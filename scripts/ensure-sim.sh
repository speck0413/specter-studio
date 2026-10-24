#!/bin/sh
# Before `tauri dev` (package.json "dev:tauri"): builds the practice board when the firmware's sim build is
# missing, so a fresh clone needs no separate scripts/build-sim.sh. Never stops the app: without PlatformIO it
# says so and the app starts without a practice board. Rebuild after firmware changes: scripts/build-sim.sh.
cd "$(dirname "$0")/.."
# the generic firmware that comes with Studio (Generic + the Proptroller board offline): built once when missing
if [ ! -f src-tauri/bundled-firmware/proptroller-firmware.json ] && { command -v pio >/dev/null 2>&1 || [ -x "$HOME/.platformio/penv/bin/pio" ]; }; then
  echo "bundled firmware: not built yet, building it (scripts/bundle-firmware.py)"
  python3 scripts/bundle-firmware.py || echo "warning: the bundled firmware did not build; USB installs need a release" >&2
fi
[ -x firmware/firmware/arduino/.pio/build/sim/program ] && exit 0
if command -v pio >/dev/null 2>&1 || [ -x "$HOME/.platformio/penv/bin/pio" ]; then
  echo "practice board: not built yet, building it (scripts/build-sim.sh)"
  ./scripts/build-sim.sh || echo "warning: the practice board did not build; the app starts without it" >&2
else
  echo "warning: no PlatformIO (pio), so no practice board; scripts/setup.sh installs it" >&2
fi
exit 0
