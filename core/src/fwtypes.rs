//! Firmware types: which firmware a board runs (`info.fw`) and where each type's releases come from. Studio
//! knows one type itself, the stock firmware (`generic`, from the release source in Settings). An allowed plugin
//! adds more in its plugin.json:
//!
//! ```json
//! "firmware": [{"fw": "lamp", "name": "Demo lamp", "source": "releases"}]
//! ```
//!
//! `source` is a release list as Settings takes it (an https GitHub releases page or manifest address), or a
//! folder inside the plugin's own folder. A type's list only counts for that type: images in it for any other
//! `fw` are ignored, so a plugin can add a type but never replace the stock images or another plugin's.
//! Updates follow the type the board reports; installing another type is a switch the person confirms.

use crate::fleet;
use serde_json::{json, Value};
use std::path::{Component, Path};

pub const GENERIC: &str = "generic";
pub const GENERIC_NAME: &str = "Generic (stock)";

/// The refusal when an update would change a board's firmware type without the person's confirmation.
pub fn switch_refusal(from: &str, to: &str) -> String {
    format!("this board runs the {from} firmware, and installing {to} would replace it: Studio does that only when you confirm the switch")
}

fn fw_ok(fw: &str) -> bool {
    !fw.is_empty() && fw.len() <= 32 && fw.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
}

/// A plugin's `source`: a web address as it is (only https is ever fetched, `fleet::web_url_ok`), else a folder
/// inside the plugin's folder (no absolute paths, no `..`).
fn plugin_source(dir: &str, source: &str) -> Option<String> {
    let s = source.trim();
    if s.starts_with("https://") || s.starts_with("http://") {
        return Some(s.to_string());
    }
    let rel = Path::new(s);
    if s.is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return None;
    }
    Some(Path::new(dir).join(rel).to_string_lossy().into_owned())
}

/// Every firmware type Studio can install: the stock firmware from `source` (the Settings release source, empty =
/// the official releases), then the types of the plugins in `allowed` (the ones the person allowed), in plugin
/// order. A plugin type with a bad name, no source, `generic` or a type already listed is left out.
/// Each: `{fw, name, source, plugin}` (`plugin`: the plugin's id and name, null for the stock firmware).
pub fn types(source: &str, plugins: &[Value], allowed: &[String]) -> Vec<Value> {
    let mut out = vec![json!({ "fw": GENERIC, "name": GENERIC_NAME, "source": source, "plugin": null })];
    for p in plugins {
        let Some(id) = p["id"].as_str() else { continue };
        if !allowed.iter().any(|a| a == id) {
            continue;
        }
        let dir = p["dir"].as_str().unwrap_or("");
        for t in p["firmware"].as_array().into_iter().flatten() {
            let fw = t["fw"].as_str().unwrap_or("");
            let name = t["name"].as_str().map(str::trim).filter(|n| !n.is_empty() && n.chars().count() <= 60);
            let src = t["source"].as_str().and_then(|s| plugin_source(dir, s));
            let (Some(name), Some(src)) = (name, src) else { continue };
            if !fw_ok(fw) || out.iter().any(|o| o["fw"] == fw) {
                continue;
            }
            out.push(json!({ "fw": fw, "name": name, "source": src, "plugin": { "id": id, "name": p["name"].as_str().unwrap_or(id) } }));
        }
    }
    out
}

/// The type a board's `fw` names, if Studio has a list for it.
pub fn type_for<'a>(types: &'a [Value], fw: &str) -> Option<&'a Value> {
    types.iter().find(|t| t["fw"] == fw)
}

/// Only the images of `t`'s own type from its list, each marked with the list's `version` and its `source` (two
/// lists have two versions: the stock firmware and a plugin's are numbered on their own).
pub fn own_images(t: &Value, manifest: &Value) -> Vec<Value> {
    manifest["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["fw"] == t["fw"])
        .map(|i| {
            let mut i = i.clone();
            i["version"] = manifest["version"].clone();
            // the generic release that comes with Studio is read from its own folder
            i["source"] = match manifest[BUNDLED_KEY].as_str() { Some(dir) => json!(dir), None => t["source"].clone() };
            i
        })
        .collect()
}

/// A manifest of `t`'s own images only (the shape `fleet::image_for` reads).
pub fn own_manifest(t: &Value, manifest: &Value) -> Value {
    let mut m = manifest.clone();
    m["images"] = json!(own_images(t, manifest));
    m
}

/// Every type's list merged: `{types: [{fw, name, plugin, version | error}], images: [...]}`, each image with its
/// own list's `version` and `source`. One list that cannot be read (offline, nothing published, a missing
/// folder) is reported on its type and never hides the others.
pub fn merge(lists: &[(Value, Result<Value, String>)]) -> Value {
    let mut types = vec![];
    let mut images = vec![];
    for (t, m) in lists {
        let mut row = json!({ "fw": t["fw"], "name": t["name"], "plugin": t["plugin"] });
        match m {
            Ok(m) => {
                row["version"] = m["version"].clone();
                row["bundled"] = json!(m[BUNDLED_KEY].is_string());
                row["prerelease"] = json!(m["prerelease"] == true);
                images.extend(own_images(t, m));
            }
            Err(e) => row["error"] = json!(e),
        }
        types.push(row);
    }
    json!({ "types": types, "images": images })
}

/// Where a list that comes with Studio says its folder (set only by [`manifest_of`]; removed from any other list).
pub const BUNDLED_KEY: &str = "studio_bundled_source";
/// The manifest file of a release folder.
pub const MANIFEST_FILE: &str = "proptroller-firmware.json";

/// The generic release that comes with Studio (images built from the firmware it was made with, so the stock
/// firmware and the Proptroller board are there offline and before any release is published):
/// `SPECTER_BUNDLED_FIRMWARE`, which the desktop app sets to its resources (a development build to
/// `src-tauri/bundled-firmware`, scripts/bundle-firmware.py) and the UI tests to a fixture.
pub fn bundled_dir() -> Option<String> {
    let dir = std::path::PathBuf::from(std::env::var("SPECTER_BUNDLED_FIRMWARE").ok().filter(|d| !d.is_empty())?);
    dir.join(MANIFEST_FILE).is_file().then(|| dir.to_string_lossy().into_owned())
}

/// The stock list to use: the downloaded one when it can be read and is not older than the one that comes with
/// Studio, else the one that comes with Studio (marked with [`BUNDLED_KEY`]). Pure: the two lists as read.
pub fn prefer(remote: Result<Value, String>, bundled: Option<(String, Result<Value, String>)>) -> Result<Value, String> {
    let remote = remote.map(|mut m| {
        if let Some(o) = m.as_object_mut() {
            o.remove(BUNDLED_KEY);
        }
        m
    });
    let Some((dir, Ok(mut b))) = bundled else { return remote };
    if let Ok(r) = &remote {
        if !fleet::newer(b["version"].as_str().unwrap_or(""), r["version"].as_str().unwrap_or("")) {
            return remote;
        }
    }
    b[BUNDLED_KEY] = json!(dir);
    Ok(b)
}

/// A type's list: `t["betas"]` (set from the request by the device layer) allows pre-releases. The stock type
/// also has the release that comes with Studio ([`prefer`]).
pub async fn manifest_of(t: &Value) -> Result<Value, String> {
    let remote = fleet::manifest_with(t["source"].as_str().unwrap_or(""), t["betas"] == true).await;
    if t["fw"] != GENERIC {
        return remote;
    }
    let bundled = match bundled_dir() {
        Some(dir) => {
            let m = fleet::manifest(&dir).await;
            Some((dir, m))
        }
        None => None,
    };
    prefer(remote, bundled)
}

/// Every type's list, fetched one after another (the GitHub ones are cached by `fleet::manifest`).
pub async fn catalog(types: &[Value]) -> Value {
    let mut lists = vec![];
    for t in types {
        lists.push((t.clone(), manifest_of(t).await));
    }
    merge(&lists)
}

/// The type an update installs: `want` (the person's choice) or the board's own. `Ok(true)` for a switch of type,
/// which needs `confirmed`; never a silent one.
pub fn pick(board_fw: &str, want: Option<&str>, confirmed: bool) -> Result<(String, bool), String> {
    let target = want.filter(|w| !w.is_empty()).unwrap_or(board_fw).to_string();
    let switch = target != board_fw;
    if switch && !confirmed {
        return Err(switch_refusal(board_fw, &target));
    }
    Ok((target, switch))
}

/// The first-flash (USB) image of type `fw` for a board package `board` and chip `mcu` from a list.
pub fn first_flash_for<'a>(manifest: &'a Value, fw: &str, board: &str, mcu: &str) -> Option<&'a Value> {
    manifest["images"].as_array()?.iter().find(|i| i["first_flash"] == true && i["fw"] == fw && fleet::board_of(i) == board && i["mcu"] == mcu)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(id: &str, dir: &str, firmware: Value) -> Value {
        json!({ "id": id, "name": format!("{id} plugin"), "dir": dir, "firmware": firmware })
    }

    #[test]
    fn stock_type_first_and_a_plugin_adds_one() {
        let ps = vec![plugin("lamps", "/p/lamps", json!([{ "fw": "lamp", "name": "Demo lamp", "source": "releases" }]))];
        // not allowed yet: only the stock firmware
        assert_eq!(types("", &ps, &[]).len(), 1);
        let t = types("/my/release", &ps, &["lamps".into()]);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0]["fw"], "generic");
        assert_eq!(t[0]["name"], GENERIC_NAME);
        assert_eq!(t[0]["source"], "/my/release");
        assert_eq!(t[1]["fw"], "lamp");
        assert_eq!(t[1]["name"], "Demo lamp");
        assert_eq!(t[1]["source"], Path::new("/p/lamps").join("releases").to_string_lossy().as_ref());
        assert_eq!(t[1]["plugin"]["id"], "lamps");
    }

    #[test]
    fn a_plugin_cannot_replace_a_type_or_leave_its_folder() {
        let ps = vec![
            plugin("a", "/p/a", json!([
                { "fw": "generic", "name": "Not the stock one", "source": "x" },
                { "fw": "lamp", "name": "Lamp", "source": "../elsewhere" },
                { "fw": "lamp", "name": "Lamp", "source": "/etc" },
                { "fw": "Bad Name", "name": "Bad", "source": "x" },
                { "fw": "fog", "name": "", "source": "x" },
                { "fw": "fog", "name": "Fog", "source": "https://example.com/fog/proptroller-firmware.json" },
            ])),
            plugin("b", "/p/b", json!([{ "fw": "fog", "name": "Another fog", "source": "x" }])),
        ];
        let t = types("", &ps, &["a".into(), "b".into()]);
        let fws: Vec<&str> = t.iter().map(|x| x["fw"].as_str().unwrap()).collect();
        assert_eq!(fws, ["generic", "fog"]);
        assert_eq!(t[1]["name"], "Fog");
        assert_eq!(t[1]["source"], "https://example.com/fog/proptroller-firmware.json");
    }

    #[test]
    fn merge_keeps_each_list_to_its_own_type_and_version() {
        let ts = types("", &[plugin("lamps", "/p", json!([{ "fw": "lamp", "name": "Demo lamp", "source": "r" }]))], &["lamps".into()]);
        let stock = json!({ "version": "0.1.0", "images": [
            { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "g.bin", "sha256": "aa" }] });
        // the plugin's list also carries a "generic" image: ignored, a plugin never replaces the stock firmware
        let lamp = json!({ "version": "4.0.0", "images": [
            { "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "file": "l.bin", "sha256": "bb" },
            { "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "file": "l-first.bin", "sha256": "cc", "first_flash": true },
            { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "evil.bin", "sha256": "dd" }] });
        let m = merge(&[(ts[0].clone(), Ok(stock)), (ts[1].clone(), Ok(lamp))]);
        let imgs = m["images"].as_array().unwrap();
        assert_eq!(imgs.len(), 3);
        assert!(!imgs.iter().any(|i| i["file"] == "evil.bin"));
        let g = imgs.iter().find(|i| i["fw"] == "generic").unwrap();
        assert_eq!((g["version"].as_str(), g["source"].as_str()), (Some("0.1.0"), Some("")));
        let l = imgs.iter().find(|i| i["file"] == "l.bin").unwrap();
        assert_eq!((l["version"].as_str(), l["source"].as_str()), (Some("4.0.0"), Some("/p/r")));
        assert_eq!(m["types"][1]["version"], "4.0.0");
    }

    #[test]
    fn one_unreadable_list_does_not_hide_the_others() {
        let ts = types("", &[plugin("lamps", "/p", json!([{ "fw": "lamp", "name": "Demo lamp", "source": "r" }]))], &["lamps".into()]);
        let stock = json!({ "version": "0.1.0", "images": [{ "fw": "generic", "impl": "cpp", "mcu": "sim", "file": "g", "sha256": "aa" }] });
        let m = merge(&[(ts[0].clone(), Ok(stock)), (ts[1].clone(), Err("there is no proptroller-firmware.json in /p/r".into()))]);
        assert_eq!(m["images"].as_array().unwrap().len(), 1);
        assert_eq!(m["types"][0]["version"], "0.1.0");
        assert!(m["types"][1]["error"].as_str().unwrap().contains("/p/r"));
        assert_eq!(m["types"][1]["name"], "Demo lamp");
    }

    #[test]
    fn the_release_that_comes_with_studio_is_used_when_nothing_newer_is_downloaded() {
        let b = json!({ "version": "0.2.0", "images": [{ "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "first.bin", "sha256": "aa", "first_flash": true }] });
        let bundled = || Some(("/app/bundled-firmware".to_string(), Ok(b.clone())));
        // no release published, or offline: the bundled one, from its folder
        let m = prefer(Err(fleet::NO_RELEASE.into()), bundled()).unwrap();
        assert_eq!(m[BUNDLED_KEY], "/app/bundled-firmware");
        let t = &types("", &[], &[])[0];
        let imgs = own_images(t, &m);
        assert_eq!(imgs[0]["source"], "/app/bundled-firmware");
        assert_eq!(first_flash_for(&own_manifest(t, &m), GENERIC, "proptroller", "esp32-devkit").unwrap()["file"], "first.bin");
        let c = merge(&[(t.clone(), Ok(m))]);
        assert_eq!(c["types"][0]["bundled"], true);
        // an older download: still the bundled one; the same or newer: the download
        assert_eq!(prefer(Ok(json!({ "version": "0.1.9", "images": [] })), bundled()).unwrap()["version"], "0.2.0");
        let r = prefer(Ok(json!({ "version": "0.2.0", "images": [], BUNDLED_KEY: "/etc" })), bundled()).unwrap();
        assert!(r.get(BUNDLED_KEY).is_none(), "a downloaded list cannot name a folder");
        assert_eq!(prefer(Ok(json!({ "version": "0.3.0-rc.1", "images": [] })), bundled()).unwrap()["version"], "0.3.0-rc.1");
        // nothing comes with this Studio: the download as it is
        assert!(prefer(Err("offline".into()), None).is_err());
        assert!(prefer(Err("offline".into()), Some(("/x".into(), Err("unreadable".into())))).is_err());
        assert_eq!(own_images(t, &json!({ "version": "1", "images": [{ "fw": "generic" }] }))[0]["source"], "");
    }

    #[test]
    fn updates_follow_the_board_and_a_switch_needs_a_confirmation() {
        // no choice: the board's own type
        assert_eq!(pick("lamp", None, false).unwrap(), ("lamp".into(), false));
        assert_eq!(pick("generic", Some(""), false).unwrap(), ("generic".into(), false));
        assert_eq!(pick("generic", Some("generic"), false).unwrap(), ("generic".into(), false));
        // another type: refused unless confirmed
        let e = pick("generic", Some("lamp"), false).unwrap_err();
        assert_eq!(e, switch_refusal("generic", "lamp"));
        assert!(e.contains("confirm"));
        assert_eq!(pick("generic", Some("lamp"), true).unwrap(), ("lamp".into(), true));
    }

    #[test]
    fn the_update_image_comes_from_the_boards_own_list() {
        let ts = types("", &[plugin("lamps", "/p", json!([{ "fw": "lamp", "name": "Demo lamp", "source": "r" }]))], &["lamps".into()]);
        let lamp = json!({ "version": "4.0.0", "images": [
            { "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "file": "l-first.bin", "sha256": "cc", "first_flash": true },
            { "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "file": "l.bin", "sha256": "bb" },
            { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "evil.bin", "sha256": "dd" }] });
        let board = json!({ "fw": "lamp", "fw_impl": "cpp", "mcu": "esp32-devkit", "fw_version": "3.0.0" });
        let t = type_for(&ts, "lamp").unwrap();
        let own = own_manifest(t, &lamp);
        assert_eq!(fleet::image_for(&own, &board).unwrap()["file"], "l.bin");
        // a stock board finds nothing in the plugin's list (its "generic" image is not the plugin's to give)
        let stock_board = json!({ "fw": "generic", "fw_impl": "cpp", "mcu": "esp32-devkit" });
        assert!(fleet::image_for(&own, &stock_board).is_none());
        assert_eq!(first_flash_for(&own, "lamp", "proptroller", "esp32-devkit").unwrap()["file"], "l-first.bin");
        assert!(first_flash_for(&own, "lamp", "proptroller", "pico-w").is_none());
        assert!(first_flash_for(&own, "lamp", "other-board", "esp32-devkit").is_none());
        assert!(type_for(&ts, "my-own-sketch").is_none());
    }

    #[test]
    fn images_key_on_type_board_package_and_chip() {
        // two builds of one type for the same chip, on two board packages
        let m = json!({ "version": "4.0.0", "images": [
            { "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "board": "proptroller", "file": "p.bin", "sha256": "aa" },
            { "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "board": "lamp-board", "file": "b.bin", "sha256": "bb" },
            { "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "board": "lamp-board", "file": "b-first.bin", "sha256": "cc", "first_flash": true }] });
        let on = |board: Option<&str>| {
            let mut i = json!({ "fw": "lamp", "fw_impl": "cpp", "mcu": "esp32-devkit" });
            if let Some(b) = board { i["board"] = json!(b); }
            fleet::image_for(&m, &i).map(|x| x["file"].as_str().unwrap().to_string())
        };
        assert_eq!(on(Some("lamp-board")).as_deref(), Some("b.bin"));
        assert_eq!(on(Some("proptroller")).as_deref(), Some("p.bin"));
        // a board from before the field counts as the Proptroller board
        assert_eq!(on(None).as_deref(), Some("p.bin"));
        assert_eq!(on(Some("unknown-board")), None);
        // an entry without `board` is for the Proptroller board
        let old = json!({ "version": "1", "images": [{ "fw": "lamp", "impl": "cpp", "mcu": "esp32-devkit", "file": "o.bin", "sha256": "dd" }] });
        assert!(fleet::image_for(&old, &json!({ "fw": "lamp", "fw_impl": "cpp", "mcu": "esp32-devkit", "board": "proptroller" })).is_some());
        assert!(fleet::image_for(&old, &json!({ "fw": "lamp", "fw_impl": "cpp", "mcu": "esp32-devkit", "board": "lamp-board" })).is_none());
        assert_eq!(first_flash_for(&m, "lamp", "lamp-board", "esp32-devkit").unwrap()["file"], "b-first.bin");
        assert!(first_flash_for(&m, "lamp", "proptroller", "esp32-devkit").is_none());
    }
}
