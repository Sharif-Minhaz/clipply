import { z } from 'zod';

import { Device, DeviceKeys, DeviceName, KeyEnvelope, RecoveryEnvelope, RegisterDeviceRequest } from './device';
import { MAX_BLOB_BYTES } from './item';
import { Id, KeyEpoch, Millis, Signature } from './primitives';

// ── auth ────────────────────────────────────────────────────────────────────────────────────

/** Google identifies the account only; it never grants vault access (docs/encryption.md §5). */
export const GoogleSignInRequest = z.object({
  idToken: z.string().min(20).max(4096),
  device: RegisterDeviceRequest,
});
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequest>;

export const RefreshToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const AuthResponse = z.object({
  accessToken: z.string(),
  accessExpiresAt: Millis,
  refreshToken: RefreshToken,
  user: z.object({ id: Id, email: z.email() }),
  device: Device,
});
export type AuthResponse = z.infer<typeof AuthResponse>;

export const RefreshRequest = z.object({ refreshToken: RefreshToken });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

// ── devices ─────────────────────────────────────────────────────────────────────────────────

export const DeviceList = z.object({ devices: z.array(Device) });
export const RenameDeviceRequest = z.object({ name: DeviceName });

// ── storage (Cloudinary private raw assets holding ciphertext) ──────────────────────────────

export const UploadSignatureRequest = z.object({
  itemId: Id,
  size: z.number().int().positive().max(MAX_BLOB_BYTES),
});
export type UploadSignatureRequest = z.infer<typeof UploadSignatureRequest>;

/** Multipart fields to POST, together with the ciphertext as `file`, straight to `uploadUrl`. */
export const UploadSignatureResponse = z.object({
  uploadUrl: z.url(),
  key: z.string(),
  fields: z.record(z.string(), z.string()),
});
export type UploadSignatureResponse = z.infer<typeof UploadSignatureResponse>;

export const ConfirmUploadRequest = z.object({
  key: z.string().min(1).max(200),
  /** Cloudinary's upload response; its signature proves Cloudinary stored this public_id. */
  upload: z.object({
    public_id: z.string(),
    version: z.number().int().nonnegative(),
    signature: z.string().regex(/^[0-9a-f]{40}$/),
    bytes: z.number().int().positive().max(MAX_BLOB_BYTES),
  }),
});
export type ConfirmUploadRequest = z.infer<typeof ConfirmUploadRequest>;

export const DownloadUrlResponse = z.object({ url: z.url(), expiresAt: Millis });
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponse>;

export const ApiErrorBody = z.object({ error: z.string() });

// ── vault (key distribution; the server only stores sealed, signed envelopes) ───────────────

export const VaultStateResponse = z.object({
  initialized: z.boolean(),
  epoch: z.number().int().min(1),
  /** Bumped on every envelope change, so devices know when to re-fetch theirs. */
  version: z.number().int().nonnegative(),
});
export type VaultStateResponse = z.infer<typeof VaultStateResponse>;

export const InitVaultRequest = z.object({ envelope: KeyEnvelope, recovery: RecoveryEnvelope });
export type InitVaultRequest = z.infer<typeof InitVaultRequest>;

const DevicePublic = z.object({ id: Id, name: DeviceName, keys: DeviceKeys });

export const EnvelopeResponse = z.object({ envelope: KeyEnvelope, signer: DevicePublic });
export type EnvelopeResponse = z.infer<typeof EnvelopeResponse>;

/** For a pending device: which authorized device claimed it (shown with the enrollment code). */
export const EnrollmentResponse = z.object({ approver: DevicePublic.nullable() });
export type EnrollmentResponse = z.infer<typeof EnrollmentResponse>;

export const PublishEnvelopesRequest = z.object({
  epoch: KeyEpoch,
  envelopes: z.array(KeyEnvelope).min(1).max(64),
  /** Required when `epoch` is a new (rotated) epoch. */
  recovery: RecoveryEnvelope.optional(),
  /** A pending device this caller claimed and now enrolls. */
  authorize: Id.optional(),
});
export type PublishEnvelopesRequest = z.infer<typeof PublishEnvelopesRequest>;

export const RecoverRequest = z.object({ timestamp: Millis, signature: Signature });
export type RecoverRequest = z.infer<typeof RecoverRequest>;

export const RecoverResponse = z.object({ recovery: RecoveryEnvelope });
export type RecoverResponse = z.infer<typeof RecoverResponse>;
