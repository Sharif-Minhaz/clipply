import { readFile, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { MIN_PASSPHRASE_LENGTH } from '@clipply/crypto';
import { ClipKind } from '@clipply/shared-schemas';
import { DeviceName } from '@clipply/shared-schemas';
import { exportBackup, importBackup, MAX_CAPTURE_BYTES, type AccountController, type ClipLibrary, type UpdateChecker } from '@clipply/sync-engine';
import type { Logger } from '@clipply/logger';

import { CH, type DesktopStatus } from '../shared/api';
import type { DesktopCore } from './core';
import { SettingsPatch } from './settings';

/** Structural subset of ipcMain so the guard logic is testable. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: { senderFrame: { url: string } | null }, ...args: unknown[]) => unknown): void;
}

const Id = z.uuid();
const Filter = z.object({
  kinds: z.array(ClipKind).max(6).optional(),
  pinned: z.boolean().optional(),
  favorite: z.boolean().optional(),
  query: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
}).strict();
const Flags = z.object({ pinned: z.boolean(), favorite: z.boolean(), title: z.string().max(200) }).partial().strict();
const Text = z.string().max(MAX_CAPTURE_BYTES);
const Upload = {
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  data: z.instanceof(Uint8Array).refine((b) => b.length > 0 && b.length <= MAX_CAPTURE_BYTES, 'empty or too large'),
};
const ManualInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: Text.min(1) }).strict(),
  z.object({ type: z.literal('image'), ...Upload }).strict(),
  z.object({ type: z.literal('file'), ...Upload }).strict(),
]);
const Passphrase = z.string().min(MIN_PASSPHRASE_LENGTH).max(1024);
const MAX_BACKUP_BYTES = 1024 ** 3;

export interface IpcDeps {
  ipcMain: IpcMainLike;
  /** Only frames whose URL starts with this may call anything. */
  allowedOrigin: string;
  core: () => DesktopCore | null;
  library: () => ClipLibrary | null;
  status: () => Promise<DesktopStatus>;
  installShortcut: () => Promise<void>;
  resetVault: () => Promise<void>;
  account: () => AccountController | null;
  updates: UpdateChecker;
  /** Opens the URL of the current update state in the system browser. */
  openReleasePage: () => Promise<void>;
  /** Native save/open dialog for backup files; null when cancelled. */
  chooseBackupFile: (mode: 'save' | 'open') => Promise<string | null>;
  log: Logger;
}

/**
 * Every channel validates its sender and arguments. Errors reach the renderer as a generic
 * message plus the error name — never content.
 */
export function registerIpc(d: IpcDeps): void {
  const handle = <A extends z.ZodTuple>(channel: string, args: A, fn: (...a: z.infer<A>) => unknown): void => {
    d.ipcMain.handle(channel, async (event, ...raw) => {
      const url = event.senderFrame?.url ?? '';
      if (!url.startsWith(d.allowedOrigin)) {
        d.log.warn('rejected IPC from untrusted frame', { channel });
        throw new Error('untrusted sender');
      }
      const parsed = args.safeParse(raw);
      if (!parsed.success) throw new Error(`invalid arguments for ${channel}`);
      try {
        return await fn(...(parsed.data as z.infer<A>));
      } catch (error) {
        d.log.warn('IPC handler failed', { channel, error });
        throw new Error(error instanceof Error ? `${error.name}: ${error.message}` : 'failed');
      }
    });
  };
  const lib = (): ClipLibrary => {
    const l = d.library();
    if (!l) throw new Error('vault is not open');
    return l;
  };
  const core = (): DesktopCore => {
    const c = d.core();
    if (!c) throw new Error('vault is not open');
    return c;
  };

  handle(CH.list, z.tuple([Filter]), (f) => lib().list(f));
  handle(CH.thumb, z.tuple([Id]), (id) => lib().readThumb(id));
  handle(CH.body, z.tuple([Id]), (id) => lib().readBody(id));
  handle(CH.copy, z.tuple([Id]), (id) => core().copy(id));
  handle(CH.saveFile, z.tuple([Id]), (id) => core().saveFile(id));
  handle(CH.openUrl, z.tuple([Id]), (id) => core().openUrl(id));
  handle(CH.linkPreview, z.tuple([Id]), (id) => core().linkPreview(id));
  handle(CH.flags, z.tuple([Id, Flags]), (id, flags) => lib().setFlags(id, flags));
  handle(CH.edit, z.tuple([Id, Text]), (id, text) => lib().editText(id, text));
  handle(CH.add, z.tuple([ManualInput]), (input) => core().add(input));
  handle(CH.remove, z.tuple([z.array(Id).min(1).max(1000)]), (ids) => lib().remove(ids));
  handle(CH.clear, z.tuple([z.array(ClipKind).max(6).optional()]), (kinds) => lib().clear(kinds));
  handle(CH.storage, z.tuple([]), () => lib().stats());
  handle(CH.exportBackup, z.tuple([Passphrase]), async (passphrase) => {
    const path = await d.chooseBackupFile('save');
    if (!path) return null;
    const { data, count, skipped } = await exportBackup(lib(), passphrase);
    await writeFile(path, data, { mode: 0o600 });
    return { count, skipped };
  });
  handle(CH.importBackup, z.tuple([Passphrase]), async (passphrase) => {
    const path = await d.chooseBackupFile('open');
    if (!path) return null;
    if ((await stat(path)).size > MAX_BACKUP_BYTES) throw new Error('file is too large to be a Clipply backup');
    return importBackup(lib(), new Uint8Array(await readFile(path)), passphrase);
  });
  handle(CH.status, z.tuple([]), () => d.status());
  handle(CH.settings, z.tuple([]), () => core().settings);
  handle(CH.updateSettings, z.tuple([SettingsPatch]), (patch) => core().updateSettings(patch));
  handle(CH.installShortcut, z.tuple([]), () => d.installShortcut());
  handle(CH.resetVault, z.tuple([]), () => d.resetVault());
  handle(CH.updateState, z.tuple([]), () => d.updates.state());
  handle(CH.updateCheck, z.tuple([]), () => d.updates.check({ force: true }));
  handle(CH.updateOpen, z.tuple([]), () => d.openReleasePage());

  const acct = (): AccountController => {
    const a = d.account();
    if (!a) throw new Error('vault is not open');
    return a;
  };
  handle(CH.accountStatus, z.tuple([]), () => acct().getStatus());
  handle(CH.signIn, z.tuple([]), () => acct().signIn());
  handle(CH.signOut, z.tuple([]), () => acct().signOut());
  handle(CH.syncNow, z.tuple([]), () => acct().sync());
  handle(CH.enrollment, z.tuple([]), () => acct().enrollment());
  handle(CH.acceptEnrollment, z.tuple([]), () => acct().acceptEnrollment());
  handle(CH.recover, z.tuple([z.string().min(40).max(120)]), (key) => acct().recover(key));
  handle(CH.devices, z.tuple([]), () => acct().devices());
  handle(CH.startApproval, z.tuple([Id]), (id) => acct().startApproval(id));
  handle(CH.approvalCode, z.tuple([Id]), (id) => acct().approvalCode(id));
  handle(CH.confirmApproval, z.tuple([Id]), (id) => acct().confirmApproval(id));
  handle(CH.revoke, z.tuple([Id]), (id) => acct().revoke(id));
  handle(CH.rename, z.tuple([Id, DeviceName]), (id, name) => acct().rename(id, name));
  handle(CH.replaceRecoveryKey, z.tuple([]), () => acct().replaceRecoveryKey());
  handle(CH.setSyncPaused, z.tuple([z.boolean()]), (paused) => acct().setSyncPaused(paused));
}
