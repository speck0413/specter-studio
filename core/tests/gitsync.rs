//! The library as a git working copy (gitsync.rs), against local bare repositories: no network, and never the
//! person's own git settings (every git here gets its own HOME and global config with a made-up test identity).

use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use studio_core::gitsync::{self, Debouncer, Git};

struct Env {
    root: PathBuf,
    git: Git,
}

const TEST_IDENTITY: &str = "[user]\n\tname = Test Person\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n";

fn env(name: &str, identity: bool) -> Env {
    let root = std::env::temp_dir().join(format!("studio-git-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("home")).unwrap();
    let cfg = root.join("gitconfig");
    std::fs::write(&cfg, if identity { TEST_IDENTITY.to_string() } else { TEST_IDENTITY.split("[init]").nth(1).map(|s| format!("[init]{s}")).unwrap() }).unwrap();
    let envs = vec![
        ("HOME".to_string(), root.join("home").to_string_lossy().into_owned()),
        ("GIT_CONFIG_GLOBAL".to_string(), cfg.to_string_lossy().into_owned()),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
    ];
    Env { root, git: Git { bin: "git".into(), envs, ..Default::default() } }
}

impl Env {
    /// Plain git as a person (or another computer) would run it.
    fn sh(&self, dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git").current_dir(dir).args(args).envs(self.git.envs.iter().map(|(k, v)| (k, v))).env("GIT_AUTHOR_NAME", "Test Person").env("GIT_AUTHOR_EMAIL", "test@example.invalid").env("GIT_COMMITTER_NAME", "Test Person").env("GIT_COMMITTER_EMAIL", "test@example.invalid").output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }
    /// A bare repository (the "GitHub" of the test) and its file:// address.
    fn bare(&self) -> (PathBuf, String) {
        let b = self.root.join("remote.git");
        std::fs::create_dir_all(&b).unwrap();
        self.sh(&b, &["init", "-q", "--bare", "-b", "main"]);
        (b.clone(), format!("file://{}", b.display()))
    }
    /// Another computer's clone, with `files` committed and pushed.
    fn other(&self, url: &str, files: &[(&str, &str)]) -> PathBuf {
        let o = self.root.join("other");
        if !o.exists() {
            self.sh(&self.root, &["clone", "-q", url, "other"]);
        } else {
            self.sh(&o, &["pull", "-q", "--ff-only"]);
        }
        for (f, t) in files {
            write(&o.join(f), t);
        }
        self.sh(&o, &["add", "-A"]);
        self.sh(&o, &["commit", "-q", "-m", "from the other computer"]);
        self.sh(&o, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
        o
    }
    fn lib(&self) -> PathBuf {
        let l = self.root.join("My Props");
        std::fs::create_dir_all(l.join("effects")).unwrap();
        l
    }
}

fn write(p: &Path, t: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, t).unwrap();
}
fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap()
}
/// A file's text in the bare repository's main branch.
fn in_remote(e: &Env, bare: &Path, f: &str) -> Option<String> {
    let o = Command::new("git").current_dir(bare).args(["show", &format!("main:{f}")]).envs(e.git.envs.iter().map(|(k, v)| (k, v))).output().unwrap();
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

const A1: &str = "effect a:\n  wait for trig1\n  out1 = on\n  sleep 1\n  out1 = off\n";
const A2: &str = "effect a:\n  wait for trig1\n  out1 = on\n  sleep 2\n  out1 = off\n";
const A3: &str = "effect a:\n  wait for trig1\n  out1 = on\n  sleep 3\n  out1 = off\n";

#[test]
fn connect_keeps_every_file_and_adds_the_repositorys() {
    let e = env("connect", true);
    let (bare, url) = e.bare();
    e.other(&url, &[("effects/a.txt", A1), ("effects/only there.txt", "effect t:\n")]);
    let lib = e.lib();
    write(&lib.join("effects/a.txt"), A2); // the same name on both sides: the folder's copy stays
    write(&lib.join("effects/mine.txt"), "effect m:\n");
    write(&lib.join("effects/.a.txt.tmp-1-2"), "half"); // a write cut short: never backed up
    write(&lib.join("sounds/chime.mp3"), "x");
    let p = gitsync::preview(&e.git, &lib).unwrap();
    assert_eq!(p["files"], 4, "{p}");
    assert_eq!(p["repo"], false);

    let r = gitsync::connect(&e.git, &lib, &url).unwrap();
    assert!(r.message.contains("Connected to"), "{}", r.message);
    assert_eq!(read(&lib.join("effects/a.txt")), A2);
    assert_eq!(read(&lib.join("effects/mine.txt")), "effect m:\n");
    assert_eq!(read(&lib.join("effects/only there.txt")), "effect t:\n");
    let s = gitsync::status(&e.git, &lib);
    assert_eq!(s["connected"], true);
    assert_eq!(s["branch"], "main");
    assert_eq!(s["changes"], 3, "{s}"); // a.txt changed, mine.txt and the sound new

    let b = gitsync::backup(&e.git, &lib).unwrap();
    assert!(b.message.contains("3 files changed"), "{}", b.message);
    assert_eq!(in_remote(&e, &bare, "effects/a.txt").as_deref(), Some(A2));
    assert_eq!(in_remote(&e, &bare, "effects/mine.txt").as_deref(), Some("effect m:\n"));
    assert!(in_remote(&e, &bare, "effects/only there.txt").is_some());
    assert!(in_remote(&e, &bare, "effects/.a.txt.tmp-1-2").is_none());
    assert!(in_remote(&e, &bare, "sounds/chime.mp3").is_some());
    let s = gitsync::status(&e.git, &lib);
    assert_eq!(s["changes"], 0, "{s}");
    assert!(s["last_backup"].as_u64().unwrap() > 1_700_000_000);
    assert_eq!(e.sh(&bare, &["log", "-1", "--format=%s", "main"]), "Studio backup: 3 files changed");
    // connecting again to the same address changes nothing; another address needs a git client
    assert!(gitsync::connect(&e.git, &lib, &format!("{url}/")).is_ok());
    let other = gitsync::connect(&e.git, &lib, "https://example.invalid/someone/else.git").unwrap_err();
    assert_eq!(other.kind, "git_client");
}

#[test]
fn an_empty_repository_is_filled_by_the_first_backup() {
    let e = env("empty", true);
    let (bare, url) = e.bare();
    let lib = e.lib();
    write(&lib.join("effects/a.txt"), A1);
    gitsync::connect(&e.git, &lib, &url).unwrap();
    assert_eq!(gitsync::get_latest(&e.git, &lib, true).unwrap().message, "The repository has nothing in it yet.");
    let b = gitsync::backup(&e.git, &lib).unwrap();
    assert!(b.message.contains("1 script changed"), "{}", b.message);
    assert_eq!(in_remote(&e, &bare, "effects/a.txt").as_deref(), Some(A1));
    assert_eq!(e.sh(&bare, &["log", "-1", "--format=%s", "main"]), "Studio backup: 1 script changed");
}

#[test]
fn get_latest_fast_forwards() {
    let e = env("ff", true);
    let (_bare, url) = e.bare();
    e.other(&url, &[("effects/a.txt", A1)]);
    let lib = e.lib();
    gitsync::connect(&e.git, &lib, &url).unwrap();
    assert_eq!(gitsync::get_latest(&e.git, &lib, true).unwrap().message, "Already up to date.");
    e.other(&url, &[("effects/a.txt", A2), ("effects/b.txt", "effect b:\n")]);
    // a change of its own in another file does not stop a fast-forward
    write(&lib.join("effects/mine.txt"), "effect m:\n");
    let r = gitsync::get_latest(&e.git, &lib, true).unwrap();
    assert!(r.changed && r.message.contains("1 new change"), "{}", r.message);
    assert_eq!(read(&lib.join("effects/a.txt")), A2);
    assert_eq!(read(&lib.join("effects/b.txt")), "effect b:\n");
    assert_eq!(read(&lib.join("effects/mine.txt")), "effect m:\n");
}

#[test]
fn a_rejected_push_gets_the_latest_then_pushes() {
    let e = env("rejected", true);
    let (bare, url) = e.bare();
    e.other(&url, &[("effects/a.txt", A1)]);
    let lib = e.lib();
    gitsync::connect(&e.git, &lib, &url).unwrap();
    e.other(&url, &[("effects/theirs.txt", "effect t:\n")]);
    write(&lib.join("effects/mine.txt"), "effect m:\n");
    let b = gitsync::backup(&e.git, &lib).unwrap();
    assert!(b.message.contains("got the latest first"), "{}", b.message);
    assert_eq!(read(&lib.join("effects/theirs.txt")), "effect t:\n");
    assert_eq!(in_remote(&e, &bare, "effects/mine.txt").as_deref(), Some("effect m:\n"));
    assert_eq!(in_remote(&e, &bare, "effects/theirs.txt").as_deref(), Some("effect t:\n"));
    assert_eq!(gitsync::status(&e.git, &lib)["changes"], 0);
}

#[test]
fn a_true_conflict_stops_with_the_folder_as_it_was() {
    let e = env("conflict", true);
    let (bare, url) = e.bare();
    e.other(&url, &[("effects/a.txt", A1)]);
    let lib = e.lib();
    gitsync::connect(&e.git, &lib, &url).unwrap();
    e.other(&url, &[("effects/a.txt", A3)]);
    write(&lib.join("effects/a.txt"), A2);
    let p = gitsync::backup(&e.git, &lib).unwrap_err();
    assert_eq!(p.kind, "git_client");
    let msg = p.message(&lib);
    assert!(msg.starts_with("Your scripts folder needs a git client to sort this out: "), "{msg}");
    assert!(msg.contains("effects/a.txt") && msg.ends_with(&format!("Folder: {}.", lib.display())), "{msg}");
    // the folder: the person's version, committed locally, no rebase left behind, nothing lost on either side
    assert_eq!(read(&lib.join("effects/a.txt")), A2);
    let gd = lib.join(".git");
    assert!(!gd.join("rebase-merge").exists() && !gd.join("rebase-apply").exists());
    assert_eq!(e.sh(&lib, &["status", "--porcelain"]), "");
    assert_eq!(e.sh(&lib, &["show", "HEAD:effects/a.txt"]) + "\n", A2);
    assert_eq!(in_remote(&e, &bare, "effects/a.txt").as_deref(), Some(A3));
    let s = gitsync::status(&e.git, &lib);
    assert_eq!(s["changes"], 1, "{s}");
    // Get latest says the same, and still changes nothing
    let head = e.sh(&lib, &["rev-parse", "HEAD"]);
    assert_eq!(gitsync::get_latest(&e.git, &lib, true).unwrap_err().kind, "git_client");
    assert_eq!(e.sh(&lib, &["rev-parse", "HEAD"]), head);
    // pull only (a plugin folder): commits of its own are a git-client matter straight away
    assert_eq!(gitsync::get_latest(&e.git, &lib, false).unwrap_err().kind, "git_client");
}

#[test]
fn half_done_or_detached_folders_are_left_alone() {
    let e = env("detached", true);
    let (_bare, url) = e.bare();
    e.other(&url, &[("effects/a.txt", A1)]);
    e.other(&url, &[("effects/a.txt", A2)]);
    let lib = e.lib();
    gitsync::connect(&e.git, &lib, &url).unwrap();
    e.sh(&lib, &["checkout", "-q", "HEAD~1"]);
    let p = gitsync::backup(&e.git, &lib).unwrap_err();
    assert_eq!(p.kind, "git_client");
    assert!(p.reason.contains("detached HEAD"));
    e.sh(&lib, &["checkout", "-q", "main"]);
    std::fs::write(lib.join(".git/MERGE_HEAD"), e.sh(&lib, &["rev-parse", "HEAD"])).unwrap();
    assert!(gitsync::get_latest(&e.git, &lib, true).unwrap_err().reason.contains("a merge was started"));
}

#[test]
fn no_identity_commits_nothing() {
    let e = env("noid", false);
    let (bare, url) = e.bare();
    let lib = e.lib();
    write(&lib.join("effects/a.txt"), A1);
    gitsync::connect(&e.git, &lib, &url).unwrap();
    let p = gitsync::backup(&e.git, &lib).unwrap_err();
    assert_eq!(p.kind, "no_identity");
    assert!(p.message(&lib).contains("Studio never sets them"));
    assert!(Command::new("git").current_dir(&lib).args(["rev-parse", "--verify", "-q", "HEAD"]).envs(e.git.envs.iter().map(|(k, v)| (k, v))).output().unwrap().stdout.is_empty());
    assert!(in_remote(&e, &bare, "effects/a.txt").is_none());
    assert_eq!(read(&lib.join("effects/a.txt")), A1);
}

#[test]
fn no_git_says_how_to_install_it() {
    let e = env("nogit", true);
    let lib = e.lib();
    let git = Git { bin: e.root.join("no-such-git"), ..Default::default() };
    let p = gitsync::connect(&git, &lib, "https://github.com/someone/props.git").unwrap_err();
    assert_eq!(p.kind, "no_git");
    let m = p.message(&lib);
    assert!(m.contains("Windows") && m.contains("macOS") && m.contains("Linux"), "{m}");
    assert_eq!(gitsync::status(&git, &lib)["problem"]["kind"], "no_git");
}

#[test]
fn addresses_with_passwords_or_odd_kinds_are_refused() {
    for ok in ["https://github.com/you/my-props.git", "git@github.com:you/my-props.git", "ssh://git@gitlab.example.com/team/props.git", "file:///srv/props.git"] {
        assert!(gitsync::check_url(ok).is_ok(), "{ok}");
    }
    for bad in ["", "-upload-pack=x", "ext::sh -c x", "http://example.com/x.git", "https://user:token@github.com/you/x.git", "https://token@github.com/you/x.git", "github.com/you/x", "a b"] {
        assert_eq!(gitsync::check_url(bad).unwrap_err().kind, "bad_url", "{bad}");
    }
    assert_eq!(gitsync::redact("fatal: unable to access 'https://me:secret@github.com/x.git/'"), "fatal: unable to access 'https://github.com/x.git/'");
    assert_eq!(gitsync::repo_name("https://github.com/you/my-props.git"), "you/my-props");
    assert_eq!(gitsync::repo_name("git@github.com:you/my-props.git"), "you/my-props");
    assert_eq!(gitsync::commit_message(&["effects/a.txt".into(), "effects/b.txt".into(), "effects/c.txt".into()]), "Studio backup: 3 scripts changed");
}

#[tokio::test]
async fn debounce_runs_once_after_the_quiet_time() {
    let d = Debouncer::new(Duration::from_millis(150));
    let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let start = std::time::Instant::now();
    for _ in 0..5 {
        let n = n.clone();
        d.poke(move || async move { n.fetch_add(1, std::sync::atomic::Ordering::SeqCst); });
        tokio::time::sleep(Duration::from_millis(40)).await; // a burst of saves, each within the quiet time
    }
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 0, "nothing runs while saves keep coming");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(start.elapsed() >= Duration::from_millis(350));
    // cancelled (auto save turned off): nothing runs
    let n2 = n.clone();
    d.poke(move || async move { n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); });
    d.cancel();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn auto_save_backs_up_once_after_saves_in_studio() {
    let e = env("auto", true);
    let (bare, url) = e.bare();
    let lib = e.lib();
    let studio = studio_core::Studio::new();
    studio.scripts.configure(e.git.clone(), Duration::from_millis(300));
    let folder = lib.to_string_lossy().into_owned();
    let mut events = studio.events();
    studio.dispatch("workspace_set", json!({ "folder": folder })).await.unwrap();
    let pv = studio.dispatch("sources_preview", json!({ "folder": folder, "source": url })).await.unwrap();
    assert_eq!(pv["folder"], "remote");
    let c = studio.dispatch("sources_add", json!({ "folder": folder, "source": url })).await.unwrap();
    assert_eq!(c["ok"], true, "{c}");
    assert_eq!(c["id"], "remote");
    // the same repository twice: refused
    assert!(studio.dispatch("sources_preview", json!({ "folder": folder, "source": url })).await.is_err());
    // off: a save does nothing
    studio.dispatch("library_save", json!({ "folder": folder, "name": "remote/a", "text": A1, "now": "2026-10-24 10:00" })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(in_remote(&e, &bare, "effects/a.txt").is_none());
    studio.dispatch("sources_auto", json!({ "folder": folder, "ids": ["remote"] })).await.unwrap();
    let t = std::time::Instant::now();
    for text in [A1, A2, A3] {
        studio.dispatch("library_save", json!({ "folder": folder, "name": "remote/a", "text": text, "now": "2026-10-24 10:01" })).await.unwrap();
    }
    // a save of the library's own scripts (not in a source) starts nothing
    studio.dispatch("library_save", json!({ "folder": folder, "name": "local only", "text": A1, "now": "2026-10-24 10:01" })).await.unwrap();
    // the dispatch never waited for git
    assert!(t.elapsed() < Duration::from_millis(250));
    let ev = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(studio_core::Event::ScriptsRepo { auto: true, result, .. }) = events.recv().await {
                return result;
            }
        }
    })
    .await
    .expect("auto save ran");
    assert_eq!(ev["ok"], true, "{ev}");
    assert_eq!(in_remote(&e, &bare, "effects/a.txt").as_deref(), Some(A3));
    // one backup for the burst; the history copies stay on this computer
    assert_eq!(e.sh(&bare, &["rev-list", "--count", "main"]), "1");
    assert!(in_remote(&e, &bare, ".specter/index.json").is_none());
    let l = studio.dispatch("sources_list", json!({ "folder": folder })).await.unwrap();
    assert_eq!(l[0]["changes"], 0, "{l}");
    assert_eq!(l[0]["id"], "remote");
    // the library lists the source's script with its source
    let list = studio.dispatch("library_list", json!({ "folder": folder })).await.unwrap();
    let a = list.as_array().unwrap().iter().find(|x| x["name"] == "remote/a").expect("source script listed").clone();
    assert_eq!(a["source"], "remote");
    assert_eq!(a["title"], "a");
    assert!(list.as_array().unwrap().iter().any(|x| x["name"] == "local only" && x["source"].is_null()));
}

#[test]
fn shorthand_for_every_host() {
    let x = |t: &str| gitsync::expand_source(t).map_err(|p| p.kind);
    assert_eq!(x("someone/specterscripts").unwrap(), "https://github.com/someone/specterscripts.git");
    assert_eq!(x("github:org/scripts").unwrap(), "https://github.com/org/scripts.git");
    assert_eq!(x("gitlab:group/sub/repo").unwrap(), "https://gitlab.com/group/sub/repo.git");
    assert_eq!(x("gitlab:me/props").unwrap(), "https://gitlab.com/me/props.git");
    assert_eq!(x("bitbucket:team/props").unwrap(), "https://bitbucket.org/team/props.git");
    assert_eq!(x("owner/repo.git").unwrap(), "https://github.com/owner/repo.git");
    for full in ["https://git.example.com/a/b.git", "git@gitlab.com:group/sub/repo.git", "ssh://git@host:2222/x/y.git"] {
        assert_eq!(x(full).unwrap(), full);
    }
    for bad in ["owner", "github:a/b/c", "bitbucket:a", "gitlab:a/../b", "a b/c", "owner/", "/repo", "-x/y", "https://u:p@github.com/a/b.git"] {
        assert_eq!(x(bad).unwrap_err(), "bad_url", "{bad}");
    }
    let taken = |n: &str| n == "props";
    assert_eq!(gitsync::folder_for("https://github.com/me/props.git", &|_| false), "props");
    assert_eq!(gitsync::folder_for("https://github.com/me/props.git", &taken), "me-props");
}

fn hook_denies(bare: &Path) {
    let h = bare.join("hooks/pre-receive");
    std::fs::write(&h, "#!/bin/sh\necho 'Permission to someone/scripts.git denied to you.' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&h, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[tokio::test]
async fn two_sources_one_read_only_with_save_a_copy() {
    let e = env("two", true);
    let lib = e.lib();
    // mine (writable) and a friend's (Studio may read, never push)
    let mine = e.root.join("mine.git");
    let theirs = e.root.join("friend-scripts.git");
    for b in [&mine, &theirs] {
        std::fs::create_dir_all(b).unwrap();
        e.sh(b, &["init", "-q", "--bare", "-b", "main"]);
    }
    let theirs_url = format!("file://{}", theirs.display());
    e.other(&theirs_url, &[("effects/spooky.txt", A1)]);
    hook_denies(&theirs);
    let studio = studio_core::Studio::new();
    studio.scripts.configure(e.git.clone(), Duration::from_millis(200));
    let folder = lib.to_string_lossy().into_owned();
    studio.dispatch("workspace_set", json!({ "folder": folder })).await.unwrap();
    for u in [format!("file://{}", mine.display()), theirs_url.clone()] {
        let r = studio.dispatch("sources_add", json!({ "folder": folder, "source": u })).await.unwrap();
        assert_eq!(r["ok"], true, "{r}");
    }
    let list = studio.dispatch("library_list", json!({ "folder": folder })).await.unwrap();
    assert!(list.as_array().unwrap().iter().any(|x| x["name"] == "friend-scripts/spooky"), "{list}");
    // a change to the friend's script: the first push finds out it is read-only, with a plain note
    studio.dispatch("library_save", json!({ "folder": folder, "name": "friend-scripts/spooky", "text": A2, "now": "2026-10-24 11:00" })).await.unwrap();
    let b = studio.dispatch("sources_backup", json!({ "folder": folder, "id": "friend-scripts" })).await.unwrap();
    assert_eq!(b["ok"], false);
    assert_eq!(b["problem"]["kind"], "no_write", "{b}");
    assert!(lib.join("sources/friend-scripts/.git").join(gitsync::READ_ONLY_FILE).exists());
    // from now on: no saves into it, and Back up everything leaves it out
    let refused = studio.dispatch("library_save", json!({ "folder": folder, "name": "friend-scripts/spooky", "text": A3, "now": "2026-10-24 11:01" })).await.unwrap_err();
    assert!(refused.contains("Save a copy to"), "{refused}");
    assert!(studio.dispatch("library_delete", json!({ "folder": folder, "name": "friend-scripts/spooky" })).await.is_err());
    assert!(studio.dispatch("file_write", json!({ "folder": folder, "path": lib.join("sources/friend-scripts/effects/x.txt").to_string_lossy(), "text": "x" })).await.is_err());
    let listed = studio.dispatch("library_list", json!({ "folder": folder })).await.unwrap();
    assert!(listed.as_array().unwrap().iter().any(|x| x["name"] == "friend-scripts/spooky" && x["read_only"] == true));
    // Save a copy to… my source: a new script there
    let text = studio.dispatch("library_read", json!({ "folder": folder, "name": "friend-scripts/spooky" })).await.unwrap();
    studio.dispatch("library_save", json!({ "folder": folder, "name": "mine/spooky", "text": text, "now": "2026-10-24 11:02" })).await.unwrap();
    let all = studio.dispatch("sources_backup", json!({ "folder": folder })).await.unwrap();
    assert_eq!(all["ok"], true, "{all}");
    assert_eq!(all["results"].as_array().unwrap().len(), 1, "the read-only source is left out: {all}");
    assert_eq!(in_remote(&e, &mine, "effects/spooky.txt").as_deref(), Some(A2));
    // Get latest still works for the read-only one, for all sources at once
    let g = studio.dispatch("sources_get_latest", json!({ "folder": folder })).await.unwrap();
    assert_eq!(g["results"].as_array().unwrap().len(), 2, "{g}");
    // a rename never moves a script into another source
    assert!(studio.dispatch("library_rename", json!({ "folder": folder, "from": "mine/spooky", "to": "friend-scripts/x" })).await.is_err());
    studio.dispatch("library_rename", json!({ "folder": folder, "from": "mine/spooky", "to": "spookier" })).await.unwrap();
    assert!(lib.join("sources/mine/effects/spookier.txt").exists());
}

fn plugin(dir: &Path, id: &str, extra: &str) {
    write(&dir.join("plugin.json"), &format!("{{\"id\":\"{id}\",\"name\":\"Demo lights\",\"entry\":\"index.html\"{extra}}}"));
    write(&dir.join("index.html"), "<p>demo</p>");
}

/// A bare repository holding `files` (made by a second clone) and its address.
fn repo_with(e: &Env, name: &str, make: impl Fn(&Path)) -> (PathBuf, String) {
    let b = e.root.join(format!("{name}.git"));
    std::fs::create_dir_all(&b).unwrap();
    e.sh(&b, &["init", "-q", "--bare", "-b", "main"]);
    let w = e.root.join(format!("{name}-work"));
    let url = format!("file://{}", b.display());
    e.sh(&e.root, &["clone", "-q", &url, w.to_str().unwrap()]);
    make(&w);
    e.sh(&w, &["add", "-A"]);
    e.sh(&w, &["commit", "-q", "-m", "extension"]);
    e.sh(&w, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    (w, url)
}

#[tokio::test]
async fn extensions_from_git_add_update_and_remove() {
    let e = env("ext", true);
    let root = e.root.join("extensions");
    let studio = studio_core::Studio::new();
    studio.scripts.configure(e.git.clone(), Duration::from_millis(200));
    studio.set_extensions_dir(root.clone());
    // at the top of the repository
    let (top_work, top_url) = repo_with(&e, "demo-lights", |w| plugin(w, "demo-lights", ""));
    let pv = studio.dispatch("extension_preview", json!({ "source": top_url })).await.unwrap();
    assert_eq!(pv["folder"], "demo-lights");
    let a = studio.dispatch("extension_add", json!({ "source": top_url })).await.unwrap();
    assert_eq!(a["added"]["id"], "demo-lights", "{a}");
    let plugins = studio.dispatch("plugins", json!({})).await.unwrap();
    assert!(plugins.as_array().unwrap().iter().any(|p| p["id"] == "demo-lights"));
    // in one folder inside the repository
    let (_w, sub_url) = repo_with(&e, "demo-pack", |w| { write(&w.join("README.md"), "x"); plugin(&w.join("studio-plugin"), "demo-pack", ""); });
    let b = studio.dispatch("extension_add", json!({ "source": sub_url })).await.unwrap();
    assert_eq!(b["added"]["id"], "demo-pack", "{b}");
    assert!(b["added"]["dir"].as_str().unwrap().ends_with("studio-plugin"));
    // several: the person picks
    let (_w, many_url) = repo_with(&e, "demo-many", |w| { plugin(&w.join("one"), "demo-one", ""); plugin(&w.join("two"), "demo-two", ""); });
    let c = studio.dispatch("extension_add", json!({ "source": many_url })).await.unwrap();
    assert_eq!(c["choose"], json!(["one", "two"]), "{c}");
    let c2 = studio.dispatch("extension_add", json!({ "source": many_url, "sub": "two" })).await.unwrap();
    assert_eq!(c2["added"]["id"], "demo-two", "{c2}");
    // none: said plainly, and nothing is left behind
    let (_w, none_url) = repo_with(&e, "not-an-extension", |w| write(&w.join("README.md"), "x"));
    let n = studio.dispatch("extension_add", json!({ "source": none_url })).await.unwrap_err();
    assert!(n.contains("has no Studio extension"), "{n}");
    assert!(!root.join("not-an-extension").exists());
    // the same id twice: refused
    let (_w, dup_url) = repo_with(&e, "demo-copy", |w| plugin(w, "demo-lights", ""));
    assert!(studio.dispatch("extension_add", json!({ "source": dup_url })).await.unwrap_err().contains("already has an extension"));

    let l = studio.dispatch("extensions", json!({})).await.unwrap();
    let first = l.as_array().unwrap().iter().find(|x| x["id"] == "demo-lights").unwrap().clone();
    assert_eq!(first["source"], top_url.as_str());
    assert!(first["commit"].as_str().unwrap().len() >= 7);
    // an update that asks for more: Check tells, Get latest brings it (the consent screen asks again in the app)
    plugin(&top_work, "demo-lights", ",\"control\":true");
    e.sh(&top_work, &["commit", "-qam", "asks for control"]);
    e.sh(&top_work, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    let ck = studio.dispatch("extension_check", json!({ "folder": "demo-lights" })).await.unwrap();
    assert_eq!(ck["behind"], 1, "{ck}");
    assert!(!read(&root.join("demo-lights/plugin.json")).contains("control"), "checking never applies");
    let g = studio.dispatch("extension_get_latest", json!({ "folder": "demo-lights" })).await.unwrap();
    assert_eq!(g["ok"], true, "{g}");
    let plugins = studio.dispatch("plugins", json!({})).await.unwrap();
    assert_eq!(plugins.as_array().unwrap().iter().find(|p| p["id"] == "demo-lights").unwrap()["control"], true);
    // a commit made in the extension folder: not a fast-forward, so a git client sorts it out
    write(&root.join("demo-lights/local.txt"), "mine");
    e.sh(&root.join("demo-lights"), &["add", "-A"]);
    e.sh(&root.join("demo-lights"), &["commit", "-qm", "local"]);
    write(&top_work.join("more.txt"), "x");
    e.sh(&top_work, &["add", "-A"]);
    e.sh(&top_work, &["commit", "-qm", "more"]);
    e.sh(&top_work, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    let nf = studio.dispatch("extension_get_latest", json!({ "folder": "demo-lights" })).await.unwrap();
    assert_eq!(nf["ok"], false);
    let m = nf["message"].as_str().unwrap();
    assert!(m.starts_with("This extension's folder needs a git client to sort this out: "), "{m}");
    assert!(m.contains(&root.join("demo-lights").display().to_string()), "{m}");
    assert_eq!(read(&root.join("demo-lights/local.txt")), "mine");
    // Remove: the clone only
    studio.dispatch("extension_remove", json!({ "folder": "demo-pack" })).await.unwrap();
    assert!(!root.join("demo-pack").exists());
    assert!(studio.dispatch("plugins", json!({})).await.unwrap().as_array().unwrap().iter().all(|p| p["id"] != "demo-pack"));
    assert!(studio.dispatch("extension_remove", json!({ "folder": "../x" })).await.is_err());
    // a fresh Studio finds the added ones again
    let again = studio_core::Studio::new();
    again.set_extensions_dir(root.clone());
    let ids: Vec<String> = again.dispatch("plugins", json!({})).await.unwrap().as_array().unwrap().iter().filter_map(|p| p["id"].as_str().map(String::from)).collect();
    assert!(ids.contains(&"demo-lights".to_string()) && ids.contains(&"demo-two".to_string()) && !ids.contains(&"demo-pack".to_string()), "{ids:?}");
}

#[test]
fn what_runs_by_itself_never_opens_a_sign_in_window() {
    let g = Git::default();
    let quiet = g.non_interactive();
    let has = |k: &str, v: &str| quiet.envs.iter().any(|(a, b)| a == k && b == v);
    assert!(has("GCM_INTERACTIVE", "never") && has("GIT_ASKPASS", "") && has("GIT_CONFIG_KEY_0", "credential.interactive") && has("GIT_CONFIG_VALUE_0", "false"));
    assert_eq!(quiet.timeout, gitsync::GIT_TIMEOUT);
    // a button the person pressed: the credential manager may ask, and gets time for a first sign-in
    let pressed = g.interactive();
    assert!(!pressed.envs.iter().any(|(k, _)| k == "GCM_INTERACTIVE"));
    assert_eq!(pressed.timeout, gitsync::SIGN_IN_TIMEOUT);
}

#[tokio::test]
async fn removing_a_source_keeps_changes_not_backed_up_unless_asked() {
    let e = env("remove", true);
    let (_bare, url) = e.bare();
    e.other(&url, &[("effects/a.txt", A1)]);
    let lib = e.lib();
    let studio = studio_core::Studio::new();
    studio.scripts.configure(e.git.clone(), Duration::from_millis(200));
    let folder = lib.to_string_lossy().into_owned();
    studio.dispatch("workspace_set", json!({ "folder": folder })).await.unwrap();
    assert_eq!(studio.dispatch("sources_add", json!({ "folder": folder, "source": url })).await.unwrap()["ok"], true);
    studio.dispatch("library_save", json!({ "folder": folder, "name": "remote/b", "text": A2, "now": "2026-10-24 12:00" })).await.unwrap();
    let r = studio.dispatch("sources_remove", json!({ "folder": folder, "id": "remote" })).await.unwrap();
    assert_eq!(r, json!({ "removed": false, "changes": 1 }));
    assert!(lib.join("sources/remote/effects/b.txt").exists());
    let r = studio.dispatch("sources_remove", json!({ "folder": folder, "id": "remote", "anyway": true })).await.unwrap();
    assert_eq!(r["removed"], true);
    assert!(!lib.join("sources/remote").exists());
    assert!(lib.join("effects").exists(), "only the clone goes");
    // a clean source goes straight away
    assert_eq!(studio.dispatch("sources_add", json!({ "folder": folder, "source": url })).await.unwrap()["ok"], true);
    assert_eq!(studio.dispatch("sources_remove", json!({ "folder": folder, "id": "remote" })).await.unwrap()["removed"], true);
    assert!(studio.dispatch("sources_remove", json!({ "folder": folder, "id": "../x" })).await.is_err());
}

#[tokio::test]
async fn an_extension_loads_only_the_folder_chosen_and_a_repository_adds_once_per_extension() {
    let e = env("extpick", true);
    let root = e.root.join("extensions");
    let studio = studio_core::Studio::new();
    studio.scripts.configure(e.git.clone(), Duration::from_millis(200));
    studio.set_extensions_dir(root.clone());
    let ids = |v: serde_json::Value| -> Vec<String> { v.as_array().unwrap().iter().filter_map(|p| p["id"].as_str().map(String::from)).collect() };
    // a plugin at the top with another one inside: only the chosen one loads
    let (_w, url) = repo_with(&e, "demo-nested", |w| { plugin(w, "demo-top", ""); plugin(&w.join("child"), "demo-child", ""); });
    let c = studio.dispatch("extension_add", json!({ "source": url })).await.unwrap();
    assert_eq!(c["choose"], json!(["", "child"]), "{c}");
    studio.dispatch("extension_add", json!({ "source": url, "sub": "" })).await.unwrap();
    let now = ids(studio.dispatch("plugins", json!({})).await.unwrap());
    assert!(now.contains(&"demo-top".to_string()) && !now.contains(&"demo-child".to_string()), "{now:?}");
    // the same repository again: the other extension in it, in a clone of its own
    let again = studio.dispatch("extension_add", json!({ "source": url })).await.unwrap();
    assert_eq!(again["choose"], json!(["child"]), "{again}");
    let added = studio.dispatch("extension_add", json!({ "source": url, "sub": "child" })).await.unwrap();
    assert_eq!(added["added"]["id"], "demo-child", "{added}");
    assert_ne!(added["added"]["folder"], "demo-nested");
    let now = ids(studio.dispatch("plugins", json!({})).await.unwrap());
    assert_eq!(now.iter().filter(|i| *i == "demo-top" || *i == "demo-child").count(), 2, "{now:?}");
    assert!(studio.dispatch("extension_add", json!({ "source": url })).await.unwrap_err().contains("already added"));
    assert_eq!(studio.dispatch("extensions", json!({})).await.unwrap().as_array().unwrap().len(), 2);
}
