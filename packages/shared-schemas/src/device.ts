import { z } from 'zod';

import { B64, Id, Key32, KeyEpoch, Millis, Signature } from './primitives';

export const DevicePlatform = z.enum(['ubuntu', 'android']);
export type DevicePlatform = z.infer<typeof DevicePlatform>;
export const DeviceStatus = z.enum(['pending', 'authorized', 'revoked']);

/** Public halves of the device's keys; private halves never leave OS-protected storage. */
export const DeviceKeys = z.object({
  /** X25519, receives sealed vault keyrings. */
  boxPublicKey: Key32,
  /** Ed25519, signs keyrings it hands to other devices. */
  signPublicKey: Key32,
});

export const DeviceName = z.string().trim().min(1).max(64);

export const RegisterDeviceRequest = z.object({
  id: Id,
  name: DeviceName,
  platform: DevicePlatform,
  appVersion: z.string().max(32),
  keys: DeviceKeys,
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

export const Device = RegisterDeviceRequest.extend({
  status: DeviceStatus,
  createdAt: Millis,
  lastSeenAt: Millis,
  lastSyncAt: Millis.optional(),
  /** A waiting device that scanned the caller's pairing QR: its proof, for the caller only. */
  pairingProof: Key32.optional(),
});
export type Device = z.infer<typeof Device>;

/**
 * The full vault keyring (every epoch key) sealed to one device's box key and signed by the
 * authorized device that produced it. The signature covers `deviceId || epoch || sealed`.
 */
export const KeyEnvelope = z.object({
  deviceId: Id,
  epoch: KeyEpoch,
  sealed: B64.max(16_384),
  signerDeviceId: Id,
  signature: Signature,
});
export type KeyEnvelope = z.infer<typeof KeyEnvelope>;

/** The keyring sealed to the X25519 public key derived from the user's recovery key. */
export const RecoveryEnvelope = z.object({
  epoch: KeyEpoch,
  sealed: B64.max(16_384),
  boxPublicKey: Key32,
  /** Ed25519 key derived from the recovery key; proves recovery-based enrollment to the server. */
  signPublicKey: Key32,
});
export type RecoveryEnvelope = z.infer<typeof RecoveryEnvelope>;
