import { concat, utf8 } from './encoding';
import { parseKeyring, serializeKeyring, type Keyring } from './keyring';
import { CryptoError, sodium } from './sodium';

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** A device's long-term keys. Private halves belong in OS secure storage only. */
export interface DeviceKeyPairs {
  box: KeyPair;
  sign: KeyPair;
}

export function generateDeviceKeys(): DeviceKeyPairs {
  const s = sodium();
  const box = s.crypto_box_keypair();
  const sign = s.crypto_sign_keypair();
  return {
    box: { publicKey: box.publicKey, privateKey: box.privateKey },
    sign: { publicKey: sign.publicKey, privateKey: sign.privateKey },
  };
}

const envelopeMessage = (deviceId: string, epoch: number, sealed: Uint8Array): Uint8Array =>
  concat(utf8(`clipply/v1/envelope/${deviceId}/${epoch}/`), sealed);

export interface SealedEnvelope {
  epoch: number;
  sealed: Uint8Array;
  signature: Uint8Array;
}

/** Seals the whole keyring to a recipient device and signs it as the sending device. */
export function sealKeyringFor(
  ring: Keyring,
  recipientDeviceId: string,
  recipientBoxPublicKey: Uint8Array,
  signerSignPrivateKey: Uint8Array,
): SealedEnvelope {
  const s = sodium();
  const sealed = s.crypto_box_seal(serializeKeyring(ring), recipientBoxPublicKey);
  const signature = s.crypto_sign_detached(envelopeMessage(recipientDeviceId, ring.current, sealed), signerSignPrivateKey);
  return { epoch: ring.current, sealed, signature };
}

/** Verifies the signer before decrypting; rejects keyrings whose epoch disagrees with the signed one. */
export function openKeyringEnvelope(
  envelope: SealedEnvelope,
  ownDeviceId: string,
  ownBox: KeyPair,
  signerSignPublicKey: Uint8Array,
): Keyring {
  const s = sodium();
  const message = envelopeMessage(ownDeviceId, envelope.epoch, envelope.sealed);
  if (!s.crypto_sign_verify_detached(envelope.signature, message, signerSignPublicKey)) {
    throw new CryptoError('envelope signature invalid');
  }
  let bytes: Uint8Array;
  try {
    bytes = s.crypto_box_seal_open(envelope.sealed, ownBox.publicKey, ownBox.privateKey);
  } catch {
    throw new CryptoError('envelope cannot be opened by this device');
  }
  const ring = parseKeyring(bytes);
  if (ring.current !== envelope.epoch) throw new CryptoError('envelope epoch mismatch');
  return ring;
}

/**
 * Short authentication string shown on both devices during enrollment (12 digits, ~40 bits).
 * Any key substituted by the server changes it. Order: new device first, approving device second.
 */
type PublicKeys = { boxPublicKey: Uint8Array; signPublicKey: Uint8Array };

/** One-time secret printed in a pairing QR code; it travels only optically, never via the server. */
export function pairingSecret(): Uint8Array {
  return sodium().randombytes_buf(16);
}

/** Fingerprint of the QR-showing device's keys, so the scanner can check the keys the server hands it. */
export function pairingFingerprint(keys: PublicKeys): Uint8Array {
  return sodium().crypto_generichash(32, concat(utf8('clipply/v1/pair-fp/'), keys.boxPublicKey, keys.signPublicKey), null);
}

/**
 * Proof that the scanner read the QR (it knows the secret), binding both devices' ids and keys. The
 * showing device recomputes it from its secret to authenticate the scanner's keys.
 */
export function pairingProof(secret: Uint8Array, scanner: PublicKeys & { id: string }, shower: PublicKeys & { id: string }): Uint8Array {
  return sodium().crypto_generichash(
    32,
    concat(utf8(`clipply/v1/pair/${scanner.id}/${shower.id}/`), scanner.boxPublicKey, scanner.signPublicKey, shower.boxPublicKey, shower.signPublicKey),
    secret,
  );
}

export function verifyPairingProof(secret: Uint8Array, scanner: PublicKeys & { id: string }, shower: PublicKeys & { id: string }, proof: Uint8Array): boolean {
  return proof.length === 32 && sodium().memcmp(pairingProof(secret, scanner, shower), proof);
}

/** Constant-time comparison of a QR fingerprint against keys. */
export function matchesFingerprint(keys: PublicKeys, fingerprint: Uint8Array): boolean {
  return fingerprint.length === 32 && sodium().memcmp(pairingFingerprint(keys), fingerprint);
}

export function enrollmentCode(
  newDevice: { boxPublicKey: Uint8Array; signPublicKey: Uint8Array },
  approver: { boxPublicKey: Uint8Array; signPublicKey: Uint8Array },
): string {
  const s = sodium();
  const digest = s.crypto_generichash(
    16,
    concat(utf8('clipply/v1/sas/'), newDevice.boxPublicKey, newDevice.signPublicKey, approver.boxPublicKey, approver.signPublicKey),
    null,
  );
  const n = new DataView(digest.buffer, digest.byteOffset).getBigUint64(0) % 1_000_000_000_000n;
  const digits = n.toString().padStart(12, '0');
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
}
