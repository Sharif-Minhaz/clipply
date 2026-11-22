import { spawnSync } from 'node:child_process';
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type { Logger } from '@clipply/logger';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

/** GNOME's screenshot UI saves to `<Pictures>/Screenshots` (the folder name is localized). */
export function defaultScreenshotDir(): string {
  const res = spawnSync('xdg-user-dir', ['PICTURES'], { encoding: 'utf8', timeout: 2000 });
  const pictures = res.status === 0 && res.stdout.trim() ? res.stdout.trim() : join(homedir(), 'Pictures');
  return join(pictures, 'Screenshots');
}

export interface ScreenshotWatcherOptions {
  dir: string;
  onImage: (file: { path: string; data: Uint8Array; mime: string }) => void;
  log: Logger;
  now?: () => number;
  watch?: (dir: string, listener: (event: string, file: string | null) => void) => Pick<FSWatcher, 'close'>;
  /** Delay before checking a new file, and between size-stability checks. */
  settleMs?: number;
}

/**
 * Event-driven (inotify via fs.watch), never scans. A file is imported once its size stops
 * changing, only if it was written after the watcher started, and only once per path+mtime.
 */
export function watchScreenshots(opts: ScreenshotWatcherOptions): { close(): void } | null {
  const startedAt = (opts.now ?? Date.now)();
  if (existsSync(opts.dir)) return watchDir(opts, startedAt, false);
  // GNOME creates the folder with the first screenshot: wait for it instead of staying idle.
  const parent = dirname(opts.dir);
  if (!existsSync(parent)) {
    opts.log.info('screenshot folder not found; screenshot capture idle', { dir: opts.dir });
    return null;
  }
  let inner: { close(): void } | null = null;
  const outer = (opts.watch ?? fsWatch)(parent, (_event, file) => {
    if (inner || file !== basename(opts.dir) || !existsSync(opts.dir)) return;
    outer.close();
    // The screenshot that created the folder may already be inside it.
    inner = watchDir(opts, startedAt, true);
  });
  return {
    close() {
      outer.close();
      inner?.close();
    },
  };
}

function watchDir(opts: ScreenshotWatcherOptions, startedAt: number, scanExisting: boolean): { close(): void } {
  const settle = opts.settleMs ?? 400;
  const seen = new Set<string>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const check = async (path: string, lastSize: number, tries: number): Promise<void> => {
    pending.delete(path);
    try {
      const s = await stat(path);
      if (!s.isFile() || s.mtimeMs < startedAt - 2000) return;
      if (s.size === 0 || s.size !== lastSize) {
        if (tries < 15) pending.set(path, setTimeout(() => void check(path, s.size, tries + 1), settle));
        return;
      }
      const key = `${path}:${s.mtimeMs}`;
      if (seen.has(key)) return;
      seen.add(key);
      const ext = extname(path).toLowerCase();
      opts.onImage({ path, data: new Uint8Array(await readFile(path)), mime: ext === '.png' ? 'image/png' : 'image/jpeg' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') opts.log.warn('screenshot import failed', { error });
    }
  };

  const consider = (file: string | null): void => {
    if (!file || !IMAGE_EXT.has(extname(file).toLowerCase()) || file.startsWith('.')) return;
    const path = join(opts.dir, file);
    clearTimeout(pending.get(path));
    pending.set(path, setTimeout(() => void check(path, -1, 0), settle));
  };
  const watcher = (opts.watch ?? fsWatch)(opts.dir, (_event, file) => consider(file));
  if (scanExisting) void readdir(opts.dir).then((files) => files.forEach(consider), () => {});

  return {
    close() {
      watcher.close();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}
