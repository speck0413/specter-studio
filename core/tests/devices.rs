//! The device layer against the real C++ simulator (the firmware submodule's `sim` build; run
//! scripts/build-sim.sh first). Every simulator gets a free port and no UDP discovery unless a test needs it.

use serde_json::{json, Value};
use std::time::Duration;
use studio_core::{Event, Studio};


/// Windows has no practice-board simulator yet (the firmware's sim builds on Linux and macOS): a test that needs
/// it is skipped there while none is found, and runs as soon as one is (PROPTROLLER_SIM or a built `sim`).
fn no_simulator_here() -> bool {
    let skip = cfg!(windows) && studio_core::sim::find_program().is_none();
    if skip {
        eprintln!("no simulator on this Windows computer: skipped");
    }
    skip
}

async fn sim(s: &Studio, extra: Value) -> String {
    let mut a = json!({ "name": "Test Prop" });
    a.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    let r = s.dispatch("sim_start", a).await.expect("simulator starts");
    r["key"].as_str().unwrap().to_string()
}

async fn rpc(s: &Studio, key: &str, req: Value) -> Value {
    s.dispatch("rpc", json!({ "key": key, "req": req })).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_rpc_and_events() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let mut ev = s.events();
    let key = sim(&s, json!({})).await;
    let info = rpc(&s, &key, json!({ "op": "info" })).await;
    assert_eq!(info["ok"], true);
    assert_eq!(info["result"]["name"], "Test Prop");
    assert_eq!(info["result"]["mcu"], "sim");
    // pressing an input shows in the pushed state
    let r = rpc(&s, &key, json!({ "op": "sim_input", "input": "TRIG1", "active": true })).await;
    assert_eq!(r["ok"], true, "{r}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    let mut saw = false;
    while tokio::time::Instant::now() < deadline && !saw {
        if let Ok(Ok(Event::Board { msg, .. })) = tokio::time::timeout(Duration::from_secs(1), ev.recv()).await {
            if msg["event"] == "state" {
                saw = msg["data"]["inputs"].as_array().unwrap().iter().any(|i| i["input"] == "TRIG1" && i["raw"] == true);
            }
        }
    }
    assert!(saw, "a state event shows TRIG1 pressed");
    // an error answer comes back as an envelope
    let bad = rpc(&s, &key, json!({ "op": "get_show", "show": 99 })).await;
    assert_eq!(bad["ok"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn session_survives_the_keepalive() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let key = sim(&s, json!({})).await;
    tokio::time::sleep(Duration::from_secs(12)).await; // the board drops a silent session after 5 s
    let c = s.dispatch("connections", json!({})).await.unwrap();
    assert_eq!(c[0]["online"], true);
    assert_eq!(rpc(&s, &key, json!({ "op": "state" })).await["ok"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn udp_discovery_finds_a_simulator() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let port = 47_913;
    let _key = sim(&s, json!({ "discovery_port": port, "id": "simdisc01" })).await;
    let found = s.dispatch("discover", json!({ "timeout_ms": 800, "unicast": [format!("127.0.0.1:{port}")], "mdns": false })).await.unwrap();
    let me = found.as_array().unwrap().iter().find(|f| f["id"] == "simdisc01").expect("found");
    assert_eq!(me["name"], "Test Prop");
    assert!(me["address"].as_str().unwrap().starts_with("http://127.0.0.1:"));
    let info = s.dispatch_dev("probe", json!({ "address": me["address"] })).await.unwrap();
    assert_eq!(info["id"], "simdisc01");
}

#[tokio::test(flavor = "multi_thread")]
async fn script_check_uses_the_board_checker() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let r = s.dispatch("check_script", json!({ "text": "effect a:\n  wait for trig1\n  out5 = on\n" })).await.unwrap();
    assert_eq!(r["ok"], false);
    assert_eq!(
        r["errors"][0]["message"],
        "line 3: there is no out5 on this board. The outputs are out1 to out4, rly1, rly2, cc1 and cc2."
    );
    let good = s.dispatch("check_script", json!({ "text": "effect a:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n" })).await.unwrap();
    assert_eq!(good["ok"], true);
    assert_eq!(good["effects"], 1);
}

fn sim_image(version: &str, build: &str, pass: bool) -> Vec<u8> {
    let head = json!({ "mcu": "sim", "fw_version": version, "fw_build": build, "self_check": if pass { "pass" } else { "fail" } });
    let mut v = b"PROPTROLLER-SIM-IMAGE\n".to_vec();
    v.extend(head.to_string().as_bytes());
    v.push(b'\n');
    v.extend((0..200_000u32).map(|i| (i % 251) as u8));
    v
}

#[tokio::test(flavor = "multi_thread")]
async fn update_from_a_release_folder() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let key = sim(&s, json!({ "speed": 10.0 })).await;
    let dir = std::env::temp_dir().join(format!("studio-release-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let img = sim_image("0.2.0", "abc1234", true);
    std::fs::write(dir.join("sim.bin"), &img).unwrap();
    let manifest = json!({ "version": "0.2.0", "images": [
        { "fw": "generic", "impl": "cpp", "mcu": "sim", "file": "sim.bin", "bytes": img.len(), "sha256": studio_core::fleet::sha256_hex(&img) } ] });
    std::fs::write(dir.join("proptroller-firmware.json"), manifest.to_string()).unwrap();
    let source = dir.to_string_lossy().to_string();
    let info = rpc(&s, &key, json!({ "op": "info" })).await["result"].clone();
    let plan = s.dispatch("update_plan", json!({ "source": source, "info": info })).await.unwrap();
    assert_eq!(plan["out_of_date"], true, "{plan}");
    let mut ev = s.events();
    let r = s.dispatch("update", json!({ "key": key, "source": source })).await.unwrap();
    assert_eq!(r["result"], "valid", "{r}");
    assert_eq!(r["info"]["fw_version"], "0.2.0");
    let mut phases = vec![];
    while let Ok(e) = ev.try_recv() {
        if let Event::Update { phase, .. } = e {
            phases.push(phase);
        }
    }
    assert_eq!(phases, ["sending", "restarting", "checking", "valid"]);
    // the session came back by itself after the restart
    let mut ok = false;
    for _ in 0..20 {
        if let Ok(v) = s.dispatch("rpc", json!({ "key": key, "req": { "op": "info" } })).await {
            ok = v["result"]["fw_version"] == "0.2.0";
            if ok { break; }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    assert!(ok, "the session reconnects after the update");
    let _ = std::fs::remove_dir_all(dir);
}

/// A release folder with one image per `(fw, mcu, file, bytes, first_flash)`.
fn release_folder(dir: &std::path::Path, version: &str, images: &[(&str, &str, &str, Vec<u8>, bool)]) {
    std::fs::create_dir_all(dir).unwrap();
    let mut list = vec![];
    for (fw, mcu, file, bytes, first) in images {
        std::fs::write(dir.join(file), bytes).unwrap();
        let mut e = json!({ "fw": fw, "impl": "cpp", "mcu": mcu, "file": file, "bytes": bytes.len(), "sha256": studio_core::fleet::sha256_hex(bytes) });
        if *first {
            e["first_flash"] = json!(true);
        }
        list.push(e);
    }
    std::fs::write(dir.join("proptroller-firmware.json"), json!({ "version": version, "images": list }).to_string()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_adds_a_firmware_type_and_a_switch_needs_a_confirmation() {
    if no_simulator_here() {
        return;
    }
    let root = std::env::temp_dir().join(format!("studio-fwtypes-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    // the stock list (0.2.0) and a plugin with a type of its own (4.0.0) in a folder inside the plugin
    let stock = root.join("stock");
    release_folder(&stock, "0.2.0", &[("generic", "sim", "sim.bin", sim_image("0.2.0", "gen0001", true), false)]);
    let plugin = root.join("plugins").join("lamps");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("plugin.json"), json!({ "id": "lamps", "name": "Lamps", "entry": "index.html",
        "firmware": [{ "fw": "lamp", "name": "Demo lamp", "source": "releases" }] }).to_string()).unwrap();
    let mut merged = vec![0xFFu8; 0x1000];
    merged.extend([0xE9, 0, 0, 0]);
    release_folder(&plugin.join("releases"), "4.0.0", &[
        ("lamp", "sim", "lamp.bin", sim_image("4.0.0", "lamp001", true), false),
        ("lamp", "esp32-devkit", "first-flash-lamp.bin", merged, true),
        // a plugin's list never gives the stock firmware
        ("generic", "sim", "not-stock.bin", sim_image("9.9.9", "bad0001", true), false),
    ]);
    let s = Studio::new();
    s.plugin_dirs.lock().unwrap().push(root.join("plugins"));
    let src = stock.to_string_lossy().to_string();
    let allowed = json!({ "source": src, "plugins": ["lamps"] });

    // the plugin's type is there only once the person allowed the plugin
    let t = s.dispatch("firmware_types", json!({ "source": src })).await.unwrap();
    assert_eq!(t.as_array().unwrap().len(), 1);
    assert_eq!(t[0]["name"], "Generic (stock)");
    let t = s.dispatch("firmware_types", allowed.clone()).await.unwrap();
    assert_eq!(t[1]["fw"], "lamp");
    assert_eq!(t[1]["name"], "Demo lamp");
    let c = s.dispatch("firmware_catalog", allowed.clone()).await.unwrap();
    assert_eq!(c["types"][0]["version"], "0.2.0");
    assert_eq!(c["types"][1]["version"], "4.0.0");
    assert!(!c["images"].as_array().unwrap().iter().any(|i| i["file"] == "not-stock.bin"), "{c}");

    // a stock board is offered the stock update, never the plugin's version
    let key = sim(&s, json!({ "speed": 10.0 })).await;
    let info = rpc(&s, &key, json!({ "op": "info" })).await["result"].clone();
    assert_eq!(info["fw"], "generic");
    let plan = s.dispatch("update_plan", json!({ "source": src, "plugins": ["lamps"], "info": info })).await.unwrap();
    assert_eq!((plan["latest"].as_str(), plan["out_of_date"].as_bool(), plan["type_name"].as_str()), (Some("0.2.0"), Some(true), Some("Generic (stock)")), "{plan}");

    // another type without the confirmation: refused, nothing sent
    let mut a = allowed.clone();
    a["key"] = json!(key);
    a["fw"] = json!("lamp");
    let e = s.dispatch("update", a.clone()).await.unwrap_err();
    assert!(e.contains("confirm the switch"), "{e}");
    let now = rpc(&s, &key, json!({ "op": "info" })).await["result"].clone();
    assert_eq!(now["fw_version"], info["fw_version"]);

    // confirmed: the plugin's image goes on (and the board's settings are saved to a file first)
    a["switch_type"] = json!(true);
    a["backups"] = json!(root.join("backups").to_string_lossy());
    let r = s.dispatch("update", a).await.unwrap();
    assert_eq!(r["result"], "valid", "{r}");
    assert_eq!(r["info"]["fw_version"], "4.0.0");
    assert!(std::path::Path::new(r["backup"].as_str().unwrap()).exists(), "{r}");

    // a new board's first install over USB comes from the chosen type's list (a dry run: nothing is written)
    let mut u = allowed.clone();
    u.as_object_mut().unwrap().extend(json!({ "fw": "lamp", "mcu": "esp32-devkit", "port": "/dev/not-a-board", "dry_run": true }).as_object().unwrap().clone());
    let r = s.dispatch("usb_install", u.clone()).await.unwrap();
    assert_eq!(r["dry_run"], true);
    assert_eq!(r["plan"]["parts"][0]["offset"], "0x0");
    assert_eq!(r["type_name"], "Demo lamp");
    let cmd: Vec<String> = serde_json::from_value(r["command"].clone()).unwrap();
    assert!(cmd.iter().any(|c| c.ends_with("first-flash-lamp.bin")) && cmd.contains(&"/dev/not-a-board".to_string()), "{cmd:?}");
    // not confirmed: refused
    u["dry_run"] = json!(false);
    assert_eq!(s.dispatch("usb_install", u.clone()).await.unwrap_err(), "flashing needs a confirmation");
    // the stock list has no USB image for it, and a plugin's type is unknown until the plugin is allowed
    u["fw"] = json!("generic");
    assert!(s.dispatch("usb_install", u.clone()).await.unwrap_err().contains("no USB install"));
    let e = s.dispatch("usb_install", json!({ "source": src, "fw": "lamp", "mcu": "esp32-devkit", "port": "/dev/not-a-board", "dry_run": true })).await.unwrap_err();
    assert!(e.contains("no firmware list"), "{e}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread")]
async fn update_that_fails_its_self_check_rolls_back() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let key = sim(&s, json!({ "speed": 10.0, "swap_ms": 3000 })).await;
    // each image as a one-image release folder (the only way an update gets an image: S4)
    let dir = std::env::temp_dir().join(format!("studio-bad-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let release = |version: &str, img: Vec<u8>| {
        std::fs::write(dir.join("sim.bin"), &img).unwrap();
        let m = json!({ "version": version, "images": [
            { "fw": "generic", "impl": "cpp", "mcu": "sim", "file": "sim.bin", "bytes": img.len(), "sha256": studio_core::fleet::sha256_hex(&img) } ] });
        std::fs::write(dir.join("proptroller-firmware.json"), m.to_string()).unwrap();
        dir.to_string_lossy().to_string()
    };
    let info = rpc(&s, &key, json!({ "op": "info" })).await;
    assert_eq!(info["result"]["update"]["install_max_s"], 180, "swap-ms reports install_max_s");
    let r = s.dispatch("update", json!({ "key": key, "source": release("0.3.0", sim_image("0.3.0", "bad0001", false)) })).await.unwrap();
    assert_eq!(r["result"], "rolled_back", "{r}");
    assert_eq!(r["info"]["fw_version"], info["result"]["fw_version"], "back on the version it had");
    // the next good update is not mistaken for a rollback, although the board still says rolled_back from
    // the last one until it restarts
    let r = s.dispatch("update", json!({ "key": key, "source": release("0.3.1", sim_image("0.3.1", "good001", true)) })).await.unwrap();
    assert_eq!(r["result"], "valid", "{r}");
    assert_eq!(r["info"]["fw_version"], "0.3.1");
    // never back to an older or the same version without asking for it (no silent downgrade)
    let e = s.dispatch("update", json!({ "key": key, "source": release("0.3.1", sim_image("0.3.1", "good002", true)) })).await.unwrap_err();
    assert!(e.contains("nothing newer"), "{e}");
    // a refused image gives the board's message
    let e = s.dispatch("update", json!({ "key": key, "source": release("0.3.2", b"not an image".to_vec()) })).await.unwrap_err();
    assert!(e.contains("not an image for sim"), "{e}");
    // an arbitrary file is not a source of firmware any more: `file` is ignored, the release list is what counts
    let empty = dir.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let e = s.dispatch("update", json!({ "key": key, "file": dir.join("sim.bin"), "source": empty })).await.unwrap_err();
    assert!(e.contains(studio_core::fleet::MANIFEST), "{e}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn backup_and_restore_through_a_folder() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let a = sim(&s, json!({ "name": "Front Door" })).await;
    let b = sim(&s, json!({ "name": "Back Door" })).await;
    let script = "effect porch:\n  wait for trig1\n  out1 = on\n  sleep 2\n  out1 = off\n";
    let r = rpc(&s, &a, json!({ "op": "set_script", "text": script })).await;
    assert_eq!(r["result"]["ok"], true, "{r}");
    let dir = std::env::temp_dir().join(format!("studio-backups-{}", std::process::id()));
    let path = s.dispatch("backup", json!({ "key": a, "folder": dir })).await.unwrap();
    let list = s.dispatch("backups", json!({ "folder": dir })).await.unwrap();
    assert_eq!(list[0]["name"], "Front Door");
    assert_eq!(list[0]["path"], path);
    let r = s.dispatch("restore", json!({ "key": b, "path": path })).await.unwrap();
    assert_eq!(r["kind"], "restored", "{r}");
    let got = rpc(&s, &b, json!({ "op": "get_script" })).await;
    assert_eq!(got["result"]["text"], script);
    assert_eq!(rpc(&s, &b, json!({ "op": "info" })).await["result"]["name"], "Back Door", "keep_name by default");
    let _ = std::fs::remove_dir_all(dir);
}

/// USB serial: JSON lines through a pseudo-terminal pair; the other end is a fake board that forwards each
/// request to a simulator and also prints console lines (which must be skipped).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn serial_json_lines_through_a_pty() {
    use std::io::{BufRead, BufReader, Write};
    let s = Studio::new();
    let key = sim(&s, json!({ "name": "Serial Prop" })).await;
    let (host, mut board) = serialport::TTYPort::pair().expect("pty pair");
    serialport::SerialPort::set_timeout(&mut board, Duration::from_secs(60)).unwrap(); // the fake board waits for lines
    let base = key.clone();
    let rt = tokio::runtime::Handle::current();
    std::thread::spawn(move || {
        let mut out = board.try_clone_native().unwrap();
        let _ = writeln!(out, "Proptroller booting (a console line)");
        for line in BufReader::new(board).lines() {
            let Ok(line) = line else { break };
            if !line.starts_with('{') { continue; }
            let resp: Value = rt.block_on(async {
                reqwest::Client::new().post(format!("{base}/api/v1/rpc")).header("Content-Type", "application/json").body(line).send().await.unwrap().json().await.unwrap()
            });
            let _ = writeln!(out, "log: handled a request");
            let _ = writeln!(out, "{resp}");
            let _ = writeln!(out, "{}", json!({ "v": 1, "seq": 1, "event": "log", "data": "hello over serial" }));
        }
    });
    let reader = host.try_clone_native().unwrap();
    let mut ev = s.events();
    let mut once: Option<studio_core::conn::Lines> = Some((Box::new(reader), Box::new(host)));
    let c = studio_core::conn::open_lines("serial:test", move || once.take(), s_events(&s));
    // the session is up once the board has answered the opening "info" line
    let mut r = Err(String::new());
    for _ in 0..20 {
        r = c.rpc(json!({ "op": "info" })).await;
        if r.is_ok() { break; }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(r.unwrap()["result"]["name"], "Serial Prop");
    let mut saw = false;
    for _ in 0..20 {
        if let Ok(Ok(Event::Board { key, msg })) = tokio::time::timeout(Duration::from_millis(500), ev.recv()).await {
            if key == "serial:test" && msg["data"] == "hello over serial" { saw = true; break; }
        }
    }
    assert!(saw, "events over serial");
    c.close();
}

fn s_events(s: &Studio) -> tokio::sync::broadcast::Sender<Event> {
    s.event_sender()
}

/// The serial monitor on a pseudo-terminal: lines in as events, a typed line out, friendly names.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn serial_monitor_lines_both_ways() {
    use std::io::{BufRead, BufReader, Write};
    use serialport::SerialPort;
    let s = Studio::new();
    let (mut master, slave) = serialport::TTYPort::pair().expect("pty pair");
    let path = slave.name().unwrap();
    let mut ev = s.events();
    s.dispatch("monitor_open", json!({ "path": path, "baud": 115200 })).await.unwrap();
    master.write_all(b"temp:21.5 hum:40\r\n").unwrap();
    let mut got = None;
    for _ in 0..20 {
        if let Ok(Ok(Event::Serial { line, status: None, .. })) = tokio::time::timeout(Duration::from_millis(500), ev.recv()).await {
            got = Some(line);
            break;
        }
    }
    assert_eq!(got.as_deref(), Some("temp:21.5 hum:40"));
    s.dispatch("monitor_send", json!({ "path": path, "line": "status" })).await.unwrap();
    master.set_timeout(Duration::from_secs(3)).unwrap();
    let mut line = String::new();
    BufReader::new(master.try_clone_native().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line, "status\n");
    s.dispatch("monitor_close", json!({ "path": path })).await.unwrap();
    assert!(s.dispatch("monitor_send", json!({ "path": path, "line": "x" })).await.is_err());
    assert_eq!(studio_core::monitor::friendly(0x10c4, 0xea60, None), "ESP32 board (CP210x USB chip)");
    assert_eq!(studio_core::monitor::friendly(0x2e8a, 0x000a, None), "Raspberry Pi Pico");
    drop(slave);
}

#[tokio::test(flavor = "multi_thread")]
async fn sounds_are_numbers_and_no_list_goes_to_the_board() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let key = sim(&s, json!({})).await;
    let ws = std::env::temp_dir().join(format!("studio-snd-{}", std::process::id()));
    s.dispatch("workspace_init", json!({ "folder": ws })).await.unwrap();
    std::fs::write(ws.join("sounds.csv"), "number,file\n1,chime.mp3\n").unwrap();  // the SD card tool's list: a hint only
    let text = "effect bell:\n  wait for trig1\n  audio_single = 1\n";
    let c = s.dispatch("check_script", json!({ "text": text, "folder": ws })).await.unwrap();
    assert_eq!(c["ok"], true, "{c}");
    let bad = s.dispatch("check_script", json!({ "text": text.replace("= 1", "= chime.mp3"), "folder": ws })).await.unwrap();
    assert!(bad["errors"][0]["message"].as_str().unwrap().contains("\"chime.mp3\" is not a sound number"), "{bad}");
    s.dispatch("library_save", json!({ "folder": ws, "name": "bell", "text": text, "now": "2026-10-21 22:00" })).await.unwrap();
    let r = s.dispatch("send_script", json!({ "key": key, "folder": ws, "name": "bell" })).await.unwrap();
    assert_eq!(r["result"]["ok"], true, "{r}");
    let got = rpc(&s, &key, json!({ "op": "get_script" })).await;
    assert!(got["result"]["sounds"].as_object().map_or(true, |m| m.is_empty()), "{got}");
    assert_eq!(s.dispatch("library_identify", json!({ "folder": ws, "text": got["result"]["text"] })).await.unwrap()["status"], "current");
    // edited on the board's page and sent to this board only: the board's own version of "bell" ...
    let edited = format!("{text}  sleep 1\n");
    let r = s.dispatch("send_script", json!({ "key": key, "folder": ws, "name": "bell", "text": edited, "now": "2026-10-21 22:05" })).await.unwrap();
    assert_eq!(r["result"]["ok"], true, "{r}");
    let got = rpc(&s, &key, json!({ "op": "get_script" })).await;
    let on_board = got["result"]["text"].as_str().unwrap().to_string();
    assert!(on_board.starts_with("# Specter Studio: bell, saved 2026-10-21 22:05\n"), "{on_board}");
    assert!(on_board.ends_with("  sleep 1\n"), "{on_board}");
    let id = s.dispatch("library_identify", json!({ "folder": ws, "text": on_board })).await.unwrap();
    assert_eq!(id["status"], "changed", "{id}");
    assert_eq!(id["name"], "bell");
    // ... and saved to the library afterwards: up to date
    s.dispatch("library_save", json!({ "folder": ws, "name": "bell", "text": on_board, "now": "2026-10-21 22:06" })).await.unwrap();
    assert_eq!(s.dispatch("library_identify", json!({ "folder": ws, "text": on_board })).await.unwrap()["status"], "current");
    // without a name: no header, not in the library
    let r = s.dispatch("send_script", json!({ "key": key, "folder": ws, "text": "# Specter Studio: bell, saved x\neffect other:\n  wait for trig2\n  out2 = on\n" })).await.unwrap();
    assert_eq!(r["result"]["ok"], true, "{r}");
    let got = rpc(&s, &key, json!({ "op": "get_script" })).await;
    assert!(got["result"]["text"].as_str().unwrap().starts_with("effect other:"), "{got}");
    assert_eq!(s.dispatch("library_identify", json!({ "folder": ws, "text": got["result"]["text"] })).await.unwrap()["status"], "unknown");
    let _ = std::fs::remove_dir_all(ws);
}

/// A USB board that goes away (reset, unplug) comes back by itself: the second "port" is a new pty pair.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn serial_session_comes_back_after_the_port_went_away() {
    use std::io::{BufRead, BufReader, Write};
    let s = Studio::new();
    // a fake board answering "info" with its own name, for `answers` requests, then gone
    fn fake(name: &'static str, answers: usize) -> studio_core::conn::Lines {
        let (host, mut board) = serialport::TTYPort::pair().unwrap();
        serialport::SerialPort::set_timeout(&mut board, Duration::from_secs(60)).unwrap();
        std::thread::spawn(move || {
            let mut out = board.try_clone_native().unwrap();
            for line in BufReader::new(board).lines().take(answers) {
                let Ok(line) = line else { break };
                let v: Value = serde_json::from_str(&line).unwrap();
                let _ = writeln!(out, "{}", json!({ "v": 1, "id": v["id"], "ok": true, "result": { "kind": "info", "name": name } }));
            }
        });
        let r = host.try_clone_native().unwrap();
        (Box::new(r), Box::new(host))
    }
    let (tx, rx) = std::sync::mpsc::channel::<studio_core::conn::Lines>();
    tx.send(fake("first", 2)).unwrap();
    let c = studio_core::conn::open_lines("serial:test2", move || rx.try_recv().ok(), s.event_sender());
    let ask = |c: std::sync::Arc<studio_core::conn::Conn>| async move {
        for _ in 0..40 {
            if let Ok(r) = c.rpc(json!({ "op": "info" })).await { return Some(r["result"]["name"].as_str().unwrap().to_string()); }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        None
    };
    assert_eq!(ask(c.clone()).await.as_deref(), Some("first"));
    tx.send(fake("second", 100)).unwrap(); // the board comes back (the first one answered its last request)
    let mut got = None;
    for _ in 0..40 {
        got = ask(c.clone()).await;
        if got.as_deref() == Some("second") { break; }
    }
    assert_eq!(got.as_deref(), Some("second"));
    c.close();
}

/// A USB board that restarts with the port kept open (a new firmware, a restart over the network) prints its
/// "ready after" line: the session goes offline and comes back with the board's next answer, so Studio reads the
/// new info (its firmware type) as it does after a network board's restart.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn serial_session_goes_offline_and_back_when_the_board_restarts() {
    use std::io::{BufRead, BufReader, Write};
    let s = Studio::new();
    let (host, mut board) = serialport::TTYPort::pair().unwrap();
    serialport::SerialPort::set_timeout(&mut board, Duration::from_secs(60)).unwrap();
    let (restart_tx, restart_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut out = board.try_clone_native().unwrap();
        let mut fw = "generic";
        for line in BufReader::new(board).lines() {
            let Ok(line) = line else { break };
            if restart_rx.try_recv().is_ok() {
                fw = "other";
                let _ = writeln!(out, "[proptroller] ready after 461 ms");
                continue; // the request that landed in the boot is lost
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let _ = writeln!(out, "{}", json!({ "v": 1, "id": v["id"], "ok": true, "result": { "kind": "info", "name": "Restarter", "fw": fw } }));
        }
    });
    let r = host.try_clone_native().unwrap();
    let mut once: Option<studio_core::conn::Lines> = Some((Box::new(r), Box::new(host)));
    let mut ev = s.events();
    let c = studio_core::conn::open_lines("serial:restarts", move || once.take(), s.event_sender());
    let fw = |c: std::sync::Arc<studio_core::conn::Conn>| async move {
        for _ in 0..40 {
            if let Ok(r) = c.rpc(json!({ "op": "info" })).await { return r["result"]["fw"].as_str().unwrap_or("").to_string(); }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        String::new()
    };
    assert_eq!(fw(c.clone()).await, "generic");
    let mut seen = vec![];
    while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(200), ev.recv()).await {
        if let Event::Online { key, online } = e { if key == "serial:restarts" { seen.push(online); } }
    }
    assert_eq!(seen, vec![true]);
    restart_tx.send(()).unwrap();
    let _ = c.rpc(json!({ "op": "state" })).await; // lost in the boot; the session asks "info" again by itself
    let mut seen = vec![];
    for _ in 0..40 {
        if let Ok(Ok(Event::Online { key, online })) = tokio::time::timeout(Duration::from_millis(250), ev.recv()).await {
            if key == "serial:restarts" { seen.push(online); }
        }
        if seen.len() >= 2 { break; }
    }
    assert_eq!(seen, vec![false, true], "offline at the restart, online with the next answer");
    assert_eq!(fw(c.clone()).await, "other");
    c.close();
}

/// An implementation switch backs the board up to the library's .specter/backups on disk first and restores
/// it after the new image runs.
#[tokio::test(flavor = "multi_thread")]
async fn implementation_switch_keeps_a_backup_on_disk() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let key = sim(&s, json!({ "speed": 10.0, "name": "Switch Prop" })).await;
    let script = "effect porch:\n  wait for trig1\n  out1 = on\n  sleep 2\n  out1 = off\n";
    assert_eq!(rpc(&s, &key, json!({ "op": "set_script", "text": script })).await["result"]["ok"], true);
    let ws = std::env::temp_dir().join(format!("studio-switch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    let addr = key.clone();
    let r = studio_core::fleet::switch_update(s.conn(&key).unwrap(), &key, &addr, sim_image("0.4.0", "sw00001", true), ws.to_str().unwrap(), None, &s.event_sender()).await.unwrap();
    assert_eq!(r["result"], "valid", "{r}");
    let saved = r["backup"].as_str().unwrap();
    let sp = std::path::Path::new(saved);
    assert!(sp.parent().unwrap().ends_with(std::path::Path::new(".specter").join("backups")), "{saved}");
    assert!(sp.file_name().unwrap().to_string_lossy().starts_with("Switch-Prop-"), "{saved}");
    let b: Value = serde_json::from_str(&std::fs::read_to_string(saved).unwrap()).unwrap();
    assert_eq!(b["script"]["text"], script);
    assert_eq!(rpc(&s, &key, json!({ "op": "get_script" })).await["result"]["text"], script);
    let _ = std::fs::remove_dir_all(ws);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_practice_board_unplugged_and_plugged_in_again_keeps_what_it_held() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let key = sim(&s, json!({})).await;
    let r = rpc(&s, &key, json!({ "op": "set_params", "values": [{ "key": "name", "value": "Porch ghost" }, { "key": "out1_name", "value": "lamp" }] })).await;
    assert_eq!(r["ok"], true, "{r}");
    let r = rpc(&s, &key, json!({ "op": "set_script", "text": "effect porch:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n" })).await;
    assert_eq!(r["ok"], true, "{r}");
    s.dispatch("sim_power", json!({ "key": key, "on": false })).await.unwrap();
    s.dispatch("sim_power", json!({ "key": key, "on": true })).await.unwrap();
    let info = rpc(&s, &key, json!({ "op": "info" })).await;
    assert_eq!(info["result"]["name"], "Porch ghost", "{info}");
    let script = rpc(&s, &key, json!({ "op": "get_script" })).await;
    assert!(script["result"]["text"].as_str().unwrap_or("").contains("effect porch:"), "{script}");
}

/// S6: the router gives a board's address to another device. Studio notices on reconnecting (the board's id
/// changed), refuses every request there (no action or page password reaches the other device) and says so;
/// when the board itself is back, everything works again.
#[tokio::test(flavor = "multi_thread")]
async fn another_device_at_a_known_address_gets_nothing() {
    if no_simulator_here() {
        return;
    }
    use studio_core::{conn, sim};
    let a = sim::start(&sim::SimOptions { id: Some("aaaa0001".into()), ..Default::default() }).unwrap();
    let port = a.port;
    let (tx, mut ev) = tokio::sync::broadcast::channel(256);
    let c = conn::open_ws("k", &a.address, tx);
    let wait_online = |c: std::sync::Arc<conn::Conn>, want: bool| async move {
        for _ in 0..100 {
            if c.online.load(std::sync::atomic::Ordering::Relaxed) == want { return true; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    };
    assert!(wait_online(c.clone(), true).await);
    assert_eq!(c.rpc(json!({ "op": "info" })).await.unwrap()["result"]["id"], "aaaa0001");
    drop(a);
    assert!(wait_online(c.clone(), false).await);
    let b = sim::start(&sim::SimOptions { id: Some("bbbb0002".into()), port: Some(port), ..Default::default() }).unwrap();
    let mut refused = String::new();
    for _ in 0..60 {
        match c.rpc(json!({ "op": "set_output", "channel": "OUT1", "level": 1000 })).await {
            Err(e) if e.contains("different device") => { refused = e; break; }
            Ok(r) => panic!("a request reached the other device: {r}"),
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    assert!(refused.contains("different device"), "{refused}");
    assert!(!c.online.load(std::sync::atomic::Ordering::Relaxed));
    let mut said = false;
    while let Ok(e) = ev.try_recv() {
        if let Event::Board { msg, .. } = e { said |= msg["other_device"] == true; }
    }
    assert!(said, "one log event says why");
    drop(b);
    let _a2 = sim::start(&sim::SimOptions { id: Some("aaaa0001".into()), port: Some(port), ..Default::default() }).unwrap();
    assert!(wait_online(c.clone(), true).await, "the board itself is back");
    assert_eq!(c.rpc(json!({ "op": "info" })).await.unwrap()["result"]["id"], "aaaa0001");
}

/// Backup file names carry the local time the UI gives (the list shows local times); anything else falls back
/// to UTC, and a malformed time never reaches the file name.
#[tokio::test(flavor = "multi_thread")]
async fn backup_file_names_use_the_local_time_from_the_ui() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let key = sim(&s, json!({ "name": "Clock Prop" })).await;
    let dir = std::env::temp_dir().join(format!("studio-bk-local-{}", std::process::id()));
    let p = s.dispatch("backup", json!({ "key": key, "folder": dir, "now": "2026-10-22-131415" })).await.unwrap();
    assert!(p.as_str().unwrap().ends_with("-2026-10-22-131415.proptroller.json"), "{p}");
    assert_eq!(studio_core::fleet::local_stamp(Some("2026-10-22-131415")), "2026-10-22-131415");
    for bad in ["../../etc/x", "2026-10-22 13:14:15", "2026-10-22-13141a", ""] {
        let got = studio_core::fleet::local_stamp(Some(bad));
        assert_eq!(got.len(), 17, "{bad} -> {got}");
        assert!(got.chars().all(|c| c.is_ascii_digit() || c == '-'), "{bad} -> {got}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_allowed_plugin_offers_board_packages_profiles_and_scripts() {
    // the dispatch commands only (no board): what the dropdowns list and the requests a choice becomes
    let root = std::env::temp_dir().join(format!("studio-boardfiles-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let dir = root.join("plugins").join("lamps");
    std::fs::create_dir_all(dir.join("files")).unwrap();
    std::fs::write(dir.join("plugin.json"), json!({ "id": "lamps", "name": "Lamps",
        "board_packages": ["files/lamp.json"], "profiles": [{ "name": "Lamp words", "file": "files/profile.json" }],
        "scripts": [{ "name": "Blink", "file": "files/blink.txt" }] }).to_string()).unwrap();
    std::fs::write(dir.join("files/lamp.json"), json!({ "board_package": 1, "id": "lamp-board", "name": "Demo lamp board", "mcu": "esp32-devkit" }).to_string()).unwrap();
    std::fs::write(dir.join("files/profile.json"), r#"{"title":"Lamp"}"#).unwrap();
    std::fs::write(dir.join("files/blink.txt"), "effect1: blink\n").unwrap();
    let s = Studio::new();
    s.plugin_dirs.lock().unwrap().push(root.join("plugins"));

    // a plugin with only these files has no page of its own
    let p = s.dispatch("plugins", json!({})).await.unwrap();
    let lamps = p.as_array().unwrap().iter().find(|x| x["id"] == "lamps").unwrap();
    assert!(lamps.get("entry").is_none(), "{lamps}");

    // listed only once allowed
    let none = s.dispatch("board_files", json!({})).await.unwrap();
    assert_eq!(none["packages"].as_array().unwrap().len(), 0);
    let l = s.dispatch("board_files", json!({ "plugins": ["lamps"] })).await.unwrap();
    assert_eq!(l["packages"][0]["name"], "Demo lamp board");
    assert_eq!(l["profiles"][0]["name"], "Lamp words");
    assert_eq!(l["scripts"][0]["name"], "Blink");

    let r = s.dispatch("board_setup", json!({ "plugins": ["lamps"], "defaults": true,
        "package": { "plugin": "lamps", "file": "files/lamp.json" }, "profile": { "plugin": "lamps", "file": "files/profile.json" },
        "script": { "plugin": "lamps", "file": "files/blink.txt" } })).await.unwrap();
    // with the package's defaults applied at the restart, the profile and script go into them (sent before it they
    // would be replaced)
    let ops: Vec<&str> = r["requests"].as_array().unwrap().iter().map(|x| x["op"].as_str().unwrap()).collect();
    assert_eq!(ops, ["set_board"]);
    assert_eq!(r["requests"][0]["package"]["id"], "lamp-board");
    assert_eq!(r["requests"][0]["defaults"], "apply");
    assert_eq!(r["requests"][0]["package"]["defaults"]["script"], "effect1: blink\n");
    assert_eq!(r["after_restart"], json!([]));
    assert_eq!(r["restart_needed"], true);
    assert_eq!(r["reboot"], json!({ "op": "reboot" }));
    // a file of a plugin that is not allowed, or one it does not list: refused
    let e = s.dispatch("board_setup", json!({ "package": { "plugin": "lamps", "file": "files/lamp.json" } })).await.unwrap_err();
    assert!(e.contains("not allowed"), "{e}");
    let e = s.dispatch("board_setup", json!({ "plugins": ["lamps"], "package": { "plugin": "lamps", "file": "plugin.json" } })).await.unwrap_err();
    assert!(e.contains("does not offer"), "{e}");

    // a USB install with the package file: the file system image is a second part of the same esptool write
    // (a dry run: nothing is written), with the profile and script in the package's defaults
    let mut merged = vec![0xFFu8; 0x1000];
    merged.extend([0xE9, 0, 0, 0]);
    let stock = root.join("stock");
    release_folder(&stock, "0.3.0", &[("generic", "esp32-devkit", "first-flash.bin", merged, true)]);
    let setup = json!({ "package": { "plugin": "lamps", "file": "files/lamp.json" }, "profile": { "plugin": "lamps", "file": "files/profile.json" }, "script": { "plugin": "lamps", "file": "files/blink.txt" } });
    let u = json!({ "source": stock.to_string_lossy(), "plugins": ["lamps"], "fw": "generic", "mcu": "esp32-devkit", "port": "/dev/not-a-board", "dry_run": true, "setup": setup });
    let r = s.dispatch("usb_install", u.clone()).await.unwrap();
    assert_eq!(r["plan"]["parts"][1]["offset"], "0x3D0000", "{r}");
    assert_eq!(r["plan"]["parts"][1]["bytes"], 128 * 1024);
    assert_eq!(r["board_package"], "Demo lamp board");
    assert!(r["send_after"].is_null(), "{r}");
    let cmd: Vec<String> = serde_json::from_value(r["command"].clone()).unwrap();
    assert!(cmd.contains(&"0x3D0000".to_string()), "{cmd:?}");
    let fs = std::fs::read(r["plan"]["parts"][1]["file"].as_str().unwrap()).unwrap();
    let (j, apply) = studio_core::fsimage::image_package("esp32-devkit", &fs).unwrap();
    let v: Value = serde_json::from_str(&j).unwrap();
    assert_eq!((v["id"].as_str(), v["defaults"]["script"].as_str(), apply), (Some("lamp-board"), Some("effect1: blink\n"), true));
    // the Proptroller board: a fresh file system goes on with the firmware (no package left from earlier firmware)
    let mut p = u.clone();
    p["setup"] = json!({ "package": { "preset": "proptroller" } });
    let r = s.dispatch("usb_install", p.clone()).await.unwrap();
    assert_eq!(r["plan"]["parts"][1]["offset"], "0x3D0000", "{r}");
    let fs = std::fs::read(r["plan"]["parts"][1]["file"].as_str().unwrap()).unwrap();
    let l = studio_core::fsimage::layout("esp32-devkit").unwrap();
    assert!(studio_core::fsimage::read_fs(&l, &fs, "/board-a.bin").is_err(), "a fresh file system: no board record");
    // another built-in one only as the board gave it (get_board with preset), as a package
    p["setup"] = json!({ "package": { "preset": "relay-board" } });
    assert!(s.dispatch("usb_install", p.clone()).await.unwrap_err().contains("as the board gave it"));
    p["setup"] = json!({ "package": { "inline": { "board_package": 1, "id": "relay-board", "name": "Relay board", "mcu": "esp32-devkit" } } });
    let r = s.dispatch("usb_install", p).await.unwrap();
    let fs = std::fs::read(r["plan"]["parts"][1]["file"].as_str().unwrap()).unwrap();
    assert!(studio_core::fsimage::image_package("esp32-devkit", &fs).unwrap().0.contains("relay-board"));
    let _ = std::fs::remove_dir_all(root);
}
