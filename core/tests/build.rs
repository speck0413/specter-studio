//! A real firmware build with PlatformIO (skipped when PlatformIO is not installed): the sketch folder is built
//! the Arduino way and the board-visible build id is stamped into the image.

use serde_json::json;
use studio_core::Studio;

#[tokio::test(flavor = "multi_thread")]
async fn builds_a_sketch_and_stamps_its_version() {
    if studio_core::builder::find_pio().is_none() {
        eprintln!("PlatformIO is not installed: skipped");
        return;
    }
    let s = Studio::new();
    let ws = std::env::temp_dir().join(format!("studio-build-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    s.dispatch("workspace_init", json!({ "folder": ws })).await.unwrap();
    s.dispatch("firmware_new", json!({ "folder": ws, "name": "ghost in the machine" })).await.unwrap();
    let r = s.dispatch("firmware_upload", json!({ "folder": ws, "name": "ghost in the machine", "build_only": true })).await.unwrap();
    assert_eq!(r["build"]["build_id"], "ghost in the machine v1");
    let img = std::fs::read(r["build"]["image"].as_str().unwrap()).unwrap();
    assert!(img.windows(23).any(|w| w == b"ghost in the machine v1"), "the build id is in the image");
    let p = s.dispatch("library_projects", json!({ "folder": ws })).await.unwrap();
    assert_eq!(p[0]["version"], 1);
    // the flash plan of that very build follows the flash map
    let plan = studio_core::flash::plan("esp32dev", r["build"]["out"].as_str().unwrap()).unwrap();
    assert_eq!(plan["parts"][3]["offset"], "0x10000");
    // the same sketch for a Pico W (behind the Pico bootloader: the image is linked for its active slot)
    let pico = s.dispatch_dev("firmware_build", json!({ "folder": ws, "name": "ghost in the machine", "board": "picow" })).await.unwrap();
    assert_eq!(pico["build_id"], "ghost in the machine v2");
    assert!(std::path::Path::new(pico["image"].as_str().unwrap()).exists());
    // a mistake comes back in plain words, and the version does not move
    let ino = ws.join("firmware/ghost-in-the-machine/ghost-in-the-machine.ino");
    std::fs::write(&ino, "#include <Proptroller.h>\nProptroller prop;\nvoid setup() { prop.begin(); prop2.update(); }\nvoid loop() { prop.update(); }\n").unwrap();
    let e = s.dispatch_dev("firmware_build", json!({ "folder": ws, "name": "ghost in the machine" })).await.unwrap_err();
    assert!(e.contains("line 3 of ghost-in-the-machine.ino: 'prop2' was not declared in this scope"), "{e}");
    assert_eq!(s.dispatch("library_projects", json!({ "folder": ws })).await.unwrap()[0]["version"], 2);
    let _ = std::fs::remove_dir_all(ws);
}

/// Pico W first flash of the user's own firmware: the sketch, the Pico bootloader and the firmware's merge,
/// then a dry run of the copy to a BOOTSEL drive. The merged image's layout is checked byte by byte.
#[tokio::test(flavor = "multi_thread")]
async fn pico_w_first_flash_file() {
    if studio_core::builder::find_pio().is_none() {
        eprintln!("PlatformIO is not installed: skipped");
        return;
    }
    let s = Studio::new();
    let ws = std::env::temp_dir().join(format!("studio-pico-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    s.dispatch("workspace_init", json!({ "folder": ws })).await.unwrap();
    s.dispatch("firmware_new", json!({ "folder": ws, "name": "tracking babies" })).await.unwrap();
    let drive = ws.join("RPI-RP2");
    std::fs::create_dir_all(&drive).unwrap();
    std::fs::write(drive.join("INFO_UF2.TXT"), "UF2 Bootloader v3.0\nModel: Raspberry Pi RP2\nBoard-ID: RPI-RP2\n").unwrap();
    let r = s.dispatch("firmware_upload", json!({ "folder": ws, "name": "tracking babies", "board": "picow", "drive": drive, "dry_run": true })).await.unwrap();
    let copy = &r["flash"]["copy"];
    let uf2 = std::path::PathBuf::from(copy[0].as_str().unwrap());
    assert!(std::path::Path::new(copy[1].as_str().unwrap()).ends_with(std::path::Path::new("RPI-RP2").join("flash.uf2")), "{r}");
    assert!(!drive.join("flash.uf2").exists(), "a dry run copies nothing");
    // flash.bin: the bootloader from 0x10000000, 0xFF up to the active slot at 0x10007000, then the firmware
    let bin = std::fs::read(uf2.with_file_name("flash.bin")).unwrap();
    let app = std::fs::read(ws.join(".specter/build/tracking-babies/.pio/picow/firmware.bin")).unwrap();
    assert_eq!(&bin[0x7000..], &app[..], "the firmware sits at the active slot");
    assert!(bin[0x6000..0x7000].iter().all(|&b| b == 0xFF), "the bootloader state sector is erased");
    assert!(bin[..0x100].iter().any(|&b| b != 0xFF), "the bootloader (boot2) is at the start");
    // flash.uf2: 512-byte blocks, RP2040 family, contiguous 256-byte payloads from 0x10000000
    let u = std::fs::read(&uf2).unwrap();
    assert_eq!(u.len() % 512, 0);
    let word = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    for (i, blk) in u.chunks(512).enumerate() {
        assert_eq!((word(blk, 0), word(blk, 4), word(blk, 508)), (0x0A32_4655, 0x9E5D_5157, 0x0AB1_6F30), "UF2 magic");
        assert_eq!(word(blk, 12), 0x1000_0000 + 256 * i as u32);
        assert_eq!(word(blk, 28), 0xE48B_FF56, "RP2040 family");
    }
    assert_eq!(u.len() / 512 * 256, bin.len().div_ceil(256) * 256);
    let _ = std::fs::remove_dir_all(ws);
}
