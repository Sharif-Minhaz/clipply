import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyring, rotateKeyring } from '@clipply/crypto';

import { REVOKED_DEVICE_TTL_SECONDS } from '../src/db';
import { loadConfig } from '../src/config';
import { signParams } from '../src/modules/storage/cloudinary';
import { restorePath } from '../src/vercel';
import { bearer, encryptedItem, signIn, startHarness, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h?.close());

const push = (d: Awaited<ReturnType<typeof signIn>>, ops: unknown[]) => request(h.app).post('/v1/sync/push').set(...bearer(d)).send({ ops });
const upsert = (item: ReturnType<typeof encryptedItem>, baseRev = 0, opId = randomUUID()) => ({ type: 'upsert', opId, baseRev, item });

describe('auth', () => {
  it('authorizes the first device only; later devices stay pending', async () => {
    const a = await signIn(h, 'alice');
    const b = await signIn(h, 'alice');
    expect(a.auth.device.status).toBe('authorized');
    expect(b.auth.device.status).toBe('pending');
    expect((await request(h.app).get('/v1/sync/head').set(...bearer(b))).body).toEqual({ error: 'device_not_authorized' });
    const devices = await request(h.app).get('/v1/devices').set(...bearer(b));
    expect(devices.body.devices.map((d: { status: string }) => d.status)).toEqual(['authorized', 'pending']);
  });

  it('rejects bad Google tokens, foreign device ids and swapped device keys', async () => {
    expect((await request(h.app).post('/v1/auth/google').send({ idToken: 'x'.repeat(30), device: {} })).status).toBe(400);
    const valid = await signIn(h, 'carol');
    const res = await request(h.app).post('/v1/auth/google').send({ idToken: `forged:${'x'.repeat(30)}`, device: valid.auth.device });
    expect(res.status).toBe(401);
    await expect(signIn(h, 'mallory', valid.id)).rejects.toThrow(/409/);
    await expect(signIn(h, 'carol', valid.id)).rejects.toThrow(/device_keys_mismatch/);
  });

  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const d = await signIn(h, 'dave');
    const r1 = await request(h.app).post('/v1/auth/refresh').send({ refreshToken: d.refresh });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(d.refresh);
    const replay = await request(h.app).post('/v1/auth/refresh').send({ refreshToken: d.refresh });
    expect(replay.status).toBe(401);
    const afterTheft = await request(h.app).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(afterTheft.status).toBe(401);
  });

  it('rejects missing, forged and expired access tokens', async () => {
    const d = await signIn(h, 'erin');
    expect((await request(h.app).get('/v1/sync/head')).status).toBe(401);
    expect((await request(h.app).get('/v1/sync/head').set('authorization', `Bearer ${d.token}x`)).status).toBe(401);
    h.clock.now += 16 * 60_000;
    expect((await request(h.app).get('/v1/sync/head').set(...bearer(d))).status).toBe(401);
    h.clock.now -= 16 * 60_000;
  });

  it('revocation cuts a device off immediately, including its refresh token', async () => {
    const a = await signIn(h, 'frank');
    const b = await signIn(h, 'frank');
    expect((await request(h.app).post(`/v1/devices/${a.id}/revoke`).set(...bearer(b))).status).toBe(403);
    expect((await request(h.app).post(`/v1/devices/${b.id}/revoke`).set(...bearer(a))).body.status).toBe('revoked');
    expect((await request(h.app).get('/v1/devices').set(...bearer(b))).status).toBe(403);
    expect((await request(h.app).post('/v1/auth/refresh').send({ refreshToken: b.refresh })).body).toEqual({ error: 'device_revoked' });
    const renamed = await request(h.app).patch(`/v1/devices/${a.id}`).set(...bearer(a)).send({ name: 'Laptop' });
    expect(renamed.body.name).toBe('Laptop');
  });

  it('stamps revoked devices for TTL purge and leaves live devices alone', async () => {
    const a = await signIn(h, 'frida');
    const b = await signIn(h, 'frida');
    await request(h.app).post(`/v1/devices/${b.id}/revoke`).set(...bearer(a));
    expect((await h.store.c.devices.findOne({ _id: b.id }))?.revokedAt).toBeInstanceOf(Date);
    expect((await h.store.c.devices.findOne({ _id: a.id }))?.revokedAt).toBeUndefined();
    const ttl = (await h.store.c.devices.indexes()).find((i) => i.key.revokedAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(REVOKED_DEVICE_TTL_SECONDS);
  });
});

describe('sync', () => {
  it('stores ciphertext only, assigns seq/rev, and replays ops idempotently', async () => {
    const d = await signIn(h, 'grace');
    const item = encryptedItem(undefined, 'PLAINTEXT-MARKER');
    const op = upsert(item);
    const first = await push(d, [op]);
    expect(first.body.results).toEqual([{ opId: op.opId, status: 'applied', rev: 1, seq: 1 }]);
    const again = await push(d, [op]);
    expect(again.body.results).toEqual(first.body.results);
    expect((await request(h.app).get('/v1/sync/head').set(...bearer(d))).body).toEqual({ seq: 1, keyEpoch: 1 });

    const raw = JSON.stringify(await h.store.c.items.find({}).toArray()) + JSON.stringify(h.logs);
    expect(raw).not.toContain('PLAINTEXT-MARKER');
    expect(raw).not.toContain('text/plain');
  });

  it('detects edit conflicts, lets delete win, and blocks resurrection', async () => {
    const d = await signIn(h, 'heidi');
    const item = encryptedItem();
    await push(d, [upsert(item)]);
    expect((await push(d, [upsert(item, 1)])).body.results[0]).toMatchObject({ status: 'applied', rev: 2 });
    const stale = (await push(d, [upsert(item, 1)])).body.results[0];
    expect(stale).toMatchObject({ status: 'conflict', current: { rev: 2, deleted: false } });
    const del = (await push(d, [{ type: 'delete', opId: randomUUID(), itemId: item.id }])).body.results[0];
    expect(del).toMatchObject({ status: 'applied', rev: 3 });
    expect((await push(d, [{ type: 'delete', opId: randomUUID(), itemId: item.id }])).body.results[0]).toMatchObject({ status: 'applied', rev: 3, seq: del.seq });
    expect((await push(d, [upsert(item, 3)])).body.results[0]).toMatchObject({ status: 'conflict', current: { deleted: true, id: item.id } });

    // Deleting an id the server never saw still leaves a tombstone, so a late upsert cannot create it.
    const ghost = encryptedItem();
    await push(d, [{ type: 'delete', opId: randomUUID(), itemId: ghost.id }]);
    expect((await push(d, [upsert(ghost)])).body.results[0]).toMatchObject({ status: 'conflict' });
    expect((await push(d, [upsert(encryptedItem(), 5)])).body.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_base_revision' });
  });

  it('orders concurrent pushes without gaps and pages pulls by cursor', async () => {
    const a = await signIn(h, 'ivan');
    const items = Array.from({ length: 12 }, () => encryptedItem());
    await Promise.all(items.map((it) => push(a, [upsert(it)])));
    const seqs = (await h.store.c.items.find({ itemId: { $in: items.map((i) => i.id) } }).toArray()).map((d) => d.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    const p1 = await request(h.app).get('/v1/sync/pull?cursor=0&limit=5').set(...bearer(a));
    expect(p1.body).toMatchObject({ cursor: 5, hasMore: true });
    const p3 = await request(h.app).get('/v1/sync/pull?cursor=10&limit=5').set(...bearer(a));
    expect(p3.body).toMatchObject({ cursor: 12, hasMore: false });
    expect(p3.body.changes).toHaveLength(2);
    expect((await request(h.app).get('/v1/sync/pull?cursor=-1').set(...bearer(a))).status).toBe(400);
  });

  it('isolates users completely', async () => {
    const a = await signIn(h, 'judy');
    const b = await signIn(h, 'ken');
    const item = encryptedItem();
    await push(a, [upsert(item)]);
    expect((await request(h.app).get(`/v1/items/${item.id}`).set(...bearer(b))).status).toBe(404);
    expect((await request(h.app).get('/v1/sync/pull?cursor=0').set(...bearer(b))).body.changes).toEqual([]);
    expect((await push(b, [upsert(item, 1)])).body.results[0]).toMatchObject({ status: 'rejected' });
    expect((await request(h.app).get(`/v1/items/${item.id}`).set(...bearer(a))).body.item.id).toBe(item.id);
  });

  it('rejects items under a retired key epoch and oversized or malformed batches', async () => {
    const d = await signIn(h, 'leo');
    const user = await h.store.c.users.findOne({ googleSub: 'leo' });
    await h.store.c.users.updateOne({ _id: user!._id }, { $set: { keyEpoch: 2 } });
    expect((await push(d, [upsert(encryptedItem(createKeyring()))])).body.results[0]).toMatchObject({ status: 'stale_epoch', currentEpoch: 2 });
    expect((await push(d, [upsert(encryptedItem(rotateKeyring(createKeyring())))])).body.results[0]).toMatchObject({ status: 'applied' });
    expect((await push(d, Array(51).fill(upsert(encryptedItem())))).status).toBe(400);
    expect((await push(d, [{ ...upsert(encryptedItem()), item: { id: 'x' } }])).status).toBe(400);
    const big = await request(h.app).post('/v1/sync/push').set(...bearer(d)).set('content-type', 'application/json').send(`{"ops":"${'a'.repeat(5_000_000)}"}`);
    expect(big.status).toBe(413);
  });
});

describe('storage + maintenance', () => {
  it('signs uploads, verifies Cloudinary responses, serves signed downloads and cleans up', async () => {
    const d = await signIn(h, 'mia');
    const base = encryptedItem();
    const sig = await request(h.app).post('/v1/storage/upload-signature').set(...bearer(d)).send({ itemId: base.id, size: 1000 });
    expect(sig.status).toBe(200);
    const { key, fields, uploadUrl } = sig.body;
    expect(uploadUrl).toBe('https://api.cloudinary.com/v1_1/demo/raw/upload');
    expect(fields).toMatchObject({ type: 'private', public_id: key, api_key: '1234', overwrite: 'false' });
    expect(fields.signature).toBe(signParams({ public_id: key, timestamp: fields.timestamp, type: 'private', overwrite: 'false' }, 'cloud-secret'));

    const withBlob = { ...base, body: undefined, blob: { key, size: 1000 } };
    delete (withBlob as { body?: string }).body;
    expect((await push(d, [upsert(withBlob)])).body.results[0]).toMatchObject({ status: 'rejected', reason: 'blob_not_uploaded' });

    const forged = { public_id: key, version: 7, signature: 'f'.repeat(40), bytes: 1000 };
    expect((await request(h.app).post('/v1/storage/confirm').set(...bearer(d)).send({ key, upload: forged })).status).toBe(400);
    const genuine = { ...forged, signature: signParams({ public_id: key, version: 7 }, 'cloud-secret') };
    expect((await request(h.app).post('/v1/storage/confirm').set(...bearer(d)).send({ key, upload: genuine })).status).toBe(204);
    const other = await signIn(h, 'nick');
    expect((await request(h.app).post('/v1/storage/confirm').set(...bearer(other)).send({ key, upload: genuine })).status).toBe(404);

    expect((await push(d, [upsert(withBlob)])).body.results[0]).toMatchObject({ status: 'applied' });
    const dl = await request(h.app).get(`/v1/storage/download-url?itemId=${base.id}`).set(...bearer(d));
    const url = new URL(dl.body.url);
    expect(url.pathname).toBe('/v1_1/demo/raw/download');
    expect(url.searchParams.get('signature')).toBe(signParams({ public_id: key, timestamp: url.searchParams.get('timestamp')!, type: 'private', expires_at: url.searchParams.get('expires_at')! }, 'cloud-secret'));
    expect((await request(h.app).get(`/v1/storage/download-url?itemId=${base.id}`).set(...bearer(other))).status).toBe(404);

    await push(d, [{ type: 'delete', opId: randomUUID(), itemId: base.id }]);
    expect((await h.store.c.objects.findOne({ _id: key }))?.status).toBe('delete_pending');

    expect((await request(h.app).get('/v1/internal/gc')).status).toBe(401);
    h.clock.now += 31 * 86_400_000;
    const gc = await request(h.app).get('/v1/internal/gc').set('authorization', `Bearer ${'c'.repeat(20)}`);
    expect(gc.body.blobsDestroyed).toBeGreaterThanOrEqual(1);
    expect(gc.body.tombstonesPurged).toBeGreaterThanOrEqual(1);
    expect(h.fetchCalls.some((u) => u.endsWith('/raw/destroy'))).toBe(true);
    expect(await h.store.c.objects.findOne({ _id: key })).toBeNull();
    const refreshed = await request(h.app).post('/v1/auth/refresh').send({ refreshToken: d.refresh });
    const auth = ['authorization', `Bearer ${refreshed.body.accessToken}`] as const;
    expect((await request(h.app).get('/v1/sync/pull?cursor=1').set(...auth)).body).toEqual({ error: 'cursor_expired' });
    expect((await request(h.app).get('/v1/sync/pull?cursor=0').set(...auth)).status).toBe(200);
    h.clock.now -= 31 * 86_400_000;
  });

  it('destroys uploads no item ever referenced, keeps attached ones, and makes a late push re-upload', async () => {
    const d = await signIn(h, 'olga');
    const upload = async (itemId: string): Promise<string> => {
      const { key } = (await request(h.app).post('/v1/storage/upload-signature').set(...bearer(d)).send({ itemId, size: 10 })).body;
      const upload = { public_id: key, version: 1, signature: signParams({ public_id: key, version: 1 }, 'cloud-secret'), bytes: 10 };
      expect((await request(h.app).post('/v1/storage/confirm').set(...bearer(d)).send({ key, upload })).status).toBe(204);
      return key;
    };
    const blobItem = (key: string, base = encryptedItem()) => {
      const { body: _body, ...rest } = base;
      return { ...rest, blob: { key, size: 10 } };
    };

    const kept = encryptedItem();
    const keptKey = await upload(kept.id);
    expect((await push(d, [upsert(blobItem(keptKey, kept))])).body.results[0]).toMatchObject({ status: 'applied' });
    expect((await h.store.c.objects.findOne({ _id: keptKey }))?.status).toBe('attached');

    // Uploaded, then the item was deleted locally before its first push: nothing references it.
    const lost = encryptedItem();
    const lostKey = await upload(lost.id);

    h.clock.now += 4 * 86_400_000;
    const gc = await request(h.app).get('/v1/internal/gc').set('authorization', `Bearer ${'c'.repeat(20)}`);
    expect(gc.body.orphansReleased).toBeGreaterThanOrEqual(1);
    expect(await h.store.c.objects.findOne({ _id: lostKey })).toBeNull();
    expect((await h.store.c.objects.findOne({ _id: keptKey }))?.status).toBe('attached');

    // The device comes back online and pushes anyway: rejected, so the client re-uploads.
    const refreshed = await request(h.app).post('/v1/auth/refresh').send({ refreshToken: d.refresh });
    const late = await request(h.app).post('/v1/sync/push').set('authorization', `Bearer ${refreshed.body.accessToken}`).send({ ops: [upsert(blobItem(lostKey, lost))] });
    expect(late.body.results[0]).toMatchObject({ status: 'rejected', reason: 'blob_not_uploaded' });
    h.clock.now -= 4 * 86_400_000;
  });

  it('matches Cloudinary’s documented signature example', () => {
    expect(signParams({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd'))
      .toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });
});

describe('platform', () => {
  it('rate-limits sign-in attempts per IP', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await request(h.app).post('/v1/auth/refresh').set('x-real-ip', '203.0.113.9').send({ refreshToken: 'a'.repeat(43) })).status;
    }
    expect(last).toBe(429);
  });

  it('answers CORS preflight for allowed origins only, and hides internals', async () => {
    const ok = await request(h.app).options('/v1/sync/push').set('origin', 'https://localhost');
    expect(ok.headers['access-control-allow-origin']).toBe('https://localhost');
    const bad = await request(h.app).options('/v1/sync/push').set('origin', 'https://evil.test');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const health = await request(h.app).get('/v1/health');
    expect(health.body).toEqual({ ok: true });
    expect(health.headers['x-powered-by']).toBeUndefined();
    expect((await request(h.app).get('/nope')).body).toEqual({ error: 'not_found' });
    expect((await request(h.app).post('/v1/auth/google').set('content-type', 'application/json').send('{bad')).body).toEqual({ error: 'invalid_json' });
  });

  it('restores the original path behind the Vercel rewrite', () => {
    expect(restorePath('/api?__path=sync/pull&cursor=3')).toBe('/v1/sync/pull?cursor=3');
    expect(restorePath('/v1/health')).toBe('/v1/health');
  });

  it('reports missing configuration by name only', () => {
    expect(() => loadConfig({ JWT_SECRET: 'short-but-secret-value' })).toThrow(/MONGODB_URI.*JWT_SECRET/);
    expect(() => loadConfig({ JWT_SECRET: 'short-but-secret-value' })).not.toThrow(/short-but-secret-value/);
  });
});
