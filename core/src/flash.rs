//! First USB flash (firmware/FLASH-MAP.md). The plan says exactly what is written where and is checked
//! before anything touches a port; `flash` runs it only with `confirm: true` (and `dry_run` returns the plan
//! and the command without running it).
//!
//! * ESP32 DevKit: bootloader at 0x1000, partition table at 0x8000, otadata (`boot_app0.bin`, the bootloader
//!   then boots app0) at 0xE000, the app at 0x10000; DIO, 40 MHz, 4 MB. Written with esptool from
//!   PlatformIO's packages (the same tool `pio run -t upload` uses), so it equals a PlatformIO upload.
//! * Pico W / Pico 2 W: the merged `flash.uf2` (bootloader + app, `tools/picoboot_image.py merge`), copied to
//!   the board's BOOTSEL drive. Plain Pico: its `firmware.uf2`.

use crate::builder::find_pio;
use crate::fleet::sha256_hex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const ESP32_APP_MAX: u64 = 1_966_080;

pub fn pio_home() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    std::env::var("PLATFORMIO_CORE_DIR").map(PathBuf::from).unwrap_or_else(|_| Path::new(&home).join(".platformio"))
}

fn part(offset: u64, path: &Path) -> Result<Value, String> {
    let b = std::fs::read(path).map_err(|_| format!("{} is missing: build the firmware first", path.display()))?;
    Ok(json!({ "offset": format!("0x{offset:X}"), "file": path.to_string_lossy(), "bytes": b.len(), "sha256": sha256_hex(&b) }))
}

/// The flash plan for `board` (`esp32dev`, `picow`, `pico2w`, `pico`) from a build folder.
pub fn plan(board: &str, build_dir: &str) -> Result<Value, String> {
    let d = Path::new(build_dir);
    match board {
        "esp32dev" => {
            let app = d.join("firmware.bin");
            let img = std::fs::read(&app).map_err(|_| "firmware.bin is missing: build the firmware first".to_string())?;
            if img.first() != Some(&0xE9) {
                return Err("firmware.bin is not an ESP32 app image".into());
            }
            if img.len() as u64 > ESP32_APP_MAX {
                return Err(format!("the firmware is too big: {} bytes, the board takes at most {ESP32_APP_MAX}", img.len()));
            }
            let boot_app0 = std::env::var("SPECTER_BOOT_APP0").map(PathBuf::from).unwrap_or_else(|_| pio_home().join("packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"));
            Ok(json!({ "board": board, "kind": "esptool", "chip": "esp32", "flash": { "mode": "dio", "freq": "40m", "size": "4MB" },
                "parts": [part(0x1000, &d.join("bootloader.bin"))?, part(0x8000, &d.join("partitions.bin"))?, part(0xE000, &boot_app0)?, part(0x10000, &app)?] }))
        }
        "picow" | "pico2w" => {
            let name = if board == "picow" { "pico-w" } else { "pico2-w" };
            let uf2 = d.parent().unwrap_or(d).join(format!("picoboot-{name}")).join("flash.uf2");
            Ok(json!({ "board": board, "kind": "uf2", "parts": [part(0x1000_0000, &uf2)?],
                       "note": "bootloader and firmware in one file; the stored settings are kept" }))
        }
        "pico" => Ok(json!({ "board": board, "kind": "uf2", "parts": [part(0x1000_0000, &d.join("firmware.uf2"))?] })),
        _ => Err(format!("Studio cannot flash a {board} over USB")),
    }
}

/// The UF2 family of an image (its first block's family ID), if it names one.
pub fn uf2_family(bytes: &[u8]) -> Option<u32> {
    let w = |i: usize| bytes.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if w(0)? != 0x0A32_4655 || w(4)? != 0x9E5D_5157 {
        return None;
    }
    (w(8)? & 0x2000 != 0).then(|| w(28)).flatten()
}

/// The chip a UF2 family is for: `RP2040` or `RP2350`.
pub fn family_chip(family: u32) -> Option<&'static str> {
    match family {
        0xE48B_FF56 => Some("RP2040"),
        0xE48B_FF57..=0xE48B_FF5A => Some("RP2350"),
        _ => None,
    }
}

/// The chip of a board in BOOTSEL mode, from its drive's `INFO_UF2.TXT` (`Board-ID: RPI-RP2` or `RP2350`).
pub fn drive_chip(drive: &Path) -> Option<&'static str> {
    let info = std::fs::read_to_string(drive.join("INFO_UF2.TXT")).ok()?;
    let id = info.lines().find_map(|l| l.strip_prefix("Board-ID: "))?.trim().to_uppercase();
    if id.contains("RP2350") { Some("RP2350") } else if id.contains("RP2") { Some("RP2040") } else { None }
}

/// The Python that runs PlatformIO: its own `penv` (the official installer), else the Python beside the `pio` found
/// on PATH (PlatformIO installed with pip, as on CI or with a system package), else the one named in `pio`'s first
/// line, else `python3` / `python`.
pub fn pio_python() -> PathBuf {
    let penv = pio_home().join(if cfg!(windows) { "penv/Scripts/python.exe" } else { "penv/bin/python" });
    if penv.is_file() {
        return penv;
    }
    if let Some(pio) = crate::builder::find_pio() {
        if let Some(dir) = pio.parent() {
            for name in if cfg!(windows) { &["python.exe"][..] } else { &["python3", "python"][..] } {
                if dir.join(name).is_file() {
                    return dir.join(name);
                }
            }
        }
        let first = std::fs::read(&pio).ok().and_then(|b| b.split(|&c| c == b'\n').next().map(|l| String::from_utf8_lossy(l).to_string()));
        if let Some(py) = first.as_deref().and_then(|l| l.strip_prefix("#!")).map(str::trim).filter(|p| Path::new(p).is_file()) {
            return PathBuf::from(py);
        }
    }
    PathBuf::from(if cfg!(windows) { "python" } else { "python3" })
}

/// Where PlatformIO keeps esptool (installed with the ESP32 platform, on its first ESP32 build).
pub fn esptool_script() -> PathBuf {
    pio_home().join("packages/tool-esptoolpy/esptool.py")
}

/// esptool's command line for an ESP32 plan.
pub fn esptool_command(plan: &Value, port: &str) -> Vec<String> {
    let mut c = vec![pio_python().to_string_lossy().to_string(), esptool_script().to_string_lossy().to_string()];
    // the plan's chip: esp32, or esp32s3 / esp32c3 for the bare devkits
    let chip = plan["chip"].as_str().unwrap_or("esp32");
    for s in ["--chip", chip, "--port", port, "--baud", "460800", "--before", "default_reset", "--after", "hard_reset",
              "write_flash", "-z", "--flash_mode", "dio", "--flash_freq", "40m", "--flash_size", "4MB"] {
        c.push(s.to_string());
    }
    for p in plan["parts"].as_array().into_iter().flatten() {
        c.push(p["offset"].as_str().unwrap_or("").to_string());
        c.push(p["file"].as_str().unwrap_or("").to_string());
    }
    c
}

/// The flash plan for a release's first-flash image (PROTOCOL.md "Releases"), for a board `mcu` (`info.mcu`):
/// the ESP32's merged image (bootloader, partition table, otadata and firmware) from 0x0, or a Pico's UF2 for
/// its BOOTSEL drive.
pub fn release_plan(mcu: &str, file: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    let p = json!({ "offset": "0x0", "file": file.to_string_lossy(), "bytes": bytes.len(), "sha256": sha256_hex(&bytes) });
    match mcu {
        "esp32-devkit" => {
            // the merged image starts with the bootloader's padding (0xFF) up to 0x1000, where the app image magic is
            if bytes.get(0x1000) != Some(&0xE9) {
                return Err("the first-flash image is not a merged ESP32 image".into());
            }
            Ok(json!({ "board": "esp32dev", "kind": "esptool", "chip": "esp32", "flash": { "mode": "dio", "freq": "40m", "size": "4MB" }, "parts": [p] }))
        }
        // the bare devkits' ESP32-S3 and ESP32-C3 (the firmware's BARE-DEVKIT.md): their bootloader starts the merged
        // image at 0x0, its header naming the chip (9 ESP32-S3, 5 ESP32-C3)
        "esp32-s3" | "esp32-c3" => {
            let (chip, id) = if mcu == "esp32-s3" { ("esp32s3", 9u8) } else { ("esp32c3", 5u8) };
            if bytes.first() != Some(&0xE9) || bytes.get(12) != Some(&id) {
                return Err(format!("the first-flash image is not a merged {} image", mcu.to_uppercase()));
            }
            Ok(json!({ "board": mcu, "kind": "esptool", "chip": chip, "flash": { "mode": "dio", "freq": "40m", "size": "4MB" }, "parts": [p] }))
        }
        "pico-w" | "pico2-w" | "pico" => {
            if uf2_family(&bytes).is_none() {
                return Err("the first-flash image is not a UF2 file".into());
            }
            Ok(json!({ "board": crate::builder::board_for_mcu(mcu), "kind": "uf2", "parts": [p] }))
        }
        _ => Err(format!("Studio cannot install firmware on a {mcu} board over USB")),
    }
}

/// A release plan with the board package file system image (`fsimage.rs`) added: a second part of the esptool
/// write for an ESP32, or the image's blocks added to the UF2 file for a Pico (written to `dir`).
pub fn with_fs_image(plan: Value, mcu: &str, fs: &[u8], dir: &Path) -> Result<Value, String> {
    let l = crate::fsimage::layout(mcu)?;
    let mut p = plan;
    let first = PathBuf::from(p["parts"][0]["file"].as_str().unwrap_or(""));
    if p["kind"] == "esptool" {
        if p["parts"][0]["bytes"].as_u64().unwrap_or(0) > l.offset as u64 {
            return Err("the firmware image reaches into the board's file system".into());
        }
        let file = dir.join("board-package-fs.bin");
        std::fs::write(&file, fs).map_err(|e| e.to_string())?;
        p["parts"].as_array_mut().ok_or("bad plan")?.push(part(l.offset as u64, &file)?);
        return Ok(p);
    }
    let uf2 = std::fs::read(&first).map_err(|e| format!("cannot read {}: {e}", first.display()))?;
    let both = crate::fsimage::uf2_with(&uf2, l.offset, fs)?;
    let stem = first.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "firmware".into());
    let file = dir.join(format!("{stem}-with-board-package.uf2"));
    std::fs::write(&file, &both).map_err(|e| e.to_string())?;
    p["parts"][0] = json!({ "offset": "0x0", "file": file.to_string_lossy(), "bytes": both.len(), "sha256": sha256_hex(&both) });
    Ok(p)
}

/// Runs a plan: `{board, build_dir, port (ESP32) | drive (Pico), confirm, dry_run}`.
pub async fn flash(a: &Value) -> Result<Value, String> {
    let board = a["board"].as_str().ok_or("missing board")?;
    let p = plan(board, a["build_dir"].as_str().ok_or("missing build_dir")?)?;
    run(p, a).await
}

/// Runs a flash plan (from [`plan`] or [`release_plan`]): `a` gives `port` (ESP32) or `drive` (Pico), `confirm`,
/// `dry_run` and `wait_ms`.
pub async fn run(p: Value, a: &Value) -> Result<Value, String> {
    let dry = a["dry_run"] == true;
    if p["kind"] == "esptool" {
        let port = a["port"].as_str().ok_or("choose the board's USB port")?;
        let cmd = esptool_command(&p, port);
        if dry {
            return Ok(json!({ "plan": p, "command": cmd, "dry_run": true }));
        }
        if a["confirm"] != true {
            return Err("flashing needs a confirmation".into());
        }
        if find_pio().is_none() {
            return Err("PlatformIO is not installed (it brings the flashing tool)".into());
        }
        if !esptool_script().is_file() {
            return Err("flashing failed: PlatformIO has no esptool yet (it comes with the ESP32 platform: build an ESP32 firmware once)".into());
        }
        let out = tokio::process::Command::new(&cmd[0]).args(&cmd[1..]).output().await.map_err(|e| format!("flashing failed: cannot start Python for esptool ({}): {e}", cmd[0]))?;
        let log = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
        if !out.status.success() {
            let hint = if log.contains("Failed to connect") { "the board did not answer: hold its BOOT button while it starts, then try again" } else { "flashing failed (see the log)" };
            return Err(hint.into());
        }
        return Ok(json!({ "plan": p, "log": log }));
    }
    let drive = a["drive"].as_str().ok_or("put the board in BOOTSEL mode (hold BOOTSEL while plugging it in)")?;
    let src = PathBuf::from(p["parts"][0]["file"].as_str().unwrap_or(""));
    let dest = Path::new(drive).join(src.file_name().unwrap_or_default());
    if dry {
        return Ok(json!({ "plan": p, "copy": [src.to_string_lossy(), dest.to_string_lossy()], "dry_run": true }));
    }
    if a["confirm"] != true {
        return Err("flashing needs a confirmation".into());
    }
    if !Path::new(drive).join("INFO_UF2.TXT").exists() {
        return Err(format!("{drive} is not a board in BOOTSEL mode"));
    }
    // the bootrom quietly ignores an image for another chip and stays a drive: check before, and after
    let image = std::fs::read(&src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    if let (Some(want), Some(have)) = (uf2_family(&image).and_then(family_chip), drive_chip(Path::new(drive))) {
        if want != have {
            return Err(format!("this firmware is for an {want} board, but the board in BOOTSEL mode is an {have} (a Pico {}): pick the right board", if have == "RP2350" { "2 or Pico 2 W" } else { "or Pico W" }));
        }
    }
    if let Err(e) = std::fs::copy(&src, &dest) {
        // the board restarts as soon as the last block arrives, which can cut the copy's own ending short
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if Path::new(drive).join("INFO_UF2.TXT").exists() {
            return Err(format!("cannot copy to the board: {e}"));
        }
    }
    // a board that took the image restarts and its drive goes away
    for _ in 0..(a["wait_ms"].as_u64().unwrap_or(8000) / 250) {
        if !Path::new(drive).join("INFO_UF2.TXT").exists() {
            return Ok(json!({ "plan": p, "copied": dest.to_string_lossy() }));
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err("the board did not take the firmware (it is still waiting in BOOTSEL mode): it may be another kind of Pico, or the image is damaged".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // the bare devkits' S3 and C3 first-flash images (bootloader at 0x0): esptool gets the chip; another chip's image
    // or a classic ESP32 one is refused
    #[test]
    fn s3_and_c3_first_flash_plans() {
        let d = std::env::temp_dir().join(format!("specter-flash-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let img = |chip: u8| {
            let mut b = vec![0xFFu8; 64];
            b[0] = 0xE9;
            b[12] = chip;
            b
        };
        let f = d.join("c3.bin");
        std::fs::write(&f, img(5)).unwrap();
        let p = release_plan("esp32-c3", &f).unwrap();
        assert_eq!(p["chip"], "esp32c3");
        let cmd = esptool_command(&p, "/dev/ttyACM0");
        assert_eq!(cmd[2..4].join(" "), "--chip esp32c3");
        assert!(release_plan("esp32-s3", &f).unwrap_err().contains("not a merged ESP32-S3 image"));
        let s3 = d.join("s3.bin");
        std::fs::write(&s3, img(9)).unwrap();
        assert_eq!(release_plan("esp32-s3", &s3).unwrap()["chip"], "esp32s3");
        assert!(release_plan("esp32-devkit", &s3).is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}
