import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClipView } from '@clipply/sync-engine';
import type { ClipKind } from '@clipply/shared-schemas';

import { ClipplyProvider, formattedDocument, ItemViewer, looksLikeText, OcrLanguageRows, parseCsv, previewKind, SimilarPanel, useDeviceNames, type AccountClient, type ClipplyClient } from './index';
import { optimistic } from './optimistic';
import { brightnessMap, groupSimilarImages, type ImageMark } from './similarImages';

const DEVICE = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const bytes = (t: string): Uint8Array => new TextEncoder().encode(t);
const view = (id: string, kind: ClipKind, preview = '', meta: Partial<ClipView['meta']> = {}): ClipView => ({
  id, preview, hasThumb: kind === 'image',
  meta: { kind, mime: 'text/plain', createdAt: 1_000, originDeviceId: DEVICE, size: 10, contentHash: '0'.repeat(64), favorite: false, pinned: false, ...meta },
});
const client = (over: Partial<ClipplyClient> = {}): ClipplyClient => ({
  list: async () => ({ items: [], total: 0 }), subscribe: () => () => {}, readThumb: async () => null, readBody: async () => new Uint8Array(0),
  linkPreview: async () => null, openUrl: async () => {}, copy: async () => {}, copyText: async () => {}, recognizeText: async () => '', imageText: async () => null,
  similarTexts: async () => [], saveFile: async () => true, setFlags: async () => {}, editText: async () => {}, add: async () => ({ duplicate: false }),
  remove: async () => {}, storage: async () => ({ count: 0, bytes: 0, kept: 0, byKind: {} }), clear: async () => 0, ...over,
});
const show = (item: ClipView, over: Partial<ClipplyClient>) => render(<ClipplyProvider client={client(over)}><ItemViewer item={item} onClose={() => {}} /></ClipplyProvider>);

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe('search results', () => {
  it('keeps what the platform matched beyond the preview (recognized text, the middle of long text)', async () => {
    const hits = [view('img', 'image'), view('long', 'text', 'only the start')];
    const layer = optimistic(client({ list: async () => ({ items: hits, total: 2 }) }));
    expect((await layer.list({ query: 'needle' })).items.map((v) => v.id)).toEqual(['img', 'long']);
  });
});

describe('file preview', () => {
  const file = (name: string, mime: string, size = 10): ClipView => view('f', 'file', name, { mime, size, file: { name } });

  it('picks the preview by type, then by extension, then by contents', () => {
    expect(previewKind('application/pdf', 'x')).toBe('pdf');
    expect(previewKind('application/octet-stream', 'Report.PDF')).toBe('pdf');
    expect(previewKind('audio/mpeg', 'a.mp3')).toBe('audio');
    expect(previewKind('video/quicktime', 'a.mov')).toBe('video');
    expect(previewKind('image/svg+xml', 'a.svg')).toBe('image');
    expect(previewKind('text/markdown', 'a.md')).toBe('text');
    expect(previewKind('application/octet-stream', 'data.tsv')).toBe('csv');
    expect(previewKind('application/zip', 'a.zip')).toBeNull();
    expect(looksLikeText(bytes('#!/bin/sh\necho বাংলা'))).toBe(true);
    expect(looksLikeText(Uint8Array.of(0x50, 0x4b, 3, 4, 0))).toBe(false);
    expect(looksLikeText(Uint8Array.of(0xff, 0xd8, 0xff))).toBe(false);
  });

  it('parses quoted fields, other separators and Windows line ends', () => {
    expect(parseCsv('a,b\r\n"x, ""y""",2\r\n')).toEqual([['a', 'b'], ['x, "y"', '2']]);
    expect(parseCsv('a;b\n1;"two\nlines"')).toEqual([['a', 'b'], ['1', 'two\nlines']]);
    expect(parseCsv('a\tb\n1\t')).toEqual([['a', 'b'], ['1', '']]);
    expect(parseCsv('a,b\n1,2\n3,4', 2)).toHaveLength(2);
    expect(parseCsv('')).toEqual([]);
  });

  it('shows text, tables and players, and the plain card for anything else', async () => {
    show(file('notes.md', 'text/markdown'), { readBody: async () => bytes('# Hello') });
    expect((await screen.findByLabelText('File contents')).textContent).toBe('# Hello');
    cleanup();
    show(file('data.csv', 'application/octet-stream'), { readBody: async () => bytes('name,age\nAda,36') });
    expect((await screen.findByRole('columnheader', { name: 'name' })).tagName).toBe('TH');
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeTruthy();
    cleanup();
    show(file('song.mp3', 'audio/mpeg'), { readBody: async () => bytes('x') });
    expect((await screen.findByLabelText('song.mp3')).tagName).toBe('AUDIO');
    cleanup();
    show(file('app.zip', 'application/zip'), { readBody: async () => Uint8Array.of(0x50, 0x4b, 3, 4, 0) });
    await waitFor(() => expect(screen.getAllByText('app.zip').length).toBeGreaterThan(1));
  });

  it('downloads a large file only when asked', async () => {
    const user = userEvent.setup();
    const readBody = vi.fn(async () => bytes('x'));
    show(file('film.mp4', 'video/mp4', 60 * 1024 * 1024), { readBody });
    const button = screen.getByRole('button', { name: /Show preview \(60.0 MB\)/ });
    expect(readBody).not.toHaveBeenCalled();
    await user.click(button);
    expect((await screen.findByLabelText('film.mp4')).tagName).toBe('VIDEO');
  });

  it('says so when a format cannot be played', async () => {
    show(file('old.avi', 'video/x-msvideo'), { readBody: async () => bytes('x') });
    (await screen.findByLabelText('old.avi')).dispatchEvent(new Event('error'));
    expect(await screen.findByText(/cannot be played here/)).toBeTruthy();
  });
});

describe('rich text', () => {
  const HTML = '<p onclick="steal()">Hi <b>there</b></p><script>steal()</script><img src="https://track.er/p.png"><img src="data:image/png;base64,AA=="><a href="javascript:x()">link</a><iframe src="//e"></iframe><form action="/x"><input></form>';

  it('drops everything that runs, loads or navigates', () => {
    const doc = formattedDocument(HTML);
    expect(doc).toContain('<b>there</b>');
    expect(doc).toContain('data:image/png;base64,AA==');
    for (const bad of ['steal', 'track.er', 'javascript:', '<iframe', '<form', '<input', '<script']) expect(doc).not.toContain(bad);
    expect(doc).toContain("default-src 'none'");
  });

  it('opens formatted in a sandbox that allows nothing; the source is one tap away and is what gets edited', async () => {
    const user = userEvent.setup();
    show(view('h', 'html'), { readBody: async () => bytes(HTML) });
    const frame = await screen.findByTitle('Formatted text');
    expect(frame.getAttribute('sandbox')).toBe('');
    await user.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.queryByTitle('Formatted text')).toBeNull();
    expect(screen.getByText(/onclick=/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Formatted' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Edit text') as HTMLTextAreaElement).value).toBe(HTML);
  });
});

describe('recognized text', () => {
  it('opens with all of it, not only the part the item carries', async () => {
    show(view('i', 'image', '', { ocr: 'The start' }), { imageText: async () => 'The start and the whole rest' });
    expect(await screen.findByDisplayValue('The start and the whole rest')).toBeTruthy();
  });

  it('switches languages on and off in a fixed order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OcrLanguageRows value={['jpn', 'ben']} onChange={onChange} />);
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    await user.click(screen.getByRole('switch', { name: 'Arabic' }));
    expect(onChange).toHaveBeenLastCalledWith(['ben', 'ara', 'jpn']);
    await user.click(screen.getByRole('switch', { name: 'Bengali' }));
    expect(onChange).toHaveBeenLastCalledWith(['jpn']);
  });
});

describe('similar clips', () => {
  const mark = (id: string, fill: number, change = 0): ImageMark => ({ id, ratio: 1.5, gray: new Uint8Array(1024).fill(fill).map((v, i) => (i < change ? v + 60 : v)) });

  it('groups images that look the same and keeps small real differences apart', () => {
    expect(groupSimilarImages([mark('a', 100), mark('b', 102), mark('c', 100, 12), mark('d', 160)])).toEqual([['a', 'b']]);
    expect(groupSimilarImages([mark('a', 100), { ...mark('b', 100), ratio: 1.6 }])).toEqual([]);
    const white = brightnessMap(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64);
    expect([...new Set(white)]).toEqual([255]);
  });

  it('asks before deleting, keeps the first and every favorite, and reports the count', async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => {});
    const texts = [[view('keep', 'text', 'Buy milk'), view('fav', 'text', 'buy milk', { favorite: true }), view('old', 'text', 'BUY MILK')]];
    const images = [view('i1', 'image', '', { createdAt: 5 }), view('i2', 'image', '', { createdAt: 9 })];
    render(
      <ClipplyProvider client={client({ remove, similarTexts: async () => texts, list: async () => ({ items: images, total: 2 }), readThumb: async () => bytes('t') })}>
        <SimilarPanel mark={async (id) => mark(id, 50)} />
      </ClipplyProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Find similar clips' }));
    expect(await screen.findByText('Similar clips (2 groups)')).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: 'Delete 1 other' })[0]!);
    expect(remove).toHaveBeenLastCalledWith(['old']);
    // The newest image is kept.
    window.confirm = vi.fn(() => true);
    await user.click(await screen.findByRole('button', { name: 'Keep one of each, delete 1' }));
    await waitFor(() => expect(remove).toHaveBeenLastCalledWith(['i1']));
    expect(await screen.findByText('Deleted 2 clips.')).toBeTruthy();
  });

  it('says when there is nothing to clean up', async () => {
    const user = userEvent.setup();
    render(<ClipplyProvider client={client()}><SimilarPanel /></ClipplyProvider>);
    await user.click(screen.getByRole('button', { name: 'Find similar clips' }));
    expect(await screen.findByText('No similar clips found.')).toBeTruthy();
  });
});

describe('device names', () => {
  it('follow renames, and keep the same object while nothing changed', async () => {
    let names: Record<string, string> = { p: 'Phone' };
    let notify = (): void => {};
    const account = { deviceNames: async () => ({ ...names }), onStatus: (cb: () => void) => ((notify = cb), () => {}) } as unknown as AccountClient;
    const { result } = renderHook(() => useDeviceNames(account));
    await waitFor(() => expect(result.current).toEqual({ p: 'Phone' }));
    const before = result.current;
    notify();
    await new Promise((r) => setTimeout(r));
    expect(result.current).toBe(before);
    names = { p: 'Pixel' };
    notify();
    await waitFor(() => expect(result.current).toEqual({ p: 'Pixel' }));
  });
});
