#!/usr/bin/env python3
"""The generic release that comes with Studio (core/src/fwtypes.rs bundled_dir): built from the firmware submodule,
so the stock firmware and the Proptroller board are offered offline and before any release is published.

    python3 scripts/bundle-firmware.py [--pico]

Builds the ESP32 DevKit firmware (pio run -e esp32dev), merges its first-flash image (bootloader, partition table,
otadata and firmware from 0x0, as the firmware's tools/release.py does) and writes src-tauri/bundled-firmware/:
generic-esp32-devkit-<v>.bin (update image), first-flash-esp32-devkit-<v>.bin and proptroller-firmware.json (the
release manifest, PROTOCOL.md "Releases"). --pico adds the Pico W and Pico 2 W (their bootloader merge included).
Needs PlatformIO. Build output stays in the firmware's .pio folder and in src-tauri/bundled-firmware.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARD = os.path.join(ROOT, "firmware", "firmware", "arduino")
OUT = os.path.join(ROOT, "src-tauri", "bundled-firmware")
PIO_HOME = os.environ.get("PLATFORMIO_CORE_DIR", os.path.join(os.path.expanduser("~"), ".platformio"))
BUILD = os.path.join(ARD, ".pio", "build")


def pio():
    found = shutil.which("pio")
    if found:
        return found
    for p in (os.path.join(PIO_HOME, "penv", "bin", "pio"), os.path.join(PIO_HOME, "penv", "Scripts", "pio.exe")):
        if os.path.exists(p):
            return p
    sys.exit("bundle-firmware: PlatformIO (pio) is not installed: scripts/setup.sh installs it")


def python():
    for p in (os.path.join(PIO_HOME, "penv", "bin", "python"), os.path.join(PIO_HOME, "penv", "Scripts", "python.exe")):
        if os.path.exists(p):
            return p
    return sys.executable


def entry(path, mcu, first_flash=False):
    with open(path, "rb") as f:
        data = f.read()
    e = {"fw": "generic", "impl": "cpp", "mcu": mcu, "board": "proptroller", "file": os.path.basename(path),
         "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if first_flash:
        e["first_flash"] = True
    return e


def main(argv):
    pico = "--pico" in argv
    version = open(os.path.join(ROOT, "firmware", "firmware", "VERSION")).read().strip()
    envs = ["esp32dev"] + (["picow", "pico2w", "boot_rp2040", "boot_rp2350"] if pico else [])
    args = [pio(), "run"]
    for e in envs:
        args += ["-e", e]
    subprocess.check_call(args, cwd=ARD)
    # the firmware build regenerates a committed header; keep the submodule clean
    subprocess.call(["git", "-C", os.path.join(ROOT, "firmware"), "checkout", "--",
                     "firmware/arduino/lib/proptroller/src/proptroller/web_assets.h"], stderr=subprocess.DEVNULL)
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    updates, firsts = [], []
    app = os.path.join(BUILD, "esp32dev", "firmware.bin")
    upd = os.path.join(OUT, "generic-esp32-devkit-%s.bin" % version)
    shutil.copyfile(app, upd)
    updates.append(entry(upd, "esp32-devkit"))
    merged = os.path.join(OUT, "first-flash-esp32-devkit-%s.bin" % version)
    boot_app0 = os.path.join(PIO_HOME, "packages", "framework-arduinoespressif32", "tools", "partitions", "boot_app0.bin")
    esptool = os.path.join(PIO_HOME, "packages", "tool-esptoolpy", "esptool.py")
    subprocess.check_call([python(), esptool, "--chip", "esp32", "merge_bin", "-o", merged, "--flash_mode", "dio",
                           "--flash_freq", "40m", "--flash_size", "4MB",
                           "0x1000", os.path.join(BUILD, "esp32dev", "bootloader.bin"),
                           "0x8000", os.path.join(BUILD, "esp32dev", "partitions.bin"),
                           "0xE000", boot_app0, "0x10000", app])
    firsts.append(entry(merged, "esp32-devkit", True))
    if pico:
        for name, env in (("pico-w", "picow"), ("pico2-w", "pico2w")):
            subprocess.check_call([python(), os.path.join("tools", "picoboot_image.py"), "merge", name], cwd=ARD)
            u = os.path.join(OUT, "generic-%s-%s.bin" % (name, version))
            shutil.copyfile(os.path.join(BUILD, env, "firmware.bin"), u)
            updates.append(entry(u, name))
            f = os.path.join(OUT, "first-flash-%s-%s.uf2" % (name, version))
            shutil.copyfile(os.path.join(BUILD, "picoboot-" + name, "flash.uf2"), f)
            firsts.append(entry(f, name, True))
    with open(os.path.join(OUT, "proptroller-firmware.json"), "w") as f:
        json.dump({"version": version, "images": updates + firsts}, f, indent=1)
    print("bundled firmware %s: %s" % (version, ", ".join(e["file"] for e in updates + firsts)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
