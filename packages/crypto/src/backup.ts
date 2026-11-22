import { z } from 'zod';

import { open, seal } from './aead';
import { concat, fromB64, fromUtf8, toB64, utf8 } from './encoding';
import { CryptoError, sodium } from './sodium';

/** OWASP 2023 guidance for PBKDF2-HMAC-SHA256. libsodium's standard build has no Argon2. */
const ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;

const Header = z.object({
  format: z.literal('clipply-backup'),
  v: z.literal(1),
  kdf: z.literal('PBKDF2-SHA256'),
  iterations: z.number().int().min(100_000).max(10_000_000),
  salt: z.string().length(22),
});

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(utf8(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations }, base, 256);
  return new Uint8Array(bits);
}

/**
 * Portable encrypted file: a one-line JSON header (KDF parameters) then XChaCha20-Poly1305
 * ciphertext. The header is the AAD, so its parameters cannot be swapped.
 */
export async function sealWithPassphrase(passphrase: string, plaintext: Uint8Array): Promise<Uint8Array> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new CryptoError(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const salt = sodium().randombytes_buf(16);
  const header = JSON.stringify({ format: 'clipply-backup', v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toB64(salt) });
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  try {
    return concat(utf8(`${header}\n`), seal(key, plaintext, `clipply/v1/backup/${header}`));
  } finally {
    sodium().memzero(key);
  }
}

/** Throws CryptoError for a wrong passphrase, a damaged file or something that is not a backup. */
export async function openWithPassphrase(passphrase: string, file: Uint8Array): Promise<Uint8Array> {
  const nl = file.subarray(0, 1024).indexOf(0x0a);
  if (nl < 0) throw new CryptoError('not a Clipply backup');
  let header: string;
  let parsed: z.infer<typeof Header>;
  try {
    header = fromUtf8(file.subarray(0, nl));
    parsed = Header.parse(JSON.parse(header));
  } catch {
    throw new CryptoError('not a Clipply backup');
  }
  const key = await deriveKey(passphrase, fromB64(parsed.salt), parsed.iterations);
  try {
    return open(key, file.subarray(nl + 1), `clipply/v1/backup/${header}`);
  } catch {
    throw new CryptoError('wrong passphrase or damaged backup');
  } finally {
    sodium().memzero(key);
  }
}
