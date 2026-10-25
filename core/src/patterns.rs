//! LED patterns in the library: one file per pattern, `<workspace>/patterns/<name>.pattern.js` (and
//! `<source>/patterns/<name>.pattern.js` in a script source, named `<source>/<name>` like its effects). The
//! text is the pattern's own code (a JavaScript-like language, so other editors colour it); Studio compiles and
//! previews it (src/patterns/). Nothing here runs it.

use crate::library::{file_stem, index_dir, source_names, sources_dir, write_atomic};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const EXT: &str = ".pattern.js";
/// Large enough for any pattern a person writes; a bigger file is not a pattern.
const MAX_BYTES: usize = 256 * 1024;

pub fn patterns_dir(ws: &Path) -> PathBuf {
    ws.join("patterns")
}

struct Place {
    dir: PathBuf,
    stem: String,
    source: Option<PathBuf>,
}

impl Place {
    fn file(&self) -> PathBuf {
        self.dir.join(format!("{}{EXT}", self.stem))
    }
    fn writable(&self, name: &str) -> Result<(), String> {
        match &self.source {
            Some(sd) if crate::gitsync::is_read_only(sd) => Err(format!("\"{name}\" is in a read-only script source (Studio cannot back up to it). Use Save a copy to… to put it into one of your own sources.")),
            _ => Ok(()),
        }
    }
}

fn locate(lib: &Path, name: &str) -> Result<Place, String> {
    match name.split_once('/') {
        None => Ok(Place { dir: patterns_dir(lib), stem: stem(name)?, source: None }),
        Some((src, n)) => {
            let (src, st) = (file_stem(src)?, stem(n)?);
            let sd = sources_dir(lib).join(&src);
            if std::fs::symlink_metadata(&sd).map(|m| m.file_type().is_symlink()).unwrap_or(true) || !sd.join(".git").exists() {
                return Err(format!("there is no script source called \"{src}\" in your library"));
            }
            Ok(Place { dir: patterns_dir(&sd), stem: st, source: Some(sd) })
        }
    }
}

fn stem(name: &str) -> Result<String, String> {
    file_stem(name).map_err(|e| e.replace("the effect", "the pattern"))
}

/// Every pattern: `{name, title, source, read_only, file}`, by name (the library's own first, then each source).
pub fn list(lib: &Path) -> Vec<Value> {
    let mut places: Vec<(PathBuf, Option<String>, bool)> = vec![(patterns_dir(lib), None, false)];
    for s in source_names(lib) {
        let sd = sources_dir(lib).join(&s);
        places.push((patterns_dir(&sd), Some(s), crate::gitsync::is_read_only(&sd)));
    }
    let mut out = vec![];
    for (dir, src, ro) in places {
        let mut here: Vec<Value> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let fname = e.file_name().to_string_lossy().to_string();
                let title = fname.strip_suffix(EXT)?.to_string();
                if title.is_empty() || title.starts_with('.') || !e.path().is_file() {
                    return None;
                }
                let name = match &src { Some(s) => format!("{s}/{title}"), None => title.clone() };
                Some(json!({ "name": name, "title": title, "source": src, "read_only": ro, "file": e.path().to_string_lossy() }))
            })
            .collect();
        here.sort_by_key(|v| v["title"].as_str().unwrap_or("").to_lowercase());
        out.extend(here);
    }
    out
}

pub fn read(lib: &Path, name: &str) -> Result<String, String> {
    let p = locate(lib, name)?;
    std::fs::read_to_string(p.file()).map_err(|_| format!("there is no pattern called \"{name}\""))
}

/// Saves a pattern (a new one or over the old text). `new: true` refuses a name that is taken.
pub fn save(lib: &Path, name: &str, text: &str, new: bool) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("this pattern is too big (more than 256 KB)".into());
    }
    let p = locate(lib, name)?;
    p.writable(name)?;
    if new && taken(&p) {
        return Err(format!("there is already a pattern called \"{name}\""));
    }
    std::fs::create_dir_all(&p.dir).map_err(|e| format!("cannot make {}: {e}", p.dir.display()))?;
    write_atomic(&p.file(), text.as_bytes())
}

/// A file of that name, ignoring case (Windows and macOS see "Fire" and "fire" as one file).
fn taken(p: &Place) -> bool {
    let want = format!("{}{EXT}", p.stem).to_lowercase();
    std::fs::read_dir(&p.dir).into_iter().flatten().flatten().any(|e| e.file_name().to_string_lossy().to_lowercase() == want)
}

pub fn rename(lib: &Path, from: &str, to: &str) -> Result<(), String> {
    let pf = locate(lib, from)?;
    // a new name for a source's pattern stays in that source
    let to_full = match (&pf.source, to.contains('/')) {
        (Some(_), false) => format!("{}/{to}", from.split_once('/').map(|x| x.0).unwrap_or("")),
        _ => to.to_string(),
    };
    let pt = locate(lib, &to_full)?;
    if pf.source != pt.source {
        return Err("a pattern cannot be renamed into another script source: use Save a copy to…".into());
    }
    pf.writable(from)?;
    let (src, dst) = (pf.file(), pt.file());
    if !src.exists() {
        return Err(format!("there is no pattern called \"{from}\""));
    }
    let case_only = pf.stem != pt.stem && pf.stem.to_lowercase() == pt.stem.to_lowercase();
    if taken(&pt) && !case_only {
        return Err(format!("there is already a pattern called \"{to}\""));
    }
    if case_only {
        let tmp = src.with_extension("renaming");
        std::fs::rename(&src, &tmp).and_then(|_| std::fs::rename(&tmp, &dst))
    } else {
        std::fs::rename(&src, &dst)
    }
    .map_err(|e| e.to_string())
}

/// Moves the pattern to the library's trash folder (`.specter/trash`), so it can be got back.
pub fn delete(lib: &Path, name: &str) -> Result<(), String> {
    let p = locate(lib, name)?;
    p.writable(name)?;
    let src = p.file();
    if !src.exists() {
        return Err(format!("there is no pattern called \"{name}\""));
    }
    let trash = index_dir(lib).join("trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    std::fs::rename(&src, trash.join(format!("{}-{}{EXT}", p.stem, crate::fleet::stamp()))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("studio-patterns-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_list_read_rename_delete() {
        let w = ws("basic");
        assert!(list(&w).is_empty());
        save(&w, "rainbow", "export function render(i) {}", true).unwrap();
        save(&w, "Comet", "x", true).unwrap();
        assert!(w.join("patterns/rainbow.pattern.js").is_file());
        let names: Vec<String> = list(&w).iter().map(|v| v["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["Comet", "rainbow"]);
        assert_eq!(read(&w, "rainbow").unwrap(), "export function render(i) {}");
        // a new pattern never replaces one (whatever the case); saving over an open one does
        assert!(save(&w, "RAINBOW", "y", true).unwrap_err().contains("already a pattern"));
        save(&w, "rainbow", "z", false).unwrap();
        assert_eq!(read(&w, "rainbow").unwrap(), "z");
        rename(&w, "rainbow", "Rainbow").unwrap();
        assert_eq!(read(&w, "Rainbow").unwrap(), "z");
        assert!(rename(&w, "Rainbow", "comet").unwrap_err().contains("already"));
        delete(&w, "Rainbow").unwrap();
        assert!(read(&w, "Rainbow").is_err());
        assert!(std::fs::read_dir(w.join(".specter/trash")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("Rainbow-")));
        // effects are not patterns, and patterns are not effects
        std::fs::create_dir_all(w.join("effects")).unwrap();
        std::fs::write(w.join("effects/porch.txt"), "effect porch:\n").unwrap();
        assert_eq!(list(&w).len(), 1);
        assert!(crate::library::list(&w).iter().all(|e| e["name"] != "Comet"));
        let _ = std::fs::remove_dir_all(&w);
    }

    #[test]
    fn names_are_checked() {
        let w = ws("names");
        assert!(save(&w, "../x", "a", true).is_err());
        assert!(save(&w, ".hidden", "a", true).is_err());
        assert!(save(&w, "nosource/x", "a", true).unwrap_err().contains("no script source"));
        assert!(save(&w, "big", &"x".repeat(MAX_BYTES + 1), true).unwrap_err().contains("too big"));
        let _ = std::fs::remove_dir_all(&w);
    }

    #[test]
    fn sources_keep_their_own_and_read_only_ones_refuse() {
        let w = ws("sources");
        let sd = sources_dir(&w).join("shared");
        std::fs::create_dir_all(sd.join(".git")).unwrap();
        save(&w, "shared/fire", "f", true).unwrap();
        assert!(sd.join("patterns/fire.pattern.js").is_file());
        let l = list(&w);
        assert_eq!(l[0]["name"], "shared/fire");
        assert_eq!(l[0]["source"], "shared");
        rename(&w, "shared/fire", "embers").unwrap();
        assert_eq!(read(&w, "shared/embers").unwrap(), "f");
        std::fs::write(sd.join(".git").join(crate::gitsync::READ_ONLY_FILE), "x").unwrap();
        assert!(save(&w, "shared/embers", "g", false).unwrap_err().contains("read-only"));
        assert!(delete(&w, "shared/embers").is_err());
        assert_eq!(list(&w)[0]["read_only"], true);
        let _ = std::fs::remove_dir_all(&w);
    }
}
