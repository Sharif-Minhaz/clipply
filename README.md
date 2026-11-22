# Clipply

End-to-end encrypted clipboard history shared between Ubuntu (Electron) and Android (Capacitor + Kotlin). The server (Express on Vercel, MongoDB Atlas, Cloudinary for encrypted image/file blobs) stores ciphertext only.

**Status:** Phase 1 complete — shared packages (schemas, crypto, database, sync-engine library, api-client, ui, logger) with 57 passing tests. No app is runnable yet. See [docs/development-roadmap.md](docs/development-roadmap.md).

## Layout

```text
apps/       desktop · mobile · server           (from Phase 2/3/6)
packages/   shared-schemas · crypto · database · sync-engine · api-client · ui · logger
docs/       architecture · encryption · synchronization · desktop · android · roadmap
```

## Setup

Requires Node ≥ 24 (npm workspaces):

```sh
npm install
npm run gate               # typecheck + tests in every package
```

## Build and run (from the repo root)

| Script | What it does |
|---|---|
| `npm run desktop:dev` | Desktop app with hot reload (XWayland) |
| `npm run desktop:dist` | AppImage + deb in `apps/desktop/dist/` (`dist:dir` in the workspace: unpacked, faster) |
| `npm run server:dev` / `server:build` | Local API / Vercel bundle |
| `npm run android:debug` | Debug APK |
| `npm run android:install:usb` / `android:install:wifi` | Install the debug APK on a phone (Wi-Fi: wireless debugging, optional pairing) |
| `npm run android:live` / `android:live:wifi` | Run on the phone with live reload (served as `http://localhost` via `adb reverse`, so WebCrypto works) |
| `npm run android:logs` | WebView console, Kotlin plugin/worker logs, WorkManager, crashes |
| `npm run android:release` | Release APK, signed when `apps/mobile/android/keystore.properties` exists, otherwise unsigned |
| `npm run icons:android -w @clipply/mobile` | Regenerate launcher icons from `apps/mobile/assets/` |

Release signing — create once, keep both files out of git (already ignored) and backed up:
```sh
keytool -genkeypair -v -keystore apps/mobile/android/clipply-release.jks -alias clipply -keyalg RSA -keysize 4096 -validity 10000
cat > apps/mobile/android/keystore.properties <<'P'
storeFile=clipply-release.jks
storePassword=…
keyAlias=clipply
keyPassword=…
P
```
Losing the keystore means users must uninstall to update. Register the release key's SHA-1 (`keytool -list -v -keystore …`) as an Android OAuth client too.

## Docs

- [Architecture](docs/architecture.md) — components, decisions, data model, risks
- [Encryption](docs/encryption.md) — key hierarchy, enrollment, recovery, rotation, threat model
- [Synchronization](docs/synchronization.md) — ordering, conflicts, loop prevention, API
- [Desktop](docs/desktop.md) — GNOME Wayland/X11 clipboard, screenshots, tray, shortcuts
- [Android](docs/android.md) — clipboard limits, capture entry points, battery rules

## Releases

GitHub Releases only: AppImage + .deb for Ubuntu, signed APK for Android.
