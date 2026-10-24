//! The Dashboard's event log on disk, one file per show night: `<workspace>/.specter/nights/<YYYY-MM-DD>.jsonl`,
//! one JSON object per line (a run, a status change, online / offline, an error ...), appended as they happen.
//! Which night an event belongs to is the UI's decision (src/dashboard/nights.ts: a night starts at the first run
//! after a gap of 4 hours or more and is named after the evening's date, so a show from 7 pm to 2 am is one
//! night); this module only keeps the files: append, list and read, inside the library folder.

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One writer at a time.
static LOCK: Mutex<()> = Mutex::new(());

/// A night file holds at most this much (a night's runs and events are a few hundred KB at most); lines past it
/// are not written, and that is said once in the file.
pub const NIGHT_MAX_BYTES: u64 = 8 * 1024 * 1024;

pub fn dir(ws: &Path) -> PathBuf {
    crate::library::index_dir(ws).join("nights")
}

/// A night's name: its evening's date, `YYYY-MM-DD`.
pub fn valid_night(n: &str) -> bool {
    let b = n.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Appends `events` (JSON objects) to the night's file.
pub fn append(ws: &Path, night: &str, events: &[Value]) -> Result<(), String> {
    if !valid_night(night) {
        return Err(format!("{night} is not a night (YYYY-MM-DD)"));
    }
    if !ws.is_dir() {
        return Err(format!("{} does not exist", ws.display()));
    }
    let _g = LOCK.lock().unwrap();
    let d = dir(ws);
    std::fs::create_dir_all(&d).map_err(|e| format!("cannot make {}: {e}", d.display()))?;
    let path = d.join(format!("{night}.jsonl"));
    let mut size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size >= NIGHT_MAX_BYTES {
        return Ok(());
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let mut out = String::new();
    for e in events.iter().filter(|e| e.is_object()) {
        let line = e.to_string();
        size += line.len() as u64 + 1;
        if size >= NIGHT_MAX_BYTES {
            out.push_str(&json!({ "type": "error", "text": "this night's log is full: later events are not kept" }).to_string());
            out.push('\n');
            break;
        }
        out.push_str(&line);
        out.push('\n');
    }
    f.write_all(out.as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Every night kept, newest first: `[{"night": "2026-10-23", "bytes": 1234}]`.
pub fn list(ws: &Path) -> Value {
    let mut v: Vec<(String, u64)> = std::fs::read_dir(dir(ws))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let night = name.strip_suffix(".jsonl")?.to_string();
                    valid_night(&night).then(|| (night, e.metadata().map(|m| m.len()).unwrap_or(0)))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    json!(v.into_iter().map(|(night, bytes)| json!({ "night": night, "bytes": bytes })).collect::<Vec<_>>())
}

/// A night's events, oldest first (a line that cannot be read, say cut short by a power cut, is left out).
pub fn read(ws: &Path, night: &str) -> Result<Value, String> {
    if !valid_night(night) {
        return Err(format!("{night} is not a night (YYYY-MM-DD)"));
    }
    let path = dir(ws).join(format!("{night}.jsonl"));
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!([])),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    Ok(json!(text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect::<Vec<_>>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nights_are_appended_listed_and_read() {
        let ws = std::env::temp_dir().join(format!("specter-nightlog-{}", std::process::id()));
        std::fs::create_dir_all(&ws).unwrap();
        append(&ws, "2026-10-23", &[json!({ "t": 1, "type": "run", "board": "Front Door" }), json!("not an object")]).unwrap();
        append(&ws, "2026-10-23", &[json!({ "t": 2, "type": "online", "board": "Front Door" })]).unwrap();
        append(&ws, "2026-10-24", &[json!({ "t": 3, "type": "run", "board": "Crypt" })]).unwrap();
        // a line cut short by a power cut is skipped
        std::fs::OpenOptions::new().append(true).open(dir(&ws).join("2026-10-24.jsonl")).unwrap().write_all(b"{\"t\":4,\"ty").unwrap();
        let l = list(&ws);
        assert_eq!(l[0]["night"], "2026-10-24");
        assert_eq!(l[1]["night"], "2026-10-23");
        let r = read(&ws, "2026-10-23").unwrap();
        assert_eq!(r.as_array().unwrap().len(), 2);
        assert_eq!(r[1]["type"], "online");
        assert_eq!(read(&ws, "2026-10-24").unwrap().as_array().unwrap().len(), 1);
        assert_eq!(read(&ws, "2026-01-01").unwrap(), json!([]));
        assert!(append(&ws, "../../etc", &[json!({})]).is_err());
        assert!(read(&ws, "2026-10-2x").is_err());
        let _ = std::fs::remove_dir_all(&ws);
    }
}
