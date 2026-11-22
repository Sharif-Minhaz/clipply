import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const SHELL = 'org.gnome.shell.keybindings';
export const GNOME_BINDING = '<Super>v';
export const CLIPPLY_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/clipply/';

export type GSettingsRunner = (args: string[]) => Promise<string>;

export const runGSettings: GSettingsRunner = async (args) => (await promisify(execFile)('gsettings', args, { timeout: 5000 })).stdout;

/** Parses a GVariant string array as printed by gsettings: `['/a/', '/b/']` or `@as []`. */
export function parseStringArray(out: string): string[] {
  const t = out.trim().replace(/^@as\s*/, '');
  if (t === '[]') return [];
  if (!t.startsWith('[') || !t.endsWith(']')) throw new Error('unexpected gsettings output');
  return [...t.slice(1, -1).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
}

/** GVariant string literal. gsettings parses every value as GVariant, so a raw command that starts with a quote fails. */
export const formatString = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const formatStringArray = (items: string[]): string => `[${items.map(formatString).join(', ')}]`;

/**
 * Registers a GNOME custom shortcut that runs `<command>` (Clipply's `--toggle`). Needed on
 * GNOME Wayland, where X11 key grabs only fire while an X11 window has focus. Only runs on
 * explicit user request from Settings; it edits the user's GNOME keybindings.
 */
export async function installGnomeShortcut(command: string, binding: string, run: GSettingsRunner = runGSettings): Promise<void> {
  // GNOME uses Super+V (and Super+M) for the notification list; the shell would win, so Clipply takes
  // Super+V and leaves Super+M for notifications.
  const tray = parseStringArray(await run(['get', SHELL, 'toggle-message-tray']));
  const freed = tray.filter((b) => b.toLowerCase() !== binding.toLowerCase());
  if (freed.length !== tray.length) await run(['set', SHELL, 'toggle-message-tray', formatStringArray(freed)]);
  const list = parseStringArray(await run(['get', SCHEMA, 'custom-keybindings']));
  if (!list.includes(CLIPPLY_PATH)) {
    await run(['set', SCHEMA, 'custom-keybindings', formatStringArray([...list, CLIPPLY_PATH])]);
  }
  const key = `${SCHEMA}.custom-keybinding:${CLIPPLY_PATH}`;
  await run(['set', key, 'name', formatString('Clipply')]);
  await run(['set', key, 'command', formatString(command)]);
  await run(['set', key, 'binding', formatString(binding)]);
}

/** True only when the entry exists with a command and the current binding (an earlier, failed or older install does not count). */
export async function gnomeShortcutInstalled(run: GSettingsRunner = runGSettings): Promise<boolean> {
  try {
    if (!parseStringArray(await run(['get', SCHEMA, 'custom-keybindings'])).includes(CLIPPLY_PATH)) return false;
    const key = `${SCHEMA}.custom-keybinding:${CLIPPLY_PATH}`;
    const [command, binding] = await Promise.all([run(['get', key, 'command']), run(['get', key, 'binding'])]);
    // Earlier builds put --ozone-platform=x11 in the command, which now starts a blurry window.
    return command.trim() !== "''" && !command.includes('--ozone-platform') && binding.trim().toLowerCase() === `'${GNOME_BINDING.toLowerCase()}'`;
  } catch {
    return false;
  }
}
