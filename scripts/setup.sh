#!/bin/sh
# Development setup for macOS and Linux, safe to run again. It says what it checks and what it installs.
#
#   scripts/setup.sh           tools, then this checkout: Rust toolchain, firmware submodule, npm ci, practice board
#   scripts/setup.sh --tools   the tools only (no submodule, npm or practice board)
#   scripts/setup.sh --check   installs and changes nothing; lists what is there and what is missing
#
# Tools: git, Node.js 20+, Rust (rustup), PlatformIO Core in ~/.platformio (Studio's USB install runs esptool from
# there), esptool, and Tauri's system parts (macOS: Apple's Command Line Tools; Linux: WebKitGTK 4.1 and friends).
# It installs only into your home folder (Homebrew packages on macOS, rustup, PlatformIO). Anything that needs
# sudo or an administrator is printed for you to run yourself. Windows: scripts/setup.ps1.
set -e
cd "$(dirname "$0")/.."

MODE=all
case "${1:-}" in
  --check) MODE=check ;;
  --tools) MODE=tools ;;
  "") ;;
  *) echo "usage: scripts/setup.sh [--check | --tools]" >&2; exit 2 ;;
esac

MISSING=
TODO=
ok()   { echo "  ok       $1"; }
did()  { echo "  install  $1"; }
miss() { echo "  MISSING  $1"; MISSING="$MISSING
  - $1"; }
todo() { echo "  todo     $1"; TODO="$TODO
  $1"; }
note() { echo "           $1"; }
have() { command -v "$1" >/dev/null 2>&1; }
installing() { [ "$MODE" != check ]; }

OS=$(uname)
PIO_HOME=${PLATFORMIO_CORE_DIR:-$HOME/.platformio}
PIO_PENV=$PIO_HOME/penv/bin
if [ -d "$HOME/.cargo/bin" ]; then
  case ":$PATH:" in *":$HOME/.cargo/bin:"*) ;; *) PATH="$HOME/.cargo/bin:$PATH" ;; esac
fi
export PATH

echo "Specter Studio development setup ($OS, mode: $MODE)"

# --- system parts -------------------------------------------------------------------------------------------
echo
echo "System"
if [ "$OS" = Darwin ]; then
  if xcode-select -p >/dev/null 2>&1; then
    ok "Apple Command Line Tools ($(xcode-select -p))"
  elif installing; then
    xcode-select --install 2>/dev/null || true
    echo "Install Apple's Command Line Tools in the window that opened, then run scripts/setup.sh again." >&2
    exit 1
  else
    miss "Apple Command Line Tools: xcode-select --install"
  fi
  have brew || [ ! -x /opt/homebrew/bin/brew ] || eval "$(/opt/homebrew/bin/brew shellenv)"
  have brew || [ ! -x /usr/local/bin/brew ] || eval "$(/usr/local/bin/brew shellenv)"
  if have brew; then
    ok "Homebrew ($(brew --prefix))"
    if installing; then
      did "Homebrew packages from the Brewfile (node, rustup, esptool)"
      brew bundle --file=Brewfile
    elif brew bundle check --file=Brewfile >/dev/null 2>&1; then
      ok "Brewfile packages (node, rustup, esptool)"
    else
      miss "Brewfile packages: brew bundle --file=Brewfile"
    fi
    # Homebrew's rustup is keg-only: rustc and cargo are in its own bin folder, not on PATH
    if RUSTUP_PREFIX=$(brew --prefix rustup 2>/dev/null) && [ -d "$RUSTUP_PREFIX/bin" ]; then
      case ":$PATH:" in
        *":$RUSTUP_PREFIX/bin:"*) ;;
        *) PATH="$RUSTUP_PREFIX/bin:$PATH"; PATH_HINT="export PATH=\"$RUSTUP_PREFIX/bin:\$PATH\"" ;;
      esac
    fi
  else
    miss "Homebrew (it asks for your administrator password, so run it yourself):"
    note '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    note "then the two 'Next steps' lines it prints (brew shellenv), then scripts/setup.sh again"
    if installing; then exit 1; fi
  fi
else
  # Tauri's Linux parts (https://v2.tauri.app/start/prerequisites/)
  if have pkg-config && pkg-config --exists webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 openssl librsvg-2.0 2>/dev/null; then
    ok "WebKitGTK 4.1, libsoup 3, OpenSSL, librsvg (webkit2gtk $(pkg-config --modversion webkit2gtk-4.1))"
  else
    miss "Tauri's system packages (needs sudo, run it yourself):"
    if have apt-get; then
      note "sudo apt update && sudo apt install -y build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev python3-venv"
    elif have dnf; then
      note "sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel python3 && sudo dnf group install -y c-development"
    elif have pacman; then
      note "sudo pacman -Syu --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool python"
    else
      note "see https://v2.tauri.app/start/prerequisites/ (Linux) for your distribution"
    fi
  fi
  if have cc; then ok "C compiler ($(cc --version 2>/dev/null | head -n 1))"
  else miss "a C compiler (build-essential / base-devel, above)"; fi
fi

# --- libclang: Studio's core builds the C littlefs with bindgen, which loads libclang (docs/BUILDING.md) ------
libclang_found() {
  XC=$(xcode-select -p 2>/dev/null || true)
  for f in "${LIBCLANG_PATH:-/nonexistent}"/libclang.* "$XC"/usr/lib/libclang.dylib "$XC"/Toolchains/XcodeDefault.xctoolchain/usr/lib/libclang.dylib \
           /usr/lib/llvm-*/lib/libclang*.so* /usr/lib/libclang*.so* /usr/lib64/libclang*.so* /usr/lib/*/libclang*.so*; do
    [ -e "$f" ] && return 0
  done
  return 1
}
if libclang_found; then ok "libclang (for bindgen)"
elif [ "$OS" = Darwin ]; then
  if installing && have brew; then
    did "LLVM (libclang) with Homebrew"; brew install llvm
    todo "add to ~/.zprofile: export LIBCLANG_PATH=\"$(brew --prefix llvm)/lib\""
  else
    miss "libclang: xcode-select --install, or brew install llvm and add to ~/.zprofile: export LIBCLANG_PATH=\"\$(brew --prefix llvm)/lib\""
  fi
else
  if have apt-get; then miss "libclang (needs sudo, run it yourself): sudo apt install -y libclang-dev"
  elif have dnf; then miss "libclang (needs sudo, run it yourself): sudo dnf install -y clang-devel"
  elif have pacman; then miss "libclang (needs sudo, run it yourself): sudo pacman -S --needed clang"
  else miss "libclang (your distribution's clang or libclang package)"; fi
fi

# --- git, Node, Rust ------------------------------------------------------------------------
echo
echo "Tools"
if have git; then ok "git ($(git --version | sed 's/git version //'))"
else miss "git (macOS: the Command Line Tools; Linux: your package manager, for example sudo apt install git)"; fi
if have node; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then ok "Node.js $(node -v), npm $(npm -v 2>/dev/null)"
  else miss "Node.js 20 or newer (found $(node -v)): macOS brew upgrade node; Linux https://nodejs.org or nvm (nvm install 22)"; fi
else
  miss "Node.js 20 or newer: macOS brew install node; Linux https://nodejs.org or nvm (nvm install 22, no sudo)"
fi
if have rustup; then
  ok "rustup ($(rustup --version 2>/dev/null | head -n 1))"
elif installing && [ "$OS" != Darwin ] && ! have rustc; then
  did "rustup into ~/.cargo (https://sh.rustup.rs)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  PATH="$HOME/.cargo/bin:$PATH"
elif have rustc; then
  ok "Rust $(rustc --version | cut -d' ' -f2) without rustup (works if new enough; rustup is recommended: https://rustup.rs)"
else
  miss "rustup: macOS brew install rustup; Linux curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

# --- PlatformIO and esptool ---------------------------------------------------------------------------------
# Studio's USB install runs ~/.platformio/penv/bin/python with ~/.platformio/packages/tool-esptoolpy/esptool.py,
# so PlatformIO Core goes into ~/.platformio with the official installer (Homebrew's or pipx's has no penv).
if [ -x "$PIO_PENV/pio" ]; then
  ok "PlatformIO Core in $PIO_HOME ($("$PIO_PENV/pio" --version 2>/dev/null | sed 's/.*version //'))"
elif installing && have python3; then
  did "PlatformIO Core into $PIO_HOME (official installer, get-platformio.py)"
  mkdir -p "$PIO_HOME"
  python3 -c "import urllib.request,sys; urllib.request.urlretrieve('https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py', sys.argv[1])" "$PIO_HOME/get-platformio.py"
  python3 "$PIO_HOME/get-platformio.py"
else
  miss "PlatformIO Core in $PIO_HOME (the official installer: https://docs.platformio.org/en/latest/core/installation/)"
  if have pio; then note "a pio is on PATH ($(command -v pio)), but Studio's USB install needs the one in $PIO_HOME"; fi
fi
if [ -x "$PIO_PENV/pio" ]; then
  have pio || todo "optional, pio in new terminals: add to ~/.zprofile (macOS) or ~/.profile (Linux): export PATH=\"\$PATH:$PIO_PENV\""
  if ls -d "$PIO_HOME"/packages/tool-esptoolpy* >/dev/null 2>&1; then
    ok "esptool for Studio's USB install ($PIO_HOME/packages/tool-esptoolpy)"
  elif installing; then
    did "esptool (PlatformIO package tool-esptoolpy)"
    "$PIO_PENV/pio" pkg install --global --tool platformio/tool-esptoolpy
  else
    miss "esptool for Studio's USB install: $PIO_PENV/pio pkg install --global --tool platformio/tool-esptoolpy"
  fi
fi
if have esptool || have esptool.py; then ok "esptool on PATH ($(command -v esptool || command -v esptool.py))"
else note "esptool on PATH: optional (Studio uses PlatformIO's; macOS brew install esptool, Linux pipx install esptool)"; fi

# --- USB serial ---------------------------------------------------------------------------------------------
echo
echo "USB (ESP32 DevKit: a CP210x or CH340 chip next to its USB socket)"
if [ "$OS" = Darwin ]; then
  note "macOS has drivers for both chips: the board shows up as /dev/cu.usbserial-* or /dev/cu.wchusbserial*."
  note "No port? Use a data cable (not charge-only); then install the chip maker's driver (Silicon Labs CP210x"
  note "VCP, or WCH CH34x) and allow it in System Settings > Privacy & Security."
else
  grp=dialout
  if getent group uucp >/dev/null 2>&1 && ! getent group dialout >/dev/null 2>&1; then grp=uucp; fi
  if id -nG | tr ' ' '\n' | grep -qx "$grp"; then ok "serial ports: you are in the $grp group"
  else todo "serial ports (run it yourself, then log out and in): sudo usermod -aG $grp \$USER"; fi
  if [ -f /etc/udev/rules.d/99-platformio-udev.rules ]; then ok "PlatformIO udev rules"
  else note "optional, PlatformIO's udev rules: curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core/develop/platformio/assets/system/99-platformio-udev.rules | sudo tee /etc/udev/rules.d/99-platformio-udev.rules"; fi
  note "Linux has drivers for CP210x and CH340 built in."
fi

if [ -n "$MISSING" ]; then
  echo
  echo "Missing:$MISSING"
  echo "Install those, then run scripts/setup.sh again."
  exit 1
fi
if [ "$MODE" != all ]; then
  echo
  if [ -n "$TODO" ]; then echo "Still to do yourself:$TODO"; fi
  echo "Tools: all there."
  exit 0
fi

# --- this checkout ------------------------------------------------------------------------------------------
echo
echo "This checkout"
if have rustup; then
  rustup show active-toolchain >/dev/null 2>&1 || rustup default stable
  rustup toolchain install   # the toolchain rust-toolchain.toml names, when not installed yet
fi
ok "$(rustc --version)"

if git -c protocol.file.allow=always submodule update --init; then
  ok "firmware submodule at $(git -C firmware rev-parse --short HEAD)"
else
  echo "The firmware submodule did not check out." >&2
  echo "Check the internet connection and run scripts/setup.sh again." >&2
  exit 1
fi
did "npm packages (npm ci)"
npm ci
did "practice board (scripts/build-sim.sh)"
PATH="$PATH:$PIO_PENV" ./scripts/build-sim.sh

echo
if [ -n "$TODO" ]; then echo "Still to do yourself:$TODO"; echo; fi
echo "Ready: npm run tauri dev"
if [ -n "${PATH_HINT:-}" ]; then
  echo "For rustc and cargo in new terminals, add this line to ~/.zprofile:"
  echo "  $PATH_HINT"
fi
