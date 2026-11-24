// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { itemRepo, kvRepo, migrate, MIGRATIONS, outboxRepo, Transactor, type ItemRow, type SqlDb } from './index';
import { openTestDb } from './testing';

let db: SqlDb;
beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
});

const row = (id: string, createdAt: number, extra: Partial<ItemRow> = {}): ItemRow => ({
  id, keyEpoch: 1, dek: Uint8Array.of(1), meta: Uint8Array.of(2), body: Uint8Array.of(3), thumb: null,
  blobKey: null, blobSize: null, ocr: null, chunks: null, contentHash: `h${id}`, createdAt, pinned: false, favorite: false,
  deleted: false, rev: 0, seq: null, syncState: 'local', updatedAt: createdAt, ...extra,
});

describe('migrate', () => {
  it('is idempotent and refuses a newer schema', async () => {
    expect(await migrate(db)).toBe(MIGRATIONS.length);
    await db.run('INSERT INTO schema_migrations VALUES (?, ?)', [MIGRATIONS.length + 1, 0]);
    await expect(migrate(db)).rejects.toThrow(/newer than this app/);
  });
});

describe('itemRepo', () => {
  it('round-trips a row including blobs and booleans', async () => {
    const items = itemRepo(db);
    const r = row('a', 10, { pinned: true, blobKey: 'k', blobSize: 9, thumb: Uint8Array.of(7), ocr: Uint8Array.of(8), chunks: [{ key: 'k', size: 9 }, null] });
    await items.put(r);
    expect(await items.get('a')).toEqual(r);
    expect(await items.get('missing')).toBeNull();
  });

  it('lists newest first with stable keyset pages and hides tombstones', async () => {
    const items = itemRepo(db);
    for (const [id, t] of [['a', 1], ['b', 2], ['c', 2], ['d', 3]] as const) await items.put(row(id, t));
    await items.markDeleted('a', 99);
    const first = await items.list(2);
    expect(first.map((i) => i.id)).toEqual(['d', 'c']);
    const last = first.at(-1)!;
    expect((await items.list(10, { createdAt: last.createdAt, id: last.id })).map((i) => i.id)).toEqual(['b']);
    expect(await items.count()).toBe(3);
  });

  it('lists for the index without thumbnails or large bodies, with the same paging', async () => {
    const items = itemRepo(db);
    await items.put(row('small', 3, { body: new Uint8Array(10), thumb: Uint8Array.of(7) }));
    await items.put(row('large', 2, { body: new Uint8Array(5000) }));
    await items.put(row('blob', 1, { body: null }));
    const page = await items.listForIndex(2, undefined, 100);
    expect(page.map((r) => [r.id, r.body?.length ?? null, r.thumb, r.hasThumb])).toEqual([['small', 10, null, true], ['large', null, null, false]]);
    const rest = await items.listForIndex(10, { createdAt: 2, id: 'large' }, 100);
    expect(rest.map((r) => r.id)).toEqual(['blob']);
  });

  it('drops ciphertext on delete and purges only tombstones', async () => {
    const items = itemRepo(db);
    await items.put(row('a', 1));
    await items.purge('a');
    expect(await items.get('a')).not.toBeNull();
    await items.markDeleted('a', 5);
    const dead = await items.get('a');
    expect(dead).toMatchObject({ deleted: true, body: null, updatedAt: 5 });
    expect(dead!.meta.length + dead!.dek.length).toBe(0);
    await items.purge('a');
    expect(await items.get('a')).toBeNull();
  });

  it('finds live duplicates by hash and selects retention candidates', async () => {
    const items = itemRepo(db);
    await items.put(row('a', 1, { contentHash: 'same' }));
    await items.put(row('p', 1, { pinned: true }));
    await items.put(row('f', 1, { favorite: true }));
    await items.put(row('new', 100));
    expect((await items.findLiveByHash('same'))?.id).toBe('a');
    await items.markDeleted('a', 2);
    expect(await items.findLiveByHash('same')).toBeNull();
    await items.put(row('old', 1));
    expect(await items.expiredIds(50)).toEqual(['old']);
  });
});

describe('outboxRepo', () => {
  it('keeps one op per item, never downgrades a delete, and completes only the pushed op', async () => {
    const outbox = outboxRepo(db);
    await outbox.enqueue('a', 'upsert', 'op1', 0);
    await outbox.enqueue('a', 'delete', 'op2', 1);
    await outbox.enqueue('a', 'upsert', 'op3', 2);
    const [op] = await outbox.due(10, 10);
    expect(op).toMatchObject({ itemId: 'a', type: 'delete', opId: 'op3' });
    await outbox.complete('op1');
    expect(await outbox.pendingCount()).toBe(1);
    await outbox.complete('op3');
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('backs off failed ops', async () => {
    const outbox = outboxRepo(db);
    await outbox.enqueue('a', 'upsert', 'op1', 0);
    await outbox.recordFailure('op1', 'network', 1000);
    expect(await outbox.due(999, 10)).toEqual([]);
    expect((await outbox.due(1000, 10))[0]).toMatchObject({ attempts: 1, lastError: 'network' });
  });
});

describe('kvRepo', () => {
  it('stores JSON values', async () => {
    const kv = kvRepo(db);
    expect(await kv.get('cursor')).toBeUndefined();
    await kv.set('cursor', 5);
    await kv.set('cursor', 6);
    expect(await kv.get<number>('cursor')).toBe(6);
  });
});

describe('Transactor', () => {
  it('rolls back on error and serializes concurrent transactions', async () => {
    const tx = new Transactor(db);
    const items = itemRepo(db);
    await expect(
      tx.transaction(async (d) => {
        await itemRepo(d).put(row('x', 1));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await items.get('x')).toBeNull();

    await Promise.all([
      tx.transaction(async (d) => itemRepo(d).put(row('y', 1))),
      tx.transaction(async (d) => itemRepo(d).put(row('z', 1))),
    ]);
    expect(await items.count()).toBe(2);
  });
});
