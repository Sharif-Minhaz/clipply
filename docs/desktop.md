# Ubuntu desktop

Status: **Phase 0 investigation**. Nothing below is implemented; compatibility claims wait for tests.

## Environment measured (2026-11-22)

Ubuntu 24.04.5, GNOME Shell 46.0, Wayland session (`XDG_SESSION_TYPE=wayland`, XWayland on `:0`), AppIndicator extension enabled.

Probe: from a background shell (no focused window), `xclip -o -selection clipboard -t TARGETS` returned the targets of content copied in a Wayland/XWayland app. Mutter mirrors the Wayland clipboard into the XWayland selection, so **an X11 client can read the clipboard without focus on GNOME 46**. `wl-paste` also worked but steals focus with a helper surface — unsuitable for monitoring.

## Clipboard providers

`ClipboardProvider` interface (start, stop, onClipboardChanged, readCurrentClipboard) with:

1. **ElectronX11Provider** (default): Electron forced onto X11/XWayland (`--ozone-platform=x11`), polls `clipboard.availableFormats()` + content hash every 750 ms in the main process. Cost on desktop is small; it is not a battery concern like Android. Trade-off: XWayland windows may look blurry with fractional scaling.
2. **XFixesProvider** (Phase 8): event-driven selection-owner notifications instead of polling, via a tiny native helper.
3. **GnomeShellExtensionProvider** (fallback): a bundled extension listens to `Meta.Selection` `owner-changed` and forwards over session D-Bus. Needed if a future GNOME stops mirroring to XWayland, or for native-Wayland Electron.

Pure X11 sessions use provider 1 unchanged. Other compositors (KDE, wlroots) are untested and will be documented as such.

Privacy: content whose targets include `x-kde-passwordManagerHint` (KeePassXC and others) is skipped. Excluded-app support is limited: X11 exposes the selection owner window, Wayland does not.

## Screenshots

GNOME's screenshot UI saves to `$(xdg-user-dir PICTURES)/Screenshots` and copies the image to the clipboard. Watch that directory with `fs.watch` (inotify, no scanning) and capture image clipboard events. Dedupe by hashing decoded RGBA pixels (`nativeImage.toBitmap()`), because the file (PNG) and the clipboard image encode the same pixels differently. User-configurable watch/exclude directories.

## Background, tray, autostart, shortcuts

- Window close hides; app keeps running in tray (Ubuntu ships the AppIndicator extension; vanilla GNOME has no tray — the app then stays reachable through the shortcut / launcher). Single-instance lock; `clipply --toggle` from a second instance shows/hides the window.
- Start on login: `~/.config/autostart/clipply.desktop` (Electron's `setLoginItemSettings` does nothing on Linux).
- Global shortcut: Electron `globalShortcut` works on X11. On GNOME 46 Wayland, X11 key grabs only fire while an X11 window is focused and the GlobalShortcuts portal is not available (expected in GNOME 48+, verify). The app offers to register a GNOME custom keybinding (gsettings `custom-keybindings`) that runs `clipply --toggle`.

## Key storage

Electron `safeStorage` (libsecret/gnome-keyring). If the backend is `basic_text` (no keyring), keys are not stored with it; the user sets a local passphrase (Argon2id via `crypto_pwhash`) instead.

## Packaging

electron-builder → AppImage and .deb, both auto-updated by electron-updater from GitHub Releases (AppImage replaces itself; .deb installs through a `pkexec` password prompt — verify in Phase 9). better-sqlite3 rebuilt for Electron's ABI.
