//! The user's own firmware, the Arduino way: `<workspace>/firmware/<name-with-dashes>/<name-with-dashes>.ino`
//! (plus any .cpp / .h beside it) and `sketch.yaml` (arduino-cli's profile file: `default_profile` and one
//! profile per board with its `fqbn`). Studio builds with PlatformIO behind the scenes (`builder.rs`).
//!
//! The version is a number Studio raises on every build (`.specter/firmware.json`), built into the
//! board-visible id `<name> v<N>` (`PROPTROLLER_FW_BUILD`, reported as `fw_build`), so a board running a
//! project is recognised from its `info` alone.

use crate::library::file_stem;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn firmware_dir(ws: &Path) -> PathBuf {
    ws.join("firmware")
}

/// "ghost in the machine" -> "ghost-in-the-machine" (the folder and sketch name).
pub fn slug(name: &str) -> String {
    let s: String = name.trim().chars().map(|c| if c.is_alphanumeric() || c == '_' { c.to_ascii_lowercase() } else { '-' }).collect();
    s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

/// The name people see: the folder's dashes as spaces.
pub fn friendly(dir: &str) -> String {
    dir.replace('-', " ")
}

/// The board environment (the template's board sections) for an Arduino board id.
pub fn board_of_fqbn(fqbn: &str) -> Option<&'static str> {
    let f = fqbn.to_lowercase();
    Some(if f.contains("esp32") {
        "esp32dev"
    } else if f.ends_with("rpipico2w") {
        "pico2w"
    } else if f.ends_with("rpipicow") {
        "picow"
    } else if f.ends_with("rpipico") {
        "pico"
    } else {
        return None;
    })
}

/// `(default_profile, [(profile, fqbn)])` from a sketch.yaml (only the keys Studio needs).
pub fn read_sketch_yaml(text: &str) -> (Option<String>, Vec<(String, String)>) {
    let (mut default, mut profiles, mut in_profiles, mut current) = (None, vec![], false, None::<String>);
    for line in text.lines() {
        let indent = line.len() - line.trim_start().len();
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if indent == 0 {
            in_profiles = t == "profiles:";
            if let Some(v) = t.strip_prefix("default_profile:") {
                default = Some(v.trim().to_string());
            }
        } else if in_profiles && indent == 2 && t.ends_with(':') {
            current = Some(t.trim_end_matches(':').to_string());
        } else if let (true, Some(p), Some(f)) = (in_profiles, &current, t.strip_prefix("fqbn:")) {
            profiles.push((p.clone(), f.trim().to_string()));
        }
    }
    (default, profiles)
}

/// A project's version: the number in `firmware/<folder>/VERSION` (the firmware's workspace layout), 0 when none.
fn version_of(ws: &Path, folder: &str) -> u64 {
    std::fs::read_to_string(firmware_dir(ws).join(folder).join("VERSION")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// Every project: `{name, dir, folder, main, version, boards: [{profile, fqbn, env, board}], default_env}`. The
/// environment is the board's name (each sketch has its own hidden PlatformIO project, `builder.rs`), which is
/// also what the Pico bootloader tools expect.
pub fn projects(ws: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(firmware_dir(ws))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            let folder = e.file_name().to_string_lossy().to_string();
            let main = dir.join(format!("{folder}.ino"));
            if !main.exists() {
                return None;
            }
            let name = friendly(&folder);
            let (default, profiles) = read_sketch_yaml(&std::fs::read_to_string(dir.join("sketch.yaml")).unwrap_or_default());
            let boards: Vec<Value> = profiles
                .iter()
                .filter_map(|(p, f)| Some(json!({ "profile": p, "fqbn": f, "board": board_of_fqbn(f)?, "env": board_of_fqbn(f)? })))
                .collect();
            let default_env = boards.iter().find(|b| Some(b["profile"].as_str().unwrap_or("")) == default.as_deref()).or(boards.first()).map(|b| b["env"].clone());
            Some(json!({ "name": name, "folder": folder, "dir": dir.to_string_lossy(), "main": main.to_string_lossy(),
                         "version": version_of(ws, &folder), "boards": boards, "default_env": default_env }))
        })
        .collect();
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}

/// `("my firmware", 3)` from a board's `fw_build` of `my firmware v3`.
pub fn build_id(fw_build: &str) -> Option<(String, u64)> {
    let (name, v) = fw_build.rsplit_once(" v")?;
    Some((name.to_string(), v.parse().ok()?))
}

/// The firmware a board runs, compared with the workspace: `{kind: "custom", name, version, library_version,
/// status: current | older | unknown}` for the user's own firmware, else `{kind: "release"}`.
pub fn identify(ws: &Path, info: &Value) -> Value {
    // the firmware names itself (`fw`, PROPTROLLER_FW_NAME = the sketch folder) on newer firmware; older firmware
    // only carries Studio's build id in `fw_build`
    let named = info["fw"].as_str().filter(|f| *f != "generic" && !f.is_empty()).map(|f| (friendly(f), info["fw_version"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0)));
    let Some((name, version)) = named.or_else(|| info["fw_build"].as_str().and_then(build_id)) else { return json!({ "kind": "release" }) };
    let lv = projects(ws).into_iter().find(|p| p["name"] == name.as_str()).and_then(|p| p["version"].as_u64());
    let status = match lv {
        None => "unknown",
        Some(l) if l > version => "older",
        Some(_) => "current",
    };
    json!({ "kind": "custom", "name": name, "version": version, "library_version": lv, "status": status })
}

/// A first sketch when the firmware has no project template.
const STARTER_SKETCH: &str = "// Your prop. The board already does everything the stock firmware does (the phone page, effect scripts,\n\
// settings, updates); add your own behaviour here.\n\
#include <Arduino.h>\n#include <Proptroller.h>\n\nProptroller prop;\n\n\
void setup() {\n  prop.begin();\n  // TRIG1 closes: sound 1 plays and OUT1 is on for 2 seconds\n  prop.when(TRIG1).playSound(1).turnOn(OUT1, seconds(2));\n}\n\n\
void loop() {\n  prop.update();\n}\n";

const SKETCH_YAML: &str = "# Which boards this firmware is for (arduino-cli's profile file). Specter Studio builds the default one.\n\
default_profile: esp32dev\n\
profiles:\n  esp32dev:\n    fqbn: esp32:esp32:esp32\n  picow:\n    fqbn: rp2040:rp2040:rpipicow\n";

/// A new project: `firmware/<slug>/<slug>.ino` from the template's `src/main.cpp`, and a sketch.yaml.
pub fn new_project(ws: &Path, name: &str, template_dir: &Path) -> Result<Value, String> {
    file_stem(name)?;
    let folder = slug(name);
    if folder.is_empty() {
        return Err("give the firmware a name with letters or digits".into());
    }
    let dir = firmware_dir(ws).join(&folder);
    if dir.exists() {
        return Err(format!("there is already a firmware called \"{}\"", friendly(&folder)));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let main = std::fs::read_to_string(template_dir.join("src/main.cpp")).unwrap_or_else(|_| STARTER_SKETCH.to_string());
    std::fs::write(dir.join(format!("{folder}.ino")), main).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("sketch.yaml"), SKETCH_YAML).map_err(|e| e.to_string())?;
    Ok(json!({ "name": friendly(&folder), "folder": folder, "version": 0 }))
}

/// Raises a project's version by one (before each build) and returns the new build id `<name> v<N>`.
/// The version is written to `firmware/<folder>/VERSION` (read by the firmware's workspace build as well).
pub fn bump(ws: &Path, name: &str) -> Result<String, String> {
    let folder = slug(name);
    let v = version_of(ws, &folder) + 1;
    std::fs::write(firmware_dir(ws).join(&folder).join("VERSION"), format!("{v}\n")).map_err(|e| e.to_string())?;
    Ok(format!("{name} v{v}"))
}

pub const PROJECTS_LINE: &str = "; ---- projects: written by make_envs.py from firmware/*/sketch.yaml (do not edit below) ----";

/// Makes the library folder a workspace the firmware's own tools build too (open it in VS Code with PlatformIO):
/// `platformio.ini` from the firmware's `workspace-template` (its board sections, `dir` pointed at
/// `arduino_dir`), one `[env:<folder>]` per sketch by the same rules as its `make_envs.py` (which is copied in,
/// with `project_src.py`). Nothing happens with a firmware that has no workspace template yet.
pub fn write_workspace_ini(ws: &Path, arduino_dir: &Path) -> Result<bool, String> {
    let wt = arduino_dir.join("workspace-template");
    let Ok(template) = std::fs::read_to_string(wt.join("platformio.ini")) else { return Ok(false) };
    let path = ws.join("platformio.ini");
    let existing = std::fs::read_to_string(&path).ok();
    // a platformio.ini of the person's own (no projects line) is theirs: Studio leaves it alone
    if existing.as_ref().is_some_and(|s| !s.contains(PROJECTS_LINE)) {
        return Ok(false);
    }
    let current = existing.filter(|s| s.contains(PROJECTS_LINE));
    let head = match &current {
        Some(s) => s[..s.find(PROJECTS_LINE).unwrap()].to_string(),
        None => {
            let t = &template[..template.find(PROJECTS_LINE).ok_or("the workspace template has no projects line")?];
            t.lines().map(|l| if l.trim_start().starts_with("dir = ") { format!("dir = {}", arduino_dir.display()) } else { l.to_string() }).collect::<Vec<_>>().join("\n") + "\n"
        }
    };
    let envs: Vec<String> = projects(ws)
        .iter()
        .filter_map(|p| {
            let folder = p["folder"].as_str()?;
            // the firmware's rule: the first fqbn in sketch.yaml picks the board
            let board = p["boards"].as_array()?.first()?["board"].as_str()?.to_string();
            Some(format!("[env:{folder}]\nextends = board_{board}\ncustom_project = {folder}\n"))
        })
        .collect();
    let new = format!("{head}{PROJECTS_LINE}\n\n{}", envs.join("\n"));
    if current.as_deref() != Some(new.as_str()) {
        std::fs::write(&path, new).map_err(|e| e.to_string())?;
    }
    // the helper scripts: written when missing, and replaced (a newer firmware's) only while they are still
    // exactly what Studio wrote last time (`.specter/written.json`, by hash); a changed one is the person's
    let record = ws.join(".specter").join("written.json");
    let mut written: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&record).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    for f in ["project_src.py", "make_envs.py"] {
        let want = std::fs::read(wt.join(f)).map_err(|e| format!("cannot read {f}: {e}"))?;
        let dest = ws.join(f);
        let ours = match std::fs::read(&dest) {
            Err(_) => true,
            Ok(have) => have == want || written.get(f).and_then(|h| h.as_str()) == Some(crate::fleet::sha256_hex(&have).as_str()),
        };
        if ours {
            std::fs::write(&dest, &want).map_err(|e| format!("cannot write {f}: {e}"))?;
            written.insert(f.into(), serde_json::json!(crate::fleet::sha256_hex(&want)));
        }
    }
    if std::fs::create_dir_all(ws.join(".specter")).is_ok() {
        let _ = std::fs::write(&record, serde_json::to_string_pretty(&written).unwrap_or_default());
    }
    Ok(true)
}
