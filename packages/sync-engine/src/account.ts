import { createApiClient, ApiError, type ApiClient } from '@clipply/api-client';
import { toB64, type Keyring } from '@clipply/crypto';
import { kvRepo, outboxRepo, type SqlDb } from '@clipply/database';
import type { Logger } from '@clipply/logger';
import type { DevicePlatform } from '@clipply/shared-schemas';

import type { ClipLibrary } from './library';
import { SyncEngine, type BlobDownloader, type BlobUploader } from './sync';
import {
  acceptEnrollment, approveDevice, createAccountVault, enrollmentCodeFor, recoverVault, refreshKeyring, replaceRecoveryKey, revokeAndRotate,
  type DeviceIdentity, type DevicePublicKeys,
} from './vault';

export interface StoredSession {
  userId: string;
  email: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
}

export type VaultStatus = 'none' | 'ready' | 'needs_enrollment' | 'removed';
export type SyncState = 'off' | 'paused' | 'idle' | 'syncing' | 'offline' | 'error';

export interface AccountStatus {
  configured: boolean;
  signedIn: boolean;
  email?: string;
  deviceStatus?: 'authorized' | 'pending' | 'revoked';
  vault: VaultStatus;
  sync: { state: SyncState; lastSyncAt?: number; error?: string; pending: number };
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: DevicePlatform;
  status: 'authorized' | 'pending' | 'revoked';
  lastSeenAt: number;
  lastSyncAt?: number;
  isThisDevice: boolean;
}

export interface AccountDeps {
  /** Undefined when this build has no server configured: account features stay off. */
  baseUrl: string | undefined;
  fetch?: typeof fetch;
  db: SqlDb;
  library: ClipLibrary;
  identity: DeviceIdentity;
  device: { name: string; platform: DevicePlatform; appVersion: string };
  getKeyring: () => Keyring;
  /** Persists the keyring in OS-protected storage. */
  setKeyring: (ring: Keyring) => Promise<void>;
  loadSession: () => Promise<StoredSession | null>;
  /** null signs out. Stored in OS-protected storage. */
  saveSession: (s: StoredSession | null) => Promise<void>;
  /** Platform Google sign-in (desktop: browser + loopback + PKCE; Android: Credential Manager). */
  googleIdToken: () => Promise<string>;
  uploadBlob: BlobUploader;
  downloadBlob: BlobDownloader;
  log: Logger;
  now?: () => number;
}

const VAULT_VERSION = 'vault.version';
const SYNC_PAUSED = 'sync.paused';
const ACCESS_SKEW_MS = 60_000;

/**
 * Account, vault and sync orchestration shared by desktop and Android. Platform code supplies only
 * Google sign-in, secure storage and blob transport (AccountDeps).
 */
export class AccountController {
  readonly api: ApiClient;
  readonly engine: SyncEngine;
  private session: StoredSession | null = null;
  private shownApprover: { id: string; name: string; keys: DevicePublicKeys; code: string } | null = null;
  private status: AccountStatus;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private readonly now: () => number;

  constructor(private readonly d: AccountDeps) {
    this.now = d.now ?? Date.now;
    this.status = { configured: !!d.baseUrl, signedIn: false, vault: 'none', sync: { state: 'off', pending: 0 } };
    this.api = createApiClient({
      baseUrl: d.baseUrl ?? 'http://invalid.localhost',
      ...(d.fetch ? { fetch: d.fetch } : {}),
      getAccessToken: async () => this.accessToken(),
      refreshSession: async () => this.refreshSession(),
    });
    this.engine = new SyncEngine({
      db: d.db, api: this.api, library: d.library, uploadBlob: d.uploadBlob, downloadBlob: d.downloadBlob, log: d.log.child('sync'),
      onKeyringStale: async () => {
        await this.refreshVault(true);
      },
      ...(d.now ? { now: d.now } : {}),
    });
  }

  getStatus(): AccountStatus {
    return this.status;
  }

  onStatus(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async init(): Promise<void> {
    if (!this.d.baseUrl) return;
    this.paused = (await kvRepo(this.d.db).get<boolean>(SYNC_PAUSED)) ?? false;
    this.session = await this.d.loadSession();
    if (!this.session) return;
    this.update({ signedIn: true, email: this.session.email });
    try {
      await this.refreshState();
    } catch (error) {
      this.syncFailed(error);
    }
  }

  isSyncPaused(): boolean {
    return this.paused;
  }

  /** Per-device switch: while paused nothing is sent or fetched; local changes queue up and go on resume. */
  async setSyncPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    await kvRepo(this.d.db).set(SYNC_PAUSED, paused);
    if (paused) {
      if (this.debounce) clearTimeout(this.debounce);
      if (this.status.vault === 'ready') this.update({ sync: { ...this.status.sync, state: 'paused' } });
    } else {
      if (this.status.sync.state === 'paused') this.update({ sync: { ...this.status.sync, state: 'idle' } });
      await this.sync();
    }
  }

  /** Returns the recovery key when this sign-in created the account vault (show it exactly once). */
  async signIn(): Promise<{ recoveryKey?: string }> {
    if (!this.d.baseUrl) throw new Error('sync is not configured in this build');
    const idToken = await this.d.googleIdToken();
    const { identity: me, device } = this.d;
    const auth = await this.api.signInWithGoogle({
      idToken,
      device: {
        id: me.deviceId, name: device.name, platform: device.platform, appVersion: device.appVersion,
        keys: { boxPublicKey: toB64(me.keys.box.publicKey), signPublicKey: toB64(me.keys.sign.publicKey) },
      },
    });
    this.session = { userId: auth.user.id, email: auth.user.email, refreshToken: auth.refreshToken, accessToken: auth.accessToken, accessExpiresAt: auth.accessExpiresAt };
    await this.d.saveSession(this.session);
    this.update({ signedIn: true, email: auth.user.email, deviceStatus: auth.device.status });
    return this.refreshState();
  }

  /** Keeps local history; stops syncing and forgets the session. */
  async signOut(): Promise<void> {
    this.stopScheduler();
    if (this.session) await this.api.logout({ refreshToken: this.session.refreshToken }).catch(() => undefined);
    this.session = null;
    await this.d.saveSession(null);
    this.status = { configured: this.status.configured, signedIn: false, vault: 'none', sync: { state: 'off', pending: 0 } };
    this.emit();
  }

  /** Works out where this device stands and creates the account vault if it is the first device. */
  private async refreshState(): Promise<{ recoveryKey?: string }> {
    const me = (await this.api.listDevices()).devices.find((x) => x.id === this.d.identity.deviceId);
    const deviceStatus = me?.status ?? 'revoked';
    this.update({ deviceStatus });
    if (deviceStatus === 'revoked') {
      this.update({ vault: 'removed', sync: { ...this.status.sync, state: 'off' } });
      return {};
    }
    if (deviceStatus === 'pending') {
      this.update({ vault: 'needs_enrollment', sync: { ...this.status.sync, state: 'off' } });
      return {};
    }
    const state = await this.api.vaultState();
    if (!state.initialized) {
      const { ring, recoveryKey } = await createAccountVault(this.api, this.d.identity, this.d.getKeyring());
      await this.d.setKeyring(ring);
      await kvRepo(this.d.db).set(VAULT_VERSION, 1);
      this.update({ vault: 'ready' });
      this.syncOrShowPaused();
      return { recoveryKey };
    }
    await this.refreshVault(true);
    if (this.status.vault === 'ready') this.syncOrShowPaused();
    return {};
  }

  /** Picks up a new envelope (roster change or rotation) when the vault version moved. */
  private async refreshVault(force = false): Promise<void> {
    const state = await this.api.vaultState();
    const known = (await kvRepo(this.d.db).get<number>(VAULT_VERSION)) ?? 0;
    if (!force && state.version === known) return;
    const res = await refreshKeyring(this.api, this.d.identity, this.d.getKeyring());
    if (res.status === 'removed') {
      this.update({ vault: 'removed' });
      throw new Error('this device was removed from the vault');
    }
    if (res.status === 'updated') await this.d.setKeyring(res.ring);
    await kvRepo(this.d.db).set(VAULT_VERSION, state.version);
    this.update({ vault: 'ready' });
  }

  // ── enrollment: new-device side ────────────────────────────────────────────────────────

  /** Pending device: who claimed us and the code to compare, or null while nobody has. */
  async enrollment(): Promise<{ approverName: string; code: string } | null> {
    const { approver } = await this.api.enrollment();
    if (!approver) return this.shownApprover ? { approverName: this.shownApprover.name, code: this.shownApprover.code } : null;
    const code = enrollmentCodeFor(this.publicKeys(), approver.keys);
    this.shownApprover = { ...approver, code };
    return { approverName: approver.name, code };
  }

  /**
   * After the user confirmed the codes match on this device. Uses exactly the approver whose code
   * was shown (the server clears the claim once approval completes, and must not be asked again).
   */
  async acceptEnrollment(): Promise<void> {
    const approver = this.shownApprover;
    if (!approver) throw new Error('no device has started approving this one');
    await this.join(await acceptEnrollment(this.api, this.d.identity, approver));
    this.shownApprover = null;
  }

  async recover(recoveryKey: string): Promise<void> {
    if (!this.session) throw new Error('sign in first');
    await this.join(await recoverVault(this.api, this.d.identity, this.session.userId, recoveryKey, this.now()));
  }

  private async join(ring: Keyring): Promise<void> {
    const previous = this.d.getKeyring();
    await this.d.setKeyring(ring);
    await this.d.library.adoptKeyring(previous);
    await kvRepo(this.d.db).set(VAULT_VERSION, (await this.api.vaultState()).version);
    this.update({ deviceStatus: 'authorized', vault: 'ready' });
    this.syncOrShowPaused();
  }

  private syncOrShowPaused(): void {
    if (this.paused) this.update({ sync: { ...this.status.sync, state: 'paused' } });
    else void this.sync();
  }

  // ── devices: approver side ─────────────────────────────────────────────────────────────

  async devices(): Promise<DeviceInfo[]> {
    return (await this.api.listDevices()).devices.map((x) => ({
      id: x.id, name: x.name, platform: x.platform, status: x.status, lastSeenAt: x.lastSeenAt,
      ...(x.lastSyncAt !== undefined ? { lastSyncAt: x.lastSyncAt } : {}),
      isThisDevice: x.id === this.d.identity.deviceId,
    }));
  }

  /** Claims a pending device and returns the code to compare with the one it shows. */
  async startApproval(deviceId: string): Promise<{ code: string }> {
    const pending = (await this.api.listDevices()).devices.find((x) => x.id === deviceId && x.status === 'pending');
    if (!pending) throw new Error('device is not waiting for approval');
    await this.api.claimDevice(deviceId);
    return { code: enrollmentCodeFor(pending.keys, this.publicKeys()) };
  }

  /** After the user confirmed the codes match on this device. */
  async confirmApproval(deviceId: string): Promise<void> {
    const pending = (await this.api.listDevices()).devices.find((x) => x.id === deviceId && x.status === 'pending');
    if (!pending) throw new Error('device is not waiting for approval');
    await this.d.setKeyring(await approveDevice(this.api, this.d.identity, this.d.getKeyring(), { id: deviceId, keys: pending.keys }));
    await kvRepo(this.d.db).set(VAULT_VERSION, (await this.api.vaultState()).version);
    this.emit();
  }

  /** Returns a new recovery key when the removed device had held the old one (show it once). */
  async revoke(deviceId: string): Promise<{ recoveryKey?: string }> {
    const { ring, recoveryKey } = await revokeAndRotate(this.api, this.d.identity, this.d.getKeyring(), deviceId);
    await this.adoptRotation(ring);
    return recoveryKey ? { recoveryKey } : {};
  }

  /** Replaces the recovery key (lost or exposed); the old one stops working. Show the new one once. */
  async replaceRecoveryKey(): Promise<{ recoveryKey: string }> {
    const { ring, recoveryKey } = await replaceRecoveryKey(this.api, this.d.identity, this.d.getKeyring());
    await this.adoptRotation(ring);
    return { recoveryKey };
  }

  private async adoptRotation(ring: Keyring): Promise<void> {
    await this.d.setKeyring(ring);
    await kvRepo(this.d.db).set(VAULT_VERSION, (await this.api.vaultState()).version);
    this.emit();
  }

  async rename(deviceId: string, name: string): Promise<void> {
    await this.api.renameDevice(deviceId, name);
  }

  // ── sync scheduling ────────────────────────────────────────────────────────────────────

  /** One sync now (single-flight). Never throws; problems land in the status. */
  async sync(): Promise<void> {
    if (!this.canSync()) return;
    this.update({ sync: { ...this.status.sync, state: 'syncing' } });
    try {
      await this.refreshVault();
      await this.engine.sync();
      this.update({ sync: { state: 'idle', lastSyncAt: this.now(), pending: await outboxRepo(this.d.db).pendingCount() } });
    } catch (error) {
      this.syncFailed(error);
    }
  }

  /**
   * A cheap probe (vault version + sync head, no item transfer when nothing changed) every
   * `intervalMs`, plus a debounced sync after local changes. Desktop runs it always; Android only
   * while the app is on screen.
   */
  startScheduler(intervalMs = 60_000): void {
    this.stopScheduler();
    this.timer = setInterval(() => void this.probe(), intervalMs);
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  /** Call after any local change (capture, edit, delete); pushes ~2 s later. */
  notifyLocalChange(): void {
    if (!this.canSync()) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.sync(), 2_000);
  }

  private async probe(): Promise<void> {
    if (!this.canSync()) return;
    try {
      const state = await this.api.vaultState();
      const known = (await kvRepo(this.d.db).get<number>(VAULT_VERSION)) ?? 0;
      if (state.version !== known) return void (await this.sync());
      if (await this.engine.syncIfNeeded()) {
        this.update({ sync: { state: 'idle', lastSyncAt: this.now(), pending: await outboxRepo(this.d.db).pendingCount() } });
      }
    } catch (error) {
      this.syncFailed(error);
    }
  }

  private canSync(): boolean {
    return !this.paused && !!this.session && this.status.vault === 'ready' && this.status.deviceStatus === 'authorized';
  }

  private syncFailed(error: unknown): void {
    if (error instanceof ApiError && error.status === 403) {
      this.update({ deviceStatus: 'revoked', vault: 'removed', sync: { ...this.status.sync, state: 'off', error: 'This device was removed from your account.' } });
      return;
    }
    const offline = error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout');
    this.d.log.warn('sync failed', { error });
    void outboxRepo(this.d.db).pendingCount().then((pending) =>
      this.update({ sync: { ...this.status.sync, pending, state: offline ? 'offline' : 'error', error: error instanceof Error ? error.message : 'sync failed' } }),
    );
  }

  // ── session ────────────────────────────────────────────────────────────────────────────

  private async accessToken(): Promise<string | null> {
    if (!this.session) return null;
    if (this.session.accessExpiresAt - ACCESS_SKEW_MS < this.now()) await this.refreshSession();
    return this.session?.accessToken ?? null;
  }

  private refreshing: Promise<boolean> | null = null;

  private refreshSession(): Promise<boolean> {
    this.refreshing ??= (async () => {
      if (!this.session) return false;
      // Another process (Android's upload worker) may have rotated the token: adopt it instead of
      // replaying ours, which the server would treat as theft and revoke the session.
      const stored = await this.d.loadSession();
      if (stored && stored.refreshToken !== this.session.refreshToken) {
        this.session = stored;
        if (stored.accessExpiresAt - ACCESS_SKEW_MS > this.now()) return true;
      }
      try {
        const auth = await this.api.refresh({ refreshToken: this.session.refreshToken });
        this.session = { ...this.session, refreshToken: auth.refreshToken, accessToken: auth.accessToken, accessExpiresAt: auth.accessExpiresAt };
        await this.d.saveSession(this.session);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          // device_revoked: another device removed this one. Local history stays; sync stops.
          this.update({ deviceStatus: 'revoked', vault: 'removed', sync: { ...this.status.sync, state: 'off', error: 'This device was removed from your account.' } });
        } else if (error instanceof ApiError && error.status === 401) {
          // The refresh token is dead (expired or replayed): the user must sign in again.
          this.session = null;
          await this.d.saveSession(null);
          this.update({ signedIn: false, vault: 'none', sync: { state: 'off', pending: this.status.sync.pending, error: 'Signed out. Please sign in again.' } });
        }
        return false;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private publicKeys(): DevicePublicKeys {
    return { boxPublicKey: toB64(this.d.identity.keys.box.publicKey), signPublicKey: toB64(this.d.identity.keys.sign.publicKey) };
  }

  private update(patch: Partial<AccountStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
