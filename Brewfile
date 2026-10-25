# macOS development tools (scripts/setup.sh runs `brew bundle`). Xcode's Command Line Tools come first
# (`xcode-select --install`): Apple clang builds the simulator and the Rust crates' C code. PlatformIO is not
# here: setup.sh puts it in ~/.platformio with the official installer, where Studio's USB install finds esptool.
brew "node"        # the frontend and the Tauri CLI (Node 20+)
brew "rustup"      # Rust; keg-only, so its bin folder goes on PATH by hand (setup.sh says how)
brew "esptool"     # esptool on PATH, for flashing by hand without Studio
