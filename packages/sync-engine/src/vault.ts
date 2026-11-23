import {
  CryptoError, deriveRecoveryKeys, enrollmentCode, extendsKeyring, formatRecoveryKey, fromB64, generateRecoveryKey,
  matchesFingerprint, openKeyringEnvelope, openRecoveryEnvelope, pairingFingerprint, pairingProof, pairingSecret, parseRecoveryKey,
  recoveryPublicKeys, rosterEntry, rotateKeyring, sealKeyringFor, sealRecoveryEnvelope, signRecoveryProof, toB64,
  verifyPairingProof, withRecovery, withRoster,
  type DeviceKeyPairs, type Keyring, type RosterEntry, type SealedEnvelope,
} from '@clipply/crypto';
import type { ApiClient } from '@clipply/api-client';
import { ENVELOPE_HISTORY_PAGE, type KeyEnvelope, type RecoveryEnvelope } from '@clipply/shared-schemas';

export interface DeviceIdentity {
  deviceId: string;
  keys: DeviceKeyPairs;
}

/** Public keys as the API exchanges them (base64url). */
export interface DevicePublicKeys {
  boxPublicKey: string;
  signPublicKey: string;
}

export type VaultApi = Pick<
  ApiClient,
  'vaultState' | 'initVault' | 'envelope' | 'envelopeHistory' | 'claimDevice' | 'pairDevice' | 'enrollment' | 'publishEnvelopes' | 'recover' | 'revokeDevice'
>;

export class VaultProtocolError extends Error {
  override name = 'VaultProtocolError';
}

/** The latest envelope's signer is unknown here, even after replaying the envelope history this device missed. */
export class UntrustedEnvelopeError extends VaultProtocolError {}

const entryOf = (id: string, keys: DevicePublicKeys): RosterEntry => ({
  id,
  boxPublicKey: fromB64(keys.boxPublicKey),
  signPublicKey: fromB64(keys.signPublicKey),
});

const selfEntry = (me: DeviceIdentity): RosterEntry => ({
  id: me.deviceId,
  boxPublicKey: me.keys.box.publicKey,
  signPublicKey: me.keys.sign.publicKey,
});

const toWire = (e: SealedEnvelope, deviceId: string, signerDeviceId: string): KeyEnvelope => ({
  deviceId, epoch: e.epoch, sealed: toB64(e.sealed), signerDeviceId, signature: toB64(e.signature),
});

const fromWire = (e: KeyEnvelope): SealedEnvelope => ({ epoch: e.epoch, sealed: fromB64(e.sealed), signature: fromB64(e.signature) });

/** One envelope per roster member, all signed with `signingKey` on behalf of `signerId`. */
function envelopesFor(ring: Keyring, signerId: string, signingKey: Uint8Array): KeyEnvelope[] {
  if (!ring.roster?.length) throw new VaultProtocolError('keyring has no device roster');
  return ring.roster.map((r) => toWire(sealKeyringFor(ring, r.id, r.boxPublicKey, signingKey), r.id, signerId));
}

function recoveryEnvelope(ring: Keyring): RecoveryEnvelope {
  if (!ring.recovery) throw new VaultProtocolError('keyring has no recovery keys');
  return {
    epoch: ring.current,
    // Sealed to the recovery key from our own authenticated keyring — never to one the server supplies.
    sealed: toB64(sealRecoveryEnvelope(ring, ring.recovery.boxPublicKey)),
    boxPublicKey: toB64(ring.recovery.boxPublicKey),
    signPublicKey: toB64(ring.recovery.signPublicKey),
  };
}

/**
 * First device of an account: the local keyring becomes the account vault (so local history stays
 * readable as-is), with this device as the only roster member and a new recovery key.
 * Returns the recovery key text, which must be shown to the user exactly once.
 */
export async function createAccountVault(api: VaultApi, me: DeviceIdentity, local: Keyring): Promise<{ ring: Keyring; recoveryKey: string }> {
  const rk = generateRecoveryKey();
  const ring = withRecovery(withRoster(local, [selfEntry(me)]), { ...recoveryPublicKeys(deriveRecoveryKeys(rk)), knownBy: [me.deviceId] });
  const [envelope] = envelopesFor(ring, me.deviceId, me.keys.sign.privateKey);
  await api.initVault({ envelope: envelope!, recovery: recoveryEnvelope(ring) });
  return { ring, recoveryKey: formatRecoveryKey(rk) };
}

/** The 12-digit code both devices display; the user confirms they match on both screens. */
export function enrollmentCodeFor(newDevice: DevicePublicKeys, approver: DevicePublicKeys): string {
  const n = entryOf('new', newDevice);
  const a = entryOf('approver', approver);
  return enrollmentCode(n, a);
}

// ── QR pairing (replaces the code comparison when one device can scan the other's screen) ──────

/** A pairing QR this device shows: its id, its key fingerprint and a one-time secret. */
export interface PairingOffer {
  text: string;
  secret: Uint8Array;
}

export interface ScannedPairing {
  deviceId: string;
  fingerprint: Uint8Array;
  secret: Uint8Array;
}

const PAIRING_QR = /^clipply-pair:1:([0-9a-fA-F-]{36}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{22})$/;

export function createPairingOffer(me: DeviceIdentity): PairingOffer {
  const secret = pairingSecret();
  return { secret, text: `clipply-pair:1:${me.deviceId}:${toB64(pairingFingerprint(selfEntry(me)))}:${toB64(secret)}` };
}

export function parsePairingQr(text: string): ScannedPairing {
  const m = PAIRING_QR.exec(text.trim());
  if (!m) throw new VaultProtocolError('This is not a Clipply pairing code.');
  return { deviceId: m[1]!, fingerprint: fromB64(m[2]!), secret: fromB64(m[3]!) };
}

/**
 * Scanner side: checks the keys the server reports for the QR's device against the fingerprint the
 * QR carries (a substituted key fails here), then returns the proof to send through the server.
 */
export function answerPairing(qr: ScannedPairing, me: DeviceIdentity, shower: { id: string; keys: DevicePublicKeys }): string {
  const entry = entryOf(shower.id, shower.keys);
  if (shower.id !== qr.deviceId || !matchesFingerprint(entry, qr.fingerprint)) {
    throw new VaultProtocolError("The device's keys do not match the code. Do not continue: someone may be intercepting the connection.");
  }
  return toB64(pairingProof(qr.secret, selfEntry(me), entry));
}

/** Showing side: true only if `proof` comes from a device that read our QR and has exactly these keys. */
export function checkPairingProof(offer: PairingOffer, me: DeviceIdentity, scanner: { id: string; keys: DevicePublicKeys }, proof: string): boolean {
  return verifyPairingProof(offer.secret, entryOf(scanner.id, scanner.keys), selfEntry(me), fromB64(proof));
}

/** Approver side, after `claimDevice` and after the user confirmed matching codes (or a verified QR pairing). */
export async function approveDevice(api: VaultApi, me: DeviceIdentity, ring: Keyring, pending: { id: string; keys: DevicePublicKeys }): Promise<Keyring> {
  const roster = (ring.roster ?? []).filter((r) => r.id !== pending.id);
  const next = withRoster(ring, [...roster, entryOf(pending.id, pending.keys)]);
  // The recovery copy is republished too, so a later recovery starts from the current roster.
  await api.publishEnvelopes({
    epoch: next.current, envelopes: envelopesFor(next, me.deviceId, me.keys.sign.privateKey), recovery: recoveryEnvelope(next), authorize: pending.id,
  });
  return next;
}

/**
 * New-device side, after the user confirmed matching codes for `approver`. Only an envelope signed
 * by exactly that confirmed key is accepted, so a server substituting keys is caught.
 */
export async function acceptEnrollment(api: VaultApi, me: DeviceIdentity, approver: { id: string; keys: DevicePublicKeys }): Promise<Keyring> {
  const { envelope } = await api.envelope();
  if (envelope.signerDeviceId !== approver.id) throw new VaultProtocolError('envelope not signed by the confirmed device');
  const ring = openKeyringEnvelope(fromWire(envelope), me.deviceId, me.keys.box, fromB64(approver.keys.signPublicKey));
  if (!rosterEntry(ring, me.deviceId)) throw new VaultProtocolError('this device is not in the received roster');
  return ring;
}

/**
 * Recovery-key enrollment. The proof authorizes this device; the recovery envelope yields the full
 * keyring; this device then adds itself to the roster and republishes, signing with the recovery key
 * (which every roster member already trusts) because no member knows this device yet.
 */
export async function recoverVault(api: VaultApi, me: DeviceIdentity, userId: string, recoveryKeyText: string, now: number): Promise<Keyring> {
  const keys = deriveRecoveryKeys(parseRecoveryKey(recoveryKeyText));
  const { recovery } = await api.recover({ timestamp: now, signature: toB64(signRecoveryProof(keys, userId, me.deviceId, now)) });
  const ring = openRecoveryEnvelope(fromB64(recovery.sealed), keys);
  const roster = (ring.roster ?? []).filter((r) => r.id !== me.deviceId);
  let next = withRoster(ring, [...roster, selfEntry(me)]);
  // This device has now seen the recovery key: revoking it later must replace the key.
  const knownBy = [...new Set([...(ring.recovery?.knownBy ?? []), me.deviceId])];
  if (next.recovery) next = withRecovery(next, { ...next.recovery, knownBy });
  await api.publishEnvelopes({ epoch: next.current, envelopes: envelopesFor(next, me.deviceId, keys.sign.privateKey), recovery: recoveryEnvelope(next) });
  return next;
}

/** A rotation, optionally with a new recovery key. The recovery key text is returned only when replaced. */
async function rotate(api: VaultApi, me: DeviceIdentity, ring: Keyring, newRecoveryKey: boolean): Promise<{ ring: Keyring; recoveryKey?: string }> {
  let next = rotateKeyring(ring);
  let recoveryKey: string | undefined;
  if (newRecoveryKey) {
    const rk = generateRecoveryKey();
    next = withRecovery(next, { ...recoveryPublicKeys(deriveRecoveryKeys(rk)), knownBy: [me.deviceId] });
    recoveryKey = formatRecoveryKey(rk);
  }
  await api.publishEnvelopes({ epoch: next.current, envelopes: envelopesFor(next, me.deviceId, me.keys.sign.privateKey), recovery: recoveryEnvelope(next) });
  return recoveryKey ? { ring: next, recoveryKey } : { ring: next };
}

/**
 * Revokes a device and rotates the vault key so it cannot read anything written afterwards. If that
 * device ever held the recovery key, the recovery key is replaced too (it could have kept a copy);
 * the new one is returned and must be shown to the user once.
 */
export async function revokeAndRotate(api: VaultApi, me: DeviceIdentity, ring: Keyring, deviceId: string): Promise<{ ring: Keyring; recoveryKey?: string }> {
  if (deviceId === me.deviceId) throw new VaultProtocolError('use sign-out to remove this device');
  await api.revokeDevice(deviceId);
  const remaining = withRoster(ring, (ring.roster ?? []).filter((r) => r.id !== deviceId));
  return rotate(api, me, remaining, ring.recovery?.knownBy?.includes(deviceId) ?? false);
}

/** Replaces a lost or exposed recovery key. The old one stops working; the vault key rotates with it. */
export async function replaceRecoveryKey(api: VaultApi, me: DeviceIdentity, ring: Keyring): Promise<{ ring: Keyring; recoveryKey: string }> {
  const { ring: next, recoveryKey } = await rotate(api, me, ring, true);
  return { ring: next, recoveryKey: recoveryKey! };
}

/** Opens an envelope signed by a roster member of `ring` or by its recovery key; null if neither signed it. */
function openTrusted(envelope: KeyEnvelope, me: DeviceIdentity, ring: Keyring): Keyring | null {
  const candidates = [rosterEntry(ring, envelope.signerDeviceId)?.signPublicKey, ring.recovery?.signPublicKey].filter(
    (k): k is Uint8Array => k !== undefined,
  );
  for (const key of candidates) {
    try {
      return openKeyringEnvelope(fromWire(envelope), me.deviceId, me.keys.box, key);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
    }
  }
  return null;
}

export type RefreshResult ={ status: 'unchanged' | 'updated'; ring: Keyring } | { status: 'removed'; ring: Keyring };

/**
 * Picks up a re-published envelope (new roster or rotated epoch). Accepted only if signed by a
 * device in our current roster or by the recovery key we hold, and if it keeps every key we have.
 * `since` is the vault version this device last processed; missed steps are replayed from there.
 */
export async function refreshKeyring(api: VaultApi, me: DeviceIdentity, ring: Keyring, since = 0): Promise<RefreshResult> {
  const { envelope } = await api.envelope();
  let next = openTrusted(envelope, me, ring);
  if (!next) {
    // Missed more than one roster change: replay this device's envelopes since `since`, each accepted
    // only if the roster trusted so far vouches for its signer, then check the latest against that.
    let trusted = ring;
    for (let from = since; ;) {
      let page;
      try {
        page = (await api.envelopeHistory(from)).envelopes;
      } catch (error) {
        // A server without the history endpoint yet: fall through to re-joining, as before.
        if ((error as { status?: number }).status === 404) break;
        throw error;
      }
      for (const h of page) {
        const step = openTrusted(h.envelope, me, trusted);
        if (step && extendsKeyring(step, trusted)) trusted = step;
      }
      if (page.length < ENVELOPE_HISTORY_PAGE) break;
      from = page.at(-1)!.version;
    }
    next = openTrusted(envelope, me, trusted);
  }
  if (!next) throw new UntrustedEnvelopeError('envelope is not signed by a trusted device');
  if (!extendsKeyring(next, ring)) throw new VaultProtocolError('envelope drops keys this device already has');
  if (!rosterEntry(next, me.deviceId)) return { status: 'removed', ring };
  const same = next.current === ring.current && JSON.stringify(next.roster?.map((r) => r.id)) === JSON.stringify(ring.roster?.map((r) => r.id));
  return { status: same ? 'unchanged' : 'updated', ring: next };
}
