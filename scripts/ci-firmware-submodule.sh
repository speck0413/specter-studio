#!/bin/sh
# CI: check out the firmware submodule at its pinned commit (the workflow checks out this repository without
# submodules, then runs this), from the public firmware repository in .gitmodules, with no token.
set -e
cd "$(dirname "$0")/.."
pin=$(git ls-tree HEAD firmware | awk '{print $3}')
[ -n "$pin" ] || { echo "::error::no firmware submodule in this commit"; exit 1; }
if git submodule update --init --depth 1 firmware || git submodule update --init firmware; then
  echo "firmware $pin from $(git config submodule.firmware.url)"
  exit 0
fi
echo "::error::the firmware submodule pin $pin is not in $(git config -f .gitmodules submodule.firmware.url). Pin a published commit; see docs/BUILDING.md"
exit 1
