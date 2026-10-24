#!/bin/sh
# Proves that a plugin frame cannot call Studio's backend directly, nor reach the network (fetch, WebSocket, WebRTC) (needs a display; opens the app window for a
# few seconds). Runs the release build with a probe plugin that tries Tauri's IPC every way it can and reports
# through a file request; passes when every attempt was blocked and no file_write was dispatched.
#   npm run tauri build -- --no-bundle && scripts/test-plugin-isolation.sh
# (SPECTER_APP names another build; without a display: xvfb-run -a scripts/test-plugin-isolation.sh)
set -e
cd "$(dirname "$0")/.."
LOG=$(mktemp); rm -f /tmp/specter-ipc-probe-pwned
SPECTER_TEST_LOG="$LOG" SPECTER_OPEN_PLUGIN=ipc-probe SPECTER_STUDIO_PLUGINS="$PWD/tests/fixtures" "${SPECTER_APP:-target/release/specter-studio}" &
APP=$!
for i in $(seq 1 60); do grep -q probe-done "$LOG" 2>/dev/null && break; sleep 0.5; done
kill $APP 2>/dev/null || true
echo "--- log"; cat "$LOG"
REPORT=$(grep probe-done "$LOG" | head -1)
[ -n "$REPORT" ] || { echo "FAIL: the probe did not report"; exit 1; }
python3 - "$REPORT" <<'PY'
import json, sys, urllib.parse
q = urllib.parse.urlparse(sys.argv[1].split(" ", 1)[1]).query
r = json.loads(urllib.parse.parse_qs(q)["r"][0])
print("probe:", r)
# blocked outright, or refused by Tauri's IPC (anything but a 200 answer)
bad = [k for k in ("internals", "tauri") if r.get(k)] + [k for k in ("ipc_scheme", "ipc_http") if str(r.get(k)).startswith("status 200")]
bad += ["parent"] if r.get("parent") != "blocked" else []
bad += ["invoke"] if r.get("invoke") == "ok" else []
# the network: fetch and WebSocket blocked by the plugin CSP, WebRTC removed (B1)
bad += [k for k in ("net_fetch", "net_ws") if r.get(k) != "blocked"] + (["net_rtc"] if r.get("net_rtc") != "gone" else [])
sys.exit("FAIL: reachable: %s" % bad if bad else 0)
PY
if grep -q "dispatch file_write" "$LOG" || [ -e /tmp/specter-ipc-probe-pwned ]; then echo "FAIL: file_write reached the backend"; exit 1; fi
echo "PASS: a plugin frame cannot reach Studio's backend"
