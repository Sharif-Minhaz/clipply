import { describe, expect, it } from 'vitest';
import type { OcrLanguage } from '@clipply/shared-schemas';

import { recognizeWith } from './ocr';

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
