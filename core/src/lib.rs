//! Specter Studio's device layer. Everything the UI asks for goes through [`Studio::dispatch`]
//! (a command name and JSON arguments, a JSON answer); everything boards push comes out of
//! [`Studio::events`]. The Tauri shell and the test bridge are thin wrappers around these two.

pub mod adapters;
pub mod automation;
pub mod boardpkg;
pub mod builder;
pub mod conn;
pub mod discover;
pub mod extensions;
pub mod fleet;
pub mod gitsync;
pub mod flash;
pub mod fsimage;
pub mod fwtypes;
pub mod library;
pub mod monitor;
pub mod mqtt;
pub mod nightlog;
pub mod patterns;
pub mod plugins;
pub mod projects;
pub mod sdcard;
pub mod secrets;
pub mod sim;
pub mod sources;
pub mod unsaved;
pub mod viewer;

use conn::Conn;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    /// A message the board pushed (`{"v":1,"seq":..,"event":..,"data":..}`).
    Board { key: String, msg: Value },
    /// The session came up or went down (it reconnects by itself).
    Online { key: String, online: bool },
    /// An over-the-air update's progress, as Studio sees it.
    Update { key: String, phase: String, detail: Value },
    /// A line from the serial monitor, or (with `status`) the monitor connected / lost the port.
    /// A board reporting to Studio's MQTT server changed (online, state, a status line).
    Fleet { board: Value },
    /// An event a board published on Studio's MQTT server (`<p>/event`: a run, a notice, a log line,
    /// `params_changed` ...), with the board it came from (`key` = `<prefix>/<name>`, as in `Fleet`).
    FleetEvent { key: String, name: String, msg: Value },
    /// Any message on Studio's MQTT server (device adapters subscribe to the topics they declare).
    Mqtt { topic: String, payload: String, retained: bool },
    /// A line of a firmware build's output.
    Build { project: String, line: String },
    Serial { path: String, line: String, #[serde(skip_serializing_if = "Option::is_none")] status: Option<String> },
    /// The library's scripts repository did something (Get latest, Back up everything, auto save): the answer
    /// (`gitsync::answer`), and whether auto save started it.
    ScriptsRepo { folder: String, auto: bool, result: Value },
    /// The SD card tool's progress (sdcard.rs): `phase` format / clear / copy / backup / done, `done` of `total`,
    /// the file being written.
    SdCard { phase: String, done: usize, total: usize, file: String },
    /// Some events were dropped on their way to the UI (it fell behind): it should read the connections and
    /// every board's state again. Sent by the shell and the bridge to that one listener, never broadcast.
    Resync,
}

struct Device {
    conn: Arc<Conn>,
    address: Option<String>,
    sim: Option<sim::Sim>,
    /// a practice board's options (to switch it on again on the same port)
    sim_opts: Option<sim::SimOptions>,
    /// a practice board switched off: what it held (its backup), given back when it is switched on again, as a
    /// real board keeps its settings, shows and effect script without power
    sim_memory: Option<Value>,
}

pub struct Studio {
    devices: Mutex<HashMap<String, Device>>,
    events: broadcast::Sender<Event>,
    /// Where plugins are looked for (each a folder with plugin.json).
    pub plugin_dirs: Mutex<Vec<std::path::PathBuf>>,
    monitors: monitor::Monitors,
    checker_lock: tokio::sync::Mutex<()>,
    fleet: Mutex<Option<Arc<mqtt::Fleet>>>,
    viewer: Mutex<Option<viewer::Viewer>>,
    /// The person's library folder ("My Props"), as the UI last named it (`workspace_set`, or the folder of a
    /// library listing or workspace set-up): file reads and writes stay inside it whatever folder a caller names.
    workspace: Mutex<Option<std::path::PathBuf>>,
    /// Script sources and extensions from git (gitsync.rs): one git operation at a time, auto save.
    pub scripts: gitsync::Scripts,
    /// Where extensions added from git are cloned (the app's config folder; `SPECTER_STUDIO_EXTENSIONS_DIR`).
    extensions_dir: Mutex<Option<std::path::PathBuf>>,
    /// "When a message arrives, send a web request" rules (Settings, Automation)
    pub automation: Arc<automation::Engine>,
}

impl Default for Studio {
    fn default() -> Self {
        Self::new()
    }
}

fn arg<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a[k].as_str().ok_or_else(|| format!("missing \"{k}\""))
}

/// A folder argument: never empty (an empty path would put files in the app's working directory).
fn folder(a: &Value) -> Result<&str, String> {
    a["folder"].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| "choose a folder first (Settings)".to_string())
}

/// `path` canonicalised, and only when it lies inside the folder `root` (file access is limited to the
/// person's workspace).
fn inside(root: &str, path: &str) -> Result<std::path::PathBuf, String> {
    let r = dunce::canonicalize(root).map_err(|_| format!("{root} does not exist"))?;
    let p = std::path::Path::new(path);
    let parent = dunce::canonicalize(p.parent().ok_or("not a file path")?).map_err(|_| format!("{path}: no such folder"))?;
    let full = parent.join(p.file_name().ok_or("not a file path")?);
    // a link in the folder that points elsewhere is not followed (N2)
    if std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{path} is a link to somewhere else: Studio does not follow it"));
    }
    if full.starts_with(&r) { Ok(full) } else { Err(format!("{path} is outside your library folder")) }
}

fn opt_str(a: &Value, k: &str) -> Option<String> {
    a[k].as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// This computer's address on the local network (the one other devices reach it at), else "localhost".
pub fn this_computer() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| { s.connect("192.0.2.1:9")?; s.local_addr() }) // nothing is sent: it only picks a route
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "localhost".into())
}

/// The firmware's `firmware/arduino` (the Proptroller library and the project template): `SPECTER_FIRMWARE_DIR`,
/// else the firmware submodule (development).
pub fn arduino_dir() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("SPECTER_FIRMWARE_DIR") {
        return Some(p.into());
    }
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../firmware/firmware/arduino");
    // the library is the firmware's lib/proptroller (the project template moved to workspace-template)
    dev.join("lib/proptroller").exists().then(|| dunce::canonicalize(&dev).unwrap_or(dev))
}

impl Studio {
    pub fn new() -> Self {
        Studio { devices: Mutex::new(HashMap::new()), events: broadcast::channel(1024).0, plugin_dirs: Mutex::new(vec![]), monitors: Default::default(), checker_lock: Default::default(), fleet: Mutex::new(None), viewer: Mutex::new(None), workspace: Mutex::new(None), scripts: Default::default(), extensions_dir: Mutex::new(None), automation: automation::Engine::new(Arc::new(secrets::Keychain), Arc::new(automation::delivery::Web::new()), Default::default()) }
    }

    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Closes every session and stops every practice board and serial monitor (the app is quitting).
    pub fn shutdown(&self) {
        if let Some(f) = self.fleet.lock().unwrap().as_ref() {
            f.shutdown();
        }
        self.devices.lock().unwrap().clear();
        self.monitors.close_all();
        // counters and timers changed in the last moment before closing
        self.automation.save_state();
    }

    pub fn event_sender(&self) -> broadcast::Sender<Event> {
        self.events.clone()
    }

    pub fn conn(&self, key: &str) -> Result<Arc<Conn>, String> {
        self.devices.lock().unwrap().get(key).map(|d| d.conn.clone()).ok_or_else(|| format!("{key} is not connected"))
    }

    /// Remembers `folder` as the library folder (canonical when it exists).
    fn remember_workspace(&self, folder: &str) {
        let p = std::path::Path::new(folder);
        *self.workspace.lock().unwrap() = Some(dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()));
    }

    /// The folder file reads and writes may use: the remembered library folder. The caller's `folder` must be
    /// that same folder (a first file request with nothing remembered yet remembers it).
    fn file_root(&self, a: &Value) -> Result<String, String> {
        let asked = folder(a)?;
        let canon = dunce::canonicalize(asked).map_err(|_| format!("{asked} does not exist"))?;
        let mut w = self.workspace.lock().unwrap();
        match &*w {
            Some(root) if *root != canon => Err("files can be read and written only in your library folder".into()),
            Some(root) => Ok(root.to_string_lossy().into_owned()),
            None => {
                *w = Some(canon.clone());
                Ok(canon.to_string_lossy().into_owned())
            }
        }
    }

    fn address(&self, key: &str) -> Result<String, String> {
        self.devices.lock().unwrap().get(key).and_then(|d| d.address.clone()).ok_or_else(|| format!("{key} is connected over USB, not over the network: Studio does this through its USB port"))
    }

    /// Opens the session and waits for the board's `info`: up to 5 s on the network, 8 s over USB (an ESP32
    /// DevKit restarts when its port opens and needs about half a second to boot before it answers).
    async fn add(&self, key: String, conn: Arc<Conn>, address: Option<String>, sim: Option<sim::Sim>) -> Result<Value, String> {
        self.devices.lock().unwrap().insert(key.clone(), Device { conn: conn.clone(), address, sim, sim_opts: None, sim_memory: None });
        let serial = key.strip_prefix("serial:").map(String::from);
        let deadline = tokio::time::Instant::now() + if serial.is_some() { SERIAL_CONNECT_WAIT } else { Duration::from_secs(5) };
        let last = loop {
            match conn.rpc(json!({ "op": "info" })).await {
                Ok(r) => {
                    *conn.info.lock().unwrap() = Some(r["result"].clone());
                    return Ok(json!({ "key": key, "info": r["result"] }));
                }
                Err(e) if tokio::time::Instant::now() >= deadline => break e,
                Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        };
        let mut d = self.devices.lock().unwrap();
        if d.get(&key).is_some_and(|x| Arc::ptr_eq(&x.conn, &conn)) {
            d.remove(&key);
        }
        if last != "the board is not connected" {
            return Err(last);
        }
        Err(match serial {
            Some(path) => serial_silence(&path, conn.heard_text.load(std::sync::atomic::Ordering::Relaxed)),
            None => format!("no board answers at {key}"),
        })
    }

    /// One board, one session: a board just connected at `key` that Studio already has under another key (its IP
    /// address and its `name.local`, or USB and Wi-Fi) keeps the older session; the new one is closed. The answer
    /// then names the older key (`same_as`: what was asked).
    fn same_board(&self, key: &str, r: Value) -> Value {
        let Some(id) = r["info"]["id"].as_str().filter(|i| !i.is_empty()) else { return r };
        let mut d = self.devices.lock().unwrap();
        // only a session that answers now: a board that left its Wi-Fi (a factory reset, "Start fresh") and is
        // plugged in with USB gets its USB session, not the offline network one
        let other = d
            .iter()
            .find(|(k, v)| k.as_str() != key && v.sim.is_none() && v.conn.board_id().as_deref() == Some(id) && v.conn.online.load(std::sync::atomic::Ordering::Relaxed))
            .map(|(k, _)| k.clone());
        match other {
            Some(k) => {
                d.remove(key);
                json!({ "key": k, "info": r["info"], "same_as": key })
            }
            None => r,
        }
    }

    /// The firmware types for a request's `source` (the Settings release source) and `plugins` (the ids of the
    /// plugins the person allowed): docs/DESIGN.md "Firmware types".
    fn firmware_types(&self, a: &Value) -> Vec<Value> {
        let (plugins, allowed) = self.allowed_plugins(a);
        let mut types = fwtypes::types(a["source"].as_str().unwrap_or(""), &plugins, &allowed);
        // Settings "Allow betas": every type's GitHub list may then offer a pre-release
        for t in &mut types {
            t["betas"] = json!(a["betas"] == true);
        }
        types
    }

    /// Every plugin, and the ids of the ones the person allowed (a request's `plugins`, from the UI).
    fn allowed_plugins(&self, a: &Value) -> (Vec<Value>, Vec<String>) {
        let allowed: Vec<String> = a["plugins"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
        (plugins::list(&self.plugin_dirs.lock().unwrap()), allowed)
    }

    /// Upload: build the firmware for the board's kind, then over Wi-Fi (`key`, an over-the-air update) or
    /// USB (`port` for an ESP32, `drive` for a Pico in BOOTSEL mode, with `confirm`).
    async fn upload(&self, a: &Value) -> Result<Value, String> {
        let ws = std::path::PathBuf::from(folder(a)?);
        let name = arg(a, "name")?.to_string();
        let key = opt_str(a, "key");
        let board: Option<String> = match &key {
            Some(k) => {
                self.address(k).map_err(|_| "upload to this board over Wi-Fi or plug it in with USB".to_string())?;
                let info = self.conn(k)?.rpc(json!({ "op": "info" })).await?;
                let mcu = info["result"]["mcu"].as_str().unwrap_or("").to_string();
                Some(builder::board_for_mcu(&mcu).ok_or_else(|| format!("a {mcu} board cannot run your own firmware"))?.to_string())
            }
            None => opt_str(a, "board"),
        };
        let ev = self.events.clone();
        let (w, n, b) = (ws.clone(), name.clone(), board.clone());
        let built = tokio::task::spawn_blocking(move || builder::build(&w, &n, b.as_deref(), &ev)).await.map_err(|e| e.to_string())??;
        let id = built["build_id"].as_str().unwrap_or("").to_string();
        if a["build_only"] == true {
            return Ok(json!({ "message": format!("Built {id}."), "log": built["log"], "build": built }));
        }
        if let Some(k) = key {
            let address = self.address(&k)?;
            let image = std::fs::read(built["image"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
            let r = fleet::update(&k, &address, image, opt_str(a, "pin"), &self.events).await?;
            let msg = if r["result"] == "valid" { format!("{id} is on the board and running.") } else { format!("The board could not start {id} and went back to its previous firmware. Nothing was lost.") };
            return Ok(json!({ "message": msg, "log": built["log"], "result": r }));
        }
        let board = built["board"].as_str().unwrap_or("").to_string();
        if board == "picow" || board == "pico2w" {
            // a first flash over USB: the bootloader and the firmware in one file
            let app_build = std::path::PathBuf::from(built["out"].as_str().unwrap_or("")).parent().map(|p| p.to_path_buf()).unwrap_or_default();
            let (ev, n) = (self.events.clone(), name.clone());
            tokio::task::spawn_blocking(move || builder::merge_pico(&app_build, &board, &ev, &n)).await.map_err(|e| e.to_string())??;
        }
        let mut f = json!({ "board": built["board"], "build_dir": built["out"], "confirm": a["confirm"], "dry_run": a["dry_run"] });
        for k in ["port", "drive"] {
            if let Some(v) = opt_str(a, k) {
                f[k] = json!(v);
            }
        }
        let r = flash::flash(&f).await?;
        Ok(json!({ "message": format!("{id} is written to the board over USB."), "log": built["log"], "flash": r }))
    }

    /// Commands the UI never sends (tests and development tools only): never reachable from the app's window or
    /// the bridge, which call [`Studio::dispatch`]. Anything else goes on to `dispatch`.
    pub async fn dispatch_dev(&self, cmd: &str, a: Value) -> Result<Value, String> {
        match cmd {
            "probe" => discover::probe(arg(&a, "address")?).await,
            "mqtt_rpc" => {
                let f = self.fleet.lock().unwrap().clone().ok_or("the MQTT server is not running")?;
                f.rpc(arg(&a, "prefix")?, arg(&a, "name")?, a.get("req").cloned().ok_or("missing \"req\"")?).await
            }
            "flash_plan" => flash::plan(arg(&a, "board")?, arg(&a, "build_dir")?).map(|p| json!(p)),
            "flash" => flash::flash(&a).await,
            "secret_delete" => {
                let e = keyring::Entry::new("specter-studio", arg(&a, "name")?).map_err(|e| e.to_string())?;
                let _ = e.delete_credential();
                Ok(json!(null))
            }
            "firmware_build" => {
                let (ws, name, board, ev) = (std::path::PathBuf::from(folder(&a)?), arg(&a, "name")?.to_string(), opt_str(&a, "board"), self.events.clone());
                tokio::task::spawn_blocking(move || builder::build(&ws, &name, board.as_deref(), &ev)).await.map_err(|e| e.to_string())?
            }
            _ => self.dispatch(cmd, a).await,
        }
    }

    pub async fn dispatch(&self, cmd: &str, a: Value) -> Result<Value, String> {
        let touched = match (gitsync_saves(cmd), self.workspace.lock().unwrap().clone()) {
            (true, Some(ws)) => sources::touched(&ws, cmd, &a),
            _ => vec![],
        };
        // a read-only script source is never written to (library.rs refuses its own commands the same way)
        if cmd == "file_write" && touched.iter().any(|d| gitsync::is_read_only(d)) {
            return Err("That file is in a read-only script source (Studio cannot back up to it). Use Save a copy to… to put it into one of your own sources.".into());
        }
        let r = self.dispatch_inner(cmd, &a).await;
        // a save in a script source: auto save (when it is on for that source) backs up once things are quiet
        if r.is_ok() {
            for d in &touched {
                self.scripts.saved(d, &self.events);
            }
        }
        r
    }

    async fn dispatch_inner(&self, cmd: &str, a: &Value) -> Result<Value, String> {
        let a = a.clone();
        match cmd {
            c if c.starts_with("sources_") || c.starts_with("extension") || c == "open_folder" => self.git_sources(c, &a).await,
            c if c.starts_with("sdcard_") => sdcard::dispatch(c, &a, &self.events).await,
            "discover" => {
                let unicast: Vec<SocketAddr> =
                    a["unicast"].as_array().into_iter().flatten().filter_map(|s| s.as_str()?.parse().ok()).collect();
                let ms = a["timeout_ms"].as_u64().unwrap_or(1500);
                Ok(json!(discover::discover(Duration::from_millis(ms), unicast, a["mdns"] != false).await))
            }
            "serial_ports" => Ok(json!(monitor::ports())),
            "bootsel_drives" => Ok(json!(monitor::bootsel_drives())),
            "monitor_open" => {
                let baud = a["baud"].as_u64().unwrap_or(115_200) as u32;
                self.monitors.open(arg(&a, "path")?, baud, self.events.clone()).map(|_| json!(null))
            }
            "monitor_send" => self.monitors.send(arg(&a, "path")?, arg(&a, "line")?).map(|_| json!(null)),
            "monitor_close" => {
                self.monitors.close(arg(&a, "path")?);
                Ok(json!(null))
            }
            "connect" => {
                if let Some(path) = opt_str(&a, "serial") {
                    let key = format!("serial:{path}");
                    if self.devices.lock().unwrap().contains_key(&key) {
                        return Ok(json!({ "key": key, "info": self.conn(&key)?.rpc(json!({"op":"info"})).await?["result"] }));
                    }
                    let c = conn::open_serial(&path, self.events.clone())?;
                    let r = self.add(key.clone(), c, None, None).await?;
                    return Ok(self.same_board(&key, r));
                }
                let base = discover::normalise(arg(&a, "address")?);
                if self.devices.lock().unwrap().contains_key(&base) {
                    let info = self.conn(&base)?.rpc(json!({ "op": "info" })).await?;
                    return Ok(json!({ "key": base, "info": info["result"] }));
                }
                let c = conn::open_ws(&base, &base, self.events.clone());
                let r = self.add(base.clone(), c, Some(base.clone()), None).await?;
                Ok(self.same_board(&base, r))
            }
            "disconnect" => {
                self.devices.lock().unwrap().remove(arg(&a, "key")?);
                Ok(json!(null))
            }
            "connections" => {
                let d = self.devices.lock().unwrap();
                Ok(json!(d.iter().map(|(k, v)| json!({ "key": k, "online": v.conn.online.load(std::sync::atomic::Ordering::Relaxed), "sim": v.sim.is_some(), "info": *v.conn.info.lock().unwrap() })).collect::<Vec<_>>()))
            }
            "rpc" => {
                let req = a.get("req").cloned().ok_or("missing \"req\"")?;
                self.conn(arg(&a, "key")?)?.rpc(req).await
            }
            "sim_start" => {
                let o = sim::SimOptions {
                    name: opt_str(&a, "name"),
                    id: opt_str(&a, "id"),
                    // SPECTER_SIM_SPEED runs practice boards faster (UI tests: the 30 s self-check after an update)
                    speed: a["speed"].as_f64().or_else(|| std::env::var("SPECTER_SIM_SPEED").ok()?.parse().ok()),
                    fail_self_check: a["fail_self_check"] == true,
                    swap_ms: a["swap_ms"].as_u64(),
                    discovery_port: a["discovery_port"].as_u64().unwrap_or(0) as u16,
                    port: None,
                };
                let o2 = o.clone();
                let s = tokio::task::spawn_blocking(move || sim::start(&o)).await.map_err(|e| e.to_string())??;
                let key = s.address.clone();
                let mut opts = o2;
                opts.port = Some(s.port);
                let c = conn::open_ws(&key, &key, self.events.clone());
                let r = self.add(key.clone(), c, Some(key.clone()), Some(s)).await?;
                if let Some(d) = self.devices.lock().unwrap().get_mut(&key) {
                    d.sim_opts = Some(opts);
                }
                Ok(r)
            }
            "sim_power" => {
                // switch a practice board off (its session waits) or on again on the same address
                let key = arg(&a, "key")?.to_string();
                if a["on"] == true {
                    let o = self.devices.lock().unwrap().get(&key).and_then(|d| d.sim_opts.clone()).ok_or("not a practice board")?;
                    let s = tokio::task::spawn_blocking(move || sim::start(&o)).await.map_err(|e| e.to_string())??;
                    let (conn, memory) = {
                        let mut d = self.devices.lock().unwrap();
                        let d = d.get_mut(&key).ok_or("removed")?;
                        d.sim = Some(s);
                        (d.conn.clone(), d.sim_memory.take())
                    };
                    // give it back what it held: once the session is back, its own backup (with its name)
                    if let Some(data) = memory {
                        for _ in 0..100 {
                            if conn.online.load(std::sync::atomic::Ordering::Relaxed) {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                        let r = conn.rpc(json!({ "op": "put_backup", "data": data, "keep_name": false })).await?;
                        if r["ok"] != true {
                            return Err(r["error"]["message"].as_str().unwrap_or("the practice board did not take back its memory").into());
                        }
                    }
                } else {
                    let conn = self.devices.lock().unwrap().get(&key).map(|d| d.conn.clone()).ok_or("removed")?;
                    let memory = conn.rpc(json!({ "op": "get_backup" })).await.ok().filter(|r| r["ok"] == true).map(|r| r["result"]["data"].clone());
                    let s = {
                        let mut d = self.devices.lock().unwrap();
                        let d = d.get_mut(&key).ok_or("removed")?;
                        d.sim_memory = memory;
                        d.sim.take()
                    };
                    drop(s);
                }
                Ok(json!(null))
            }
            "mqtt_start" => {
                // port 1883 by default: some boards' firmware cannot be told another port
                let existing = self.fleet.lock().unwrap().clone();
                let f = match existing {
                    Some(f) => f,
                    None => {
                        let port = a["port"].as_u64().unwrap_or(1883) as u16;
                        // optional: one network only (`bind`), a login (`user` and `password`, or `secret`: a
                        // keychain name) for networks where only devices that can log in report here
                        let password = opt_str(&a, "password").or_else(|| opt_str(&a, "secret").and_then(|n| keyring::Entry::new("specter-studio", &n).ok()?.get_password().ok()));
                        let o = mqtt::BrokerOptions { bind: opt_str(&a, "bind"), login: opt_str(&a, "user").zip(password) };
                        let f = mqtt::Fleet::start_with(port, &o, self.events.clone())?;
                        self.automation.ensure_started();
                        f.set_automation(self.automation.clone());
                        *self.fleet.lock().unwrap() = Some(f.clone());
                        f
                    }
                };
                Ok(json!({ "port": f.port, "address": this_computer() }))
            }
            "mqtt_status" => Ok(self.fleet.lock().unwrap().as_ref().map(|f| json!({ "port": f.port, "address": this_computer(), "bridge": f.bridge_status() })).unwrap_or(json!(null))),
            "mqtt_boards" => Ok(json!(self.fleet.lock().unwrap().as_ref().map(|f| f.boards()).unwrap_or_default())),
            "mqtt_watch" | "mqtt_unwatch" => {
                let f = self.fleet.lock().unwrap().clone().ok_or("the MQTT server is not running")?;
                if cmd == "mqtt_watch" { f.watch(arg(&a, "filter")?) } else { f.unwatch(arg(&a, "filter")?) }
                Ok(json!(null))
            }
            "mqtt_publish" => {
                let f = self.fleet.lock().unwrap().clone().ok_or("the MQTT server is not running")?;
                f.publish(arg(&a, "topic")?, a["payload"].as_str().unwrap_or("")).map(|_| json!(null))
            }
            "mqtt_retained" => {
                let f = self.fleet.lock().unwrap().clone().ok_or("the MQTT server is not running")?;
                Ok(json!(f.retained_matching(arg(&a, "filter").unwrap_or("#")).await))
            }
            "http_request" => {
                let ports: Vec<u16> = self.devices.lock().unwrap().values().filter_map(|d| d.sim.as_ref().map(|s| s.port)).collect();
                adapters::http_request(&a, &ports).await
            }
            "bridge_start" => {
                let f = self.fleet.lock().unwrap().clone().ok_or("start the MQTT server first")?;
                let mut cfg: mqtt::BridgeConfig = serde_json::from_value(a.clone()).map_err(|e| format!("bridge settings: {e}"))?;
                if let Some(name) = opt_str(&a, "secret") {
                    // the upstream password lives in the system keychain
                    cfg.password = keyring::Entry::new("specter-studio", &name).ok().and_then(|e| e.get_password().ok());
                }
                f.bridge(cfg)?;
                Ok(json!(null))
            }
            "bridge_stop" => {
                if let Some(f) = self.fleet.lock().unwrap().clone() {
                    f.stop_bridge();
                }
                Ok(json!(null))
            }
            "viewer_start" => {
                let port = a["port"].as_u64().unwrap_or(8765) as u16;
                self.viewer.lock().unwrap().take();
                // the sharing password: given, or the one kept in the keychain (`secret`, default "viewer-password")
                let password = opt_str(&a, "password").or_else(|| {
                    let name = opt_str(&a, "secret").unwrap_or_else(|| "viewer-password".into());
                    if name != "viewer-password" {
                        return None;
                    }
                    keyring::Entry::new("specter-studio", &name).ok().and_then(|e| e.get_password().ok()).filter(|p| !p.is_empty())
                });
                // the usual port taken by another program: any free one (the page shows the address)
                let v = match viewer::Viewer::start(port, password.clone()).await {
                    Ok(v) => v,
                    Err(_) if port != 0 => viewer::Viewer::start(0, password).await?,
                    Err(e) => return Err(e),
                };
                let p = v.port;
                *self.viewer.lock().unwrap() = Some(v);
                Ok(json!({ "port": p, "url": format!("http://{}:{p}/", this_computer()) }))
            }
            "viewer_stop" => {
                self.viewer.lock().unwrap().take();
                Ok(json!(null))
            }
            "viewer_publish" => {
                // what Studio shows, plus boards seen only through the MQTT server
                let mut boards = a["boards"].as_array().cloned().unwrap_or_default();
                if let Some(f) = self.fleet.lock().unwrap().as_ref() {
                    for b in f.boards() {
                        let name = b["state"]["name"].as_str().or(b["name"].as_str()).unwrap_or("").to_string();
                        if !boards.iter().any(|x| x["name"] == name.as_str()) {
                            // the run counters: from the state, or the retained status topics
                            let count = |k: &str| if b["state"][k].is_null() { b["status"][k].clone() } else { b["state"][k].clone() };
                            boards.push(json!({ "name": name, "online": b["online"], "kind": "reports over MQTT", "outputs": b["state"]["outputs"],
                                "runs_tonight": count("runs_since_power_on"), "runs_lifetime": count("runs_lifetime") }));
                        }
                    }
                }
                if let Some(v) = self.viewer.lock().unwrap().as_ref() {
                    v.publish(&json!(boards));
                }
                Ok(json!(null))
            }
            "check_script" => {
                // the board's own checker: a connected board (its settings count), else a hidden simulator
                let key = match opt_str(&a, "key") {
                    Some(k) => k,
                    None => {
                        let _one = self.checker_lock.lock().await;
                        let have = self.devices.lock().unwrap().contains_key("checker");
                        if !have {
                            let s = tokio::task::spawn_blocking(|| sim::start(&Default::default())).await.map_err(|e| e.to_string())??;
                            let c = conn::open_ws("checker", &s.address, self.events.clone());
                            let addr = s.address.clone();
                            self.add("checker".into(), c, Some(addr), Some(s)).await?;
                        }
                        "checker".into()
                    }
                };
                // a sound is its number: no sound list goes with the script
                let req = json!({ "op": "check_script", "text": arg(&a, "text")? });
                let r = self.conn(&key)?.rpc(req).await?;
                if r["ok"] != true {
                    return Err(r["error"]["message"].as_str().unwrap_or("the check failed").into());
                }
                Ok(r["result"].clone())
            }
            "manifest" => {
                if a["fresh"] == true {
                    fleet::forget_cached_releases();
                }
                fleet::manifest_with(a["source"].as_str().unwrap_or(""), a["betas"] == true).await
            }
            "releases_default" => Ok(json!(fleet::DEFAULT_SOURCE)),
            // the firmware types Studio can install (the stock firmware, then the allowed plugins' types) and
            // every type's list merged: `{source, plugins: [allowed plugin ids]}`
            "firmware_types" => Ok(json!(self.firmware_types(&a))),
            "firmware_catalog" => {
                if a["fresh"] == true {
                    fleet::forget_cached_releases();
                }
                Ok(fwtypes::catalog(&self.firmware_types(&a)).await)
            }
            // board packages, profiles and scripts the allowed plugins offer (boardpkg.rs): `{plugins}`
            "board_files" => {
                let (plugins, allowed) = self.allowed_plugins(&a);
                Ok(boardpkg::list(&plugins, &allowed))
            }
            // the requests that put a choice on a board, in order, without the restart: `{plugins, package:
            // {preset} | {plugin, file} | {forget: true} | null, defaults, profile: {plugin, file}?, script: {plugin,
            // file}?}` -> `{requests, after_restart, restart_needed, reboot}` (`after_restart`: sent once the board
            // is back, so the package's defaults applied at that boot do not replace them). The UI sends them one by one (with the page password)
            // and asks before it sends `reboot`
            "board_setup" => {
                let (plugins, allowed) = self.allowed_plugins(&a);
                let s = boardpkg::setup_from(&plugins, &allowed, &a)?;
                Ok(json!({ "requests": boardpkg::requests(&s), "after_restart": boardpkg::after_restart(&s), "restart_needed": boardpkg::restart_needed(&s), "reboot": boardpkg::reboot() }))
            }
            "update_plan" => {
                // the board's own type decides the list: a board is offered only updates of the firmware it runs
                let info = &a["info"];
                let types = self.firmware_types(&a);
                let board_fw = info["fw"].as_str().unwrap_or("");
                let Some(t) = fwtypes::type_for(&types, board_fw) else {
                    return Ok(json!({ "latest": null, "current": info["fw_version"], "image": null, "out_of_date": false, "fw": board_fw, "type_name": null }));
                };
                let m = match fwtypes::manifest_of(t).await {
                    // nothing published yet: nothing to offer, and nothing the person must fix
                    Err(e) if e == fleet::NO_RELEASE => {
                        return Ok(json!({ "latest": null, "current": info["fw_version"], "image": null, "out_of_date": false, "none_yet": true, "fw": board_fw, "type_name": t["name"] }))
                    }
                    r => r?,
                };
                let m = fwtypes::own_manifest(t, &m);
                let latest = m["version"].as_str().unwrap_or("");
                let image = fleet::image_for(&m, info).cloned();
                let current = info["fw_version"].as_str().unwrap_or("");
                // a board without over-the-air updates (no `update` in its info) gets new firmware over USB only:
                // said (`usb_update`), never offered as an update it would refuse
                let newer = image.is_some() && fleet::newer(latest, current);
                let ota = info.get("update").is_some_and(|u| !u.is_null());
                // a board on a board package the new image does not have, whose firmware cannot take one: over USB
                // only, with the reason (`usb_reason`)
                if let Some(why) = boardpkg::ota_blocked(&m, info).filter(|_| fleet::newer(latest, current)) {
                    return Ok(json!({ "latest": latest, "current": current, "image": null, "fw": board_fw, "type_name": t["name"],
                                      "out_of_date": false, "usb_update": true, "usb_reason": why }));
                }
                Ok(json!({ "latest": latest, "current": current, "image": image, "fw": board_fw, "type_name": t["name"],
                           "out_of_date": newer && ota, "usb_update": newer && !ota, "prerelease": m["prerelease"] == true }))
            }
            "update" => {
                let key = arg(&a, "key")?.to_string();
                let address = self.address(&key)?;
                // only from the release list (https or a folder, every image checked against its SHA-256), and
                // never an older or the same version unless asked for (`allow_older`): no silent downgrade.
                // The list is the board's own type's; another type (`fw`) only with `switch_type: true`
                let info = json!({ "result": fleet::board_info(&address).await? });
                let board_fw = info["result"]["fw"].as_str().unwrap_or("").to_string();
                let (target, type_switch) = fwtypes::pick(&board_fw, a["fw"].as_str(), a["switch_type"] == true)?;
                let types = self.firmware_types(&a);
                let t = fwtypes::type_for(&types, &target).ok_or_else(|| format!("Studio has no firmware list for the {target} firmware"))?;
                let source = t["source"].as_str().unwrap_or("").to_string();
                let m = fwtypes::own_manifest(t, &fwtypes::manifest_of(t).await?);
                let mut want = info["result"].clone();
                want["fw"] = json!(target);
                if let Some(why) = boardpkg::ota_blocked(&m, &want) {
                    return Err(why);
                }
                let img = fleet::image_for(&m, &want).ok_or_else(|| format!("the {} release has no image for this board", t["name"].as_str().unwrap_or(&target)))?;
                let switch = img["impl"] != info["result"]["fw_impl"];
                let (latest, current) = (m["version"].as_str().unwrap_or(""), info["result"]["fw_version"].as_str().unwrap_or(""));
                if !switch && !type_switch && a["allow_older"] != true && !fleet::newer(latest, current) {
                    return Err(format!("the board already runs firmware {current}, and the release is {latest}: nothing newer to install"));
                }
                let image = fleet::fetch_image(img["source"].as_str().unwrap_or(&source), img).await?;
                if type_switch {
                    // another firmware keeps its settings its own way: the board's are saved to a file first (when it
                    // can give them) and not put back on the new firmware
                    let saved = match opt_str(&a, "backups") {
                        Some(dir) => fleet::backup(&*self.conn(&key)?, &dir, a["now"].as_str()).await.ok(),
                        None => None,
                    };
                    let mut r = fleet::update(&key, &address, image, opt_str(&a, "pin"), &self.events).await?;
                    r["backup"] = json!(saved);
                    r["fw"] = r["info"]["fw"].clone();
                    return Ok(r);
                }
                if switch {
                    let ws = folder(&a).map_err(|_| "choose your library folder first: the board is backed up there before the switch".to_string())?;
                    return fleet::switch_update(self.conn(&key)?, &key, &address, image, ws, opt_str(&a, "pin"), &self.events).await;
                }
                fleet::update(&key, &address, image, opt_str(&a, "pin"), &self.events).await
            }
            // a new board's first firmware over USB, from a type's release list: `{fw, board, mcu, port | drive,
            // confirm, dry_run, source, plugins, setup?}` (`setup`: board_setup's arguments with a package file,
            // which goes on in the same write as a file system image; `send_after`: requests for after the boot) (`board`: the board package, default "proptroller"; the image
            // checked against its SHA-256 before anything is written)
            "usb_install" => {
                let (fw, mcu) = (arg(&a, "fw")?, arg(&a, "mcu")?);
                let mut a_package: Option<Value> = None;
                let board = fleet::board_of(&a).to_string();
                let types = self.firmware_types(&a);
                let t = fwtypes::type_for(&types, fw).ok_or_else(|| format!("Studio has no firmware list for the {fw} firmware"))?;
                let source = t["source"].as_str().unwrap_or("").to_string();
                let m = fwtypes::own_manifest(t, &fwtypes::manifest_of(t).await?);
                let img = fwtypes::first_flash_for(&m, fw, &board, mcu).ok_or_else(|| format!("the {} release has no USB install for this kind of board", t["name"].as_str().unwrap_or(fw)))?.clone();
                let bytes = fleet::fetch_image(img["source"].as_str().unwrap_or(&source), &img).await?;
                let dir = std::env::temp_dir().join("specter-studio-first-flash");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let name = std::path::Path::new(img["file"].as_str().unwrap_or("image.bin")).file_name().map(|n| n.to_owned()).unwrap_or_default();
                let file = dir.join(name);
                std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
                // a USB session Studio has on that port would keep it busy: it ends before the port is written
                if a["dry_run"] != true && a["confirm"] == true {
                    if let Some(port) = opt_str(&a, "port") {
                        let gone = self.devices.lock().unwrap().remove(&format!("serial:{port}"));
                        if let Some(d) = gone {
                            d.conn.close();
                            drop(d);
                            tokio::time::sleep(Duration::from_millis(800)).await;
                        }
                    }
                }
                let mut plan = flash::release_plan(mcu, &file)?;
                // a board package file goes on in the same write, in the board's file system (boardpkg.rs, fsimage.rs)
                let mut after = json!(null);
                if !a["setup"].is_null() {
                    let (plugins, allowed) = self.allowed_plugins(&a);
                    let s = boardpkg::setup_from(&plugins, &allowed, &a["setup"])?;
                    if fw != fwtypes::GENERIC {
                        return Err(format!("the {} firmware has its board built in: a board package goes on only with the generic firmware", t["name"].as_str().unwrap_or(fw)));
                    }
                    // the Proptroller board (or no stored package): a fresh file system, so the image's built-in board
                    // runs from the first second and no package stored by earlier firmware is left
                    let builtin = matches!(&s.package, boardpkg::PackageChoice::Forget) || matches!(&s.package, boardpkg::PackageChoice::Preset(id) if id == fleet::DEFAULT_BOARD);
                    let pkg = match &s.package {
                        boardpkg::PackageChoice::Package(p) => p.clone(),
                        _ if builtin => json!({ "name": boardpkg::DEFAULT_PRESETS[0].1 }),
                        _ => return Err("a built-in board package goes on with the firmware only as the board gave it: choose it again".into()),
                    };
                    let (fs, inside) = if builtin {
                        (fsimage::build_fs(&fsimage::layout(mcu)?, &[])?, s.profile.is_none() && s.script.is_none())
                    } else {
                        fsimage::install_image(mcu, &pkg, s.profile.as_ref(), s.script.as_deref())?
                    };
                    plan = flash::with_fs_image(plan, mcu, &fs, &dir)?;
                    if !inside {
                        // too big to go in beside the package: sent once the board answers
                        let rest = boardpkg::Setup { package: boardpkg::PackageChoice::Keep, defaults: false, profile: s.profile.clone(), script: s.script.clone() };
                        after = json!(boardpkg::requests(&rest));
                    }
                    a_package = Some(pkg["name"].clone());
                }
                let mut r = flash::run(plan, &a).await?;
                r["board_package"] = json!(a_package);
                r["send_after"] = after;
                r["fw"] = json!(fw);
                r["type_name"] = t["name"].clone();
                r["prerelease"] = json!(m["prerelease"] == true);
                r["version"] = m["version"].clone();
                Ok(r)
            }
            "backup" => Ok(json!(fleet::backup(&*self.conn(arg(&a, "key")?)?, folder(&a)?, a["now"].as_str()).await?)),
            "backups" => Ok(json!(fleet::list_backups(folder(&a)?))),
            // a firmware switch whose restore never finished: offer it at the next start (`folder`: the library);
            // restore it with "restore" {key, path}, then "switch_done" {folder, path}
            "switch_pending" => Ok(json!(fleet::pending(folder(&a)?))),
            "switch_done" => {
                fleet::pending_set(folder(&a)?, arg(&a, "path")?, None);
                Ok(json!(null))
            }
            "restore" => {
                let conn = self.conn(arg(&a, "key")?)?;
                fleet::restore(&conn, arg(&a, "path")?, a["keep_name"] != false, opt_str(&a, "pin")).await
            }
            "default_folder" => {
                let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
                Ok(json!(std::path::Path::new(&home).join("Documents").join("Specter Studio").join("Backups").to_string_lossy()))
            }
            "library_default" => {
                let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
                Ok(json!(std::path::Path::new(&home).join("Documents").join("Specter Studio").join("My Props").to_string_lossy()))
            }
            "workspace_set" => {
                self.remember_workspace(folder(&a)?);
                Ok(json!(null))
            }
            "library_list" => {
                self.remember_workspace(folder(&a)?);
                Ok(json!(library::list(folder(&a)?.as_ref())))
            }
            "library_read" => Ok(json!(library::read(folder(&a)?.as_ref(), arg(&a, "name")?)?)),
            // the hash library_save's base_hash is compared with (the editor takes it of what it opened)
            "library_hash" => Ok(json!(library::hash(arg(&a, "text")?))),
            "library_save" => {
                let now = opt_str(&a, "now").unwrap_or_else(library::now_utc);
                // `base_hash`: the hash of what the editor opened; a file changed outside since is not overwritten
                library::save_checked(folder(&a)?.as_ref(), arg(&a, "name")?, arg(&a, "text")?, &now, a["base_hash"].as_str())
            }
            // hot exit (unsaved.rs): unsaved effect edits and board settings, kept on disk while Studio runs
            // the Dashboard's event log, one file per show night (nightlog.rs)
            "nights_append" => nightlog::append(folder(&a)?.as_ref(), arg(&a, "night")?, a["events"].as_array().map(|v| v.as_slice()).unwrap_or(&[])).map(|_| json!(null)),
            "nights_list" => Ok(nightlog::list(folder(&a)?.as_ref())),
            "nights_read" => nightlog::read(folder(&a)?.as_ref(), arg(&a, "night")?),
            "unsaved_put" => unsaved::put(folder(&a)?.as_ref(), &unsaved::computer_name(), &a["effects"], &a["settings"], &opt_str(&a, "now").unwrap_or_else(library::now_utc)).map(|_| json!(null)),
            "unsaved_get" => Ok(unsaved::get(folder(&a)?.as_ref(), &unsaved::computer_name())),
            "unsaved_clear" => unsaved::clear(folder(&a)?.as_ref(), &unsaved::computer_name()).map(|_| json!(null)),
            "library_projects" => {
                self.remember_workspace(folder(&a)?);
                Ok(json!(projects::projects(folder(&a)?.as_ref())))
            }
            "identify_firmware" => Ok(projects::identify(folder(&a)?.as_ref(), &a["info"])),
            "workspace_init" => {
                let ws = std::path::PathBuf::from(folder(&a)?);
                std::fs::create_dir_all(&ws).map_err(|e| format!("cannot make {}: {e}", ws.display()))?;
                self.remember_workspace(folder(&a)?);
                for d in [library::effects_dir(&ws), patterns::patterns_dir(&ws), projects::firmware_dir(&ws), ws.join(".specter")] {
                    std::fs::create_dir_all(&d).map_err(|e| format!("cannot make {}: {e}", d.display()))?;
                }
                if let Some(ard) = arduino_dir() {
                    projects::write_workspace_ini(&ws, &ard)?;
                }
                Ok(json!(ws.to_string_lossy()))
            }
            "firmware_new" => {
                let ws = std::path::PathBuf::from(folder(&a)?);
                let ard = arduino_dir().ok_or("the firmware library is not installed")?;
                let p = projects::new_project(&ws, arg(&a, "name")?, &ard.join("template"))?;
                projects::write_workspace_ini(&ws, &ard)?;
                Ok(p)
            }
            // page passwords, only when the person ticks "remember": the system keychain, never a file or a log
            "secret_get" => {
                // only page passwords go back to the UI (it sends them with a board's requests); the other secrets
                // (the MQTT upstream and sharing passwords) are used here in the core and never leave it
                let name = arg(&a, "name")?;
                if !name.starts_with("page-password:") {
                    return Err(format!("{name} is kept in the keychain and used by Studio itself"));
                }
                let e = keyring::Entry::new("specter-studio", name).map_err(|e| e.to_string())?;
                Ok(e.get_password().map(|p| json!(p)).unwrap_or(json!(null)))
            }
            "secret_set" => {
                let e = keyring::Entry::new("specter-studio", arg(&a, "name")?).map_err(|e| e.to_string())?;
                e.set_password(arg(&a, "value")?).map(|_| json!(null)).map_err(|e| format!("the keychain refused: {e}"))
            }
            "pio_status" => Ok(json!({ "installed": builder::find_pio().is_some(), "path": builder::find_pio() })),
            "pio_install" => builder::install_pio().await,
            "firmware_upload" => self.upload(&a).await,
            "file_read" => std::fs::read_to_string(inside(&self.file_root(&a)?, arg(&a, "path")?)?).map(|s| json!(s)).map_err(|e| e.to_string()),
            "file_write" => library::write_atomic(&inside(&self.file_root(&a)?, arg(&a, "path")?)?, arg(&a, "text")?.as_bytes()).map(|_| json!(null)),
            "sounds" => Ok(json!(library::sounds(folder(&a)?.as_ref()))),
            "library_rename" => library::rename(folder(&a)?.as_ref(), arg(&a, "from")?, arg(&a, "to")?).map(|_| json!(null)),
            "library_delete" => library::delete(folder(&a)?.as_ref(), arg(&a, "name")?).map(|_| json!(null)),
            "library_identify" => Ok(library::identify(folder(&a)?.as_ref(), arg(&a, "text")?)),
            // LED patterns (patterns.rs): `<library>/patterns/<name>.pattern.js`, `source/name` in a script source
            "pattern_list" => Ok(json!(patterns::list(folder(&a)?.as_ref()))),
            "pattern_read" => patterns::read(folder(&a)?.as_ref(), arg(&a, "name")?).map(|t| json!(t)),
            "pattern_save" => patterns::save(folder(&a)?.as_ref(), arg(&a, "name")?, arg(&a, "text")?, a["new"] == true).map(|_| json!(null)),
            "pattern_rename" => patterns::rename(folder(&a)?.as_ref(), arg(&a, "from")?, arg(&a, "to")?).map(|_| json!(null)),
            "pattern_delete" => patterns::delete(folder(&a)?.as_ref(), arg(&a, "name")?).map(|_| json!(null)),
            "send_script" => {
                // the newest library version, with its header line, to a board (the board checks it); or `text`, a
                // script edited on the board's page and sent to that board only: under `name` it carries a header
                // with the send time (the board's version of that effect, "changed on the board" until it is saved),
                // without a name none ("not in your library")
                let text = match a["text"].as_str() {
                    Some(t) => match opt_str(&a, "name") {
                        Some(n) => library::with_header(&n, &opt_str(&a, "now").unwrap_or_else(library::now_utc), t),
                        None => library::body(t).to_string(),
                    },
                    None => library::for_board(folder(&a)?.as_ref(), arg(&a, "name")?)?,
                };
                // `bytes`: the text's UTF-8 length, so a line that lost bytes on the way (serial) is refused, not stored
                // (firmware before 0.1.0-rc.1 ignores the field)
                let mut req = json!({ "op": "set_script", "text": text, "bytes": text.len() });
                if let Some(p) = opt_str(&a, "pin") {
                    req["pin"] = json!(p);
                }
                self.conn(arg(&a, "key")?)?.rpc(req).await
            }
            "guides" => {
                let pages: Vec<String> = plugins::guides_dir()
                    .and_then(|d| std::fs::read_dir(d).ok())
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.ends_with(".html"))
                    .collect();
                Ok(json!({ "available": !pages.is_empty(), "pages": pages }))
            }
            "examples" => {
                // the firmware's example effect scripts: [{name, title, text}]
                let dir = arduino_dir().map(|d| d.join("../show-script-examples")).filter(|d| d.is_dir());
                let mut out: Vec<Value> = dir
                    .and_then(|d| std::fs::read_dir(d).ok())
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().ends_with(".txt"))
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        // "06_12v_animatronic.txt" -> "12v animatronic": only the leading number and its "_" go
                        let stem = name.trim_end_matches(".txt");
                        let stem = match stem.split_once('_') { Some((n, rest)) if n.chars().all(|c| c.is_ascii_digit()) => rest, _ => stem };
                        let title = stem.replace('_', " ");
                        Some(json!({ "name": name, "title": title, "text": std::fs::read_to_string(e.path()).ok()? }))
                    })
                    .collect();
                out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                Ok(json!(out))
            }
            "plugins" => Ok(json!(plugins::list(&self.plugin_dirs.lock().unwrap()))),
            // every extension's own icon and the effect icons it adds, as SVG text (src/props/icons.tsx)
            "plugin_icons" => Ok(json!(plugins::icons(&self.plugin_dirs.lock().unwrap()))),
            c if c.starts_with("automation_") => self.automation.dispatch(c, &a).await,
            "startup" => Ok(json!({ "open_plugin": std::env::var("SPECTER_OPEN_PLUGIN").ok() })),
            _ => Err(format!("unknown command {cmd}")),
        }
    }
}

/// The commands that change files in the library (auto save follows them).
fn gitsync_saves(cmd: &str) -> bool {
    matches!(cmd, "library_save" | "library_rename" | "library_delete" | "file_write" | "firmware_new" | "pattern_save" | "pattern_rename" | "pattern_delete")
}

impl Studio {
    /// Where extensions added from git are kept; the ones already there are loaded.
    pub fn set_extensions_dir(&self, dir: std::path::PathBuf) {
        let mut dirs = self.plugin_dirs.lock().unwrap();
        for (_, d) in extensions::registered(&dir) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
        *self.extensions_dir.lock().unwrap() = Some(dir);
    }

    fn extensions_root(&self) -> Result<std::path::PathBuf, String> {
        self.extensions_dir.lock().unwrap().clone().ok_or_else(|| "Extensions from git need the desktop app.".to_string())
    }

    /// Script sources (sources.rs), extensions from git (extensions.rs) and "Open folder". Git runs only in the
    /// remembered library folder's sources or in Studio's extensions folder.
    async fn git_sources(&self, cmd: &str, a: &Value) -> Result<Value, String> {
        let msg = |p: gitsync::Problem, d: &std::path::Path| p.message(d);
        if cmd == "open_folder" {
            let asked = dunce::canonicalize(folder(a)?).map_err(|_| "that folder is not there".to_string())?;
            let ws = self.workspace.lock().unwrap().clone();
            let ext = self.extensions_dir.lock().unwrap().clone().and_then(|d| dunce::canonicalize(d).ok());
            let ok = ws.as_ref().is_some_and(|w| asked.starts_with(w)) || ext.as_ref().is_some_and(|e| asked.starts_with(e));
            if !ok || !asked.is_dir() {
                return Err("Studio opens only folders in your library or its extensions folder".into());
            }
            return open_in_file_manager(&asked).map(|_| json!({ "opened": asked.to_string_lossy() }));
        }
        if let Some(op) = cmd.strip_prefix("extension") {
            let root = self.extensions_root()?;
            let text = a["source"].as_str().unwrap_or("").to_string();
            return match op {
                "s" => { let r = root.clone(); self.scripts.with(move |g| json!(extensions::list(g, &r))).await }
                "_preview" => { let r = root.clone(); self.scripts.with(move |g| extensions::preview(g, &r, &text).map_err(|p| msg(p, &r))).await? }
                "_add" => {
                    let sub = a["sub"].as_str().map(String::from);
                    let ids: Vec<String> = plugins::list(&self.plugin_dirs.lock().unwrap()).iter().filter_map(|p| p["id"].as_str().map(String::from)).collect();
                    let r = root.clone();
                    let v = self.scripts.with(move |g| extensions::add(g, &r, &text, sub.as_deref(), &ids).map_err(|p| msg(p, &r.join("…")))).await??;
                    if let Some(d) = v["added"]["dir"].as_str() {
                        self.plugin_dirs.lock().unwrap().push(d.into());
                    }
                    Ok(v)
                }
                "_get_latest" | "_check" => {
                    let c = extensions::clone_dir(&root, arg(a, "folder")?)?;
                    if op == "_check" {
                        // checking runs by itself over every extension: no sign-in windows
                        return self.scripts.with(move |g| match gitsync::behind(&g.non_interactive(), &c) { Ok(n) => json!({ "ok": true, "behind": n }), Err(p) => json!({ "ok": false, "message": p.message(&c), "problem": p }) }).await;
                    }
                    // fast-forward only: an extension folder is never committed to or pushed from
                    Ok(self.scripts.run(c, false, &self.events, |g, d| gitsync::get_latest(g, d, false)).await)
                }
                "_remove" => {
                    let gone = extensions::remove(&root, arg(a, "folder")?)?;
                    self.plugin_dirs.lock().unwrap().retain(|d| *d != gone);
                    Ok(json!(null))
                }
                _ => Err(format!("unknown command {cmd}")),
            };
        }
        let lib = std::path::PathBuf::from(self.file_root(a)?);
        let text = a["source"].as_str().unwrap_or("").to_string();
        // the sources an operation is for: one (`id`) or all
        let targets = |write: bool| -> Result<Vec<std::path::PathBuf>, String> {
            match a["id"].as_str() {
                Some(id) => Ok(vec![sources::dir(&lib, id)?]),
                None => Ok(library::source_names(&lib).into_iter().map(|n| library::sources_dir(&lib).join(n)).filter(|d| !write || !gitsync::is_read_only(d)).collect()),
            }
        };
        match cmd {
            "sources_list" => { let l = lib.clone(); self.scripts.with(move |g| json!(sources::list(g, &l))).await }
            "sources_preview" => { let l = lib.clone(); self.scripts.with(move |g| sources::preview(g, &l, &text).map_err(|p| msg(p, &l))).await? }
            "sources_add" => {
                let l = lib.clone();
                let r = self.scripts.with(move |g| sources::add(g, &l, &text)).await?;
                let folder = library::sources_dir(&lib);
                let status = { let l = lib.clone(); self.scripts.with(move |g| json!(sources::list(g, &l))).await? };
                Ok(match r {
                    Ok((id, d)) => json!({ "ok": true, "id": id, "message": d.message, "sources": status }),
                    Err(p) => json!({ "ok": false, "message": p.message(&folder), "problem": p, "sources": status }),
                })
            }
            "sources_get_latest" | "sources_backup" => {
                let back = cmd == "sources_backup";
                let mut results = vec![];
                for d in targets(back)? {
                    // a read-only source is pull only (never "back up first")
                    let ro = gitsync::is_read_only(&d);
                    let v = self.scripts.run(d.clone(), false, &self.events, move |g, dd| if back { gitsync::backup(g, dd) } else { gitsync::get_latest(g, dd, !ro) }).await;
                    results.push(json!({ "id": d.file_name().map(|n| n.to_string_lossy().into_owned()), "answer": v }));
                }
                Ok(combine(results, back))
            }
            "sources_remove" => {
                let (l, id, anyway) = (lib.clone(), arg(a, "id")?.to_string(), a["anyway"] == true);
                self.scripts.forget(&sources::dir(&lib, &id)?);
                self.scripts.with(move |g| sources::remove(g, &l, &id, anyway)).await?
            }
            "sources_check_write" => {
                let d = targets(false)?.into_iter().next().ok_or("choose a source")?;
                self.scripts.with(move |g| match gitsync::check_write(g, &d) { Ok(w) => json!({ "ok": true, "writable": w }), Err(p) => json!({ "ok": false, "message": p.message(&d), "problem": p }) }).await
            }
            "sources_auto" => {
                let ids: Vec<String> = a["ids"].as_array().map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                self.scripts.set_auto(ids.iter().filter_map(|id| sources::dir(&lib, id).ok()).collect());
                Ok(json!(null))
            }
            _ => Err(format!("unknown command {cmd}")),
        }
    }
}

/// One answer for an operation over several sources: ok when every one was; the messages in order; the first
/// problem (its message names that source's folder).
fn combine(results: Vec<Value>, backup: bool) -> Value {
    let ok = results.iter().all(|r| r["answer"]["ok"] == true);
    let problem = results.iter().find(|r| r["answer"]["ok"] != true).map(|r| r["answer"].clone());
    let changed = results.iter().any(|r| r["answer"]["changed"] == true);
    let message = match (&problem, results.len()) {
        (Some(p), _) => p["message"].as_str().unwrap_or("").to_string(),
        (None, 0) => if backup { "There is no source to back up to yet.".into() } else { "There is no script source yet.".into() },
        (None, 1) => results[0]["answer"]["message"].as_str().unwrap_or("").to_string(),
        (None, n) => format!("{} {n} sources: done.", if backup { "Backed up" } else { "Got the latest for" }),
    };
    json!({ "ok": ok, "message": message, "changed": changed, "problem": problem.map(|p| p["problem"].clone()), "results": results })
}

/// Opens a folder in the computer's file manager (Explorer, Finder, the Linux desktop's). `SPECTER_NO_OPEN`
/// (tests): nothing is opened.
fn open_in_file_manager(dir: &std::path::Path) -> Result<(), String> {
    if std::env::var_os("SPECTER_NO_OPEN").is_some() {
        return Ok(());
    }
    let prog = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(prog).arg(dir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map(|_| ()).map_err(|e| format!("could not open the folder ({e}): it is {}", dir.display()))
}

/// How long "Plugged in with USB" waits for a board's first answer.
pub const SERIAL_CONNECT_WAIT: Duration = Duration::from_secs(8);

/// Why a USB board did not connect, in plain words. `heard`: the port printed text, but never a Proptroller answer.
pub fn serial_silence(path: &str, heard: bool) -> String {
    let secs = SERIAL_CONNECT_WAIT.as_secs();
    if heard {
        format!("Something on {path} is talking, but it did not answer as a Proptroller board within {secs} seconds. It may run other firmware: put Proptroller firmware on it (Upload), then try again.")
    } else {
        format!("No board answered on {path} within {secs} seconds. Check that the board has power, that the USB cable carries data (some cables only charge), and that no other program (a serial monitor, the Arduino IDE) has the port open. Then try again.")
    }
}
