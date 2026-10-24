//! The Tauri shell: one command (`dispatch`) into the device layer, its events out as `studio-event`, and
//! the `plugin://` scheme that serves plugin folders. Everything else lives in `studio-core`.

use std::sync::Arc;
use studio_core::Studio;
use tauri::{Emitter, Manager, RunEvent};

/// SPECTER_TEST_LOG (tests only): every dispatched command and plugin file request is appended to this file,
/// so a test can prove what a plugin frame could and could not reach.
fn test_log(line: &str) {
    if let Some(p) = std::env::var_os("SPECTER_TEST_LOG") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{line}");
        }
    }
}

#[tauri::command]
async fn dispatch(studio: tauri::State<'_, Arc<Studio>>, cmd: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    test_log(&format!("dispatch {cmd}"));
    if cmd == "startup" {
        // SPECTER_OPEN_PLUGIN opens a plugin's page at start (tests and demos)
        return Ok(serde_json::json!({ "open_plugin": std::env::var("SPECTER_OPEN_PLUGIN").ok() }));
    }
    studio.dispatch(&cmd, args).await
}

pub fn run() {
    let studio = Arc::new(Studio::new());
    let for_scheme = studio.clone();
    let for_exit = studio.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(studio.clone())
        .register_uri_scheme_protocol("plugin", move |_ctx, req| {
            // plugin://localhost/<id>/<path>
            test_log(&format!("plugin-file {}", req.uri()));
            let path = studio_core::plugins::percent_decode(req.uri().path().trim_start_matches('/'));
            let (id, rel) = path.split_once('/').unwrap_or((&path, "index.html"));
            let dirs = for_scheme.plugin_dirs.lock().unwrap().clone();
            match studio_core::plugins::file(&dirs, id, rel) {
                Some((body, mime)) => {
                    let mut r = tauri::http::Response::builder().header("Content-Type", mime);
                    for (k, v) in studio_core::plugins::plugin_headers() {
                        r = r.header(k, v);
                    }
                    r.body(body).unwrap()
                }
                None => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
        .setup(move |app| {
            // the bundled firmware library and workspace template (desktop builds; development uses the submodule)
            if let Ok(res) = app.path().resource_dir() {
                let ard = res.join("firmware/arduino");
                if ard.join("lib/proptroller").is_dir() && std::env::var_os("SPECTER_FIRMWARE_DIR").is_none() {
                    std::env::set_var("SPECTER_FIRMWARE_DIR", ard);
                }
            }
            // the generic release that comes with Studio (scripts/bundle-firmware.py; core fwtypes::bundled_dir)
            if std::env::var_os("SPECTER_BUNDLED_FIRMWARE").is_none() {
                let bundled = app.path().resource_dir().ok().map(|r| r.join("bundled-firmware")).filter(|b| b.join("proptroller-firmware.json").is_file());
                // `tauri dev`: the development build's folder (scripts/ensure-sim.sh makes it)
                let dev = cfg!(debug_assertions).then(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("bundled-firmware"));
                if let Some(b) = bundled.or(dev.filter(|d| d.join("proptroller-firmware.json").is_file())) {
                    std::env::set_var("SPECTER_BUNDLED_FIRMWARE", b);
                }
            }
            if let Some(g) = std::env::var_os("SPECTER_GUIDES_DIR").or_else(|| app.path().resource_dir().ok().map(|d| d.join("wiring-guides").into_os_string())) {
                if std::path::Path::new(&g).is_dir() && std::env::var_os("SPECTER_GUIDES_DIR").is_none() {
                    std::env::set_var("SPECTER_GUIDES_DIR", &g);
                }
            }
            if let Ok(dir) = app.path().app_config_dir() {
                studio.plugin_dirs.lock().unwrap().push(dir.join("plugins"));
                // extensions added from git (Extensions page)
                studio.set_extensions_dir(dir.join("extensions"));
                // automation rules, counters and timers (no secrets: those are in the keychain)
                studio.automation.set_config_dir(dir.clone());
            }
            if let Ok(extra) = std::env::var("SPECTER_STUDIO_PLUGINS") {
                studio.plugin_dirs.lock().unwrap().extend(std::env::split_paths(&extra));
            }
            let handle = app.handle().clone();
            let mut rx = studio.events();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => { let _ = handle.emit("studio-event", ev); }
                        // events were dropped (an online/offline or update among them, perhaps): the UI reads again
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => { let _ = handle.emit("studio-event", studio_core::Event::Resync); }
                        Err(_) => break,
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .build(tauri::generate_context!())
        .expect("error while starting Specter Studio")
        .run(move |_, e| {
            // practice boards and serial monitors stop with the app
            if let RunEvent::Exit = e {
                for_exit.shutdown();
            }
        });
}
