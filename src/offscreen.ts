import { createWorker, PSM } from 'tesseract.js';
import { prepareImages, decide } from './image';

let workerPromise: ReturnType<typeof createWorker> | undefined;
let queue: Promise<unknown> = Promise.resolve();
async function worker() {
  workerPromise ??= createWorker('eng', 1, {
    workerPath: chrome.runtime.getURL('vendor/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/core'),
    langPath: chrome.runtime.getURL('vendor/lang'),
    workerBlobURL: false, cacheMethod: 'none', logger: () => {},
  }).then(async w => {
    await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE, user_defined_dpi: '300' });
    return w;
  }).catch(error => { workerPromise = undefined; throw error; });
  return workerPromise;
}
async function recognize(image: string, token: string) {
  const images = prepareImages(Uint8Array.from(atob(image), c => c.charCodeAt(0)));
  const ocr = await worker(), candidates = [];
  for (const raster of images) {
    const canvas = document.createElement('canvas'); canvas.width = raster.width; canvas.height = raster.height;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
    const { data } = await ocr.recognize(canvas);
    candidates.push({ text: data.text, confidence: data.confidence });
  }
  return { token, ...decide(candidates) };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || message.type !== 'ocr' || sender.id !== chrome.runtime.id || sender.tab) return false;
  const work = queue.then(() => recognize(message.image, message.token));
  queue = work.catch(() => {});
  work.then(respond, () => respond({ token: message.token, error: '本地识别引擎无法运行，请重新加载扩展后重试' }));
  return true;
});
