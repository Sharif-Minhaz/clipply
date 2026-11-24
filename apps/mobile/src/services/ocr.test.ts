import type { Page } from 'tesseract.js';
import { describe, expect, it } from 'vitest';

import { hasBengali, recognizeWith } from './ocr';

const page = (text: string, confidence = 95): Pick<Page, 'blocks' | 'text'> =>
  ({ text, blocks: [{ paragraphs: [{ lines: [{ words: text.split(' ').map((t) => ({ text: t, confidence })) }] }] }] }) as unknown as Page;
const reads = (text: string) => async () => text;
const fails = (message: string) => async () => Promise.reject<never>(new Error(message));

describe('text recognition', () => {
  it('spots Bengali only in words read with confidence', () => {
    expect(hasBengali(page('Total মোট 500'))).toBe(true);
    expect(hasBengali(page('Invoice #42'))).toBe(false);
    expect(hasBengali(page('Invoice ১ ক'))).toBe(false);
    expect(hasBengali(page('তল কেপ', 55))).toBe(false);
    expect(hasBengali({ blocks: null })).toBe(false);
  });

  it('takes Tesseract for Bengali and ML Kit for everything else', async () => {
    expect(await recognizeWith(reads('TaTS CTTaTa'), async () => page('আমার সোনার বাংলা'))).toBe('আমার সোনার বাংলা');
    expect(await recognizeWith(reads('Invoice #42'), async () => page('lnvoice #42'))).toBe('Invoice #42');
    expect(await recognizeWith(reads(''), async () => page('তল', 20))).toBe('');
  });

  it('uses whichever engine works; fails only when neither does', async () => {
    expect(await recognizeWith(fails('no Play services'), async () => page('Invoice'))).toBe('Invoice');
    expect(await recognizeWith(reads('Invoice'), fails('no wasm'))).toBe('Invoice');
    await expect(recognizeWith(fails('no Play services'), fails('no wasm'))).rejects.toThrow('no Play services');
  });
});
