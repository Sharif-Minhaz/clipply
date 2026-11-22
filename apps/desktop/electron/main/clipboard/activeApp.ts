import { execFile } from 'node:child_process';

const xprop = (args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile('xprop', args, { timeout: 500 }, (error, out) => resolve(error ? null : out)));

/** `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007` → `0x3a00007`; 0x0 (a native Wayland window has focus) → null. */
export function parseActiveWindow(out: string): string | null {
  const id = /window id # (0x[0-9a-f]+)/i.exec(out)?.[1];
  return id && Number.parseInt(id, 16) !== 0 ? id : null;
}

/** `WM_CLASS(STRING) = "keepassxc", "KeePassXC"` → `['keepassxc']` (lower-cased, deduplicated). */
export function parseWmClass(out: string): string[] {
  const value = /WM_CLASS\(STRING\) = (.*)/.exec(out)?.[1] ?? '';
  return [...new Set([...value.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.toLowerCase()).filter(Boolean))];
}

/**
 * Window classes of the focused X11/XWayland window, via `xprop` (x11-utils). null when unknown:
 * no xprop, or a native Wayland window has focus (GNOME does not expose those to X clients).
 */
export async function activeAppClasses(): Promise<string[] | null> {
  const root = await xprop(['-root', '_NET_ACTIVE_WINDOW']);
  const id = root && parseActiveWindow(root);
  if (!id) return null;
  const cls = await xprop(['-id', id, 'WM_CLASS']);
  return cls ? parseWmClass(cls) : null;
}
