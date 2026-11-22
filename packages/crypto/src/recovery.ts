import { concat, fromBase32, toBase32, utf8 } from './encoding';
import { parseKeyring, serializeKeyring, type Keyring, type RecoveryPublicKeys } from './keyring';
import type { KeyPair } from './device';
import { CryptoError, sodium } from './sodium';

const RK_BYTES = 32;
const CHECK_BYTES = 2;

/** 256-bit random recovery key. Shown to the user once; never stored by Clipply or the server. */
export function generateRecoveryKey(): Uint8Array {
  return sodium().randombytes_buf(RK_BYTES);
}

const checksum = (rk: Uint8Array): Uint8Array => sodium().crypto_generichash(CHECK_BYTES, rk, null);

/** 55 Crockford base32 characters in groups of 5 (key + 16-bit typo checksum). */
export function formatRecoveryKey(rk: Uint8Array): string {
  return toBase32(concat(rk, checksum(rk))).match(/.{1,5}/g)!.join('-');
}

/** Accepts spaces, dashes, lower case and I/L/O look-alikes; rejects typos via the checksum. */
export function parseRecoveryKey(text: string): Uint8Array {
  const bytes = fromBase32(text);
  if (bytes.length !== RK_BYTES + CHECK_BYTES) throw new CryptoError('recovery key has the wrong length');
  const rk = bytes.slice(0, RK_BYTES);
  if (!sodium().memcmp(checksum(rk), bytes.slice(RK_BYTES))) throw new CryptoError('recovery key checksum mismatch');
  return rk;
}

export interface RecoveryKeys {
  /** X25519: keyrings are sealed to the public half, so any device can refresh the recovery copy
   * after a rotation without knowing the recovery key — and a revoked device cannot open it. */
  box: KeyPair;
  /** Ed25519: proves recovery-key possession to the server during recovery enrollment. */
  sign: KeyPair;
}

export function deriveRecoveryKeys(rk: Uint8Array): RecoveryKeys {
  const s = sodium();
  const boxKp = s.crypto_box_seed_keypair(s.crypto_kdf_derive_from_key(s.crypto_box_SEEDBYTES, 1, 'clprecov', rk));
  const signKp = s.crypto_sign_seed_keypair(s.crypto_kdf_derive_from_key(s.crypto_sign_SEEDBYTES, 2, 'clprecov', rk));
  return {
    box: { publicKey: boxKp.publicKey, privateKey: boxKp.privateKey },
    sign: { publicKey: signKp.publicKey, privateKey: signKp.privateKey },
  };
}

export const recoveryPublicKeys = (keys: RecoveryKeys): RecoveryPublicKeys => ({
  boxPublicKey: keys.box.publicKey,
  signPublicKey: keys.sign.publicKey,
});

/** Seals the keyring to the recovery public key. Callers use the key from their own keyring. */
export function sealRecoveryEnvelope(ring: Keyring, recoveryBoxPublicKey: Uint8Array): Uint8Array {
  return sodium().crypto_box_seal(serializeKeyring(ring), recoveryBoxPublicKey);
}

export function openRecoveryEnvelope(sealed: Uint8Array, keys: RecoveryKeys): Keyring {
  let bytes: Uint8Array;
  try {
    bytes = sodium().crypto_box_seal_open(sealed, keys.box.publicKey, keys.box.privateKey);
  } catch {
    throw new CryptoError('recovery envelope cannot be opened with this recovery key');
  }
  return parseKeyring(bytes);
}

export const recoveryProofMessage = (userId: string, deviceId: string, timestamp: number): Uint8Array =>
  utf8(`clipply/v1/recover/${userId}/${deviceId}/${timestamp}`);

/** Signature the server checks against the stored recovery public key before authorizing a device. */
export function signRecoveryProof(keys: RecoveryKeys, userId: string, deviceId: string, timestamp: number): Uint8Array {
  return sodium().crypto_sign_detached(recoveryProofMessage(userId, deviceId, timestamp), keys.sign.privateKey);
}
