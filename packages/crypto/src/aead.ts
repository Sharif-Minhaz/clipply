import { concat, utf8 } from './encoding';
import { CryptoError, sodium } from './sodium';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;

/**
 * ISO/IEC 7816-4 padding to a size bucket, hiding exact lengths from the server.
 * Buckets grow with size so small items stay small: <4 KiB → 256 B, <1 MiB → 4 KiB, else 64 KiB.
 */
export function pad(data: Uint8Array): Uint8Array {
  const block = data.length < 4096 ? 256 : data.length < 1 << 20 ? 4096 : 65536;
  const padded = new Uint8Array((Math.floor(data.length / block) + 1) * block);
  padded.set(data);
  padded[data.length] = 0x80;
  return padded;
}

/** Only ever called on authenticated plaintext, so it needs no constant-time care. */
export function unpad(padded: Uint8Array): Uint8Array {
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x80) throw new CryptoError('invalid padding');
  return padded.subarray(0, end);
}

/** XChaCha20-Poly1305-IETF; output is `nonce || ciphertext || tag`. `nonce` is for test vectors only. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string, nonce?: Uint8Array): Uint8Array {
  const s = sodium();
  const n = nonce ?? s.randombytes_buf(NONCE_BYTES);
  return concat(n, s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, utf8(aad), null, n, key));
}

export function open(key: Uint8Array, box: Uint8Array, aad: string): Uint8Array {
  if (box.length < NONCE_BYTES + sodium().crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new CryptoError('ciphertext too short');
  }
  try {
    return sodium().crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      box.subarray(NONCE_BYTES),
      utf8(aad),
      box.subarray(0, NONCE_BYTES),
      key,
    );
  } catch {
    throw new CryptoError('authentication failed');
  }
}

export function randomKey(): Uint8Array {
  return sodium().randombytes_buf(KEY_BYTES);
}
