import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
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

export const formatStringArray = (items: string[]): string =>
  `[${items.map((i) => `'${i.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`;

/**
 * Registers a GNOME custom shortcut that runs `<command>` (Clipply's `--toggle`). Needed on
 * GNOME Wayland, where X11 key grabs only fire while an X11 window has focus. Only runs on
 * explicit user request from Settings; it edits the user's GNOME keybindings.
 */
export async function installGnomeShortcut(command: string, binding: string, run: GSettingsRunner = runGSettings): Promise<void> {
  const list = parseStringArray(await run(['get', SCHEMA, 'custom-keybindings']));
  if (!list.includes(CLIPPLY_PATH)) {
    await run(['set', SCHEMA, 'custom-keybindings', formatStringArray([...list, CLIPPLY_PATH])]);
  }
  const key = `${SCHEMA}.custom-keybinding:${CLIPPLY_PATH}`;
  await run(['set', key, 'name', 'Clipply']);
  await run(['set', key, 'command', command]);
  await run(['set', key, 'binding', binding]);
}

export async function gnomeShortcutInstalled(run: GSettingsRunner = runGSettings): Promise<boolean> {
  try {
    return parseStringArray(await run(['get', SCHEMA, 'custom-keybindings'])).includes(CLIPPLY_PATH);
  } catch {
    return false;
  }
}
