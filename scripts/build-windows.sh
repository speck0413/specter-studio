#!/bin/sh
# Windows NSIS installer (x86_64-setup.exe) cross-built on Linux with cargo-xwin, following Tauri's
# "Windows Installer" page (cross-compiling from Linux with cargo-xwin). No sudo needed; the tools live
# in ~/.local/opt (docs/BUILDING.md, "Windows from Linux", says how to get them). No practice board (the
# simulator does not build for Windows yet) and unsigned. cargo-xwin downloads Microsoft's CRT and Windows
# SDK, which means accepting https://go.microsoft.com/fwlink/?LinkId=2086102 (the owner approved 2026-10-22).
#   scripts/build-windows.sh            -> <target dir>/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe
# Overrides: LLVM_DIR, NSIS_DIR, CARGO_TARGET_DIR, XWIN_CACHE_DIR, SPECTER_GUIDES_DIR, ALLOW_NO_GUIDES=1.
set -e
cd "$(dirname "$0")/.."

LLVM_DIR="${LLVM_DIR:-$HOME/.local/opt/LLVM-23.1.4-Linux-X64}"   # llvm-rc, llvm-lib (system clang/lld-link are used too)
NSIS_DIR="${NSIS_DIR:-$HOME/.local/opt/nsis-3.13}"               # Bin/makensis + Stubs, Plugins, Include, Contrib
export PATH="$NSIS_DIR/Bin:$LLVM_DIR/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/cargo-target/studio-win}"
export XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$HOME/.cache/cargo-xwin}"
export TMPDIR="${TMPDIR:-$HOME/.cache/tmp}"
mkdir -p "$TMPDIR"

for t in cargo-xwin makensis llvm-rc llvm-lib clang clang-cl lld-link; do
  command -v "$t" >/dev/null || { echo "error: $t not found (see docs/BUILDING.md, Windows from Linux)" >&2; exit 1; }
done

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

# the generic release that comes with Studio (needs PlatformIO; an empty folder says none comes with this build)
mkdir -p src-tauri/bundled-firmware
python3 scripts/bundle-firmware.py || { echo none > src-tauri/bundled-firmware/none.txt; echo "warning: no bundled firmware in this installer"; }
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc \
  --config src-tauri/tauri.bundle.conf.json --config '{"bundle":{"externalBin":[]}}' --bundles nsis
ls -l "$CARGO_TARGET_DIR"/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
