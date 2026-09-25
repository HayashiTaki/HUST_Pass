"""Collect public, unauthenticated CAPTCHA fixtures; never saves session cookies."""
import argparse, http.cookiejar, io, json, time, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageChops

parser = argparse.ArgumentParser()
parser.add_argument('--count', type=int, default=140)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = root / 'tests' / 'fixtures' / 'captcha'
out.mkdir(parents=True, exist_ok=True)
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
opener.addheaders = [('User-Agent', 'Mozilla/5.0'), ('Referer', 'https://pass.hust.edu.cn/cas/login')]
with opener.open('https://pass.hust.edu.cn/cas/login', timeout=20) as response:
    response.read()
for i in range(args.count):
    path = out / f'{i:03}.gif'
    if path.exists():
        continue
    with opener.open(f'https://pass.hust.edu.cn/cas/code?fixture={time.time_ns()}', timeout=20) as response:
        data = response.read()
    image = Image.open(io.BytesIO(data))
    if image.format != 'GIF':
        raise RuntimeError('Expected a GIF response')
    path.write_bytes(data)
    if i % 10 == 0:
        print(f'Collected {i + 1}/{args.count}', flush=True)
    time.sleep(1)

preview = root / '.cache' / 'samples'
preview.mkdir(parents=True, exist_ok=True)
for start in range(0, args.count, 40):
    sheet = Image.new('RGB', (1000, 8 * 140), 'white')
    draw = ImageDraw.Draw(sheet)
    for offset, i in enumerate(range(start, min(start + 40, args.count))):
        im = Image.open(out / f'{i:03}.gif')
        merged = Image.new('RGB', im.size, 'white')
        for frame in range(im.n_frames):
            im.seek(frame)
            merged = ImageChops.darker(merged, im.convert('RGB'))
        x, y = (offset % 5) * 200, (offset // 5) * 140
        sheet.paste(merged.resize((180,116)), (x,y+20))
        draw.text((x+4,y+3), f'{i:03}', fill='black')
    sheet.save(preview / f'contact-{start:03}.png')
print('Collection and contact sheets complete.', flush=True)
