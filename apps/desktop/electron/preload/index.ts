import { contextBridge, ipcRenderer } from 'electron';

import { CH, type DesktopApi } from '../shared/api';

const on = (channel: string) => (cb: () => void): (() => void) => {
  const listener = (): void => cb();
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

/** The renderer's only door to the main process: fixed channels, no raw ipcRenderer. */
const api: DesktopApi = {
  list: (f) => ipcRenderer.invoke(CH.list, f),
  readThumb: (id) => ipcRenderer.invoke(CH.thumb, id),
  readBody: (id) => ipcRenderer.invoke(CH.body, id),
  copy: (id) => ipcRenderer.invoke(CH.copy, id),
  copyText: (text) => ipcRenderer.invoke(CH.copyText, text),
  recognizeText: (id) => ipcRenderer.invoke(CH.recognize, id),
  saveFile: (id) => ipcRenderer.invoke(CH.saveFile, id),
  openUrl: (id) => ipcRenderer.invoke(CH.openUrl, id),
  linkPreview: (id) => ipcRenderer.invoke(CH.linkPreview, id),
  setFlags: (id, flags) => ipcRenderer.invoke(CH.flags, id, flags),
  editText: (id, text) => ipcRenderer.invoke(CH.edit, id, text),
  add: (input) => ipcRenderer.invoke(CH.add, input),
  remove: (ids) => ipcRenderer.invoke(CH.remove, [...ids]),
  clear: (kinds) => ipcRenderer.invoke(CH.clear, kinds ? [...kinds] : undefined),
  storage: () => ipcRenderer.invoke(CH.storage),
  exportBackup: (passphrase) => ipcRenderer.invoke(CH.exportBackup, passphrase),
  importBackup: (passphrase) => ipcRenderer.invoke(CH.importBackup, passphrase),
  onChanged: on(CH.changed),
  getStatus: () => ipcRenderer.invoke(CH.status),
  onStatus: on(CH.statusChanged),
  getSettings: () => ipcRenderer.invoke(CH.settings),
  updateSettings: (patch) => ipcRenderer.invoke(CH.updateSettings, patch),
  installGnomeShortcut: () => ipcRenderer.invoke(CH.installShortcut),
  hideWindow: () => ipcRenderer.invoke(CH.hideWindow),
  resetVault: () => ipcRenderer.invoke(CH.resetVault),
  updates: {
    state: () => ipcRenderer.invoke(CH.updateState),
    check: () => ipcRenderer.invoke(CH.updateCheck),
    openReleasePage: () => ipcRenderer.invoke(CH.updateOpen),
    install: async (onProgress) => {
      const listener = (_e: unknown, percent: number): void => onProgress?.(percent);
      ipcRenderer.on(CH.updateProgress, listener);
      try {
        await ipcRenderer.invoke(CH.updateInstall);
      } finally {
        ipcRenderer.removeListener(CH.updateProgress, listener);
      }
    },
    onChange: on(CH.updateChanged),
  },
  account: {
    status: () => ipcRenderer.invoke(CH.accountStatus),
    onStatus: on(CH.accountChanged),
    signIn: () => ipcRenderer.invoke(CH.signIn),
    signOut: () => ipcRenderer.invoke(CH.signOut),
    syncNow: () => ipcRenderer.invoke(CH.syncNow),
    enrollment: () => ipcRenderer.invoke(CH.enrollment),
    acceptEnrollment: () => ipcRenderer.invoke(CH.acceptEnrollment),
    recover: (key) => ipcRenderer.invoke(CH.recover, key),
    devices: () => ipcRenderer.invoke(CH.devices),
    startApproval: (id) => ipcRenderer.invoke(CH.startApproval, id),
    approvalCode: (id) => ipcRenderer.invoke(CH.approvalCode, id),
    pairingQr: () => ipcRenderer.invoke(CH.pairingQr),
    checkPairing: () => ipcRenderer.invoke(CH.checkPairing),
    confirmApproval: (id) => ipcRenderer.invoke(CH.confirmApproval, id),
    revoke: (id) => ipcRenderer.invoke(CH.revoke, id),
    rename: (id, name) => ipcRenderer.invoke(CH.rename, id, name),
    replaceRecoveryKey: () => ipcRenderer.invoke(CH.replaceRecoveryKey),
    setSyncPaused: (paused) => ipcRenderer.invoke(CH.setSyncPaused, paused),
  },
};

contextBridge.exposeInMainWorld('clipply', api);
