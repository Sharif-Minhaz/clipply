# Android

Status: **Phase 0 investigation**. Distribution: signed APK on GitHub Releases (no Play Store).

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
