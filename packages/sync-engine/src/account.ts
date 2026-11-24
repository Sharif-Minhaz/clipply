import { createApiClient, ApiError, type ApiClient } from '@clipply/api-client';
import { createKeyring, rosterEntry, toB64, type Keyring } from '@clipply/crypto';
import { kvRepo, outboxRepo, type SqlDb } from '@clipply/database';
import type { Logger } from '@clipply/logger';
import type { DevicePlatform } from '@clipply/shared-schemas';

import type { ClipLibrary } from './library';
import { SYNC_CURSOR, SyncEngine, type BlobDownloader, type BlobUploader } from './sync';
import {
  acceptEnrollment, answerPairing, approveDevice, checkPairingProof, createAccountVault, createPairingOffer, enrollmentCodeFor, parsePairingQr,
  recoverVault, refreshKeyring, replaceRecoveryKey, revokeAndRotate, UntrustedEnvelopeError,
  type DeviceIdentity, type DevicePublicKeys, type PairingOffer, type RefreshResult,
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
  /** Devices waiting for this (connected) device to approve them; refreshed on every sync and probe. */
  joinRequests?: Array<{ id: string; name: string }>;
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
  /**
   * Persists and returns a fresh device id and key pairs, keeping the keyring and local history.
   * Used when this device was removed from the account: the server never lets a removed id back
   * in, so signing in again registers it as a new device that must be approved.
   */
  newIdentity?: () => Promise<DeviceIdentity>;
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
const DEVICE_NAMES = 'devices.names';
const NAMES_MAX_AGE_MS = 6 * 3_600_000;
const ACCESS_SKEW_MS = 60_000;
const PAIRING_TTL_MS = 10 * 60_000;

/**
 * Account, vault and sync orchestration shared by desktop and Android. Platform code supplies only
 * Google sign-in, secure storage and blob transport (AccountDeps).
 */
export class AccountController {
  readonly api: ApiClient;
  readonly engine: SyncEngine;
  private session: StoredSession | null = null;
  /** `paired`: authenticated by a QR pairing proof instead of a code the user compares. */
  private shownApprover: { id: string; name: string; keys: DevicePublicKeys; code: string; paired?: boolean } | null = null;
  /** Keys of devices this one started approving, exactly as the shown code covered them. */
  private readonly approving = new Map<string, DevicePublicKeys>();
  /** Pairing QRs this device showed and that have not expired (their secrets never leave this process). */
  private pairings: Array<{ offer: PairingOffer; expiresAt: number }> = [];
  private status: AccountStatus;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private readonly now: () => number;
  private identity: DeviceIdentity;

  constructor(private readonly d: AccountDeps) {
    this.now = d.now ?? Date.now;
    this.identity = d.identity;
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
    const register = () => {
      const { device } = this.d;
      return this.api.signInWithGoogle({
        idToken,
        device: { id: this.identity.deviceId, name: device.name, platform: device.platform, appVersion: device.appVersion, keys: this.publicKeys() },
      });
    };
    let auth: Awaited<ReturnType<typeof register>>;
    try {
      auth = await register();
    } catch (error) {
      const removed = error instanceof ApiError && error.status === 403 && error.message.endsWith('device_revoked');
      if (!removed || !this.d.newIdentity) throw error;
      // This device was removed from the account: come back as a new device (needs approval).
      this.identity = await this.d.newIdentity();
      this.shownApprover = null;
      this.d.library.setDeviceId(this.identity.deviceId);
      auth = await register();
    }
    this.session = { userId: auth.user.id, email: auth.user.email, refreshToken: auth.refreshToken, accessToken: auth.accessToken, accessExpiresAt: auth.accessExpiresAt };
    await this.d.saveSession(this.session);
    this.update({ signedIn: true, email: auth.user.email, deviceStatus: auth.device.status });
    return this.refreshState();
  }

  /**
   * Leaves the account on this device: ends the session, deletes this device's history and keys and
   * starts a new device identity. Local only: synced clips stay in the account, and nothing carries
   * over to the next account signed in here. The old device entry stays in the account until removed
   * from another device (a self-revoke here could not rotate the vault key, leaving a stale roster).
   */
  async signOut(): Promise<void> {
    this.stopScheduler();
    if (this.session) await this.api.logout({ refreshToken: this.session.refreshToken }).catch(() => undefined);
    this.session = null;
    await this.d.saveSession(null);
    await this.d.library.forgetAll();
    const kv = kvRepo(this.d.db);
    await kv.set(SYNC_CURSOR, 0);
    await kv.set(VAULT_VERSION, 0);
    await this.d.setKeyring(createKeyring());
    if (this.d.newIdentity) {
      this.identity = await this.d.newIdentity();
      this.d.library.setDeviceId(this.identity.deviceId);
    }
    this.shownApprover = null;
    this.pairings = [];
    this.approving.clear();
    this.status = { configured: this.status.configured, signedIn: false, vault: 'none', sync: { state: 'off', pending: 0 } };
    this.emit();
  }

  /** Works out where this device stands and creates the account vault if it is the first device. */
  private async refreshState(): Promise<{ recoveryKey?: string }> {
    const me = (await this.api.listDevices()).devices.find((x) => x.id === this.identity.deviceId);
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
    if (state.initialized && !rosterEntry(this.d.getKeyring(), this.identity.deviceId)) {
      // Authorized on the server but never took the keyring (e.g. the app closed before
      // "Codes match"): there is nothing local to verify an envelope against, so join again.
      this.update({ vault: 'needs_enrollment', sync: { ...this.status.sync, state: 'off' } });
      return {};
    }
    if (!state.initialized) {
      const { ring, recoveryKey } = await createAccountVault(this.api, this.identity, this.d.getKeyring());
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
    this.showJoinRequests(state.pendingDevices);
    const known = (await kvRepo(this.d.db).get<number>(VAULT_VERSION)) ?? 0;
    if (!force && state.version === known) return;
    let res: RefreshResult;
    try {
      res = await refreshKeyring(this.api, this.identity, this.d.getKeyring(), known);
    } catch (error) {
      if (!(error instanceof UntrustedEnvelopeError)) throw error;
      // Not even the replayed history vouches for the new signer: join again (codes match or recovery key).
      this.update({ vault: 'needs_enrollment', sync: { ...this.status.sync, state: 'off' } });
      return;
    }
    if (res.status === 'removed') {
      this.update({ vault: 'removed' });
      throw new Error('this device was removed from the vault');
    }
    if (res.status === 'updated') await this.d.setKeyring(res.ring);
    // The roster changed: there may be a device whose name is not known yet.
    this.namesAt = 0;
    await kvRepo(this.d.db).set(VAULT_VERSION, state.version);
    this.update({ vault: 'ready' });
  }

  // ── enrollment: new-device side ────────────────────────────────────────────────────────

  /** Pending device: who claimed us and the code to compare, or null while nobody has. */
  async enrollment(): Promise<{ approverName: string; code: string; approved?: boolean; rejoin?: boolean; paired?: boolean } | null> {
    // Paired by QR: nothing to compare; join as soon as the approver has published our envelope.
    if (this.shownApprover?.paired) return this.finishPairing();
    if (this.status.deviceStatus === 'authorized') {
      // Already approved, but this device has no keyring it can verify the latest envelope with: either
      // it was never accepted here, or (`rejoin`) it was a member that fell too far behind. The
      // envelope's signer is the device to compare codes with (it shows them under "Show code").
      if (!this.shownApprover) {
        const { signer } = await this.api.envelope();
        this.shownApprover = { ...signer, code: enrollmentCodeFor(this.publicKeys(), signer.keys) };
      }
      const rejoin = !!rosterEntry(this.d.getKeyring(), this.identity.deviceId);
      return { approverName: this.shownApprover.name, code: this.shownApprover.code, approved: true, ...(rejoin ? { rejoin } : {}) };
    }
    const { approver, proof } = await this.api.enrollment();
    if (!approver) return this.shownApprover ? { approverName: this.shownApprover.name, code: this.shownApprover.code } : null;
    const code = enrollmentCodeFor(this.publicKeys(), approver.keys);
    // The approver scanned our QR: its proof (keyed by the QR secret the server never saw) vouches for its keys.
    if (proof && this.liveOffers().some((o) => checkPairingProof(o, this.identity, approver, proof))) {
      this.pairings = [];
      this.shownApprover = { ...approver, code, paired: true };
      return this.finishPairing();
    }
    this.shownApprover = { ...approver, code };
    return { approverName: approver.name, code };
  }

  private async finishPairing(): Promise<{ approverName: string; code: string; paired: true }> {
    const { name, code } = this.shownApprover!;
    try {
      await this.acceptEnrollment();
    } catch (error) {
      // No envelope yet: the approver is still sealing the keyring. The next poll tries again.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    return { approverName: name, code, paired: true };
  }

  // ── QR pairing ─────────────────────────────────────────────────────────────────────────

  /**
   * The pairing QR this device shows: a new device shows it to a connected one, or a connected
   * device shows it to a new one. Each code is valid for 10 minutes.
   */
  async pairingQr(): Promise<string> {
    if (!this.session) throw new Error('sign in first');
    const offer = createPairingOffer(this.identity);
    // Earlier codes stay valid until they expire: one may have been scanned just before the screen refreshed it.
    this.pairings = [...this.pairings.filter((p) => p.expiresAt > this.now()), { offer, expiresAt: this.now() + PAIRING_TTL_MS }];
    return offer.text;
  }

  /**
   * Scanner side. A connected device scanning a new one approves it at once; a new device scanning
   * a connected one asks it to approve (that device finishes while it shows its code).
   */
  async pairWithQr(text: string): Promise<{ name: string }> {
    const qr = parsePairingQr(text);
    const shower = (await this.api.listDevices()).devices.find((d) => d.id === qr.deviceId);
    if (this.status.vault === 'ready' && this.status.deviceStatus === 'authorized') {
      if (shower?.status !== 'pending') throw new Error('This code is not from a device waiting to join your account.');
      const proof = answerPairing(qr, this.identity, shower);
      await this.api.claimDevice(shower.id, { proof });
      await this.approve(shower.id, shower.keys);
      return { name: shower.name };
    }
    if (this.status.vault === 'needs_enrollment' && this.status.deviceStatus === 'pending') {
      if (shower?.status !== 'authorized') throw new Error('Scan the code shown on a device that is already connected to your account.');
      const proof = answerPairing(qr, this.identity, shower);
      await this.api.pairDevice({ approverId: shower.id, proof });
      this.shownApprover = { id: shower.id, name: shower.name, keys: shower.keys, code: enrollmentCodeFor(this.publicKeys(), shower.keys), paired: true };
      return { name: shower.name };
    }
    throw new Error('This device cannot pair right now.');
  }

  /** Showing side, polled while a connected device shows its QR: approves the device that scanned it. */
  async checkPairing(): Promise<{ name: string } | null> {
    const offers = this.liveOffers();
    if (offers.length === 0 || this.status.vault !== 'ready') return null;
    for (const d of (await this.api.listDevices()).devices) {
      const proof = d.pairingProof;
      if (d.status !== 'pending' || !proof || !offers.some((o) => checkPairingProof(o, this.identity, d, proof))) continue;
      this.pairings = [];
      await this.approve(d.id, d.keys);
      return { name: d.name };
    }
    return null;
  }

  private liveOffers(): PairingOffer[] {
    return this.pairings.filter((p) => p.expiresAt > this.now()).map((p) => p.offer);
  }

  /**
   * After the user confirmed the codes match on this device. Uses exactly the approver whose code
   * was shown (the server clears the claim once approval completes, and must not be asked again).
   */
  async acceptEnrollment(): Promise<void> {
    const approver = this.shownApprover;
    if (!approver) throw new Error('no device has started approving this one');
    await this.join(await acceptEnrollment(this.api, this.identity, approver));
    this.shownApprover = null;
  }

  async recover(recoveryKey: string): Promise<void> {
    if (!this.session) throw new Error('sign in first');
    await this.join(await recoverVault(this.api, this.identity, this.session.userId, recoveryKey, this.now()));
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
    const { devices } = await this.api.listDevices();
    await this.rememberNames(Object.fromEntries(devices.map((x) => [x.id, x.name])));
    return devices.map((x) => ({
      id: x.id, name: x.name, platform: x.platform, status: x.status, lastSeenAt: x.lastSeenAt,
      ...(x.lastSyncAt !== undefined ? { lastSyncAt: x.lastSyncAt } : {}),
      isThisDevice: x.id === this.identity.deviceId,
    }));
  }

  /**
   * Names of the account's other devices, by id, for "from <device>" labels. Remembered on this device, so
   * they show offline and for devices removed since.
   */
  async deviceNames(): Promise<Record<string, string>> {
    const names = { ...((await kvRepo(this.d.db).get<Record<string, string>>(DEVICE_NAMES)) ?? {}) };
    delete names[this.identity.deviceId];
    return names;
  }

  private namesAt = 0;

  private async rememberNames(names: Record<string, string>): Promise<void> {
    this.namesAt = this.now();
    const kv = kvRepo(this.d.db);
    const known = (await kv.get<Record<string, string>>(DEVICE_NAMES)) ?? {};
    const next = { ...known, ...names };
    if (JSON.stringify(next) === JSON.stringify(known)) return;
    await kv.set(DEVICE_NAMES, next);
    this.emit();
  }

  /** Names only label clips: a failure here never fails a sync. */
  private async refreshNames(): Promise<void> {
    if (this.namesAt > 0 && this.now() - this.namesAt < NAMES_MAX_AGE_MS) return;
    await this.devices().catch((error: unknown) => this.d.log.debug('device names not refreshed', { error }));
  }

  /** Claims a pending device and returns the code to compare with the one it shows. */
  async startApproval(deviceId: string): Promise<{ code: string }> {
    const pending = (await this.api.listDevices()).devices.find((x) => x.id === deviceId && x.status === 'pending');
    if (!pending) throw new Error('device is not waiting for approval');
    await this.api.claimDevice(deviceId);
    // confirmApproval seals to exactly these keys, the ones the code was computed from.
    this.approving.set(deviceId, pending.keys);
    return { code: enrollmentCodeFor(pending.keys, this.publicKeys()) };
  }

  /**
   * The code for an already-approved device that never accepted its keyring, so the user can
   * compare it with the one that device shows when it joins again.
   */
  async approvalCode(deviceId: string): Promise<{ code: string }> {
    const d = (await this.api.listDevices()).devices.find((x) => x.id === deviceId && x.status === 'authorized');
    if (!d) throw new Error('device is not connected');
    return { code: enrollmentCodeFor(d.keys, this.publicKeys()) };
  }

  /** After the user confirmed the codes match on this device. */
  async confirmApproval(deviceId: string): Promise<void> {
    // Not re-fetched: a server could otherwise swap in its own keys after the codes were compared.
    const keys = this.approving.get(deviceId);
    if (!keys) throw new Error('Tap Approve again to show a fresh code.');
    await this.approve(deviceId, keys);
    this.approving.delete(deviceId);
  }

  /** Seals the keyring to a pending device whose keys were verified (codes or QR pairing). */
  private async approve(deviceId: string, keys: DevicePublicKeys): Promise<void> {
    await this.d.setKeyring(await approveDevice(this.api, this.identity, this.d.getKeyring(), { id: deviceId, keys }));
    const state = await this.api.vaultState();
    await kvRepo(this.d.db).set(VAULT_VERSION, state.version);
    this.showJoinRequests(state.pendingDevices);
    this.emit();
  }

  /** Returns a new recovery key when the removed device had held the old one (show it once). */
  async revoke(deviceId: string): Promise<{ recoveryKey?: string }> {
    const { ring, recoveryKey } = await revokeAndRotate(this.api, this.identity, this.d.getKeyring(), deviceId);
    await this.adoptRotation(ring);
    return recoveryKey ? { recoveryKey } : {};
  }

  /** Replaces the recovery key (lost or exposed); the old one stops working. Show the new one once. */
  async replaceRecoveryKey(): Promise<{ recoveryKey: string }> {
    const { ring, recoveryKey } = await replaceRecoveryKey(this.api, this.identity, this.d.getKeyring());
    await this.adoptRotation(ring);
    return { recoveryKey };
  }

  private async adoptRotation(ring: Keyring): Promise<void> {
    await this.d.setKeyring(ring);
    const state = await this.api.vaultState();
    await kvRepo(this.d.db).set(VAULT_VERSION, state.version);
    // Removing a device that was still waiting clears its request.
    this.showJoinRequests(state.pendingDevices);
    this.emit();
  }

  async rename(deviceId: string, name: string): Promise<void> {
    await this.api.renameDevice(deviceId, name);
    await this.rememberNames({ [deviceId]: name });
  }

  // ── sync scheduling ────────────────────────────────────────────────────────────────────

  /** One sync now (single-flight). Never throws; problems land in the status. */
  async sync(): Promise<void> {
    if (!this.canSync()) return;
    this.update({ sync: { ...this.status.sync, state: 'syncing' } });
    try {
      await this.refreshVault();
      if (this.status.vault !== 'ready') return;
      await this.engine.sync();
      void this.refreshNames();
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
      this.showJoinRequests(state.pendingDevices);
      const known = (await kvRepo(this.d.db).get<number>(VAULT_VERSION)) ?? 0;
      if (state.version !== known) return void (await this.sync());
      if (await this.engine.syncIfNeeded()) {
        this.update({ sync: { state: 'idle', lastSyncAt: this.now(), pending: await outboxRepo(this.d.db).pendingCount() } });
      }
    } catch (error) {
      this.syncFailed(error);
    }
  }

  /** Only a connected device can approve others; emits only when the list changed. */
  private showJoinRequests(pending: Array<{ id: string; name: string }>): void {
    const next = this.status.deviceStatus === 'authorized' ? pending.filter((d) => d.id !== this.identity.deviceId) : [];
    if (JSON.stringify(next) === JSON.stringify(this.status.joinRequests ?? [])) return;
    this.update({ joinRequests: next });
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
    return { boxPublicKey: toB64(this.identity.keys.box.publicKey), signPublicKey: toB64(this.identity.keys.sign.publicKey) };
  }

  private update(patch: Partial<AccountStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
