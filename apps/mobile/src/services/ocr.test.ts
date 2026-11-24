import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrLanguage } from '@clipply/shared-schemas';

import { recognizeWith, tesseract } from './ocr';

const createWorker = vi.hoisted(() => vi.fn());
vi.mock('tesseract.js', () => ({ default: { createWorker, OEM: { LSTM_ONLY: 1 } } }));

const page = (text: string, language: OcrLanguage | null = null) => async () => ({ text, language });
const reads = (text: string) => async () => text;
const fails = (message: string) => async () => Promise.reject<never>(new Error(message));

describe('text recognition', () => {
  it('takes Tesseract for a language it found and ML Kit for everything else', async () => {
    expect(await recognizeWith(reads('TaTS CTTaTa'), page('আমার সোনার বাংলা', 'ben'))).toBe('আমার সোনার বাংলা');
    expect(await recognizeWith(reads('Invoice #42'), page('lnvoice #42'))).toBe('Invoice #42');
    expect(await recognizeWith(reads(''), page('তল'))).toBe('');
  });

  it('uses whichever engine works; fails only when neither does', async () => {
    expect(await recognizeWith(fails('no Play services'), page('Invoice'))).toBe('Invoice');
    expect(await recognizeWith(reads('Invoice'), fails('no wasm'))).toBe('Invoice');
    await expect(recognizeWith(fails('no Play services'), fails('no wasm'))).rejects.toThrow('no Play services');
  });
});

describe('tesseract', () => {
  const never = new Promise<never>(() => undefined);
  const terminate = vi.fn(async () => undefined);
  const scan = () => tesseract(new Uint8Array(1), 'image/png', ['ben']);

  beforeEach(() => {
    vi.useFakeTimers();
    createWorker.mockReset();
    terminate.mockClear();
    vi.stubGlobal('createImageBitmap', async () => ({ width: 1, height: 1, close: () => undefined }));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { fillRect: () => undefined, drawImage: () => undefined }; }
      async convertToBlob() { return new Blob(); }
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('names the languages by code, the only form tesseract.js initializes correctly', async () => {
    createWorker.mockResolvedValue({ recognize: async () => ({ data: { text: 'আমার', confidence: 90, blocks: null } }), terminate });
    expect((await scan()).text).toBe('আমার');
    expect(createWorker.mock.calls[0]![0]).toEqual(['ben', 'eng']);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('fails when the engine reports an error but createWorker never settles', async () => {
    createWorker.mockImplementation((_l: unknown, _o: unknown, { errorHandler }: { errorHandler: (e: unknown) => void }) => {
      errorHandler('initialization failed');
      return never;
    });
    await expect(scan()).rejects.toThrow('initialization failed');
  });

  it('fails an engine that goes silent, but not one that is slow', async () => {
    let alive = (): void => undefined;
    createWorker.mockImplementation(async (_l: unknown, _o: unknown, { logger }: { logger: () => void }) => {
      alive = logger;
      return { recognize: () => never, terminate };
    });
    let settled = false;
    const result = scan().finally(() => (settled = true));
    result.catch(() => undefined);
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
      alive();
    }
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).rejects.toThrow('Tesseract stopped responding');
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('does not wait forever for ML Kit', async () => {
    const result = recognizeWith(() => never, page('Invoice'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBe('Invoice');
  });
});
