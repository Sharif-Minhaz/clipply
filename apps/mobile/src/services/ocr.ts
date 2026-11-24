import type { Worker } from 'tesseract.js';
import coreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';

import { createLogger } from '@clipply/logger';
import type { OcrLanguage } from '@clipply/shared-schemas';
import { scanLanguages, type OcrScan } from '@clipply/sync-engine';

const log = createLogger('ocr');

/** Enough for a 1440×3200 screenshot; larger camera photos only make Tesseract slow. */
const MAX_PIXELS = 4_700_000;

/** Longest silence from an engine before its scan fails. Tesseract reports progress all along, so slow phones are fine. */
const STALL_MS = 60_000;

/** Fails when `work` goes STALL_MS without calling `alive`: an engine that crashes or never starts may settle nothing. */
async function watch<T>(engine: string, work: (alive: () => void) => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      const alive = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error(`${engine} stopped responding`)), STALL_MS);
      };
      alive();
      work(alive).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Both engines read every image, because ML Kit (more accurate on Latin, above all in photos) reads only
 * Latin script and cannot tell that it is looking at something else. Tesseract's text wins when it found
 * one of the chosen languages, or when ML Kit is unavailable (no Play services).
 */
export async function recognizeWith(
  mlKit: () => Promise<string>,
  tesseract: () => Promise<{ text: string; language: OcrLanguage | null }>,
): Promise<string> {
  const [latin, page] = await Promise.allSettled([watch('ML Kit', mlKit), tesseract()]);
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
 * The chosen languages in a web worker, one pass each. Everything it loads is bundled in the app (language data:
 * /ocr, see vite.config.ts), so nothing is downloaded. The worker (~100 MB) lives for one pass: scans are rare and
 * phones are short of memory.
 */
export async function tesseract(image: Uint8Array, mime: string, languages: readonly OcrLanguage[]): Promise<OcrScan & { language: OcrLanguage | null }> {
  const [{ createWorker, OEM }, blob] = await Promise.all([import('tesseract.js').then((m) => m.default), prepare(image, mime)]);
  return scanLanguages(languages, async (codes) => {
    let worker: Worker | undefined;
    try {
      return await watch('Tesseract', async (alive) => {
        // Codes only: tesseract.js 7 also takes { code, data }, but then passes `data` to the engine as the language
        // name. And createWorker never settles when that or loading the data fails; errorHandler is told.
        worker = await new Promise<Worker>((resolve, reject) => {
          createWorker(codes, OEM.LSTM_ONLY, {
            workerPath: workerUrl, corePath: coreUrl, langPath: '/ocr', gzip: false, workerBlobURL: false, cacheMethod: 'none',
            logger: alive,
            errorHandler: (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))),
          }).then(resolve, reject);
        });
        const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
        return { text: data.text, confidence: data.confidence, words: (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))) };
      });
    } finally {
      await worker?.terminate();
    }
  });
}
