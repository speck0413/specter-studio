//! Hot exit: unsaved effect edits and board settings kept in `.specter/unsaved.json`, read back after a crash,
//! compared with the library, one entry per computer, secrets never written.

use serde_json::{json, Value};
use studio_core::{library, unsaved, Studio};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("studio-unsaved-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

const V1: &str = "effect fog:\n  wait for trig2\n  rly1 = on\n  sleep 3\n  rly1 = off\n";
const EDIT: &str = "effect fog:\n  wait for trig2\n  rly1 = on\n  sleep 8\n  rly1 = off\n";
const ELSEWHERE: &str = "effect fog:\n  wait for trig1\n  rly1 = on\n  sleep 3\n  rly1 = off\n";

#[test]
fn write_restore_and_clear() {
    let d = tmp("restore");
    library::save(&d, "porch fog", V1, "2026-10-22 06:00").unwrap();
    library::save(&d, "lamp", "effect l:\n  wait for trig1\n", "2026-10-22 06:00").unwrap();
    let effects = json!({ "porch fog": { "text": EDIT, "base": V1 }, "lamp": { "text": "effect l:\n  wait for trig1\n", "base": "x" } });
    let settings = json!({ "a0b1c2d3e4f5": { "name": "Front door", "key": "http://10.0.0.5", "edits": { "debounce_ms": 120, "wifi_pass": "hunter22", "pin": "4321" }, "base": { "debounce_ms": 100 } } });
    unsaved::put(&d, "pc1", &effects, &settings, "2026-10-22 06:10").unwrap();

    let raw = std::fs::read_to_string(unsaved::file(&d)).unwrap();
    assert!(raw.contains("specter-unsaved"));
    assert!(!raw.contains("hunter22") && !raw.contains("4321"), "secrets are never written: {raw}");
    assert!(!d.join(".specter").read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "no temporary file left");

    // the next start (after a crash): the edit comes back, unchanged in the library = no conflict;
    // an "edit" the library already has word for word is left out
    let r = unsaved::get(&d, "pc1");
    assert_eq!(r["saved"], "2026-10-22 06:10");
    let e = r["effects"].as_array().unwrap();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["name"], "porch fog");
    assert_eq!(e[0]["text"], EDIT);
    assert_eq!(e[0]["conflict"], false);
    assert_eq!(e[0]["missing"], false);
    assert_eq!(e[0]["library"], V1);
    assert_eq!(r["settings"]["a0b1c2d3e4f5"]["edits"], json!({ "debounce_ms": 120 }));
    assert_eq!(r["settings"]["a0b1c2d3e4f5"]["name"], "Front door");

    // nothing unsaved any more (saved, discarded): the file goes
    unsaved::put(&d, "pc1", &json!({}), &json!({}), "2026-10-22 06:11").unwrap();
    assert!(!unsaved::file(&d).exists());
    assert_eq!(unsaved::get(&d, "pc1")["effects"], json!([]));

    // "Close without saving" clears it
    unsaved::put(&d, "pc1", &effects, &json!({}), "2026-10-22 06:12").unwrap();
    unsaved::clear(&d, "pc1").unwrap();
    assert!(!unsaved::file(&d).exists());
    unsaved::clear(&d, "pc1").unwrap(); // twice is fine
}

#[test]
fn conflict_when_the_library_changed_since() {
    let d = tmp("conflict");
    library::save(&d, "porch fog", V1, "2026-10-22 06:00").unwrap();
    unsaved::put(&d, "pc1", &json!({ "porch fog": { "text": EDIT, "base": V1 }, "gone": { "text": "effect g:\n", "base": "" } }), &json!({}), "2026-10-22 06:10").unwrap();
    // saved from another computer (a sync folder) while this one had unsaved edits
    library::save(&d, "porch fog", ELSEWHERE, "2026-10-22 06:20").unwrap();
    let r = unsaved::get(&d, "pc1");
    let e = r["effects"].as_array().unwrap();
    let fog = e.iter().find(|x| x["name"] == "porch fog").unwrap();
    assert_eq!(fog["conflict"], true);
    assert_eq!(fog["text"], EDIT, "mine");
    assert_eq!(fog["library"], ELSEWHERE, "and the library's, to pick from");
    let gone = e.iter().find(|x| x["name"] == "gone").unwrap();
    assert_eq!(gone["missing"], true);
    assert_eq!(gone["library"], Value::Null);
    // line endings alone are not a conflict
    library::save(&d, "porch fog", &V1.replace('\n', "\r\n"), "2026-10-22 06:30").unwrap();
    let r = unsaved::get(&d, "pc1");
    assert_eq!(r["effects"].as_array().unwrap().iter().find(|x| x["name"] == "porch fog").unwrap()["conflict"], false);
}

#[test]
fn one_entry_per_computer() {
    let d = tmp("computers");
    library::save(&d, "porch fog", V1, "2026-10-22 06:00").unwrap();
    let mine = json!({ "porch fog": { "text": EDIT, "base": V1 } });
    let theirs = json!({ "porch fog": { "text": ELSEWHERE, "base": V1 } });
    unsaved::put(&d, "pc1", &mine, &json!({}), "2026-10-22 06:10").unwrap();
    unsaved::put(&d, "laptop", &theirs, &json!({}), "2026-10-22 06:11").unwrap();
    assert_eq!(unsaved::get(&d, "pc1")["effects"][0]["text"], EDIT);
    assert_eq!(unsaved::get(&d, "laptop")["effects"][0]["text"], ELSEWHERE);
    assert_eq!(unsaved::get(&d, "desktop")["effects"], json!([]));
    // clearing or emptying one computer's entry keeps the other's
    unsaved::clear(&d, "pc1").unwrap();
    unsaved::put(&d, "pc1", &json!({}), &json!({}), "2026-10-22 06:12").unwrap();
    assert_eq!(unsaved::get(&d, "laptop")["effects"][0]["text"], ELSEWHERE);
    // a damaged file is ignored, not fatal, and the next write replaces it
    std::fs::write(unsaved::file(&d), "{ half a fi").unwrap();
    assert_eq!(unsaved::get(&d, "pc1")["effects"], json!([]));
    unsaved::put(&d, "pc1", &mine, &json!({}), "2026-10-22 06:13").unwrap();
    assert_eq!(unsaved::get(&d, "pc1")["effects"][0]["text"], EDIT);
}

#[test]
fn secret_keys() {
    for k in ["wifi_pass", "pin", "ap_pass", "page_pin", "mqtt_password", "api_key", "token"] {
        assert!(unsaved::is_secret_key(k), "{k}");
    }
    for k in ["debounce_ms", "name", "page_lock", "volume", "wifi_ssid"] {
        assert!(!unsaved::is_secret_key(k), "{k}");
    }
}

#[tokio::test]
async fn through_dispatch() {
    let d = tmp("dispatch");
    let ws = d.to_string_lossy().to_string();
    let s = Studio::new();
    library::save(&d, "porch fog", V1, "2026-10-22 06:00").unwrap();
    s.dispatch("unsaved_put", json!({ "folder": ws, "effects": { "porch fog": { "text": EDIT, "base": V1 } }, "settings": {}, "now": "2026-10-22 06:10" })).await.unwrap();
    let r = s.dispatch("unsaved_get", json!({ "folder": ws })).await.unwrap();
    assert_eq!(r["effects"][0]["text"], EDIT);
    assert!(std::fs::read_to_string(unsaved::file(&d)).unwrap().contains(&unsaved::computer_name()));
    s.dispatch("unsaved_clear", json!({ "folder": ws })).await.unwrap();
    assert_eq!(s.dispatch("unsaved_get", json!({ "folder": ws })).await.unwrap()["effects"], json!([]));
    assert!(s.dispatch("unsaved_get", json!({ "folder": "" })).await.is_err(), "never without a library folder");
}
