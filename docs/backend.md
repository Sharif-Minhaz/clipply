# Backend

Status: **Phase 3 implemented** (`apps/server`). Express 5 + MongoDB driver 7 + jose, bundled with esbuild into one Vercel function. 16 integration tests run against a real in-memory MongoDB replica set with genuinely encrypted payloads.

## Principles

- **Blind relay.** The server stores and orders ciphertext; it never sees content, titles, kinds, flags or keys.
- **Stateless.** No in-memory sessions, queues or rate counters: everything is in MongoDB, so any cold or warm Vercel instance can answer any request.
- **Every input validated** with the shared Zod schemas; errors return `{ "error": "<code>" }` only — no stack traces, no echoed data. Logs carry ids, routes and counts, never bodies (logger redaction).

## API (`/v1`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | — | DB ping |
| `POST /auth/google` | rate-limited per IP | Google ID token + device registration → access JWT (15 min) + refresh token (90 days) |
| `POST /auth/refresh` | refresh token | Rotates the refresh token; replaying an old one revokes the session |
| `POST /auth/logout` | refresh token | Revokes the session |
| `GET /devices` | any device of the account | List devices |
| `PATCH /devices/:id` | any device | Rename |
| `POST /devices/:id/revoke` | authorized device (or self) | Revoke: status, sessions, envelope. The revoked row refuses re-registration under its id and is purged by TTL 30 days later (`revokedAt`) |
| `GET /sync/head` | authorized device | `{ seq, keyEpoch }` — cheap "anything new?" probe |
| `GET /sync/pull?cursor&limit` | authorized device | Changes with `seq > cursor`, ≤ 500 per page, `410 cursor_expired` below the purge floor |
| `POST /sync/push` | authorized device | ≤ 50 ops, one transaction; per-op `applied` / `conflict` / `stale_epoch` / `rejected` |
| `GET /items/:id` | authorized device | One item (create/edit/pin/favorite/delete are pushes: flags are inside encrypted metadata) |
| `POST /storage/upload-signature` | authorized device | Signed Cloudinary upload params for a private raw asset (≤ 10 MB) |
| `POST /storage/confirm` | authorized device | Verifies Cloudinary's response signature, marks the object uploaded |
| `GET /storage/download-url?itemId` | authorized device | 10-minute signed private download URL, owner-checked |
| `GET /internal/gc` | `Bearer $CRON_SECRET` | Daily cleanup (Vercel cron) |

Device authorization: the account's **first** device is authorized at sign-in; every later device is `pending` and gets 403 `device_not_authorized` on sync/items/storage until enrolled (Phase 4). Device status is re-read on every request, so revocation is immediate.

## Collections and indexes

| Collection | Key / indexes | Notes |
|---|---|---|
| `users` | `googleSub` unique | `seq` counter, `keyEpoch`, `purgeFloor` |
| `devices` | `_id` = client device id; `userId` | public keys, status, timestamps |
| `sessions` | `tokenHash` unique, `previousHash`, TTL `expiresAt` | SHA-256 of refresh tokens only |
| `clipboard_items` | `_id` = `userId:itemId`; `{userId, seq}`; `{deleted, updatedAt}` | latest state + tombstones |
| `sync_events` | `_id` = `userId:opId`; TTL 7 days | push idempotency |
| `encrypted_objects` | `_id` = Cloudinary public_id; `{userId,itemId}`; `{status,updatedAt}` | `pending` → `uploaded` → `attached` (an item references it) → `delete_pending` |
| `rate_limits` | TTL `expiresAt` | fixed windows |

`device_key_envelopes` arrives with Phase 4.

## Sync semantics

One transaction per push. Each accepted op increments `users.seq`; concurrent pushes conflict on that document and are retried by the driver, so commit order equals seq order (tested: 12 concurrent pushes → seqs 1..12 without gaps). Upserts need `baseRev` equal to the current rev; deletes always win and always leave a tombstone, even for ids the server never saw, so a late in-flight upsert cannot resurrect a deleted item. Items under a retired key epoch get `stale_epoch`. An upsert referencing a blob that was not confirmed is `rejected`.

## Storage (Cloudinary)

Server-chosen public ids `clipply/<userId>/<itemId>/<random>`, `type=private`, `overwrite=false`, resource type `raw` (ciphertext). The signing algorithm is checked against Cloudinary's documented example. Not verified against a live Cloudinary account yet: the raw `download` endpoint parameters and the `destroy` call (see [deployment.md](deployment.md) checklist). The upload size reported on confirm comes from the client (Cloudinary's response signature covers only `public_id` + `version`); abuse only consumes the account owner's own quota.

## Limits

- JSON body 4 MB (Vercel's hard limit is 4.5 MB); push ≤ 50 ops; inline body ≤ ~48 KB ciphertext.
- Rate limits: auth 30/min per IP; API 600/min per user; storage 120/min per user.
- Mongo pool `maxPoolSize: 5` per instance (M0 allows ~500 connections).

## Maintenance (`/internal/gc`, daily)

Releases orphaned uploads (confirmed but never attached to an item after 3 days, e.g. the item was deleted or edited before its first push; a late push gets `blob_not_uploaded` and the client re-uploads), destroys `delete_pending` blobs (the push that releases a blob already destroys it; the cron retries the ones that failed) and uploads abandoned for > 24 h on Cloudinary (5 in parallel, failures retried next run), and purges tombstones older than 30 days after raising the user's `purgeFloor`, so a device with an older cursor gets `410` and resyncs instead of silently missing a delete. Works in batches for up to ~20 s per run (function limit 30 s); leftovers carry over to the next day.
