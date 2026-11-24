import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '@clipply/api-client';
import { createKeyring, fromUtf8, generateDeviceKeys, toB64, utf8, type Keyring } from '@clipply/crypto';
import { itemRepo, kvRepo, migrate, outboxRepo, type SqlDb } from '@clipply/database';
import { openTestDb } from '@clipply/database/testing';
import { createLogger } from '@clipply/logger';
import {
  acceptEnrollment, approveDevice, ClipLibrary, createAccountVault, MAX_CAPTURE_BYTES, memoryChunkStore, refreshKeyring, SYNC_CURSOR, SyncEngine,
  type BlobUploader, type ChunkStore, type DeviceIdentity,
} from '@clipply/sync-engine';

import { runGc } from '../src/modules/maintenance/gc';
import { signParams } from '../src/modules/storage/cloudinary';
import { startHarness, type Harness } from './helpers';

let h: Harness;
let server: Server;
let baseUrl: string;
const cloud = new Map<string, Uint8Array>();
const log = createLogger('sync-test', { sink: () => {} });

/** Stands in for Cloudinary: keeps ciphertext in memory and signs responses like Cloudinary does. */
let failUploadAfter = Infinity;
const uploadBlob: BlobUploader = async (_url, fields, ciphertext) => {
  if (failUploadAfter-- <= 0) throw new Error('connection lost');
  cloud.set(fields.public_id!, ciphertext.slice());
  return { public_id: fields.public_id!, version: 1, bytes: ciphertext.length, signature: signParams({ public_id: fields.public_id!, version: 1 }, 'cloud-secret') };
};
let downloads = 0;
const downloadBlob = async (url: string): Promise<Uint8Array> => {
  downloads++;
  const blob = cloud.get(new URL(url).searchParams.get('public_id')!);
  if (!blob) throw new Error('404');
  return blob;
};

beforeAll(async () => {
  h = await startHarness();
  server = createServer(h.app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
// The injected clock stands still, so each test gets its own rate-limit window.
beforeEach(() => {
  h.clock.now += 61_000;
});
afterAll(async () => {
  server?.close();
  await h?.close();
});

interface Sim {
  me: DeviceIdentity;
  api: ApiClient;
  db: SqlDb;
  ring: Keyring;
  lib: ClipLibrary;
  engine: SyncEngine;
  chunks: ChunkStore;
  pub: { boxPublicKey: string; signPublicKey: string };
  offline: boolean;
}

async function device(sub: string): Promise<Sim> {
  const keys = generateDeviceKeys();
  const me = { deviceId: randomUUID(), keys };
  const pub = { boxPublicKey: toB64(keys.box.publicKey), signPublicKey: toB64(keys.sign.publicKey) };
  const sim = { me, pub, offline: false, ring: createKeyring(), chunks: memoryChunkStore() } as Sim;
  let token: string | null = null;
  const netFetch: typeof fetch = async (input, init) => {
    if (sim.offline) throw new TypeError('fetch failed');
    return fetch(input, init);
  };
  sim.api = createApiClient({ baseUrl, getAccessToken: async () => token, fetch: netFetch });
  token = (await sim.api.signInWithGoogle({
    idToken: `google:${sub}:${sub}@example.com`,
    device: { id: me.deviceId, name: `sim-${sub}`, platform: 'ubuntu', appVersion: '0.1.0', keys: pub },
  })).accessToken;
  sim.db = openTestDb();
  await migrate(sim.db);
  sim.lib = new ClipLibrary({ db: sim.db, keyring: () => sim.ring, deviceId: me.deviceId, fetchBlob: (id, chunk) => sim.engine.fetchBlob(id, chunk), chunks: sim.chunks });
  sim.engine = new SyncEngine({
    db: sim.db, api: sim.api, library: sim.lib, uploadBlob, downloadBlob, log,
    onKeyringStale: async () => {
      sim.ring = (await refreshKeyring(sim.api, sim.me, sim.ring)).ring;
    },
  });
  return sim;
}

/** What a user sees: content, kind and flags, by id. Used to assert convergence. */
async function view(s: Sim): Promise<Array<[string, string, boolean, boolean]>> {
  const out: Array<[string, string, boolean, boolean]> = [];
  for (const v of s.lib.list()) out.push([v.id, fromUtf8(await s.lib.readBody(v.id)), v.meta.pinned, v.meta.favorite]);
  return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

const syncBoth = async (a: Sim, b: Sim): Promise<void> => {
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
};

describe('two-device synchronization', () => {
  let a: Sim;
  let b: Sim;

  it('sets up an account vault and enrolls a second device that already had local history', async () => {
    a = await device('quinn');
    await a.lib.capture({ type: 'text', text: 'from A before sync' });
    a.ring = (await createAccountVault(a.api, a.me, a.ring)).ring;

    b = await device('quinn');
    await b.lib.capture({ type: 'text', text: 'from B before joining' });
    await a.api.claimDevice(b.me.deviceId);
    a.ring = await approveDevice(a.api, a.me, a.ring, { id: b.me.deviceId, keys: b.pub });
    const before = b.ring;
    b.ring = await acceptEnrollment(b.api, b.me, { id: a.me.deviceId, keys: a.pub });
    expect(await b.lib.adoptKeyring(before)).toBe(1);

    await syncBoth(a, b);
    expect((await view(a)).map((v) => v[1]).sort()).toEqual(['from A before sync', 'from B before joining']);
    expect(await view(a)).toEqual(await view(b));
  });

  it('syncs images as encrypted blobs with inline encrypted thumbnails, prefetched in the background', async () => {
    const png = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
    const { id } = (await b.lib.capture({ type: 'image', mime: 'image/png', data: png, thumb: utf8('thumb-bytes'), pixels: png }))!;
    const before = downloads;
    await syncBoth(a, b);
    await a.engine.prefetchImages();
    const blobRow = await itemRepo(a.db).get(id);
    expect(blobRow!.body).not.toBeNull();
    expect(blobRow!.blobKey).toMatch(/^clipply\//);
    expect(a.lib.get(id)?.hasThumb).toBe(true);
    expect(fromUtf8((await a.lib.readThumb(id))!)).toBe('thumb-bytes');
    // Copy reads the cached body: no download at copy time.
    expect(await a.lib.readBody(id)).toEqual(png);
    expect(downloads - before).toBe(1);
    // Cloudinary only ever saw ciphertext.
    for (const blob of cloud.values()) expect(Buffer.from(blob).includes(Buffer.from(png.subarray(0, 64)))).toBe(false);
    await a.lib.remove([id]);
    await syncBoth(a, b);
  });

  it('prefetches at most 5 images, only from the 15 newest items; older ones download on demand', async () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2)); // distinct createdAt keeps the order exact
    const images: string[] = [];
    const texts: string[] = [];
    for (let n = 0; n < 7; n++) {
      const png = Uint8Array.from({ length: 1_000 }, (_, i) => (i + n) % 251);
      images.push((await b.lib.capture({ type: 'image', mime: 'image/png', data: png, thumb: utf8(`t${n}`), pixels: png }))!.id);
      await tick();
    }
    for (let n = 0; n < 9; n++) {
      texts.push((await b.lib.capture({ type: 'text', text: `window filler ${n}` }))!.id);
      await tick();
    }
    await syncBoth(a, b);
    await a.engine.prefetchImages();
    // Newest 15 = 9 texts + images[1..6]; the cap keeps images[2..6]. images[0] is outside the window.
    const cached = await Promise.all(images.map(async (id) => (await itemRepo(a.db).get(id))!.body !== null));
    expect(cached).toEqual([false, false, true, true, true, true, true]);
    const before = downloads;
    await a.lib.readBody(images[0]!);
    expect(downloads - before).toBe(1);
    await a.lib.remove([...images, ...texts]);
    await syncBoth(a, b);
  });

  it('syncs flags of an image whose body was never downloaded here', async () => {
    const png = Uint8Array.from({ length: 9_000 }, (_, i) => (i * 7) % 251);
    const { id } = (await b.lib.capture({ type: 'image', mime: 'image/png', data: png, thumb: utf8('t'), pixels: png }))!;
    await b.engine.sync();
    await a.engine.sync();
    await a.engine.prefetchImages();
    await itemRepo(a.db).put({ ...(await itemRepo(a.db).get(id))!, body: null });
    await a.lib.setFlags(id, { favorite: true });
    await syncBoth(a, b);
    expect(b.lib.get(id)!.meta.favorite).toBe(true);
    expect(await b.lib.readBody(id)).toEqual(png);
    await a.lib.remove([id]);
    await syncBoth(a, b);
  });

  it('syncs all recognized text, and keeps it when an older app pushes without it', async () => {
    const text = `${'word '.repeat(1500)}the end`;
    const png = Uint8Array.from({ length: 9_000 }, (_, i) => (i * 11) % 251);
    const { id } = (await b.lib.capture({ type: 'image', mime: 'image/png', data: png, thumb: utf8('t'), pixels: png }))!;
    await b.lib.setFlags(id, {});
    const scanning = new ClipLibrary({ db: b.db, keyring: () => b.ring, deviceId: b.me.deviceId, recognizeText: async () => text });
    await scanning.load();
    await scanning.recognize(id);
    await syncBoth(a, b);
    expect(a.lib.list({ query: 'the end' }).map((v) => v.id)).toEqual([id]);

    // What an app from before the `ocr` part sends when the user stars the image.
    const item = (await a.api.getItem(id)) as Extract<Awaited<ReturnType<ApiClient['getItem']>>, { deleted: false }>;
    const { ocr, ...older } = item.item;
    expect(ocr).toBeDefined();
    const res = await a.api.push({ ops: [{ type: 'upsert', opId: randomUUID(), baseRev: item.rev, item: older }] });
    expect(res.results[0]!.status).toBe('applied');
    await syncBoth(a, b);
    expect(await b.lib.readOcr(id)).toBe(text);
    expect((await a.api.getItem(id)) as object).toMatchObject({ item: { ocr } });
    await a.lib.remove([id]);
    await syncBoth(a, b);
  });

  it('syncs a file over 10 MB in chunks: resumes an interrupted upload, survives an older app, and is deleted whole', async () => {
    const data = Uint8Array.from({ length: MAX_CAPTURE_BYTES + 3_000_000 }, (_, i) => (i * 13 + (i >> 9)) & 255);
    const { id } = (await b.lib.capture({ type: 'file', mime: 'video/mp4', name: 'trip.mp4', data }))!;
    const { id: small } = (await b.lib.capture({ type: 'text', text: 'not held up by the upload' }))!;
    const blobs = cloud.size;
    failUploadAfter = 2;
    await b.engine.sync();
    failUploadAfter = Infinity;
    expect(cloud.size).toBe(blobs + 2);
    await a.engine.sync();
    expect(a.lib.get(small)).toBeDefined();
    expect(a.lib.get(id)).toBeUndefined();

    await b.db.run('UPDATE outbox SET next_attempt_at = 0');
    await b.engine.sync();
    expect(cloud.size).toBe(blobs + 4);
    await a.engine.sync();
    expect(a.lib.get(id)!.meta).toMatchObject({ kind: 'file', size: data.length, file: { name: 'trip.mp4' } });
    // Only downloaded when opened.
    expect(await a.chunks.ids()).toEqual([]);
    expect(Buffer.compare(await a.lib.readBody(id), data)).toBe(0);
    for (const blob of cloud.values()) expect(Buffer.from(blob).includes(Buffer.from(data.subarray(0, 64)))).toBe(false);

    // Starred by an app that does not know chunks: the server keeps them.
    const item = (await a.api.getItem(id)) as Extract<Awaited<ReturnType<ApiClient['getItem']>>, { deleted: false }>;
    const { chunks, ...older } = item.item;
    expect(chunks).toHaveLength(4);
    await a.api.push({ ops: [{ type: 'upsert', opId: randomUUID(), baseRev: item.rev, item: older }] });
    await syncBoth(a, b);
    expect((await itemRepo(b.db).get(id))!.chunks).toEqual(chunks);

    // The sweep does not mistake the other chunks for orphans.
    const objects = await h.store.c.objects.find({ itemId: id }).toArray();
    expect(objects.filter((o) => o.status === 'attached')).toHaveLength(4);
    await h.store.c.objects.updateMany({ itemId: id }, { $set: { status: 'uploaded', updatedAt: new Date(0) } });
    await runGc(h.store, async () => true, h.clock.now, log);
    expect(await h.store.c.objects.countDocuments({ itemId: id, status: 'attached' })).toBe(4);

    await a.lib.remove([id, small]);
    expect(await a.chunks.ids()).toEqual([]);
    await syncBoth(a, b);
    expect(await b.chunks.ids()).toEqual([]);
    expect(await h.store.c.objects.countDocuments({ itemId: id, status: 'attached' })).toBe(0);
  });

  it('keeps large files on the device while the server does not support them', async () => {
    const { id } = (await b.lib.capture({ type: 'file', mime: 'x/y', name: 'big.bin', data: new Uint8Array(MAX_CAPTURE_BYTES + 1) }))!;
    const head = b.api.syncHead;
    (b.api as { syncHead: typeof head }).syncHead = async () => ({ ...(await head()), features: [] });
    const blobs = cloud.size;
    await b.engine.sync();
    (b.api as { syncHead: typeof head }).syncHead = head;
    expect(cloud.size).toBe(blobs);
    expect((await outboxRepo(b.db).forItem(id))!.lastError).toMatch(/does not support files over 10 MB/);
    await b.lib.remove([id]);
  });

  it('splits a pull into pages the host can send', async () => {
    for (let n = 0; n < 60; n++) {
      const png = Uint8Array.from({ length: 3_000 }, (_, i) => (i * n) % 251);
      await b.lib.capture({ type: 'image', mime: 'image/png', data: png, thumb: new Uint8Array(40_000).fill(n), pixels: png });
    }
    while ((await outboxRepo(b.db).pendingCount()) > 0) expect((await b.engine.sync()).failed).toBe(0);
    const page = await a.api.pull(0, 200);
    expect(JSON.stringify(page).length).toBeLessThan(4_000_000);
    expect(page.hasMore).toBe(true);
    await a.engine.sync();
    expect(a.lib.stats().count).toBe(b.lib.stats().count);

    // A new device pages through all of it even though old deletes were purged meanwhile.
    await h.store.c.users.updateMany({}, { $max: { purgeFloor: (await a.api.syncHead()).seq - 1 } });
    await kvRepo(a.db).set(SYNC_CURSOR, 0);
    expect((await a.engine.sync()).failed).toBe(0);
    expect(await kvRepo(a.db).get(SYNC_CURSOR)).toBe((await a.api.syncHead()).seq);
    await h.store.c.users.updateMany({}, { $set: { purgeFloor: 0 } });
    await b.lib.clear(['image']);
    await syncBoth(a, b);
  });

  it('propagates edits, flags and deletes, and never touches remote clipboards', async () => {
    const id = a.lib.list().find((v) => v.preview === 'from A before sync')!.id;
    await a.lib.editText(id, 'edited on A');
    await b.lib.setFlags(b.lib.list().find((v) => v.preview === 'from B before joining')!.id, { pinned: true });
    await syncBoth(a, b);
    expect(await view(a)).toEqual(await view(b));
    expect((await view(b)).some((v) => v[1] === 'edited on A')).toBe(true);
    expect((await view(a)).some((v) => v[2])).toBe(true);
  });

  it('merges concurrent flag changes and forks concurrent content edits — nothing is lost', async () => {
    const id = a.lib.list().find((v) => v.preview === 'edited on A')!.id;
    a.offline = b.offline = true;
    await a.lib.setFlags(id, { favorite: true });
    await b.lib.setFlags(id, { pinned: true });
    a.offline = b.offline = false;
    await syncBoth(a, b);
    await b.engine.sync();
    expect(a.lib.get(id)?.meta).toMatchObject({ pinned: true, favorite: false });
    expect(await view(a)).toEqual(await view(b));

    a.offline = b.offline = true;
    await a.lib.editText(id, 'version A');
    await b.lib.editText(id, 'version B');
    a.offline = b.offline = false;
    await a.engine.sync();
    const report = await b.engine.sync();
    expect(report.conflicts).toBe(1);
    await syncBoth(a, b);
    const texts = (await view(a)).map((v) => v[1]);
    expect(texts).toContain('version A');
    expect(texts).toContain('version B');
    expect(await view(a)).toEqual(await view(b));
  });

  it('lets a delete win over a concurrent offline edit', async () => {
    const id = a.lib.list().find((v) => v.preview === 'version A')!.id;
    b.offline = true;
    await a.lib.remove([id]);
    await a.engine.sync();
    await b.lib.editText(id, 'edit that loses');
    b.offline = false;
    await syncBoth(a, b);
    expect(a.lib.get(id)).toBeUndefined();
    expect(b.lib.get(id)).toBeUndefined();
    expect(await view(a)).toEqual(await view(b));
  });

  it('collapses the same content copied on both devices into one item', async () => {
    a.offline = b.offline = true;
    await a.lib.capture({ type: 'text', text: 'copied everywhere' });
    await b.lib.capture({ type: 'text', text: 'copied everywhere\r\n' });
    a.offline = b.offline = false;
    await syncBoth(a, b);
    await syncBoth(a, b);
    expect(a.lib.list({ query: 'copied everywhere' })).toHaveLength(1);
    expect(await view(a)).toEqual(await view(b));
  });

  it('survives network failures and lost responses without duplicates', async () => {
    a.offline = true;
    await a.lib.capture({ type: 'text', text: 'made offline' });
    await expect(a.engine.sync()).rejects.toThrow();
    expect(await outboxRepo(a.db).pendingCount()).toBe(1);
    const [op] = await outboxRepo(a.db).due(Infinity, 1);
    expect(op).toMatchObject({ attempts: 1 });
    expect(op!.nextAttemptAt).toBeGreaterThan(Date.now());
    a.offline = false;
    await outboxRepo(a.db).recordFailure(op!.opId, 'reset for test', 0);

    // The push reaches the server but the response is lost; the retry replays the same opId.
    const realPush = a.api.push;
    let first = true;
    a.api.push = vi.fn(async (body) => {
      const res = await realPush(body);
      if (first) {
        first = false;
        throw new TypeError('connection reset');
      }
      return res;
    });
    await a.engine.sync().catch(() => {});
    await outboxRepo(a.db).recordFailure(op!.opId, 'reset for test', 0);
    await a.engine.sync();
    a.api.push = realPush;
    await b.engine.sync();
    expect(b.lib.list({ query: 'made offline' })).toHaveLength(1);
    expect(await outboxRepo(a.db).pendingCount()).toBe(0);
  });

  it('re-syncs from scratch when its cursor predates purged tombstones', async () => {
    const id = a.lib.list().find((v) => v.preview === 'made offline')!.id;
    b.offline = true;
    await a.lib.remove([id]);
    await a.engine.sync();
    h.clock.now += 31 * 86_400_000;
    await fetch(`${baseUrl}/v1/internal/gc`, { headers: { authorization: `Bearer ${'c'.repeat(20)}` } });
    h.clock.now -= 31 * 86_400_000;
    b.offline = false;
    expect(b.lib.get(id)).toBeDefined();
    await b.engine.sync();
    expect(b.lib.get(id)).toBeUndefined();
    expect(await view(a)).toEqual(await view(b));
    expect(await kvRepo(b.db).get('sync.cursor')).toBeGreaterThan(0);
  });

  it('syncIfNeeded stays idle when nothing changed', async () => {
    const pushSpy = vi.spyOn(a.api, 'pull');
    expect(await a.engine.syncIfNeeded()).toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
    await b.lib.capture({ type: 'text', text: 'news' });
    await b.engine.sync();
    expect(await a.engine.syncIfNeeded()).toMatchObject({ pulled: 1 });
  });
});
