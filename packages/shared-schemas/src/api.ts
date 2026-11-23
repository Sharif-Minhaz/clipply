import { z } from 'zod';

import { Device, DeviceKeys, DeviceName, KeyEnvelope, RecoveryEnvelope, RegisterDeviceRequest } from './device';
import { MAX_BLOB_BYTES } from './item';
import { Id, Key32, KeyEpoch, Millis, Signature } from './primitives';

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

export const MAX_PENDING_SHOWN = 10;

export const VaultStateResponse = z.object({
  initialized: z.boolean(),
  epoch: z.number().int().min(1),
  /** Bumped on every envelope change, so devices know when to re-fetch theirs. */
  version: z.number().int().nonnegative(),
  /** Devices waiting for approval, so connected devices can ask the user (defaults for older servers). */
  pendingDevices: z.array(z.object({ id: Id, name: DeviceName })).max(MAX_PENDING_SHOWN).default([]),
});
export type VaultStateResponse = z.infer<typeof VaultStateResponse>;

export const InitVaultRequest = z.object({ envelope: KeyEnvelope, recovery: RecoveryEnvelope });
export type InitVaultRequest = z.infer<typeof InitVaultRequest>;

const DevicePublic = z.object({ id: Id, name: DeviceName, keys: DeviceKeys });

export const EnvelopeResponse = z.object({ envelope: KeyEnvelope, signer: DevicePublic });
export type EnvelopeResponse = z.infer<typeof EnvelopeResponse>;

/** Page size of GET /vault/envelope-history; a full page means there may be more. */
export const ENVELOPE_HISTORY_PAGE = 100;

/**
 * The caller's past envelopes after vault version `since`, oldest first. A device that missed several
 * roster changes replays them, so each signer is vouched for by the roster before it.
 */
export const EnvelopeHistoryResponse = z.object({
  envelopes: z.array(z.object({ version: z.number().int().min(1), envelope: KeyEnvelope })).max(ENVELOPE_HISTORY_PAGE),
});
export type EnvelopeHistoryResponse = z.infer<typeof EnvelopeHistoryResponse>;

/** For a pending device: which authorized device claimed it (shown with the enrollment code). */
export const EnrollmentResponse = z.object({
  approver: DevicePublic.nullable(),
  /** Set when the approver scanned this device's pairing QR (docs/encryption.md §5). */
  proof: Key32.optional(),
});
export type EnrollmentResponse = z.infer<typeof EnrollmentResponse>;

/** Claim of a pending device; `proof` when the claimer scanned that device's pairing QR. */
export const ClaimDeviceRequest = z.object({ proof: Key32.optional() });
export type ClaimDeviceRequest = z.infer<typeof ClaimDeviceRequest>;

/** A pending device that scanned an authorized device's pairing QR asks it to approve. */
export const PairDeviceRequest = z.object({ approverId: Id, proof: Key32 });
export type PairDeviceRequest = z.infer<typeof PairDeviceRequest>;

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
