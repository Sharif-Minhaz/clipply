import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKeyring, fromUtf8, generateDeviceKeys, toB64, type Keyring } from '@clipply/crypto';

const fakeKeysFor = () => {
  const k = generateDeviceKeys();
  return { boxPublicKey: toB64(k.box.publicKey), signPublicKey: toB64(k.sign.publicKey) };
};
import { migrate } from '@clipply/database';
import { openTestDb } from '@clipply/database/testing';
import { createLogger } from '@clipply/logger';
import { AccountController, ClipLibrary, type StoredSession } from '@clipply/sync-engine';

import { signParams } from '../src/modules/storage/cloudinary';
import { startHarness, type Harness } from './helpers';

let h: Harness;
let server: Server;
let baseUrl: string;
const cloud = new Map<string, Uint8Array>();

beforeAll(async () => {
  h = await startHarness();
  server = createServer(h.app).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await h?.close();
});

async function app(sub: string, name: string) {
  let google = sub;
  const db = openTestDb();
  await migrate(db);
  let ring: Keyring = createKeyring();
  let session: StoredSession | null = null;
  let identity = { deviceId: randomUUID(), keys: generateDeviceKeys() };
  const library: ClipLibrary = new ClipLibrary({ db, keyring: () => ring, deviceId: identity.deviceId, now: () => h.clock.now, fetchBlob: (id) => account.engine.fetchBlob(id) });
  const account: AccountController = new AccountController({
    baseUrl, db, library, identity, now: () => h.clock.now,
    newIdentity: async () => (identity = { deviceId: randomUUID(), keys: generateDeviceKeys() }),
    device: { name, platform: 'ubuntu', appVersion: '0.1.0' },
    getKeyring: () => ring,
    setKeyring: async (r) => void (ring = r),
    loadSession: async () => session,
    saveSession: async (s) => void (session = s),
    googleIdToken: async () => `google:${google}:${google}@example.com`,
    uploadBlob: async (_u, f, ct) => {
      cloud.set(f.public_id!, ct);
      return { public_id: f.public_id!, version: 1, bytes: ct.length, signature: signParams({ public_id: f.public_id!, version: 1 }, 'cloud-secret') };
    },
    downloadBlob: async (url) => cloud.get(new URL(url).searchParams.get('public_id')!)!,
    log: createLogger('acct', { sink: () => {} }),
  });
  return { account, library, ring: () => ring, session: () => session, useGoogle: (s: string) => void (google = s) };
}

describe('AccountController (shared by desktop and Android)', () => {
  it('runs the whole user journey: sign in, vault, approve a second device, sync, revoke', async () => {
    const laptop = await app('rosa', 'Laptop');
    await laptop.library.capture({ type: 'text', text: 'note from laptop' });
    const first = await laptop.account.signIn();
    expect(first.recoveryKey).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/);
    expect(laptop.account.getStatus()).toMatchObject({ signedIn: true, deviceStatus: 'authorized', vault: 'ready' });
    expect(laptop.ring().roster).toHaveLength(1);

    const phone = await app('rosa', 'Phone');
    await phone.library.capture({ type: 'text', text: 'note from phone' });
    expect(await phone.account.signIn()).toEqual({});
    expect(phone.account.getStatus()).toMatchObject({ deviceStatus: 'pending', vault: 'needs_enrollment' });
    expect(await phone.account.enrollment()).toBeNull();

    const pending = (await laptop.account.devices()).find((d) => d.status === 'pending')!;
    expect(pending.name).toBe('Phone');
    const { code } = await laptop.account.startApproval(pending.id);
    const onPhone = await phone.account.enrollment();
    expect(onPhone).toEqual({ approverName: 'Laptop', code });
    await expect(phone.account.acceptEnrollment()).rejects.toThrow();
    await laptop.account.confirmApproval(pending.id);
    await phone.account.acceptEnrollment();
    expect(phone.account.getStatus()).toMatchObject({ deviceStatus: 'authorized', vault: 'ready' });

    await phone.account.sync();
    await laptop.account.sync();
    await phone.account.sync();
    const bodies = async (x: Awaited<ReturnType<typeof app>>) =>
      (await Promise.all(x.library.list().map((v) => x.library.readBody(v.id)))).map(fromUtf8).sort();
    expect(await bodies(laptop)).toEqual(['note from laptop', 'note from phone']);
    expect(await bodies(phone)).toEqual(await bodies(laptop));
    expect(laptop.account.getStatus().sync).toMatchObject({ state: 'idle', pending: 0 });

    // Labels for clips from the other device: never this one's own name, and remembered (read from the database).
    const laptopId = (await laptop.account.devices()).find((d) => d.isThisDevice)!.id;
    expect(await phone.account.deviceNames()).toEqual({ [laptopId]: 'Laptop' });
    expect(await laptop.account.deviceNames()).toEqual({ [pending.id]: 'Phone' });
    await laptop.account.rename(pending.id, 'Pixel');
    expect(await laptop.account.deviceNames()).toEqual({ [pending.id]: 'Pixel' });

    // Access tokens expire after 15 minutes; the controller refreshes transparently.
    h.clock.now += 20 * 60_000;
    await laptop.library.capture({ type: 'text', text: 'after token expiry' });
    await laptop.account.sync();
    expect(laptop.account.getStatus().sync.state).toBe('idle');

    await laptop.account.revoke(pending.id);
    expect(laptop.ring().current).toBe(2);
    await phone.account.sync();
    expect(phone.account.getStatus()).toMatchObject({ vault: 'removed', deviceStatus: 'revoked' });
    h.clock.now -= 20 * 60_000;
  });

  it('finishes setup when the app closed after approval but before "Codes match"', async () => {
    const laptop = await app('uma', 'Laptop');
    await laptop.account.signIn();
    const phone = await app('uma', 'Phone');
    await phone.account.signIn();
    const pending = (await laptop.account.devices()).find((d) => d.status === 'pending')!;
    await laptop.account.startApproval(pending.id);
    await laptop.account.confirmApproval(pending.id);

    // Next launch: authorized on the server, but the keyring was never taken. No sync error.
    await phone.account.init();
    expect(phone.account.getStatus()).toMatchObject({ deviceStatus: 'authorized', vault: 'needs_enrollment' });
    expect(phone.account.getStatus().sync.error).toBeUndefined();
    const { code } = await laptop.account.approvalCode(pending.id);
    expect(await phone.account.enrollment()).toEqual({ approverName: 'Laptop', code, approved: true });
    await phone.account.acceptEnrollment();
    expect(phone.account.getStatus()).toMatchObject({ vault: 'ready' });
    await phone.library.capture({ type: 'text', text: 'after late setup' });
    await phone.account.sync();
    expect(phone.account.getStatus().sync).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('tells a connected device that another one is waiting, and clears it once approved or removed', async () => {
    const desk = await app('lin', 'Desk');
    await desk.account.signIn();
    expect(desk.account.getStatus().joinRequests ?? []).toEqual([]);

    const phone = await app('lin', 'Phone');
    await phone.account.signIn();
    expect(phone.account.getStatus().joinRequests ?? []).toEqual([]); // a waiting device cannot approve
    await desk.account.sync(); // what the minute probe, window focus or app resume runs
    const [request] = desk.account.getStatus().joinRequests!;
    expect(request).toMatchObject({ name: 'Phone' });

    await desk.account.startApproval(request!.id);
    await phone.account.enrollment();
    await desk.account.confirmApproval(request!.id);
    expect(desk.account.getStatus().joinRequests).toEqual([]);

    const tablet = await app('lin', 'Tablet');
    await tablet.account.signIn();
    await desk.account.sync();
    const tabletId = desk.account.getStatus().joinRequests![0]!.id;
    await desk.account.revoke(tabletId);
    expect(desk.account.getStatus().joinRequests).toEqual([]);
  });

  describe('QR pairing', () => {
    // Each test signs in several devices; keep the auth rate limit (30 a minute) out of the way.
    beforeEach(() => void (h.clock.now += 61_000));
    afterAll(() => void (h.clock.now += 61_000));

    const fakeKeys = () => {
      const k = generateDeviceKeys();
      return { boxPublicKey: toB64(k.box.publicKey), signPublicKey: toB64(k.sign.publicKey) };
    };

    it('a connected phone scans the new desktop: no codes to compare', async () => {
      const phone = await app('qa', 'Phone');
      await phone.library.capture({ type: 'text', text: 'from the phone' });
      await phone.account.signIn();
      const desk = await app('qa', 'Desk');
      await desk.account.signIn();
      const qr = await desk.account.pairingQr();

      expect(await phone.account.pairWithQr(qr)).toEqual({ name: 'Desk' });
      // The desktop's next poll verifies the phone's proof and joins on its own.
      expect(await desk.account.enrollment()).toMatchObject({ approverName: 'Phone', paired: true });
      expect(desk.account.getStatus()).toMatchObject({ deviceStatus: 'authorized', vault: 'ready' });
      await desk.account.sync();
      expect(desk.library.list().map((v) => v.preview)).toContain('from the phone');
      expect(phone.ring().roster).toHaveLength(2);
    });

    it('a new phone scans the connected desktop, which approves it while showing its code', async () => {
      const desk = await app('qb', 'Desk');
      await desk.account.signIn();
      const qr = await desk.account.pairingQr();
      const phone = await app('qb', 'Phone');
      await phone.account.signIn();

      expect(await desk.account.checkPairing()).toBeNull(); // nobody scanned yet
      expect(await phone.account.pairWithQr(qr)).toEqual({ name: 'Desk' });
      expect(await phone.account.enrollment()).toMatchObject({ approverName: 'Desk', paired: true }); // waiting for Desk
      expect(phone.account.getStatus().vault).toBe('needs_enrollment');
      expect(await desk.account.checkPairing()).toEqual({ name: 'Phone' });
      await phone.account.enrollment();
      expect(phone.account.getStatus()).toMatchObject({ deviceStatus: 'authorized', vault: 'ready' });
      expect(await desk.account.checkPairing()).toBeNull(); // the code is used up
    });

    it('refuses keys the server substituted for the device in the QR', async () => {
      const phone = await app('qc', 'Phone');
      await phone.account.signIn();
      const desk = await app('qc', 'Desk');
      await desk.account.signIn();
      const qr = await desk.account.pairingQr();
      const deskId = qr.split(':')[2]!;
      await h.store.c.devices.updateOne({ _id: deskId }, { $set: { keys: fakeKeys() } });
      await expect(phone.account.pairWithQr(qr)).rejects.toThrow(/do not match the code/);
      expect((await phone.account.devices()).find((d) => d.id === deskId)?.status).toBe('pending');
    });

    it('ignores a proof that was not made with the QR secret', async () => {
      const desk = await app('qd', 'Desk');
      await desk.account.signIn();
      await desk.account.pairingQr();
      const phone = await app('qd', 'Phone');
      await phone.account.signIn();
      const deskId = (await phone.account.devices()).find((d) => d.name === 'Desk')!.id;
      // A malicious server (or someone who never saw the screen) names Desk as approver with a made-up proof.
      await phone.account.api.pairDevice({ approverId: deskId, proof: toB64(new Uint8Array(32).fill(7)) });
      expect(await desk.account.checkPairing()).toBeNull();
      expect((await desk.account.devices()).find((d) => d.name === 'Phone')?.status).toBe('pending');
    });

    it('rejects a code from a device in another account', async () => {
      const mine = await app('qe', 'Mine');
      await mine.account.signIn();
      const theirs = await app('qf', 'Theirs');
      await theirs.account.signIn();
      const stranger = await app('qf', 'Stranger');
      await stranger.account.signIn();
      await expect(mine.account.pairWithQr(await stranger.account.pairingQr())).rejects.toThrow(/not from a device waiting/);
      await expect(mine.account.pairWithQr('hello')).rejects.toThrow(/not a Clipply pairing code/);
    });
  });

  it('approves the exact keys the codes were compared for, even if the server swaps them afterwards', async () => {
    const desk = await app('qg', 'Desk');
    await desk.account.signIn();
    const phone = await app('qg', 'Phone');
    await phone.account.signIn();
    const p = (await desk.account.devices()).find((d) => d.status === 'pending')!;
    await desk.account.startApproval(p.id);
    await phone.account.enrollment();
    await h.store.c.devices.updateOne({ _id: p.id }, { $set: { keys: fakeKeysFor() } });
    await desk.account.confirmApproval(p.id);
    // Sealed to the phone's real keys, so the phone can open it.
    await phone.account.acceptEnrollment();
    expect(phone.account.getStatus()).toMatchObject({ vault: 'ready' });
  });

  const joinVia = async (approver: Awaited<ReturnType<typeof app>>, sub: string, name: string) => {
    const x = await app(sub, name);
    await x.account.signIn();
    const p = (await approver.account.devices()).find((d) => d.status === 'pending')!;
    await approver.account.startApproval(p.id);
    await x.account.enrollment();
    await approver.account.confirmApproval(p.id);
    await x.account.acceptEnrollment();
    return x;
  };

  it('catches up by itself when the roster moved on by more than one step while this device was away', async () => {
    const desk = await app('ines', 'Desk');
    await desk.account.signIn();
    const phone = await joinVia(desk, 'ines', 'Phone');
    const tablet = await joinVia(phone, 'ines', 'Tablet'); // signed by Phone: Desk still trusts it
    await joinVia(tablet, 'ines', 'Laptop'); // signed by Tablet: unknown to Desk until it replays the Tablet step

    await desk.account.init();
    expect(desk.account.getStatus()).toMatchObject({ deviceStatus: 'authorized', vault: 'ready' });
    await desk.account.sync();
    expect(desk.account.getStatus()).toMatchObject({ vault: 'ready', sync: { state: 'idle', pending: 0 } });
    expect(desk.ring().roster).toHaveLength(4);
  });

  it('keeps an old device connected after a reinstalled phone recovers and removes its old entry', async () => {
    const desk = await app('jo', 'Desk');
    const { recoveryKey } = await desk.account.signIn();
    const oldPhone = await joinVia(desk, 'jo', 'Phone');
    const oldPhoneId = (await desk.account.devices()).find((d) => d.name === 'Phone')!.id;
    void oldPhone;

    // Desk is closed. The reinstalled phone recovers (signed by the recovery key), then removes its
    // old entry (a rotation signed by the new phone, which Desk has never seen).
    const newPhone = await app('jo', 'Phone');
    await newPhone.account.signIn();
    await newPhone.account.recover(recoveryKey!);
    await newPhone.account.revoke(oldPhoneId);
    await newPhone.library.capture({ type: 'text', text: 'after reinstall' });
    await newPhone.account.sync();

    await desk.account.init();
    expect(desk.account.getStatus()).toMatchObject({ deviceStatus: 'authorized', vault: 'ready' });
    expect(desk.ring().current).toBe(2);
    expect(desk.ring().roster!.map((r) => r.id)).not.toContain(oldPhoneId);
    await desk.account.sync();
    expect(desk.library.list().map((v) => v.preview)).toContain('after reinstall');
  });

  it('re-joins with codes when the missed history is gone, and says why', async () => {
    const desk = await app('kai', 'Desk');
    await desk.account.signIn();
    const phone = await joinVia(desk, 'kai', 'Phone');
    const tablet = await joinVia(phone, 'kai', 'Tablet');
    await joinVia(tablet, 'kai', 'Laptop');
    const deskId = (await tablet.account.devices()).find((d) => d.name === 'Desk')!.id;
    await h.store.c.envelopeHistory.deleteMany({ deviceId: deskId });

    await desk.account.init();
    expect(desk.account.getStatus()).toMatchObject({ deviceStatus: 'authorized', vault: 'needs_enrollment' });
    const { code } = await tablet.account.approvalCode(deskId);
    expect(await desk.account.enrollment()).toEqual({ approverName: 'Tablet', code, approved: true, rejoin: true });
    await desk.account.acceptEnrollment();
    await desk.account.sync();
    expect(desk.account.getStatus()).toMatchObject({ vault: 'ready', sync: { state: 'idle', pending: 0 } });
    expect(desk.ring().roster).toHaveLength(4);
  });

  it('a removed device signs out and back in as a new device', async () => {
    const laptop = await app('vera', 'Laptop');
    await laptop.account.signIn();
    const phone = await app('vera', 'Phone');
    await phone.library.capture({ type: 'text', text: 'old phone note' });
    await phone.account.signIn();
    const first = (await laptop.account.devices()).find((d) => d.status === 'pending')!;
    await laptop.account.startApproval(first.id);
    await phone.account.enrollment();
    await laptop.account.confirmApproval(first.id);
    await phone.account.acceptEnrollment();
    await laptop.account.revoke(first.id);
    await phone.account.sync();
    expect(phone.account.getStatus().vault).toBe('removed');

    await phone.account.signOut();
    expect(phone.library.list()).toHaveLength(0);
    await phone.account.signIn();
    expect(phone.account.getStatus()).toMatchObject({ deviceStatus: 'pending', vault: 'needs_enrollment' });
    const devices = await laptop.account.devices();
    const second = devices.find((d) => d.status === 'pending')!;
    expect(second.id).not.toBe(first.id);
    expect(devices.find((d) => d.id === first.id)?.status).toBe('revoked');

    const { code } = await laptop.account.startApproval(second.id);
    expect(await phone.account.enrollment()).toEqual({ approverName: 'Laptop', code });
    await laptop.account.confirmApproval(second.id);
    await phone.account.acceptEnrollment();
    await phone.account.sync();
    expect(phone.account.getStatus()).toMatchObject({ vault: 'ready', sync: { state: 'idle', pending: 0 } });
  });

  it('sign-out wipes this device only; another account then starts clean', async () => {
    const pc = await app('sam', 'PC');
    const { recoveryKey } = await pc.account.signIn();
    await pc.library.capture({ type: 'text', text: 'sam secret' });
    await pc.account.sync();
    const saved = pc.session();
    const oldRing = pc.ring();

    await pc.account.signOut();
    expect(pc.account.getStatus()).toMatchObject({ signedIn: false, vault: 'none' });
    expect(pc.library.list()).toHaveLength(0);
    expect(pc.ring()).not.toBe(oldRing);
    // The old refresh token is revoked server-side.
    await expect(pc.account.api.refresh({ refreshToken: saved!.refreshToken })).rejects.toMatchObject({ status: 401 });

    // A different Google account on the same device: no device_id_taken, nothing of sam's carried over.
    pc.useGoogle('nora');
    await pc.account.signIn();
    await pc.account.sync();
    expect(pc.account.getStatus()).toMatchObject({ signedIn: true, email: 'nora@example.com', vault: 'ready', sync: { pending: 0 } });
    expect(pc.library.list()).toHaveLength(0);

    // Sam's synced clip is still in sam's account.
    const phone = await app('sam', 'Phone');
    await phone.account.signIn();
    await phone.account.recover(recoveryKey!);
    await phone.account.sync();
    const [only] = phone.library.list();
    expect(fromUtf8(await phone.library.readBody(only!.id))).toBe('sam secret');
  });

  it('pauses and resumes sync per device', async () => {
    const pc = await app('tess', 'PC');
    await pc.account.signIn();
    await pc.account.setSyncPaused(true);
    expect(pc.account.getStatus().sync.state).toBe('paused');
    await pc.library.capture({ type: 'text', text: 'while paused' });
    await pc.account.sync();
    expect((await pc.account.api.pull(0)).changes).toHaveLength(0);

    await pc.account.setSyncPaused(false);
    expect(pc.account.getStatus().sync).toMatchObject({ state: 'idle', pending: 0 });
    expect((await pc.account.api.pull(0)).changes).toHaveLength(1);
  });

  it('stays inert when the build has no server configured', async () => {
    const offline = new AccountController({
      baseUrl: undefined, db: openTestDb(), library: {} as ClipLibrary, identity: { deviceId: randomUUID(), keys: generateDeviceKeys() },
      device: { name: 'x', platform: 'ubuntu', appVersion: '0' }, getKeyring: createKeyring, setKeyring: async () => {},
      loadSession: async () => null, saveSession: async () => {}, googleIdToken: async () => '', uploadBlob: async () => { throw new Error(); },
      downloadBlob: async () => new Uint8Array(), log: createLogger('x', { sink: () => {} }),
    });
    await offline.init();
    expect(offline.getStatus()).toMatchObject({ configured: false, signedIn: false });
    await expect(offline.signIn()).rejects.toThrow(/not configured/);
  });
});
