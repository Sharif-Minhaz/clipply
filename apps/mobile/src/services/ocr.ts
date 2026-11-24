import type { Worker } from 'tesseract.js';
import araUrl from '@tesseract.js-data/ara/4.0.0_best_int/ara.traineddata.gz?url';
import benUrl from '@tesseract.js-data/ben/4.0.0_best_int/ben.traineddata.gz?url';
import engUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import hinUrl from '@tesseract.js-data/hin/4.0.0_best_int/hin.traineddata.gz?url';
import jpnUrl from '@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz?url';
import coreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';

import { createLogger } from '@clipply/logger';
import type { OcrLanguage } from '@clipply/shared-schemas';
import { scanLanguages, type OcrScan } from '@clipply/sync-engine';

const log = createLogger('ocr');

/** Enough for a 1440×3200 screenshot; larger camera photos only make Tesseract slow. */
const MAX_PIXELS = 4_700_000;

const DATA: Record<string, string> = { ara: araUrl, ben: benUrl, eng: engUrl, hin: hinUrl, jpn: jpnUrl };

/**
 * Both engines read every image, because ML Kit (more accurate on Latin, above all in photos) reads only
 * Latin script and cannot tell that it is looking at something else. Tesseract's text wins when it found
 * one of the chosen languages, or when ML Kit is unavailable (no Play services).
 */
export async function recognizeWith(
  mlKit: () => Promise<string>,
  tesseract: () => Promise<{ text: string; language: OcrLanguage | null }>,
): Promise<string> {
  const [latin, page] = await Promise.allSettled([mlKit(), tesseract()]);
  if (page.status === 'rejected') log.warn('tesseract failed', { error: String(page.reason) });
  if (page.status === 'fulfilled' && (latin.status === 'rejected' || page.value.language)) return page.value.text;
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
 * The chosen languages in a web worker, one pass each. Everything it loads is bundled in the app, so nothing is
 * downloaded. The worker (~100 MB) lives for one pass: scans are rare and phones are short of memory.
 */
export async function tesseract(image: Uint8Array, mime: string, languages: readonly OcrLanguage[]): Promise<OcrScan & { language: OcrLanguage | null }> {
  const load = async (code: string): Promise<{ code: string; data: Uint8Array }> => ({ code, data: new Uint8Array(await (await fetch(DATA[code]!)).arrayBuffer()) });
  const [{ createWorker, OEM }, blob] = await Promise.all([import('tesseract.js').then((m) => m.default), prepare(image, mime)]);
  return scanLanguages(languages, async (codes) => {
    const worker: Worker = await createWorker(await Promise.all(codes.map(load)), OEM.LSTM_ONLY, { workerPath: workerUrl, corePath: coreUrl, workerBlobURL: false, cacheMethod: 'none' });
    try {
      const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
      return { text: data.text, confidence: data.confidence, words: (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))) };
    } finally {
      await worker.terminate();
    }
  });
}
