import { parseGIF, decompressFrames } from 'gifuct-js';

export interface Raster { width: number; height: number; data: Uint8ClampedArray }
export function decodeGif(bytes: Uint8Array): Raster[] {
  const signature = new TextDecoder().decode(bytes.slice(0, 6));
  if (!['GIF87a', 'GIF89a'].includes(signature)) throw new Error('验证码不是 GIF 动图');
  if (bytes.length > 1_000_000) throw new Error('验证码图片过大');
  const gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const width = gif.lsd.width, height = gif.lsd.height;
  if (!width || !height || width > 512 || height > 256 || gif.frames.length > 100) throw new Error('验证码尺寸异常');
  const frames = decompressFrames(gif, true);
  if (!frames.length) throw new Error('验证码没有可解码的图像帧');
  let canvas = new Uint8ClampedArray(width * height * 4).fill(255);
  const result: Raster[] = [];
  for (const frame of frames) {
    const before = canvas.slice();
    const { left, top, width: fw, height: fh } = frame.dims;
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      if (left + x >= width || top + y >= height) continue;
      const src = (y * fw + x) * 4, dst = ((top + y) * width + left + x) * 4;
      if (frame.patch[src + 3]) canvas.set(frame.patch.subarray(src, src + 4), dst);
    }
    result.push({ width, height, data: canvas.slice() });
    if (frame.disposalType === 2) {
      for (let y = top; y < Math.min(top + fh, height); y++) {
        canvas.fill(255, (y * width + left) * 4, (y * width + Math.min(left + fw, width)) * 4);
      }
    } else if (frame.disposalType === 3) canvas = before;
  }
  return result;
}

function clean(mask: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(mask.length);
  const components: number[][] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || visited[i]) continue;
    const pixels = [i]; visited[i] = 1;
    for (let j = 0; j < pixels.length; j++) {
      const p = pixels[j], x = p % width, y = Math.floor(p / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, q = yy * width + xx;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && mask[q] && !visited[q]) {
          visited[q] = 1; pixels.push(q);
        }
      }
    }
    components.push(pixels);
  }
  for (const pixels of components) {
    const ys = pixels.map(p => Math.floor(p / width));
    if (pixels.length < 12 || Math.max(...ys) - Math.min(...ys) < 7) for (const p of pixels) mask[p] = 0;
  }
  return mask;
}

export function prepareImages(bytes: Uint8Array): Raster[] {
  const frames = decodeGif(bytes);
  const { width, height } = frames[0];
  const fused: number[][] = [[], []];
  for (let p = 0; p < width * height; p++) {
    const values = frames.map(f => {
      const i = p * 4;
      return Math.round(0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2]);
    }).sort((a,b) => a-b);
    fused[0].push(values[Math.min(1, values.length - 1)]);
    fused[1].push(values[0]);
  }
  return [[0,200], [0,230], [1,180]].map(([which,threshold]) => {
    const mask = clean(Uint8Array.from(fused[which], v => Number(v < threshold)), width, height);
    const scale = 4, padding = 20, w = width * scale + padding * 2, h = height * scale + padding * 2;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < height * scale; y++) for (let x = 0; x < width * scale; x++) {
      if (!mask[Math.floor(y / scale) * width + Math.floor(x / scale)]) continue;
      const i = ((y + padding) * w + x + padding) * 4;
      data[i] = data[i+1] = data[i+2] = 0;
    }
    return { width: w, height: h, data };
  });
}

export interface Candidate { text: string; confidence: number }
export interface Recognition { code: string | null; confidence: number; reason?: string }
export function decide(candidates: Candidate[]): Recognition {
  const groups = new Map<string, number[]>();
  for (const candidate of candidates) {
    const text = candidate.text.replace(/\s/g, '');
    if (/^\d{4}$/.test(text)) groups.set(text, [...(groups.get(text) ?? []), candidate.confidence]);
  }
  const ranked = [...groups].sort((a,b) => b[1].length - a[1].length);
  const best = ranked[0];
  if (best && best[1].length >= 2 && Math.max(...best[1]) >= 60 && (ranked[1]?.[1].length ?? 0) < best[1].length) {
    return { code: best[0], confidence: Math.max(...best[1]) };
  }
  return { code: null, confidence: 0, reason: '识别结果不够确定' };
}
