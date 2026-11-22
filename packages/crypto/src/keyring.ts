import { z } from 'zod';

import { fromB64, fromUtf8, toB64, utf8 } from './encoding';
import { KEY_BYTES, randomKey } from './aead';
import { CryptoError, sodium } from './sodium';

/** Every vault key generation the device knows. Old epochs stay so old items remain readable. */
export interface Keyring {
  readonly current: number;
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

export function createKeyring(): Keyring {
  return { current: 1, keys: new Map([[1, randomKey()]]) };
}

/** New epoch for key rotation after a device revocation. */
export function rotateKeyring(ring: Keyring): Keyring {
  const next = ring.current + 1;
  return { current: next, keys: new Map([...ring.keys, [next, randomKey()]]) };
}

export function epochKey(ring: Keyring, epoch: number): Uint8Array {
  const key = ring.keys.get(epoch);
  if (!key) throw new CryptoError(`unknown key epoch ${epoch}`);
  return key;
}

/**
 * A received keyring is acceptable only if it holds every key we already have, byte-identical.
 * A server that never held the vault cannot produce one.
 */
export function extendsKeyring(candidate: Keyring, known: Keyring): boolean {
  if (candidate.current < known.current) return false;
  for (const [epoch, key] of known.keys) {
    const other = candidate.keys.get(epoch);
    if (!other || !sodium().memcmp(other, key)) return false;
  }
  return true;
}

/** Keyed hash for duplicate detection. Derived from epoch 1 so hashes stay comparable across rotations. */
export function contentHash(ring: Keyring, normalizedContent: Uint8Array): string {
  const s = sodium();
  const hashKey = s.crypto_kdf_derive_from_key(32, 1, 'clphash_', epochKey(ring, 1));
  return s.to_hex(s.crypto_generichash(32, normalizedContent, hashKey));
}

const KeyringJson = z.object({
  v: z.literal(1),
  current: z.number().int().min(1),
  keys: z.record(z.string().regex(/^[1-9]\d*$/), z.string()),
});

export function serializeKeyring(ring: Keyring): Uint8Array {
  const keys = Object.fromEntries([...ring.keys].map(([epoch, key]) => [String(epoch), toB64(key)]));
  return utf8(JSON.stringify({ v: 1, current: ring.current, keys }));
}

export function parseKeyring(bytes: Uint8Array): Keyring {
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new CryptoError('keyring is not valid JSON');
  }
  const parsed = KeyringJson.safeParse(json);
  if (!parsed.success) throw new CryptoError('malformed keyring');
  const keys = new Map(Object.entries(parsed.data.keys).map(([e, k]) => [Number(e), fromB64(k)] as const));
  for (let epoch = 1; epoch <= parsed.data.current; epoch++) {
    if (keys.get(epoch)?.length !== KEY_BYTES) throw new CryptoError('keyring is missing an epoch');
  }
  if (keys.size !== parsed.data.current) throw new CryptoError('keyring has keys beyond current epoch');
  return { current: parsed.data.current, keys };
}
