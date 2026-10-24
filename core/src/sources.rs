//! Script sources: git repositories of effect scripts, each cloned into its own folder under the library
//! (`<workspace>/sources/<folder>/`). The library shows them all together; a source's scripts are named
//! `<folder>/<script>`. One is usually enough (your own); more can be added (a friend's public scripts, a team's).
//! The address lives in the clone's `origin`, the read-only mark in its `.git` folder: nothing to keep in step.

use crate::gitsync::{self, Done, Git, Problem};
use crate::library;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// What adding `text` would do: the address it means and the folder it would go into (shown before cloning).
pub fn preview(git: &Git, lib: &Path, text: &str) -> Result<Value, Problem> {
    let url = gitsync::expand_source(text)?;
    if let Some(existing) = find(git, lib, &url) {
        return Err(Problem { kind: "bad_url", reason: format!("That repository is already a source in your library (\"{existing}\").") });
    }
    let root = library::sources_dir(lib);
    let folder = gitsync::folder_for(&url, &|n| root.join(n).exists());
    Ok(json!({ "url": gitsync::redact(&url), "folder": folder, "path": root.join(&folder).to_string_lossy() }))
}

/// The source already cloned from `url`, if any.
fn find(git: &Git, lib: &Path, url: &str) -> Option<String> {
    library::source_names(lib).into_iter().find(|n| {
        let d = library::sources_dir(lib).join(n);
        git_origin(git, &d).is_some_and(|o| gitsync::same_repo(&o, url))
    })
}

fn git_origin(git: &Git, dir: &Path) -> Option<String> {
    let s = gitsync::status(git, dir);
    s["url"].as_str().map(String::from)
}

/// Clones the source, then finds out (by a dry run) whether Studio can push to it.
pub fn add(git: &Git, lib: &Path, text: &str) -> Result<(String, Done), Problem> {
    let p = preview(git, lib, text)?;
    let url = gitsync::expand_source(text)?;
    let folder = p["folder"].as_str().unwrap_or("scripts").to_string();
    let dir = library::sources_dir(lib).join(&folder);
    let fresh = !dir.exists();
    let r = gitsync::connect(git, &dir, &url);
    if r.is_err() && fresh {
        let _ = std::fs::remove_dir_all(&dir); // only the folder made a moment ago, with nothing of the person's in it
    }
    let mut done = r?;
    // offline or the like proves nothing: the first backup tells
    let writable = gitsync::check_write(git, &dir).unwrap_or(true);
    if !writable {
        done.message = format!("{} It is read-only: Studio cannot back up to it (Get latest works).", done.message);
    }
    Ok((folder, done))
}

/// Every source with its status: `{id, path, ...gitsync::status}`.
pub fn list(git: &Git, lib: &Path) -> Vec<Value> {
    library::source_names(lib)
        .into_iter()
        .map(|n| {
            let d = library::sources_dir(lib).join(&n);
            let mut v = gitsync::status(git, &d);
            v["id"] = json!(n);
            v["path"] = json!(d.to_string_lossy());
            v
        })
        .collect()
}

/// The folder of the source `id` (it must be one of the library's sources).
pub fn dir(lib: &Path, id: &str) -> Result<PathBuf, String> {
    library::source_names(lib).into_iter().find(|n| n == id).map(|n| library::sources_dir(lib).join(n)).ok_or_else(|| format!("there is no script source called \"{id}\""))
}

/// Deletes a source's clone (only that folder; this computer's history copies stay). A source with changes not
/// backed up is kept unless `anyway`: the answer says how many.
pub fn remove(git: &Git, lib: &Path, id: &str, anyway: bool) -> Result<Value, String> {
    let d = dir(lib, id)?;
    if std::fs::symlink_metadata(&d).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
        return Err(format!("{} is a link: Studio does not delete it", d.display()));
    }
    let s = gitsync::status(git, &d);
    let changes = if gitsync::is_read_only(&d) { 0 } else { s["changes"].as_u64().unwrap_or(0) };
    if changes > 0 && !anyway {
        return Ok(json!({ "removed": false, "changes": changes }));
    }
    std::fs::remove_dir_all(&d).map_err(|e| format!("could not remove {} ({e})", d.display()))?;
    Ok(json!({ "removed": true, "changes": changes }))
}

/// The source a library command changed, from its arguments: a `source/name` effect name, or a file path inside
/// a source's folder.
pub fn touched(lib: &Path, cmd: &str, a: &Value) -> Vec<PathBuf> {
    let mut out = vec![];
    for k in ["name", "from", "to"] {
        if let Some((src, _)) = a[k].as_str().and_then(|n| n.split_once('/')) {
            if let Ok(d) = dir(lib, src) {
                out.push(d);
            }
        }
    }
    if cmd == "file_write" {
        if let Some(p) = a["path"].as_str() {
            let root = library::sources_dir(lib);
            if let Ok(rest) = Path::new(p).strip_prefix(&root) {
                if let Some(first) = rest.components().next() {
                    out.push(root.join(first.as_os_str()));
                }
            }
        }
    }
    out.dedup();
    out
}
