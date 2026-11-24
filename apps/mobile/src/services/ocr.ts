import type { Page } from 'tesseract.js';
import benUrl from '@tesseract.js-data/ben/4.0.0_best_int/ben.traineddata.gz?url';
import engUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import coreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';

import { createLogger } from '@clipply/logger';

const log = createLogger('ocr');

/** Enough for a 1440×3200 screenshot; larger camera photos only make Tesseract slow. */
const MAX_PIXELS = 4_700_000;

type Words = Pick<Page, 'blocks'>;

/**
 * True when a Bengali word was read with confidence. Tesseract also turns noise and blurry Latin into
 * Bengali letters, but in measurements those were single letters or stayed below 70.
 */
export function hasBengali(page: Words): boolean {
  const words = (page.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
  return words.some((w) => w.confidence >= 80 && /\p{Script=Bengali}{2}/u.test(w.text));
}

/**
 * Both engines read every image, because ML Kit (more accurate on Latin, above all in photos) has no Bengali
 * model and cannot tell that it is looking at Bengali. Tesseract's text wins when it found Bengali, or when
 * ML Kit is unavailable (no Play services).
 */
export async function recognizeWith(
  mlKit: () => Promise<string>,
  tesseract: () => Promise<Words & { text: string }>,
): Promise<string> {
  const [latin, page] = await Promise.allSettled([mlKit(), tesseract()]);
  if (page.status === 'rejected') log.warn('tesseract failed', { error: String(page.reason) });
  if (page.status === 'fulfilled' && (latin.status === 'rejected' || hasBengali(page.value))) return page.value.text;
  if (latin.status === 'rejected') throw latin.reason;
  return latin.value;
}

/** Upright, opaque and at most MAX_PIXELS, in a format Tesseract decodes (the WebView reads more formats). */
async function prepare(image: Uint8Array, mime: string): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([image as Uint8Array<ArrayBuffer>], { type: mime }));
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Bengali + English in a web worker. Everything it loads is bundled in the app, so nothing is downloaded.
 * The worker (~100 MB) lives for one scan: scans are rare and phones are short of memory.
 */
export async function tesseract(image: Uint8Array, mime: string): Promise<Words & { text: string }> {
  // Bengali first: as the primary language it reads Bengali lines that eng+ben turns into Latin.
  const load = async (code: string, url: string): Promise<{ code: string; data: Uint8Array }> => ({ code, data: new Uint8Array(await (await fetch(url)).arrayBuffer()) });
  const [{ createWorker, OEM }, blob, ...langs] = await Promise.all([
    import('tesseract.js').then((m) => m.default), prepare(image, mime), load('ben', benUrl), load('eng', engUrl),
  ]);
  const worker = await createWorker(langs, OEM.LSTM_ONLY, { workerPath: workerUrl, corePath: coreUrl, workerBlobURL: false, cacheMethod: 'none' });
  try {
    return (await worker.recognize(blob, {}, { text: true, blocks: true })).data;
  } finally {
    await worker.terminate();
  }
}
