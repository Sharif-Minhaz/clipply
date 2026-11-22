# Development roadmap

Each phase ends working and testable. A phase is done only when its acceptance checks pass.
Gate for every phase: `npm run gate` (typecheck + tests across the workspace).

| Phase | Scope | Status |
|---|---|---|
| 0 | Inspection, architecture, monorepo, shared data models | **done** |
| 1 | Shared foundation | **done** |
| 2 | Ubuntu desktop MVP (local only) | **done** |
| 3 | Backend MVP (ciphertext store) | **done** |
| 4 | End-to-end encryption: enrollment, recovery, rotation | **done** |
| 5 | Sync engine, two simulated devices | **done** |
| 6 | Android app | **done** |
| 7 | Multi-device management | **done** |
| 8 | Advanced features | **done** |
| 9 | Security review + release (AppImage, deb, APK on GitHub Releases) | next |

## Phase 0 — done (2026-11-22)

- Repo inspected: only three empty placeholder dirs (`desktop/ mobile/ server/`), removed in favour of `apps/`. Reference projects (pennywise, yashfeen_frontend) read, not modified.
- Environment: Node 24.13, npm 11.6, JDK 21, Android SDK 36 + build-tools 35/36, Docker, Ubuntu 24.04 GNOME 46 Wayland.
- GNOME Wayland clipboard probe: XWayland selection readable unfocused ([desktop.md](desktop.md)).
- Monorepo config (npm workspaces, strict `tsconfig.base.json`).
- `packages/shared-schemas`: item, device, envelope, sync wire schemas; 7 tests pass.
- Docs: architecture, encryption, synchronization, desktop, android, this roadmap.

## Phase 8 — done (2026-11-22)

- **Bulk operations**: selection mode in the shared history list (select / select all, pin, unpin, delete).
- **Storage management**: per-kind counts and sizes; clear one kind or all history (pinned and favorite kept). Retention was already configurable.
- **Import / export**: passphrase-encrypted backup file ([encryption.md §6](encryption.md)); desktop via native dialogs (file mode 0600), Android via the system pickers.
- **MIME types**: files copied in a file manager (desktop, single file ≤ ~10 MB) or shared on Android become encrypted, synced `file` items with “Save”; HTML-only clips were already kept.
- **Excluded applications** (desktop): by window class via `xprop`; X11 and XWayland windows only (measured limit on GNOME Wayland).
- **Screenshot detection**: watcher no longer stays idle when the Screenshots folder does not exist yet.
- **Compositors**: XWayland polling kept as the single provider (documented in [desktop.md](desktop.md)); no native-Wayland provider, since GNOME 46 lacks the data-control protocol needed for one.
- **Performance** (Node, 5 000 text items, encrypted SQLite): load + decrypt 86 ms, search 0.23 ms per query, list 0.2 ms, capture ~1.8 ms per item. No changes needed.
- Not verified on the emulator: Android file share, backup and Save pickers.

## Phase 7 — done (2026-11-22)

Devices screen (shared UI, desktop + Android): list with platform, status (connected / waiting / removed), last seen and last sync; rename; approve by code; remove with key rotation.

- **Recovery workflow**: replace the recovery key from any authorized device (rotation + new key shown once). The keyring records which devices held the recovery key (`recovery.knownBy`); removing one of them replaces the key in the same rotation.
- **Per-device sync control**: pause/resume sync on this device (stored locally; on Android it also stops the background upload worker). Captures keep queuing and upload on resume.
- Bug found and fixed: approvals did not refresh the recovery copy, so a device recovering later started from a stale roster, dropped approved devices, and the next rotation failed with `rotation_missing_devices`.
- Server: a new recovery key is accepted only with a rotation (`recovery_key_changed` otherwise).
- Tests: approval → later recovery keeps the approved device; revoking a device that never saw the key keeps it; revoking one that did replaces it and the old key gets 403; manual replacement; non-rotation swap refused; pause sends nothing and resume uploads.

## Phase 6 — done (2026-11-22)

`apps/mobile` — Capacitor 8 app reusing the shared UI, sync engine and AccountController; Kotlin plugin for Keystore storage, clipboard, encrypted capture inbox, share/process-text/tile entry points, screenshot content-trigger worker, background text upload with Kotlin crypto. Debug APK builds (`npm run android:debug -w @clipply/mobile`).

- Kotlin crypto proven compatible: 4 JVM tests decrypt the TypeScript vectors and reproduce the keyed hash.
- Emulator-verified capture paths, encryption at rest, screenshot import, and idle battery behaviour — details and gaps in [android.md](android.md).
- Bugs found on the emulator and fixed: SQLite BLOB binding shape; screenshot worker cancelling itself.

## Phase 5 — done (2026-11-22)

- `SyncEngine`: batched push (inline or Cloudinary blob + thumb), per-op results (ack, conflict resolution, stale-epoch re-wrap, rejection), cursor pull with 410 full resync, exponential backoff with jitter, `syncIfNeeded` head probe, lazy blob download.
- `ClipLibrary` remote operations; `AccountController` (shared by desktop and Android): Google sign-in → vault create/join/recover → approvals/revocation → sync scheduling and status, token refresh, removed-device detection.
- Desktop wired: loopback + PKCE Google sign-in, sealed session file, keyring persisted on change, Cloudinary transport, account IPC, shared `DevicesPanel` (sign-in, one-time recovery key with typed confirmation and no copy button, enrollment code, recovery, approve/remove/rename, honest sync status).
- Bugs found by the two-device tests and fixed: 410 loop on cursor 0; enrollment acceptance after the server clears the claim; revoked device shown as "signed out".
- Tests: 9 two-device sync scenarios, 3 AccountController journeys, loopback OAuth (PKCE/state), DevicesPanel flows. Full gate green.

Not verified: real Google sign-in and real Cloudinary transfers (need your credentials: `apps/desktop/.env`, `apps/server/.env`; see deployment.md).

## Phase 4 — done (2026-11-22)

Protocols per [encryption.md](encryption.md) §5, implemented and tested end-to-end (7 tests, 3 simulated devices against the real API + MongoDB).

- Design changes found while implementing (both close holes in the Phase 0 design): the recovery copy is sealed to an X25519 key derived from the recovery key (so rotations refresh it without the recovery key, and revoked devices cannot open it); the authorized-device roster and recovery public keys travel inside the signed keyring (so a server cannot add devices or redirect recovery). This delivers the "signed device list" originally planned for Phase 7.
- Server: `/vault/state|init|envelope|claim|enrollment|envelopes|recover`; publish rules (signer = caller, claimed-by-caller authorization, rotation must include a recovery envelope and every authorized device); revocation deletes the envelope.
- Client: `createAccountVault`, `enrollmentCodeFor`, `approveDevice`, `acceptEnrollment`, `recoverVault`, `revokeAndRotate`, `refreshKeyring`; `ClipLibrary.adoptKeyring` re-keys local history on joining.
- Security tests: key substitution caught, forged envelope rejected, revoked device locked out and unable to decrypt new items, stale-epoch uploads rejected, recovery after rotation works, no keys/plaintext in any request body.

Not done here: desktop UI for sign-in/enrollment/recovery (lands with sync wiring in Phase 5 and device management in Phase 7). Residual risk documented: revoked device + server collusion against a device that has not refreshed yet.

## Phase 3 — done (2026-11-22)

`apps/server` — see [backend.md](backend.md), deploy via [deployment.md](deployment.md).

- Google ID-token sign-in → HS256 access JWT (15 min) + rotating refresh tokens with reuse detection; first device authorized, later ones pending.
- Devices list/rename/revoke (immediate); sync head/pull/push with transactional per-user seq, idempotent ops, conflicts, delete-wins tombstones, key-epoch check; single-item read.
- Cloudinary signed private raw uploads/downloads/destroy; MongoDB rate limiting; CORS allow-list; daily GC cron (blobs, tombstones + purge floor → 410).
- Vercel Build Output bundle (`npm run build -w @clipply/server`), smoke-tested locally: health 200 through the rewrite.
- Tests: 16 integration tests on an in-memory MongoDB replica set with real XChaCha20 ciphertext (incl. "no plaintext in DB or logs", user isolation, 12 concurrent pushes → gap-free seqs, replayed refresh token revokes session, 413 on oversize bodies).
- Fixes the Phase 1 delete/in-flight-upsert race: deletes always leave a tombstone.

Not verified (needs your accounts): live Google token verification, live Cloudinary download/destroy endpoints, Vercel cron + route behaviour in production. Checklist in deployment.md.

## Phase 2 — done (2026-11-22)

`apps/desktop`: Electron 45 + electron-vite + React renderer on the shared UI. Run: `npm run dev -w @clipply/desktop`.

- Main process owns capture, crypto, SQLite (`node:sqlite`), and the IPC surface (Zod-validated, sender-checked); hardened sandboxed renderer with CSP.
- Screens: Clipboard / Favorites / Pinned (search, type filters, cards), item viewer (image zoom, text edit, link open), Devices (this device only, honest about no sync), Settings (capture, screenshots, retention, clear history, autostart, close-to-tray, GNOME shortcut, security status), vault-problem screen.
- Tray (pause/resume, show, quit), single instance + `--toggle` / `--hidden`, XDG autostart, retention every 6 h.
- Tests: 15 main-process unit tests (provider, screenshot watcher, gsettings, autostart, settings, vault, core, IPC guard) + shared UI tests.
- Live-verified on GNOME 46 Wayland: background capture hidden/unfocused, image + thumbnail, password-hint skip, screenshot import, file/clipboard image dedupe, restart keeps history, no plaintext in DB/WAL, DB + vault + logs 0600. See [desktop.md](desktop.md).

Not verified: installing the GNOME shortcut (edits your keybindings — try it from Settings), the tray menu by click, X11 (non-Wayland) sessions, other compositors. Packaging (AppImage/deb) is Phase 9.

## Phase 1 — done (2026-11-22)

`npm run gate`: 7 packages typecheck, 57 tests pass. No shared package imports Electron, Capacitor or Express.

| Package | What exists | Tests |
|---|---|---|
| shared-schemas | wire schemas (items with encrypted thumb, devices, envelopes, sync) | 8 |
| crypto | XChaCha20-Poly1305 seal/open with AAD + padding, keyring (rotate, serialize, continuity check), keyed content hash, item DEK wrap, device keys, signed sealed envelopes, 12-digit enrollment code, recovery key format/checksum/derivation/envelope | 15 (incl. IETF vector + pinned Kotlin vectors) |
| database | `SqlDb` seam, append-only migrations, item / outbox / kv repos, serialized `Transactor` | 9 |
| sync-engine | content classification, UUIDv7, `ClipLibrary` | 13 |
| api-client | typed fetch for sync head/pull/push, response validation, timeout, one-shot refresh, error taxonomy with `retryable` | 5 |
| ui | Tailwind 4 tokens, `ClipplyClient` context, live list hook, thumbnail blob-URL hook, SearchBar, KindFilter, ClipCard, ClipList, relative time | 5 |
| logger | scoped logger with recursive redaction | 2 |

Not verified yet: `packages/ui/src/styles.css` has not been compiled by Tailwind (no app builds it until Phase 2). UI tests use an in-memory fake client, because vitest's jsdom environment mixes typed-array realms and libsodium rejects them; the real engine is covered by Node tests.

Known follow-ups recorded in code: an in-flight upsert racing a delete of a never-synced item (Phase 5 ack handler).

## Phase 1 — Shared foundation (original plan)

Smallest set that Phase 2 (local desktop) and Phase 3 (server) need. Order:

1. **crypto** (`packages/crypto`): libsodium init; keyring create/serialize; DEK; item encrypt/decrypt with AAD + padding; keyed content hash; box keypair + seal/open; sign/verify; recovery key generate/format/parse/derive. Tests: round-trips, tamper, AAD swap, wrong epoch, fixed-vector snapshots (become the Kotlin vectors later).
2. **database** (`packages/database`): async `SqlDb` interface, ordered migrations table, schema v1 (items, outbox, sync_state, device, prefs, blobs), item repository (insert, list page, update flags/body, soft delete, retention purge). Tests on real SQLite (better-sqlite3 in Node).
3. **domain helpers** inside `sync-engine` (no network yet): content normalizer + kind detection (url / code / html / text), capture pipeline (normalize → hash → dedupe → encrypt → store), local search over decrypted index. Tests.
4. **api-client**: typed fetch wrapper over shared-schemas with response validation, timeout, error taxonomy. Tests with a stub fetch.
5. **ui** (`packages/ui`): Tailwind 4 theme tokens (dark-first), `ClipplyClient` context, item card, list, search, filter chips. Rendered in Vitest + Testing Library.
6. **config + logging**: typed env loading (Zod) per app; logger with a redaction rule that drops any `content`/`body`/`key` field. Test: plaintext never reaches log output.

Acceptance: `npm run gate` green; crypto vectors committed; no package imports Electron/Capacitor/Express.

## Later phases (acceptance summary)

- **2**: copy text/image anywhere on this GNOME session → appears in Clipply within 1 s with window closed; search, edit, delete, pin, favorite, image preview/zoom; tray; `--toggle` shortcut; survives restart; DB contains no plaintext.
- **3**: Express on Vercel; Google ID token → JWT + rotating refresh; devices; push/pull/head with seq ordering; Cloudinary signed upload/download; rate limits; tests with mongodb-memory-server; plaintext-never-logged test.
- **4**: two desktop profiles enroll via SAS and via recovery key; revoke → rotation → revoked device rejected and lacks new epoch.
- **5**: two simulated devices: offline edits, conflicts, deletes, duplicates, replays converge.
- **6**: Android capture entry points, Kotlin inbox + WorkManager upload, TS↔Kotlin vectors, battery measurements recorded here.
- **7–9**: per spec §13.

## Open decisions (defaults chosen; override if you disagree)

1. Android background upload re-implements item encryption in Kotlin (vs. upload only when app is open).
2. Blobs in Cloudinary (free plan, no card) as private raw ciphertext; MongoDB-only storage rejected (see architecture §8).
3. No `apps/web`.
4. electron-builder instead of Electron Forge.
