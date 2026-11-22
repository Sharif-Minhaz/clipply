# Development roadmap

Each phase ends working and testable. A phase is done only when its acceptance checks pass.
Gate for every phase: `npm run gate` (typecheck + tests across the workspace).

| Phase | Scope | Status |
|---|---|---|
| 0 | Inspection, architecture, monorepo, shared data models | **done** |
| 1 | Shared foundation | **done** |
| 2 | Ubuntu desktop MVP (local only) | next |
| 3 | Backend MVP (ciphertext store) | — |
| 4 | End-to-end encryption: enrollment, recovery, rotation | — |
| 5 | Sync engine, two simulated devices | — |
| 6 | Android app | — |
| 7 | Multi-device management | — |
| 8 | Advanced features | — |
| 9 | Security review + release (AppImage, deb, APK on GitHub Releases) | — |

## Phase 0 — done (2026-11-22)

- Repo inspected: only three empty placeholder dirs (`desktop/ mobile/ server/`), removed in favour of `apps/`. Reference projects (pennywise, yashfeen_frontend) read, not modified.
- Environment: Node 24.13, npm 11.6, JDK 21, Android SDK 36 + build-tools 35/36, Docker, Ubuntu 24.04 GNOME 46 Wayland.
- GNOME Wayland clipboard probe: XWayland selection readable unfocused ([desktop.md](desktop.md)).
- Monorepo config (npm workspaces, strict `tsconfig.base.json`).
- `packages/shared-schemas`: item, device, envelope, sync wire schemas; 7 tests pass.
- Docs: architecture, encryption, synchronization, desktop, android, this roadmap.

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
