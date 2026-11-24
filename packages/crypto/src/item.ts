import { ItemMeta } from '@clipply/shared-schemas';

import { open, pad, randomKey, seal, unpad } from './aead';
import { fromUtf8, utf8 } from './encoding';
import { epochKey, type Keyring } from './keyring';
import { CryptoError } from './sodium';

export type ItemPart = 'dek' | 'meta' | 'body' | 'thumb' | 'ocr' | `body/${number}/${number}`;
/** Parts sealed whole with the item's DEK. */
export type DataPart = 'body' | 'thumb' | 'ocr';

/** Binds a ciphertext to its item and field so stored ciphertexts cannot be swapped around. */
export const itemAad = (itemId: string, part: ItemPart): string => `clipply/v1/${itemId}/${part}`;

export const generateDek = randomKey;

export interface WrappedDek {
  keyEpoch: number;
  dek: Uint8Array;
}

/** Wraps an item data key under the keyring's current epoch. */
export function wrapDek(ring: Keyring, itemId: string, dek: Uint8Array): WrappedDek {
  return { keyEpoch: ring.current, dek: seal(epochKey(ring, ring.current), dek, itemAad(itemId, 'dek')) };
}

export function unwrapDek(ring: Keyring, itemId: string, wrapped: WrappedDek): Uint8Array {
  return open(epochKey(ring, wrapped.keyEpoch), wrapped.dek, itemAad(itemId, 'dek'));
}

/** Encrypts a padded item field (body, thumbnail or recognized text bytes) with the item's DEK. */
export function sealPart(dek: Uint8Array, itemId: string, part: DataPart, data: Uint8Array): Uint8Array {
  return seal(dek, pad(data), itemAad(itemId, part));
}

export function openPart(dek: Uint8Array, itemId: string, part: DataPart, box: Uint8Array): Uint8Array {
  return unpad(open(dek, box, itemAad(itemId, part)));
}

/** One chunk of a large body. Its position and the chunk count are bound in, so chunks cannot be reordered, dropped or added. */
export function sealChunk(dek: Uint8Array, itemId: string, index: number, count: number, data: Uint8Array): Uint8Array {
  return seal(dek, pad(data), itemAad(itemId, `body/${index}/${count}`));
}

export function openChunk(dek: Uint8Array, itemId: string, index: number, count: number, box: Uint8Array): Uint8Array {
  return unpad(open(dek, box, itemAad(itemId, `body/${index}/${count}`)));
}

export function sealMeta(dek: Uint8Array, itemId: string, meta: ItemMeta): Uint8Array {
  return seal(dek, pad(utf8(JSON.stringify(ItemMeta.parse(meta)))), itemAad(itemId, 'meta'));
}

/** Decrypted metadata is still untrusted input (another device wrote it), so it is validated. */
export function openMeta(dek: Uint8Array, itemId: string, box: Uint8Array): ItemMeta {
  const bytes = unpad(open(dek, box, itemAad(itemId, 'meta')));
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new CryptoError('item metadata is not valid JSON');
  }
  const parsed = ItemMeta.safeParse(json);
  if (!parsed.success) throw new CryptoError('item metadata failed validation');
  return parsed.data;
}
