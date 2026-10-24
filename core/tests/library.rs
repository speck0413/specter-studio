//! The effects library: plain files, a hash index and history copies; recognising a board's script.

use serde_json::json;
use studio_core::library::{self, header, identify, save, with_header};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("studio-lib-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

const V1: &str = "effect fog:\n  wait for trig2\n  rly1 = on\n  sleep 3\n  rly1 = off\n";
const V2: &str = "effect fog:\n  wait for trig2\n  rly1 = on\n  sleep 5\n  rly1 = off\n";

#[test]
fn header_round_trip() {
    let t = with_header("lamp and fog - lab room 1", "2026-10-21 21:04", V1);
    assert!(t.starts_with("# Specter Studio: lamp and fog - lab room 1, saved 2026-10-21 21:04\neffect fog:"));
    assert_eq!(header(&t), Some(("lamp and fog - lab room 1".into(), "2026-10-21 21:04".into())));
    assert_eq!(library::body(&t), V1);
    // a second header replaces the first
    assert_eq!(with_header("x", "2026-10-22 08:00", &t).matches("# Specter Studio").count(), 1);
    // CRLF and trailing spaces do not change the hash
    assert_eq!(library::hash(V1), library::hash(&V1.replace('\n', "  \r\n")));
}

#[test]
fn save_list_and_history() {
    let d = tmp("save");
    let r = save(&d, "ghost in the machine", V1, "2026-10-21 20:00").unwrap();
    assert_eq!(r["changed"], true);
    let again = save(&d, "ghost in the machine", V1, "2026-10-21 20:30").unwrap();
    assert_eq!(again["changed"], false, "same text, nothing new");
    assert_eq!(again["saved"], "2026-10-21 20:00");
    save(&d, "ghost in the machine", V2, "2026-10-21 21:00").unwrap();
    std::fs::write(d.join("effects/hand copied.txt"), "effect a:\n  wait for trig1\n").unwrap();
    let l = library::list(&d);
    let names: Vec<_> = l.iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, ["ghost in the machine", "hand copied"]);
    assert_eq!(l[0]["saved"], "2026-10-21 21:00");
    assert_eq!(std::fs::read_dir(d.join(".specter/history/ghost in the machine")).unwrap().count(), 2);
    assert!(save(&d, "../escape", V1, "x").is_err());
    assert!(save(&d, "", V1, "x").is_err());
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn identify_a_boards_script() {
    let d = tmp("ident");
    assert_eq!(identify(&d, "")["status"], "none");
    assert_eq!(identify(&d, "# only a comment\n")["status"], "none");
    assert_eq!(identify(&d, V1)["status"], "unknown");
    save(&d, "air blaster 4", V1, "2026-10-21 20:00").unwrap();
    // sent by Studio: the header names it
    let sent = library::for_board(&d, "air blaster 4").unwrap();
    assert_eq!(identify(&d, &sent), json!({ "status": "current", "name": "air blaster 4", "saved": "2026-10-21 20:00", "library_saved": "2026-10-21 20:00", "hash": library::hash(V1) }));
    // sent by other means: the hash index names it
    assert_eq!(identify(&d, V1)["status"], "current");
    assert_eq!(identify(&d, V1)["name"], "air blaster 4");
    // the library moves on: both forms are an older version now
    save(&d, "air blaster 4", V2, "2026-10-21 22:00").unwrap();
    assert_eq!(identify(&d, &sent)["status"], "older");
    assert_eq!(identify(&d, V1)["status"], "older");
    assert_eq!(identify(&d, V1)["library_saved"], "2026-10-21 22:00");
    // a header naming a library script with text Studio never saved: changed elsewhere
    let edited = with_header("air blaster 4", "2026-10-21 23:00", "effect x:\n  wait for trig1\n");
    assert_eq!(identify(&d, &edited)["status"], "changed");
    // a header naming a script this library does not have
    let other = with_header("butchers room video", "2026-10-01 10:00", V1);
    assert_eq!(identify(&d, &other)["status"], "unknown");
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn firmware_projects_are_recognised() {
    use studio_core::projects;
    let d = tmp("fw");
    let fw = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../firmware/firmware/arduino");
    let p = projects::new_project(&d, "Tracking Babies", &fw.join("template")).unwrap();
    assert_eq!(p["folder"], "tracking-babies");
    assert!(d.join("firmware/tracking-babies/tracking-babies.ino").exists());
    assert!(d.join("firmware/tracking-babies/sketch.yaml").exists());
    assert!(projects::new_project(&d, "tracking babies", &fw.join("template")).is_err());
    assert_eq!(projects::bump(&d, "tracking babies").unwrap(), "tracking babies v1");
    assert_eq!(projects::bump(&d, "tracking babies").unwrap(), "tracking babies v2");
    let info = |b: &str| json!({ "fw": "generic", "fw_version": "0.1.0", "fw_build": b });
    assert_eq!(projects::identify(&d, &info("1ed6c66"))["kind"], "release");
    assert_eq!(projects::identify(&d, &info("tracking babies v2"))["status"], "current");
    assert_eq!(projects::identify(&d, &info("tracking babies v1"))["status"], "older");
    assert_eq!(projects::identify(&d, &info("someone else v4"))["status"], "unknown");
    // newer firmware names itself: fw = the sketch folder, fw_version = its VERSION
    std::fs::write(d.join("firmware/tracking-babies/VERSION"), "2\n").unwrap();
    let named = json!({ "fw": "tracking-babies", "fw_version": "2", "fw_build": "abc1234" });
    assert_eq!(projects::identify(&d, &named)["status"], "current");
    assert_eq!(projects::identify(&d, &named)["name"], "tracking babies");
    assert_eq!(projects::identify(&d, &json!({ "fw": "tracking-babies", "fw_version": "1" }))["status"], "older");
    let list = projects::projects(&d);
    assert_eq!(list[0]["name"], "tracking babies");
    assert_eq!(list[0]["default_env"], "esp32dev");
    assert_eq!(list[0]["boards"][1]["board"], "picow");
    assert_eq!(projects::read_sketch_yaml("default_profile: a\nprofiles:\n  a:\n    fqbn: esp32:esp32:esp32\n").1, vec![("a".to_string(), "esp32:esp32:esp32".to_string())]);
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn flash_plans_follow_the_flash_map() {
    use studio_core::flash;
    let d = tmp("flash");
    std::fs::create_dir_all(&d).unwrap();
    let mut app = vec![0xE9u8];
    app.extend(vec![0u8; 1000]);
    std::fs::write(d.join("firmware.bin"), &app).unwrap();
    std::fs::write(d.join("bootloader.bin"), vec![1u8; 17_536]).unwrap();
    std::fs::write(d.join("partitions.bin"), vec![2u8; 3072]).unwrap();
    std::fs::write(d.join("boot_app0.bin"), vec![0xFFu8; 8192]).unwrap();
    std::env::set_var("SPECTER_BOOT_APP0", d.join("boot_app0.bin"));
    let p = flash::plan("esp32dev", d.to_str().unwrap()).unwrap();
    let offs: Vec<_> = p["parts"].as_array().unwrap().iter().map(|x| x["offset"].as_str().unwrap().to_string()).collect();
    assert_eq!(offs, ["0x1000", "0x8000", "0xE000", "0x10000"]);
    assert_eq!(p["parts"][0]["bytes"], 17_536);
    assert_eq!(p["flash"]["mode"], "dio");
    let cmd = flash::esptool_command(&p, "/dev/ttyUSB0");
    let tail: Vec<_> = cmd.iter().skip(2).take(19).cloned().collect();
    assert_eq!(tail.join(" "), "--chip esp32 --port /dev/ttyUSB0 --baud 460800 --before default_reset --after hard_reset write_flash -z --flash_mode dio --flash_freq 40m --flash_size 4MB 0x1000");
    // a dry run never opens the port; without confirm nothing runs
    let rt = tokio::runtime::Runtime::new().unwrap();
    let dry = rt.block_on(flash::flash(&json!({ "board": "esp32dev", "build_dir": d, "port": "/dev/ttyUSB0", "dry_run": true }))).unwrap();
    assert_eq!(dry["dry_run"], true);
    assert!(rt.block_on(flash::flash(&json!({ "board": "esp32dev", "build_dir": d, "port": "/dev/ttyUSB0" }))).unwrap_err().contains("confirmation"));
    // wrong images are refused before anything else
    std::fs::write(d.join("firmware.bin"), b"not an image").unwrap();
    assert!(flash::plan("esp32dev", d.to_str().unwrap()).unwrap_err().contains("not an ESP32 app image"));
    std::fs::write(d.join("firmware.bin"), vec![0xE9u8; 2_000_000]).unwrap();
    assert!(flash::plan("esp32dev", d.to_str().unwrap()).unwrap_err().contains("too big"));
    // Pico W: the merged flash.uf2 next to the app build, copied to the BOOTSEL drive
    let app_build = d.join("pio/picow");
    std::fs::create_dir_all(&app_build).unwrap();
    std::fs::create_dir_all(d.join("pio/picoboot-pico-w")).unwrap();
    // one UF2 block for the RP2040 (magic, flags with "family ID present", the family at byte 28)
    let mut block = vec![0u8; 512];
    for (at, v) in [(0usize, 0x0A32_4655u32), (4, 0x9E5D_5157), (8, 0x2000), (28, 0xE48B_FF56)] {
        block[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
    assert_eq!(flash::uf2_family(&block).and_then(flash::family_chip), Some("RP2040"));
    std::fs::write(d.join("pio/picoboot-pico-w/flash.uf2"), &block).unwrap();
    let drive = d.join("RPI-RP2");
    std::fs::create_dir_all(&drive).unwrap();
    let r = rt.block_on(flash::flash(&json!({ "board": "picow", "build_dir": app_build, "drive": drive, "dry_run": true }))).unwrap();
    assert!(std::path::Path::new(r["copy"][1].as_str().unwrap()).ends_with(std::path::Path::new("RPI-RP2").join("flash.uf2")));
    assert!(rt.block_on(flash::flash(&json!({ "board": "picow", "build_dir": app_build, "drive": drive, "confirm": true }))).unwrap_err().contains("not a board in BOOTSEL mode"));
    // a Pico 2 in BOOTSEL mode does not get a Pico W image (its bootrom would ignore it and Studio say "done")
    std::fs::write(drive.join("INFO_UF2.TXT"), "Board-ID: RP2350\n").unwrap();
    let e = rt.block_on(flash::flash(&json!({ "board": "picow", "build_dir": app_build, "drive": drive, "confirm": true }))).unwrap_err();
    assert!(e.contains("RP2040") && e.contains("RP2350"), "{e}");
    assert!(!drive.join("flash.uf2").exists());
    std::fs::write(drive.join("INFO_UF2.TXT"), "Board-ID: RPI-RP2\n").unwrap();
    // the copy is made; a drive that stays (this folder) means the board did not take it
    let e = rt.block_on(flash::flash(&json!({ "board": "picow", "build_dir": app_build, "drive": drive, "confirm": true, "wait_ms": 500 }))).unwrap_err();
    assert!(e.contains("did not take"), "{e}");
    assert!(drive.join("flash.uf2").exists());
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn compiler_errors_in_plain_words() {
    let log = "Compiling .pio/x/src/my-fw.ino.cpp.o\n/tmp/ws/.specter/build/my-fw/.pio/my-fw-esp32dev/src/my-fw.ino.cpp:12:3: error: 'prop2' was not declared in this scope\n";
    assert_eq!(studio_core::builder::errors(log), ["line 12 of my-fw.ino: 'prop2' was not declared in this scope"]);
}

#[test]
fn the_sound_list_is_the_sd_card_tools_csv() {
    let d = tmp("sounds");
    std::fs::create_dir_all(&d).unwrap();
    assert!(library::sounds(&d).is_empty());
    std::fs::write(d.join("sounds.csv"), "number,file\n1,rain.mp3\n2,\"a, \"\"b\"\".wav\"\nx,bad\n3001,too-far.mp3\n").unwrap();
    assert_eq!(json!(library::sounds(&d)), json!({ "rain.mp3": 1, "a, \"b\".wav": 2 }));
    let _ = std::fs::remove_dir_all(d);
}

/// The library folder is also a workspace the firmware's own tools build: the generated platformio.ini equals
/// what the firmware's make_envs.py writes (checked with its --check). Needs a firmware with a workspace
/// template: set SPECTER_WORKSPACE_FIRMWARE to such a firmware/arduino folder (skipped otherwise).
#[test]
fn library_is_a_firmware_workspace() {
    let Ok(ard) = std::env::var("SPECTER_WORKSPACE_FIRMWARE") else { eprintln!("skipped"); return };
    use studio_core::projects;
    let ard = std::path::PathBuf::from(ard);
    let d = tmp("wsini");
    std::fs::create_dir_all(d.join("firmware")).unwrap();
    projects::new_project(&d, "ghost in the machine", &ard.join("template")).unwrap();
    projects::new_project(&d, "tracking babies", &ard.join("template")).unwrap();
    assert!(projects::write_workspace_ini(&d, &ard).unwrap());
    let ini = std::fs::read_to_string(d.join("platformio.ini")).unwrap();
    assert!(ini.contains(&format!("dir = {}", ard.display())));
    assert!(ini.ends_with("[env:ghost-in-the-machine]\nextends = board_esp32dev\ncustom_project = ghost-in-the-machine\n\n[env:tracking-babies]\nextends = board_esp32dev\ncustom_project = tracking-babies\n"));
    let out = std::process::Command::new("python3").arg("make_envs.py").arg("--check").current_dir(&d).output().unwrap();
    assert!(out.status.success(), "make_envs.py --check: {}", String::from_utf8_lossy(&out.stderr));
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn rename_and_delete_keep_history() {
    let d = tmp("rename");
    save(&d, "lamp", V1, "2026-10-21 20:00").unwrap();
    save(&d, "lamp", V2, "2026-10-21 21:00").unwrap();
    library::rename(&d, "lamp", "porch lamp").unwrap();
    assert!(library::read(&d, "lamp").is_err());
    assert_eq!(library::read(&d, "porch lamp").unwrap(), V2);
    assert_eq!(identify(&d, V1)["name"], "porch lamp", "older versions follow the new name");
    assert_eq!(std::fs::read_dir(d.join(".specter/history/porch lamp")).unwrap().count(), 2);
    save(&d, "other", V1, "2026-10-21 22:00").unwrap();
    assert!(library::rename(&d, "porch lamp", "other").is_err(), "no overwrite");
    // a change of case only works too (the same file on Windows and macOS)
    library::rename(&d, "porch lamp", "Porch Lamp").unwrap();
    assert_eq!(library::read(&d, "Porch Lamp").unwrap(), V2);
    library::rename(&d, "Porch Lamp", "porch lamp").unwrap();
    library::delete(&d, "porch lamp").unwrap();
    assert!(library::read(&d, "porch lamp").is_err());
    assert_eq!(std::fs::read_dir(d.join(".specter/trash")).unwrap().count(), 1, "kept in the trash");
    let _ = std::fs::remove_dir_all(d);
}

/// S13: two saves in the same minute keep both versions; a cut-short index is made again from the history; a
/// save time from the caller cannot reach outside the history folder; a file changed outside since it was
/// opened is not overwritten.
#[test]
fn saves_never_lose_versions_or_the_index() {
    let d = tmp("robust");
    save(&d, "porch", V1, "2026-10-22 08:00").unwrap();
    save(&d, "porch", V2, "2026-10-22 08:00").unwrap();
    assert_eq!(std::fs::read_dir(d.join(".specter/history/porch")).unwrap().count(), 2, "two saves in one minute");
    save(&d, "ghost", V1, "../../../../evil").unwrap();
    assert!(std::fs::read_dir(d.join(".specter/history/ghost")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains('/')));
    assert!(!d.parent().unwrap().join("evil.txt").exists());
    // the index cut short (a crash, a sync tool): what Studio knew comes back from the history
    std::fs::write(d.join(".specter/index.json"), "{\"abc\": {\"na").unwrap();
    assert_eq!(identify(&d, V2)["status"], "current");
    assert_eq!(identify(&d, V1)["name"], "ghost", "V1 was saved last as ghost");
    save(&d, "porch", V2.replace("sleep 5", "sleep 6").as_str(), "2026-10-22 09:00").unwrap();
    let idx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(d.join(".specter/index.json")).unwrap()).unwrap();
    assert!(idx.as_object().unwrap().len() >= 3, "the rewritten index kept the old versions: {idx}");
    // an editor saves only over the version it opened
    let opened = library::hash(&library::read(&d, "porch").unwrap());
    std::fs::write(d.join("effects/porch.txt"), "effect porch:\n  wait for trig1\n  # edited elsewhere\n").unwrap();
    let e = library::save_checked(&d, "porch", V1, "2026-10-22 10:00", Some(&opened)).unwrap_err();
    assert!(e.starts_with(library::CHANGED_OUTSIDE), "{e}");
    assert!(library::read(&d, "porch").unwrap().contains("edited elsewhere"));
    let now = library::hash(&library::read(&d, "porch").unwrap());
    library::save_checked(&d, "porch", V1, "2026-10-22 10:01", Some(&now)).unwrap();
    // no temporary files left behind
    assert!(std::fs::read_dir(d.join("effects")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".tmp-")));
    let _ = std::fs::remove_dir_all(d);
}

/// S19: a platformio.ini or helper script the person wrote or changed is never overwritten.
#[test]
fn the_persons_own_workspace_files_are_left_alone() {
    use studio_core::projects;
    let d = tmp("ownini");
    let ard = d.join("ard");
    let wt = ard.join("workspace-template");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join("platformio.ini"), format!("[platformio]\ndir = x\n{}\n", projects::PROJECTS_LINE)).unwrap();
    std::fs::write(wt.join("project_src.py"), "v1").unwrap();
    std::fs::write(wt.join("make_envs.py"), "v1").unwrap();
    let ws = d.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    assert!(projects::write_workspace_ini(&ws, &ard).unwrap());
    assert_eq!(std::fs::read_to_string(ws.join("make_envs.py")).unwrap(), "v1");
    // a newer firmware's scripts replace Studio's own copies, not one the person changed
    std::fs::write(ws.join("project_src.py"), "mine").unwrap();
    std::fs::write(wt.join("project_src.py"), "v2").unwrap();
    std::fs::write(wt.join("make_envs.py"), "v2").unwrap();
    projects::write_workspace_ini(&ws, &ard).unwrap();
    assert_eq!(std::fs::read_to_string(ws.join("make_envs.py")).unwrap(), "v2");
    assert_eq!(std::fs::read_to_string(ws.join("project_src.py")).unwrap(), "mine");
    // a platformio.ini of their own (no projects line) stays as it is
    std::fs::write(ws.join("platformio.ini"), "[env:mine]\nboard = esp32dev\n").unwrap();
    assert!(!projects::write_workspace_ini(&ws, &ard).unwrap());
    assert_eq!(std::fs::read_to_string(ws.join("platformio.ini")).unwrap(), "[env:mine]\nboard = esp32dev\n");
    let _ = std::fs::remove_dir_all(d);
}

/// S16: a backup taken before a firmware switch stays listed until the board has its setup back.
#[test]
fn a_switch_backup_waits_until_restored() {
    use studio_core::fleet;
    let d = tmp("pending");
    let ws = d.to_string_lossy().to_string();
    assert!(fleet::pending(&ws).is_empty());
    let b = d.join(".specter/backups/porch.proptroller.json");
    std::fs::create_dir_all(b.parent().unwrap()).unwrap();
    std::fs::write(&b, "{}").unwrap();
    fleet::pending_set(&ws, &b.to_string_lossy(), Some(json!({ "path": b.to_string_lossy(), "key": "k", "name": "Porch" })));
    let p = fleet::pending(&ws);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0]["name"], "Porch");
    fleet::pending_set(&ws, &b.to_string_lossy(), None);
    assert!(fleet::pending(&ws).is_empty());
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn the_library_list_reads_a_scripts_icon_and_colour_like_studio() {
    // the same table as src/props/look.test.ts
    let t: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/look-cases.json")).unwrap()).unwrap();
    for c in t["cases"].as_array().unwrap() {
        let (icon, color) = library::look(c["text"].as_str().unwrap());
        assert_eq!(icon.as_deref(), c["list"]["icon"].as_str(), "{}", c["name"]);
        assert_eq!(color.as_deref(), c["list"]["color"].as_str(), "{}", c["name"]);
    }
    let lib = tmp("look");
    save(&lib, "blood", "# icon: splat\n# color: red\neffect fire:\n  wait for trig1\n  sleep 1\n", "2026-10-24 20:00").unwrap();
    let l = library::list(&lib);
    assert_eq!(l[0]["icon"], "splat");
    assert_eq!(l[0]["color"], "red");
    let _ = std::fs::remove_dir_all(lib);
}
