# Android

Status: **Phase 6 implemented** (`apps/mobile`: Capacitor 8 + shared React UI + Kotlin). Distribution: signed APK on GitHub Releases (no Play Store). Verified on the API 35 emulator unless marked otherwise.

## Platform limits (not bypassed)

- Android 10+: only the default IME or the app whose window has **input focus** can read the clipboard. No background reading, no service trick.
- Android 12+: the system shows a "pasted from" toast whenever an app reads another app's clip.
- Android 13+: clips flagged `ClipDescription.EXTRA_IS_SENSITIVE` (passwords) — Clipply skips them.
- `onResume` is too early: the read must happen in `onWindowFocusChanged(true)`.
- Custom keyboard (IME) is out of scope for the first release.

## Capture entry points (all event-driven)

| Entry | Mechanism | Content |
|---|---|---|
| Open app | read on window focus, once | text, URI, image clip |
| Share sheet | `ACTION_SEND` / `SEND_MULTIPLE` intent filter | text, images, files |
| Text selection menu | `ACTION_PROCESS_TEXT` ("Save to Clipply") | selected text |
| Quick Settings tile | `TileService` → translucent activity, reads on focus, finishes | current clip |
| Notification action (opt-in) | ongoing notification, no service, action opens translucent activity | current clip |
| Screenshots (opt-in) | WorkManager job with content-URI trigger on `MediaStore.Images`, filtered to the Screenshots relative path; re-enqueued after each run | new screenshots |

Screenshots need `READ_MEDIA_IMAGES` (13+) and full photo access; with partial access ("selected photos", 14+) Clipply explains the limitation. No silent capture from MediaProjection.

## Background work

- No foreground service, no polling loop, no WebSocket, no wake locks, no periodic job by default.
- After a capture: Kotlin encrypts into a native inbox and enqueues one unique expedited `OneTimeWorkRequest` (`NetworkType.CONNECTED`, `ExistingWorkPolicy.APPEND_OR_REPLACE`) — bursts batch into one upload; Doze/App Standby defer it as the OS decides.
- Pull happens only on app foreground / pull-to-refresh.
- "Pause monitoring" disables the tile, process-text handler, and screenshot job.

## Keys

The vault keyring and device private keys are wrapped with a non-exportable AES-GCM key in Android Keystore. `android:allowBackup="false"` so wrapped blobs never land in a backup they can't be unwrapped from.

## Battery testing (Phase 6 onward)

`adb shell dumpsys batterystats`, `dumpsys jobscheduler`, WorkManager diagnostics, Battery Historian; acceptance = zero wakeups and zero network while idle with screenshots off.

## Implementation (as built)

| Piece | Where | Notes |
|---|---|---|
| WebView app | `apps/mobile/src` | Shared `@clipply/ui` + `AccountController`; SQLite via @capacitor-community/sqlite (BLOBs must be passed as `{type:'Buffer', data}` — found on the emulator) |
| Keys / session | `SecureStore.kt` | AES-256-GCM key in Android Keystore; files in `noBackupFilesDir`; backup and device transfer disabled |
| Capture inbox | `Inbox.kt` | Keystore-encrypted entries; drained into history on app start/resume or immediately if the app is running |
| Foreground read | `MainActivity.onWindowFocusChanged` → JS `windowFocus` | Skips `EXTRA_IS_SENSITIVE` clips; self-writes ignored |
| Share / text selection | `ShareActivity` | `SEND` (text, images), `SEND_MULTIPLE` (images), `PROCESS_TEXT` |
| Quick Settings tile | `ClipboardTileService` → `CaptureActivity` | translucent activity reads on focus |
| Screenshots | `ScreenshotWorker` | WorkManager content-URI trigger on MediaStore Images, `Screenshots` paths only, newer than enable time; re-arms with `APPEND_OR_REPLACE` (REPLACE cancelled its own run — fixed after emulator test) |
| Background upload | `UploadWorker` + `ItemCrypto.kt` | Unique, network-constrained, exponential backoff; text only; Tink XChaCha20-Poly1305 + BouncyCastle BLAKE2b, unit-tested against `packages/crypto/vectors/item-v1.json` |
| Copy image to clipboard | `ClipImageProvider` | serves bytes from memory via a pipe — no plaintext image file |
| Blob transfer | plugin `uploadBlob` / `downloadBlob` | native HTTP, ciphertext only |

Token sharing: the worker may rotate the refresh token; `AccountController` re-reads the stored session before refreshing so the two never replay each other's token.

## Measured on the emulator (API 35, 2026-11-22)

- Share text and text-selection while the app was **force-stopped** → 2 inbox files, `grep` for the plaintext marker in them: 0 hits. On open: imported, inbox emptied, SQLite has 0 plaintext hits.
- Clipboard written by another process, app reopened → captured on window focus.
- Screenshot written to `Pictures/Screenshots` + media scan → ScreenshotWorker ran (2/2 successes, 0 self-cancellations after the fix) and the images appeared with WebView-generated thumbnails.
- **Idle for 90 s in background**: 0 alarms, 0 wake locks held, 0 scheduled jobs (screenshot import off), no network, no wakeup events for the app UID; the only service record is Chrome's WebView renderer sandbox.

## Not verified yet

- Google sign-in (Credential Manager) and sync against a real server — needs `apps/mobile/.env` (`VITE_API_URL`, `VITE_GOOGLE_WEB_CLIENT_ID`) and an Android OAuth client for your signing key.
- The Quick Settings tile tap (`cmd statusbar click-tile` did not deliver `onClick` on the emulator); image shares from another app; `UploadWorker` against a live API.
- A real device's Doze/App Standby over hours (Battery Historian).

## Known limitations

- Background upload handles text only; images captured while the app is closed upload when it next opens (thumbnails are made in the WebView).
- Background captures classify `url` vs `text` only (code detection runs in the app).
- Image dedupe hashes RGBA pixels on Android and BGRA on desktop, so the same image captured on both platforms can appear twice.
- New items from other devices arrive when the app is opened (no push, by design).
