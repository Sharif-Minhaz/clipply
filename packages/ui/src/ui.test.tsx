import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ClipView, ListFilter } from '@clipply/sync-engine';
import type { ClipKind } from '@clipply/shared-schemas';

import { Plus } from 'lucide-react';
import { optimistic } from './optimistic';
import { AddClip, ClipList, ClipplyProvider, formatBytes, formatRelative, ItemViewer, KindFilter, MEDIA_KINDS, SearchBar, type ClipplyClient } from './index';

const DEVICE = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

/** In-memory stand-in for the platform client; the real engine is covered by sync-engine tests. */
class FakeLibrary {
  private items: ClipView[] = [];
  private listeners = new Set<() => void>();

  add(id: string, preview: string, kind: ClipKind, createdAt: number): void {
    this.items.unshift({
      id, preview, hasThumb: false,
      meta: { kind, mime: 'text/plain', createdAt, originDeviceId: DEVICE, size: preview.length, contentHash: '0'.repeat(64), favorite: false, pinned: false },
    });
  }

  list(f: ListFilter = {}): ClipView[] {
    const q = f.query?.toLowerCase();
    return this.items.filter(
      (i) => (!f.kinds || f.kinds.includes(i.meta.kind)) && (f.pinned === undefined || i.meta.pinned === f.pinned) && (f.favorite === undefined || (i.meta.favorite || i.meta.pinned) === f.favorite) && (!q || i.preview.toLowerCase().includes(q)),
    );
  }

  client(copy = vi.fn(async () => {})): ClipplyClient {
    const emit = (): void => this.listeners.forEach((l) => l());
    return {
      list: async (f) => this.list(f),
      subscribe: (cb) => {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
      readThumb: async () => null,
      readBody: async (id) => new TextEncoder().encode(this.items.find((i) => i.id === id)?.preview ?? ''),
      openUrl: vi.fn(async () => {}),
      editText: async (id, text) => {
        this.items = this.items.map((i) => (i.id === id ? { ...i, preview: text } : i));
        emit();
      },
      copy,
      setFlags: async (id, flags) => {
        this.items = this.items.map((i) => (i.id === id ? { ...i, meta: { ...i.meta, ...flags } } : i));
        emit();
      },
      remove: async (ids) => {
        this.items = this.items.filter((i) => !ids.includes(i.id));
        emit();
      },
      saveFile: async () => true,
      add: async () => ({ duplicate: false }),
      linkPreview: async () => null,
      storage: async () => ({ count: this.items.length, bytes: 0, kept: 0, byKind: {} }),
      clear: async () => 0,
    };
  }
}

function Screen() {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<ClipKind[]>([]);
  const filter: ListFilter = { ...(query ? { query } : {}), ...(kinds.length ? { kinds } : {}) };
  return (
    <>
      <SearchBar value={query} onChange={setQuery} />
      <KindFilter value={kinds} onChange={setKinds} />
      <ClipList filter={filter} deviceNames={{ [DEVICE]: 'Laptop' }} />
    </>
  );
}

let lib: FakeLibrary;
beforeEach(() => {
  lib = new FakeLibrary();
  lib.add('a', 'grocery list', 'text', Date.now() - 121_000);
  lib.add('b', 'https://clipply.dev', 'url', Date.now() - 120_000);
});
afterEach(cleanup);

describe('shared UI', () => {
  it('renders history newest first with kind, time and source device', async () => {
    render(<ClipplyProvider client={lib.client()}><Screen /></ClipplyProvider>);
    const cards = await screen.findAllByRole('article');
    expect(cards.map((c) => within(c).getByText(/grocery|clipply/).textContent)).toEqual(['https://clipply.dev', 'grocery list']);
    expect(within(cards[0]!).getByText('Link')).toBeTruthy();
    expect(within(cards[0]!).getByText('2 minutes ago').parentElement?.textContent).toBe('2 minutes ago, from Laptop');
  });

  it('searches and filters by kind', async () => {
    const user = userEvent.setup();
    render(<ClipplyProvider client={lib.client()}><Screen /></ClipplyProvider>);
    await screen.findAllByRole('article');
    await user.type(screen.getByLabelText('Search clipboard history'), 'grocery');
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    await user.clear(screen.getByLabelText('Search clipboard history'));
    const link = within(screen.getByRole('group', { name: 'Filter by type' })).getByRole('button', { name: 'Link' });
    await user.click(link);
    expect(link.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    await user.type(screen.getByLabelText('Search clipboard history'), 'zzz');
    expect(await screen.findByText('Nothing matches “zzz”.')).toBeTruthy();
  });

  it('favorites, copies and deletes through the client and re-renders on change', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    render(<ClipplyProvider client={lib.client(copy)}><Screen /></ClipplyProvider>);
    const [first] = await screen.findAllByRole('article');
    expect(within(first!).queryByRole('button', { name: 'Pin' })).toBeNull();
    await user.click(within(first!).getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(within(screen.getAllByRole('article')[0]!).getByRole('button', { name: 'Unfavorite' }).getAttribute('aria-pressed')).toBe('true'));
    expect(lib.list({ favorite: true })).toHaveLength(1);

    await user.click(within(screen.getAllByRole('article')[0]!).getByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith(lib.list()[0]!.id);

    await user.click(within(screen.getAllByRole('article')[0]!).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
  });

  it('shows a legacy pinned item as a favorite and clears the pin when unfavorited', async () => {
    const user = userEvent.setup();
    const client = lib.client();
    await client.setFlags(lib.list()[0]!.id, { pinned: true });
    render(<ClipplyProvider client={client}><Screen /></ClipplyProvider>);
    const [first] = await screen.findAllByRole('article');
    await user.click(within(first!).getByRole('button', { name: 'Unfavorite' }));
    await waitFor(() => expect(lib.list({ favorite: true })).toHaveLength(0));
    expect(lib.list()[0]!.meta).toMatchObject({ pinned: false, favorite: false });
  });

  it('shows images and files as a gallery with copy, download, favorite and delete', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    lib.add('img', '', 'image', Date.now() - 60_000);
    lib.add('doc', '', 'file', Date.now() - 30_000);
    const client = { ...lib.client(copy), saveFile: vi.fn(async () => true) };
    render(<ClipplyProvider client={client}><ClipList filter={{ kinds: MEDIA_KINDS }} layout="grid" /></ClipplyProvider>);
    const tiles = await screen.findAllByRole('article');
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual(['File item', 'Image item']);
    expect(within(tiles[0]!).queryByRole('button', { name: 'Copy' })).toBeNull();

    await user.click(within(tiles[1]!).getByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith('img');
    await user.click(within(tiles[0]!).getByRole('button', { name: 'Download' }));
    expect(client.saveFile).toHaveBeenCalledWith('doc');
    await user.click(within(tiles[1]!).getByRole('button', { name: 'Favorite' }));
    await waitFor(() => expect(lib.list({ favorite: true }).map((i) => i.id)).toEqual(['img']));

    await user.click(within(screen.getAllByRole('article')[1]!).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    expect(lib.list().map((i) => i.id)).not.toContain('img');
  });

  it('shows an add, delete and favorite at once and rolls each back when the platform fails', async () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
      return { promise, resolve, reject };
    };
    const base = lib.client();
    const slowAdd = deferred<{ duplicate: boolean }>();
    const slowRemove = deferred<void>();
    const slowFlags = deferred<void>();
    const client = optimistic({ ...base, add: () => slowAdd.promise, remove: () => slowRemove.promise, setFlags: () => slowFlags.promise });

    const adding = client.add({ type: 'text', text: 'https://example.com' });
    const [first] = await client.list({});
    expect(first).toMatchObject({ preview: 'https://example.com', meta: { kind: 'url' } });
    expect(await client.list({ kinds: ['text'] })).toHaveLength(1);
    slowAdd.reject(new Error('offline'));
    await expect(adding).rejects.toThrow('offline');
    expect((await client.list({})).map((v) => v.id)).toEqual(['b', 'a']);

    const removing = client.remove(['a']);
    expect((await client.list({})).map((v) => v.id)).toEqual(['b']);
    slowRemove.reject(new Error('locked'));
    await expect(removing).rejects.toThrow('locked');
    expect((await client.list({})).map((v) => v.id)).toEqual(['b', 'a']);

    const starring = client.setFlags('a', { favorite: true });
    expect((await client.list({ favorite: true })).map((v) => v.id)).toEqual(['a']);
    slowFlags.reject(new Error('nope'));
    await expect(starring).rejects.toThrow('nope');
    expect(await client.list({ favorite: true })).toEqual([]);
  });

  it('lists a typed note before the platform finishes storing it', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const base = lib.client();
    const client: ClipplyClient = {
      ...base,
      add: async (input) => {
        await new Promise<void>((r) => (finish = r));
        return base.add(input);
      },
    };
    render(<ClipplyProvider client={client}><ClipList filter={{}} /><AddClip /></ClipplyProvider>);
    await screen.findAllByRole('article');
    await user.click(screen.getByRole('button', { name: 'Add text, image or file' }));
    await user.click(screen.getByRole('menuitem', { name: 'Text' }));
    await user.type(screen.getByLabelText('Text to add'), 'instant note');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('instant note')).toBeTruthy();
    expect(screen.getByText('Saving…')).toBeTruthy();
    finish();
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
  });

  it('selects several gallery tiles and deletes them together', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    lib.add('img1', '', 'image', Date.now() - 60_000);
    lib.add('img2', '', 'image', Date.now() - 50_000);
    lib.add('doc', '', 'file', Date.now() - 30_000);
    render(<ClipplyProvider client={lib.client()}><ClipList filter={{ kinds: MEDIA_KINDS }} layout="grid" /></ClipplyProvider>);
    await screen.findAllByRole('article');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Select File' }));
    await user.click(screen.getAllByRole('button', { name: 'Select Image' })[0]!);
    expect(screen.getByText('2 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    // Text clips outside the gallery are untouched.
    expect(lib.list().map((i) => i.id).sort()).toEqual(['a', 'b', 'img1']);
  });

  it('selects several items and favorites or deletes them together', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ClipplyProvider client={lib.client()}><Screen /></ClipplyProvider>);
    await screen.findAllByRole('article');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const cards = screen.getAllByRole('button', { name: /^Select .* item$/ });
    await user.click(cards[0]!);
    await user.click(cards[1]!);
    expect(screen.getByText('2 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Favorite selected' }));
    await waitFor(() => expect(lib.list({ favorite: true })).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    await waitFor(() => expect(lib.list()).toHaveLength(0));
  });

  it('copies when the card is clicked and opens details with Expand', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    const onOpen = vi.fn();
    render(<ClipplyProvider client={lib.client(copy)}><ClipList filter={{}} onOpen={onOpen} /></ClipplyProvider>);
    const [first] = await screen.findAllByRole('article');
    await user.click(within(first!).getByRole('button', { name: /^Copy .* item$/ }));
    expect(copy).toHaveBeenCalledWith(lib.list()[0]!.id);
    expect(await within(first!).findByText('Copied')).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(within(first!).getByRole('button', { name: 'Expand' }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: lib.list()[0]!.id }));
  });

  it('viewer shows details on one line and closes from the top or the bottom bar', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<ClipplyProvider client={lib.client(copy)}><ItemViewer item={lib.list()[0]!} onClose={onClose} /></ClipplyProvider>);
    const dialog = screen.getByRole('dialog', { name: 'Link item' });
    expect(within(dialog).getByText(/^19 B · text\/plain · 2 minutes ago$/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith('b');
    const closes = within(dialog).getAllByRole('button', { name: 'Close' });
    expect(closes).toHaveLength(2);
    await user.click(closes[1]!);
    await user.click(closes[0]!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('viewer closes at once on Delete, before the platform finishes', async () => {
    const user = userEvent.setup();
    const remove = vi.fn(() => new Promise<void>(() => {}));
    const onClose = vi.fn();
    render(<ClipplyProvider client={{ ...lib.client(), remove }}><ItemViewer item={lib.list()[0]!} onClose={onClose} /></ClipplyProvider>);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(['b']);
  });

  it('shows Copying… while a copy is still downloading', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const copy = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<ClipplyProvider client={lib.client(copy)}><ClipList filter={{}} /></ClipplyProvider>);
    const [first] = await screen.findAllByRole('article');
    await user.click(within(first!).getByRole('button', { name: /^Copy .* item$/ }));
    expect(await within(first!).findByText('Copying…')).toBeTruthy();
    finish();
    expect(await within(first!).findByText('Copied')).toBeTruthy();
    expect(within(first!).queryByText('Copying…')).toBeNull();
  });

  it('opens an item, edits its text and closes on Escape', async () => {
    const user = userEvent.setup();
    const client = lib.client();
    const item = lib.list().find((i) => i.id === 'a')!;
    const onClose = vi.fn();
    render(<ClipplyProvider client={client}><ItemViewer item={item} onClose={onClose} /></ClipplyProvider>);
    expect(await screen.findByText('grocery list')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Edit/ }));
    const box = screen.getByLabelText('Edit text');
    await user.clear(box);
    await user.type(box, 'milk and eggs');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(lib.list().find((i) => i.id === 'a')?.preview).toBe('milk and eggs'));
    // Saving closes the viewer.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves an edit with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const item = lib.list().find((i) => i.id === 'a')!;
    const onClose = vi.fn();
    render(<ClipplyProvider client={lib.client()}><ItemViewer item={item} onClose={onClose} /></ClipplyProvider>);
    await user.click(await screen.findByRole('button', { name: /Edit/ }));
    const box = screen.getByLabelText('Edit text');
    await user.clear(box);
    await user.type(box, 'bread{Control>}{Enter}{/Control}');
    await waitFor(() => expect(lib.list().find((i) => i.id === 'a')?.preview).toBe('bread'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('adds text from the + menu, and rejects oversize files before reading them', async () => {
    const user = userEvent.setup();
    const add = vi.fn(async () => ({ duplicate: false }));
    const { container } = render(<ClipplyProvider client={{ ...lib.client(), add }}><AddClip /></ClipplyProvider>);
    await user.click(screen.getByRole('button', { name: 'Add text, image or file' }));
    await user.click(screen.getByRole('menuitem', { name: 'Text' }));
    const dialog = screen.getByRole('dialog', { name: 'Add text' });
    expect(within(dialog).getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true);
    await user.type(within(dialog).getByLabelText('Text to add'), 'call the plumber');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(add).toHaveBeenCalledWith({ type: 'text', text: 'call the plumber' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByRole('status')).textContent).toBe('Added.');

    const [, fileInput] = container.querySelectorAll('input[type=file]');
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'movie.mp4', { type: 'video/mp4' });
    await user.upload(fileInput as HTMLInputElement, big);
    expect((await screen.findByRole('alert')).textContent).toContain('Too large');
    expect(add).toHaveBeenCalledTimes(1);

    const small = new File([new Uint8Array([1, 2, 3])], 'notes.pdf', { type: 'application/pdf' });
    await user.upload(fileInput as HTMLInputElement, small);
    await waitFor(() => expect(add).toHaveBeenLastCalledWith({ type: 'file', name: 'notes.pdf', mime: 'application/pdf', data: new Uint8Array([1, 2, 3]) }));
  });

  it('speed dial runs an extra action and closes', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<ClipplyProvider client={lib.client()}><AddClip dial actions={[{ icon: Plus, label: 'Save clipboard', onClick: save }]} /></ClipplyProvider>);
    await user.click(screen.getByRole('button', { name: 'Add to Clipply' }));
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Text', 'Image', 'File', 'Save clipboard']);
    await user.click(screen.getByRole('menuitem', { name: 'Save clipboard' }));
    expect(save).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('formats byte sizes', () => {
    expect([formatBytes(10), formatBytes(2048), formatBytes(5 * 1024 * 1024)]).toEqual(['10 B', '2.0 KB', '5.0 MB']);
  });

  it('shows an error state when the client fails', async () => {
    const client = { ...lib.client(), list: async () => Promise.reject(new Error('locked')) };
    render(<ClipplyProvider client={client}><ClipList filter={{}} /></ClipplyProvider>);
    expect((await screen.findByRole('alert')).textContent).toContain('locked');
  });

  it('formats relative times', () => {
    expect(formatRelative(1_000, 30_000, 'en')).toBe('just now');
    expect(formatRelative(0, 3 * 3_600_000, 'en')).toBe('3 hours ago');
    expect(formatRelative(0, 86_400_000, 'en')).toBe('yesterday');
  });
});
