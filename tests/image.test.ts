import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decide, decodeGif, prepareImages } from '../src/image.ts';
import { errorKind, isLoginUrl } from '../src/protocol.ts';

test('GIF bytes determine format regardless of the incorrect HTTP image/jpeg header', async () => {
  const bytes = await readFile('tests/fixtures/captcha/000.gif');
  const frames = decodeGif(bytes);
  assert.equal(frames.length, 4); assert.equal(frames[0].width, 90); assert.equal(frames[0].height, 58);
  assert.notDeepEqual(frames[0].data, frames[1].data);
  assert.ok(frames.every(frame => frame.data.length === 90 * 58 * 4));
  const variants = prepareImages(bytes);
  assert.equal(variants.length, 3);
  for (const raster of variants) {
    assert.ok(raster.data.includes(0)); assert.ok(raster.data.includes(255));
    assert.ok(raster.width > 90 && raster.height > 58);
  }
});
test('corrupt, missing and oversized GIF data are rejected', async () => {
  assert.throws(() => decodeGif(new Uint8Array()), /GIF/);
  assert.throws(() => decodeGif(new TextEncoder().encode('<html>error</html>')), /GIF/);
  const tooBig = new Uint8Array(1_000_001); tooBig.set(new TextEncoder().encode('GIF89a'));
  assert.throws(() => decodeGif(tooBig), /过大/);
  const dimensions = new Uint8Array(await readFile('tests/fixtures/captcha/000.gif'));
  dimensions[6] = 255; dimensions[7] = 255;
  assert.throws(() => decodeGif(dimensions), /尺寸/);
});
test('leading zeroes, repeated digits and spaces are preserved as a four-digit string', () => {
  assert.equal(decide([{text:' 00 05\n',confidence:92},{text:'0005',confidence:95}]).code, '0005');
  assert.equal(decide([{text:'8888',confidence:90},{text:'8888',confidence:91}]).code, '8888');
});
test('single, conflicting, weak and non-four-digit readings never get filled', () => {
  for (const candidates of [
    [{text:'1234',confidence:99}],
    [{text:'1234',confidence:99},{text:'1235',confidence:99}],
    [{text:'1234',confidence:45},{text:'1234',confidence:50}],
    [{text:'12345',confidence:99},{text:'12345',confidence:99}],
    [{text:'O123',confidence:99},{text:'O123',confidence:99}],
  ]) assert.equal(decide(candidates).code, null);
});
test('only the exact HTTPS login path matches; service query is arbitrary', () => {
  assert.ok(isLoginUrl('https://pass.hust.edu.cn/cas/login?service=https%3A%2F%2Fexample.invalid'));
  for (const url of ['https://pass.hust.edu.cn/cas/loginOther', 'http://pass.hust.edu.cn/cas/login','https://evil.invalid/cas/login','https://pass.hust.edu.cn.evil.invalid/cas/login','invalid']) assert.equal(isLoginUrl(url), false);
});
test('only explicit CAPTCHA errors authorize retries, including English pages', () => {
  for (const message of ['验证码错误','验证码已过期','Invalid captcha','Verification code is incorrect']) assert.equal(errorKind(message), 'captcha');
  for (const message of ['密码错误','验证码错误或密码错误','系统繁忙','Account locked','Invalid password']) assert.equal(errorKind(message), 'other');
  assert.equal(errorKind(''), null);
});


test('transparent frame patches and disposal 1/2/3 match independent Pillow reference pixels', async () => {
  for (const disposal of [1,2,3]) {
    const name = `tests/fixtures/gif/disposal-${disposal}`;
    const actual = decodeGif(await readFile(name+'.gif'));
    const expected = JSON.parse(await readFile(name+'.json','utf8'));
    assert.equal(actual.length, expected.length);
    for (let i=0;i<actual.length;i++) assert.deepEqual(Array.from(actual[i].data),expected[i].data, `disposal ${disposal} frame ${i}`);
  }
});
