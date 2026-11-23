import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '@clipply/api-client';
import {
  createKeyring, fromB64, fromUtf8, generateDeviceKeys, openPart, rosterEntry, sealKeyringFor, toB64, unwrapDek,
  type Keyring,
} from '@clipply/crypto';
import {
  acceptEnrollment, approveDevice, createAccountVault, enrollmentCodeFor, recoverVault, refreshKeyring, replaceRecoveryKey, revokeAndRotate,
  VaultProtocolError, type DeviceIdentity,
} from '@clipply/sync-engine';
import type { EncryptedItem } from '@clipply/shared-schemas';

import { encryptedItem, startHarness, type Harness } from './helpers';

let h: Harness;
let server: Server;
let baseUrl: string;
/** Every request body any simulated device sent, to prove no vault key ever left a device. */
const sentBodies: string[] = [];

beforeAll(async () => {
  h = await startHarness();
  server = createServer(h.app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await h?.close();
});

interface Sim {
  me: DeviceIdentity;
  api: ApiClient;
  userId: string;
  ring: Keyring;
  pub: { boxPublicKey: string; signPublicKey: string };
}

async function device(sub: string, ring: Keyring = createKeyring()): Promise<Sim> {
  const keys = generateDeviceKeys();
  const me = { deviceId: randomUUID(), keys };
  const pub = { boxPublicKey: toB64(keys.box.publicKey), signPublicKey: toB64(keys.sign.publicKey) };
  let token: string | null = null;
  const recordingFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string') sentBodies.push(init.body);
    return fetch(input, init);
  };
  const api = createApiClient({ baseUrl, getAccessToken: async () => token, fetch: recordingFetch });
  const auth = await api.signInWithGoogle({
    idToken: `google:${sub}:${sub}@example.com`,
    device: { id: me.deviceId, name: `sim-${sub}`, platform: 'ubuntu', appVersion: '0.1.0', keys: pub },
  });
  token = auth.accessToken;
  return { me, api, userId: auth.user.id, ring, pub };
}

const readable = (ring: Keyring, item: EncryptedItem): string => {
  const dek = unwrapDek(ring, item.id, { keyEpoch: item.keyEpoch, dek: fromB64(item.dek) });
  return fromUtf8(openPart(dek, item.id, 'body', fromB64(item.body!)));
};

describe('end-to-end key management across simulated devices', () => {
  let a: Sim;
  let b: Sim;
  let c: Sim;
  let f: Sim;
  let g: Sim;
  let recoveryKey: string;
  let early: EncryptedItem;

  it('first device creates the vault; its local keyring becomes the account vault', async () => {
    a = await device('olivia');
    early = encryptedItem(a.ring, 'written before sync');
    ({ ring: a.ring, recoveryKey } = await createAccountVault(a.api, a.me, a.ring));
    expect(recoveryKey).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/);
    expect(await a.api.vaultState()).toMatchObject({ initialized: true, epoch: 1, version: 1 });
    await expect(createAccountVault(a.api, a.me, a.ring)).rejects.toMatchObject({ status: 409 });
    await a.api.push({ ops: [{ type: 'upsert', opId: randomUUID(), baseRev: 0, item: early }] });
  });

  it('enrolls a second device only after both sides show the same code', async () => {
    b = await device('olivia');
    await expect(b.api.pull(0)).rejects.toMatchObject({ kind: 'forbidden' });
    await a.api.claimDevice(b.me.deviceId);
    const { approver } = await b.api.enrollment();
    expect(approver?.id).toBe(a.me.deviceId);
    // Both screens compute the code from the keys they hold; equal codes mean no key was swapped.
    expect(enrollmentCodeFor(b.pub, approver!.keys)).toBe(enrollmentCodeFor(b.pub, a.pub));
    a.ring = await approveDevice(a.api, a.me, a.ring, { id: b.me.deviceId, keys: b.pub });
    b.ring = await acceptEnrollment(b.api, b.me, { id: a.me.deviceId, keys: a.pub });

    const pulled = await b.api.pull(0);
    const item = pulled.changes.find((ch) => !ch.deleted && ch.item.id === early.id);
    expect(item && !item.deleted && readable(b.ring, item.item)).toBe('written before sync');
    expect((await a.api.vaultState()).version).toBe(2);
  });

  it('detects a server that substitutes keys during enrollment', async () => {
    const victim = await device('olivia');
    await a.api.claimDevice(victim.me.deviceId);
    const mallory = generateDeviceKeys();
    const fakeApprover = { boxPublicKey: toB64(mallory.box.publicKey), signPublicKey: toB64(mallory.sign.publicKey) };
    expect(enrollmentCodeFor(victim.pub, fakeApprover)).not.toBe(enrollmentCodeFor(victim.pub, a.pub));
    await approveDevice(a.api, a.me, a.ring, { id: victim.me.deviceId, keys: victim.pub });
    // The envelope is genuine, but the victim confirmed a different key: rejected.
    await expect(acceptEnrollment(victim.api, victim.me, { id: a.me.deviceId, keys: fakeApprover })).rejects.toThrow();
    // A forged envelope pushed straight into the DB (a malicious server) is rejected on refresh.
    const forged = sealKeyringFor(createKeyring(), b.me.deviceId, b.me.keys.box.publicKey, mallory.sign.privateKey);
    await h.store.c.envelopes.updateOne({ _id: b.me.deviceId }, { $set: { sealed: toB64(forged.sealed), signature: toB64(forged.signature), signerDeviceId: a.me.deviceId } });
    // Replaying history cannot launder it either: a forged step slipped into the history is skipped.
    await h.store.c.envelopeHistory.insertOne({
      _id: `${b.me.deviceId}:999`, userId: b.userId, version: 999, createdAt: new Date(), deviceId: b.me.deviceId, epoch: 1,
      sealed: toB64(forged.sealed), signature: toB64(forged.signature), signerDeviceId: a.me.deviceId,
    });
    await expect(refreshKeyring(b.api, b.me, b.ring)).rejects.toThrow(VaultProtocolError);
    await h.store.c.envelopeHistory.deleteOne({ _id: `${b.me.deviceId}:999` });
    // Revoking the victim device rotates and republishes, which also restores B's genuine envelope.
    a.ring = (await revokeAndRotate(a.api, a.me, a.ring, victim.me.deviceId)).ring;
    const rb = await refreshKeyring(b.api, b.me, b.ring);
    expect(rb.status).toBe('updated');
    b.ring = rb.ring;
    expect(b.ring.current).toBe(2);
    expect(rosterEntry(b.ring, victim.me.deviceId)).toBeUndefined();
  });

  it('recovers a vault on a brand-new device with the recovery key', async () => {
    c = await device('olivia');
    await expect(recoverVault(c.api, c.me, c.userId, recoveryKey.replace(/^./, (x) => (x === 'A' ? 'B' : 'A')), h.clock.now)).rejects.toThrow();
    c.ring = await recoverVault(c.api, c.me, c.userId, recoveryKey.toLowerCase(), h.clock.now);
    expect(c.ring.current).toBe(2);
    expect(readable(c.ring, early)).toBe('written before sync');
    // Existing devices trust C's republished roster because it is signed with the recovery key.
    const ra = await refreshKeyring(a.api, a.me, a.ring);
    expect(ra.status).toBe('updated');
    a.ring = ra.ring;
    expect(rosterEntry(a.ring, c.me.deviceId)).toBeDefined();
  });

  it('revocation rotates the key: the revoked device is cut off and cannot read new items', async () => {
    const bOldRing = b.ring;
    a.ring = (await revokeAndRotate(a.api, a.me, a.ring, b.me.deviceId)).ring;
    expect(a.ring.current).toBe(3);
    await expect(b.api.pull(0)).rejects.toMatchObject({ kind: 'forbidden' });

    const fresh = encryptedItem(a.ring, 'after revocation');
    expect(fresh.keyEpoch).toBe(3);
    await a.api.push({ ops: [{ type: 'upsert', opId: randomUUID(), baseRev: 0, item: fresh }] });
    expect(() => readable(bOldRing, fresh)).toThrow(/unknown key epoch/);

    c.ring = (await refreshKeyring(c.api, c.me, c.ring)).ring;
    expect(readable(c.ring, fresh)).toBe('after revocation');
    const stale = await c.api.push({ ops: [{ type: 'upsert', opId: randomUUID(), baseRev: 0, item: encryptedItem(bOldRing) }] });
    expect(stale.results[0]).toMatchObject({ status: 'stale_epoch', currentEpoch: 3 });

    // The recovery copy was refreshed by A without knowing the recovery key.
    const d = await device('olivia');
    const recovered = await recoverVault(d.api, d.me, d.userId, recoveryKey, h.clock.now);
    expect(recovered.current).toBe(3);
    expect(readable(recovered, fresh)).toBe('after revocation');
  });

  it('never sends vault keys, device private keys or plaintext to the server', () => {
    const secrets = [
      ...[...a.ring.keys.values()].map(toB64),
      toB64(a.me.keys.box.privateKey), toB64(a.me.keys.sign.privateKey), toB64(c.me.keys.sign.privateKey),
      recoveryKey, 'written before sync', 'after revocation',
    ];
    const wire = sentBodies.join('\n') + JSON.stringify(h.logs);
    for (const s of secrets) expect(wire).not.toContain(s);
    expect(sentBodies.length).toBeGreaterThan(10);
  });

  it('rejects stale or forged recovery proofs and lockout-causing rotations', async () => {
    const e = await device('olivia');
    await expect(recoverVault(e.api, e.me, e.userId, recoveryKey, h.clock.now - 10 * 60_000)).rejects.toMatchObject({ status: 400 });
    await expect(e.api.recover({ timestamp: h.clock.now, signature: toB64(new Uint8Array(64)) })).rejects.toMatchObject({ status: 403 });
    // A rotation that leaves out an authorized device (C) is refused by the server.
    const partial = { ...a.ring, roster: a.ring.roster!.filter((r) => r.id === a.me.deviceId) };
    await expect(revokeAndRotate(a.api, a.me, partial, e.me.deviceId)).rejects.toMatchObject({ status: 409 });
  });

  it('keeps the recovery copy current on approval, so a later recovery keeps approved devices', async () => {
    a.ring = (await refreshKeyring(a.api, a.me, a.ring)).ring;
    f = await device('olivia');
    await a.api.claimDevice(f.me.deviceId);
    a.ring = await approveDevice(a.api, a.me, a.ring, { id: f.me.deviceId, keys: f.pub });
    g = await device('olivia');
    g.ring = await recoverVault(g.api, g.me, g.userId, recoveryKey, h.clock.now);
    expect(rosterEntry(g.ring, f.me.deviceId)).toBeDefined();
    expect(g.ring.recovery?.knownBy).toContain(g.me.deviceId);
  });

  it('replaces the recovery key when revoking a device that held it, and on request', async () => {
    a.ring = (await refreshKeyring(a.api, a.me, a.ring)).ring;
    // F was approved by code and never saw the recovery key: no new key.
    const rf = await revokeAndRotate(a.api, a.me, a.ring, f.me.deviceId);
    expect(rf.recoveryKey).toBeUndefined();
    // G typed the recovery key: revoking it replaces the key, and the old one stops working.
    const rg = await revokeAndRotate(a.api, a.me, rf.ring, g.me.deviceId);
    expect(rg.recoveryKey).toBeDefined();
    expect(rg.recoveryKey).not.toBe(recoveryKey);
    a.ring = rg.ring;
    const x = await device('olivia');
    await expect(recoverVault(x.api, x.me, x.userId, recoveryKey, h.clock.now)).rejects.toMatchObject({ status: 403 });
    const xr = await recoverVault(x.api, x.me, x.userId, rg.recoveryKey!, h.clock.now);
    expect(xr.current).toBe(a.ring.current);

    a.ring = (await refreshKeyring(a.api, a.me, a.ring)).ring;
    const replaced = await replaceRecoveryKey(a.api, a.me, a.ring);
    expect(replaced.ring.current).toBe(a.ring.current + 1);
    a.ring = replaced.ring;
    const y = await device('olivia');
    await expect(recoverVault(y.api, y.me, y.userId, rg.recoveryKey!, h.clock.now)).rejects.toMatchObject({ status: 403 });
    expect((await recoverVault(y.api, y.me, y.userId, replaced.recoveryKey, h.clock.now)).current).toBe(a.ring.current);
    // The server refuses a recovery-key swap without a rotation.
    let rotation: Parameters<ApiClient['publishEnvelopes']>[0] | undefined;
    await replaceRecoveryKey({ ...a.api, publishEnvelopes: async (req) => void (rotation = req) }, a.me, a.ring);
    const own = sealKeyringFor(a.ring, a.me.deviceId, a.me.keys.box.publicKey, a.me.keys.sign.privateKey);
    await expect(a.api.publishEnvelopes({
      epoch: a.ring.current,
      envelopes: [{ deviceId: a.me.deviceId, epoch: own.epoch, sealed: toB64(own.sealed), signerDeviceId: a.me.deviceId, signature: toB64(own.signature) }],
      recovery: { ...rotation!.recovery!, epoch: a.ring.current },
    })).rejects.toThrow(/recovery_key_changed/);
  });
});
