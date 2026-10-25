# Development setup for Windows, safe to run again. It says what it checks and what it installs.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1            check, and list the commands for what is missing
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Install   also install the missing tools with winget,
#                                                                          then set up this checkout
#
# Tools: Git (with Git Bash), Node.js 20+, Rust (rustup), Python 3, PlatformIO Core in %USERPROFILE%\.platformio
# (Studio's USB install runs esptool from there), esptool, and Tauri's system parts (Microsoft C++ Build Tools,
# WebView2). Windows asks for administrator approval for some winget installs (Build Tools, Git, Node.js); that
# prompt is yours to answer, nothing is elevated behind your back. The practice board (simulator) does not build on
# Windows yet, so Studio starts without one. macOS and Linux: scripts/setup.sh.
param([switch]$Install, [switch]$ToolsOnly)
$ErrorActionPreference = 'Continue'   # native tools write to stderr; exit codes are checked
Set-Location (Join-Path $PSScriptRoot '..')

$script:missing = @()
$script:todo = @()
function Ok($t)   { Write-Host "  ok       $t" }
function Did($t)  { Write-Host "  install  $t" }
function Miss($t) { Write-Host "  MISSING  $t"; $script:missing += $t }
function Todo($t) { Write-Host "  todo     $t"; $script:todo += $t }
function Note($t) { Write-Host "           $t" }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $cargo = Join-Path $env:USERPROFILE '.cargo\bin'
  if ((Test-Path $cargo) -and ($env:Path -notlike "*$cargo*")) { $env:Path = "$cargo;$env:Path" }
}
# winget package: install with -Install, else print the command
function WingetInstall($id, $what, $extra = '') {
  $cmd = "winget.exe install --id $id -e --source winget --accept-package-agreements --accept-source-agreements $extra".Trim()
  if ($Install) {
    if (-not (Have 'winget.exe')) { Miss "$what (no winget: install 'App Installer' from the Microsoft Store)"; return }
    Did "$what ($cmd)"
    Invoke-Expression $cmd
    if ($LASTEXITCODE -ne 0) { Miss "$what (winget exit $LASTEXITCODE): $cmd" }
    Refresh-Path
  } else {
    Miss "${what}: $cmd"
  }
}

Refresh-Path
$mode = if ($Install) { 'install' } else { 'check' }
Write-Host "Specter Studio development setup (Windows, mode: $mode)"

Write-Host ''
Write-Host 'System'
# Microsoft C++ Build Tools (MSVC and the Windows SDK) for Rust and Tauri
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvc = $null
if (Test-Path $vswhere) { $msvc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if ($msvc) { Ok "Microsoft C++ Build Tools ($msvc)" }
else {
  Note 'Microsoft C++ Build Tools: needs administrator approval (a few GB, takes a while)'
  WingetInstall 'Microsoft.VisualStudio.2022.BuildTools' 'Microsoft C++ Build Tools' '--override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
}
$wv = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wvUser = 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if ((Test-Path $wv) -or (Test-Path $wvUser)) { Ok 'WebView2 runtime' }
else { WingetInstall 'Microsoft.EdgeWebView2Runtime' 'WebView2 runtime' }

# libclang: Studio's core builds the C littlefs with bindgen, which loads libclang (docs/BUILDING.md)
$llvm = if ($env:LIBCLANG_PATH -and (Test-Path (Join-Path $env:LIBCLANG_PATH 'libclang.dll'))) { $env:LIBCLANG_PATH } elseif (Test-Path 'C:\Program Files\LLVM\bin\libclang.dll') { 'C:\Program Files\LLVM\bin' } else { $null }
if ($llvm) {
  Ok "libclang ($llvm)"
  if (-not $env:LIBCLANG_PATH) { Todo "setx LIBCLANG_PATH ""$llvm""   (then open a new terminal; bindgen finds libclang there)" }
} else {
  WingetInstall 'LLVM.LLVM' 'LLVM (libclang, for bindgen)'
  Todo 'setx LIBCLANG_PATH "C:\Program Files\LLVM\bin"   (then open a new terminal)'
}

Write-Host ''
Write-Host 'Tools'
if (Have 'git') { Ok "git ($((git --version) -replace 'git version ',''))" } else { WingetInstall 'Git.Git' 'Git (with Git Bash)' }
if (Have 'gh') {
  gh auth status *> $null
  if ($LASTEXITCODE -eq 0) { Ok 'GitHub CLI, signed in' } else { Todo 'gh auth login; gh auth setup-git   (for the private repositories)' }
} else { WingetInstall 'GitHub.cli' 'GitHub CLI (signs in for the private repositories)' }
$nodeOk = $false
if (Have 'node') {
  $major = [int](((node -v) -replace '^v', '') -split '\.')[0]
  if ($major -ge 20) { Ok "Node.js $(node -v)"; $nodeOk = $true } else { Note "Node.js $(node -v) is too old (20 or newer)" }
}
if (-not $nodeOk) { WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js 20 or newer' }
if (Have 'rustup') { Ok "rustup ($((rustup --version 2>$null) | Select-Object -First 1))" } else { WingetInstall 'Rustlang.Rustup' 'Rust (rustup)' }
$py = $null
foreach ($c in @('py', 'python')) {
  if (Have $c) { $v = & $c --version 2>$null; if ($v -match 'Python 3') { $py = $c; Ok "$v ($c)"; break } }
}
if (-not $py) { WingetInstall 'Python.Python.3.12' 'Python 3 (for the PlatformIO installer)'; foreach ($c in @('py', 'python')) { if (-not $py -and (Have $c)) { $py = $c } } }

# PlatformIO Core in %USERPROFILE%\.platformio: Studio's USB install runs penv\Scripts\python.exe with
# packages\tool-esptoolpy\esptool.py from there.
$pioHome = if ($env:PLATFORMIO_CORE_DIR) { $env:PLATFORMIO_CORE_DIR } else { Join-Path $env:USERPROFILE '.platformio' }
$pio = Join-Path $pioHome 'penv\Scripts\pio.exe'
if (Test-Path $pio) { Ok "PlatformIO Core in $pioHome ($((& $pio --version) -replace '.*version ',''))" }
elseif ($Install -and $py) {
  Did "PlatformIO Core into $pioHome (official installer, get-platformio.py)"
  New-Item -ItemType Directory -Force $pioHome | Out-Null
  $inst = Join-Path $pioHome 'get-platformio.py'
  Invoke-WebRequest 'https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py' -OutFile $inst -UseBasicParsing
  & $py $inst
} else { Miss "PlatformIO Core in $pioHome (run with -Install, or https://docs.platformio.org/en/latest/core/installation/)" }
if (Test-Path $pio) {
  if (-not (Have 'pio')) { Todo "optional, pio in new terminals: add $(Split-Path $pio) to your user PATH" }
  if (Get-ChildItem (Join-Path $pioHome 'packages') -Filter 'tool-esptoolpy*' -ErrorAction SilentlyContinue) { Ok 'esptool for Studio''s USB install (tool-esptoolpy)' }
  elseif ($Install) { Did 'esptool (PlatformIO package tool-esptoolpy)'; & $pio pkg install --global --tool platformio/tool-esptoolpy }
  else { Miss "esptool for Studio's USB install: $pio pkg install --global --tool platformio/tool-esptoolpy" }
}

Write-Host ''
Write-Host 'USB (ESP32 DevKit: a CP210x or CH340 chip next to its USB socket)'
Note 'The board shows up as a COM port in Device Manager (Ports). No port, or a yellow warning sign: install the'
Note 'chip maker''s driver (Silicon Labs CP210x VCP, or WCH CH340/CH341), and use a data cable, not charge-only.'

if ($script:missing.Count) {
  Write-Host ''
  Write-Host 'Missing:'
  $script:missing | ForEach-Object { Write-Host "  - $_" }
  if ($Install) { Write-Host 'Install those, open a new terminal, then run scripts\setup.ps1 -Install again.' }
  else { Write-Host 'Run scripts\setup.ps1 -Install to install them with winget (or run the commands above yourself).' }
  exit 1
}
if (-not $Install -or $ToolsOnly) {
  Write-Host ''
  if ($script:todo.Count) { Write-Host 'Still to do yourself:'; $script:todo | ForEach-Object { Write-Host "  $_" } }
  Write-Host 'Tools: all there.'
  exit 0
}

Write-Host ''
Write-Host 'This checkout'
rustup show active-toolchain *> $null
if ($LASTEXITCODE -ne 0) { rustup default stable }
rustup toolchain install
git submodule update --init
if ($LASTEXITCODE -ne 0) {
  Write-Host 'The firmware submodule did not check out.'
  Write-Host '- Private repository: gh auth login, then gh auth setup-git, then run this again.'
  Write-Host '- The pinned commit is on the development repository until it is published:'
  Write-Host '    git config submodule.firmware.url https://github.com/speck0413/specter-proptroller-dev.git'
  exit 1
}
Did 'npm packages (npm ci)'
npm ci
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host ''
if ($script:todo.Count) { Write-Host 'Still to do yourself:'; $script:todo | ForEach-Object { Write-Host "  $_" }; Write-Host '' }
Write-Host 'Ready. Start Studio from Git Bash (npm runs scripts\ensure-sim.sh with sh): npm run tauri dev'
Write-Host 'There is no practice board on Windows yet; real boards work.'
