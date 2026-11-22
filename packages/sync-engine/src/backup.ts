import { fromB64, fromUtf8, openWithPassphrase, sealWithPassphrase, toB64, utf8 } from '@clipply/crypto';
import { ClipKind } from '@clipply/shared-schemas';
import { z } from 'zod';

import type { CaptureInput, ClipLibrary } from './library';

const Entry = z.object({
  kind: ClipKind,
  mime: z.string().min(1).max(255),
  createdAt: z.number().int().nonnegative(),
  pinned: z.boolean(),
  favorite: z.boolean(),
  title: z.string().max(200).optional(),
  fileName: z.string().max(255).optional(),
  body: z.string(),
  thumb: z.string().optional(),
});
const Payload = z.object({ format: z.literal('clipply-items'), v: z.literal(1), items: z.array(Entry).max(100_000) });
type Entry = z.infer<typeof Entry>;

/**
 * Encrypted export of the whole history (passphrase-protected, portable between accounts and
 * vaults). Items whose body is not available right now (a blob that cannot be downloaded) are skipped.
 */
export async function exportBackup(library: ClipLibrary, passphrase: string): Promise<{ data: Uint8Array; count: number; skipped: number }> {
  const items: Entry[] = [];
  let skipped = 0;
  for (const v of library.list()) {
    try {
      const body = await library.readBody(v.id);
      const thumb = v.hasThumb ? await library.readThumb(v.id) : null;
      const { meta } = v;
      items.push({
        kind: meta.kind, mime: meta.mime, createdAt: meta.createdAt, pinned: meta.pinned, favorite: meta.favorite,
        ...(meta.title ? { title: meta.title } : {}), ...(meta.file ? { fileName: meta.file.name } : {}),
        body: toB64(body), ...(thumb ? { thumb: toB64(thumb) } : {}),
      });
    } catch {
      skipped++;
    }
  }
  const data = await sealWithPassphrase(passphrase, utf8(JSON.stringify({ format: 'clipply-items', v: 1, items })));
  return { data, count: items.length, skipped };
}

function toInput(e: Entry): CaptureInput {
  const data = fromB64(e.body);
  switch (e.kind) {
    case 'image':
      return { type: 'image', mime: e.mime, data, ...(e.thumb ? { thumb: fromB64(e.thumb) } : {}) };
    case 'file':
      return { type: 'file', mime: e.mime, data, name: e.fileName ?? 'file' };
    case 'html':
      return { type: 'html', html: fromUtf8(data) };
    default:
      return { type: 'text', text: fromUtf8(data) };
  }
}

/** Adds the backup's items to history (encrypted under this vault); existing identical items are left as they are. */
export async function importBackup(library: ClipLibrary, file: Uint8Array, passphrase: string): Promise<{ imported: number; duplicates: number; failed: number }> {
  const parsed = Payload.safeParse(JSON.parse(fromUtf8(await openWithPassphrase(passphrase, file))));
  if (!parsed.success) throw new Error('backup contents are not valid');
  const out = { imported: 0, duplicates: 0, failed: 0 };
  // Oldest first, so ids (time-ordered) follow the original order.
  for (const e of [...parsed.data.items].sort((a, b) => a.createdAt - b.createdAt)) {
    try {
      const r = await library.capture(toInput(e), { createdAt: e.createdAt, pinned: e.pinned, favorite: e.favorite, title: e.title });
      if (r?.duplicate) out.duplicates++;
      else if (r) out.imported++;
    } catch {
      out.failed++;
    }
  }
  return out;
}
