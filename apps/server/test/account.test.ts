import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyring, fromUtf8, generateDeviceKeys, type Keyring } from '@clipply/crypto';
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
  const db = openTestDb();
  await migrate(db);
  let ring: Keyring = createKeyring();
  let session: StoredSession | null = null;
  const identity = { deviceId: randomUUID(), keys: generateDeviceKeys() };
  const library: ClipLibrary = new ClipLibrary({ db, keyring: () => ring, deviceId: identity.deviceId, now: () => h.clock.now, fetchBlob: (id) => account.engine.fetchBlob(id) });
  const account: AccountController = new AccountController({
    baseUrl, db, library, identity, now: () => h.clock.now,
    device: { name, platform: 'ubuntu', appVersion: '0.1.0' },
    getKeyring: () => ring,
    setKeyring: async (r) => void (ring = r),
    loadSession: async () => session,
    saveSession: async (s) => void (session = s),
    googleIdToken: async () => `google:${sub}:${sub}@example.com`,
    uploadBlob: async (_u, f, ct) => {
      cloud.set(f.public_id!, ct);
      return { public_id: f.public_id!, version: 1, bytes: ct.length, signature: signParams({ public_id: f.public_id!, version: 1 }, 'cloud-secret') };
    },
    downloadBlob: async (url) => cloud.get(new URL(url).searchParams.get('public_id')!)!,
    log: createLogger('acct', { sink: () => {} }),
  });
  return { account, library, ring: () => ring, session: () => session };
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

  it('signs out without losing local history and resumes on next start', async () => {
    const pc = await app('sam', 'PC');
    await pc.account.signIn();
    await pc.library.capture({ type: 'text', text: 'kept locally' });
    const saved = pc.session();
    expect(saved?.refreshToken).toBeDefined();

    await pc.account.signOut();
    expect(pc.account.getStatus()).toMatchObject({ signedIn: false, vault: 'none' });
    expect(pc.library.list()).toHaveLength(1);
    // The old refresh token is revoked server-side.
    await expect(pc.account.api.refresh({ refreshToken: saved!.refreshToken })).rejects.toMatchObject({ status: 401 });
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
