import { join } from 'node:path';
import { createWorker, OEM, type Worker } from 'tesseract.js';

/** Bengali must come first: as the primary language it reads Bengali lines that `eng+ben` turns into Latin. */
const LANGS = 'ben+eng';

/**
 * On-device OCR with tesseract.js. `dir` holds ocr-worker.js, the core .wasm files and the
 * *.traineddata.gz of every language below, all copied there at build time, so nothing is downloaded.
 * The worker (~100 MB) is started on first use and stopped after `idleMs` without work.
 */
export function tesseractRecognizer(dir: string, idleMs = 60_000): { recognize: (image: Uint8Array) => Promise<string>; stop: () => Promise<void> } {
  // Packaged builds unpack out/main (electron-builder asarUnpack): worker threads load from the real file system.
  const real = dir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  let worker: Promise<Worker> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const stop = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    const w = worker;
    worker = null;
    if (w) await (await w).terminate().catch(() => undefined);
  };
  return {
    stop,
    recognize: async (image) => {
      if (timer) clearTimeout(timer);
      worker ??= createWorker(LANGS, OEM.LSTM_ONLY, { workerPath: join(real, 'ocr-worker.js'), langPath: real, cacheMethod: 'none', gzip: true });
      try {
        const { data } = await (await worker).recognize(Buffer.from(image));
        return data.text;
      } catch (error) {
        await stop();
        throw error;
      } finally {
        timer = setTimeout(() => void stop(), idleMs);
        timer.unref();
      }
    },
  };
}
