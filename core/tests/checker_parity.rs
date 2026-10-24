//! SS-C5: Studio's script checker must give the board's answer. Every case of the firmware's show-script
//! golden set (`firmware/firmware/show-script-golden/`, the submodule) goes through Studio's own
//! `check_script` path, as the effect editor calls it: the hidden checker board when the case has no
//! settings, else a practice board with the case's settings (the "Check with the settings of" choice). The
//! answer must match the case's `ok`, `errors` and `warnings` byte for byte (and its `table` when the reply
//! has one; the reply carries only the number of effects, which is compared instead). A trace-only case (no
//! `check`) must check with no errors, since the board saves its script. Needs the simulator
//! (scripts/build-sim.sh).
//!
//! The setting `buttons` (USER1-3 as triggers or as learn-mode record buttons) exists only on firmware before
//! 0.1.0-rc.1, where USER1-3 always trigger: on a board without it `buttons = triggers` is left out (it is what
//! the board does anyway) and a `buttons = learn` case is skipped (no such board to ask).
//!
//! `SHOW_SCRIPT_GOLDEN=<dir with cases/>` runs another golden set instead (scripts/checker-parity.sh uses it
//! to see what changes when the submodule pin moves to a newer firmware).

use serde_json::{json, Value};
use std::path::PathBuf;
use studio_core::Studio;


/// Windows has no practice-board simulator yet (the firmware's sim builds on Linux and macOS): a test that needs
/// it is skipped there while none is found, and runs as soon as one is (PROPTROLLER_SIM or a built `sim`).
fn no_simulator_here() -> bool {
    let skip = cfg!(windows) && studio_core::sim::find_program().is_none();
    if skip {
        eprintln!("no simulator on this Windows computer: skipped");
    }
    skip
}

fn golden_dir() -> PathBuf {
    match std::env::var("SHOW_SCRIPT_GOLDEN") {
        Ok(d) => PathBuf::from(d),
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../firmware/firmware/show-script-golden"),
    }
}

fn cases() -> Vec<(String, PathBuf)> {
    let dir = golden_dir().join("cases");
    let mut v: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e} (run git submodule update --init)", dir.display()))
        .map(|d| d.unwrap().path())
        .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), p))
        .collect();
    v.sort();
    v
}

/// The board's answer, or `None` for a case this board cannot be asked (`buttons = learn` without learn mode).
async fn check(s: &Studio, c: &Value, text: &str) -> Option<Value> {
    let sounds = if c["sounds"].is_object() { c["sounds"].clone() } else { json!({}) };
    let mut settings = c["settings"].as_object().cloned().unwrap_or_default();
    if settings.is_empty() {
        return Some(s.dispatch("check_script", json!({ "text": text, "sounds": sounds })).await.expect("check_script"));
    }
    let key = s.dispatch("sim_start", json!({ "name": "Parity" })).await.expect("simulator starts")["key"].as_str().unwrap().to_string();
    if let Some(b) = settings.get("buttons").cloned() {
        let params = s.dispatch("rpc", json!({ "key": key, "req": { "op": "get_params" } })).await.unwrap();
        let has = params["result"]["values"].as_array().into_iter().flatten().any(|v| v["key"] == "buttons");
        if !has {
            if b != "triggers" {
                let _ = s.dispatch("disconnect", json!({ "key": key })).await;
                return None;
            }
            settings.remove("buttons");
        }
    }
    let values: Vec<Value> = settings.iter().map(|(k, v)| json!({ "key": k, "value": v })).collect();
    if !values.is_empty() {
        let r = s.dispatch("rpc", json!({ "key": key, "req": { "op": "set_params", "values": values } })).await.unwrap();
        assert_eq!(r["ok"], true, "settings {settings:?}: {r}");
    }
    let got = s.dispatch("check_script", json!({ "text": text, "sounds": sounds, "key": key })).await.expect("check_script");
    let _ = s.dispatch("disconnect", json!({ "key": key })).await;
    Some(got)
}

#[tokio::test(flavor = "multi_thread")]
async fn every_golden_case_gets_the_board_answer() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let mut failed = Vec::new();
    let mut n = 0;
    let mut traces = 0;
    let mut skipped = Vec::new();
    for (name, p) in cases() {
        let c: Value = serde_json::from_str(&std::fs::read_to_string(p.join("case.json")).unwrap()).unwrap();
        let text = String::from_utf8(std::fs::read(p.join("script.txt")).unwrap()).unwrap();
        let Some(want) = c.get("check") else {
            // a trace-only case: the board saves its script, so the check has no errors
            traces += 1;
            let Some(got) = check(&s, &c, &text).await else { skipped.push(name); continue };
            if got["ok"] != true || got["errors"] != json!([]) {
                failed.push(format!("{name} (trace case, must save):\n  got {got}"));
            }
            continue;
        };
        let Some(got) = check(&s, &c, &text).await else { skipped.push(name); continue };
        n += 1;
        let mut diffs = Vec::new();
        for k in ["ok", "errors", "warnings"] {
            if got[k] != want[k] {
                diffs.push(format!("  {k}: want {}\n  {k}: got  {}", want[k], got[k]));
            }
        }
        if want.get("table").is_some() && got.get("table").is_some() && got["table"] != want["table"] {
            diffs.push(format!("  table: want {}\n  table: got  {}", want["table"], got["table"]));
        }
        if want["ok"] == true && got.get("table").is_none() {
            if let Some(effects) = want["table"]["effects"].as_array() {
                if got["effects"] != json!(effects.len()) {
                    diffs.push(format!("  effects: want {}, got {}", effects.len(), got["effects"]));
                }
            }
        }
        if !diffs.is_empty() {
            failed.push(format!("{name}:\n{}", diffs.join("\n")));
        }
    }
    assert!(n > 0, "no check cases in {}", golden_dir().display());
    eprintln!("checker parity: {n} check cases and {traces} trace cases from {}, {} differ; skipped (learn mode, not on this firmware): {skipped:?}", golden_dir().display(), failed.len());
    assert!(failed.is_empty(), "{} of {} cases differ from the board's answer:\n{}", failed.len(), n + traces, failed.join("\n"));
}

/// What Studio's new-effect dialog relies on (src/components/NewEffect.tsx): a `#` in an effect name starts a
/// comment, so the name loses its colon; the dialog leaves `#` out.
#[tokio::test(flavor = "multi_thread")]
async fn a_hash_in_an_effect_name_is_a_comment() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let body = "  wait for trig2\n  rly1 = on\n  sleep 5\n  rly1 = off\n";
    let bad = s.dispatch("check_script", json!({ "text": format!("effect Fog #2:\n{body}"), "sounds": {} })).await.unwrap();
    assert_eq!(bad["errors"][0]["message"], "line 1: put a colon after the effect name: \"effect fog:\".", "{bad}");
    let good = s.dispatch("check_script", json!({ "text": format!("effect Fog 2:\n{body}"), "sounds": {} })).await.unwrap();
    assert_eq!(good["ok"], true, "{good}");
}
