# Building Specter Studio

Local development and Linux desktop builds are in the README (`scripts/build-desktop.sh deb`). This page is
about the other systems.

## macOS installer on a Mac

```sh
scripts/setup.sh                # once: tools, Rust, the submodule, npm ci
scripts/build-macos.sh          # Specter Studio.app and Specter Studio_<version>_<arch>.dmg
```

It runs `scripts/build-desktop.sh app,dmg --target <this Mac's triple>` (practice board, firmware library,
wiring guides from the submodule) and prints where the `.dmg` is: `target/<triple>/release/bundle/dmg/`.
`TARGET=x86_64-apple-darwin` names the other processor, but the simulator is always built for this Mac, so build
each architecture on its own kind of Mac (as CI does). Signing is ad-hoc (`APPLE_SIGNING_IDENTITY=-`) unless
that variable names a Developer ID identity; with `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` set as well,
Tauri notarizes. An ad-hoc build runs on the Mac that built it; another Mac asks once (System Settings, Privacy
& Security, Open Anyway).

## Windows and macOS installers from Linux: CI

Short answer: the installers for Windows and macOS are built on Windows and macOS machines, which GitHub
Actions provides (`.github/workflows/build.yml`). A Linux computer cannot build macOS apps at all; it can
build the Windows NSIS installer (`scripts/build-windows.sh`), which Tauri calls a less tested last resort.
Checked 2026-10-22 against the Tauri docs ("Windows Installer", updated 2026-10-16; "GitHub" pipeline page,
updated 2026-06-29) and by trying it on the development machine.

| | From Linux | In CI |
|---|---|---|
| Linux `.deb`, AppImage | yes (`scripts/build-desktop.sh deb`) | `ubuntu-22.04` |
| Windows NSIS `-setup.exe` | yes, `scripts/build-windows.sh` (unsigned, no practice board, "less tested"; see below) | `windows-latest` (NSIS and `.msi`) |
| Windows `.msi` | no (Tauri builds MSI only on Windows) | `windows-latest` |
| macOS `.app`, `.dmg` | no (needs Apple's SDK; signing and notarizing need a Mac) | `macos-latest` (Apple silicon), `macos-15-intel` (Intel) |
| Firmware for boards (ESP32, Pico) | yes, the same on every system | not needed |
| Extensions (plugins) | nothing to build (HTML and JavaScript loaded at run time) | not needed |

### Windows from Linux (only if CI is not an option)

Tauri documents a cross build with `cargo-xwin` as a last resort, less tested than native builds, NSIS only.
`cargo-xwin` downloads Microsoft's C runtime and Windows SDK, and its README says: "By using this software
you are consented to accept the license at https://go.microsoft.com/fwlink/?LinkId=2086102". The owner
accepted that licence on 2026-10-22. The result is unsigned (SmartScreen warns) and has no practice board
(the `externalBin: []` overlay drops the simulator, see "Simulator" below). No `.msi` this way.

With root, Tauri's recipe is `sudo apt install nsis lld llvm clang` plus `cargo install --locked cargo-xwin`.
The development machine has no sudo, so the working recipe (2026-10-22, rustc 1.99.0, cargo-xwin 0.23.1,
Tauri CLI from `package.json`) puts the missing tools in `~/.local/opt`. System `clang`, `clang-cl` and
`lld-link` (Ubuntu clang 21) were already there; `makensis` and `llvm-rc`/`llvm-lib` were not.

```sh
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin

# llvm-rc, llvm-lib (and llvm-objdump for checking): the official LLVM release, verified with its sigstore
# attestation (sha256 efdd1dbd089b99bfcfcde7b8eb1236163f2e88df5a981cca4f783ec9cb5e0378, built by
# llvm/llvm-project release-binaries.yml@llvmorg-23.1.4)
python3 -m venv ~/.local/opt/buildtools-venv && ~/.local/opt/buildtools-venv/bin/pip install sigstore scons
curl -LO https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.4/LLVM-23.1.4-Linux-X64.tar.zst
curl -LO https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.4/LLVM-23.1.4-Linux-X64.tar.zst.jsonl
~/.local/opt/buildtools-venv/bin/python -m sigstore verify github --repository llvm/llvm-project \
  --bundle LLVM-23.1.4-Linux-X64.tar.zst.jsonl LLVM-23.1.4-Linux-X64.tar.zst
zstd -dc --long=31 LLVM-23.1.4-Linux-X64.tar.zst | tar -x -C ~/.local/opt --wildcards \
  '*/bin/llvm-rc' '*/bin/llvm-ar' '*/bin/llvm-lib' '*/bin/llvm-dlltool' '*/bin/llvm-objdump'   # only these

# makensis: built for Linux from the official source, with the Windows stubs, plugins and includes from the
# official zip (SourceForge "NSIS 3/3.13"; MD5s matched the SourceForge listing: src 3f992d176c50fb653cf0230eed38cfea,
# zip 530e3623c077cba879ed2ae6e13be362; sha256 src a8ffe024602d46b6d766f9e1ce30c324ad2a24daeacd3efc2642d436a0c157ac,
# zip ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8). Needs g++ and zlib headers.
tar xjf nsis-3.13-src.tar.bz2 && cd nsis-3.13-src
~/.local/opt/buildtools-venv/bin/scons VERSION=3.13 SKIPSTUBS=all SKIPPLUGINS=all SKIPUTILS=all SKIPMISC=all \
  NSIS_CONFIG_CONST_DATA_PATH=no PREFIX=$PWD/out install-compiler
mkdir -p ~/.local/opt/nsis-3.13/Bin && cp out/makensis ~/.local/opt/nsis-3.13/Bin/
unzip nsis-3.13.zip && cp -r nsis-3.13/{Stubs,Plugins,Include,Contrib,nsisconf.nsh,COPYING} ~/.local/opt/nsis-3.13/
# makensis looks for its data one level above its own folder, hence Bin/

SPECTER_GUIDES_DIR=<firmware checkout>/docs/wiring-guides/html scripts/build-windows.sh
```

`scripts/build-windows.sh` puts those tools on PATH, keeps the build off `/tmp` (`CARGO_TARGET_DIR=
~/.cache/cargo-target/studio-win`, `XWIN_CACHE_DIR=~/.cache/cargo-xwin`, `TMPDIR=~/.cache/tmp`), copies
the wiring guides and runs

```sh
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc \
  --config src-tauri/tauri.bundle.conf.json --config '{"bundle":{"externalBin":[]}}' --bundles nsis
```

The installer lands in `~/.cache/cargo-target/studio-win/x86_64-pc-windows-msvc/release/bundle/nsis/`.
First run (2026-10-22): about 5 minutes with an empty target directory, `Specter Studio_0.1.0_x64-setup.exe`, 20.45 MiB, with
the firmware library and template (132 files) and the wiring guides (367 files), no `proptroller-sim`. The
C build scripts (`ring`, `aws-lc-sys`, `psm`, `stacker`) compiled with clang-cl against the xwin SDK; no NASM
was needed. The app's PE imports are the Universal CRT (`api-ms-win-crt-*`) and system DLLs only, no
`VCRUNTIME140.dll`, so it needs no VC++ redistributable; WebView2 is fetched by the installer's bootstrapper
if missing (per-user install). Not run on Windows yet (no Windows machine or wine here); makensis warns
`-OUTPUTCHARSET is disabled for non Win32 platforms`, which is harmless, and Tauri skips signing on Linux.

macOS stays CI-only: no osxcross (it needs Apple's SDK, which Apple licenses for use on Apple hardware), and
signing and notarizing need a Mac anyway.

What happened before the tools and the licence approval (tried 2026-10-22): `cargo check --target x86_64-pc-windows-gnu` and
`--target aarch64-apple-darwin` both stop in C build scripts (`ring`, `aws-lc-sys`, `psm`, `stacker`)
because there is no Windows or macOS C library to compile against. `mingw-w64` (system package) would allow
Windows GNU check builds; nothing short of Apple's SDK allows macOS ones.

## The CI workflow

`.github/workflows/build.yml` runs on pushes to `main`, tags `v*`, pull requests and by hand:

Every job first checks out the firmware submodule with `scripts/ci-firmware-submodule.sh` (below).

1. **tests (Linux)**: `npm test`, the frontend build, the simulated board, `cargo test --workspace` (the
   device layer against the real simulated board, including a real firmware build; PlatformIO is cached).
2. **e2e (Linux)**: the Playwright tests (`tests/e2e`, `playwright.config.ts`) in the runner's Google Chrome
   against the real bridge, real simulated boards, the embedded MQTT broker and the GitHub mock: the simulated
   board, the bridge built first, then `npx playwright test --retries=1`. The retry is there because the tests
   drive real boards and servers with wall-clock waits: a test that passes on its second try shows as "flaky" in
   the summary without failing the job, and a test that fails twice fails it. Traces and screenshots are kept
   for 7 days when it fails. The installers do not wait for it.
3. **installers**, one job per system: `npm test`, the simulated board (named for the target), the wiring
   guides, then `tauri-apps/tauri-action` with `--config src-tauri/tauri.bundle.conf.json --target <triple>
   --bundles <list>`. The installers are uploaded as workflow artifacts (`specter-studio-<triple>`, kept 14
   days).
4. **release** (pushed `v*` tags only): downloads this run's installers and puts them, with `SHA256SUMS.txt`,
   on the tag's GitHub release. It creates the release when there is none (a pre-release when the tag has a
   `-`, e.g. `v0.1.0-rc.2`) and replaces same-named files on an existing one. To release: push the tag
   (`git tag v0.1.0-rc.2 && git push origin v0.1.0-rc.2`), or re-run the workflow on the tag.

Actions are pinned by commit SHA with the tag in a comment.

The tauri arguments were checked on Linux (2026-10-22): `--config src-tauri/tauri.bundle.conf.json --target
x86_64-unknown-linux-gnu --bundles deb` bundles the sidecar; adding the `externalBin: []` overlay builds the
same `.deb` without it (resources kept), which is how the Windows job works.

### The firmware submodule in CI

The submodule URL is the public firmware repository (`https://github.com/speck0413/specter-proptroller.git`).
`scripts/ci-firmware-submodule.sh` checks out the pinned commit from there, with no token. When the pin is a
development commit that is only on the private `specter-proptroller-dev` (not published yet), that fails, and the
script tries the development repository with the `FIRMWARE_REPO_TOKEN` secret, sent as an HTTP header for that
one command and never stored in `.git/config`. Without the secret every job stops at that step with an error
naming the pin. Pinning a published commit needs no secret.

### Repository settings it needs

| Name | Kind | Needed | What |
|---|---|---|---|
| `FIRMWARE_REPO_TOKEN` | secret | only while the submodule pins an unpublished development commit | fine-grained token, repository access `speck0413/specter-proptroller-dev`, permission Contents: read-only. Also used for the `GUIDES_REF` checkout when set |
| `FIRMWARE_DEV_REPO` | variable | no | `owner/name` of the development repository, when it is not `speck0413/specter-proptroller-dev` |
| `GUIDES_REF` | variable | for installers with the wiring guides | ref of `specter-proptroller` with `docs/wiring-guides/html` when the pinned submodule commit has none. Without guides the installers say they are not installed |

### Signing (later; installers are unsigned until these are set)

Unsigned installers work but warn: Windows SmartScreen says "unknown publisher" (More info, Run anyway);
macOS refuses at first and needs System Settings, Privacy & Security, Open Anyway. The workflow ad-hoc signs
macOS apps (`APPLE_SIGNING_IDENTITY=-`) so that Apple silicon runs them at all.

macOS (Apple Developer Program), as repository secrets; the workflow passes on only the ones that are set:

| Secret | What |
|---|---|
| `APPLE_CERTIFICATE` | the "Developer ID Application" certificate exported as `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization: Apple ID, an app-specific password, team ID |

Windows: an OV/EV certificate or Azure Trusted Signing. Tauri signs with `bundle.windows.certificateThumbprint`
(certificate imported on the runner) or a `bundle.windows.signCommand` (e.g. `trusted-signing-cli`); add the
matching secrets and a config overlay when a certificate exists.

## Simulator (practice board) per system

The sidecar is the firmware's own `sim` build (`scripts/build-sim.sh`, PlatformIO `native` platform with the
system's C++ compiler). It is built on each system for that system; there is no cross build. `SIM_TARGET=<rust
triple>` only names the file for `tauri build --target`. Tauri looks for
`src-tauri/binaries/proptroller-sim-<triple>` (`.exe` on Windows).

- Linux: builds (gcc). Checked locally.
- macOS: builds (Apple clang), checked on macOS 26 with the firmware's `macos-host-builds` changes:
  espMqttClient's POSIX client is opened to `__APPLE__` by `tools/emc_posix_apple.py`, and the strict flags
  leave out clang's `-Wsign-conversion` (GCC has none for C++).
- Windows: does not build. `net/posix.cpp` and `posix.h` are compiled only on `__unix__` / `__APPLE__`, so
  `main_sim.cpp` has no network layer. The fix belongs in the firmware repository: a Winsock version
  (`WSAStartup`, `closesocket`, `ioctlsocket(FIONBIO)`, `WSAGetLastError() == WSAEWOULDBLOCK`, no SIGPIPE, link
  `ws2_32`) and a compiler on the runner (MSYS2 MinGW, which the Windows runners carry, or clang-cl). Until
  then the Windows installer is built without the sidecar (`externalBin: []`), so it has no practice board, and
  the sim-backed `cargo test` cases run only on Linux.
- Universal macOS (one `.dmg` for both): needs a `lipo`'d sidecar named `-universal-apple-darwin`; the
  workflow builds two `.dmg`s instead.

## Platform notes from reading the code (2026-10-22)

- **libclang for the board package image.** `core` builds the C littlefs through the `littlefs2-sys` crate
  (`core/src/fsimage.rs`), whose build script runs bindgen and needs libclang at build time (the C compiler alone
  is not enough). `scripts/setup.sh` / `setup.ps1` check it. Linux: `sudo apt install libclang-dev` (dnf:
  `clang-devel`, pacman: `clang`). macOS: Apple's Command Line Tools bring it; if bindgen still does not find it,
  `brew install llvm` and `export LIBCLANG_PATH="$(brew --prefix llvm)/lib"`. Windows: `winget install LLVM.LLVM`
  and `setx LIBCLANG_PATH "C:\Program Files\LLVM\bin"`. CI: `libclang-dev` with the Linux packages, the runner's
  LLVM on Windows (`LIBCLANG_PATH` set by the workflow), Xcode's libclang on macOS. A build that cannot find it
  stops in `littlefs2-sys` with bindgen's "Unable to find libclang".

- **Console windows on Windows.** The release app is a GUI program (`windows_subsystem = "windows"`), and
  none of the six `Command::new` calls (simulator, `pio`, Python, esptool, PlatformIO installer) sets
  `CREATE_NO_WINDOW` (`std::os::windows::process::CommandExt::creation_flags(0x0800_0000)`), so each launch
  flashes a console window.
- **Wiring-guide media types.** The guides are served through the `plugin` scheme with a type from
  `core/src/plugins.rs` `mime()`, which has no `m4a`, `opus` or `webp`, so the narration and pictures go out as
  `application/octet-stream`, without byte ranges. WKWebView (macOS) is the strictest about this, and the AAC
  `.m4a` fallback exists for Safari's sake, so it may not help unless `m4a` -> `audio/mp4`, `opus` ->
  `audio/ogg` (or `audio/opus`) and `webp` -> `image/webp` are added; check audio playback on a Mac.
- **Serial ports on macOS.** Every USB device appears twice, `/dev/cu.*` and `/dev/tty.*`; the list only
  drops `/dev/ttyS*`. Uploads and the monitor should use `cu.*`; hiding `tty.*` would avoid the duplicates.
- **Folders on Windows.** "My Props" and "Backups" are `%USERPROFILE%\Documents\...`; when OneDrive redirects
  Documents, that is not the folder people see as Documents (the Known Folder API or the `dirs` crate gives
  the right one). The Pico bootloader cache uses `%LOCALAPPDATA%\.cache\specter-studio`, which works but is
  unusual. `HOME` is read first, and Git Bash sets it, so the path can differ between launches from a terminal
  and from the Start menu.
- **Plugins on Windows.** WebView2 serves custom schemes as `http://<scheme>.localhost`; `src/api.ts` and the
  CSP already handle `http://plugin.localhost`.
- **Python on Windows.** The PlatformIO installer runs `python`, which on a clean Windows is the Microsoft
  Store stub; `py` (the launcher) is more reliable.
- **USB flashing.** esptool and the Pico copy go through PlatformIO's own Python and its drivers. Windows may need
  the CP210x / CH340 USB-serial drivers for many ESP32 boards (check on each system). BOOTSEL drives
  are found under `/Volumes` (macOS) and drive letters D-Z (Windows).
- **Firmware builds** for boards (`esp32dev`, `pico`, `picow`, `pico2w`, `boot_*`) are the same on every
  system: PlatformIO downloads the toolchain for the system it runs on. The `native`, `sim`, `fuzz_*` and
  `native_asan` environments are POSIX only.
