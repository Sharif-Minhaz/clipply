import { describe, expect, it } from 'vitest';

import { EncryptedItem, ItemMeta, KeyEnvelope, PullQuery, PushRequest, ServerItem } from './index';

const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const b64 = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64url');

const item = { id, encVersion: 1, keyEpoch: 1, dek: b64(72), meta: b64(200) } as const;

describe('EncryptedItem', () => {
  it('accepts exactly one of body or blob', () => {
    expect(EncryptedItem.safeParse({ ...item, body: b64(100) }).success).toBe(true);
    expect(EncryptedItem.safeParse({ ...item, blob: { key: 'u/x', size: 9 } }).success).toBe(true);
    expect(EncryptedItem.safeParse(item).success).toBe(false);
    expect(EncryptedItem.safeParse({ ...item, body: b64(1), blob: { key: 'u/x', size: 9 } }).success).toBe(false);
  });

  it('allows a thumbnail only next to a blob, and caps blob size', () => {
    const blob = { key: 'u/x', size: 9 };
    expect(EncryptedItem.safeParse({ ...item, blob, thumb: b64(100) }).success).toBe(true);
    expect(EncryptedItem.safeParse({ ...item, body: b64(1), thumb: b64(100) }).success).toBe(false);
    expect(EncryptedItem.safeParse({ ...item, blob: { key: 'u/x', size: 10 * 1024 * 1024 + 1 } }).success).toBe(false);
  });

  it('rejects padded or standard base64 and oversize inline bodies', () => {
    expect(EncryptedItem.safeParse({ ...item, body: 'ab+/==' }).success).toBe(false);
    expect(EncryptedItem.safeParse({ ...item, body: b64(60_000) }).success).toBe(false);
  });
});

describe('ServerItem', () => {
  it('keeps no ciphertext on tombstones', () => {
    const parsed = ServerItem.parse({ rev: 3, seq: 10, updatedAt: 1, deleted: true, id, item });
    expect(parsed).not.toHaveProperty('item');
  });
});

describe('ItemMeta', () => {
  it('requires a 256-bit hex content hash', () => {
    const meta = {
      kind: 'text', mime: 'text/plain', createdAt: 1, originDeviceId: id, size: 5,
      contentHash: 'a'.repeat(64), favorite: false, pinned: true,
    };
    expect(ItemMeta.safeParse(meta).success).toBe(true);
    expect(ItemMeta.safeParse({ ...meta, contentHash: 'abc' }).success).toBe(false);
  });
});

describe('sync requests', () => {
  it('bounds push batches', () => {
    const op = { type: 'delete', opId: id, itemId: id };
    expect(PushRequest.safeParse({ ops: [op] }).success).toBe(true);
    expect(PushRequest.safeParse({ ops: [] }).success).toBe(false);
    expect(PushRequest.safeParse({ ops: Array(51).fill(op) }).success).toBe(false);
  });

  it('coerces query-string cursors and rejects negatives', () => {
    expect(PullQuery.parse({ cursor: '42' })).toEqual({ cursor: 42, limit: 200 });
    expect(PullQuery.safeParse({ cursor: '-1' }).success).toBe(false);
    expect(PullQuery.safeParse({ cursor: '1', limit: '501' }).success).toBe(false);
  });
});

describe('KeyEnvelope', () => {
  it('requires a 64-byte signature', () => {
    const env = { deviceId: id, epoch: 1, sealed: b64(120), signerDeviceId: id, signature: b64(64) };
    expect(KeyEnvelope.safeParse(env).success).toBe(true);
    expect(KeyEnvelope.safeParse({ ...env, signature: b64(32) }).success).toBe(false);
  });
});
