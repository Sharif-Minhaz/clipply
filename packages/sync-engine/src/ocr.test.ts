// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { hasScript, scanLanguages, type OcrScan } from './ocr';

const scan = (text: string, confidence = 95): OcrScan => ({ text, confidence, words: text.split(' ').map((t) => ({ text: t, confidence })) });

describe('text recognition languages', () => {
  it('spots a script only in words read with confidence', () => {
    expect(hasScript('ben', scan('Total মোট 500'))).toBe(true);
    expect(hasScript('ben', scan('Invoice #42'))).toBe(false);
    expect(hasScript('ben', scan('Invoice ১ ক'))).toBe(false);
    expect(hasScript('ben', scan('তল কেপ', 55))).toBe(false);
    expect(hasScript('ara', scan('مرحبا'))).toBe(true);
    expect(hasScript('hin', scan('नमस्ते'))).toBe(true);
    expect(hasScript('jpn', scan('日 本'))).toBe(true);
    expect(hasScript('ara', scan('নমস্কার'))).toBe(false);
    expect(hasScript('ben', { words: [] })).toBe(false);
  });

  it('scans each language with English last and keeps the one read best', async () => {
    const passes: Record<string, OcrScan> = { ben: scan('aly ৮০১০ sd', 49), ara: scan('مرحبا بالعالم', 91), hin: scan('never', 99) };
    const run = vi.fn(async ([l]: string[]) => passes[l!]!);
    expect(await scanLanguages(['ben', 'ara', 'hin'], run)).toMatchObject({ text: 'مرحبا بالعالم', language: 'ara' });
    // Sure about Arabic: Hindi is not scanned at all.
    expect(run.mock.calls.map((c) => c[0])).toEqual([['ben', 'eng'], ['ara', 'eng']]);
  });

  it('reports no language for Latin text, and scans English alone when none is chosen', async () => {
    expect(await scanLanguages(['ben', 'jpn'], async ([l]) => scan('Invoice 42', l === 'ben' ? 95 : 90))).toMatchObject({ text: 'Invoice 42', confidence: 95, language: null });
    const run = vi.fn(async () => scan('Hello'));
    expect(await scanLanguages([], run)).toMatchObject({ text: 'Hello', language: null });
    expect(run).toHaveBeenCalledWith(['eng']);
  });
});
