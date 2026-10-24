#!/bin/sh
# The macOS installer on this Mac: Specter Studio.app and a .dmg, with the practice board, the firmware library
# and the wiring guides (scripts/build-desktop.sh). For this Mac's processor unless TARGET names another
# (aarch64-apple-darwin, x86_64-apple-darwin; the simulator is built for this Mac, so build each on its own
# kind of Mac, as CI does).
# Signing: ad-hoc unless APPLE_SIGNING_IDENTITY is set, so Apple silicon runs it here; anyone else has to
# allow it once (System Settings, Privacy & Security, Open Anyway). A Developer ID identity and the
# APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID variables sign and notarize (docs/BUILDING.md "Signing").
#   scripts/build-macos.sh
set -e
cd "$(dirname "$0")/.."
[ "$(uname)" = Darwin ] || { echo "error: macOS only (Linux and Windows: docs/BUILDING.md)" >&2; exit 1; }
command -v rustc >/dev/null 2>&1 || [ ! -x /opt/homebrew/opt/rustup/bin/rustc ] || PATH="/opt/homebrew/opt/rustup/bin:$PATH"
HOST=$(rustc -vV | sed -n 's/^host: //p')
TARGET=${TARGET:-$HOST}
[ "$TARGET" = "$HOST" ] || rustup target add "$TARGET"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
SIM_TARGET=$TARGET ./scripts/build-desktop.sh app,dmg --target "$TARGET"
OUT=target/$TARGET/release/bundle
echo
ls -1 "$OUT"/dmg/*.dmg
echo "app: $OUT/macos/Specter Studio.app"
