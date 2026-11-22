import type { ClipKind } from '@clipply/shared-schemas';
import type { AccountStatus, ClipView, DeviceInfo, ListFilter, StorageStats } from '@clipply/sync-engine';

import type { Settings, SettingsPatch } from '../main/settings';

/** IPC channel names; the only strings main and renderer must agree on. */
export const CH = {
  list: 'clips:list',
  thumb: 'clips:thumb',
  body: 'clips:body',
  copy: 'clips:copy',
  saveFile: 'clips:save-file',
  openUrl: 'clips:open-url',
  flags: 'clips:flags',
  edit: 'clips:edit',
  remove: 'clips:remove',
  clear: 'clips:clear',
  storage: 'clips:storage',
  exportBackup: 'clips:export-backup',
  importBackup: 'clips:import-backup',
  changed: 'clips:changed',
  status: 'app:status',
  statusChanged: 'app:status-changed',
  settings: 'app:settings',
  updateSettings: 'app:update-settings',
  installShortcut: 'app:install-shortcut',
  resetVault: 'app:reset-vault',
  accountStatus: 'account:status',
  accountChanged: 'account:changed',
  signIn: 'account:sign-in',
  signOut: 'account:sign-out',
  syncNow: 'account:sync-now',
  enrollment: 'account:enrollment',
  acceptEnrollment: 'account:accept-enrollment',
  recover: 'account:recover',
  devices: 'devices:list',
  startApproval: 'devices:start-approval',
  confirmApproval: 'devices:confirm-approval',
  revoke: 'devices:revoke',
  rename: 'devices:rename',
  replaceRecoveryKey: 'account:replace-recovery-key',
  setSyncPaused: 'account:set-sync-paused',
} as const;

export interface DesktopStatus {
  vault: 'ready' | 'no_keyring' | 'error';
  vaultError?: 'missing' | 'unreadable';
  keyringBackend: string;
  provider: string;
  /** Wayland session with Electron on XWayland, or plain X11. */
  session: 'wayland' | 'x11' | 'unknown';
  monitoring: boolean;
  screenshotDir: string | null;
  screenshotWatching: boolean;
  items: number;
  corrupt: number;
  gnomeShortcut: boolean;
  /** Accelerator registered with Electron globalShortcut, if any (works on X11 only). */
  globalShortcut: string | null;
  deviceId: string | null;
}

/** Shape of `window.clipply`, exposed by the preload script. */
export interface DesktopApi {
  list(filter: ListFilter): Promise<ClipView[]>;
  readThumb(id: string): Promise<Uint8Array | null>;
  readBody(id: string): Promise<Uint8Array>;
  copy(id: string): Promise<void>;
  saveFile(id: string): Promise<boolean>;
  openUrl(id: string): Promise<void>;
  setFlags(id: string, flags: { pinned?: boolean; favorite?: boolean; title?: string }): Promise<void>;
  editText(id: string, text: string): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  clear(kinds?: readonly ClipKind[]): Promise<number>;
  storage(): Promise<StorageStats>;
  /** null when the user cancelled the file dialog. */
  exportBackup(passphrase: string): Promise<{ count: number; skipped: number } | null>;
  importBackup(passphrase: string): Promise<{ imported: number; duplicates: number; failed: number } | null>;
  onChanged(cb: () => void): () => void;
  getStatus(): Promise<DesktopStatus>;
  onStatus(cb: () => void): () => void;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  installGnomeShortcut(): Promise<void>;
  /** Deletes local history and keys; only offered when the vault cannot be opened. */
  resetVault(): Promise<void>;
  account: {
    status(): Promise<AccountStatus>;
    onStatus(cb: () => void): () => void;
    signIn(): Promise<{ recoveryKey?: string }>;
    signOut(): Promise<void>;
    syncNow(): Promise<void>;
    enrollment(): Promise<{ approverName: string; code: string } | null>;
    acceptEnrollment(): Promise<void>;
    recover(recoveryKey: string): Promise<void>;
    devices(): Promise<DeviceInfo[]>;
    startApproval(deviceId: string): Promise<{ code: string }>;
    confirmApproval(deviceId: string): Promise<void>;
    revoke(deviceId: string): Promise<{ recoveryKey?: string }>;
    rename(deviceId: string, name: string): Promise<void>;
    replaceRecoveryKey(): Promise<{ recoveryKey: string }>;
    setSyncPaused(paused: boolean): Promise<void>;
  };
}
