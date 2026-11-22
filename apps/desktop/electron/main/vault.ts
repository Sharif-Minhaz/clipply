import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  createKeyring, fromB64, generateDeviceKeys, parseKeyring, serializeKeyring, toB64,
  type DeviceKeyPairs, type Keyring,
} from '@clipply/crypto';

/** The subset of Electron's async safeStorage this module needs (injected so it is testable). */
export interface SecretStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend(): string;
  encryptStringAsync(plain: string): Promise<Buffer>;
  decryptStringAsync(sealed: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface LocalVault {
  deviceId: string;
  keyring: Keyring;
  deviceKeys: DeviceKeyPairs;
}

export type VaultState =
  | { status: 'ready'; vault: LocalVault; created: boolean }
  /** No OS keyring: storing keys would mean a hard-coded password, so Clipply refuses. */
  | { status: 'no_keyring'; backend: string }
  /** Vault file missing or unreadable while encrypted history exists. Never silently replaced. */
  | { status: 'error'; reason: 'missing' | 'unreadable' };

const VaultFile = z.object({
  v: z.literal(1),
  deviceId: z.uuid(),
  keyring: z.string(),
  box: z.object({ pk: z.string(), sk: z.string() }),
  sign: z.object({ pk: z.string(), sk: z.string() }),
});

function serialize(v: LocalVault): string {
  return JSON.stringify({
    v: 1,
    deviceId: v.deviceId,
    keyring: toB64(serializeKeyring(v.keyring)),
    box: { pk: toB64(v.deviceKeys.box.publicKey), sk: toB64(v.deviceKeys.box.privateKey) },
    sign: { pk: toB64(v.deviceKeys.sign.publicKey), sk: toB64(v.deviceKeys.sign.privateKey) },
  });
}

function deserialize(json: string): LocalVault {
  const f = VaultFile.parse(JSON.parse(json));
  return {
    deviceId: f.deviceId,
    keyring: parseKeyring(fromB64(f.keyring)),
    deviceKeys: {
      box: { publicKey: fromB64(f.box.pk), privateKey: fromB64(f.box.sk) },
      sign: { publicKey: fromB64(f.sign.pk), privateKey: fromB64(f.sign.sk) },
    },
  };
}

/** Writes via rename so a crash never leaves a half-written vault; 0600 like any key file. */
export async function writeVault(storage: SecretStorage, path: string, vault: LocalVault): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, await storage.encryptStringAsync(serialize(vault)), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Opens the local vault (keyring + device keys), sealed by the OS keyring via safeStorage.
 * Creates one on first run. `hasEncryptedData` stops a lost vault from being replaced by a new
 * one, which would orphan the existing history.
 */
export async function openVault(storage: SecretStorage, path: string, hasEncryptedData: boolean, newId: () => string): Promise<VaultState> {
  const available = await storage.isAsyncEncryptionAvailable();
  const backend = storage.getSelectedStorageBackend();
  if (!available || backend === 'basic_text' || backend === 'unknown') {
    return { status: 'no_keyring', backend };
  }
  if (!existsSync(path)) {
    if (hasEncryptedData) return { status: 'error', reason: 'missing' };
    const vault: LocalVault = { deviceId: newId(), keyring: createKeyring(), deviceKeys: generateDeviceKeys() };
    await writeVault(storage, path, vault);
    return { status: 'ready', vault, created: true };
  }
  let vault: LocalVault;
  let reseal: boolean;
  try {
    const { result, shouldReEncrypt } = await storage.decryptStringAsync(readFileSync(path));
    vault = deserialize(result);
    reseal = shouldReEncrypt;
  } catch {
    return { status: 'error', reason: 'unreadable' };
  }
  // The OS rotated its key; re-seal so the file keeps opening after the old key is gone.
  if (reseal) await writeVault(storage, path, vault);
  return { status: 'ready', vault, created: false };
}
