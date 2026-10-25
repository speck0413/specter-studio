//! Fleet work: the release manifest, over-the-air updates (`POST /api/v1/update`) and backups
//! (`.proptroller.json` files in a folder).

use crate::{conn::Conn, discover::normalise, Event};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

pub const MANIFEST: &str = "proptroller-firmware.json";

/// Where firmware comes from when the person has not chosen anything: the public firmware repository's GitHub
/// releases. Each release carries `proptroller-firmware.json` and the images it lists as release assets.
pub const DEFAULT_SOURCE: &str = "https://github.com/speck0413/specter-proptroller/releases";

/// Repositories that were renamed: `(owner, old name, new name)`. A source saved with the old name keeps working
/// (GitHub redirects too, but a redirect stops working the day someone takes the old name).
const RENAMED: &[(&str, &str, &str)] = &[("speck0413", "spectre-proptroller", "specter-proptroller")];

/// Firmware is fetched only over https, or from a folder on this computer: a release list or an image over plain
/// http could be swapped on the way (the SHA-256 comes from the same list).
pub const NOT_HTTPS: &str = "firmware is downloaded only over https, or from a folder on this computer";

/// The public key that signs the official release manifests (32 bytes, hex), or None while releases are not
/// signed yet. When set, a manifest is taken only with a valid detached signature next to it
/// (`proptroller-firmware.json.sig`: 64 bytes, hex), docs/DESIGN.md "Firmware releases".
pub const RELEASE_KEY: Option<&str> = None;

/// The answer when a release source has nothing published yet: nothing for the person to fix.
pub const NO_RELEASE: &str = "there is no firmware release there yet";

/// GitHub refused: too many checks from this network in the last hour.
pub const RATE_LIMITED: &str = "GitHub is not answering firmware checks right now (too many in the last hour): try again later";

/// What the person sees when a web release list cannot be reached.
pub const OFFLINE: &str = "Checking for firmware updates needs the internet. Without it, download a release folder and choose it in Settings (Advanced).";

/// The release source to use: `source`, or the default when it is empty.
pub fn source_or_default(source: Option<&str>) -> &str {
    match source.map(str::trim) {
        Some(s) if !s.is_empty() => s,
        _ => DEFAULT_SOURCE,
    }
}

/// `(owner, repo)` when `source` names a GitHub repository's releases: `https://github.com/<owner>/<repo>/releases`
/// or the API's `https://api.github.com/repos/<owner>/<repo>/releases`.
pub fn github_repo(source: &str) -> Option<(String, String)> {
    let s = source.trim().trim_end_matches('/');
    let rest = s.strip_prefix("https://github.com/").or_else(|| s.strip_prefix("https://api.github.com/repos/"))?;
    let mut parts = rest.split('/');
    let (owner, mut repo) = (parts.next()?, parts.next()?);
    if let Some(r) = RENAMED.iter().find(|r| r.0.eq_ignore_ascii_case(owner) && r.1.eq_ignore_ascii_case(repo)) {
        repo = r.2;
    }
    let tail: Vec<&str> = parts.collect();
    let ok = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (ok(owner) && ok(repo) && (tail.is_empty() || tail == ["releases"] || tail == ["releases", "latest"])).then(|| (owner.to_string(), repo.to_string()))
}

/// The GitHub API's address (`SPECTER_GITHUB_API` replaces it in tests, so they never reach the internet).
fn github_api() -> String {
    std::env::var("SPECTER_GITHUB_API").unwrap_or_else(|_| "https://api.github.com".into()).trim_end_matches('/').to_string()
}

/// `Ok` for an address firmware may come from: https, or (only in tests, when `SPECTER_GITHUB_API` points at a
/// stand-in) plain http on this computer.
pub fn web_url_ok(url: &str) -> Result<(), String> {
    let u = url.trim().to_ascii_lowercase();
    if u.starts_with("https://") {
        return Ok(());
    }
    let local = ["http://127.0.0.1:", "http://127.0.0.1/", "http://localhost:", "http://localhost/"].iter().any(|p| u.starts_with(p));
    if local && std::env::var_os("SPECTER_GITHUB_API").is_some() {
        return Ok(());
    }
    Err(format!("{NOT_HTTPS} ({url})"))
}

fn web_client() -> Result<reqwest::Client, String> {
    // GitHub's API refuses requests without a User-Agent; a redirect is followed only to another https address
    reqwest::Client::builder()
        .user_agent(concat!("SpecterStudio/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() >= 10 {
                a.error("too many redirects")
            } else if web_url_ok(a.url().as_str()).is_ok() {
                a.follow()
            } else {
                a.error(NOT_HTTPS)
            }
        }))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

async fn get_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    web_url_ok(url)?;
    let r = client.get(url).header("Accept", "application/vnd.github+json, application/json").send().await.map_err(|e| {
        if e.is_redirect() { NOT_HTTPS.to_string() } else { OFFLINE.to_string() }
    })?;
    match r.status().as_u16() {
        200..=299 => Ok(r.bytes().await.map_err(|_| OFFLINE.to_string())?.to_vec()),
        404 => Err(NO_RELEASE.into()),
        403 | 429 => Err(RATE_LIMITED.into()),
        c => Err(format!("cannot fetch the release list (the server answered {c})")),
    }
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    serde_json::from_slice(&get_bytes(client, url).await?).map_err(|_| "the release list is not JSON".to_string())
}

/// Checks a manifest's detached ed25519 signature against `key` (both hex). `Ok` only for a valid signature.
pub fn verify_signature(manifest: &[u8], sig_hex: &str, key_hex: &str) -> Result<(), String> {
    let sig = hex::decode(sig_hex.trim()).map_err(|_| "the release signature is not hex".to_string())?;
    let key = hex::decode(key_hex.trim()).map_err(|_| "the release key is not hex".to_string())?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(manifest, &sig)
        .map_err(|_| "the release list's signature is not valid: Studio does not trust it".to_string())
}

/// With [`RELEASE_KEY`] set: the manifest is taken only with a valid signature (`sig` is the `.sig` file's text,
/// None when there is none). Without a key: every manifest is taken (releases are not signed yet).
fn check_signed(manifest: &[u8], sig: Option<String>) -> Result<(), String> {
    match RELEASE_KEY {
        None => Ok(()),
        Some(key) => verify_signature(manifest, &sig.ok_or("the release list is not signed: Studio does not trust it")?, key),
    }
}

/// The release to use from GitHub's list (newest first), among those that carry a manifest (drafts never).
/// `betas` off (Settings "Allow betas", the default): the newest full release, or, while there is none, the newest
/// pre-release (owner 2026-10-24: release candidates stay pre-releases; a new user never meets "nothing to
/// install"). `betas` on: the highest version of all, a pre-release or a full release, whichever is newer.
pub fn pick_release(list: &Value, betas: bool) -> Option<&Value> {
    let with_manifest = |r: &&Value| r["draft"] != true && r["assets"].as_array().is_some_and(|a| a.iter().any(|x| x["name"] == MANIFEST));
    let all: Vec<&Value> = list.as_array().into_iter().flatten().filter(with_manifest).collect();
    let full = all.iter().find(|r| r["prerelease"] != true).copied();
    if !betas {
        return full.or_else(|| all.first().copied());
    }
    let tag = |r: &Value| r["tag_name"].as_str().unwrap_or("").to_string();
    all.iter().copied().reduce(|best, r| if newer(&tag(r), &tag(best)) { r } else { best })
}

/// The GitHub release [`pick_release`] chooses: the manifest, with each image's download address as `url` and the
/// release's `tag`, `page` and `prerelease`.
async fn github_manifest(owner: &str, repo: &str, betas: bool) -> Result<Value, String> {
    let client = web_client()?;
    let list = get_json(&client, &format!("{}/repos/{owner}/{repo}/releases?per_page=20", github_api())).await?;
    let rel = pick_release(&list, betas).ok_or(NO_RELEASE)?;
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    let url_of = |name: &str| assets.iter().find(|x| x["name"] == name).and_then(|x| x["browser_download_url"].as_str()).map(String::from);
    let raw = get_bytes(&client, &url_of(MANIFEST).unwrap_or_default()).await?;
    let sig = match (RELEASE_KEY, url_of(&format!("{MANIFEST}.sig"))) {
        (Some(_), Some(u)) => get_bytes(&client, &u).await.ok().map(|b| String::from_utf8_lossy(&b).into_owned()),
        _ => None,
    };
    check_signed(&raw, sig)?;
    let mut m: Value = serde_json::from_slice(&raw).map_err(|_| "the release list is not JSON".to_string())?;
    if let Some(imgs) = m["images"].as_array_mut() {
        for img in imgs {
            if let Some(u) = img["file"].as_str().and_then(url_of) {
                img["url"] = json!(u);
            }
        }
    }
    m["tag"] = rel["tag_name"].clone();
    m["page"] = rel["html_url"].clone();
    m["prerelease"] = json!(rel["prerelease"] == true);
    Ok(m)
}

/// Resolved GitHub manifests (and "nothing published yet"), a few minutes each: every board's check would
/// otherwise ask GitHub again (60 unauthenticated requests an hour). One request at a time, so boards checking
/// together share one answer.
static GITHUB_CACHE: std::sync::Mutex<Vec<(String, Instant, Result<Value, String>)>> = std::sync::Mutex::new(Vec::new());
static GITHUB_FETCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const GITHUB_CACHE_FOR: Duration = Duration::from_secs(300);

/// The newest release: `source` is a folder holding `proptroller-firmware.json` and the images, the URL of that
/// file, or a GitHub repository's releases page (the default, [`DEFAULT_SOURCE`]: the newest release that has the
/// manifest as an asset, see PROTOCOL.md "Releases"). An empty source means the default.
/// Manifest: `{"version": "0.2.0", "images": [{"fw","impl","mcu","file","bytes","sha256"}]}`.
pub async fn manifest(source: &str) -> Result<Value, String> {
    manifest_with(source, false).await
}

/// [`manifest`], with pre-releases allowed when `betas` is on (Settings "Allow betas"; GitHub sources only: a
/// folder or a web address holds one list).
pub async fn manifest_with(source: &str, betas: bool) -> Result<Value, String> {
    let source = source_or_default(Some(source));
    let m: Value = if let Some((owner, repo)) = github_repo(source) {
        let key = format!("{}/{owner}/{repo}{}", github_api(), if betas { "#betas" } else { "" });
        let _one = GITHUB_FETCH.lock().await;
        let hit = GITHUB_CACHE.lock().unwrap().iter().find(|(k, t, _)| *k == key && t.elapsed() < GITHUB_CACHE_FOR).map(|x| x.2.clone());
        let r = match hit {
            Some(r) => r,
            None => {
                let r = github_manifest(&owner, &repo, betas).await;
                // offline answers are asked again next time; a release, "none yet" and "too many" are remembered
                if r.as_ref().map_or_else(|e| e == NO_RELEASE || e == RATE_LIMITED, |_| true) {
                    let mut c = GITHUB_CACHE.lock().unwrap();
                    c.retain(|(k, _, _)| *k != key);
                    c.push((key, Instant::now(), r.clone()));
                }
                r
            }
        };
        r?
    } else if source.starts_with("http://") || source.starts_with("https://") {
        let client = web_client()?;
        let raw = get_bytes(&client, source).await?;
        let sig = if RELEASE_KEY.is_some() { get_bytes(&client, &format!("{source}.sig")).await.ok().map(|b| String::from_utf8_lossy(&b).into_owned()) } else { None };
        check_signed(&raw, sig)?;
        serde_json::from_slice(&raw).map_err(|_| "the release list is not JSON".to_string())?
    } else {
        let p = manifest_path(source);
        let s = std::fs::read_to_string(&p).map_err(|_| format!("there is no {MANIFEST} in {source}"))?;
        let mut sp = p.clone().into_os_string();
        sp.push(".sig");
        check_signed(s.as_bytes(), std::fs::read_to_string(sp).ok())?;
        serde_json::from_str(&s).map_err(|e| format!("{MANIFEST} is not valid JSON: {e}"))?
    };
    if !m["version"].is_string() || !m["images"].is_array() {
        return Err(format!("{MANIFEST} needs \"version\" and \"images\""));
    }
    Ok(m)
}

/// Forgets resolved GitHub manifests ("Check now" in Settings, tests).
pub fn forget_cached_releases() {
    GITHUB_CACHE.lock().unwrap().clear();
}

fn manifest_path(source: &str) -> PathBuf {
    let p = Path::new(source);
    if p.is_dir() { p.join(MANIFEST) } else { p.to_path_buf() }
}

/// The board package (BSP) a board or a list entry names (`board`); firmware and lists from before the field
/// count as the Proptroller board.
pub const DEFAULT_BOARD: &str = "proptroller";

pub fn board_of(v: &Value) -> &str {
    v["board"].as_str().filter(|b| !b.is_empty()).unwrap_or(DEFAULT_BOARD)
}

/// The image in the manifest that suits a board (its `info`): same `fw`, `fw_impl`, `board` and `mcu`.
/// A board still on the retired Rust implementation gets the C++ image (an implementation switch: the app
/// backs the board up first and restores it after, PROTOCOL.md "Releases").
pub fn image_for<'a>(manifest: &'a Value, info: &Value) -> Option<&'a Value> {
    let imgs = manifest["images"].as_array()?;
    // the over-the-air image: first-flash images (USB, "first_flash": true) for the same board are never offered
    // a board on a board package (boardpkg.rs) also takes the image of the Proptroller board (the generic image for
    // its chip) when its firmware takes packages (its stored package stays), or when that image has the board's
    // package built in (`presets`); else it is offered nothing over the air (boardpkg::ota_blocked says why)
    let board = board_of(info);
    let generic_fits = |i: &Value| {
        board_of(i) == DEFAULT_BOARD && (crate::boardpkg::takes_packages(info) || crate::boardpkg::presets_of(i).iter().any(|p| p["id"] == board))
    };
    let pick = |imp: &Value| {
        let same = |i: &&Value| i["first_flash"] != true && i["fw"] == info["fw"] && i["impl"] == *imp && i["mcu"] == info["mcu"];
        imgs.iter().filter(same).find(|i| board_of(i) == board).or_else(|| imgs.iter().filter(same).find(|i| generic_fits(i)))
    };
    pick(&info["fw_impl"]).or_else(|| if info["fw_impl"] == "rust" { pick(&json!("cpp")) } else { None })
}

/// "0.10.1" > "0.9.3": numeric parts compared in order, then the pre-release as semantic versioning does:
/// "0.1.0" > "0.1.0-rc.2" > "0.1.0-rc.1" (a release candidate comes before its release; build metadata after
/// `+` is ignored).
pub fn newer(a: &str, b: &str) -> bool {
    use std::cmp::Ordering;
    let split = |s: &str| -> (Vec<u64>, Option<String>) {
        let s = s.trim().trim_start_matches('v');
        let s = s.split('+').next().unwrap_or("");
        let (core, pre) = match s.split_once('-') { Some((c, p)) => (c, Some(p.to_string())), None => (s, None) };
        (core.split('.').map(|p| p.parse().unwrap_or(0)).collect(), pre)
    };
    let pre_cmp = |x: &str, y: &str| -> Ordering {
        let (xs, ys): (Vec<&str>, Vec<&str>) = (x.split('.').collect(), y.split('.').collect());
        for (p, q) in xs.iter().zip(ys.iter()) {
            let o = match (p.parse::<u64>(), q.parse::<u64>()) {
                (Ok(m), Ok(n)) => m.cmp(&n),
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                _ => p.cmp(q),
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        xs.len().cmp(&ys.len())
    };
    let ((ca, pa), (cb, pb)) = (split(a), split(b));
    match ca.cmp(&cb) {
        Ordering::Equal => match (pa, pb) {
            (None, None) => false,
            (None, Some(_)) => true,
            (Some(_), None) => false,
            (Some(x), Some(y)) => pre_cmp(&x, &y) == Ordering::Greater,
        },
        o => o == Ordering::Greater,
    }
}

/// The bytes of a manifest entry, checked against its `sha256`.
pub async fn fetch_image(source: &str, image: &Value) -> Result<Vec<u8>, String> {
    let source = source_or_default(Some(source));
    let file = image["file"].as_str().ok_or("the image has no file")?;
    // an image is installed only when the release list says what it must be
    let want = image["sha256"].as_str().filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| format!("{file} has no SHA-256 in the release list, so Studio does not install it"))?;
    let web = |url: String| async move {
        web_url_ok(&url)?;
        let r = web_client()?.get(url).send().await.map_err(|e| if e.is_redirect() { NOT_HTTPS.to_string() } else { OFFLINE.to_string() })?;
        if !r.status().is_success() {
            return Err(format!("cannot download {file} (the server answered {})", r.status().as_u16()));
        }
        Ok::<_, String>(r.bytes().await.map_err(|_| OFFLINE.to_string())?.to_vec())
    };
    let bytes = if github_repo(source).is_some() {
        // a GitHub release: the image's own asset address (from `manifest`), so it comes from the same release
        web(image["url"].as_str().ok_or_else(|| format!("the release has no file called {file}"))?.to_string()).await?
    } else if source.starts_with("http") {
        let base = source.rsplit_once('/').map(|x| x.0).unwrap_or(source);
        web(format!("{base}/{file}")).await?
    } else {
        let dir = manifest_path(source).parent().map(Path::to_path_buf).unwrap_or_default();
        std::fs::read(dir.join(file)).map_err(|e| format!("cannot read {file}: {e}"))?
    };
    if sha256_hex(&bytes) != want.to_lowercase() {
        return Err(format!("{file} does not match its SHA-256 in the release list"));
    }
    Ok(bytes)
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

async fn info(client: &reqwest::Client, base: &str) -> Option<Value> {
    client.get(format!("{base}/api/v1/info")).send().await.ok()?.json().await.ok()
}

/// The board's `info` over plain HTTP (it answers while its session is still coming back after a restart),
/// tried for up to 10 s.
pub async fn board_info(address: &str) -> Result<Value, String> {
    let base = normalise(address);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
    for _ in 0..20 {
        if let Some(i) = info(&client, &base).await {
            return Ok(i);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("the board does not answer".into())
}

/// Sends an image and follows the board through its restart: the answer is `valid` (the new image passed its
/// self-check), `rolled_back` or an error. Progress goes out as `Event::Update`. `pin` is the page password.
pub async fn update(
    key: &str,
    address: &str,
    image: Vec<u8>,
    pin: Option<String>,
    events: &broadcast::Sender<Event>,
) -> Result<Value, String> {
    let base = normalise(address);
    let progress = |phase: &str, detail: Value| {
        let _ = events.send(Event::Update { key: key.to_string(), phase: phase.to_string(), detail });
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let before = info(&client, &base).await.ok_or("the board does not answer")?;
    let up = before.get("update").ok_or("this board takes no over-the-air updates")?;
    let max = up["max_bytes"].as_u64().unwrap_or(u64::MAX);
    if image.len() as u64 > max {
        return Err(format!("the image is too big: {} bytes, this board takes at most {max}", image.len()));
    }
    let wait_s = up["install_max_s"].as_u64().unwrap_or(0) + 60;
    progress("sending", json!({ "bytes": image.len() }));
    let mut req = client
        .post(format!("{base}/api/v1/update"))
        .header("Content-Type", "application/octet-stream")
        .header("X-Proptroller-Sha256", sha256_hex(&image));
    if let Some(p) = pin {
        req = req.header("X-Proptroller-Pin", p);
    }
    let resp: Value = req.body(image).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    if resp["ok"] != true {
        let msg = resp["error"]["message"].as_str().unwrap_or("the board refused the update").to_string();
        progress("failed", json!({ "message": msg }));
        // "pin: ..." tells the app to ask for the page password and try again
        return Err(if resp["error"]["code"] == "pin" { format!("pin: {msg}") } else { msg });
    }
    progress("restarting", json!({ "wait_s": wait_s }));
    // the new image boots pending; then valid after its self-check, or the board rolls back
    let deadline = Instant::now() + Duration::from_secs(wait_s + 120);
    let mut seen_new = false;
    let mut seen_off = false; // the board went away (restarting): from then on rolled_back is news
    let was_rolled_back = up["rolled_back"] == true;
    let poll = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    while Instant::now() < deadline {
        let Some(i) = info(&poll, &base).await else {
            seen_off = true;
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        };
        {
            let st = &i["update"];
            if st["rolled_back"] == true && (!was_rolled_back || seen_off || seen_new) {
                progress("rolled_back", json!({ "fw_version": i["fw_version"] }));
                return Ok(json!({ "result": "rolled_back", "info": i }));
            }
            let changed = i["fw_build"] != before["fw_build"] || i["fw_version"] != before["fw_version"];
            // the board was valid before (a pending board refuses updates), so pending is the new image
            if st["state"] == "pending" {
                if !seen_new {
                    progress("checking", json!({ "fw_version": i["fw_version"] }));
                }
                seen_new = true;
            } else if st["state"] == "valid" && (seen_new || changed) {
                progress("valid", json!({ "fw_version": i["fw_version"] }));
                return Ok(json!({ "result": "valid", "info": i }));
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    progress("failed", json!({ "message": "the board did not come back" }));
    Err("the board did not come back after the update".into())
}

/// An update that switches the firmware implementation (the two store their records differently): the
/// board is backed up to `<workspace>/.specter/backups/` on disk first (never only in memory), updated, and
/// restored from that file once the new image runs. The answer carries the backup's path.
pub async fn switch_update(
    conn: std::sync::Arc<Conn>,
    key: &str,
    address: &str,
    image: Vec<u8>,
    workspace: &str,
    pin: Option<String>,
    events: &broadcast::Sender<Event>,
) -> Result<Value, String> {
    let dir = Path::new(workspace).join(".specter").join("backups");
    let saved = backup(&conn, &dir.to_string_lossy(), None).await.map_err(|e| format!("the board could not be backed up before the switch, nothing was changed: {e}"))?;
    // until the board has its setup back, the backup is listed as waiting to be restored (`switch_pending`):
    // a crash, a closed window or a failed restore never leaves it forgotten in a hidden folder
    let name = conn.rpc(json!({ "op": "info" })).await.ok().and_then(|i| i["result"]["name"].as_str().map(String::from)).unwrap_or_default();
    pending_set(workspace, &saved, Some(json!({ "path": saved, "key": key, "name": name, "since": stamp() })));
    let mut r = update(key, address, image, pin.clone(), events).await?;
    if r["result"] == "rolled_back" {
        pending_set(workspace, &saved, None); // the old firmware still has its setup
    }
    if r["result"] == "valid" {
        // the session reconnects after the restart
        let mut last = String::new();
        for _ in 0..40 {
            match restore(&conn, &saved, true, pin.clone()).await {
                Ok(_) => { last.clear(); break; }
                Err(e) => last = e,
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if !last.is_empty() {
            return Err(format!("the new firmware runs, but restoring the board's setup failed ({last}); it is saved in {saved}"));
        }
        pending_set(workspace, &saved, None);
    }
    r["backup"] = json!(saved);
    Ok(r)
}

fn pending_file(workspace: &str) -> PathBuf {
    Path::new(workspace).join(".specter").join("backups").join("waiting-to-restore.json")
}

/// Adds (`Some`) or removes (`None`) a backup waiting to be restored after an implementation switch.
pub fn pending_set(workspace: &str, path: &str, entry: Option<Value>) {
    let f = pending_file(workspace);
    let mut list: Vec<Value> = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.retain(|e| e["path"] != path);
    list.extend(entry);
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = crate::library::write_atomic(&f, serde_json::to_string_pretty(&list).unwrap_or_default().as_bytes());
}

/// Backups taken before an implementation switch whose restore never finished (the app closed or crashed, or
/// the restore failed): `[{path, key, name, since}]`, only those whose file is still there.
pub fn pending(workspace: &str) -> Vec<Value> {
    let list: Vec<Value> = std::fs::read_to_string(pending_file(workspace)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.into_iter().filter(|e| e["path"].as_str().is_some_and(|p| Path::new(p).exists())).collect()
}

/// "2026-10-21-203501" from the system clock (UTC), for file names.
pub fn stamp() -> String {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = ((s / 86400) as i64, s % 86400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn safe(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    if t.is_empty() { "board".into() } else { t }
}

/// A file-name time from the UI, `YYYY-MM-DD-HHMMSS` in the person's own time zone (the device layer has no time
/// zone table); anything else is ignored and the UTC [`stamp`] is used.
pub fn local_stamp(now: Option<&str>) -> String {
    match now {
        Some(t) if t.len() == 17 && t.char_indices().all(|(i, c)| if matches!(i, 4 | 7 | 10) { c == '-' } else { c.is_ascii_digit() }) => t.to_string(),
        _ => stamp(),
    }
}

/// Saves the board's `get_backup` as `<folder>/<name>-<id>-<time>.proptroller.json`; `now`: the local time from
/// the UI ([`local_stamp`]), so the name matches the time the backup list shows.
pub async fn backup(conn: &Conn, folder: &str, now: Option<&str>) -> Result<String, String> {
    let r = conn.rpc(json!({ "op": "get_backup" })).await?;
    if r["ok"] != true {
        return Err(r["error"]["message"].as_str().unwrap_or("the board refused").into());
    }
    let data = &r["result"]["data"];
    let name = format!(
        "{}-{}-{}.proptroller.json",
        safe(data["name"].as_str().unwrap_or("board")),
        safe(data["from"]["id"].as_str().unwrap_or("")),
        local_stamp(now)
    );
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let path = Path::new(folder).join(name);
    crate::library::write_atomic(&path, serde_json::to_string_pretty(data).unwrap().as_bytes())?;
    Ok(path.to_string_lossy().into())
}

/// Every backup in a folder, newest first: `{path, name, id, file}`.
pub fn list_backups(folder: &str) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".proptroller.json"))
        .filter_map(|e| {
            let p = e.path();
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
            let modified = e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            Some(json!({ "path": p.to_string_lossy(), "file": e.file_name().to_string_lossy(), "modified": modified,
                         "name": v["name"], "id": v["from"]["id"], "fw_version": v["from"]["fw_version"] }))
        })
        .collect();
    out.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    out
}

pub async fn restore(conn: &Conn, path: &str, keep_name: bool, pin: Option<String>) -> Result<Value, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let data: Value = serde_json::from_str(&s).map_err(|_| "the file is not a backup (not JSON)".to_string())?;
    let mut req = json!({ "op": "put_backup", "data": data, "keep_name": keep_name });
    if let Some(p) = pin {
        req["pin"] = json!(p);
    }
    let r = conn.rpc(req).await?;
    if r["ok"] != true {
        let msg = r["error"]["message"].as_str().unwrap_or("the board refused").to_string();
        return Err(if r["error"]["code"] == "pin" { format!("pin: {msg}") } else { msg });
    }
    Ok(r["result"].clone())
}
