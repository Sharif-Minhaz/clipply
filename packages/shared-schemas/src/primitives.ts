import { z } from 'zod';

/** Unpadded base64url, the only binary encoding on the wire. */
export const B64 = z.string().regex(/^[A-Za-z0-9_-]*$/, 'expected unpadded base64url');

/** A 32-byte key (X25519 / Ed25519 public key) as unpadded base64url. */
export const Key32 = B64.length(43);

/** Ed25519 signature (64 bytes) as unpadded base64url. */
export const Signature = B64.length(86);

/** Client-generated UUID (v7 for items so ids sort by creation). */
export const Id = z.uuid();

export const Millis = z.number().int().nonnegative();

/** Server-assigned, per-user, strictly increasing change number. Sync cursors are these. */
export const Seq = z.number().int().nonnegative();

/** Server-assigned per-item revision, incremented on every accepted write. */
export const Rev = z.number().int().nonnegative();

/** Vault key generation; bumped on every key rotation (device revocation). */
export const KeyEpoch = z.number().int().min(1);
