# Code overview

How the three apps — **desktop** (Electron), **mobile** (Capacitor + Kotlin) and **server** (Express on Vercel) — are put together at code level, and the patterns they share. Bird's-eye system view and the encryption story: [README → Architecture at a glance](../README.md#architecture-at-a-glance) and [README → Encryption and decryption](../README.md#encryption-and-decryption).

## 1. The one idea: shared core, thin platform shells

```text
                    ┌──────────────────────── packages/ (shared TypeScript) ─────────────────────────┐
                    │  shared-schemas   Zod schemas = wire types for HTTP, IPC, bridge, decrypted data │
                    │  crypto           libsodium: item, keyring, envelopes, recovery, backup          │
                    │  database         SqlDb interface + migrations + repos (items, outbox, kv)       │
                    │  sync-engine      ClipLibrary · SyncEngine · AccountController · vault protocol  │
                    │  api-client       typed fetch client for /v1                                     │
                    │  ui               React screens, talks only to the ClipplyClient interface       │
                    │  logger           scoped logger with recursive redaction                         │
                    └───────────────┬──────────────────────────┬──────────────────────────┬─────────────┘
                                    │                          │                          │
          apps/desktop              │      apps/mobile         │       apps/server        │
          supplies: clipboard       │      supplies: Kotlin    │       uses: shared-schemas,
          helper, node:sqlite,      │      capture, Keystore,  │       logger (never crypto:
          safeStorage, IPC, tray    │      capacitor-sqlite    │       it cannot decrypt)
```

| Package | Role | Used by |
|---|---|---|
| [`shared-schemas`](../packages/shared-schemas/src) | Zod schemas; TS types are `z.infer` of them | all |
| [`crypto`](../packages/crypto/src) | `item.ts` (encrypt/decrypt one item), `keyring.ts`, `device.ts` (key-pairs, sealed envelopes, 12-digit code), `recovery.ts`, `backup.ts` | desktop, mobile |
| [`database`](../packages/database/src) | `SqlDb` interface, `migrations.ts`, `itemRepo` / `outboxRepo` / `kvRepo`, `nodeSqlite.ts` | desktop, mobile |
| [`sync-engine`](../packages/sync-engine/src) | All app logic: history, sync, account/vault, link previews, updates, backup | desktop, mobile |
| [`api-client`](../packages/api-client/src) | `createApiClient()` → typed calls, `ApiError` kinds | sync-engine |
| [`ui`](../packages/ui/src) | Shared React UI over `ClipplyClient`, `AccountClient`, `UpdateClient` | desktop renderer, mobile WebView |
| [`logger`](../packages/logger/src) | Redacts content/key/token-like fields before any sink | all |

Rule of thumb: **if it is not platform I/O, it lives in a package.** Apps only wire dependencies together.

## 2. Patterns used everywhere

| Pattern | Where | Why |
|---|---|---|
| **Dependency injection via `*Deps` objects** | `CoreDeps` (desktop core), `AccountDeps`, `LibraryDeps`, `SyncDeps` (sync-engine), `AppDeps` (server), `IpcDeps` | Same class runs on both platforms; tests pass fakes (`now`, `fetch`, in-memory SQLite) |
| **Ports & adapters** | `SqlDb` (node:sqlite / capacitor-sqlite), `ClipplyClient` (IPC / direct), `ClipboardProvider` (Electron / helper process), `SecretStorage` | Shared code depends on interfaces, never on Electron or Capacitor |
| **Zod at every trust boundary** | HTTP bodies (server), IPC args (`ipc.ts`), bridge payloads, decrypted `meta` | Nothing crosses a boundary unvalidated |
| **Single writer + outbox** | `ClipLibrary` writes item + outbox row in one transaction | Local DB is source of truth; sync can crash anywhere and resume |
| **Idempotent ops** | Each push carries an `opId`; server stores the result in `sync_events` | Retries never apply twice |
| **Ciphertext everywhere at rest** | Local SQLite and MongoDB hold the same encrypted item | One encryption path; plaintext only in memory |
| **Injected clock** | `now?: () => number` on most classes | Deterministic tests for retention, backoff, token expiry |

## 3. Desktop — `apps/desktop`

### Process model

```text
 ┌ renderer (React, sandboxed) ───────────┐
 │ renderer/src/App.tsx, DevicesScreen,   │
 │ SettingsScreen, VaultProblem           │
 │ client.ts: desktopClient → window.clipply
 └──────────────▲─────────────────────────┘
                │ contextBridge (preload/index.ts) — fixed channels from shared/api.ts (CH)
 ┌ main process ┴─────────────────────────┐        ┌ clipboard helper process ─────────┐
 │ index.ts  main(): wires everything     │ stdio  │ --clipboard-helper                 │
 │ ipc.ts    registerIpc(): origin check  │◄──────►│ --ozone-platform=x11 (XWayland)   │
 │           + Zod on every handler       │ JSON   │ helperProcess.ts: polls clipboard │
 │ core.ts   DesktopCore: capture loop,   │ lines  └────────────────────────────────────┘
 │           copy, settings, screenshots  │
 │ vault.ts  keyring in safeStorage       │
 │ + ClipLibrary / AccountController      │
 │   (sync-engine) over node:sqlite       │
 └────────────────────────────────────────┘
```

- The window is a native Wayland client (sharp under fractional scaling); a **windowless XWayland child** reads the clipboard because only X11 clients can read it unfocused on GNOME ([clipboard/helper.ts](../apps/desktop/electron/main/clipboard/helper.ts)).
- **All crypto, DB and sync run in the main process.** The renderer only asks for decrypted views through IPC; it never sees keys.

### Boot (`electron/main/index.ts` → `main()`)

1. Single-instance lock, logger with file sink, `initCrypto()`.
2. `openNodeSqlite()` + `migrate()` → `SqlDb`.
3. `openVault(safeStorage, …)` → `ready` / `no_keyring` / `error` ([vault.ts](../apps/desktop/electron/main/vault.ts)). Refuses to store keys without a real OS keyring.
4. Build `ClipLibrary`, `AccountController` (with `googleSignIn`, `uploadBlob`/`downloadBlob`, `sessionStore` from `account/`), `UpdateChecker`, `LinkPreviewer`.
5. `new DesktopCore(deps).start()` — starts the clipboard provider and screenshot watcher.
6. `registerIpc(...)`, tray, window, `account.startScheduler()` (60 s probe + debounced sync after local changes).

### Key files

| File | Responsibility |
|---|---|
| `electron/main/core.ts` | `DesktopCore`: clipboard change → `library.capture()`, copy back to clipboard, settings, excluded apps |
| `electron/main/clipboard/provider.ts` | `ClipboardProvider` interface, SHA-256 change detection (no plaintext kept between polls), password-manager hint skip |
| `electron/main/screenshot/watcher.ts` | Watches the screenshot folder, imports new images |
| `electron/main/ipc.ts` | Every IPC handler; rejects frames outside `allowedOrigin` |
| `electron/shared/api.ts` | `CH` channel names + `DesktopApi` type shared by main, preload, renderer |
| `electron/main/account/` | Google OAuth (loopback + PKCE), blob transport, session storage |
| `electron/main/updater.ts` | AppImage / deb self-update after SHA-512 check |
| `electron/main/{tray,window,shortcuts,autostart}` | Tray menu, window toggle, GNOME `Super+V` binding, autostart entry |

## 4. Mobile — `apps/mobile`

### Two halves

```text
 ┌ WebView (only while the app is open) ─────────────┐
 │ src/main.tsx → App.tsx (shared ui)                 │
 │ src/services/runtime.ts  boot(): the whole engine  │
 │   ClipLibrary + AccountController + UpdateChecker  │
 │   over capacitor-sqlite (services/sqlite.ts)       │
 │ src/services/native.ts   typed ClipplyNative plugin│
 └───────────────▲───────────────────────────────────┘
                 │ Capacitor bridge (base64 payloads)
 ┌ Kotlin (android/app/src/main/java/co/lazycoders/clipply) ─────────────┐
 │ ClipplyNativePlugin.kt  bridge methods: secure storage, clipboard,     │
 │                         inbox, upload scheduling, files, screenshots,  │
 │                         installUpdate                                  │
 │ Capture.kt     share / text-selection / tile → readClip → saveClip     │
 │ Inbox.kt       Keystore-encrypted queue of captures made while closed  │
 │ SecureStore.kt AES-256-GCM Keystore key wraps keyring, keys, session   │
 │ ItemCrypto.kt  text-item encryption only (pinned by test vectors)      │
 │ Workers.kt     UploadWorker (WorkManager) pushes inbox text            │
 └────────────────────────────────────────────────────────────────────────┘
```

- **The WebView runs the same TypeScript engine as desktop.** Here `ClipplyClient` is implemented directly in `runtime.ts` (no IPC hop) by calling `ClipLibrary`.
- **Kotlin works without the WebView**: a capture while the app is closed is encrypted straight into `Inbox`, and `UploadWorker` pushes text items over the network. Kotlin re-implements **only** item encryption; output is checked against [packages/crypto/vectors/item-v1.json](../packages/crypto/vectors/item-v1.json).

### Lifecycle (`runtime.ts` → `boot()`)

1. `initCrypto()`, `openCapacitorDb()` + `migrate()`, `loadVault()` from `SecureStore` (creates keyring + device keys on first run).
2. Build `ClipLibrary`, `AccountController` (Google sign-in via `@capgo/capacitor-social-login`, HTTP via `CapacitorHttp`).
3. `drainInbox()` → import captures made while closed; apply retention.
4. `resume` → drain inbox, sync, `startScheduler()`; `pause` → `stopScheduler()`. **Nothing runs in the background except WorkManager jobs the OS triggers.**
5. Returns `Runtime` (`client`, `account`, `updates`, settings, backup) to `App.tsx`.

## 5. Server — `apps/server`

### Request pipeline (`src/app.ts` → `createApp()`)

```text
vercel.ts (cached MongoClient + app per warm instance)  |  local.ts (dev)
  └─ createApp({ config, store, verifyGoogle, log })
       headers: no-store, nosniff, no-referrer, CORS allow-list
       express.json({ limit: '4mb' })
       /v1/health
       /v1/auth            rateLimit('auth') → authRoutes          (Google ID token → JWT + refresh)
       ── auth(JWT) → rateLimit('api') ───────────────────────────────────────────────
       /v1/devices         deviceRoutes                            (list, rename, revoke)
       /v1/vault           rateLimit('vault') → vaultRoutes        (init, envelopes, enrollment, recover)
       /v1/sync            requireAuthorizedDevice → syncRoutes    (head, pull, push)
       /v1/items           requireAuthorizedDevice → clipboardRoutes
       /v1/storage         requireAuthorizedDevice → rateLimit('storage') → storageRoutes
       /v1/internal/gc     Bearer CRON_SECRET → runGc()            (daily Vercel cron)
       errorHandler        short error codes only, never data
```

- **Stateless.** `Store` ([db.ts](../apps/server/src/db.ts)) wraps the Mongo collections and `tx()` (transactions with retry). Every accepted write takes the user's next `seq` inside a transaction.
- **Never decrypts.** The server imports `shared-schemas` for validation and `logger`, never `crypto`.

| Module | Endpoints | Notes |
|---|---|---|
| `auth/` | `POST /google`, `/refresh`, `/logout` | `tokens.ts`: 15-min JWT, rotating 90-day refresh token stored as SHA-256 hash; replay revokes |
| `devices/` | `GET /`, `PATCH /:id`, `POST /:id/revoke` | Revoke marks its sessions revoked, deletes its envelope |
| `vault/` | `GET /state`, `POST /init`, `GET /envelope`, `POST /claim/:deviceId`, `GET /enrollment`, `POST /envelopes`, `POST /recover` | Relays sealed, signed envelopes; checks signer is authorized |
| `sync/` | `GET /head`, `GET /pull`, `POST /push` | `service.ts`: `applyPush` (conflict / stale epoch / idempotency), `pull` |
| `storage/` | `POST /upload-signature`, `POST /confirm`, `GET /download-url` | `cloudinary.ts`: signs params, verifies Cloudinary response signature, `destroy` |
| `maintenance/` | `runGc()` | Deletes released blobs, orphan uploads, old tombstones |

### Data stores

| MongoDB collection | Holds | Index / TTL |
|---|---|---|
| `users` | `googleSub`, email, `seq`, `keyEpoch`, `purgeFloor`, `vault.recovery` (sealed) | unique `googleSub` |
| `devices` | name, platform, app version, status, public keys, enrollment, `revokedAt` | `userId`; revoked rows TTL 30 days |
| `device_key_envelopes` | keyring sealed per device + signature | `userId` |
| `device_key_envelope_history` | every envelope per device and vault version, replayed by a device that missed several roster changes | `{deviceId, version}`, TTL 365 d on `createdAt` |
| `clipboard_items` | `itemId`, `rev`, `seq`, `deleted`, encrypted `item` | `{userId, seq}` |
| `encrypted_objects` | blob ↔ item, size, `pending/uploaded/attached/delete_pending` | `{userId, itemId}`, `{status, updatedAt}` |
| `sessions` | `tokenHash`, `previousHash`, `revoked`, `expiresAt` | TTL on `expiresAt` |
| `sync_events` | push result per `opId` | TTL 7 days |
| `rate_limits` | counters | TTL on `expiresAt` |

| Local SQLite table (both apps) | Holds |
|---|---|
| `items` | `dek` / `meta` / `body` / `thumb` ciphertext, blob ref, `rev`, `seq`, `sync_state`; clear columns only `created_at`, `pinned`, `favorite`, keyed `content_hash` |
| `outbox` | one pending op per item: `op_id`, `upsert`/`delete`, attempts, `next_attempt_at` |
| `kv` | sync cursor, device id, preferences — never keys or plaintext |
| `schema_migrations` | applied migration versions |

## 6. Shared engine — `packages/sync-engine`

| Class / module | What it owns |
|---|---|
| `ClipLibrary` ([library.ts](../packages/sync-engine/src/library.ts)) | The only place plaintext ↔ ciphertext happens for history: `capture`, `add`, `edit`, `setFlags`, `remove`, `list`/search over an in-memory decrypted index, retention. Each write = item + outbox in one transaction |
| `SyncEngine` ([sync.ts](../packages/sync-engine/src/sync.ts)) | `sync()` = push outbox, then pull from cursor. One run at a time, every step idempotent, exponential backoff. `syncIfNeeded()` checks `/sync/head` first |
| `AccountController` ([account.ts](../packages/sync-engine/src/account.ts)) | Sign-in, session refresh, device registration, vault create/approve/accept/recover/rotate, scheduler (60 s probe + 2 s debounce after local changes) |
| vault protocol ([vault.ts](../packages/sync-engine/src/vault.ts)) | `createAccountVault`, `enrollmentCodeFor`, `approveDevice`, `acceptEnrollment`, `recoverVault`, `revokeAndRotate`, `replaceRecoveryKey`, `refreshKeyring` |
| `UpdateChecker` ([update.ts](../packages/sync-engine/src/update.ts)) | Daily anonymous GitHub release check |
| `LinkPreviewer` ([preview.ts](../packages/sync-engine/src/preview.ts)) | Open Graph preview, public hosts only |
| backup ([backup.ts](../packages/sync-engine/src/backup.ts)) | Passphrase-encrypted export / import |

## 7. End-to-end flows in code

**Capture (desktop)** — `HelperClipboardProvider` emits a change → `DesktopCore` skips excluded apps / sensitive clips → `ClipLibrary.capture()` (dedupe hash → `crypto/item.ts` encrypt → `itemRepo` + `outboxRepo` in one tx) → `library.subscribe` → `AccountController.notifyLocalChange()` → debounced `SyncEngine.sync()` → `api-client` `POST /v1/sync/push` → `sync/service.ts applyPush` → `clipboard_items` with new `seq`.

**Capture (Android, app closed)** — share / tile / text selection → `Capture.kt saveClip` → `Inbox` (Keystore-encrypted) → `UploadWorker` encrypts text with `ItemCrypto` and pushes it; images wait. On next open `runtime.ts drainInbox()` imports everything through `ClipLibrary` (thumbnails, blob upload).

**Receive** — scheduler probe → `GET /v1/sync/head` → `GET /v1/sync/pull?cursor=N` → `itemRepo` stores ciphertext → `ClipLibrary` decrypts `meta`/text into memory → `ui` re-renders through `ClipplyClient.subscribe`.

**Image / file** — `ClipLibrary` encrypts body → `BlobUploader` (desktop `account/transport.ts`, mobile `runtime.ts`) → `POST /v1/storage/upload-signature` → direct Cloudinary upload → `POST /v1/storage/confirm`. Viewing: `readBody` → `GET /v1/storage/download-url` → download → decrypt in memory.

**New device** — `AccountController` registers device (`pending`) → approver gets `GET /v1/vault/enrollment`, shows `enrollmentCodeFor()` → user compares codes → `approveDevice()` seals keyring to new device, signs, `POST /v1/vault/envelopes` → new device `acceptEnrollment()` verifies signer, opens envelope, stores keyring in OS secure storage.

## 8. Where to add things

| You want to… | Put it in |
|---|---|
| Add a field to what is synced | `shared-schemas` (schema) → `crypto/item.ts` if it is encrypted → `database/migrations.ts` (new migration, never edit old) → server `sync/service.ts` |
| Add a UI feature for both apps | `packages/ui`, extend `ClipplyClient`, implement in `apps/desktop/renderer/src/client.ts` + `preload` + `ipc.ts`, and in `apps/mobile/src/services/runtime.ts` |
| Add an API endpoint | new route in `apps/server/src/modules/<area>/routes.ts`, schema in `shared-schemas`, call in `api-client` |
| Add Android native capability | `@PluginMethod` in `ClipplyNativePlugin.kt` + its type in `apps/mobile/src/services/native.ts` |

Tests sit next to code (`*.test.ts(x)`) and in `apps/server/test/`; `npm run gate` runs typecheck + tests everywhere.
