#!/bin/sh
# CI: check out the firmware submodule at its pinned commit (the workflow checks out this repository without
# submodules, then runs this).
#  1. From the URL in .gitmodules, the public firmware repository, with no token. This is the normal case.
#  2. Only when that fails (the pin is a development commit not published yet) and FIRMWARE_REPO_TOKEN is set:
#     from the private development repository FIRMWARE_DEV_REPO (owner/name, default
#     speck0413/specter-proptroller-dev; FIRMWARE_DEV_URL overrides the whole URL), with the token sent as an
#     HTTP header for that one command (never written to .git/config).
# Without the token a development pin stops here with an error that says so. docs/BUILDING.md, "Repository settings".
set -e
cd "$(dirname "$0")/.."
pin=$(git ls-tree HEAD firmware | awk '{print $3}')
[ -n "$pin" ] || { echo "::error::no firmware submodule in this commit"; exit 1; }
if git submodule update --init --depth 1 firmware || git submodule update --init firmware; then
  echo "firmware $pin from $(git config submodule.firmware.url)"
  exit 0
fi
if [ -z "$FIRMWARE_REPO_TOKEN" ]; then
  echo "::error::the firmware submodule pin $pin is not in $(git config -f .gitmodules submodule.firmware.url) (a development commit not published yet?). Move the pin to a published commit, or set the FIRMWARE_REPO_TOKEN secret (read access to ${FIRMWARE_DEV_REPO:-speck0413/specter-proptroller-dev}); see docs/BUILDING.md"
  exit 1
fi
dev=${FIRMWARE_DEV_URL:-https://github.com/${FIRMWARE_DEV_REPO:-speck0413/specter-proptroller-dev}.git}
echo "firmware $pin is not in the public repository: trying $dev with FIRMWARE_REPO_TOKEN"
auth=$(printf 'x-access-token:%s' "$FIRMWARE_REPO_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$auth"
git config submodule.firmware.url "$dev"
# a half-made clone from step 1 keeps its own origin: point it at the development repository too
if [ -e firmware/.git ]; then git -C firmware remote set-url origin "$dev"; fi
hdr="http.https://github.com/.extraheader=AUTHORIZATION: basic $auth"
git -c "$hdr" submodule update --init --depth 1 firmware || git -c "$hdr" submodule update --init firmware
echo "firmware $pin from $dev"
