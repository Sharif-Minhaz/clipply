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

## Docs

- [Architecture](docs/architecture.md) — components, decisions, data model, risks
- [Encryption](docs/encryption.md) — key hierarchy, enrollment, recovery, rotation, threat model
- [Synchronization](docs/synchronization.md) — ordering, conflicts, loop prevention, API
- [Desktop](docs/desktop.md) — GNOME Wayland/X11 clipboard, screenshots, tray, shortcuts
- [Android](docs/android.md) — clipboard limits, capture entry points, battery rules

## Releases

GitHub Releases only: AppImage + .deb for Ubuntu, signed APK for Android.
