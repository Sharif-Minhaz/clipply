#!/usr/bin/env bash
# Install the debug APK on a phone over USB or Wi-Fi, or run it with live reload.
# Usage: scripts/install-android.sh usb|wifi|live [usb|wifi]
set -euo pipefail
cd "$(dirname "$0")/.."

APK=android/app/build/outputs/apk/debug/app-debug.apk
ADB=$(command -v adb || echo "${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb")
[ -x "$ADB" ] || { echo "adb not found. Install Android SDK platform-tools or set ANDROID_HOME." >&2; exit 1; }
PORT=5173

require_apk() {
  [ -f "$APK" ] || { echo "No APK at $APK. Build it first: npm run android:debug" >&2; exit 1; }
  # `live` leaves an APK that loads the PC's dev server; it fails once that server stops.
  if unzip -p "$APK" assets/capacitor.config.json | grep -q '"url"'; then
    echo "APK at $APK is a live-reload build (points at the dev server). Rebuild first: npm run android:debug" >&2
    exit 1
  fi
}

# Pairs (optional) and connects over Wi-Fi; sets $serial to the connected device's IP:port.
connect_wifi() {
  echo "On the phone: Settings > Developer options > Wireless debugging ON. Phone and PC must be on the same Wi-Fi."
  read -rp "Pair this PC first? Needed once per PC (y/N): " pair
  if [[ $pair =~ ^[Yy] ]]; then
    read -rp "Pairing IP:port (tap 'Pair device with pairing code', e.g. 192.168.1.5:37123): " pair_addr
    read -rp "Pairing code (6 digits, same dialog): " code
    "$ADB" pair "$pair_addr" "$code"
  fi
  # The port changes every time Wireless debugging restarts; mDNS finds the current one.
  found=$("$ADB" mdns services 2>/dev/null | awk '/_adb-tls-connect/ {print $3; exit}')
  [ -n "$found" ] && echo "Phone found on Wi-Fi: $found"
  read -rp "Device IP:port (Wireless debugging screen, 'IP address & Port')${found:+ [$found]}: " serial
  serial=${serial:-$found}
  # adb connect exits 0 even when it fails, so check its message.
  "$ADB" connect "$serial" | tee /dev/stderr | grep -q "connected to" || { echo "Could not connect to $serial." >&2; exit 1; }
}

connect_usb() {
  echo "Connect the phone by USB with USB debugging on (Settings > Developer options), then allow this PC on the phone."
  "$ADB" wait-for-usb-device
  serial=$("$ADB" -d get-serialno)
}

case "${1:-}" in
  usb)
    require_apk
    connect_usb
    "$ADB" -s "$serial" install -r "$APK"
    echo "Installed Clipply debug build."
    ;;
  wifi)
    require_apk
    connect_wifi
    "$ADB" -s "$serial" install -r "$APK"
    echo "Installed Clipply debug build."
    ;;
  live)
    if [ "${2:-usb}" = wifi ]; then connect_wifi; else connect_usb; fi
    # The phone reaches the dev server through `adb reverse` as http://localhost, which is a secure
    # context (WebCrypto works); a LAN IP over plain http would not be.
    npx vite --host 127.0.0.1 --port "$PORT" --strictPort &
    vite_pid=$!
    trap 'kill $vite_pid 2>/dev/null' EXIT
    echo "Starting live reload. Edits reload the app on the phone; Ctrl+C stops the dev server."
    echo "The installed app then needs this PC; reinstall a normal build with: npm run android:debug && npm run android:install:usb"
    npx cap run android -l --host localhost --port "$PORT" --forwardPorts "$PORT:$PORT" --target "$serial"
    wait "$vite_pid"
    ;;
  *)
    echo "Usage: $0 usb|wifi|live [usb|wifi]" >&2
    exit 2
    ;;
esac
