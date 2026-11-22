#!/usr/bin/env bash
# Tail the app's WebView console, native plugin/worker logs and crashes from a connected phone.
# Usage: scripts/android-logs.sh [adb-serial]   (serial needed only if several devices are listed)
set -euo pipefail
APP_ID=$(grep -E "^[[:space:]]*appId:" "$(dirname "$0")/../capacitor.config.ts" | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/")
ADB=$(command -v adb || echo "${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb")
[ -x "$ADB" ] || { echo "adb not found." >&2; exit 1; }
SERIAL=${1:-$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')}
[ -n "$SERIAL" ] || { echo "No device attached." >&2; exit 1; }
echo "Logging $APP_ID on $SERIAL. Ctrl+C stops."
"$ADB" -s "$SERIAL" logcat -c || true
# Capacitor/Console = console.*; chromium = uncaught JS errors; Clipply = Kotlin workers/plugin;
# WM-* = WorkManager; AndroidRuntime = native crashes. No --pid: it changes when the app restarts.
exec "$ADB" -s "$SERIAL" logcat -v time 'Capacitor:V' 'Capacitor/Console:V' 'chromium:V' 'Clipply:V' 'WM-WorkerWrapper:I' 'AndroidRuntime:E' 'SocialLogin:V' '*:S'
