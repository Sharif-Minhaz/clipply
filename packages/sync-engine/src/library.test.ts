// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKeyring, fromUtf8, initCrypto, rotateKeyring, toB64, utf8, type Keyring } from '@clipply/crypto';
import { EncryptedItem } from '@clipply/shared-schemas';
import { itemRepo, migrate, outboxRepo, type SqlDb } from '@clipply/database';
import { openTestDb } from '@clipply/database/testing';

import { classifyText, htmlToText, saveFileName, uuidv7 } from './content';
import { ClipLibrary, ContentTooLargeError, fitOcr, ItemNotFoundError, MAX_CAPTURE_BYTES, MAX_OCR_BYTES } from './library';
import { exportBackup, importBackup } from './backup';

const DEVICE = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
let db: SqlDb;
let ring: Keyring;
let clock: number;
let lib: ClipLibrary;

beforeAll(initCrypto);
beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
  ring = createKeyring();
  clock = 1_000;
  lib = new ClipLibrary({ db, keyring: () => ring, deviceId: DEVICE, now: () => clock++ });
});

describe('content helpers', () => {
  it('classifies urls, code and text', () => {
    expect(classifyText('https://example.com/a?b=1')).toBe('url');
    expect(classifyText('see https://example.com')).toBe('text');
    expect(classifyText('const x = 1;\nif (x) {\n  run();\n}')).toBe('code');
    expect(classifyText('Shopping list:\nmilk\neggs')).toBe('text');
  });

  it('extracts text from html without scripts', () => {
    expect(htmlToText('<p>Hi&nbsp;<b>there</b></p><script>alert(1)</script>')).toBe('Hi there');
  });

  it('makes time-ordered v7 uuids', () => {
    const a = uuidv7(1);
    const b = uuidv7(2);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('ClipLibrary', () => {
  it('captures text encrypted at rest and queues it for sync', async () => {
    const res = await lib.capture({ type: 'text', text: 'my secret note' });
    expect(res).toMatchObject({ duplicate: false });
    const row = await itemRepo(db).get(res!.id);
    const stored = Buffer.concat([row!.meta, row!.body!, row!.dek]).toString('latin1');
    expect(stored).not.toContain('my secret note');
    expect(stored).not.toContain('text/plain');
    expect(row).toMatchObject({ syncState: 'pending', keyEpoch: 1 });
    expect(await outboxRepo(db).pendingCount()).toBe(1);
    expect(fromUtf8(await lib.readBody(res!.id))).toBe('my secret note');
    expect(lib.list()[0]).toMatchObject({ preview: 'my secret note', meta: { kind: 'text', originDeviceId: DEVICE } });
  });

  it('ignores empty text and rejects oversize content', async () => {
    expect(await lib.capture({ type: 'text', text: '  \r\n ' })).toBeNull();
    await expect(lib.capture({ type: 'file', mime: 'x/y', name: 'a', data: new Uint8Array(MAX_CAPTURE_BYTES + 1) })).rejects.toThrow(ContentTooLargeError);
  });

  it('moves duplicates to the top instead of storing them twice', async () => {
    const a = await lib.capture({ type: 'text', text: 'same\r\n' });
    await lib.capture({ type: 'text', text: 'other' });
    const again = await lib.capture({ type: 'text', text: 'same  ' });
    expect(again).toEqual({ id: a!.id, duplicate: true });
    expect(lib.list().map((v) => v.preview)).toEqual(['same\r\n', 'other']);
    expect(await itemRepo(db).count()).toBe(2);
  });

  it('dedupes images by pixels when provided, and keeps text and file namespaces apart', async () => {
    const pixels = Uint8Array.of(1, 2, 3, 4);
    const a = await lib.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(9), pixels, thumb: Uint8Array.of(5) });
    const b = await lib.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(8), pixels });
    expect(b!.id).toBe(a!.id);
    expect(await lib.readThumb(a!.id)).toEqual(Uint8Array.of(5));
    const f = await lib.capture({ type: 'file', mime: 'text/plain', name: 'n.txt', data: utf8('hello') });
    const t = await lib.capture({ type: 'text', text: 'hello' });
    expect(f!.id).not.toBe(t!.id);
  });

  it('edits text, re-classifies and updates search', async () => {
    const { id } = (await lib.capture({ type: 'text', text: 'draft' }))!;
    await lib.editText(id, 'https://clipply.dev');
    expect(lib.get(id)?.meta).toMatchObject({ kind: 'url' });
    expect(lib.get(id)?.meta.editedAt).toBeGreaterThan(0);
    expect(lib.list({ query: 'CLIPPLY' }).map((v) => v.id)).toEqual([id]);
    expect(lib.list({ query: 'draft' })).toEqual([]);
    const img = (await lib.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(1) }))!;
    await expect(lib.editText(img.id, 'x')).rejects.toThrow(TypeError);
  });

  it('filters by kind and flags, which never reach the database in clear inside meta', async () => {
    const { id } = (await lib.capture({ type: 'text', text: 'pin me' }))!;
    await lib.capture({ type: 'html', html: '<b>bold move</b>' });
    await lib.setFlags(id, { pinned: true, favorite: undefined, title: 'Important' });
    expect(lib.list({ pinned: true }).map((v) => v.id)).toEqual([id]);
    // A legacy pin counts as a favorite.
    expect(lib.list({ favorite: true }).map((v) => v.id)).toEqual([id]);
    expect(lib.list({ favorite: false }).map((v) => v.id)).not.toContain(id);
    expect(lib.list({ kinds: ['html'] })[0]?.preview).toBe('bold move');
    expect(lib.list({ query: 'important' }).map((v) => v.id)).toEqual([id]);
    const row = await itemRepo(db).get(id);
    expect(row?.pinned).toBe(true);
    expect(Buffer.from(row!.meta).toString('latin1')).not.toContain('Important');
  });

  it('purges never-synced deletes and tombstones synced ones', async () => {
    const local = (await lib.capture({ type: 'text', text: 'a' }))!;
    const synced = (await lib.capture({ type: 'text', text: 'b' }))!;
    const row = await itemRepo(db).get(synced.id);
    await itemRepo(db).put({ ...row!, rev: 1, seq: 7, syncState: 'synced' });
    await lib.remove([local.id, synced.id, 'missing']);
    expect(await itemRepo(db).get(local.id)).toBeNull();
    expect(await itemRepo(db).get(synced.id)).toMatchObject({ deleted: true, body: null });
    const ops = await outboxRepo(db).due(Infinity, 10);
    expect(ops).toEqual([expect.objectContaining({ itemId: synced.id, type: 'delete' })]);
    expect(lib.list()).toEqual([]);
    await expect(lib.readBody(synced.id)).rejects.toThrow(ItemNotFoundError);
  });

  it('applies retention but keeps pinned and favorite items', async () => {
    const old = (await lib.capture({ type: 'text', text: 'old' }))!;
    const keep = (await lib.capture({ type: 'text', text: 'keep' }))!;
    await lib.setFlags(keep.id, { favorite: true });
    clock = 10_000;
    await lib.capture({ type: 'text', text: 'fresh' });
    expect(await lib.applyRetention(5_000)).toBe(1);
    expect(lib.get(old.id)).toBeUndefined();
    expect(lib.list().map((v) => v.preview).sort()).toEqual(['fresh', 'keep']);
  });

  it('reloads from disk, survives key rotation and isolates corrupt rows', async () => {
    const before = (await lib.capture({ type: 'text', text: 'before rotation' }))!;
    ring = rotateKeyring(ring);
    const after = (await lib.capture({ type: 'text', text: 'after rotation' }))!;
    expect((await itemRepo(db).get(after.id))?.keyEpoch).toBe(2);

    const row = await itemRepo(db).get(before.id);
    const meta = row!.meta.slice();
    meta[meta.length - 1]! ^= 1;
    await itemRepo(db).put({ ...row!, meta });

    const fresh = new ClipLibrary({ db, keyring: () => ring, deviceId: DEVICE });
    await fresh.load();
    expect(fresh.list().map((v) => v.preview)).toEqual(['after rotation']);
    expect(fresh.corruptCount).toBe(1);
  });

  it('downloads a remote body once when a copy races a background prefetch', async () => {
    const { id } = (await lib.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(9, 8, 7) }))!;
    const row = await itemRepo(db).get(id);
    await itemRepo(db).put({ ...row!, body: null, blobKey: 'k', blobSize: row!.body!.length });
    let fetches = 0;
    const remote = new ClipLibrary({ db, keyring: () => ring, deviceId: DEVICE, fetchBlob: async () => (fetches++, row!.body!) });
    await remote.load();
    const [, body] = await Promise.all([remote.cacheBody(id), remote.readBody(id)]);
    expect(body).toEqual(Uint8Array.of(9, 8, 7));
    expect(fetches).toBe(1);
    expect((await itemRepo(db).get(id))!.body).toEqual(row!.body);
  });

  it('re-keys local history into another vault without touching bodies', async () => {
    const { id } = (await lib.capture({ type: 'text', text: 'joins the account' }))!;
    await lib.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(1, 2, 3) });
    const before = await itemRepo(db).get(id);
    const old = ring;
    ring = createKeyring();
    expect(await lib.adoptKeyring(old)).toBe(2);
    const after = await itemRepo(db).get(id);
    expect(after!.body).toEqual(before!.body);
    expect(after!.dek).not.toEqual(before!.dek);
    expect(after!.contentHash).toBe(lib.hashOf({ type: 'text', text: 'joins the account' }));
    expect(lib.list().map((v) => v.preview)).toContain('joins the account');
    expect(lib.corruptCount).toBe(0);
    expect(await lib.capture({ type: 'text', text: 'joins the account' })).toMatchObject({ id, duplicate: true });
  });

  it('notifies subscribers and exposes the hash for self-write detection', async () => {
    let calls = 0;
    const off = lib.subscribe(() => calls++);
    await lib.capture({ type: 'text', text: 'x' });
    off();
    await lib.capture({ type: 'text', text: 'y' });
    expect(calls).toBe(1);
    expect(lib.hashOf({ type: 'text', text: 'x\r\n' })).toBe(lib.list({ query: 'x' })[0]?.meta.contentHash);
  });
});

describe('encrypted backup', () => {
  it('exports with a passphrase and imports into another vault, keeping metadata and skipping duplicates', async () => {
    const t = await lib.capture({ type: 'text', text: 'backup me' });
    await lib.setFlags(t!.id, { pinned: true, title: 'Kept' });
    await lib.capture({ type: 'image', mime: 'image/png', data: new Uint8Array([1, 2, 3]), thumb: new Uint8Array([9]) });
    const { data, count } = await exportBackup(lib, 'long enough passphrase');
    expect(count).toBe(2);
    expect(new TextDecoder().decode(data)).not.toContain('backup me');

    const otherDb = openTestDb();
    await migrate(otherDb);
    const otherRing = createKeyring();
    const other = new ClipLibrary({ db: otherDb, keyring: () => otherRing, deviceId: DEVICE });
    await other.capture({ type: 'text', text: 'backup me' });
    await expect(importBackup(other, data, 'wrong passphrase!!')).rejects.toThrow(/wrong passphrase/);
    expect(await importBackup(other, data, 'long enough passphrase')).toEqual({ imported: 1, duplicates: 1, failed: 0 });
    const img = other.list({ kinds: ['image'] })[0]!;
    expect(await other.readBody(img.id)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await other.readThumb(img.id)).toEqual(new Uint8Array([9]));
    expect(img.meta.createdAt).toBe(lib.list({ kinds: ['image'] })[0]!.meta.createdAt);
  });
});

describe('saveFileName', () => {
  it('keeps file names and matches image extensions to the mime type', () => {
    expect(saveFileName({ kind: 'file', mime: 'application/pdf', file: { name: 'a.pdf' } } as never)).toBe('a.pdf');
    expect(saveFileName({ kind: 'image', mime: 'image/jpeg' })).toBe('image.jpg');
    expect(saveFileName({ kind: 'image', mime: 'image/WEBP' })).toBe('image.webp');
    expect(saveFileName({ kind: 'image', mime: 'image/x-unknown' })).toBe('image.png');
    expect(saveFileName({ kind: 'text', mime: 'text/plain' })).toBe('clip.txt');
  });
});

describe('text recognition', () => {
  it('never scans on capture; recognizes on demand, stores the text in the meta and makes it searchable', async () => {
    const seen: string[] = [];
    const ocr = new ClipLibrary({
      db, keyring: () => ring, deviceId: DEVICE, now: () => clock++,
      recognizeText: async (image, mime) => (seen.push(`${mime}:${image.length}`), '  Invoice   #42\n\n\nTotal  9.99 '),
    });
    const { id } = (await ocr.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(1, 2, 3) }))!;
    expect(seen).toEqual([]);
    expect(ocr.get(id)?.meta.ocr).toBeUndefined();
    expect(await ocr.recognize(id)).toBe('Invoice #42\nTotal 9.99');
    expect(seen).toEqual(['image/png:3']);
    expect(ocr.get(id)?.meta.ocr).toBe('Invoice #42\nTotal 9.99');
    expect(ocr.list({ query: 'invoice' }).map((v) => v.id)).toEqual([id]);
    const text = (await ocr.capture({ type: 'text', text: 'not an image' }))!;
    await expect(ocr.recognize(text.id)).rejects.toThrow(TypeError);
  });

  it('a failed scan leaves the item untouched; no text found is stored as empty', async () => {
    let fail = true;
    const ocr = new ClipLibrary({
      db, keyring: () => ring, deviceId: DEVICE, now: () => clock++,
      recognizeText: async () => {
        if (fail) throw new Error('engine crashed');
        return '';
      },
    });
    const { id } = (await ocr.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(7) }))!;
    await expect(ocr.recognize(id)).rejects.toThrow('engine crashed');
    expect(ocr.get(id)?.meta.ocr).toBeUndefined();
    fail = false;
    expect(await ocr.recognize(id)).toBe('');
    expect(ocr.get(id)?.meta.ocr).toBe('');
  });

  it('cuts long text so the sealed meta still fits the wire limit, even with a full title', async () => {
    const long = 'অক্ষর '.repeat(2000);
    expect(utf8(JSON.stringify(fitOcr(long))).length - 2).toBeLessThanOrEqual(MAX_OCR_BYTES);
    const ocr = new ClipLibrary({ db, keyring: () => ring, deviceId: DEVICE, now: () => clock++, recognizeText: async () => long });
    const { id } = (await ocr.capture({ type: 'image', mime: 'image/png', data: Uint8Array.of(4) }))!;
    await ocr.recognize(id);
    await ocr.setFlags(id, { title: 'শ'.repeat(200) });
    const row = (await itemRepo(db).get(id))!;
    expect(EncryptedItem.shape.meta.safeParse(toB64(row.meta)).success).toBe(true);
  });
});

describe('pagination', () => {
  it('returns one page of matches, newest first, with the total', async () => {
    for (const t of ['one', 'two', 'three', 'four', 'five']) await lib.capture({ type: 'text', text: t });
    expect(lib.page({ limit: 2 })).toMatchObject({ total: 5, items: [{ preview: 'five' }, { preview: 'four' }] });
    expect(lib.page({ offset: 4, limit: 2 }).items.map((v) => v.preview)).toEqual(['one']);
    expect(lib.page({ offset: 10, limit: 2 })).toEqual({ items: [], total: 5 });
    // Filters apply before paging, so the total counts matches only.
    expect(lib.page({ query: 'o', offset: 1, limit: 1 })).toMatchObject({ total: 3, items: [{ preview: 'two' }] });
  });
});
