# Synchronization protocol

Status: **implemented** — engine `packages/sync-engine/src/sync.ts` (+ remote operations in `library.ts`, orchestration in `account.ts`), server `apps/server/src/modules/sync`. Tested with two simulated devices against the real API (`apps/server/test/sync.test.ts`, `account.test.ts`).

## 1. Ordering

The server assigns order; device clocks are display-only.

- Every accepted write bumps the user's counter (`users.seq`, `$inc`) inside the same MongoDB transaction that writes the item, and stamps the item with that `seq` and `rev = rev + 1`.
- Concurrent transactions on one user conflict on the counter document; MongoDB aborts and retries the loser, so **commit order = seq order**. A reader that has seen `seq = n` can never later miss a change `< n`.
- Pull = `clipboard_items.find({userId, seq: {$gt: cursor}}).sort({seq: 1}).limit(L)`; only each item's latest state is returned, so a long-offline device downloads at most one record per item.

## 2. Flow

```text
capture → normalize → keyed hash → local duplicate? → encrypt (DEK, meta, body)
        → SQLite items (state=pending) + outbox op (opId)
        → push when eligible (batched ≤ 50 ops, large bodies uploaded to Cloudinary first)
server  → validates, checks epoch + baseRev, assigns rev/seq, records opId
others  → head probe → pull since cursor → decrypt → merge → history updates
```

Pushing never replaces any OS clipboard. Writing an item to the OS clipboard is a separate, explicit action (or an opt-in setting "replace clipboard with items from other devices", default **off**).

## 3. Loop prevention

- Items arriving through pull are written to the DB directly; they never pass through the capture pipeline.
- When the app itself writes to the OS clipboard (user clicked "copy"), the provider records the content hash and ignores the next change event with that hash.
- Capture of a hash already present in history bumps that item to the top locally instead of creating a new item.
- `opId` makes retries idempotent; item `id` makes upserts idempotent.

## 4. Conflicts

| Case | Rule |
|---|---|
| Two edits of the same item | Upsert carries `baseRev`. Server rejects with `conflict` + current state when `baseRev ≠ rev`. Client: if only flags differ, re-apply its flag change on top and retry; if both changed content, keep the remote version and save the local edit as a **new item** ("edited copy"). No silent loss. |
| Edit vs delete | Delete wins. Tombstone carries a higher seq; a later upsert to a tombstoned id is rejected as conflict. |
| Delete on several devices | Idempotent. |
| Same content captured on two devices | Both upload (different ids). After decrypting, clients see equal keyed hashes; the item with the higher `seq` is deleted by whichever client notices first (deterministic, idempotent). |
| Out-of-order / replayed push | `opId` already applied → server returns the original result. |
| Stale key epoch | `stale_epoch` → client fetches keyring, re-wraps DEK, retries. |

## 5. Tombstones and cursor expiry

Tombstones keep `{id, rev, seq, deleted}` and drop ciphertext (Cloudinary asset destroyed). Tombstones older than 30 days are purged and the user's `purgeFloor` is raised; a pull with `cursor < purgeFloor` returns `410 Gone`, and the client does a full re-pull (cursor 0) and drops local synced items absent from the result.

## 6. Retry and scheduling

Outbox rows carry `attempts` and `nextAttemptAt` (exponential backoff 5 s → 30 min, jitter). Network errors and 5xx retry; 4xx validation errors move the op to `failed` and surface in the UI; 401 triggers one token refresh.

| Platform | Push | Pull |
|---|---|---|
| Desktop | 2 s after capture (debounced) | `GET /sync/head` every 60 s while online (backs off to 5 min after 30 min idle, resets on capture/window focus); full pull only when head > cursor |
| Android | unique expedited WorkManager job after capture, `NetworkType.CONNECTED` | on app foreground and pull-to-refresh only |

## 7. API (planned, Phase 3)

```text
POST /v1/sync/push            PushRequest  → PushResponse
GET  /v1/sync/pull?cursor&limit            → PullResponse | 410
GET  /v1/sync/head                         → SyncHead
POST /v1/storage/upload-signature {itemId,size} → signed Cloudinary raw/private upload params (≤ 10 MB; one call per chunk of a larger file)
POST /v1/storage/confirm      {itemId, uploadResponse} → verifies Cloudinary signature, records object
GET  /v1/storage/download-url?itemId          → short-lived signed private download URL (owner-checked)
```

## 8. Implementation notes

- **Payload choice**: text-like bodies travel inline when the ciphertext fits (≤ ~48 KB); larger bodies and **all images** go to Cloudinary, so the encrypted thumbnail can ride inline. After a sync that pulled changes, the bodies of the images among the 15 newest items (at most 5) are downloaded in the background (so copying a recent image never waits on the network); older images and other blobs are fetched on first use, with a "Copying…" spinner on the card. Either way they are authenticated, then cached as ciphertext.
- **Large files** (over ~10 MB, up to 100 MB): the body is split into 4 MiB chunks, each its own ciphertext and Cloudinary blob. The item carries `chunks` (every ref) and repeats the first as `blob`, so an app from before chunks still accepts the pull; the server keeps `chunks` when such an app pushes the same blob without them. Uploaded refs are recorded one by one, so an interrupted upload resumes. Large items are pushed after small ones. Chunk ciphertext lives in the platform `ChunkStore` (files), not in SQLite, and is downloaded only when the file is opened or saved.
- **`ocr`**: all recognized text of an image. A push without it (older app) keeps the stored one; a scan that finds nothing sends an encrypted empty text, which replaces it.
- **Server features**: `GET /sync/head` announces `features`. A client holds back chunked items until the server lists `chunks`, because an older server would drop the extra refs.
- **Size limits**: a push stays near `MAX_SYNC_BYTES` (3 MB) and a pull page ends there too, because Vercel caps both bodies at 4.5 MB. Later pages of a pull that began at cursor 0 send `resync=1`: they can end below `purgeFloor`, and without it the server would answer 410 and the client would start over forever.
- **Conflict outcomes** (`ClipLibrary.resolveConflict`): same content hash → server version kept with our flags/title re-applied (`merged`); different content → server version kept under the id and our edit saved as a new item titled "Edited copy" (`forked`); server tombstone → local item removed (`deleted`).
- **Pending local edits are never overwritten by a pull**; their push conflicts and is resolved as above.
- **Desktop scheduling** (`AccountController.startScheduler`): `/vault/state` + `/sync/head` probe every 60 s (5 min after 30 min idle), sync 2 s after local changes and on window focus. Android does not use the scheduler (WorkManager, Phase 6).
- **Keyring changes**: every sync first checks `/vault/state.version`; a new version triggers `refreshKeyring`. Pulls stop (without advancing the cursor) on an item under an unknown epoch until the keyring is refreshed.
- Verified scenarios: convergence, image blobs + thumbnails, edits/flags/deletes, concurrent flag merge, concurrent edit fork, delete beats offline edit, cross-device duplicate collapse, offline backoff, lost push response replay, full resync after purge, idle head probe, token expiry refresh, revoked device detection.
