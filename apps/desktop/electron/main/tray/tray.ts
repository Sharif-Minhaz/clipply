import { Menu, Tray, nativeImage } from 'electron';

export interface TrayActions {
  icon: string;
  isMonitoring: () => boolean;
  toggleWindow: () => void;
  showWindow: () => void;
  setMonitoring: (on: boolean) => void;
  quit: () => void;
}

/**
 * Ubuntu ships the AppIndicator extension, so a tray icon shows; vanilla GNOME has no tray and
 * the app stays reachable via the launcher and the `--toggle` shortcut.
 */
export function createTray(a: TrayActions): { refresh(): void; destroy(): void } {
  const tray = new Tray(nativeImage.createFromPath(a.icon).resize({ width: 22, height: 22 }));
  tray.setToolTip('Clipply');
  const refresh = (): void => {
    const on = a.isMonitoring();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Clipply', click: a.showWindow },
        { label: on ? 'Pause monitoring' : 'Resume monitoring', click: () => a.setMonitoring(!on) },
        { type: 'separator' },
        { label: 'Quit', click: a.quit },
      ]),
    );
  };
  tray.on('click', a.toggleWindow);
  refresh();
  return { refresh, destroy: () => tray.destroy() };
}
