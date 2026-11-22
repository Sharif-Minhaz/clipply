# Ubuntu desktop

Status: **Phase 2 implemented** (`apps/desktop`). Verified on Ubuntu 24.04 / GNOME 46 Wayland unless marked otherwise.

## Environment measured (2026-11-22)

Ubuntu 24.04.5, GNOME Shell 46.0, Wayland session (`XDG_SESSION_TYPE=wayland`, XWayland on `:0`), AppIndicator extension enabled.

Probe: from a background shell (no focused window), `xclip -o -selection clipboard -t TARGETS` returned the targets of content copied in a Wayland/XWayland app. Mutter mirrors the Wayland clipboard into the XWayland selection, so **an X11 client can read the clipboard without focus on GNOME 46**. `wl-paste` also worked but steals focus with a helper surface — unsuitable for monitoring.

## Clipboard providers

`ClipboardProvider` interface (start, stop, onClipboardChanged, readCurrentClipboard) with:

1. **ElectronClipboardProvider** (implemented, `electron/main/clipboard/provider.ts`): polls Electron 45's async clipboard (`clipboard.read()`, ~4–5 ms) every 750 ms in the main process. Change detection compares SHA-256 digests (no plaintext kept between polls); image bytes are re-read only when the X `TIMESTAMP` target changes. Precedence: image → one copied file (`text/uri-list` with a single `file://` URI: its contents, ≤ ~10 MB, verified live through XWayland with `wl-copy`) → plain text → HTML-only. Several files, folders or oversize files are captured as their paths (text). The first poll after start only records a baseline.
   - **XWayland is mandatory on GNOME Wayland.** Electron 45 injects `--ozone-platform=wayland` itself; as a native Wayland client it can read the clipboard only while focused. `app.commandLine.appendSwitch('ozone-platform', 'x11')` at runtime is ignored (measured), so the main process relaunches itself once with `--ozone-platform=x11` (guarded by `CLIPPLY_X11_RELAUNCHED`). The dev script passes the flag directly.
   - Verified: with the window hidden and unfocused, three xclip text copies were captured; an item flagged `x-kde-passwordManagerHint` was skipped; database + WAL contained no plaintext.
   - Trade-off: XWayland windows may look blurry with fractional scaling.
2. **XFixesProvider** (not built): event-driven selection-owner notifications instead of polling would need a native helper. Polling costs ~4–5 ms per 750 ms and was kept.
3. **GnomeShellExtensionProvider** (fallback): a bundled extension listens to `Meta.Selection` `owner-changed` and forwards over session D-Bus. Needed if a future GNOME stops mirroring to XWayland, or for native-Wayland Electron.

Pure X11 sessions use provider 1 unchanged. KDE and wlroots compositors also bridge the clipboard to XWayland, so the same provider should work there, but only GNOME 46 was tested. A `wl-paste --watch` provider (data-control protocol) would make native-Wayland capture event-driven on KDE/wlroots; GNOME 46 lacks that protocol, so it was not built.

Privacy: content whose targets include `x-kde-passwordManagerHint` (KeePassXC and others) is skipped (verified). When the clipboard holds both plain text and HTML, plain text is captured; HTML is kept only when no text is offered (copied back as HTML + text).

**Excluded apps** (`excludedApps`, window classes): when a change is seen, `xprop` reads the focused window's `WM_CLASS`; matches are skipped. Works on X11 sessions and for XWayland windows. On GNOME Wayland a focused native Wayland window reports `_NET_ACTIVE_WINDOW = 0x0` (measured), so its copies cannot be attributed and are captured. The focused app is a proxy for the source: a copy made and followed by a focus switch within one poll (750 ms) may be misattributed.

**Files**: file items cannot be put back on the clipboard (that would need a plaintext file on disk); “Save” writes the contents to a location the user picks.

## Screenshots

GNOME's screenshot UI saves to `$(xdg-user-dir PICTURES)/Screenshots` and copies the image to the clipboard. Watch that directory with `fs.watch` (inotify, no scanning) and capture image clipboard events. Dedupe by hashing decoded pixels (`nativeImage.toBitmap()`), because the file (PNG) and the clipboard image encode the same pixels differently. Verified live: a file dropped in the watched folder was imported (`source: screenshot`), and the same image then copied to the clipboard was recognised as a duplicate. The folder is configurable (`screenshotDir`); the default uses the English folder name, so localized systems need the setting. Only files written after start are imported. If the folder does not exist yet (GNOME creates it with the first screenshot), the watcher waits on the parent and starts when it appears, including the file that created it.

## Background, tray, autostart, shortcuts

- Window close hides; app keeps running in tray (Ubuntu ships the AppIndicator extension; vanilla GNOME has no tray — the app then stays reachable through the shortcut / launcher). Single-instance lock; `clipply --toggle` from a second instance shows/hides the window.
- Start on login: `~/.config/autostart/clipply.desktop` (Electron's `setLoginItemSettings` does nothing on Linux).
- Global shortcut: `Super+Shift+V` via Electron `globalShortcut` on X11. On GNOME 46 Wayland, X11 key grabs only fire while an X11 window is focused and the GlobalShortcuts portal is not available (expected in GNOME 48+, verify). Settings → "Add GNOME shortcut" registers a GNOME custom keybinding (gsettings `custom-keybindings`, existing bindings preserved) that runs `clipply --toggle`. Unit-tested with a fake gsettings runner; **not executed on this machine** because it edits the user's keybindings.

## Key storage

Electron async `safeStorage` (`gnome_libsecret` here). The vault file (`vault.v1`: device id, keyring, device keys) is written 0600 via atomic rename and re-sealed when the OS reports `shouldReEncrypt`. If the backend is `basic_text`/`unknown`, Clipply refuses to store keys and shows a blocking explanation; capture stays off. A missing or unreadable vault while encrypted history exists is never silently replaced — the user is offered an explicit "delete and start fresh". A passphrase fallback for keyring-less systems (Argon2id, needs `libsodium-wrappers-sumo`) is not implemented.

Database: `clipply.db` via Electron's built-in `node:sqlite` (SQLite 3.54), created 0600 before first open so `-wal`/`-shm` inherit it. No native addons ship with the app.

Logs: redacted JSON lines in `<userData>/logs/main.log` (0600, rotated at 2 MB).

## Packaging

electron-builder (Phase 9) → AppImage and .deb, both auto-updated by electron-updater from GitHub Releases (AppImage replaces itself; .deb installs through a `pkexec` password prompt — verify in Phase 9). better-sqlite3 rebuilt for Electron's ABI.
