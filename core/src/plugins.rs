//! Plugins: specialised clients that live outside Specter Studio. A plugin is a folder with `plugin.json`
//! (`{"id","name","description","entry":"index.html"}`, optionally `"firmware"`: the firmware types it adds,
//! `fwtypes.rs`; `"board_packages"`, `"profiles"`, `"scripts"`: files it offers for boards, `boardpkg.rs`;
//! `"icon"`, `"icons"`: its own icon and effect icons, [`icons`]) and its
//! web files; Studio shows the entry page in a
//! sandboxed frame and talks to it only through a narrow postMessage API (see docs/PLUGINS.md).

use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

/// Every plugin found in the given folders (each folder is a plugin, or holds plugins one level down).
pub fn list(dirs: &[PathBuf]) -> Vec<Value> {
    let mut out = vec![];
    for d in dirs {
        let mut cands = vec![d.clone()];
        // a folder that is itself a plugin is only that plugin (an extension added from git loads the folder that
        // was chosen, never other plugins inside it)
        if let (false, Ok(rd)) = (d.join("plugin.json").is_file(), std::fs::read_dir(d)) {
            cands.extend(rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
        }
        for c in cands {
            let Ok(s) = std::fs::read_to_string(c.join("plugin.json")) else { continue };
            let Ok(mut v) = serde_json::from_str::<Value>(&s) else { continue };
            if !v["id"].is_string() {
                continue;
            }
            // a page of its own (a tab), a device adapter (a hidden page), or both; a plugin that only offers
            // firmware types (`firmware`, docs/DESIGN.md "Firmware types") or board packages, profiles and scripts
            // (`board_packages`, `profiles`, `scripts`, boardpkg.rs) needs neither
            let only_firmware = ["firmware", "board_packages", "profiles", "scripts"].iter().any(|k| v[*k].as_array().is_some_and(|f| !f.is_empty()));
            if !v["entry"].is_string() && !v["adapter"].is_string() && !only_firmware {
                v["entry"] = json!("index.html");
            }
            v["dir"] = json!(c.to_string_lossy());
            if !out.iter().any(|o: &Value| o["id"] == v["id"]) {
                out.push(v);
            }
        }
    }
    out
}

/// The largest SVG icon file read from an extension (src/props/svg.ts keeps to the same).
pub const MAX_ICON_BYTES: usize = 32 * 1024;
/// At most this many effect icons per extension.
pub const MAX_ICONS: usize = 64;

/// An extension's SVG file: inside its folder (`boardpkg::rel_file`), ending in `.svg`, at most
/// [`MAX_ICON_BYTES`], and an `<svg` element in it. Studio sanitizes it before drawing it (svg.ts).
fn svg_file(dir: &str, rel: &str) -> Option<String> {
    if !rel.to_ascii_lowercase().ends_with(".svg") {
        return None;
    }
    let p = crate::boardpkg::rel_file(dir, rel)?;
    if std::fs::metadata(&p).ok()?.len() as usize > MAX_ICON_BYTES {
        return None;
    }
    let s = std::fs::read_to_string(p).ok()?;
    s.contains("<svg").then_some(s)
}

/// The icons of every extension: its own (`"icon": "icon.svg"`, shown on its tab and in the extension lists)
/// and the effect icons it adds (`"icons": [{"name": "lantern", "file": "icons/lantern.svg"}]`, names a script
/// can use in `# icon: lantern`), as SVG text. A file that is missing, outside the folder, not SVG or too big is
/// left out; names are lower-case letters, digits, `-` and `_`, at most 32.
pub fn icons(dirs: &[PathBuf]) -> Vec<Value> {
    list(dirs)
        .into_iter()
        .map(|p| {
            let dir = p["dir"].as_str().unwrap_or("").to_string();
            let icon = p["icon"].as_str().and_then(|f| svg_file(&dir, f));
            let mut seen = std::collections::HashSet::new();
            let list: Vec<Value> = p["icons"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|i| {
                    let name = i["name"].as_str()?.trim().to_ascii_lowercase();
                    let ok = !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
                    if !ok || !seen.insert(name.clone()) {
                        return None;
                    }
                    let svg = svg_file(&dir, i["file"].as_str()?)?;
                    Some(json!({ "name": name, "label": i["label"].as_str().map(|s| s.chars().take(40).collect::<String>()), "svg": svg }))
                })
                .take(MAX_ICONS)
                .collect();
            json!({ "id": p["id"], "name": p["name"], "icon": icon, "icons": list })
        })
        .collect()
}

/// The plugin folders of the browser development bridge: the repo's example plugins (`plugins/`) only when
/// `SPECTER_STUDIO_EXAMPLE_PLUGINS` is `1` (so a first run in the browser looks like the desktop app: no
/// example tab, no consent dialog), then every folder in `SPECTER_STUDIO_PLUGINS`.
pub fn bridge_dirs(examples: Option<&std::ffi::OsStr>, extra: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if examples.is_some_and(|v| v == "1") {
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"));
    }
    if let Some(extra) = extra {
        dirs.extend(std::env::split_paths(extra));
    }
    dirs
}

/// The wiring guides (offline pages from the firmware's `docs/wiring-guides/html`): `SPECTER_GUIDES_DIR`,
/// else the firmware submodule (development).
pub fn guides_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SPECTER_GUIDES_DIR") {
        let p = PathBuf::from(p);
        return p.join("index.html").is_file().then_some(p);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../firmware/docs/wiring-guides/html");
    // a guides folder without its index (a bundle built without the guides) counts as not installed
    dev.join("index.html").is_file().then_some(dev)
}

/// The Content Security Policy of every plugin and wiring-guide response, from both servers (the desktop app's
/// `plugin://` scheme and the development bridge). The frame's sandbox takes away its origin, not the network:
/// without this a plugin with no permissions could post to any listener, open a board's WebSocket directly or
/// load an image beacon. Its own files and inline code only; no fetch, WebSocket, EventSource or beacon
/// (`connect-src 'none'`), no frames, workers, forms or `<base>`. `plugin:` and `http://plugin.localhost` are
/// named as well as `'self'` because WebKit does not always match `'self'` to a custom scheme. WebAssembly may
/// compile (`'wasm-unsafe-eval'`: the wiring guides' 3D views; it is not JavaScript eval and has no network). WebRTC is not
/// covered by CSP: see docs/DESIGN.md "Plugins" for what blocks it per platform.
pub const PLUGIN_CSP: &str = "default-src 'self' plugin: http://plugin.localhost; \
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' plugin: http://plugin.localhost; \
style-src 'self' 'unsafe-inline' plugin: http://plugin.localhost; \
img-src 'self' data: blob: plugin: http://plugin.localhost; \
media-src 'self' plugin: http://plugin.localhost; \
font-src 'self' data: plugin: http://plugin.localhost; \
connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; \
manifest-src 'none'; form-action 'none'; base-uri 'none'";

/// What a plugin page may not use even when the CSP would not stop it: WebRTC (a peer connection reaches any
/// address and CSP does not cover it). Put first in every HTML page served to a plugin frame, before the
/// plugin's own scripts, so the constructors are gone before its code runs. A belt for the WebView settings
/// (docs/DESIGN.md "Plugins"), not a guarantee on its own.
pub const PLUGIN_PRELUDE: &str = "<script>(()=>{for(const k of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCRtpSender','RTCRtpReceiver','RTCSessionDescription','RTCIceCandidate']){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}}try{Object.defineProperty(navigator,'mediaDevices',{value:undefined,configurable:false})}catch(e){}})()</script>";

/// The headers every plugin or guide response carries: the CSP and no content sniffing.
pub fn plugin_headers() -> [(&'static str, &'static str); 3] {
    [("Content-Security-Policy", PLUGIN_CSP), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer")]
}

/// A plugin page's HTML with [`PLUGIN_PRELUDE`] right after `<head>` (else after the doctype, else first), so it
/// runs before any script of the page and the page keeps its standards mode (guides are left as they are).
fn with_prelude(bytes: Vec<u8>) -> Vec<u8> {
    let lower = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
    let after = |tag: &str| lower.find(tag).and_then(|i| lower[i..].find('>').map(|j| i + j + 1));
    let at = after("<head").or_else(|| after("<!doctype")).unwrap_or(0);
    // `lower` has the same byte offsets as `bytes` only when the text is valid UTF-8; else put it first
    let at = if std::str::from_utf8(&bytes).is_ok() { at } else { 0 };
    let mut out = bytes[..at].to_vec();
    out.extend(PLUGIN_PRELUDE.as_bytes());
    out.extend(&bytes[at..]);
    out
}

/// A file of a plugin (or of the wiring guides, id `wiring-guides`), by id and relative path; nothing outside
/// that folder.
pub fn file(dirs: &[PathBuf], id: &str, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    let root = if id == "wiring-guides" {
        guides_dir()?
    } else {
        PathBuf::from(list(dirs).into_iter().find(|p| p["id"] == id)?["dir"].as_str()?)
    };
    let rel = Path::new(rel.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let path = root.join(rel);
    let bytes = std::fs::read(&path).ok()?;
    let m = mime(&path);
    let bytes = if id != "wiring-guides" && m.starts_with("text/html") { with_prelude(bytes) } else { bytes };
    Some((bytes, m))
}

pub fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// `%20` and friends in a URL path, decoded.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn plugin_pages_get_a_csp_without_network_and_lose_webrtc() {
        assert!(PLUGIN_CSP.contains("connect-src 'none'"));
        assert!(PLUGIN_CSP.contains("frame-src 'none'"));
        assert!(PLUGIN_CSP.contains("form-action 'none'"));
        assert!(!PLUGIN_CSP.contains('*'));
        let d = std::env::temp_dir().join(format!("specter-plugin-csp-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("plugin.json"), r#"{"id":"p","entry":"index.html"}"#).unwrap();
        std::fs::write(d.join("index.html"), "<!doctype html><html><head><script src=a.js></script>").unwrap();
        std::fs::write(d.join("a.js"), "x()").unwrap();
        let (html, _) = file(&[d.clone()], "p", "index.html").unwrap();
        let html = String::from_utf8(html).unwrap();
        assert!(html.starts_with("<!doctype html><html><head><script>(()=>"), "{html}");
        assert!(html.find("RTCPeerConnection").unwrap() < html.find("a.js").unwrap());
        assert_eq!(file(&[d.clone()], "p", "a.js").unwrap().0, b"x()");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_plugin_that_only_offers_firmware_has_no_page() {
        let d = std::env::temp_dir().join(format!("specter-plugin-fw-{}", std::process::id()));
        std::fs::create_dir_all(d.join("fw")).unwrap();
        std::fs::create_dir_all(d.join("tab")).unwrap();
        std::fs::write(d.join("fw/plugin.json"), r#"{"id":"fw","firmware":[{"fw":"lamp","name":"Demo lamp","source":"r"}]}"#).unwrap();
        std::fs::write(d.join("tab/plugin.json"), r#"{"id":"tab"}"#).unwrap();
        let l = list(&[d.clone()]);
        let fw = l.iter().find(|p| p["id"] == "fw").unwrap();
        assert!(fw["entry"].is_null(), "{fw}");
        assert_eq!(fw["firmware"][0]["fw"], "lamp");
        assert_eq!(l.iter().find(|p| p["id"] == "tab").unwrap()["entry"], "index.html");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn extension_icons_are_svg_files_inside_its_folder() {
        let d = std::env::temp_dir().join(format!("specter-plugin-icons-{}", std::process::id()));
        std::fs::create_dir_all(d.join("p/icons")).unwrap();
        std::fs::write(d.join("p/plugin.json"), r#"{"id":"p","name":"P","icon":"logo.svg","icons":[
            {"name":"Lantern","file":"icons/lantern.svg"},{"name":"lantern","file":"icons/lantern.svg"},
            {"name":"bad name","file":"icons/lantern.svg"},{"name":"up","file":"../x.svg"},{"name":"png","file":"icons/a.png"},
            {"name":"big","file":"icons/big.svg"},{"name":"gone","file":"icons/gone.svg"}]}"#).unwrap();
        std::fs::write(d.join("p/logo.svg"), "<svg viewBox='0 0 24 24'><path d='M0 0h24v24z'/></svg>").unwrap();
        std::fs::write(d.join("p/icons/lantern.svg"), "<svg><circle cx='12' cy='12' r='5'/></svg>").unwrap();
        std::fs::write(d.join("p/icons/a.png"), "<svg></svg>").unwrap();
        std::fs::write(d.join("p/icons/big.svg"), format!("<svg>{}</svg>", " ".repeat(MAX_ICON_BYTES))).unwrap();
        std::fs::write(d.join("x.svg"), "<svg></svg>").unwrap();
        let l = icons(&[d.clone()]);
        assert_eq!(l.len(), 1);
        assert!(l[0]["icon"].as_str().unwrap().contains("<path"));
        let names: Vec<&str> = l[0]["icons"].as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["lantern"]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn bridge_loads_example_plugins_only_when_asked() {
        assert!(bridge_dirs(None, None).is_empty());
        assert!(bridge_dirs(Some(OsStr::new("0")), None).is_empty());
        let with = bridge_dirs(Some(OsStr::new("1")), None);
        assert_eq!(with.len(), 1);
        assert!(with[0].ends_with("plugins"));
        assert_eq!(bridge_dirs(None, Some(OsStr::new("/tmp/x"))), vec![PathBuf::from("/tmp/x")]);
    }
}
