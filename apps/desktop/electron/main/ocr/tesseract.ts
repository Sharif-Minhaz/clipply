import { join } from 'node:path';
import { createWorker, OEM, type Worker } from 'tesseract.js';

/**
 * On-device OCR with tesseract.js (English). `dir` holds ocr-worker.js, the core .wasm files and
 * eng.traineddata.gz, all copied there at build time, so nothing is downloaded. The worker (~100 MB)
 * is started on first use and stopped after `idleMs` without work.
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
      worker ??= createWorker('eng', OEM.LSTM_ONLY, { workerPath: join(real, 'ocr-worker.js'), langPath: real, cacheMethod: 'none', gzip: true });
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
