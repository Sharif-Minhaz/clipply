import { open, seal } from './aead';
import { concat, fromBase32, toBase32 } from './encoding';
import { parseKeyring, serializeKeyring, type Keyring } from './keyring';
import type { KeyPair } from './device';
import { CryptoError, sodium } from './sodium';

const RK_BYTES = 32;
const CHECK_BYTES = 2;
const RECOVERY_AAD = 'clipply/v1/recovery';

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
  /** Encrypts the keyring stored on the server. */
  wrapKey: Uint8Array;
  /** Proves recovery-key possession to the server during enrollment; public half stored server-side. */
  sign: KeyPair;
}

export function deriveRecoveryKeys(rk: Uint8Array): RecoveryKeys {
  const s = sodium();
  const wrapKey = s.crypto_kdf_derive_from_key(32, 1, 'clprecov', rk);
  const seed = s.crypto_kdf_derive_from_key(s.crypto_sign_SEEDBYTES, 2, 'clprecov', rk);
  const kp = s.crypto_sign_seed_keypair(seed);
  return { wrapKey, sign: { publicKey: kp.publicKey, privateKey: kp.privateKey } };
}

export function sealRecoveryEnvelope(ring: Keyring, keys: RecoveryKeys): Uint8Array {
  return seal(keys.wrapKey, serializeKeyring(ring), RECOVERY_AAD);
}

export function openRecoveryEnvelope(ciphertext: Uint8Array, keys: RecoveryKeys): Keyring {
  return parseKeyring(open(keys.wrapKey, ciphertext, RECOVERY_AAD));
}
