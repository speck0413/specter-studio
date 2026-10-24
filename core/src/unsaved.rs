//! Hot exit: unsaved work kept on disk while Studio runs, so a crash, a kill or the computer shutting down never
//! loses it. The UI sends the whole set of unsaved effect edits and typed-but-unsaved board settings a moment
//! after each change; the next start reads it back and offers each item again (Keep / Discard). Closing on
//! purpose with "Close without saving" clears it.
//!
//! One file in the library's hidden folder, `<workspace>/.specter/unsaved.json`, with one entry per computer
//! (the library may sit in a sync folder or on a USB stick: each computer restores only its own entry and never
//! touches another's):
//!
//! ```json
//! {"format": "specter-unsaved", "version": 1,
//!  "computers": {"studio-pc": {"saved": "2026-10-22 06:10",
//!    "effects": {"porch fog": {"text": "...", "base_hash": "<library::hash of the text it was based on>"}},
//!    "settings": {"a0b1c2d3e4f5": {"name": "Front door", "key": "http://10.0.0.5", "edits": {"debounce_ms": 120},
//!                                  "base": {"debounce_ms": 100}}}}}}
//! ```
//!
//! Secrets typed into board settings (Wi-Fi password, page password) are never written.

use crate::library;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FORMAT: &str = "specter-unsaved";

/// One writer at a time (the file holds every computer's entry).
static LOCK: Mutex<()> = Mutex::new(());

pub fn file(ws: &Path) -> PathBuf {
    library::index_dir(ws).join("unsaved.json")
}

/// This computer's name (its entry in the file): stable across networks, unlike its address.
pub fn computer_name() -> String {
    let from_env = std::env::var("COMPUTERNAME").ok();
    let from_file = || std::fs::read_to_string("/etc/hostname").ok();
    let from_cmd = || std::process::Command::new("hostname").output().ok().and_then(|o| String::from_utf8(o.stdout).ok());
    from_env.or_else(from_file).or_else(from_cmd).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "this computer".into())
}

/// A setting that must never be written to disk: a password, the page password, a token.
pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k == "pin" || k.contains("pass") || k.contains("secret") || k.contains("token") || k.ends_with("_key") || k.ends_with("_pin")
}

fn read_all(ws: &Path) -> Map<String, Value> {
    std::fs::read_to_string(file(ws))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v["format"] == FORMAT)
        .and_then(|v| v["computers"].as_object().cloned())
        .unwrap_or_default()
}

/// Writes the file whole (a temporary file renamed over it, so a kill mid-write never leaves half a file), or
/// removes it when no computer has anything unsaved.
fn write_all(ws: &Path, computers: &Map<String, Value>) -> Result<(), String> {
    let f = file(ws);
    if computers.is_empty() {
        return match std::fs::remove_file(&f) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(library::index_dir(ws)).map_err(|e| format!("cannot keep unsaved changes in {}: {e}", ws.display()))?;
    let tmp = f.with_extension(format!("json.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(&json!({ "format": FORMAT, "version": 1, "computers": computers })).unwrap();
    std::fs::write(&tmp, text).map_err(|e| format!("cannot keep unsaved changes: {e}"))?;
    std::fs::rename(&tmp, &f).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot keep unsaved changes: {e}")
    })
}

/// Keeps `computer`'s unsaved work: `effects` `{name: {text, base}}` (`base` is the saved text the edit started
/// from) and `settings` `{board id: {name, key, edits, base}}`. Nothing unsaved removes the entry. `now` is
/// "YYYY-MM-DD HH:MM".
pub fn put(ws: &Path, computer: &str, effects: &Value, settings: &Value, now: &str) -> Result<(), String> {
    let mut eff = Map::new();
    for (name, d) in effects.as_object().into_iter().flatten() {
        let Some(text) = d["text"].as_str() else { continue };
        let base_hash = match d["base_hash"].as_str() {
            Some(h) => h.to_string(),
            None => library::hash(d["base"].as_str().unwrap_or("")),
        };
        eff.insert(name.clone(), json!({ "text": text, "base_hash": base_hash }));
    }
    let mut set = Map::new();
    for (id, d) in settings.as_object().into_iter().flatten() {
        let keep = |v: &Value| -> Map<String, Value> { v.as_object().into_iter().flatten().filter(|(k, _)| !is_secret_key(k)).map(|(k, v)| (k.clone(), v.clone())).collect() };
        let edits = keep(&d["edits"]);
        if edits.is_empty() {
            continue;
        }
        set.insert(id.clone(), json!({ "name": d["name"], "key": d["key"], "edits": edits, "base": keep(&d["base"]) }));
    }
    let _g = LOCK.lock().unwrap();
    let mut all = read_all(ws);
    if eff.is_empty() && set.is_empty() {
        if all.remove(computer).is_none() && !file(ws).exists() {
            return Ok(());
        }
    } else {
        all.insert(computer.to_string(), json!({ "saved": now, "effects": eff, "settings": set }));
    }
    write_all(ws, &all)
}

/// `computer`'s unsaved work from last time, compared with the library now:
/// `{saved, effects: [{name, text, base_hash, library, conflict, missing}], settings: {...}}`. `conflict`: the effect was
/// saved (here or on another computer) since the edit started, `library` is its text now; `missing`: it is no
/// longer in the library. An edit the library already has word for word is left out.
pub fn get(ws: &Path, computer: &str) -> Value {
    let all = {
        let _g = LOCK.lock().unwrap();
        read_all(ws)
    };
    let Some(mine) = all.get(computer) else { return json!({ "saved": null, "effects": [], "settings": {} }) };
    let mut effects: Vec<Value> = vec![];
    for (name, d) in mine["effects"].as_object().into_iter().flatten() {
        let text = d["text"].as_str().unwrap_or("");
        match library::read(ws, name) {
            Ok(disk) => {
                if library::hash(&disk) == library::hash(text) {
                    continue; // already saved
                }
                let conflict = d["base_hash"].as_str() != Some(library::hash(&disk).as_str());
                effects.push(json!({ "name": name, "text": text, "base_hash": d["base_hash"], "library": disk, "conflict": conflict, "missing": false }));
            }
            Err(_) => effects.push(json!({ "name": name, "text": text, "base_hash": d["base_hash"], "library": null, "conflict": false, "missing": true })),
        }
    }
    effects.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    json!({ "saved": mine["saved"], "effects": effects, "settings": mine["settings"].as_object().cloned().unwrap_or_default() })
}

/// Forgets `computer`'s unsaved work ("Close without saving").
pub fn clear(ws: &Path, computer: &str) -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    let mut all = read_all(ws);
    if all.remove(computer).is_none() {
        return Ok(());
    }
    write_all(ws, &all)
}
