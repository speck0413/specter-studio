//! The user's workspace ("My Props"): one plain folder with `effects/` (one effect script per file,
//! `<name>.txt`), `firmware/` (the user's own firmware, see `projects.rs`), a generated
//! `platformio.ini` (one environment per firmware project and board) and a hidden `.specter/` folder with an
//! index (content hash -> name and save time) and a copy of every saved version, so a board's script can be recognised (and told apart from an older version) on any
//! computer that has the folder: no database, nothing but files to copy to a USB stick or a sync folder.
//!
//! A script Studio sends carries one comment line at the top (the board ignores comments):
//! `# Specter Studio: lamp and fog - lab room 1, saved 2026-10-21 21:04`. The board's text alone then says
//! which script it is and which version; scripts sent by other means are recognised by their hash.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const EXT: &str = "txt";

/// Effect scripts: `<workspace>/effects/<name>.txt` (`.specter` is read too).
pub fn effects_dir(ws: &Path) -> PathBuf {
    ws.join("effects")
}
const HEADER: &str = "# Specter Studio: ";

pub(crate) fn index_dir(lib: &Path) -> PathBuf {
    lib.join(".specter")
}

/// Script sources: `<workspace>/sources/<source>/`, each a git clone (gitsync.rs). Their scripts are named
/// `<source>/<name>` everywhere (a plain name can never hold a `/`).
pub fn sources_dir(lib: &Path) -> PathBuf {
    lib.join("sources")
}

/// A source's scripts: its `effects/` folder, or its top folder when it keeps `.txt` scripts there instead.
pub fn source_scripts_dir(src: &Path) -> PathBuf {
    let e = src.join("effects");
    let top_has_scripts = std::fs::read_dir(src).into_iter().flatten().flatten().any(|f| f.path().extension().is_some_and(|x| x == EXT) && f.path().is_file());
    if !e.is_dir() && top_has_scripts { src.to_path_buf() } else { e }
}

/// The script sources in the library (folders under `sources/` that are git clones), by name.
pub fn source_names(lib: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(sources_dir(lib))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && e.path().join(".git").exists())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort_by_key(|n| n.to_lowercase());
    v
}

/// Where an effect lives: a plain name in `<workspace>/effects/`, `source/name` in that script source.
pub struct Place {
    /// the folder holding the script file
    pub dir: PathBuf,
    pub stem: String,
    /// the full name (`source/name` for a source's script)
    pub name: String,
    /// `.specter/history/<name>` (this computer's copies of every saved version)
    pub hist: PathBuf,
    /// the source's folder, for a source's script
    pub source: Option<PathBuf>,
}

pub fn locate(lib: &Path, name: &str) -> Result<Place, String> {
    let hist = index_dir(lib).join("history");
    match name.split_once('/') {
        None => {
            let stem = file_stem(name)?;
            Ok(Place { dir: effects_dir(lib), hist: hist.join(&stem), name: stem.clone(), stem, source: None })
        }
        Some((src, n)) => {
            let (src, stem) = (file_stem(src)?, file_stem(n)?);
            let sd = sources_dir(lib).join(&src);
            if std::fs::symlink_metadata(&sd).map(|m| m.file_type().is_symlink()).unwrap_or(true) || !sd.join(".git").exists() {
                return Err(format!("there is no script source called \"{src}\" in your library"));
            }
            Ok(Place { dir: source_scripts_dir(&sd), hist: hist.join(&src).join(&stem), name: format!("{src}/{stem}"), stem, source: Some(sd) })
        }
    }
}

impl Place {
    /// Refuses a change in a source Studio cannot push to.
    pub fn writable(&self) -> Result<(), String> {
        match &self.source {
            Some(sd) if crate::gitsync::is_read_only(sd) => Err(format!(
                "\"{}\" is in a read-only script source (Studio cannot back up to it). Use Save a copy to… to put it into one of your own sources.",
                self.name
            )),
            _ => Ok(()),
        }
    }
    fn file(&self) -> Option<PathBuf> {
        [EXT, "specter"].iter().map(|e| self.dir.join(format!("{}.{e}", self.stem))).find(|p| p.exists())
    }
}

/// The text without Studio's header line, line endings as written.
pub fn body(text: &str) -> &str {
    if text.starts_with(HEADER) {
        match text.find('\n') {
            Some(i) => &text[i + 1..],
            None => "",
        }
    } else {
        text
    }
}

/// `(name, saved)` from Studio's header line.
pub fn header(text: &str) -> Option<(String, String)> {
    let first = text.strip_prefix(HEADER)?.lines().next()?.trim_end();
    let (name, saved) = first.rsplit_once(", saved ")?;
    Some((name.to_string(), saved.to_string()))
}

pub fn with_header(name: &str, saved: &str, text: &str) -> String {
    format!("{HEADER}{name}, saved {saved}\n{}", body(text))
}

/// The hash a script is known by: its body, with line endings and trailing spaces evened out.
pub fn hash(text: &str) -> String {
    let norm: String = body(text).replace("\r\n", "\n").replace('\r', "\n").lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
    hex::encode(&Sha256::digest(norm.trim_end().as_bytes())[..12])
}

/// A file name for a script name: only characters every file system takes.
pub(crate) fn file_stem(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("give the effect a name".into());
    }
    if n.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r') || c.is_control()) || n.starts_with('.') {
        return Err("a name cannot hold / \\ : * ? \" < > | or start with a dot".into());
    }
    let base = n.split('.').next().unwrap_or("").trim().to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str()) || (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && base.as_bytes()[3].is_ascii_digit()) {
        return Err(format!("\"{n}\" is a name Windows keeps for itself: pick another"));
    }
    if n.contains(", saved ") {
        return Err("a name cannot hold \", saved \"".into());
    }
    Ok(n.to_string())
}

/// Writes a file whole or not at all: a temporary file beside it, then a rename (a crash or a full disk mid-write
/// never leaves half a script or half an index).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_file_name(format!(".{}.tmp-{}-{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("file"), std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let r = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// The index; when `index.json` is there but cannot be read (cut short, damaged), it is made again from the
/// saved versions in `.specter/history/`, so what Studio knew about boards' scripts is never lost.
fn read_index(lib: &Path) -> Map<String, Value> {
    let f = index_dir(lib).join("index.json");
    match std::fs::read_to_string(&f) {
        Err(_) => Map::new(),
        Ok(s) => match serde_json::from_str::<Value>(&s).ok().and_then(|v| v.as_object().cloned()) {
            Some(m) => m,
            None => rebuild_index(lib),
        },
    }
}

/// Every version in `.specter/history/<name>/<saved>.txt`, by hash: name and save time (from the file name).
fn rebuild_index(lib: &Path) -> Map<String, Value> {
    let mut idx = Map::new();
    let mut versions: Vec<(String, String, String)> = vec![]; // (saved, name, hash)
    // history/<name>/<saved>.txt, and a source's scripts one level down: history/<source>/<name>/<saved>.txt
    fn walk(dir: &Path, name: &str, depth: u8, versions: &mut Vec<(String, String, String)>) {
        for f in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if f.path().is_dir() {
                if depth == 0 {
                    walk(&f.path(), &format!("{name}/{}", f.file_name().to_string_lossy()), 1, versions);
                }
                continue;
            }
            let Ok(text) = std::fs::read_to_string(f.path()) else { continue };
            let stem = f.path().file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            versions.push((saved_from_stem(&stem), name.to_string(), hash(&text)));
        }
    }
    for d in std::fs::read_dir(index_dir(lib).join("history")).into_iter().flatten().flatten() {
        walk(&d.path(), &d.file_name().to_string_lossy(), 0, &mut versions);
    }
    versions.sort(); // oldest first: the newest save of a text wins
    for (saved, name, h) in versions {
        idx.insert(h, json!({ "name": name, "saved": saved }));
    }
    idx
}

/// "2026-10-21-21-04" or "2026-10-21-21-04-37-2" (a history file's name) -> "2026-10-21 21:04".
fn saved_from_stem(stem: &str) -> String {
    let p: Vec<&str> = stem.split('-').collect();
    if p.len() >= 5 { format!("{}-{}-{} {}:{}", p[0], p[1], p[2], p[3], p[4]) } else { stem.to_string() }
}

/// A save time as given by the caller, made safe for a file name: digits and dashes only, at most 32.
fn safe_now(now: &str) -> String {
    let t: String = now.chars().map(|c| if c.is_ascii_digit() { c } else { '-' }).take(32).collect();
    let t = t.trim_matches('-').to_string();
    if t.is_empty() { "unknown".into() } else { t }
}

fn write_index(lib: &Path, idx: &Map<String, Value>) -> Result<(), String> {
    std::fs::create_dir_all(index_dir(lib)).map_err(|e| e.to_string())?;
    write_atomic(&index_dir(lib).join("index.json"), serde_json::to_string_pretty(idx).unwrap().as_bytes())
}

/// Every script in the library: `{name, file, saved, hash}`, by name. `saved` is the last save Studio
/// recorded (or empty for a file that was copied in by hand).
/// A source's scripts come as `{name: "<source>/<title>", title, source, read_only}`; the library's own have
/// `source: null`.
pub fn list(lib: &Path) -> Vec<Value> {
    let idx = read_index(lib);
    let mut places: Vec<(PathBuf, Option<String>, bool)> = vec![(effects_dir(lib), None, false)];
    for s in source_names(lib) {
        let sd = sources_dir(lib).join(&s);
        places.push((source_scripts_dir(&sd), Some(s), crate::gitsync::is_read_only(&sd)));
    }
    let mut out: Vec<Value> = places
        .iter()
        .flat_map(|(dir, src, ro)| std::fs::read_dir(dir).into_iter().flatten().flatten().map(move |e| (e, src, ro)))
        .filter_map(|(e, src, ro)| {
            let p = e.path();
            let ext = p.extension()?.to_str()?;
            if (ext != EXT && ext != "specter") || !p.is_file() {
                return None;
            }
            let title = p.file_stem()?.to_string_lossy().to_string();
            let name = match src { Some(s) => format!("{s}/{title}"), None => title.clone() };
            let text = std::fs::read_to_string(&p).ok()?;
            let h = hash(&text);
            let saved = idx.get(&h).filter(|v| v["name"] == name.as_str()).and_then(|v| v["saved"].as_str()).unwrap_or("").to_string();
            let (icon, color) = look(&text);
            Some(json!({ "name": name, "title": title, "source": src, "read_only": ro, "file": p.to_string_lossy(), "saved": saved, "hash": h, "icon": icon, "color": color }))
        })
        .collect();
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    out
}

/// A script's icon and colour for the library list, from its comments (src/props/look.ts has the rules and the
/// editor that writes them): `# icon: <name>` / `# color: <name or #hex>` above the first effect and apart from
/// the comments directly on top of it are the script's; without those, the first effect's own (the comments
/// directly above its `effect …:` line). The script's first line of a kind wins, an effect's last. Names as
/// written, lower case; Studio draws an unknown one as `play`.
pub fn look(text: &str) -> (Option<String>, Option<String>) {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let comment = |l: &str| l.trim_start().starts_with('#');
    let is_effect = |l: &str| {
        let body = l.split('#').next().unwrap_or("").trim();
        body.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("effect"))
    };
    let parse = |l: &str| -> Option<(bool, String)> {
        let s = l.trim_start().strip_prefix('#')?.trim_start();
        let (k, v) = s.split_once([':', '='])?;
        let k = k.trim().to_ascii_lowercase();
        let v = v.trim();
        let icon = match k.as_str() { "icon" => true, "color" | "colour" => false, _ => return None };
        let val: String = if icon {
            v.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect::<String>().to_ascii_lowercase()
        } else if let Some(h) = v.strip_prefix('#') {
            let hex: String = h.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
            if hex.len() != 3 && hex.len() != 6 { return None; }
            format!("#{}", hex.to_ascii_lowercase())
        } else {
            v.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_lowercase()
        };
        (!val.is_empty()).then_some((icon, val))
    };
    let first = lines.iter().position(|l| is_effect(l)).unwrap_or(lines.len());
    let mut attached = first;
    while first < lines.len() && attached > 0 && comment(lines[attached - 1]) {
        attached -= 1;
    }
    let (mut icon, mut color) = (None, None);
    for l in &lines[..attached] {
        match parse(l) {
            Some((true, v)) if icon.is_none() => icon = Some(v),
            Some((false, v)) if color.is_none() => color = Some(v),
            _ => {}
        }
    }
    if first < lines.len() {
        let (mut ei, mut ec) = (None, None);
        for l in &lines[attached..first] {
            match parse(l) {
                Some((true, v)) => ei = Some(v),
                Some((false, v)) => ec = Some(v),
                None => {}
            }
        }
        icon = icon.or(ei);
        color = color.or(ec);
    }
    (icon, color)
}

pub fn read(lib: &Path, name: &str) -> Result<String, String> {
    let pl = locate(lib, name)?;
    for ext in [EXT, "specter"] {
        if let Ok(t) = std::fs::read_to_string(pl.dir.join(format!("{}.{ext}", pl.stem))) {
            return Ok(t);
        }
    }
    Err(format!("there is no effect called \"{name}\" in your library"))
}

/// The answer's start when the file was changed outside Studio since it was opened (`save_checked`).
pub const CHANGED_OUTSIDE: &str = "changed outside";

/// As [`save`], but only when the file on disk is still the one the editor opened (`base_hash`, the [`hash`] of
/// what it read; None = no check). Otherwise nothing is written and the error starts with [`CHANGED_OUTSIDE`].
pub fn save_checked(lib: &Path, name: &str, text: &str, now: &str, base_hash: Option<&str>) -> Result<Value, String> {
    if let Some(want) = base_hash {
        if let Ok(on_disk) = read(lib, name) {
            if hash(&on_disk) != want && hash(&on_disk) != hash(text) {
                return Err(format!("{CHANGED_OUTSIDE}: \"{name}\" was changed outside Studio since you opened it (another window, another computer or a sync folder). Nothing was saved."));
            }
        }
    }
    save(lib, name, text, now)
}

/// Saves a script (its body: any header is dropped) under `name`, keeps a copy of this version in
/// `.specter/history/<name>/` and records its hash. `now` is "YYYY-MM-DD HH:MM". Saving the same text again
/// changes nothing; two saves in the same minute keep both versions.
pub fn save(lib: &Path, name: &str, text: &str, now: &str) -> Result<Value, String> {
    let pl = locate(lib, name)?;
    pl.writable()?;
    let stem = pl.name.clone();
    let b = body(text);
    let h = hash(b);
    let mut idx = read_index(lib);
    std::fs::create_dir_all(&pl.dir).map_err(|e| format!("cannot use the folder {}: {e}", pl.dir.display()))?;
    let path = pl.dir.join(format!("{}.{EXT}", pl.stem));
    let txt = pl.dir.join(format!("{}.specter", pl.stem));
    let existing = std::fs::read_to_string(&path).or_else(|_| std::fs::read_to_string(&txt)).ok();
    if existing.as_deref().map(hash) == Some(h.clone()) {
        if let Some(v) = idx.get(&h).filter(|v| v["name"] == stem.as_str()) {
            return Ok(json!({ "name": stem, "saved": v["saved"], "hash": h, "changed": false }));
        }
    }
    write_atomic(&path, b.as_bytes())?;
    if txt.exists() {
        let _ = std::fs::remove_file(&txt); // the .txt file replaces an old .specter one
    }
    let hist = pl.hist.clone();
    std::fs::create_dir_all(&hist).map_err(|e| e.to_string())?;
    let stem_now = format!("{}-{}", safe_now(now), &crate::fleet::stamp()[15..]); // + the seconds
    let mut file = hist.join(format!("{stem_now}.{EXT}"));
    for n in 2.. {
        if !file.exists() {
            break;
        }
        file = hist.join(format!("{stem_now}-{n}.{EXT}"));
    }
    write_atomic(&file, b.as_bytes())?;
    idx.insert(h.clone(), json!({ "name": stem, "saved": now }));
    write_index(lib, &idx)?;
    Ok(json!({ "name": stem, "saved": now, "hash": h, "changed": true }))
}

/// What a board's script is, compared with the library:
/// `none` (no script), `current` (the newest version of `name`), `older` (an older version of `name`; the
/// library has a newer one) or `unknown` (not in the library: offer to save it).
pub fn identify(lib: &Path, board_text: &str) -> Value {
    if board_text.lines().all(|l| l.trim().is_empty() || l.trim_start().starts_with('#')) {
        return json!({ "status": "none" });
    }
    let h = hash(board_text);
    let idx = read_index(lib);
    let named = header(board_text).map(|(n, s)| (n, Some(s))).or_else(|| {
        idx.get(&h).and_then(|v| Some((v["name"].as_str()?.to_string(), v["saved"].as_str().map(String::from))))
    });
    let Some((name, saved)) = named else { return json!({ "status": "unknown", "hash": h }) };
    let Ok(lib_text) = read(lib, &name) else {
        return json!({ "status": "unknown", "name": name, "saved": saved, "hash": h });
    };
    let lib_hash = hash(&lib_text);
    let lib_saved = idx.get(&lib_hash).and_then(|v| v["saved"].as_str()).unwrap_or("").to_string();
    let status = if lib_hash == h {
        "current"
    } else if idx.get(&h).is_some_and(|v| v["name"] == name.as_str()) || saved.as_deref().is_some_and(|s| s < lib_saved.as_str()) {
        "older"
    } else {
        // the board's version of a library name is not one Studio saved: changed on the board or elsewhere
        "changed"
    };
    json!({ "status": status, "name": name, "saved": saved, "library_saved": lib_saved, "hash": h })
}

/// The newest saved version per name, then the board's script header for sending: the text to send.
pub fn for_board(lib: &Path, name: &str) -> Result<String, String> {
    let text = read(lib, name)?;
    let idx = read_index(lib);
    let saved = idx.get(&hash(&text)).and_then(|v| v["saved"].as_str()).unwrap_or("").to_string();
    Ok(if saved.is_empty() { format!("{HEADER}{name}, saved (not recorded)\n{}", body(&text)) } else { with_header(name, &saved, &text) })
}

/// "YYYY-MM-DD HH:MM" in local time is not available without a time-zone library: Studio passes the UI's
/// local time in; this is the UTC fallback.
pub fn now_utc() -> String {
    let s = crate::fleet::stamp();
    format!("{} {}:{}", &s[..10], &s[11..13], &s[13..15])
}

/// Renames an effect (its file, its history and its index entries; boards still running it under the old
/// name show it as not in the library until it is sent again).
pub fn rename(lib: &Path, from: &str, to: &str) -> Result<(), String> {
    let pf = locate(lib, from)?;
    // a new name for a source's script stays in that source
    let to_full = match (&pf.source, to.contains('/')) {
        (Some(_), false) => format!("{}/{}", pf.name.split_once('/').map(|x| x.0).unwrap_or(""), to),
        _ => to.to_string(),
    };
    let pt = locate(lib, &to_full)?;
    if pf.source != pt.source {
        return Err("an effect cannot be renamed into another script source: use Save a copy to…".into());
    }
    pf.writable()?;
    let (f, t) = (pf.name.clone(), pt.name.clone());
    let src = pf.file().ok_or_else(|| format!("there is no effect called \"{from}\""))?;
    let dst = pt.dir.join(format!("{}.{EXT}", pt.stem));
    // a change of case only ("Porch" -> "porch") is the same file on Windows and macOS: it goes through a
    // temporary name instead of being refused as "already there"
    let case_only = f != t && f.to_lowercase() == t.to_lowercase();
    if dst.exists() && !case_only {
        return Err(format!("there is already an effect called \"{to}\""));
    }
    let via = |a: &Path, b: &Path| -> std::io::Result<()> {
        if case_only {
            let tmp = a.with_extension("renaming");
            std::fs::rename(a, &tmp)?;
            std::fs::rename(&tmp, b)
        } else {
            std::fs::rename(a, b)
        }
    };
    via(&src, &dst).map_err(|e| e.to_string())?;
    if pf.hist.exists() {
        let _ = via(&pf.hist, &pt.hist);
    }
    let mut idx = read_index(lib);
    for v in idx.values_mut() {
        if v["name"] == f.as_str() {
            v["name"] = json!(t);
        }
    }
    write_index(lib, &idx)
}

/// Deletes an effect: the file moves to `.specter/trash/` (its history stays), so nothing is lost for good.
pub fn delete(lib: &Path, name: &str) -> Result<(), String> {
    let pl = locate(lib, name)?;
    pl.writable()?;
    let f = pl.stem.clone();
    let src = pl.file().ok_or_else(|| format!("there is no effect called \"{name}\""))?;
    let trash = index_dir(lib).join("trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    std::fs::rename(&src, trash.join(format!("{f}-{}.{EXT}", crate::fleet::stamp()))).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- sounds
//
// A script names a sound by its number: sound N is the card's `mp3/NNNN-<name>.mp3` (the SD card tool fills the
// card in that order). `<workspace>/sounds.csv` is the list the SD card tool keeps with the library (`number,file`,
// one line per sound): only a hint for the editor (`audio_single = 2` · rain), never sent to a board.

/// `{file: number}` from `<workspace>/sounds.csv` (empty when there is none).
pub fn sounds(ws: &Path) -> Map<String, Value> {
    let mut out = Map::new();
    let Ok(text) = std::fs::read_to_string(ws.join("sounds.csv")) else { return out };
    for line in text.lines().skip(1) {
        let Some((n, file)) = line.split_once(',') else { continue };
        let Ok(n) = n.trim().parse::<u64>() else { continue };
        let file = file.trim();
        let file = file.strip_prefix('"').and_then(|f| f.strip_suffix('"')).map(|f| f.replace("\"\"", "\"")).unwrap_or_else(|| file.to_string());
        if (1..=3000).contains(&n) && !file.is_empty() {
            out.insert(file, json!(n));
        }
    }
    out
}
