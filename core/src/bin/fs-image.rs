//! The board package file system image of a USB install, as a file (bench tests; fsimage.rs):
//!
//! ```text
//! cargo run -p studio-core --bin fs-image -- --mcu esp32-devkit --package board.json --out fs.bin
//! cargo run -p studio-core --bin fs-image -- --mcu esp32-devkit --read fs.bin
//! ```
//!
//! The first writes the image (the whole file system partition) and says where it goes; the second mounts an
//! image with the board's geometry and prints the package it holds.

use studio_core::{boardpkg, fsimage};

fn arg(args: &[String], k: &str) -> Option<String> {
    args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let mcu = arg(&args, "--mcu").ok_or("--mcu esp32-devkit | pico-w | pico2-w | pico is missing")?;
    let l = fsimage::layout(&mcu)?;
    if let Some(path) = arg(&args, "--read") {
        let img = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
        let (json, apply) = fsimage::image_package(&mcu, &img)?;
        println!("{json}");
        eprintln!("apply the defaults at the next power-on: {apply}");
        return Ok(());
    }
    let pkg = arg(&args, "--package").ok_or("--package <file.json> is missing")?;
    let out = arg(&args, "--out").ok_or("--out <image file> is missing")?;
    let text = std::fs::read_to_string(&pkg).map_err(|e| format!("{pkg}: {e}"))?;
    let v = boardpkg::check_package(&text)?;
    let img = fsimage::package_image(&mcu, &v)?;
    std::fs::write(&out, &img).map_err(|e| format!("{out}: {e}"))?;
    println!("{out}: {} bytes, write at 0x{:X} (esptool: write_flash 0x{:X} {out})", img.len(), l.offset, l.offset);
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("fs-image: {e}");
        std::process::exit(1);
    }
}
