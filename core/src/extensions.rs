//! Extensions from git: `owner/repo` (GitHub), `gitlab:group/repo`, `bitbucket:owner/repo` or any git address,
//! cloned with the system git and the person's own sign-in (so private repositories work) into
//! `<extensions folder>/<name>/`. The extension is the folder with `plugin.json`: the clone's top folder or exactly
//! one folder inside it (several: the person picks one). Get latest is fast-forward only; the consent screen
//! (src/components/PluginConsent.tsx) runs again whenever plugin.json asks for more. Remove deletes the clone only.
//! What was added from where is kept in the clone's own `.git` folder, so it goes when the clone goes.

use crate::gitsync::{self, Git, Problem};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Inside the clone's `.git`: `{source, sub}` (what the person typed, and the folder with plugin.json).
pub const RECORD: &str = "specter-studio-extension.json";
/// How deep inside a clone plugin.json is looked for (the top folder is depth 0).
const SEARCH_DEPTH: usize = 2;

fn bad(reason: impl Into<String>) -> Problem {
    Problem { kind: "bad_url", reason: reason.into() }
}

/// The folders inside `clone` that hold a plugin.json (relative, "" = the top folder), nearest first.
pub fn find_plugins(clone: &Path) -> Vec<String> {
    fn walk(root: &Path, d: &Path, depth: usize, out: &mut Vec<String>) {
        if d.join("plugin.json").is_file() {
            out.push(d.strip_prefix(root).unwrap_or(Path::new("")).to_string_lossy().replace('\\', "/"));
        }
        if depth >= SEARCH_DEPTH {
            return;
        }
        let mut kids: Vec<PathBuf> = std::fs::read_dir(d).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.')).map(|e| e.path()).collect();
        kids.sort();
        for k in kids {
            walk(root, &k, depth + 1, out);
        }
    }
    let mut out = vec![];
    walk(clone, clone, 0, &mut out);
    out
}

fn record(clone: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(clone.join(".git").join(RECORD)).ok()?).ok()
}

/// The registered extension's plugin folder.
fn plugin_dir(clone: &Path) -> Option<PathBuf> {
    let r = record(clone)?;
    let sub = r["sub"].as_str().unwrap_or("");
    Some(if sub.is_empty() { clone.to_path_buf() } else { clone.join(sub) })
}

/// Every added extension: its clone folder and plugin folder.
pub fn registered(root: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut v: Vec<(PathBuf, PathBuf)> = std::fs::read_dir(root).into_iter().flatten().flatten().filter_map(|e| {
        let c = e.path();
        if !e.file_type().ok()?.is_dir() {
            return None;
        }
        Some((c.clone(), plugin_dir(&c)?))
    }).collect();
    v.sort();
    v
}

/// What adding `text` would do: the address and the folder (shown before cloning).
pub fn preview(git: &Git, root: &Path, text: &str) -> Result<Value, Problem> {
    let url = gitsync::expand_source(text)?;
    // a folder is free, or holds a clone of this same repository still waiting for a pick
    let folder = gitsync::folder_for(&url, &|n| root.join(n).exists() && !pending(&root.join(n), &url, git));
    Ok(json!({ "url": gitsync::redact(&url), "folder": folder, "path": root.join(&folder).to_string_lossy() }))
}

/// A clone made for `url` that is still waiting for the person to pick which extension in it.
fn pending(c: &Path, url: &str, git: &Git) -> bool {
    record(c).is_none() && gitsync::status(git, c)["url"].as_str().is_some_and(|o| gitsync::same_repo(o, url))
}

/// The folders of this repository already added (a repository holding several extensions is added once per
/// extension, each in its own clone).
fn added_from(git: &Git, root: &Path, url: &str) -> Vec<String> {
    registered(root)
        .into_iter()
        .filter(|(c, _)| gitsync::status(git, c)["url"].as_str().is_some_and(|o| gitsync::same_repo(o, url)))
        .filter_map(|(c, _)| record(&c).and_then(|r| r["sub"].as_str().map(String::from)))
        .collect()
}

/// Clones (or reuses a clone waiting for a choice) and registers the extension. `sub`: the person's pick when
/// the repository holds several. `ids`: the extension ids Studio already has (one id, one extension).
/// Answers `{added: {folder, dir, id, name}}` or `{choose: [folders]}`.
pub fn add(git: &Git, root: &Path, text: &str, sub: Option<&str>, ids: &[String]) -> Result<Value, Problem> {
    let p = preview(git, root, text)?;
    let url = gitsync::expand_source(text)?;
    let folder = p["folder"].as_str().unwrap_or("extension").to_string();
    let clone = root.join(&folder);
    let fresh = !clone.exists();
    std::fs::create_dir_all(root).map_err(|e| Problem { kind: "git_client", reason: format!("cannot make {} ({e})", root.display()) })?;
    let drop_fresh = |p: Problem| {
        if fresh {
            let _ = std::fs::remove_dir_all(&clone); // only the clone made a moment ago
        }
        p
    };
    gitsync::connect(git, &clone, &url).map_err(drop_fresh)?;
    let all = find_plugins(&clone);
    if all.is_empty() {
        return Err(drop_fresh(bad("This repository has no Studio extension (no plugin.json in it).")));
    }
    let done = added_from(git, root, &url);
    let found: Vec<String> = all.iter().filter(|f| !done.contains(f)).cloned().collect();
    if found.is_empty() {
        return Err(drop_fresh(bad(if all.len() == 1 { "That extension is already added.".to_string() } else { "Every extension in that repository is already added.".to_string() })));
    }
    let pick = match sub {
        Some(s) if found.iter().any(|f| f == s) => s.to_string(),
        Some(s) if done.iter().any(|f| f == s) => return Err(drop_fresh(bad("That extension is already added."))),
        Some(_) => return Err(bad("That folder in the repository has no plugin.json.")),
        None if all.len() == 1 => found[0].clone(),
        None => return Ok(json!({ "choose": found, "folder": folder })),
    };
    let dir = if pick.is_empty() { clone.clone() } else { clone.join(&pick) };
    let pj: Value = std::fs::read_to_string(dir.join("plugin.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let Some(id) = pj["id"].as_str().map(String::from) else {
        return Err(drop_fresh(bad("The extension's plugin.json has no \"id\".")));
    };
    if ids.contains(&id) {
        return Err(drop_fresh(bad(format!("Studio already has an extension with the id \"{id}\". Remove that one first."))));
    }
    std::fs::write(clone.join(".git").join(RECORD), json!({ "source": text.trim(), "sub": pick }).to_string()).map_err(|e| drop_fresh(Problem { kind: "git_client", reason: format!("cannot write the record ({e})") }))?;
    Ok(json!({ "added": { "folder": folder, "dir": dir.to_string_lossy(), "id": id, "name": pj["name"] } }))
}

/// Every added extension: `{folder, source, url, sub, dir, id, name, commit, problem}`.
pub fn list(git: &Git, root: &Path) -> Vec<Value> {
    registered(root)
        .into_iter()
        .map(|(c, d)| {
            let r = record(&c).unwrap_or(Value::Null);
            let s = gitsync::status(git, &c);
            let pj: Value = std::fs::read_to_string(d.join("plugin.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
            json!({ "folder": c.file_name().map(|n| n.to_string_lossy().into_owned()), "path": c.to_string_lossy(), "source": r["source"], "sub": r["sub"],
                    "url": s["url"], "dir": d.to_string_lossy(), "id": pj["id"], "name": pj["name"], "commit": s["commit"], "problem": s["problem"] })
        })
        .collect()
}

/// The clone of the added extension `folder` (only a registered folder inside `root`, never a link).
pub fn clone_dir(root: &Path, folder: &str) -> Result<PathBuf, String> {
    if folder.is_empty() || folder.contains(['/', '\\']) || folder.starts_with('.') {
        return Err("not an extension folder".into());
    }
    let c = root.join(folder);
    if std::fs::symlink_metadata(&c).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
        return Err(format!("there is no extension folder called {folder}"));
    }
    let (canon, r) = (dunce::canonicalize(&c).map_err(|e| e.to_string())?, dunce::canonicalize(root).map_err(|e| e.to_string())?);
    if !canon.starts_with(&r) || record(&canon).is_none() {
        return Err(format!("{folder} is not an extension added from git"));
    }
    Ok(canon)
}

/// Deletes the clone of an added extension (nothing else).
pub fn remove(root: &Path, folder: &str) -> Result<PathBuf, String> {
    let c = clone_dir(root, folder)?;
    let dir = plugin_dir(&c).unwrap_or(c.clone());
    std::fs::remove_dir_all(&c).map_err(|e| format!("could not remove {} ({e})", c.display()))?;
    Ok(dir)
}
