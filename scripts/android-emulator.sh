#!/usr/bin/env bash
# Boot the Android emulator and open Gymdex in its Chrome.
#
# The emulator reaches the host's Gymdex through `adb reverse`, so the phone
# sees it at http://localhost:8080 (a secure context, so the service worker
# registers just as it does over HTTPS on the Pi).
#
# Gymdex runs against data/emulator.sqlite3 unless GYMDEX_DB_PATH is set.
# Set HEADLESS=1 to boot without a window.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
AVD="${AVD:-gymdex_pixel}"
PORT="${PORT:-8080}"
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"

if ! "$ADB" devices | grep -q '^emulator-.*device$'; then
  args=(-avd "$AVD" -no-snapshot-save -no-boot-anim)
  [[ "${HEADLESS:-0}" == 1 ]] && args+=(-no-window)
  "$EMULATOR" "${args[@]}" >/tmp/gymdex-emulator.log 2>&1 &
  echo "Booting emulator $AVD (log: /tmp/gymdex-emulator.log)..."
fi

"$ADB" wait-for-device
until [[ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
  sleep 2
done
"$ADB" reverse "tcp:$PORT" "tcp:$PORT" >/dev/null

if ! curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then
  export GYMDEX_DB_PATH="${GYMDEX_DB_PATH:-$PWD/data/emulator.sqlite3}"
  python3 -m gymdex.server --port "$PORT" >/tmp/gymdex-server.log 2>&1 &
  echo "Started Gymdex on port $PORT with $GYMDEX_DB_PATH (log: /tmp/gymdex-server.log)"
  until curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; do sleep 0.5; done
fi

"$ADB" shell am start -a android.intent.action.VIEW -d "http://localhost:$PORT/" com.android.chrome >/dev/null
echo "Gymdex is open in the emulator's Chrome at http://localhost:$PORT/"
