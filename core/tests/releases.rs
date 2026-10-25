//! The default firmware release source (the public repository's GitHub releases), against a stand-in for
//! GitHub on this computer: nothing here reaches the internet.

use serde_json::{json, Value};
use studio_core::fleet::{self, github_repo, source_or_default, DEFAULT_SOURCE, OFFLINE};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[test]
fn source_names() {
    assert_eq!(source_or_default(None), DEFAULT_SOURCE);
    assert_eq!(source_or_default(Some("  ")), DEFAULT_SOURCE);
    assert_eq!(source_or_default(Some("/media/usb/release")), "/media/usb/release");
    let want = Some(("speck0413".to_string(), "specter-proptroller".to_string()));
    assert_eq!(github_repo(DEFAULT_SOURCE), want);
    assert_eq!(DEFAULT_SOURCE, "https://github.com/speck0413/specter-proptroller/releases");
    // the repository's old name keeps working
    assert_eq!(github_repo("https://github.com/speck0413/spectre-proptroller/releases"), want);
    assert_eq!(github_repo("https://github.com/speck0413/specter-proptroller/releases/"), want);
    assert_eq!(github_repo("https://github.com/speck0413/specter-proptroller"), want);
    assert_eq!(github_repo("https://api.github.com/repos/speck0413/spectre-proptroller/releases"), want);
    // a direct manifest address or a folder is not a repository
    assert_eq!(github_repo("https://github.com/speck0413/spectre-proptroller/releases/latest/download/proptroller-firmware.json"), None);
    assert_eq!(github_repo("/srv/release"), None);
    assert_eq!(github_repo("https://example.com/speck0413/spectre-proptroller/releases"), None);
}

/// A tiny HTTP server: path -> (status, body), with "BASE" in a body replaced by the server's own address.
/// Every request it saw is sent to the receiver.
async fn serve(routes: Vec<(String, u16, Vec<u8>)>) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let me0 = base.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            let routes = routes.clone();
            let tx = tx.clone();
            let me = me0.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                let ua = req.lines().any(|l| l.to_ascii_lowercase().starts_with("user-agent: specterstudio/"));
                let _ = tx.send(format!("{path} ua={ua}"));
                let (code, body) = routes.iter().find(|r| r.0 == path).map(|r| (r.1, r.2.clone())).unwrap_or((404, b"{}".to_vec()));
                let body = match String::from_utf8(body.clone()) { Ok(t) => t.replace("BASE", &me).into_bytes(), Err(_) => body };
                // a 301's body is its Location (a renamed repository)
                let loc = if code == 301 { format!("Location: {}\r\n", String::from_utf8_lossy(&body)) } else { String::new() };
                let head = format!("HTTP/1.1 {code} X\r\n{loc}Content-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(&body).await;
            });
        }
    });
    (base, rx)
}

#[tokio::test]
async fn github_releases_default_source() {
    let img = b"not really firmware".to_vec();
    let sha = fleet::sha256_hex(&img);
    let manifest = json!({ "version": "0.3.0", "images": [
        { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "generic-esp32-0.3.0.bin", "bytes": img.len(), "sha256": sha }] });
    let releases = json!([
        // a draft is never offered, a pre-release not while there is a full release; a release without a manifest is skipped
        { "tag_name": "v0.4.0-rc1", "draft": false, "prerelease": true, "html_url": "x", "assets": [{ "name": "proptroller-firmware.json", "browser_download_url": "http://wrong/" }] },
        { "tag_name": "v0.3.1", "draft": true, "prerelease": false, "html_url": "x", "assets": [{ "name": "proptroller-firmware.json", "browser_download_url": "http://wrong/" }] },
        { "tag_name": "docs", "draft": false, "prerelease": false, "html_url": "x", "assets": [] },
        { "tag_name": "v0.3.0", "draft": false, "prerelease": false, "html_url": "https://github.com/speck0413/spectre-proptroller/releases/tag/v0.3.0", "assets": [
            { "name": "proptroller-firmware.json", "browser_download_url": "BASE/dl/v0.3.0/proptroller-firmware.json" },
            { "name": "generic-esp32-0.3.0.bin", "browser_download_url": "BASE/dl/v0.3.0/generic-esp32-0.3.0.bin" }] },
    ]);
    let releases = releases.to_string();
    let routes = vec![
        ("/repos/speck0413/specter-proptroller/releases?per_page=20".to_string(), 200, releases.into_bytes()),
        ("/dl/v0.3.0/proptroller-firmware.json".to_string(), 200, manifest.to_string().into_bytes()),
        ("/dl/v0.3.0/generic-esp32-0.3.0.bin".to_string(), 200, img.clone()),
        ("/repos/someone/empty/releases?per_page=20".to_string(), 200, b"[]".to_vec()),
        ("/repos/someone/renamed/releases?per_page=20".to_string(), 301, b"BASE/repos/someone/empty/releases?per_page=20".to_vec()),
        ("/repos/someone/limited/releases?per_page=20".to_string(), 403, b"{}".to_vec()),
        // only release candidates (pre-releases) so far: the newest of them
        ("/repos/someone/rc-only/releases?per_page=20".to_string(), 200, json!([
            { "tag_name": "v0.2.0-rc.3", "draft": true, "prerelease": true, "html_url": "x", "assets": [{ "name": "proptroller-firmware.json", "browser_download_url": "http://wrong/" }] },
            { "tag_name": "v0.2.0-rc.2", "draft": false, "prerelease": true, "html_url": "rc2", "assets": [{ "name": "proptroller-firmware.json", "browser_download_url": "BASE/dl/rc2/proptroller-firmware.json" }] },
            { "tag_name": "v0.2.0-rc.1", "draft": false, "prerelease": true, "html_url": "rc1", "assets": [{ "name": "proptroller-firmware.json", "browser_download_url": "http://wrong/" }] },
        ]).to_string().into_bytes()),
        ("/dl/rc2/proptroller-firmware.json".to_string(), 200, json!({ "version": "0.2.0-rc.2", "images": [] }).to_string().into_bytes()),
    ];
    let (base, mut seen) = serve(routes).await;
    std::env::set_var("SPECTER_GITHUB_API", &base);

    // an empty source is the default: the newest real release with a manifest
    let m = fleet::manifest("").await.unwrap();
    assert_eq!(m["version"], "0.3.0");
    assert_eq!(m["tag"], "v0.3.0");
    assert_eq!(m["images"][0]["url"], format!("{base}/dl/v0.3.0/generic-esp32-0.3.0.bin"));
    let first = seen.recv().await.unwrap();
    assert_eq!(first, "/repos/speck0413/specter-proptroller/releases?per_page=20 ua=true", "GitHub needs a User-Agent");
    let _ = seen.recv().await; // the manifest

    // asked again within minutes: the answer is remembered (GitHub allows 60 unauthenticated requests an hour)
    let again = fleet::manifest(DEFAULT_SOURCE).await.unwrap();
    assert_eq!(again, m);
    assert!(seen.try_recv().is_err(), "no second request to GitHub");

    // boards checking at the same moment share one request
    fleet::forget_cached_releases();
    let all = futures_util::future::join_all((0..5).map(|_| fleet::manifest(""))).await;
    assert!(all.iter().all(|r| r.as_ref().unwrap()["version"] == "0.3.0"));
    let mut asked = vec![];
    while let Ok(x) = seen.try_recv() { asked.push(x); }
    assert_eq!(asked.iter().filter(|x| x.starts_with("/repos/")).count(), 1, "{asked:?}");

    // the image comes from its own asset address, checked against its SHA-256
    let info = json!({ "fw": "generic", "fw_impl": "cpp", "mcu": "esp32-devkit" });
    let pick: Value = fleet::image_for(&m, &info).unwrap().clone();
    assert_eq!(fleet::fetch_image("", &pick).await.unwrap(), img);
    let mut bad = pick.clone();
    bad["sha256"] = json!("00".repeat(32));
    assert!(fleet::fetch_image(DEFAULT_SOURCE, &bad).await.unwrap_err().contains("does not match"));

    // a manifest as tools/release.py writes it: the first-flash image of the same board is never the update
    let rel = json!({ "version": "0.4.0", "images": [
        { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "first-flash-esp32-devkit-0.4.0.bin", "bytes": 4, "sha256": "aa", "first_flash": true },
        { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "generic-esp32-devkit-0.4.0.bin", "bytes": 4, "sha256": "bb" } ] });
    assert_eq!(fleet::image_for(&rel, &info).unwrap()["file"], "generic-esp32-devkit-0.4.0.bin");

    // with the bare devkits (the firmware's BARE-DEVKIT.md), as release.py writes them: the Proptroller board's entry
    // first for each mcu, each image naming the board it starts on. A bare ESP32 DevKit gets the bare image, a
    // Proptroller board (or one from before the field) the Proptroller one; the S3 and C3 their own
    let e = |mcu: &str, board: &str, file: &str, first: bool| json!({ "fw": "generic", "impl": "cpp", "mcu": mcu, "board": board, "file": file, "bytes": 4, "sha256": "aa", "first_flash": first });
    let rel = json!({ "version": "0.5.0", "images": [
        e("esp32-devkit", "proptroller", "generic-esp32-devkit-0.5.0.bin", false),
        e("esp32-devkit", "esp32-devkit-bare", "generic-esp32-devkit-bare-0.5.0.bin", false),
        e("esp32-s3", "esp32-s3-devkit", "generic-esp32-s3-devkit-0.5.0.bin", false),
        e("esp32-c3", "esp32-c3-supermini", "generic-esp32-c3-supermini-0.5.0.bin", false),
        e("esp32-devkit", "proptroller", "first-flash-esp32-devkit-0.5.0.bin", true),
        e("esp32-devkit", "esp32-devkit-bare", "first-flash-esp32-devkit-bare-0.5.0.bin", true) ] });
    let board = |mcu: &str, b: &str| json!({ "fw": "generic", "fw_impl": "cpp", "mcu": mcu, "board": b });
    let file = |i: Value| fleet::image_for(&rel, &i).map(|x| x["file"].as_str().unwrap_or("").to_string());
    assert_eq!(file(board("esp32-devkit", "proptroller")).as_deref(), Some("generic-esp32-devkit-0.5.0.bin"));
    assert_eq!(file(info.clone()).as_deref(), Some("generic-esp32-devkit-0.5.0.bin"));
    assert_eq!(file(board("esp32-devkit", "esp32-devkit-bare")).as_deref(), Some("generic-esp32-devkit-bare-0.5.0.bin"));
    assert_eq!(file(board("esp32-s3", "esp32-s3-devkit")).as_deref(), Some("generic-esp32-s3-devkit-0.5.0.bin"));
    assert_eq!(file(board("esp32-c3", "esp32-c3-supermini")).as_deref(), Some("generic-esp32-c3-supermini-0.5.0.bin"));

    // nothing published yet / too many checks: plain words, remembered for a few minutes like a release
    assert_eq!(fleet::manifest("https://github.com/someone/empty/releases").await.unwrap_err(), fleet::NO_RELEASE);
    while seen.try_recv().is_ok() {}
    assert_eq!(fleet::manifest("https://github.com/someone/empty/releases").await.unwrap_err(), fleet::NO_RELEASE);
    assert!(seen.try_recv().is_err(), "an empty list is remembered");
    // a board's update check against a source with nothing published is calm: nothing offered, no error
    let studio = studio_core::Studio::new();
    let plan = studio.dispatch("update_plan", json!({ "source": "https://github.com/someone/empty/releases", "info": info })).await.unwrap();
    assert_eq!(plan["out_of_date"], false);
    assert_eq!(plan["none_yet"], true);
    assert_eq!(fleet::manifest("https://github.com/someone/missing/releases").await.unwrap_err(), "there is no firmware release there yet");
    // a renamed repository: GitHub's redirect is followed
    assert_eq!(fleet::manifest("https://github.com/someone/renamed/releases").await.unwrap_err(), fleet::NO_RELEASE);
    let mut asked = vec![];
    while let Ok(x) = seen.try_recv() { asked.push(x); }
    assert!(asked.iter().any(|x| x.starts_with("/repos/someone/renamed/")) && asked.iter().any(|x| x.starts_with("/repos/someone/empty/")), "{asked:?}");
    assert!(fleet::manifest("https://github.com/someone/limited/releases").await.unwrap_err().contains("try again later"));
    // no full release yet: the newest pre-release (never a draft)
    let rc = fleet::manifest("https://github.com/someone/rc-only/releases").await.unwrap();
    assert_eq!((rc["version"].as_str(), rc["tag"].as_str(), rc["prerelease"].as_bool()), (Some("0.2.0-rc.2"), Some("v0.2.0-rc.2"), Some(true)));
    assert_eq!(m["prerelease"], false);

    // offline (nothing answers): say that updates need the internet or a downloaded release folder
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed_addr = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    std::env::set_var("SPECTER_GITHUB_API", &closed_addr);
    let e = fleet::manifest("").await.unwrap_err();
    assert_eq!(e, OFFLINE);
    assert!(e.contains("needs the internet") && e.contains("release folder"));
    std::env::set_var("SPECTER_GITHUB_API", &base);
}

#[tokio::test]
async fn a_board_without_over_the_air_updates_is_told_to_use_usb() {
    let dir = std::env::temp_dir().join(format!("studio-usb-only-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("proptroller-firmware.json"), json!({ "version": "0.2.0", "images": [
        { "fw": "generic", "impl": "cpp", "mcu": "pico", "file": "p.uf2", "bytes": 1, "sha256": "aa" },
        { "fw": "generic", "impl": "cpp", "mcu": "esp32-devkit", "file": "e.bin", "bytes": 1, "sha256": "bb" }] }).to_string()).unwrap();
    let s = studio_core::Studio::new();
    let src = dir.to_string_lossy().to_string();
    let plan = |info: Value| { let s = &s; let src = src.clone(); async move { s.dispatch("update_plan", json!({ "source": src, "info": info })).await.unwrap() } };
    let p = plan(json!({ "fw": "generic", "fw_impl": "cpp", "mcu": "pico", "fw_version": "0.1.0" })).await;
    assert_eq!((p["out_of_date"].as_bool(), p["usb_update"].as_bool()), (Some(false), Some(true)), "{p}");
    let p = plan(json!({ "fw": "generic", "fw_impl": "cpp", "mcu": "esp32-devkit", "fw_version": "0.1.0", "update": { "state": "valid" } })).await;
    assert_eq!((p["out_of_date"].as_bool(), p["usb_update"].as_bool()), (Some(true), Some(false)), "{p}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_newest_full_release_else_the_newest_pre_release() {
    let m = |tag: &str, pre: bool, draft: bool| json!({ "tag_name": tag, "prerelease": pre, "draft": draft, "assets": [{ "name": "proptroller-firmware.json" }] });
    let tag = |l: Value| fleet::pick_release(&l, false).map(|r| r["tag_name"].as_str().unwrap().to_string());
    // newest first, as GitHub lists them
    assert_eq!(tag(json!([m("v2-rc.1", true, false), m("v1", false, false), m("v1-rc.1", true, false)])).as_deref(), Some("v1"));
    assert_eq!(tag(json!([m("v1-rc.3", true, true), m("v1-rc.2", true, false), m("v1-rc.1", true, false)])).as_deref(), Some("v1-rc.2"));
    assert_eq!(tag(json!([m("v1", false, true)])), None);
    assert_eq!(tag(json!([{ "tag_name": "docs", "prerelease": false, "draft": false, "assets": [] }])), None);
    assert_eq!(tag(json!([])), None);
}

/// Settings "Allow betas": off takes the newest full release (an RC only while there is no full release),
/// on takes the highest version, an RC or a full release.
#[test]
fn allow_betas_picks_the_newest_including_release_candidates() {
    let m = |tag: &str, pre: bool| json!({ "tag_name": tag, "prerelease": pre, "draft": false, "assets": [{ "name": "proptroller-firmware.json" }] });
    let tag = |l: Value, betas: bool| fleet::pick_release(&l, betas).map(|r| r["tag_name"].as_str().unwrap().to_string());
    // off, with a full release: the full release, even with a newer RC above it
    assert_eq!(tag(json!([m("v0.3.0-rc.1", true), m("v0.2.0", false)]), false).as_deref(), Some("v0.2.0"));
    // off, only RCs: the newest RC (a new user is never left with nothing to install)
    assert_eq!(tag(json!([m("v0.2.0-rc.2", true), m("v0.2.0-rc.1", true)]), false).as_deref(), Some("v0.2.0-rc.2"));
    // on, an RC newer than the full release: the RC
    assert_eq!(tag(json!([m("v0.3.0-rc.1", true), m("v0.2.0", false)]), true).as_deref(), Some("v0.3.0-rc.1"));
    // on, an RC older than the full release (published later, as GitHub lists by date): the full release
    assert_eq!(tag(json!([m("v0.2.0-rc.3", true), m("v0.2.0", false)]), true).as_deref(), Some("v0.2.0"));
    assert_eq!(tag(json!([]), true), None);
}

#[test]
fn firmware_only_over_https_or_from_a_folder() {
    // plain http is refused for any address that is not this computer (this computer only with the test stand-in)
    assert!(fleet::web_url_ok("https://github.com/x/y").is_ok());
    assert!(fleet::web_url_ok("http://example.com/proptroller-firmware.json").unwrap_err().contains("https"));
    assert!(fleet::web_url_ok("http://192.168.1.5/proptroller-firmware.json").is_err());
}

#[tokio::test]
async fn an_image_without_a_sha256_or_over_http_is_never_fetched() {
    let dir = std::env::temp_dir().join(format!("specter-rel-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.bin"), b"x").unwrap();
    let img = json!({ "fw": "generic", "impl": "cpp", "mcu": "sim", "file": "a.bin" });
    let e = fleet::fetch_image(&dir.to_string_lossy(), &img).await.unwrap_err();
    assert!(e.contains("no SHA-256"), "{e}");
    let mut ok = img.clone();
    ok["sha256"] = json!(fleet::sha256_hex(b"x"));
    assert_eq!(fleet::fetch_image(&dir.to_string_lossy(), &ok).await.unwrap(), b"x");
    assert!(fleet::manifest("http://example.com/proptroller-firmware.json").await.unwrap_err().contains("https"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn signed_manifests() {
    use ring::signature::KeyPair;
    let rng = ring::rand::SystemRandom::new();
    let pk = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
    let kp = ring::signature::Ed25519KeyPair::from_pkcs8(pk.as_ref()).unwrap();
    let key = hex::encode(kp.public_key().as_ref());
    let m = br#"{"version":"0.2.0","images":[]}"#;
    let sig = hex::encode(kp.sign(m).as_ref());
    assert!(fleet::verify_signature(m, &sig, &key).is_ok());
    assert!(fleet::verify_signature(br#"{"version":"9.9.9","images":[]}"#, &sig, &key).is_err());
    assert!(fleet::verify_signature(m, "00", &key).is_err());
}

/// Release candidates: "0.1.0-rc.1" comes before "0.1.0" and after "0.0.9"; a board on a candidate is offered
/// the release, never the same candidate again.
#[test]
fn pre_release_versions_compare_as_semver() {
    use studio_core::fleet::newer;
    assert!(newer("0.1.0", "0.1.0-rc.1"));
    assert!(!newer("0.1.0-rc.1", "0.1.0"));
    assert!(newer("0.1.0-rc.2", "0.1.0-rc.1"));
    assert!(newer("0.1.0-rc.10", "0.1.0-rc.9"));
    assert!(newer("0.1.0-rc.1", "0.0.9"));
    assert!(!newer("0.1.0-rc.1", "0.1.0-rc.1"));
    assert!(newer("0.10.1", "0.9.3"));
    assert!(!newer("0.1.0+abc", "0.1.0"));
}
