# Synchronization protocol

Status: **design (Phase 0)**. Wire shapes are implemented in `packages/shared-schemas/src/sync.ts`; engine lands in Phase 5.

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
POST /v1/storage/upload-signature {itemId,size} → signed Cloudinary raw/private upload params (≤ 10 MB)
POST /v1/storage/confirm      {itemId, uploadResponse} → verifies Cloudinary signature, records object
GET  /v1/storage/download-url?itemId          → short-lived signed private download URL (owner-checked)
```
