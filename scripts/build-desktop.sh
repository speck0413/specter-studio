#!/bin/sh
# The desktop bundle: the practice board (simulator), the generic firmware release that comes with Studio, the firmware
# library and workspace template, and the wiring guides.
# The guides come from the firmware repository (docs/wiring-guides/html): the submodule when it has them, else
# SPECTER_GUIDES_DIR. Without them the build stops (ALLOW_NO_GUIDES=1 builds anyway, and Help says they are
# not installed).
#   scripts/build-desktop.sh [deb|appimage|app,dmg|...] [more tauri build arguments]
set -e
cd "$(dirname "$0")/.."
./scripts/build-sim.sh
# the generic release that comes with Studio (ESP32; BUNDLE_PICO=1 adds the Pico W and Pico 2 W)
python3 scripts/bundle-firmware.py ${BUNDLE_PICO:+--pico}
GUIDES="${SPECTER_GUIDES_DIR:-firmware/docs/wiring-guides/html}"
rm -rf src-tauri/guides && mkdir -p src-tauri/guides
if [ -f "$GUIDES/index.html" ]; then
  cp -r "$GUIDES"/. src-tauri/guides/
  echo "wiring guides: $(ls src-tauri/guides/*.html | wc -l) pages from $GUIDES"
elif [ "${ALLOW_NO_GUIDES:-}" = 1 ]; then
  echo "<!doctype html><title>Wiring guides</title><p>The wiring guides are not installed.</p>" > src-tauri/guides/missing.txt
  echo "warning: building without the wiring guides"
else
  echo "error: no wiring guides at $GUIDES (set SPECTER_GUIDES_DIR, or ALLOW_NO_GUIDES=1 to build without them)" >&2
  exit 1
fi
BUNDLES="${1:-deb}"
[ $# -gt 0 ] && shift
npm run tauri build -- --config src-tauri/tauri.bundle.conf.json --bundles "$BUNDLES" "$@"
