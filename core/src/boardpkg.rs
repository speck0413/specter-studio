//! Board packages, profiles and scripts: data a board takes over its protocol, so one firmware image per chip
//! runs on many boards (docs/DESIGN.md "Board packages").
//!
//! * A **board package** says which pins drive which terminals, plus the board's own defaults (settings, profile,
//!   script). The board checks it and says what is wrong in plain words; Studio only checks the envelope
//!   ([`check_package`]): a JSON object, `"board_package": 1`, an `id` and a `name`, at most
//!   [`MAX_PACKAGE_BYTES`]. Firmware that takes packages lists `board_package` in `info.capabilities`; the board
//!   has built-in **presets** (`get_board`) and keeps one stored package (`set_board`).
//! * An allowed extension may offer package files, profiles and scripts in its plugin.json, as files inside its
//!   own folder (no absolute paths, no `..`):
//!
//! ```json
//! "board_packages": ["board-packages/lamp-board.json"],
//! "profiles": [{"name": "Lamp words", "file": "profiles/lamp.json"}],
//! "scripts": [{"name": "Blink twice", "file": "scripts/blink.txt"}]
//! ```
//!
//! [`list`] reads them for the dropdowns (a file that is missing or wrong is listed with its `error`, never
//! hidden), [`read`] gives one back only when its plugin is allowed and lists exactly that file, and [`requests`]
//! builds the protocol calls that put a choice on a board. The restart (`reboot`) is never in that list: the
//! board keeps its old pin map until it restarts, and Studio asks the person first (a USB install restarts it
//! by itself, after the install was confirmed).

use crate::fleet;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

/// The capability firmware lists in `info.capabilities` when it takes board packages.
pub const CAPABILITY: &str = "board_package";
/// The package format Studio sends (`"board_package": 1`).
pub const PACKAGE_FORMAT: u64 = 1;
/// The largest package a board stores.
pub const MAX_PACKAGE_BYTES: usize = 16 * 1024;
/// The largest profile file (the board's settings record holds 12 KB in all).
pub const MAX_PROFILE_BYTES: usize = 12 * 1024;
/// The largest effect script (the firmware's `SCRIPT_MAX_BYTES`).
pub const MAX_SCRIPT_BYTES: usize = 8 * 1024;
/// At most this many files of each kind per extension.
pub const MAX_FILES_PER_KIND: usize = 32;
/// The longest name shown for a file.
pub const MAX_NAME_CHARS: usize = 60;
/// The presets a generic image has built in when its release entry lists none (`"presets"`): the Proptroller
/// board's own map.
pub const DEFAULT_PRESETS: &[(&str, &str)] = &[(fleet::DEFAULT_BOARD, "Proptroller board")];

/// The three kinds of file an extension may offer, by their plugin.json key.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Package,
    Profile,
    Script,
}

impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Kind::Package => "board_packages",
            Kind::Profile => "profiles",
            Kind::Script => "scripts",
        }
    }
    pub fn parse(s: &str) -> Option<Kind> {
        [Kind::Package, Kind::Profile, Kind::Script].into_iter().find(|k| k.key() == s || k.key().trim_end_matches('s') == s)
    }
}

/// A file inside a plugin's folder: a relative path of plain names only (no absolute path, no `..`, no `.`).
pub fn rel_file(dir: &str, rel: &str) -> Option<PathBuf> {
    let s = rel.trim();
    let p = Path::new(s);
    let dotted = s.split(['/', '\\']).any(|seg| seg == "." || seg == "..");
    if s.is_empty() || dir.is_empty() || dotted || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(Path::new(dir).join(p))
}

/// Whether a board's firmware takes board packages (its `info`).
pub fn takes_packages(info: &Value) -> bool {
    info["capabilities"].as_array().is_some_and(|c| c.iter().any(|x| x == CAPABILITY))
}

fn too_big(what: &str, bytes: usize, max: usize) -> String {
    format!("the {what} is too big: {bytes} bytes, a board takes at most {max}")
}

/// Studio's own check of a package file: the envelope only (the board checks the pins and says what is wrong).
pub fn check_package(text: &str) -> Result<Value, String> {
    if text.len() > MAX_PACKAGE_BYTES {
        return Err(too_big("board package", text.len(), MAX_PACKAGE_BYTES));
    }
    let v: Value = serde_json::from_str(text).map_err(|e| format!("this is not a board package (not JSON: {e})"))?;
    check_package_value(&v)?;
    Ok(v)
}

/// [`check_package`] for a package that is already parsed (also its size as JSON).
pub fn check_package_value(v: &Value) -> Result<(), String> {
    if !v.is_object() {
        return Err("this is not a board package (it must be one JSON object)".into());
    }
    match v["board_package"].as_u64() {
        Some(PACKAGE_FORMAT) => {}
        Some(n) => return Err(format!("this board package is format {n}; Studio sends format {PACKAGE_FORMAT}")),
        None => return Err("this is not a board package (\"board_package\": 1 is missing)".into()),
    }
    for f in ["id", "name"] {
        if v[f].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err(format!("the board package has no {f}"));
        }
    }
    let bytes = v.to_string().len();
    if bytes > MAX_PACKAGE_BYTES {
        return Err(too_big("board package", bytes, MAX_PACKAGE_BYTES));
    }
    Ok(())
}

/// A profile file: one JSON object (the board checks what is in it).
pub fn check_profile(text: &str) -> Result<Value, String> {
    if text.len() > MAX_PROFILE_BYTES {
        return Err(too_big("profile", text.len(), MAX_PROFILE_BYTES));
    }
    let v: Value = serde_json::from_str(text).map_err(|e| format!("this is not a profile (not JSON: {e})"))?;
    if !v.is_object() {
        return Err("this is not a profile (it must be one JSON object)".into());
    }
    Ok(v)
}

/// A script file: text (the board checks it, as for any script it is sent).
pub fn check_script(text: &str) -> Result<String, String> {
    if text.len() > MAX_SCRIPT_BYTES {
        return Err(too_big("script", text.len(), MAX_SCRIPT_BYTES));
    }
    if text.trim().is_empty() {
        return Err("the script is empty".into());
    }
    Ok(text.to_string())
}

fn short_name(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(MAX_NAME_CHARS).collect())
}

/// The `(file, name)` entries a plugin lists for `kind` (packages are bare paths, named from their JSON).
fn entries(p: &Value, kind: Kind) -> Vec<(String, Option<String>)> {
    p[kind.key()]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| match kind {
            Kind::Package => e.as_str().map(|f| (f.to_string(), None)),
            _ => Some((e["file"].as_str()?.to_string(), short_name(e["name"].as_str()))),
        })
        .take(MAX_FILES_PER_KIND)
        .collect()
}

fn allowed_plugin<'a>(plugins: &'a [Value], allowed: &[String], id: &str) -> Option<&'a Value> {
    plugins.iter().find(|p| p["id"] == id && allowed.iter().any(|a| a == id))
}

/// A file's content, checked for its kind: a package or profile as JSON, a script as text.
fn load(kind: Kind, path: &Path) -> Result<Value, String> {
    let max = match kind {
        Kind::Package => MAX_PACKAGE_BYTES,
        Kind::Profile => MAX_PROFILE_BYTES,
        Kind::Script => MAX_SCRIPT_BYTES,
    };
    let meta = std::fs::metadata(path).map_err(|_| "the file is missing".to_string())?;
    if meta.len() as usize > max {
        return Err(too_big(match kind { Kind::Package => "board package", Kind::Profile => "profile", Kind::Script => "script" }, meta.len() as usize, max));
    }
    let text = std::fs::read_to_string(path).map_err(|_| "the file cannot be read as text".to_string())?;
    match kind {
        Kind::Package => check_package(&text),
        Kind::Profile => check_profile(&text),
        Kind::Script => check_script(&text).map(Value::String),
    }
}

/// Every file the allowed plugins offer: `{packages, profiles, scripts}`, each entry `{plugin: {id, name}, file,
/// name, error?}`; a package also has its `id`, `mcu` (null for one that names its `base`) and `base`. A file
/// whose path leaves its plugin's folder, is missing or is not right is listed with `error` (plain words).
pub fn list(plugins: &[Value], allowed: &[String]) -> Value {
    let mut out = json!({ "packages": [], "profiles": [], "scripts": [] });
    for p in plugins {
        let Some(id) = p["id"].as_str() else { continue };
        if !allowed.iter().any(|a| a == id) {
            continue;
        }
        let plugin = json!({ "id": id, "name": p["name"].as_str().unwrap_or(id) });
        let dir = p["dir"].as_str().unwrap_or("");
        for (kind, slot) in [(Kind::Package, "packages"), (Kind::Profile, "profiles"), (Kind::Script, "scripts")] {
            for (file, name) in entries(p, kind) {
                let mut row = json!({ "plugin": plugin, "file": file, "name": name.clone().unwrap_or_else(|| file.clone()) });
                let loaded = match rel_file(dir, &file) {
                    None => Err("the file must be inside the extension's folder".to_string()),
                    Some(path) => load(kind, &path),
                };
                match loaded {
                    Ok(v) if kind == Kind::Package => {
                        row["id"] = v["id"].clone();
                        row["name"] = json!(short_name(v["name"].as_str()).unwrap_or_default());
                        row["mcu"] = v.get("mcu").cloned().unwrap_or(Value::Null);
                        row["base"] = v.get("base").cloned().unwrap_or(Value::Null);
                        row["defaults"] = defaults_summary(&v);
                    }
                    Ok(_) => {}
                    Err(e) => row["error"] = json!(e),
                }
                out[slot].as_array_mut().unwrap().push(row);
            }
        }
    }
    out
}

/// What a package's own defaults hold (Start fresh says it): `{settings: n, profile: bool, script: bool}`.
pub fn defaults_summary(pkg: &Value) -> Value {
    let d = &pkg["defaults"];
    json!({ "settings": d["settings"].as_object().map_or(0, |o| o.len()), "profile": d["profile"].is_object(),
            "script": d["script"].as_str().is_some_and(|s| !s.trim().is_empty()) })
}

/// One offered file's content (a package or profile as JSON, a script as a string), only when its plugin is
/// allowed and lists exactly this file for this kind.
pub fn read(plugins: &[Value], allowed: &[String], kind: Kind, plugin: &str, file: &str) -> Result<Value, String> {
    let p = allowed_plugin(plugins, allowed, plugin).ok_or_else(|| format!("the extension “{plugin}” is not allowed (Settings > Extensions)"))?;
    if !entries(p, kind).iter().any(|(f, _)| f == file) {
        return Err(format!("the extension “{}” does not offer {file}", p["name"].as_str().unwrap_or(plugin)));
    }
    let path = rel_file(p["dir"].as_str().unwrap_or(""), file).ok_or("the file must be inside the extension's folder")?;
    load(kind, &path).map_err(|e| format!("{file}: {e}"))
}

/// The board package part of a setup.
#[derive(Clone, Debug, PartialEq)]
pub enum PackageChoice {
    /// leave the board's package as it is
    Keep,
    /// one of the board's built-in presets, by id
    Preset(String),
    /// a full package (checked with [`check_package_value`])
    Package(Value),
    /// drop the stored package (the board goes back to its built-in one)
    Forget,
}

/// What goes on a board: a package choice (with or without its own defaults), then an optional profile and
/// script.
#[derive(Clone, Debug, PartialEq)]
pub struct Setup {
    pub package: PackageChoice,
    /// `"defaults": "apply"`: the package's own settings, profile and script are applied once at the next boot
    /// (Wi-Fi kept)
    pub defaults: bool,
    pub profile: Option<Value>,
    pub script: Option<String>,
}

/// Whether the package's own defaults are applied at the next boot (profile, then settings, then script, on top
/// of what is stored): a profile or script sent before that restart would be replaced.
fn applies_defaults(s: &Setup) -> bool {
    s.defaults && matches!(s.package, PackageChoice::Preset(_) | PackageChoice::Package(_))
}

/// The package with the chosen profile and script as its own defaults, when that still fits a board.
fn merged(s: &Setup) -> Option<Value> {
    let PackageChoice::Package(p) = &s.package else { return None };
    if !applies_defaults(s) || (s.profile.is_none() && s.script.is_none()) {
        return None;
    }
    let mut m = p.clone();
    if !m["defaults"].is_object() {
        m["defaults"] = json!({});
    }
    if let Some(pr) = &s.profile {
        m["defaults"]["profile"] = pr.clone();
    }
    if let Some(t) = &s.script {
        m["defaults"]["script"] = json!(t);
    }
    check_package_value(&m).ok().map(|_| m)
}

fn file_requests(s: &Setup) -> Vec<Value> {
    let mut out = vec![];
    if let Some(p) = &s.profile {
        out.push(json!({ "op": "set_profile", "data": p }));
    }
    if let Some(t) = &s.script {
        out.push(json!({ "op": "set_script", "text": t, "bytes": t.len() }));
    }
    out
}

/// The requests to send once the board is back after the restart: the chosen profile and script when the
/// package's defaults are applied at that boot and they could not go into the package (a preset, or too big).
/// Sent before the restart they would be replaced by the package's own.
pub fn after_restart(s: &Setup) -> Vec<Value> {
    if !applies_defaults(s) || merged(s).is_some() {
        return vec![];
    }
    file_requests(s)
}

/// The requests that put a setup on a board, in order: `set_board`, then `set_profile`, then `set_script` (those
/// two only when the restart does not replace them: else they go into the package's defaults, or come after the
/// restart, [`after_restart`]). The `reboot` is not in it ([`restart_needed`], [`reboot`]).
pub fn requests(s: &Setup) -> Vec<Value> {
    let mut out = vec![];
    let merged = merged(s);
    let mut set = match &s.package {
        PackageChoice::Keep => None,
        PackageChoice::Preset(id) => Some(json!({ "op": "set_board", "preset": id })),
        PackageChoice::Package(p) => Some(json!({ "op": "set_board", "package": merged.as_ref().unwrap_or(p) })),
        PackageChoice::Forget => Some(json!({ "op": "set_board", "forget": true })),
    };
    if let Some(r) = set.as_mut() {
        if s.defaults && !matches!(s.package, PackageChoice::Forget) {
            r["defaults"] = json!("apply");
        }
        out.push(set.unwrap());
    }
    if !applies_defaults(s) {
        out.extend(file_requests(s));
    }
    out
}

/// A new board package takes effect only after a restart (profile and script take effect at once).
pub fn restart_needed(s: &Setup) -> bool {
    s.package != PackageChoice::Keep
}

/// The restart request sent after the person agreed (or after a USB install).
pub fn reboot() -> Value {
    json!({ "op": "reboot" })
}

/// The built-in presets of a release image (`"presets"`: ids or `{id, name}`), else [`DEFAULT_PRESETS`]. Each
/// `{id, name}`.
pub fn presets_of(img: &Value) -> Vec<Value> {
    match img["presets"].as_array() {
        Some(list) => list
            .iter()
            .filter_map(|p| match p {
                Value::String(id) => Some(json!({ "id": id, "name": id })),
                Value::Object(_) => p["id"].as_str().map(|id| json!({ "id": id, "name": p["name"].as_str().unwrap_or(id) })),
                _ => None,
            })
            .collect(),
        None => DEFAULT_PRESETS.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect(),
    }
}

/// The plain-word reason an over-the-air update is refused when it would move a board onto an image without its
/// board package.
pub fn ota_refusal(board: &str) -> String {
    format!("this board runs the {board} board package, which the new firmware does not have built in, and its firmware cannot take a board package over Wi-Fi: install over USB so the board package goes on with it")
}

/// Why `manifest` has no over-the-air image for a board although it has one for its chip: the board runs a board
/// package the generic image does not have built in, and its firmware cannot be sent one (no `board_package`
/// capability). None when there is an image ([`fleet::image_for`]) or the release has nothing for this chip.
pub fn ota_blocked(manifest: &Value, info: &Value) -> Option<String> {
    if fleet::image_for(manifest, info).is_some() || takes_packages(info) {
        return None;
    }
    let for_chip = manifest["images"].as_array()?.iter().any(|i| i["first_flash"] != true && i["fw"] == info["fw"] && i["mcu"] == info["mcu"]);
    for_chip.then(|| ota_refusal(fleet::board_of(info)))
}

/// A setup from a UI request: `package` (`{preset}`, `{plugin, file}` of an offered file, or `{forget: true}`;
/// absent = keep), `defaults`, `profile` and `script` (`{plugin, file}`).
pub fn setup_from(plugins: &[Value], allowed: &[String], a: &Value) -> Result<Setup, String> {
    let pick = &a["package"];
    let package = if pick.is_null() {
        PackageChoice::Keep
    } else if pick["forget"] == true {
        PackageChoice::Forget
    } else if let Some(id) = pick["preset"].as_str().filter(|s| !s.is_empty()) {
        PackageChoice::Preset(id.to_string())
    } else if let (Some(p), Some(f)) = (pick["plugin"].as_str(), pick["file"].as_str()) {
        PackageChoice::Package(read(plugins, allowed, Kind::Package, p, f)?)
    } else if pick["inline"].is_object() {
        // a built-in package as the board gave it (get_board with `preset`), for a USB install of the generic image
        check_package_value(&pick["inline"])?;
        PackageChoice::Package(pick["inline"].clone())
    } else {
        return Err("choose a board package".into());
    };
    let file = |k: Kind, v: &Value| -> Result<Option<Value>, String> {
        match (v["plugin"].as_str(), v["file"].as_str()) {
            (Some(p), Some(f)) => read(plugins, allowed, k, p, f).map(Some),
            _ => Ok(None),
        }
    };
    let profile = file(Kind::Profile, &a["profile"])?;
    let script = file(Kind::Script, &a["script"])?.and_then(|v| v.as_str().map(String::from));
    Ok(Setup { package, defaults: a["defaults"] == true, profile, script })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkg(id: &str) -> Value {
        json!({ "board_package": 1, "id": id, "name": "Demo lamp board", "mcu": "esp32-devkit", "terminals": { "OUT1": { "pin": 23 } } })
    }

    #[test]
    fn paths_stay_inside_the_plugin_folder() {
        assert_eq!(rel_file("/p/a", "board-packages/x.json"), Some(Path::new("/p/a").join("board-packages/x.json")));
        for bad in ["", "  ", "../x.json", "a/../../x.json", "/etc/passwd", "./x.json", "a/./x.json"] {
            assert_eq!(rel_file("/p/a", bad), None, "{bad}");
        }
        assert_eq!(rel_file("", "x.json"), None);
    }

    #[test]
    fn a_package_is_checked_for_its_envelope_only() {
        assert!(check_package(&pkg("lamp").to_string()).is_ok());
        // pins are the board's business: Studio does not look at them
        assert!(check_package(r#"{"board_package":1,"id":"x","name":"X","terminals":{"TRIG2":{"pin":35}}}"#).is_ok());
        assert!(check_package(r#"{"board_package":1,"id":"x","name":"X","base":"proptroller"}"#).is_ok());
        let e = |t: &str| check_package(t).unwrap_err();
        assert!(e("[1]").contains("one JSON object"));
        assert!(e("{").contains("not JSON"));
        assert!(e(r#"{"id":"x","name":"X"}"#).contains("\"board_package\": 1 is missing"));
        assert!(e(r#"{"board_package":2,"id":"x","name":"X"}"#).contains("format 2"));
        assert!(e(r#"{"board_package":1,"id":"","name":"X"}"#).contains("no id"));
        assert!(e(r#"{"board_package":1,"id":"x","name":"  "}"#).contains("no name"));
        let big = json!({ "board_package": 1, "id": "x", "name": "X", "note": "a".repeat(MAX_PACKAGE_BYTES) }).to_string();
        assert!(e(&big).contains("too big"));
    }

    #[test]
    fn profiles_and_scripts_are_checked_for_shape_and_size() {
        assert!(check_profile(r#"{"title":"Lamp"}"#).is_ok());
        assert!(check_profile("[]").unwrap_err().contains("one JSON object"));
        assert!(check_profile(&"x".repeat(MAX_PROFILE_BYTES + 1)).unwrap_err().contains("too big"));
        assert_eq!(check_script("effect1: x\n").unwrap(), "effect1: x\n");
        assert!(check_script(" \n").unwrap_err().contains("empty"));
        assert!(check_script(&"x".repeat(MAX_SCRIPT_BYTES + 1)).unwrap_err().contains("too big"));
    }

    fn plugin_folder(name: &str) -> (PathBuf, Vec<Value>) {
        let root = std::env::temp_dir().join(format!("studio-boardpkg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("lamps");
        std::fs::create_dir_all(dir.join("board-packages")).unwrap();
        std::fs::create_dir_all(dir.join("profiles")).unwrap();
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("board-packages/lamp.json"), pkg("lamp-board").to_string()).unwrap();
        std::fs::write(dir.join("board-packages/broken.json"), "{ nope").unwrap();
        std::fs::write(dir.join("profiles/lamp.json"), r#"{"title":"Lamp"}"#).unwrap();
        std::fs::write(dir.join("scripts/blink.txt"), "effect1: blink\n").unwrap();
        std::fs::write(root.join("secret.json"), pkg("outside").to_string()).unwrap();
        let p = json!({ "id": "lamps", "name": "Lamps", "dir": dir.to_string_lossy(),
            "board_packages": ["board-packages/lamp.json", "board-packages/broken.json", "../secret.json", "board-packages/gone.json"],
            "profiles": [{ "name": "Lamp words", "file": "profiles/lamp.json" }],
            "scripts": [{ "name": "Blink twice", "file": "scripts/blink.txt" }, { "name": "Away", "file": "/etc/hostname" }] });
        (root, vec![p])
    }

    #[test]
    fn listing_names_each_file_and_says_what_is_wrong() {
        let (root, ps) = plugin_folder("list");
        // not allowed: nothing
        let none = list(&ps, &[]);
        assert_eq!(none["packages"].as_array().unwrap().len(), 0);
        let l = list(&ps, &["lamps".into()]);
        let p = l["packages"].as_array().unwrap();
        assert_eq!(p.len(), 4);
        assert_eq!((p[0]["name"].as_str(), p[0]["id"].as_str(), p[0]["mcu"].as_str()), (Some("Demo lamp board"), Some("lamp-board"), Some("esp32-devkit")));
        assert_eq!(p[0]["plugin"]["name"], "Lamps");
        assert_eq!(p[0]["defaults"], json!({ "settings": 0, "profile": false, "script": false }));
        assert_eq!(defaults_summary(&json!({ "defaults": { "settings": { "a": 1, "b": 2 }, "profile": {}, "script": "effect1: x" } })), json!({ "settings": 2, "profile": true, "script": true }));
        assert!(p[0].get("error").is_none());
        assert!(p[1]["error"].as_str().unwrap().contains("not JSON"));
        assert!(p[2]["error"].as_str().unwrap().contains("inside the extension's folder"));
        assert!(p[3]["error"].as_str().unwrap().contains("missing"));
        assert_eq!(l["profiles"][0]["name"], "Lamp words");
        assert!(l["profiles"][0].get("error").is_none());
        assert_eq!(l["scripts"][0]["name"], "Blink twice");
        assert!(l["scripts"][1]["error"].as_str().unwrap().contains("inside"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn read_gives_only_listed_files_of_allowed_plugins() {
        let (root, ps) = plugin_folder("read");
        let ok: Vec<String> = vec!["lamps".into()];
        assert_eq!(read(&ps, &ok, Kind::Package, "lamps", "board-packages/lamp.json").unwrap()["id"], "lamp-board");
        assert_eq!(read(&ps, &ok, Kind::Script, "lamps", "scripts/blink.txt").unwrap(), "effect1: blink\n");
        assert!(read(&ps, &[], Kind::Package, "lamps", "board-packages/lamp.json").unwrap_err().contains("not allowed"));
        // a file it does not list for that kind, or a path out of its folder
        assert!(read(&ps, &ok, Kind::Profile, "lamps", "board-packages/lamp.json").unwrap_err().contains("does not offer"));
        assert!(read(&ps, &ok, Kind::Package, "lamps", "../secret.json").unwrap_err().contains("inside"));
        assert!(read(&ps, &ok, Kind::Package, "other", "x.json").unwrap_err().contains("not allowed"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_requests_come_in_order_without_the_restart() {
        // without the package's defaults: set_board, then the profile and script at once
        let s = Setup { package: PackageChoice::Package(pkg("lamp")), defaults: false, profile: Some(json!({ "title": "Lamp" })), script: Some("effect1: x\n".into()) };
        let r = requests(&s);
        let ops: Vec<&str> = r.iter().map(|x| x["op"].as_str().unwrap()).collect();
        assert_eq!(ops, ["set_board", "set_profile", "set_script"]);
        assert_eq!(r[0]["package"]["id"], "lamp");
        assert!(r[0].get("defaults").is_none());
        assert_eq!(r[1]["data"]["title"], "Lamp");
        assert_eq!((r[2]["text"].as_str(), r[2]["bytes"].as_u64()), (Some("effect1: x\n"), Some(11)));
        assert!(after_restart(&s).is_empty());
        assert!(restart_needed(&s));
        assert_eq!(reboot(), json!({ "op": "reboot" }));

        // a preset, no defaults: exactly one of package / preset / forget
        let r = requests(&Setup { package: PackageChoice::Preset("proptroller".into()), defaults: false, profile: None, script: None });
        assert_eq!(r, vec![json!({ "op": "set_board", "preset": "proptroller" })]);
        let r = requests(&Setup { package: PackageChoice::Forget, defaults: true, profile: None, script: None });
        assert_eq!(r, vec![json!({ "op": "set_board", "forget": true })]);
        // only a profile: no set_board and no restart
        let s = Setup { package: PackageChoice::Keep, defaults: true, profile: Some(json!({})), script: None };
        assert_eq!(requests(&s).iter().map(|x| x["op"].clone()).collect::<Vec<_>>(), vec![json!("set_profile")]);
        assert!(!restart_needed(&s));
    }

    #[test]
    fn with_the_packages_defaults_the_chosen_profile_and_script_are_never_replaced_at_the_restart() {
        // the board applies the package's defaults at the next boot, on top of what is stored: a profile or script
        // sent before the restart would be replaced. They go into the package's defaults when they fit...
        let s = Setup { package: PackageChoice::Package(pkg("lamp")), defaults: true, profile: Some(json!({ "title": "Lamp" })), script: Some("effect1: x\n".into()) };
        let r = requests(&s);
        assert_eq!(r.len(), 1, "{r:?}");
        assert_eq!(r[0]["defaults"], "apply");
        assert_eq!(r[0]["package"]["defaults"]["profile"]["title"], "Lamp");
        assert_eq!(r[0]["package"]["defaults"]["script"], "effect1: x\n");
        assert_eq!(r[0]["package"]["terminals"]["OUT1"]["pin"], 23);
        assert!(after_restart(&s).is_empty());
        // ...a preset cannot hold them: they come after the restart
        let s = Setup { package: PackageChoice::Preset("relay-board".into()), defaults: true, profile: Some(json!({ "title": "Lamp" })), script: Some("effect1: x\n".into()) };
        assert_eq!(requests(&s), vec![json!({ "op": "set_board", "preset": "relay-board", "defaults": "apply" })]);
        let a: Vec<Value> = after_restart(&s).iter().map(|x| x["op"].clone()).collect();
        assert_eq!(a, vec![json!("set_profile"), json!("set_script")]);
        // ...and so does a script too big to go into the package
        let big = "effect1: x\n".repeat(MAX_PACKAGE_BYTES / 10);
        let s = Setup { package: PackageChoice::Package(pkg("lamp")), defaults: true, profile: None, script: Some(big) };
        assert!(requests(&s)[0]["package"]["defaults"].is_null());
        assert_eq!(after_restart(&s).len(), 1);
        // only a profile, no package change: at once
        let s = Setup { package: PackageChoice::Keep, defaults: true, profile: Some(json!({})), script: None };
        assert_eq!(requests(&s).len(), 1);
        assert!(after_restart(&s).is_empty());
    }

    #[test]
    fn a_setup_from_the_ui_reads_its_files_through_the_plugin() {
        let (root, ps) = plugin_folder("setup");
        let ok: Vec<String> = vec!["lamps".into()];
        let s = setup_from(&ps, &ok, &json!({ "package": { "plugin": "lamps", "file": "board-packages/lamp.json" }, "defaults": true,
            "profile": { "plugin": "lamps", "file": "profiles/lamp.json" }, "script": { "plugin": "lamps", "file": "scripts/blink.txt" } })).unwrap();
        assert!(matches!(&s.package, PackageChoice::Package(p) if p["id"] == "lamp-board"));
        assert!(s.defaults);
        assert_eq!(s.script.as_deref(), Some("effect1: blink\n"));
        assert_eq!(setup_from(&ps, &ok, &json!({ "package": { "preset": "proptroller" } })).unwrap().package, PackageChoice::Preset("proptroller".into()));
        assert_eq!(setup_from(&ps, &ok, &json!({ "package": { "forget": true } })).unwrap().package, PackageChoice::Forget);
        assert_eq!(setup_from(&ps, &ok, &json!({})).unwrap().package, PackageChoice::Keep);
        // a built-in package the board gave: checked like a file
        assert!(matches!(setup_from(&ps, &[], &json!({ "package": { "inline": pkg("relay") } })).unwrap().package, PackageChoice::Package(p) if p["id"] == "relay"));
        assert!(setup_from(&ps, &[], &json!({ "package": { "inline": { "id": "x" } } })).unwrap_err().contains("board_package"));
        assert!(setup_from(&ps, &ok, &json!({ "package": { "plugin": "lamps", "file": "board-packages/broken.json" } })).unwrap_err().contains("not JSON"));
        assert!(setup_from(&ps, &[], &json!({ "script": { "plugin": "lamps", "file": "scripts/blink.txt" } })).unwrap_err().contains("not allowed"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn presets_come_from_the_release_entry_or_the_proptroller_board() {
        assert_eq!(presets_of(&json!({})), vec![json!({ "id": "proptroller", "name": "Proptroller board" })]);
        let p = presets_of(&json!({ "presets": ["proptroller", { "id": "relay4-button", "name": "Relay board" }, 3] }));
        assert_eq!(p, vec![json!({ "id": "proptroller", "name": "proptroller" }), json!({ "id": "relay4-button", "name": "Relay board" })]);
    }

    #[test]
    fn an_update_never_moves_a_board_off_its_package_unless_the_firmware_takes_one() {
        let m = json!({ "version": "0.3.0", "images": [
            { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "g.bin", "sha256": "aa", "presets": ["proptroller", "relay4-button"] },
            { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "first.bin", "sha256": "bb", "first_flash": true }] });
        let info = |board: &str, caps: Value| json!({ "fw": "generic", "fw_impl": "cpp", "mcu": "esp32-devkit", "board": board, "capabilities": caps });
        // the Proptroller board, or a board whose package the image has built in: the generic image
        assert_eq!(fleet::image_for(&m, &info("proptroller", json!([]))).unwrap()["file"], "g.bin");
        assert_eq!(fleet::image_for(&m, &info("relay4-button", json!([]))).unwrap()["file"], "g.bin");
        assert!(ota_blocked(&m, &info("relay4-button", json!([]))).is_none());
        // a package the image does not have, on firmware that cannot take one: refused, with the reason
        let old = info("lamp-board", json!(["pin"]));
        assert!(fleet::image_for(&m, &old).is_none());
        let why = ota_blocked(&m, &old).unwrap();
        assert!(why.contains("install over USB so the board package goes on with it"), "{why}");
        assert!(why.contains("lamp-board"));
        // firmware that takes packages keeps its stored one through the update: the generic image
        let new = info("lamp-board", json!(["pin", CAPABILITY]));
        assert_eq!(fleet::image_for(&m, &new).unwrap()["file"], "g.bin");
        assert!(ota_blocked(&m, &new).is_none());
        // nothing for this chip at all: no refusal (there is simply no update)
        let pico = json!({ "fw": "generic", "fw_impl": "cpp", "mcu": "pico-w", "board": "lamp-board" });
        assert!(ota_blocked(&m, &pico).is_none());
    }

    #[test]
    fn kinds_parse_from_their_plugin_json_keys() {
        assert_eq!(Kind::parse("board_packages"), Some(Kind::Package));
        assert_eq!(Kind::parse("profile"), Some(Kind::Profile));
        assert_eq!(Kind::parse("scripts"), Some(Kind::Script));
        assert_eq!(Kind::parse("firmware"), None);
    }
}
