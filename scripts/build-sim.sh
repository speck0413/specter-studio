#!/bin/sh
# Builds the simulated board from the firmware submodule (the firmware's own `sim` build: the real controller
# code on this computer) and puts it where Tauri bundles it as a sidecar. Needs PlatformIO (`pio`).
# SIM_TARGET=<rust target triple> names the sidecar for `tauri build --target <triple>` (CI); the default is
# this computer's triple. The simulator is always built for this computer, so SIM_TARGET only renames it.
# The sim builds on Linux and macOS; Windows has no network layer for it yet (net/posix.cpp is POSIX only).
set -e
cd "$(dirname "$0")/.."
PIO=$(command -v pio || echo "$HOME/.platformio/penv/bin/pio")
(cd firmware/firmware/arduino && "$PIO" run -e sim)
# the firmware build regenerates a committed header; keep the submodule clean
git -C firmware checkout -- firmware/arduino/lib/proptroller/src/proptroller/web_assets.h 2>/dev/null || true
TRIPLE=${SIM_TARGET:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}
if [ -z "$TRIPLE" ]; then echo "error: no rustc to name the sidecar (scripts/setup.sh, or set SIM_TARGET)" >&2; exit 1; fi
OUT=firmware/firmware/arduino/.pio/build/sim/program
EXT=
if [ -f "$OUT.exe" ]; then OUT="$OUT.exe"; EXT=.exe; fi
mkdir -p src-tauri/binaries
cp "$OUT" "src-tauri/binaries/proptroller-sim-$TRIPLE$EXT"
echo "simulator: src-tauri/binaries/proptroller-sim-$TRIPLE$EXT"
