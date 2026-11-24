import { z } from 'zod';

import { B64, Id, KeyEpoch, Millis, Rev, Seq } from './primitives';

/** Inline body cap (base64url chars, ~48 KB ciphertext). With MAX_PUSH_OPS it keeps a push under Vercel's 4.5 MB body limit. */
export const INLINE_BODY_MAX = 65_536;
/** Thumbnail budget on capture: once padded, encrypted and base64-encoded it stays under INLINE_BODY_MAX. */
export const MAX_THUMB_BYTES = 40 * 1024;

export const ClipKind = z.enum(['text', 'url', 'html', 'code', 'image', 'file']);
export type ClipKind = z.infer<typeof ClipKind>;

/**
 * Plaintext item metadata. Exists only on clients; on the wire and in every database it is the
 * `meta` ciphertext of an EncryptedItem. Flags live here so the server never learns them.
 */
export const ItemMeta = z.object({
  kind: ClipKind,
  mime: z.string().min(1).max(255),
  title: z.string().max(200).optional(),
  /** Client clock, display only. Ordering always uses the server `seq`. */
  createdAt: Millis,
  editedAt: Millis.optional(),
  originDeviceId: Id,
  /** Plaintext byte size of the body. */
  size: z.number().int().nonnegative(),
  /** Keyed BLAKE2b-256 of the normalized content (hex); duplicate detection, never sent in clear. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  favorite: z.boolean(),
  pinned: z.boolean(),
  file: z.object({ name: z.string().max(255) }).optional(),
  /** Start of the text recognized in an image ('' = none found), trimmed to fit the meta budget; all of it is `EncryptedItem.ocr`. */
  ocr: z.string().max(1500).optional(),
});
export type ItemMeta = z.infer<typeof ItemMeta>;

/** Cloudinary free plan rejects raw uploads above 10 MB. */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
/** Largest plaintext body whose padded ciphertext still fits one Cloudinary raw upload. Larger images and files are split into chunks. */
export const MAX_CONTENT_BYTES = MAX_BLOB_BYTES - 65_536 - 64;
/** Plaintext bytes per chunk of a large image or file. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Largest image or file Clipply keeps. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES);
/** Encrypted recognized text (base64url chars); see sync-engine's MAX_OCR_BYTES. */
export const OCR_MAX = 40_000;

/** Optional server abilities, announced in SyncHead so a client never sends what an older server would drop. */
export const SERVER_FEATURES = ['chunks', 'ocr'] as const;
export type ServerFeature = (typeof SERVER_FEATURES)[number];

/** Encrypted body stored as a private Cloudinary raw asset instead of inline. */
export const BlobRef = z.object({
  /** Cloudinary public_id, assigned by the server when it signs the upload. */
  key: z.string().min(1).max(200),
  /** Ciphertext byte size. */
  size: z.number().int().positive().max(MAX_BLOB_BYTES),
});
export type BlobRef = z.infer<typeof BlobRef>;

/** What a client uploads. Every binary field is `nonce || ciphertext+tag`. */
export const EncryptedItem = z
  .object({
    id: Id,
    encVersion: z.literal(1),
    keyEpoch: KeyEpoch,
    /** Per-item data key, wrapped with the vault key of `keyEpoch`. */
    dek: B64.max(128),
    meta: B64.max(4096),
    /** Inline body for small content. */
    body: B64.max(INLINE_BODY_MAX).optional(),
    /** Remote body for large content (images, files). */
    blob: BlobRef.optional(),
    /**
     * Every chunk of a body too large for one blob, in order. `blob` repeats the first one, so apps from
     * before chunks still accept the item (they cannot open its body).
     */
    chunks: z.array(BlobRef).min(2).max(MAX_CHUNKS).optional(),
    /** Encrypted thumbnail made on the capturing device; the storage host never sees an image. */
    thumb: B64.max(INLINE_BODY_MAX).optional(),
    /** All text recognized in an image, encrypted like the body. */
    ocr: B64.max(OCR_MAX).optional(),
  })
  .refine((i) => (i.body === undefined) !== (i.blob === undefined), {
    message: 'exactly one of body or blob is required',
  })
  // Keeps one op at most ~one inline payload, so MAX_PUSH_OPS still fits Vercel's body limit.
  .refine((i) => i.thumb === undefined || i.blob !== undefined, {
    message: 'thumb is only allowed with blob',
  })
  .refine((i) => i.chunks === undefined || (i.blob !== undefined && i.chunks[0]?.key === i.blob.key && new Set(i.chunks.map((c) => c.key)).size === i.chunks.length), {
    message: 'chunks must start with blob and be distinct',
  });
export type EncryptedItem = z.infer<typeof EncryptedItem>;

const ServerFields = { rev: Rev, seq: Seq, updatedAt: Millis };

/** An item as the server returns it in a pull. Tombstones keep only what sync needs. */
export const ServerItem = z.discriminatedUnion('deleted', [
  z.object({ ...ServerFields, deleted: z.literal(false), item: EncryptedItem }),
  z.object({ ...ServerFields, deleted: z.literal(true), id: Id }),
]);
export type ServerItem = z.infer<typeof ServerItem>;
