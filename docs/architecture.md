# Clipply architecture

Status: **Phase 1 done** (shared packages). Sections marked *planned* describe code that does not exist yet.

## 1. System at a glance

```text
 Ubuntu (Electron)                                Android (Capacitor + Kotlin)
 ┌──────────────────────────────┐                 ┌──────────────────────────────┐
 │ main process (always on)     │                 │ WebView (only while open)    │
 │  ClipboardProvider ─┐        │                 │  shared React UI             │
 │  ScreenshotWatcher ─┤        │                 │  sync-engine + crypto (TS)   │
 │  sync-engine + crypto (TS)   │                 │  SQLite (capacitor-sqlite)   │
 │  SQLite (better-sqlite3)     │                 ├──────────────────────────────┤
 │  safeStorage (libsecret)     │                 │ Kotlin (works without WebView)│
 ├──────────── IPC ─────────────┤                 │  capture: share / tile /      │
 │ renderer: shared React UI    │                 │   process-text / screenshot   │
 └──────────────┬───────────────┘                 │  encrypt -> inbox -> WorkMgr  │
                │ HTTPS, ciphertext only          │  Android Keystore             │
                ▼                                 └──────────────┬───────────────┘
        ┌──────────────────────────────┐                         │
        │ Express API on Vercel        │◄────────────────────────┘
        │  auth · devices · sync ·     │
        │  storage (presign) · health  │──► MongoDB Atlas (ciphertext + minimal metadata)
        └──────────────────────────────┘──► Cloudinary (private raw assets = ciphertext, direct signed upload)
```

The server is a blind relay: it orders, stores and authorizes; it never decrypts.

## 2. Repository layout

```text
apps/
  desktop/   Electron: electron/main/{clipboard,screenshot,tray,shortcuts,window,sync}, preload, renderer
  mobile/    Capacitor: src/ (React), android/ (Kotlin plugin + WorkManager)
  server/    Express: src/modules/{auth,devices,clipboard,sync,storage,health}
packages/
  shared-schemas/  Zod schemas + inferred types: the single source of truth for every wire shape
  crypto/          libsodium wrapper: vault, item, envelope, recovery primitives
  sync-engine/     ClipLibrary (capture → dedupe → encrypt → store + outbox, edit, delete, retention,
                   in-memory decrypted search index); push/pull + conflicts land in Phase 5
  database/        SQL migrations + repositories over an async SqlDb interface
  api-client/      typed fetch client built on shared-schemas
  ui/              shared React + Tailwind components, talks to a ClipplyClient interface
  logger/          scoped logger; redacts content/key-like fields recursively before any sink
infrastructure/  mongodb index scripts, deployment notes
docs/
```

### Deviations from the original spec structure

| Spec | Decision | Why |
|---|---|---|
| `shared-types` + `shared-schemas` | merged into `shared-schemas` | Types are `z.infer` of the schemas; two packages would be two sources of truth. |
| `apps/web` | dropped | No requirement needs a browser client; it would be a third UI to keep secure. Re-add if wanted. |
| `packages/utilities` | not created until something needs it | Avoid a grab-bag package. |
| Configuration package | none: each app parses its env with a Zod schema at startup | A shared wrapper would be one line around `schema.parse(process.env)`. |
| Logging | `packages/logger` | Shared redaction rule so no app can log plaintext by accident. |
| pnpm | npm workspaces | npm hoists into real `node_modules` paths, which Electron Builder and Capacitor Gradle files need; no extra tool to install. |

## 3. Technology decisions

| Area | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.9 strict | TS 7 (native) exists; 5.9 kept until the toolchain (eslint, vite plugins) is verified on it. |
| Desktop | Electron 45 + Vite + React 19 + Tailwind 4 | Main process owns clipboard, crypto, DB, sync; renderer is UI only. |
| Desktop DB | better-sqlite3 (main process) | Same as yashfeen reference. |
| Desktop packaging | **electron-builder** (AppImage + deb now; NSIS for Windows and dmg/zip for macOS later), GitHub Releases | Chosen over Electron Forge (used in yashfeen): one updater (electron-updater) covers Linux, Windows and macOS straight from GitHub Release assets. Forge has no Linux auto-update, and its macOS path needs an update server or update.electronjs.org (public repos only). Signing (Apple Developer ID + notarization, Windows code-signing cert) is required for macOS auto-update and to avoid SmartScreen warnings with either tool. |
| Mobile | Capacitor 8 + React 19 + Tailwind 4 | No Ionic: the UI is shared with desktop. |
| Mobile DB | @capacitor-community/sqlite | Same as pennywise reference. |
| Android native | Kotlin plugin, WorkManager, Android Keystore | Capture + background upload work without the WebView (see §6). |
| Backend | Express 5 on Vercel (serverless), MongoDB Atlas M0, Cloudinary (blobs) | Stateless; no in-memory sessions or workers. |
| Auth | Google OIDC → own short-lived JWT + rotating refresh token | Desktop: system browser, loopback redirect + PKCE. Android: Credential Manager ID token. |
| Crypto | libsodium (`libsodium-wrappers`) XChaCha20-Poly1305, X25519 sealed boxes, Ed25519, BLAKE2b | AES-GCM rejected: libsodium.js has no AES-GCM. Details: [encryption.md](encryption.md). |
| Validation | Zod 4 at every trust boundary (HTTP, IPC, Capacitor bridge, decrypted payloads) | |
| Release | GitHub Releases only (AppImage, deb, signed APK) | No Play Store, so no Play policy limits on permissions; updates are checked on app open, never polled. |

## 4. Data model

Wire shapes live in `packages/shared-schemas` (implemented, tested).

**Item** — client-generated UUIDv7 `id`. Three ciphertexts per item:
- `dek`: random 256-bit per-item data key wrapped with vault key epoch `keyEpoch`.
- `meta`: encrypted `ItemMeta` — kind, mime, title, createdAt, editedAt, originDeviceId, size, keyed content hash, favorite, pinned.
- body: inline `body` (≤ ~48 KB) or `blob` reference to an encrypted Cloudinary raw asset, plus an encrypted inline `thumb` for images.

Server-visible per item: `id`, owner, `seq`, `rev`, `deleted`, `keyEpoch`, ciphertext sizes (padded), server timestamps. Kind, flags, title, origin device and hashes are **inside** `meta`. Filtering by favorite/pinned/type happens locally.

**Device** — id, name, platform, app version, status (`pending|authorized|revoked`), X25519 box key, Ed25519 sign key, created / last seen / last sync timestamps. The name is user-chosen and visible to the server (needed for the device screen before the vault is unlocked); documented as a metadata leak.

**MongoDB collections** (*planned*, Phase 3): `users` (google `sub`, `seq` counter, `keyEpoch`, recovery envelope), `devices`, `clipboard_items` (latest state + tombstones, index `{userId, seq}`), `sync_events` (applied `opId`s for idempotency, TTL index), `encrypted_objects` (Cloudinary public_ids, ownership, sizes, upload state), `device_key_envelopes` (`{userId, deviceId, epoch}` unique), plus `sessions` (hashed refresh tokens).

**Local SQLite** (implemented, `packages/database`, migration v1): `items` (dek / meta / body / thumb ciphertext, Cloudinary blob ref, server `rev`/`seq`, sync state), `outbox` (one pending op per item, opId, attempts, next retry), `kv` (cursor, device id, preferences — never keys or plaintext). Clear local columns are limited to `created_at`, `pinned`, `favorite` and the keyed `content_hash` so retention and dedupe run without decrypting; someone with the disk but not the keyring learns item counts, times and flags, not content. Decrypted previews live only in memory while the app runs (§7).

Tests use Node's built-in `node:sqlite`, so no native addon is built for Node; desktop uses better-sqlite3 built for Electron, Android uses the Capacitor plugin (bundles SQLCipher's modern SQLite, so upsert/row-value SQL is available on every Android version).

## 5. Shared code boundaries

- `ui` never imports Electron or Capacitor. It receives a `ClipplyClient` (list/search/edit/delete/copy/settings) via React context.
  - Desktop: `ClipplyClient` = IPC calls to the main process (crypto + DB live there).
  - Mobile: `ClipplyClient` = sync-engine + database running in the WebView.
- `sync-engine` depends on interfaces only: `SqlDb`, `ApiClient`, `VaultCrypto`, `Clock`. Both apps inject implementations.
- `crypto` is pure TS over libsodium; the Kotlin capture path re-implements only item encryption and is pinned to the TS output by shared test vectors (§6).

## 6. Android battery architecture (summary; detail in [android.md](android.md))

Nothing runs when nothing happens. No service, no polling, no socket, no periodic job by default.

Capture entry points, all user- or OS-event driven:
1. App gains window focus → read clipboard once.
2. Share sheet target (text, images, files).
3. Text-selection menu `ACTION_PROCESS_TEXT` ("Save to Clipply").
4. Quick Settings tile → translucent activity gains focus, reads clipboard, finishes.
5. Screenshots (opt-in): WorkManager job with a MediaStore content-URI trigger; the OS wakes it only when images change.

Background path without the WebView: Kotlin encrypts the item (vault key unwrapped from Keystore) into a native inbox and enqueues one unique expedited WorkManager upload (`CONNECTED` constraint, APPEND so bursts batch). When the app opens, the TS engine imports the inbox and pulls remote changes. **Risk**: duplicating item encryption in Kotlin; mitigated by cross-language test vectors, and Kotlin never handles key exchange or rotation.

Pull to Android happens on app open / pull-to-refresh. Optional low-frequency periodic pull and optional FCM "tickle" (no content) are Phase 8 opt-ins.

## 7. Local encryption at rest

The local DB stores the same ciphertext the server gets. The vault keyring and device private keys sit in OS secure storage (Electron `safeStorage` → libsecret on Ubuntu; Android Keystore-wrapped on Android). On unlock the app decrypts `meta` + text bodies into an in-memory index for list and search (thousands of items = a few MB). This gives one encryption path, no plaintext FTS index on disk, and no SQLCipher dependency. Trade-off: search cost grows with history size; retention limits cap it.

If Electron reports `safeStorage.getSelectedStorageBackend() === 'basic_text'` (no keyring), the app refuses to store keys silently and asks for a local passphrase instead.

## 8. Images and files

Rule: **no plaintext image is stored anywhere Clipply controls** — not on the server, not on Cloudinary, not in local SQLite or cache files.

- Capture device: decode once, make a ~320 px WebP thumbnail in memory, encrypt body + thumbnail with the item DEK, then discard plaintext. Android streams share-intent content URIs straight into encryption (no temp file).
- Upload: `POST /v1/storage/upload-signature` → server checks ownership/quota and signs a Cloudinary upload (`resource_type=raw`, `type=private`, server-chosen `public_id`, no overwrite). Client uploads ciphertext directly to Cloudinary, then sends the upload response; the server verifies Cloudinary's response signature (no Admin API call) and records the object.
- Download: `GET /v1/storage/download-url?itemId` → owner-checked, short-lived signed private download URL. Downloaded ciphertext is cached locally as-is.
- Display: decrypt into memory, show via a `blob:` URL, revoke it when the preview closes.
- Delete: server destroys the Cloudinary asset when the item is tombstoned.
- Cloudinary can't transform ciphertext, so all thumbnails/resizing happen on clients.

Outside Clipply's control (documented, not fixable): the OS screenshot file the user's screenshot tool saves, and the OS clipboard while an image is on it.

Rejected alternative — images in MongoDB (GridFS/inline chunks): M0's 512 MB total is shared with all metadata and indexes (~200 screenshots fill it), and every byte would pass through Vercel functions (4.5 MB request/response limit, function time and transfer quotas), which the spec forbids for large files.

## 9. Major technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| GNOME Wayland clipboard access | Desktop capture | Measured: XWayland clipboard readable unfocused on GNOME 46 (see [desktop.md](desktop.md)). Run Electron on X11/XWayland; GNOME Shell extension provider as fallback. |
| Global shortcuts on GNOME 46 Wayland | Desktop UX | No GlobalShortcuts portal on GNOME 46; register a GNOME custom keybinding that runs `clipply --toggle`. |
| Android background clipboard ban | Mobile capture | Event-driven entry points only; documented, not bypassed. |
| Kotlin crypto duplication | Mobile correctness | Narrow scope + shared vectors in CI. |
| Server substitutes keys (MITM at enrollment) | Confidentiality | Short authentication string compared on both devices; signed envelopes; keyring continuity check. |
| Revoked device colluding with server | Future-data confidentiality | Partially mitigated (signed roster in the keyring); documented limitation. |
| Cloudinary free plan: 25 credits/month (1 credit ≈ 1 GB stored or 1 GB delivered), 10 MB per raw file | Image volume | Images cached locally after first download (each device fetches once), retention + max-size settings, quota shown in settings. |
| Vercel Hobby: 4.5 MB request body, non-commercial use only, invocation quotas | Hosting | Direct-to-Cloudinary uploads, batch cap (`MAX_PUSH_OPS`), cheap `/sync/head` probe, adaptive desktop polling. |
| MongoDB M0: 512 MB, connection limits from serverless | Hosting | Only metadata + small ciphertext in Mongo, blobs in Cloudinary; cached client per function instance, low `maxPoolSize`. |
