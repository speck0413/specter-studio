#!/bin/sh
# SS-C5 against another firmware's golden set, to see what changes before the submodule pin moves:
#   scripts/checker-parity.sh [ref] [repo]     (default: HEAD of the firmware submodule; pass a local firmware
#                                              clone and a branch or tag to try a firmware before pinning it)
# Copies <ref>:firmware/show-script-golden into a temporary folder (the submodule is not touched) and runs
# Studio's parity tests on it. The board checker is still the pinned simulator, so a difference here is
# what the next pin brings; the tests on the pinned golden set (cargo test, npm test) must always pass.
set -e
cd "$(dirname "$0")/.."
REF=${1:-HEAD}
REPO=${2:-firmware}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive "$REF" firmware/show-script-golden | tar -x -C "$TMP"
export SHOW_SCRIPT_GOLDEN="$TMP/firmware/show-script-golden"
echo "golden set: $REF of $REPO"
status=0
cargo test -q -p studio-core --test checker_parity every_golden_case || status=1
npx vitest run src/effects/parity.test.ts || status=1
exit $status
