import { join } from 'node:path';
import { createWorker, OEM, type Worker } from 'tesseract.js';
import type { OcrLanguage } from '@clipply/shared-schemas';
import { scanLanguages } from '@clipply/sync-engine';

/**
 * On-device OCR with tesseract.js. `dir` holds ocr-worker.js, the core .wasm files and the
 * *.traineddata.gz of every language, all copied there at build time, so nothing is downloaded.
 * The worker (~100 MB) is started on first use and stopped after `idleMs` without work.
 */
export function tesseractRecognizer(dir: string, idleMs = 60_000): { recognize: (image: Uint8Array, languages: readonly OcrLanguage[]) => Promise<string>; stop: () => Promise<void> } {
  // Packaged builds unpack out/main (electron-builder asarUnpack): worker threads load from the real file system.
  const real = dir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  let worker: Promise<Worker> | null = null;
  let loaded = '';
  let timer: NodeJS.Timeout | null = null;
  /** Scans share one worker and switch its language, so they run one after another. */
  let queue: Promise<unknown> = Promise.resolve();

  const stop = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    const w = worker;
    worker = null;
    if (w) await (await w).terminate().catch(() => undefined);
  };
  const ready = async (langs: string): Promise<Worker> => {
    if (worker && langs !== loaded) await (await worker).reinitialize(langs, OEM.LSTM_ONLY);
    loaded = langs;
    worker ??= createWorker(langs, OEM.LSTM_ONLY, { workerPath: join(real, 'ocr-worker.js'), langPath: real, cacheMethod: 'none', gzip: true });
    return worker;
  };
  const run = async (image: Uint8Array, languages: readonly OcrLanguage[]): Promise<string> => {
    if (timer) clearTimeout(timer);
    const buf = Buffer.from(image);
    try {
      const best = await scanLanguages(languages, async (langs) => {
        const w = await ready(langs.join('+'));
        const { data } = await w.recognize(buf, {}, { text: true, blocks: true });
        return { text: data.text, confidence: data.confidence, words: (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))) };
      });
      return best.text;
    } catch (error) {
      await stop();
      throw error;
    } finally {
      timer = setTimeout(() => void stop(), idleMs);
      timer.unref();
    }
  };

  return {
    stop,
    recognize: (image, languages) => {
      const result = queue.then(() => run(image, languages));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
