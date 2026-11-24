import type { ClipKind, ItemMeta } from '@clipply/shared-schemas';
import type { ClipView, ListFilter, ManualInput } from '@clipply/sync-engine';

import type { ClipplyClient } from './client';

const PENDING = 'pending:';

/** True for the placeholder of an add that has not finished yet; it has no stored item behind it. */
export const isPendingId = (id: string): boolean => id.startsWith(PENDING);

type Flags = Parameters<ClipplyClient['setFlags']>[1];

const guessKind = (input: ManualInput): ClipKind =>
  input.type === 'text' ? (/^https?:\/\/\S+$/i.test(input.text.trim()) ? 'url' : 'text') : input.type;

function placeholder(id: string, input: ManualInput, now: number): ClipView {
  const kind = guessKind(input);
  const isText = input.type === 'text';
  const meta: ItemMeta = {
    kind,
    mime: isText ? 'text/plain' : input.mime,
    createdAt: now,
    originDeviceId: '00000000-0000-0000-0000-000000000000',
    size: isText ? new TextEncoder().encode(input.text).length : input.data.length,
    contentHash: '0'.repeat(64),
    favorite: false,
    pinned: false,
    ...(input.type === 'file' ? { file: { name: input.name } } : {}),
  };
  return { id, meta, preview: isText ? input.text.trim().slice(0, 500) : input.name, hasThumb: input.type === 'image' };
}

function matchesFlags(v: ClipView, f: ListFilter): boolean {
  if (f.pinned !== undefined && v.meta.pinned !== f.pinned) return false;
  return f.favorite === undefined || (v.meta.favorite || v.meta.pinned) === f.favorite;
}

function matches(v: ClipView, f: ListFilter): boolean {
  if (f.kinds && !f.kinds.includes(v.meta.kind)) return false;
  if (!matchesFlags(v, f)) return false;
  const q = f.query?.trim().toLowerCase();
  return !q || v.preview.toLowerCase().includes(q) || !!v.meta.title?.toLowerCase().includes(q);
}

/**
 * Wraps a platform client so adds, deletes and flag changes show at once instead of after the
 * platform round-trip (IPC, the SQLite bridge, a sync holding the database). Each change is layered
 * over `list()` results until the real call settles; on failure the layer is dropped (rollback) and
 * the error still reaches the caller.
 */
export function optimistic(inner: ClipplyClient): ClipplyClient {
  const adds = new Map<string, { view: ClipView; thumb: Uint8Array | null }>();
  const hidden = new Map<string, number>();
  const flags = new Map<string, { token: number; flags: Flags }>();
  const listeners = new Set<() => void>();
  let seq = 0;
  const emit = (): void => listeners.forEach((l) => l());

  const overlay = (v: ClipView): ClipView => {
    const f = flags.get(v.id)?.flags;
    if (!f) return v;
    const defined = Object.fromEntries(Object.entries(f).filter(([, x]) => x !== undefined));
    return { ...v, meta: { ...v.meta, ...defined } };
  };

  return {
    readBody: (id) => inner.readBody(id),
    linkPreview: (id) => inner.linkPreview(id),
    openUrl: (id) => inner.openUrl(id),
    copy: (id) => inner.copy(id),
    copyText: (text) => inner.copyText(text),
    recognizeText: (id) => inner.recognizeText(id),
    imageText: (id) => inner.imageText(id),
    similarTexts: () => inner.similarTexts(),
    saveFile: (id) => inner.saveFile(id),
    editText: (id, text) => inner.editText(id, text),
    storage: () => inner.storage(),
    clear: (kinds) => inner.clear(kinds),

    subscribe(onChange) {
      listeners.add(onChange);
      const off = inner.subscribe(onChange);
      return () => {
        listeners.delete(onChange);
        off();
      };
    },

    async list(filter) {
      // Overrides apply to the page the platform returns: deletes and flag changes that leave the filter
      // drop out, pending adds lead the first page. The next real list (after the call settles) is exact.
      const real = await inner.list(filter);
      // The platform's own matches stand (it searches full text, this layer only sees previews).
      const shown = real.items.filter((v) => !hidden.has(v.id)).map(overlay).filter((v) => !flags.has(v.id) || matchesFlags(v, filter));
      const pending = (filter.offset ?? 0) === 0 ? [...adds.values()].map((a) => a.view).filter((v) => matches(v, filter)).reverse() : [];
      return { items: [...pending, ...shown], total: Math.max(0, real.total - (real.items.length - shown.length) + pending.length) };
    },

    async readThumb(id) {
      if (isPendingId(id)) return adds.get(id)?.thumb ?? null;
      return inner.readThumb(id);
    },

    async add(input) {
      const id = `${PENDING}${++seq}`;
      adds.set(id, { view: placeholder(id, input, Date.now()), thumb: input.type === 'image' ? input.data : null });
      emit();
      try {
        return await inner.add(input);
      } finally {
        adds.delete(id);
        emit();
      }
    },

    async remove(ids) {
      const token = ++seq;
      const real = ids.filter((id) => !isPendingId(id));
      for (const id of real) hidden.set(id, token);
      emit();
      try {
        await inner.remove(real);
      } finally {
        for (const id of real) if (hidden.get(id) === token) hidden.delete(id);
        emit();
      }
    },

    async setFlags(id, next) {
      if (isPendingId(id)) return;
      const token = ++seq;
      flags.set(id, { token, flags: { ...flags.get(id)?.flags, ...next } });
      emit();
      try {
        await inner.setFlags(id, next);
      } finally {
        if (flags.get(id)?.token === token) flags.delete(id);
        emit();
      }
    },
  };
}
