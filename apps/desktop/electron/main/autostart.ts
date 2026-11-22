import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Electron's setLoginItemSettings is a no-op on Linux; XDG autostart is the standard. */
export const autostartPath = (home = homedir()): string => join(home, '.config', 'autostart', 'clipply.desktop');

const quote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, '\\$1')}"`);

export function autostartEntry(command: readonly string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Clipply',
    'Comment=Encrypted clipboard history',
    `Exec=${command.map(quote).join(' ')} --hidden`,
    'Icon=clipply',
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=true',
    '',
  ].join('\n');
}

export function setAutostart(enabled: boolean, command: readonly string[], home = homedir()): void {
  const path = autostartPath(home);
  if (!enabled) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(home, '.config', 'autostart'), { recursive: true });
  writeFileSync(path, autostartEntry(command));
}
