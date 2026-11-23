import electronUpdater from 'electron-updater';
import type { Logger } from '@clipply/logger';

/**
 * Downloads the newest GitHub release (files listed in its latest-linux.yml, SHA-512 checked) and
 * restarts into it. The AppImage replaces its own file; the deb is installed with dpkg through
 * pkexec, so the system asks for the admin password. Resolves just before the app quits.
 * `onProgress` gets the download percentage (0–100).
 */
export async function installUpdate(log: Logger, onProgress: (percent: number) => void): Promise<void> {
  const { autoUpdater } = electronUpdater;
  if (!autoUpdater.isUpdaterActive()) throw new Error('This copy of Clipply cannot update itself. Download the new version from the release page.');
  autoUpdater.autoDownload = false;
  autoUpdater.logger = { info: (m) => log.info(String(m)), warn: (m) => log.warn(String(m)), error: (m) => log.error(String(m)), debug: (m) => log.debug(String(m)) };
  // Install failures (e.g. the password prompt was cancelled) arrive only as 'error' events.
  let failure: Error | undefined;
  const onError = (e: Error): void => void (failure ??= e);
  const onDownload = (p: { percent: number }): void => onProgress(p.percent);
  autoUpdater.on('error', onError);
  autoUpdater.on('download-progress', onDownload);
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) throw new Error('Clipply is up to date.');
    await autoUpdater.downloadUpdate();
    autoUpdater.quitAndInstall(true, true);
  } finally {
    autoUpdater.off('error', onError);
    autoUpdater.off('download-progress', onDownload);
  }
  if (failure) throw failure;
}
