# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Clipply: end-to-end-encrypted clipboard history synced between an Ubuntu desktop app (Electron), an Android app (Capacitor + Kotlin) and a stateless API (Express 5 on Vercel, MongoDB Atlas, Cloudinary). The server only ever sees ciphertext.

## Commands

npm workspaces, Node ≥ 24, npm ≥ 11.19.1 (enforced by `devEngines`; older npm writes a lockfile CI's `npm ci` rejects). Android builds need JDK 21+ and the Android SDK.

```sh
npm install
npm run gate                      # typecheck + tests in every workspace (run before declaring done)
npm run typecheck                 # all workspaces
npm test                          # all workspaces (vitest)

# one workspace / one file / one test
npm test -w @clipply/sync-engine
npm test -w @clipply/server -- test/sync.test.ts
npm test -w @clipply/crypto -- -t "test name substring"
npm run android:test -w @clipply/mobile   # Kotlin unit tests (gradle testDebugUnitTest)

npm run desktop:dev               # Electron with hot reload
npm run server:dev                # local API (esbuild-bundles src/local.ts, reads apps/server/.env)
npm run android:debug             # debug APK
npm run android:live              # live reload on phone via adb reverse (http://localhost so WebCrypto works)
npm run android:logs              # WebView console + Kotlin/WorkManager logs
```

Each app reads its own `.env` (copy `apps/{server,desktop,mobile}/.env.example`). Desktop vars are `MAIN_VITE_*`, mobile `VITE_*`.

Test notes:
- `apps/server` tests start an in-memory MongoDB replica set per file (`mongodb-memory-server`); first run downloads mongod (~100 MB). Files run serially. They drive the real `AccountController`/`ClipLibrary` against the real API, simulating multiple devices.
- `packages/ui` tests run in jsdom against a fake `ClipplyClient`: libsodium rejects jsdom's mixed typed-array realms, so real crypto is only tested in Node.
- `packages/crypto/src/crypto.test.ts` writes `packages/crypto/vectors/item-v1.json` via `toMatchFileSnapshot`; `apps/mobile/android/.../ItemCryptoTest.kt` checks Kotlin's `ItemCrypto.kt` against the same file. Any change to item encryption must update both TS and Kotlin.

Releases (`npm run publish`, `publish:ci`, `release:*`, see `docs/release.md`): `release:tag` commits version files and `release:push` pushes — do not run those steps; the user commits and pushes manually. Nothing builds on push; CI release only runs via `workflow_dispatch` on a `v*` tag.

## Architecture

**Shared core, thin platform shells.** All app logic is TypeScript in `packages/`; apps only supply platform I/O and wire dependencies. Workspace packages export their `src/index.ts` directly (no build step); bundlers (electron-vite, vite, esbuild) compile them.

- `shared-schemas` — Zod schemas for every wire shape (HTTP, IPC, Capacitor bridge, decrypted `meta`); TS types are `z.infer` of them. Validate with Zod at every trust boundary.
- `crypto` — libsodium (XChaCha20-Poly1305, X25519 sealed boxes, Ed25519): per-item DEKs, keyring, device envelopes, recovery, backups.
- `database` — async `SqlDb` port + `migrations.ts` + repos (`itemRepo`, `outboxRepo`, `kvRepo`). Desktop and tests use `node:sqlite` (`@clipply/database/node`, `/testing`), Android uses `@capacitor-community/sqlite`. Add a new migration; never edit an existing one.
- `sync-engine` — `ClipLibrary` (the only plaintext↔ciphertext boundary for history; each write = item + outbox row in one transaction; in-memory decrypted search index), `SyncEngine` (push outbox then pull from cursor, idempotent, backoff), `AccountController` (sign-in, sessions, device registration, vault protocol in `vault.ts`, scheduler), `UpdateChecker`, `LinkPreviewer`, backup.
- `api-client` — typed fetch client for `/v1`. `ui` — shared React UI that talks only to `ClipplyClient` / `AccountClient` / `UpdateClient` interfaces. `logger` — recursive redaction of content/key/token fields.

Patterns used everywhere: dependency injection via `*Deps` objects (`CoreDeps`, `LibraryDeps`, `SyncDeps`, `AccountDeps`, `AppDeps`, `IpcDeps`), injected clock `now?: () => number`, ports & adapters (`SqlDb`, `ClipplyClient`, `ClipboardProvider`, `SecretStorage`). Shared code never imports Electron or Capacitor. Keep desktop platform code behind interfaces (Windows/macOS planned).

**Desktop (`apps/desktop`)** — all crypto, DB and sync run in the Electron main process (`electron/main/index.ts` `main()` wires everything; `core.ts` `DesktopCore` owns capture/copy/settings). The renderer is UI only and reaches main through fixed IPC channels (`electron/shared/api.ts` `CH`), with origin check + Zod on every handler in `ipc.ts`. The window is a native Wayland client, but clipboard reads come from a windowless child process of the same binary (`--clipboard-helper --ozone-platform=x11`, `clipboard/helper.ts`, `helperProcess.ts`) streaming JSON lines over stdio, because only X11 clients can read the clipboard unfocused on GNOME. Keys live in `safeStorage` (GNOME Keyring); `vault.ts` refuses to store keys without a real keyring.

**Mobile (`apps/mobile`)** — the WebView runs the same TS engine; `src/services/runtime.ts` `boot()` builds it and implements `ClipplyClient` directly (no IPC). Kotlin (`android/app/src/main/java/co/lazycoders/clipply/`) works without the WebView: share/tile/text-selection captures are encrypted into a Keystore-encrypted `Inbox`, and a WorkManager `UploadWorker` pushes text items; `drainInbox()` imports them on next open. Nothing runs in the background except OS-triggered WorkManager jobs. New native capability = `@PluginMethod` in `ClipplyNativePlugin.kt` + its type in `src/services/native.ts`.

**Server (`apps/server`)** — `src/app.ts` `createApp()`; `vercel.ts` caches the Mongo client per warm instance, `local.ts` for dev. Routes in `src/modules/<area>/routes.ts` (auth, devices, vault, sync, clipboard, storage, maintenance). `db.ts` `Store` wraps collections and `tx()`. The server imports `shared-schemas` and `logger`, never `crypto` — it cannot decrypt. Large/image bodies go device→Cloudinary directly via signed upload (Vercel 4.5 MB body limit).

**Sync model** — offline-first; local SQLite holds the same ciphertext as the server and is the source of truth. Every accepted write takes the user's next `seq` inside a Mongo transaction (commit order = seq order); devices pull "everything after cursor". Pushes carry `opId` (idempotent via `sync_events`) and `baseRev` (conflict → merge flags, or fork to "Edited copy"; delete wins). Pulled items never re-enter the capture pipeline (loop prevention). Details: `docs/synchronization.md`.

**Adding things** — synced field: `shared-schemas` → `crypto/item.ts` if encrypted → new migration → server `sync/service.ts`. UI feature for both apps: `packages/ui` + extend `ClipplyClient` → desktop `renderer/src/client.ts` + preload + `ipc.ts`, and mobile `runtime.ts`. API endpoint: route module + schema in `shared-schemas` + call in `api-client`.

Deeper docs: `docs/code-overview.md` (file-by-file wiring), `docs/encryption.md` (key hierarchy, threat model), `docs/architecture.md` (decisions; note its desktop "better-sqlite3" mentions are stale — desktop uses `node:sqlite`), `docs/desktop.md`, `docs/android.md`, `docs/backend.md`, `docs/deployment.md`.

TypeScript is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type` for type-only imports).
