//! A folder kept in step with a git repository, the simple way: **Get latest** (fetch, then fast-forward; a plain
//! rebase only when this folder's own commits are already made) and **Back up everything** (add all, commit,
//! push; a rejected push gets the latest once and pushes again). Anything git cannot do by itself (a conflict,
//! a sign-in that fails, a half-finished merge, a detached HEAD) stops with the folder exactly as it was and one
//! plain message: use a git client.
//!
//! Studio runs the system `git` with the person's own configuration: their credential helper or ssh agent, their
//! name and email. It never asks for, stores or logs a password or token, never sets an identity, never
//! force-pushes, never resets `--hard` and never discards a change. Used for the library folder (scripts) and,
//! pull-only, for a plugin folder that is a git clone.

use serde::Serialize;
use serde_json::{json, Value};
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The longest one git command may take (a fetch or push over a slow line); then it is stopped, so a sign-in
/// prompt that cannot be answered never hangs Studio.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// When the person pressed the button themselves, the credential manager's sign-in window may be open: they get
/// this long to sign in.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(600);
/// How often a running git command is looked at while Studio waits for it.
const POLL: Duration = Duration::from_millis(20);
/// Auto save waits this long after the last save in Studio before it backs up (more saves in that time wait again).
pub const AUTO_SAVE_QUIET: Duration = Duration::from_secs(10);
/// Inside `.git`: when this folder was last backed up, in seconds since 1970 (this computer only, never committed).
pub const LAST_BACKUP_FILE: &str = "specter-studio-last-backup";
/// File names are passed to git in groups of at most this many (command lines have a length limit).
const PATHS_PER_CALL: usize = 100;
/// Inside `.git`: present when Studio found it cannot push to this repository (this computer only).
pub const READ_ONLY_FILE: &str = "specter-studio-read-only";
/// What never goes into the repository: written into `.git/info/exclude` (this computer only; no tracked file
/// changes). Half-written temporary files (Studio writes a file beside it, then renames it) and build output.
pub const EXCLUDES: &[&str] = &[".*.tmp-*", ".pio/"];
const EXCLUDE_MARK: &str = "# Specter Studio: not backed up";

/// Why something did not happen, with the plain sentence to show.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Problem {
    /// `no_git`, `no_identity`, `git_client` (needs a git client), `offline`, `back_up_first`, `bad_url`,
    /// `not_connected`, `no_write` (Studio cannot push there: the source is read-only)
    pub kind: &'static str,
    /// The reason in plain words (for `git_client`, what git could not sort out)
    pub reason: String,
}

impl Problem {
    fn new(kind: &'static str, reason: impl Into<String>) -> Self {
        Problem { kind, reason: reason.into() }
    }
    fn client(reason: impl Into<String>) -> Self {
        Self::new("git_client", reason)
    }
    /// The one message the person sees.
    pub fn message(&self, folder: &Path) -> String {
        let f = folder.display();
        match self.kind {
            "git_client" => {
                let what = if folder.join(".git").join(crate::extensions::RECORD).exists() { "This extension's folder" } else { "Your scripts folder" };
                format!("{what} needs a git client to sort this out: {}. Folder: {f}.", self.reason)
            }
            "no_git" => NO_GIT.to_string(),
            "no_identity" => NO_IDENTITY.to_string(),
            _ => self.reason.clone(),
        }
    }
}

pub const NO_GIT: &str = "Studio needs the git program to use a scripts repository, and it is not on this computer. Windows: install Git for Windows from git-scm.com. macOS: open Terminal and run xcode-select --install. Linux: install the git package (for example sudo apt install git). Then start Studio again.";
pub const NO_IDENTITY: &str = "Git does not know your name and email yet, and every backup is signed with them. Set them in your git client (or run git config --global user.name and user.email), then try again. Studio never sets them for you.";

/// What an operation did, for the person.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Done {
    pub message: String,
    /// whether files in the folder changed (Get latest brought something in)
    pub changed: bool,
}

/// How git is run: the program and extra environment (tests point both elsewhere; the app uses `git` as found
/// on PATH with the person's own settings).
#[derive(Clone, Debug)]
pub struct Git {
    pub bin: PathBuf,
    pub envs: Vec<(String, String)>,
    /// how long one command may take ([`GIT_TIMEOUT`]; [`SIGN_IN_TIMEOUT`] while a sign-in window may be open)
    pub timeout: Duration,
}

impl Default for Git {
    fn default() -> Self {
        Git { bin: "git".into(), envs: vec![], timeout: GIT_TIMEOUT }
    }
}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn spawn_reader<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = r.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    })
}

impl Git {
    /// For what runs by itself (auto save, update checks, the read-only check): only a sign-in already saved may
    /// answer; no sign-in window (Git Credential Manager), no askpass helper.
    pub fn non_interactive(&self) -> Git {
        let mut g = self.clone();
        g.timeout = GIT_TIMEOUT;
        for (k, v) in [
            ("GCM_INTERACTIVE", "never"),
            ("GIT_ASKPASS", ""),
            ("SSH_ASKPASS", ""),
            ("GIT_CONFIG_COUNT", "2"),
            ("GIT_CONFIG_KEY_0", "credential.interactive"),
            ("GIT_CONFIG_VALUE_0", "false"),
            ("GIT_CONFIG_KEY_1", "core.askPass"),
            ("GIT_CONFIG_VALUE_1", ""),
        ] {
            g.envs.push((k.into(), v.into()));
        }
        g
    }

    /// For a button the person pressed: the credential manager may show its sign-in window (a first sign-in
    /// works), and gets time for it. Git's own typed prompt stays off.
    pub fn interactive(&self) -> Git {
        let mut g = self.clone();
        g.timeout = SIGN_IN_TIMEOUT;
        g
    }

    fn command(&self, dir: &Path, args: &[&str]) -> Command {
        let mut c = Command::new(&self.bin);
        c.current_dir(dir).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // never wait for a typed answer; messages in English (they are read); no lock just for looking
        c.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C").env("LANGUAGE", "C").env("GIT_OPTIONAL_LOCKS", "0");
        for (k, v) in &self.envs {
            c.env(k, v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window flashes up
        }
        c
    }

    /// Runs git in `dir`; Err only when git could not be run at all (missing) or took too long.
    fn run(&self, dir: &Path, args: &[&str]) -> Result<Out, Problem> {
        if !dir.is_dir() {
            return Err(Problem::new("not_connected", format!("The folder {} is not there.", dir.display())));
        }
        let mut child = match self.command(dir, args).spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Problem::new("no_git", NO_GIT)),
            Err(e) => return Err(Problem::client(format!("git could not be started ({e})"))),
        };
        let (o, e) = (spawn_reader(child.stdout.take().unwrap()), spawn_reader(child.stderr.take().unwrap()));
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if start.elapsed() > self.timeout => {
                    let _ = child.kill(); // our own child process
                    let _ = child.wait();
                    return Err(Problem::client(format!("git did not finish within {} seconds (it may be waiting for a sign-in that only your git client can answer)", self.timeout.as_secs())));
                }
                Ok(None) => std::thread::sleep(POLL),
                Err(err) => return Err(Problem::client(format!("git stopped unexpectedly ({err})"))),
            }
        };
        Ok(Out { ok: status.success(), stdout: o.join().unwrap_or_default(), stderr: e.join().unwrap_or_default() })
    }

    /// Runs git and wants success; a failure becomes a Problem read from git's message.
    fn ok(&self, dir: &Path, args: &[&str]) -> Result<String, Problem> {
        let o = self.run(dir, args)?;
        if o.ok { Ok(o.stdout) } else { Err(classify(&o.stderr)) }
    }

    /// The trimmed output when git succeeds, else None.
    fn get(&self, dir: &Path, args: &[&str]) -> Result<Option<String>, Problem> {
        let o = self.run(dir, args)?;
        Ok(o.ok.then(|| o.stdout.trim().to_string()))
    }

    /// Whether git is there at all.
    pub fn available(&self) -> Result<(), Problem> {
        self.run(Path::new("."), &["--version"]).map(|_| ())
    }

    /// The network commands (fetch, push): ssh is told not to ask questions, unless the person set up their own
    /// ssh command (which is then theirs).
    fn net(&self, dir: &Path, args: &[&str]) -> Result<Out, Problem> {
        let own_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
            || std::env::var_os("GIT_SSH").is_some()
            || self.envs.iter().any(|(k, _)| k == "GIT_SSH_COMMAND" || k == "GIT_SSH")
            || self.get(dir, &["config", "--get", "core.sshCommand"])?.is_some_and(|s| !s.is_empty());
        if own_ssh {
            return self.run(dir, args);
        }
        let mut g = self.clone();
        g.envs.push(("GIT_SSH_COMMAND".into(), "ssh -o BatchMode=yes".into()));
        g.run(dir, args)
    }
}

/// Anything like `https://user:secret@host/...` loses the part before `@` (an address with a token in it is
/// never shown or logged).
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest.find(|c: char| c.is_whitespace() || c == '/' || c == '\'' || c == '"').unwrap_or(rest.len());
        if let Some(at) = rest[..end].rfind('@') {
            rest = &rest[at + 1..];
        }
    }
    out.push_str(rest);
    out
}

/// A git error message, in plain words.
fn classify(stderr: &str) -> Problem {
    let s = stderr.to_lowercase();
    let has = |p: &[&str]| p.iter().any(|x| s.contains(x));
    if has(&["host key verification failed"]) {
        return Problem::client("this computer has not connected to that server before; connect once with your git client so it can check the server");
    }
    if has(&["authentication failed", "could not read username", "could not read password", "permission denied (publickey", "terminal prompts disabled", "the requested url returned error: 403", "the requested url returned error: 401", "repository not found", "access denied", "invalid username or password"]) {
        return Problem::client("the repository did not accept your sign-in, or it does not exist. Sign in to it once with your git client, then try again");
    }
    if has(&["could not resolve host", "failed to connect", "network is unreachable", "connection timed out", "connection refused", "operation timed out", "temporary failure in name resolution", "could not resolve hostname"]) {
        return Problem::new("offline", "Could not reach the scripts repository. Check the internet connection and try again.");
    }
    if has(&["does not appear to be a git repository", "not a git repository"]) {
        return Problem::client("that address is not a git repository, or it cannot be read");
    }
    let last = stderr.lines().map(str::trim).rfind(|l| !l.is_empty() && !l.starts_with("hint:")).unwrap_or("git stopped with an error");
    Problem::client(format!("git said \"{}\"", redact(last.trim_start_matches("fatal: ").trim_start_matches("error: "))))
}

/// Only addresses git fetches from in the usual ways: https, ssh (`ssh://` or `git@host:path`) and `file://`.
/// An address with a password or token in it is refused: the person's credential helper keeps those.
pub fn check_url(url: &str) -> Result<(), Problem> {
    let u = url.trim();
    let bad = |r: &str| Err(Problem::new("bad_url", r.to_string()));
    if u.is_empty() {
        return bad("Type the repository's address first (it starts with https:// or git@).");
    }
    if u.starts_with('-') || u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad("That does not look like a repository address (it starts with https:// or git@).");
    }
    if let Some((scheme, rest)) = u.split_once("://") {
        let scheme = scheme.to_lowercase();
        if !["https", "ssh", "file"].contains(&scheme.as_str()) {
            return bad("Use an https://, ssh:// or git@ address (Studio does not use other kinds).");
        }
        let auth = &rest[..rest.find('/').unwrap_or(rest.len())];
        if let Some(at) = auth.rfind('@') {
            let user = &auth[..at];
            if scheme == "https" || user.contains(':') {
                return bad("Take the user name and password (or token) out of the address. Studio uses the sign-in your git client already keeps.");
            }
        }
        return Ok(());
    }
    // scp-like: user@host:path
    let ok = u.split_once(':').is_some_and(|(left, path)| {
        let host_ok = left.rsplit_once('@').map(|(user, host)| !user.is_empty() && !user.contains(':') && !host.is_empty()).unwrap_or(false);
        host_ok && !path.is_empty() && left.chars().all(|c| c.is_ascii_alphanumeric() || "@._-".contains(c))
    });
    if ok { Ok(()) } else { bad("Use the repository's https:// or git@ address (for example https://github.com/you/my-props.git).") }
}

/// What a person types for a repository, as the address git clones:
/// `owner/repo` or `github:owner/repo` (GitHub), `gitlab:group/sub/repo` (GitLab, nested groups allowed),
/// `bitbucket:owner/repo` (Bitbucket); anything else is a full git address (https or ssh, any server).
pub fn expand_source(text: &str) -> Result<String, Problem> {
    let t = text.trim();
    let bad = || Problem::new("bad_url", "Type owner/repo (GitHub), gitlab:group/repo, bitbucket:owner/repo, or the repository's full https:// or git@ address.".to_string());
    let segs_ok = |p: &str, min: usize, max: usize| {
        let parts: Vec<&str> = p.trim_end_matches(".git").split('/').collect();
        parts.len() >= min
            && parts.len() <= max
            && parts.iter().all(|s| !s.is_empty() && *s != "." && *s != ".." && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
    };
    let host = |h: &str, p: &str, max: usize| -> Result<String, Problem> {
        if segs_ok(p, 2, max) { Ok(format!("https://{h}/{}.git", p.trim_end_matches(".git"))) } else { Err(bad()) }
    };
    if let Some(p) = t.strip_prefix("github:") {
        return host("github.com", p, 2);
    }
    if let Some(p) = t.strip_prefix("gitlab:") {
        return host("gitlab.com", p, 20);
    }
    if let Some(p) = t.strip_prefix("bitbucket:") {
        return host("bitbucket.org", p, 2);
    }
    if !t.contains(':') && segs_ok(t, 2, 2) {
        return host("github.com", t, 2);
    }
    check_url(t)?;
    Ok(t.to_string())
}

/// The folder a repository is cloned into: its name ("my-props"), else `owner-name` when that is taken. The
/// same repository gets the same folder on every computer, so script names (`<folder>/<script>`) match.
pub fn folder_for(url: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let clean = |s: &str| -> String { s.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).collect::<String>().trim_matches(|c| c == '.' || c == '-').to_string() };
    let full = repo_name(url);
    let mut parts = full.rsplit('/');
    let name = clean(parts.next().unwrap_or("scripts"));
    let name = if name.is_empty() { "scripts".to_string() } else { name };
    if !taken(&name) {
        return name;
    }
    let owner = parts.next().map(clean).unwrap_or_default();
    let both = if owner.is_empty() { name.clone() } else { format!("{owner}-{name}") };
    if !taken(&both) {
        return both;
    }
    (2..).map(|n| format!("{both}-{n}")).find(|c| !taken(c)).unwrap()
}

/// Whether two addresses name the same repository (case, a trailing slash and `.git` aside).
pub fn same_repo(a: &str, b: &str) -> bool {
    same_url(a, b)
}

/// "owner/name" from a repository address (the status line's name).
pub fn repo_name(url: &str) -> String {
    let u = redact(url.trim()).trim_end_matches('/').trim_end_matches(".git").to_string();
    let path = match u.split_once("://") {
        Some((_, r)) => r.split_once('/').map(|(_, p)| p.to_string()).unwrap_or_default(),
        None => u.split_once(':').map(|(_, p)| p.to_string()).unwrap_or(u.clone()),
    };
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => u,
        1 => parts[0].to_string(),
        n => format!("{}/{}", parts[n - 2], parts[n - 1]),
    }
}

fn same_url(a: &str, b: &str) -> bool {
    let n = |s: &str| s.trim().trim_end_matches('/').trim_end_matches(".git").to_lowercase();
    n(a) == n(b)
}

/// The folder's git dir, when the folder itself is the top of a working copy (not a folder inside another one).
fn git_dir(git: &Git, dir: &Path) -> Result<Option<PathBuf>, Problem> {
    let Some(top) = git.get(dir, &["rev-parse", "--show-toplevel"])? else { return Ok(None) };
    let same = match (dunce::canonicalize(&top), dunce::canonicalize(dir)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same {
        return Ok(None);
    }
    Ok(git.get(dir, &["rev-parse", "--absolute-git-dir"])?.map(PathBuf::from))
}

/// Writes Studio's lines into `.git/info/exclude` once (the person's own lines stay).
fn ensure_excludes(gd: &Path) -> Result<(), Problem> {
    let f = gd.join("info").join("exclude");
    let now = std::fs::read_to_string(&f).unwrap_or_default();
    if now.contains(EXCLUDE_MARK) {
        return Ok(());
    }
    let mut s = now;
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(EXCLUDE_MARK);
    s.push('\n');
    for e in EXCLUDES {
        s.push_str(e);
        s.push('\n');
    }
    std::fs::create_dir_all(gd.join("info")).and_then(|_| std::fs::write(&f, s)).map_err(|e| Problem::client(format!("cannot write {} ({e})", f.display())))
}

/// The state every operation starts from: a working copy with a branch and an `origin`, nothing half-done.
struct Ready {
    gd: PathBuf,
    branch: String,
    url: String,
}

fn ready(git: &Git, dir: &Path) -> Result<Ready, Problem> {
    let gd = git_dir(git, dir)?.ok_or_else(|| Problem::new("not_connected", "This folder is not connected to a scripts repository yet (Settings)."))?;
    for (f, what) in [("rebase-merge", "a rebase"), ("rebase-apply", "a rebase"), ("MERGE_HEAD", "a merge"), ("CHERRY_PICK_HEAD", "a cherry-pick"), ("REVERT_HEAD", "a revert")] {
        if gd.join(f).exists() {
            return Err(Problem::client(format!("{what} was started and not finished")));
        }
    }
    let branch = git.get(dir, &["symbolic-ref", "-q", "--short", "HEAD"])?.filter(|b| !b.is_empty()).ok_or_else(|| Problem::client("the folder is not on a branch (detached HEAD)"))?;
    if !git.ok(dir, &["ls-files", "-u"])?.trim().is_empty() {
        return Err(Problem::client("some files still have unresolved conflicts"));
    }
    let url = git.get(dir, &["remote", "get-url", "origin"])?.ok_or_else(|| Problem::new("not_connected", "This folder has no repository to back up to (no \"origin\"). Connect one in Settings."))?;
    Ok(Ready { gd, branch, url })
}

fn remote_ref(r: &Ready) -> String {
    format!("refs/remotes/origin/{}", r.branch)
}

fn has_ref(git: &Git, dir: &Path, r: &str) -> Result<bool, Problem> {
    Ok(git.get(dir, &["rev-parse", "--verify", "-q", r])?.is_some())
}

fn head(git: &Git, dir: &Path) -> Result<Option<String>, Problem> {
    git.get(dir, &["rev-parse", "--verify", "-q", "HEAD"])
}

/// Files changed in the folder and not committed (each path once).
fn dirty(git: &Git, dir: &Path) -> Result<Vec<String>, Problem> {
    let s = git.ok(dir, &["status", "--porcelain", "-z", "-uall"])?;
    let mut out = vec![];
    let mut it = s.split('\0').filter(|x| !x.is_empty());
    while let Some(e) = it.next() {
        if e.len() > 3 {
            out.push(e[3..].to_string());
        }
        if e.starts_with('R') || e.starts_with('C') {
            it.next(); // the old name of a rename
        }
    }
    Ok(out)
}

fn fetch(git: &Git, dir: &Path) -> Result<(), Problem> {
    let o = git.net(dir, &["fetch", "--quiet", "origin"])?;
    if o.ok { Ok(()) } else { Err(classify(&o.stderr)) }
}

/// Points the (new, empty) branch at the repository's and keeps every file in the folder: the index takes the
/// repository's files (a mixed reset: the working files are not touched), then files that are only in the
/// repository are written out. Files on both sides keep the folder's copy (the next backup records it).
fn adopt(git: &Git, dir: &Path, branch: &str) -> Result<(), Problem> {
    git.ok(dir, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
    git.ok(dir, &["reset", "-q", &format!("refs/remotes/origin/{branch}"), "--"])?;
    let _ = git.get(dir, &["branch", "-q", &format!("--set-upstream-to=origin/{branch}")])?;
    let missing: Vec<String> = git.ok(dir, &["ls-files", "-z", "--deleted"])?.split('\0').filter(|s| !s.is_empty()).map(String::from).collect();
    for chunk in missing.chunks(PATHS_PER_CALL) {
        let mut args = vec!["checkout", "-q", "--"];
        args.extend(chunk.iter().map(String::as_str));
        git.ok(dir, &args)?;
    }
    Ok(())
}

/// The repository's main branch after a fetch: its HEAD when git can tell, else main, master or the first one.
fn remote_default(git: &Git, dir: &Path) -> Result<Option<String>, Problem> {
    let _ = git.net(dir, &["remote", "set-head", "origin", "--auto"])?;
    if let Some(h) = git.get(dir, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])? {
        if let Some(b) = h.strip_prefix("origin/") {
            return Ok(Some(b.to_string()));
        }
    }
    let refs = git.ok(dir, &["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"])?;
    let list: Vec<&str> = refs.lines().map(str::trim).filter(|l| !l.is_empty() && *l != "HEAD").collect();
    Ok(["main", "master"].iter().find(|b| list.contains(b)).map(|b| b.to_string()).or_else(|| list.first().map(|s| s.to_string())))
}

/// What Connect will do with this folder (before asking): how many of the person's files are in it, and
/// whether it is already a working copy (and of what).
pub fn preview(git: &Git, dir: &Path) -> Result<Value, Problem> {
    git.available()?;
    let files = count_files(dir);
    let (repo, origin) = match std::fs::metadata(dir).is_ok().then(|| git_dir(git, dir)).transpose()?.flatten() {
        Some(_) => (true, git.get(dir, &["remote", "get-url", "origin"])?),
        None => (false, None),
    };
    Ok(json!({ "files": files, "repo": repo, "origin": origin.map(|o| redact(&o)) }))
}

/// The person's files in the folder (not Studio's hidden `.specter` working files, not empty folders).
fn count_files(dir: &Path) -> usize {
    fn walk(d: &Path, root: bool, n: &mut usize) {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if root && (name == ".git" || name == ".specter" || name == "platformio.ini" || name == "make_envs.py" || name == "project_src.py") {
                continue;
            }
            match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path(), false, n),
                Ok(_) => *n += 1,
                Err(_) => {}
            }
        }
    }
    let mut n = 0;
    walk(dir, true, &mut n);
    n
}

/// Makes `dir` a working copy of `url`. A folder that is empty (or only holds Studio's empty folders) simply
/// receives the repository; a folder with files keeps every one of them (see [`adopt`]). Never deletes a file.
pub fn connect(git: &Git, dir: &Path, url: &str) -> Result<Done, Problem> {
    check_url(url)?;
    let url = url.trim();
    git.available()?;
    std::fs::create_dir_all(dir).map_err(|e| Problem::client(format!("cannot make the folder ({e})")))?;
    if let Some(gd) = git_dir(git, dir)? {
        return match git.get(dir, &["remote", "get-url", "origin"])? {
            Some(o) if same_url(&o, url) => {
                ensure_excludes(&gd)?;
                Ok(Done { message: format!("Connected to {}.", repo_name(url)), changed: false })
            }
            Some(o) => Err(Problem::client(format!("this folder is already a copy of another repository ({})", redact(&o)))),
            None => {
                git.ok(dir, &["remote", "add", "origin", url])?;
                ensure_excludes(&gd)?;
                fetch(git, dir)?;
                if head(git, dir)?.is_none() {
                    if let Some(b) = remote_default(git, dir)? {
                        adopt(git, dir, &b)?;
                    }
                }
                Ok(Done { message: format!("Connected to {}. Press Get latest or Back up everything.", repo_name(url)), changed: true })
            }
        };
    }
    git.ok(dir, &["init", "-q"])?;
    let gd = git_dir(git, dir)?.ok_or_else(|| Problem::client("git init did not make a working copy"))?;
    let undo = |p: Problem| {
        // only the .git folder made a moment ago goes: the person's files were never touched
        let _ = std::fs::remove_dir_all(&gd);
        p
    };
    git.ok(dir, &["remote", "add", "origin", url]).map_err(undo)?;
    ensure_excludes(&gd).map_err(undo)?;
    fetch(git, dir).map_err(undo)?;
    match remote_default(git, dir).map_err(undo)? {
        Some(b) => adopt(git, dir, &b).map_err(undo)?,
        None => {
            // an empty repository: the first backup fills it
            git.ok(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]).map_err(undo)?;
        }
    }
    Ok(Done { message: format!("Connected to {}.", repo_name(url)), changed: true })
}

/// Fetch, then fast-forward. With `allow_rebase` (the library), the folder's own commits are replayed on top of
/// the repository's with a plain rebase; a conflict aborts it, so the folder is exactly as before. Plugins use
/// it without (pull only).
pub fn get_latest(git: &Git, dir: &Path, allow_rebase: bool) -> Result<Done, Problem> {
    let r = ready(git, dir)?;
    ensure_excludes(&r.gd)?;
    fetch(git, dir)?;
    let rr = remote_ref(&r);
    if !has_ref(git, dir, &rr)? {
        return Ok(Done { message: "The repository has nothing in it yet.".into(), changed: false });
    }
    let Some(before) = head(git, dir)? else {
        // a folder connected while the repository was empty, which has since been filled from elsewhere
        adopt(git, dir, &r.branch)?;
        return Ok(Done { message: "Got the latest from the repository.".into(), changed: true });
    };
    let counts = git.ok(dir, &["rev-list", "--left-right", "--count", &format!("HEAD...{rr}")])?;
    let mut it = counts.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
    let (ahead, behind) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    if behind == 0 {
        return Ok(Done { message: "Already up to date.".into(), changed: false });
    }
    let new = format!("{behind} new change{}", if behind == 1 { "" } else { "s" });
    if ahead == 0 {
        let o = git.run(dir, &["merge", "--ff-only", "-q", &rr])?;
        if !o.ok {
            if o.stderr.contains("would be overwritten") {
                return Err(back_up_first(allow_rebase));
            }
            return Err(classify(&o.stderr));
        }
        return Ok(Done { message: format!("Got the latest: {new}."), changed: true });
    }
    if !allow_rebase {
        return Err(Problem::client("this folder has commits of its own that the repository does not have"));
    }
    if !dirty(git, dir)?.is_empty() {
        return Err(back_up_first(true));
    }
    let o = git.run(dir, &["rebase", "-q", &rr])?;
    if o.ok {
        return Ok(Done { message: format!("Got the latest: {new}."), changed: true });
    }
    let conflicted: Vec<String> = git.get(dir, &["diff", "--name-only", "--diff-filter=U"])?.unwrap_or_default().lines().map(String::from).collect();
    let aborted = git.run(dir, &["rebase", "--abort"])?;
    let back = head(git, dir)?.as_deref() == Some(before.as_str()) && !r.gd.join("rebase-merge").exists() && !r.gd.join("rebase-apply").exists();
    if !aborted.ok || !back {
        return Err(Problem::client("the latest changes could not be combined with yours, and git could not put the folder back by itself"));
    }
    Err(Problem::client(if conflicted.is_empty() {
        "your changes and the repository's changes could not be combined automatically".to_string()
    } else {
        format!("your changes and the repository's changes touch the same lines in {}", conflicted.join(", "))
    }))
}

fn back_up_first(can: bool) -> Problem {
    if can {
        Problem::new("back_up_first", "You changed files that the repository has newer versions of. Press Back up everything: it saves your changes first, then brings in the latest.")
    } else {
        Problem::client("files in this folder were changed here and in the repository")
    }
}

/// Whether git knows who is committing (the person's own setting; Studio never sets or makes one up, and
/// git would otherwise invent one from the computer's name).
fn identity(git: &Git, dir: &Path) -> Result<(), Problem> {
    let name = git.get(dir, &["config", "--get", "user.name"])?.unwrap_or_default();
    let email = git.get(dir, &["config", "--get", "user.email"])?.unwrap_or_default();
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err(Problem::new("no_identity", NO_IDENTITY));
    }
    Ok(())
}

/// "Studio backup: 3 scripts changed" (only effect scripts) or "Studio backup: 4 files changed".
pub fn commit_message(paths: &[String]) -> String {
    let n = paths.len();
    let scripts = paths.iter().all(|p| p.starts_with("effects/"));
    let noun = if scripts { "script" } else { "file" };
    format!("Studio backup: {n} {noun}{} changed", if n == 1 { "" } else { "s" })
}

enum Push {
    Ok,
    Rejected,
}

pub const NO_WRITE: &str = "Studio cannot back up to this source: you may not have permission to change it, or your git client is not signed in to it. It is read-only here: Get latest still works, and Save a copy to… puts a script into one of your own sources.";

/// A push git refused because of who is asking (no permission, not signed in), as opposed to the network.
fn push_problem(stderr: &str) -> Problem {
    let s = stderr.to_lowercase();
    let p = classify(stderr);
    let denied = ["permission to", "denied to", "write access", "not allowed to push", "pre-receive hook declined", "protected branch", "you are not allowed", "403"].iter().any(|x| s.contains(x));
    if p.kind != "offline" && (denied || p.reason.starts_with("the repository did not accept your sign-in")) {
        return Problem::new("no_write", NO_WRITE);
    }
    p
}

pub fn is_read_only(dir: &Path) -> bool {
    dir.join(".git").join(READ_ONLY_FILE).exists()
}

fn set_read_only(dir: &Path, on: bool) {
    let f = dir.join(".git").join(READ_ONLY_FILE);
    if on {
        let _ = std::fs::write(f, "Studio could not push here\n");
    } else {
        let _ = std::fs::remove_file(f);
    }
}

/// Whether Studio can push here, by a dry run (nothing is sent); a source it cannot push to is marked
/// read-only. Being offline proves nothing and changes nothing.
pub fn check_write(git: &Git, dir: &Path) -> Result<bool, Problem> {
    let r = ready(git, dir)?;
    if head(git, dir)?.is_none() {
        set_read_only(dir, false); // nothing to try with yet: the first backup tells
        return Ok(true);
    }
    // only a sign-in already saved may answer
    let o = git.non_interactive().net(dir, &["push", "--dry-run", "--porcelain", "origin", &format!("HEAD:refs/heads/{}", r.branch)])?;
    let rejected_only = o.stdout.lines().any(|l| l.starts_with('!'));
    if o.ok || rejected_only {
        set_read_only(dir, false); // allowed in (a rejection only says the repository moved on)
        return Ok(true);
    }
    let p = push_problem(&o.stderr);
    if p.kind == "no_write" {
        set_read_only(dir, true);
        return Ok(false);
    }
    Err(p)
}

/// How many commits the repository has that this folder does not (fetches; changes no file).
pub fn behind(git: &Git, dir: &Path) -> Result<u64, Problem> {
    let r = ready(git, dir)?;
    fetch(git, dir)?;
    let rr = remote_ref(&r);
    if !has_ref(git, dir, &rr)? {
        return Ok(0);
    }
    if head(git, dir)?.is_none() {
        return Ok(git.ok(dir, &["rev-list", "--count", &rr])?.trim().parse().unwrap_or(0));
    }
    Ok(git.ok(dir, &["rev-list", "--count", &format!("HEAD..{rr}")])?.trim().parse().unwrap_or(0))
}

/// The short commit the folder is at ("" before the first one).
pub fn commit(git: &Git, dir: &Path) -> String {
    git.get(dir, &["rev-parse", "--short", "HEAD"]).ok().flatten().unwrap_or_default()
}

fn push(git: &Git, dir: &Path, branch: &str) -> Result<Push, Problem> {
    let o = git.net(dir, &["push", "--porcelain", "-u", "origin", &format!("HEAD:refs/heads/{branch}")])?;
    if o.ok {
        return Ok(Push::Ok);
    }
    // porcelain: "!\tHEAD:refs/heads/main\t[rejected] (fetch first)"
    let rejected = o.stdout.lines().any(|l| l.starts_with('!') && (l.contains("[rejected]") || l.contains("fetch first") || l.contains("non-fast-forward")))
        || o.stderr.contains("[rejected]")
        || o.stderr.contains("fetch first");
    if rejected { Ok(Push::Rejected) } else { Err(push_problem(&o.stderr)) }
}

/// Add all, commit with a plain message, push; a rejected push gets the latest once, then pushes again.
pub fn backup(git: &Git, dir: &Path) -> Result<Done, Problem> {
    let r = ready(git, dir)?;
    if is_read_only(dir) {
        return Err(Problem::new("no_write", NO_WRITE));
    }
    ensure_excludes(&r.gd)?;
    let changed = dirty(git, dir)?;
    if !changed.is_empty() {
        identity(git, dir)?;
        git.ok(dir, &["add", "-A"])?;
        let staged: Vec<String> = git.ok(dir, &["diff", "--cached", "--name-only", "-z"])?.split('\0').filter(|s| !s.is_empty()).map(String::from).collect();
        if !staged.is_empty() {
            git.ok(dir, &["commit", "-q", "-m", &commit_message(&staged)])?;
        }
    }
    let mut brought = false;
    let pushed = push(git, dir, &r.branch).inspect_err(|p| {
        if p.kind == "no_write" {
            set_read_only(dir, true);
        }
    })?;
    match pushed {
        Push::Ok => {}
        Push::Rejected => {
            brought = get_latest(git, dir, true)?.changed;
            if let Push::Rejected = push(git, dir, &r.branch)? {
                return Err(Problem::client("the repository changed again while Studio was backing up"));
            }
        }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(r.gd.join(LAST_BACKUP_FILE), now.to_string());
    let what = if changed.is_empty() { "nothing new to save".to_string() } else { commit_message(&changed).trim_start_matches("Studio backup: ").to_string() };
    Ok(Done { message: format!("Backed up to {}: {what}{}.", repo_name(&r.url), if brought { " (and got the latest first)" } else { "" }), changed: brought })
}

/// The status line: repository name, branch, files not backed up, last backup (no network).
pub fn status(git: &Git, dir: &Path) -> Value {
    let base = |problem: Option<Problem>| json!({ "connected": false, "problem": problem, "message": problem_msg(&problem, dir) });
    match git.available().and_then(|_| git_dir(git, dir)) {
        Err(p) => return base(Some(p)),
        Ok(None) => return base(None),
        Ok(Some(_)) => {}
    }
    let r = match ready(git, dir) {
        Ok(r) => r,
        Err(p) => {
            let url = git.get(dir, &["remote", "get-url", "origin"]).ok().flatten();
            let mut v = base(Some(p.clone()));
            if let Some(u) = url {
                v["connected"] = json!(p.kind != "not_connected");
                v["repo"] = json!(repo_name(&u));
                v["url"] = json!(redact(&u));
            }
            return v;
        }
    };
    let mut files: std::collections::BTreeSet<String> = dirty(git, dir).unwrap_or_default().into_iter().collect();
    let rr = remote_ref(&r);
    let unpushed = if has_ref(git, dir, &rr).unwrap_or(false) {
        git.get(dir, &["diff", "--name-only", &format!("{rr}..HEAD")]).ok().flatten()
    } else if head(git, dir).ok().flatten().is_some() {
        git.get(dir, &["ls-tree", "-r", "--name-only", "HEAD"]).ok().flatten()
    } else {
        None
    };
    files.extend(unpushed.unwrap_or_default().lines().filter(|l| !l.is_empty()).map(String::from));
    // seconds since 1970 (the UI shows it in local time)
    let last = std::fs::read_to_string(r.gd.join(LAST_BACKUP_FILE)).ok().and_then(|s| s.trim().parse::<u64>().ok());
    json!({ "connected": true, "repo": repo_name(&r.url), "url": redact(&r.url), "branch": r.branch, "changes": files.len(), "last_backup": last, "read_only": is_read_only(dir), "commit": commit(git, dir), "problem": null })
}

fn problem_msg(p: &Option<Problem>, dir: &Path) -> Option<String> {
    p.as_ref().map(|p| p.message(dir))
}

/// The answer the UI gets for an operation: `{ok, message, changed, problem, status}`.
pub fn answer(git: &Git, dir: &Path, r: Result<Done, Problem>) -> Value {
    let status = status(git, dir);
    match r {
        Ok(d) => json!({ "ok": true, "message": d.message, "changed": d.changed, "status": status }),
        Err(p) => json!({ "ok": false, "message": p.message(dir), "problem": p, "status": status }),
    }
}

/// Runs the last of a burst of pokes once the burst has been quiet for `quiet` (auto save after saves).
/// Never blocks the caller: each poke starts a timer task, and only the newest one still runs when it ends.
#[derive(Clone)]
pub struct Debouncer {
    gen: Arc<AtomicU64>,
    pub quiet: Duration,
}

impl Debouncer {
    pub fn new(quiet: Duration) -> Self {
        Debouncer { gen: Arc::new(AtomicU64::new(0)), quiet }
    }
    /// Starts (or restarts) the quiet time; `run` happens only if no other poke comes before it ends.
    pub fn poke<F, Fut>(&self, run: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let me = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        let (gen, quiet) = (self.gen.clone(), self.quiet);
        tokio::spawn(async move {
            tokio::time::sleep(quiet).await;
            if gen.load(Ordering::SeqCst) == me {
                run().await;
            }
        });
    }
    /// Forgets a pending run (auto save turned off).
    pub fn cancel(&self) {
        self.gen.fetch_add(1, Ordering::SeqCst);
    }
}

/// The script sources inside Studio: one git operation at a time (a click and an auto save never run together),
/// and auto save per source after saves.
pub struct Scripts {
    git: std::sync::Mutex<Git>,
    lock: Arc<tokio::sync::Mutex<()>>,
    /// the source folders auto save is on for
    auto: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
    debounce: std::sync::Mutex<std::collections::HashMap<PathBuf, Debouncer>>,
    quiet: std::sync::Mutex<Duration>,
}

impl Default for Scripts {
    fn default() -> Self {
        Scripts { git: Default::default(), lock: Default::default(), auto: Default::default(), debounce: Default::default(), quiet: std::sync::Mutex::new(AUTO_SAVE_QUIET) }
    }
}

impl Scripts {
    /// Tests: another git (program, environment) and another quiet time.
    pub fn configure(&self, git: Git, quiet: Duration) {
        *self.git.lock().unwrap() = git;
        *self.quiet.lock().unwrap() = quiet;
        self.debounce.lock().unwrap().clear();
    }
    pub fn git(&self) -> Git {
        self.git.lock().unwrap().clone()
    }
    /// Runs one operation on `dir` (after any running one), off the async threads; the answer for the UI is
    /// also sent as an event (`auto`: started by auto save), so every place showing the status follows.
    /// A button the person pressed: the credential manager's sign-in window is allowed.
    pub async fn run<F>(&self, dir: PathBuf, auto: bool, events: &tokio::sync::broadcast::Sender<crate::Event>, op: F) -> Value
    where
        F: FnOnce(&Git, &Path) -> Result<Done, Problem> + Send + 'static,
    {
        run_locked(self.lock.clone(), self.git().interactive(), dir, auto, events.clone(), op).await
    }
    /// Any blocking git work, after any running operation (no event). Started by the person (adding a source or
    /// an extension): a sign-in window is allowed; checks that run by themselves use `non_interactive()`.
    pub async fn with<T: Send + 'static>(&self, f: impl FnOnce(&Git) -> T + Send + 'static) -> Result<T, String> {
        let _one_at_a_time = self.lock.clone().lock_owned().await;
        let git = self.git().interactive();
        tokio::task::spawn_blocking(move || f(&git)).await.map_err(|e| e.to_string())
    }
    /// The source folders auto save is on for (the others' pending auto saves are dropped).
    pub fn set_auto(&self, dirs: Vec<PathBuf>) {
        let keep: std::collections::HashSet<PathBuf> = dirs.into_iter().collect();
        for (d, deb) in self.debounce.lock().unwrap().iter() {
            if !keep.contains(d) {
                deb.cancel();
            }
        }
        *self.auto.lock().unwrap() = keep;
    }
    /// A source that is going away: no auto save for it any more.
    pub fn forget(&self, dir: &Path) {
        self.auto.lock().unwrap().remove(dir);
        if let Some(d) = self.debounce.lock().unwrap().remove(dir) {
            d.cancel();
        }
    }
    /// Something in the source `dir` was saved in Studio: with auto save on for it, back up once things are quiet.
    pub fn saved(&self, dir: &Path, events: &tokio::sync::broadcast::Sender<crate::Event>) {
        if !self.auto.lock().unwrap().contains(dir) || is_read_only(dir) {
            return;
        }
        let quiet = *self.quiet.lock().unwrap();
        let deb = self.debounce.lock().unwrap().entry(dir.to_path_buf()).or_insert_with(|| Debouncer::new(quiet)).clone();
        // auto save never opens a sign-in window
        let (lock, git, dir, events) = (self.lock.clone(), self.git().non_interactive(), dir.to_path_buf(), events.clone());
        deb.poke(move || async move {
            run_locked(lock, git, dir, true, events, backup).await;
        });
    }
}

async fn run_locked<F>(lock: Arc<tokio::sync::Mutex<()>>, git: Git, dir: PathBuf, auto: bool, events: tokio::sync::broadcast::Sender<crate::Event>, op: F) -> Value
where
    F: FnOnce(&Git, &Path) -> Result<Done, Problem> + Send + 'static,
{
    let _one_at_a_time = lock.lock_owned().await;
    let folder = dir.to_string_lossy().into_owned();
    let v = tokio::task::spawn_blocking(move || {
        let r = op(&git, &dir);
        answer(&git, &dir, r)
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "message": format!("the backup stopped unexpectedly ({e})") }));
    let _ = events.send(crate::Event::ScriptsRepo { folder, auto, result: v.clone() });
    v
}
