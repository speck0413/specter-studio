//! Building the user's own firmware with PlatformIO behind the scenes: one hidden PlatformIO project per
//! firmware (`<workspace>/.specter/build/<folder>/platformio.ini`, its `src_dir` the sketch folder, so the
//! `.ino` is built the Arduino way), the template's board sections (partition table, Pico bootloader linking,
//! pinned platform and library versions) and the build id `<name> v<N>` stamped in.

use crate::projects;
use crate::Event;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tokio::sync::broadcast;

/// PlatformIO's `pio`: on the PATH, or where its official installer puts it.
pub fn find_pio() -> Option<PathBuf> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let mut c: Vec<PathBuf> = std::env::var("PATH").unwrap_or_default().split(if cfg!(windows) { ';' } else { ':' }).map(|d| Path::new(d).join(if cfg!(windows) { "pio.exe" } else { "pio" })).collect();
    c.push(Path::new(&home).join(".platformio/penv/bin/pio"));
    c.push(Path::new(&home).join(".platformio/penv/Scripts/pio.exe"));
    c.into_iter().find(|p| p.is_file())
}

pub const INSTALLER_URL: &str = "https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py";

/// Installs PlatformIO with its official installer (only after the person said yes).
pub async fn install_pio() -> Result<Value, String> {
    let script = reqwest::get(INSTALLER_URL).await.map_err(|e| format!("cannot download the PlatformIO installer: {e}"))?.bytes().await.map_err(|e| e.to_string())?;
    let path = std::env::temp_dir().join("get-platformio.py");
    std::fs::write(&path, &script).map_err(|e| e.to_string())?;
    let py = if cfg!(windows) { "python" } else { "python3" };
    let out = tokio::process::Command::new(py).arg(&path).output().await.map_err(|e| format!("Python is needed to install PlatformIO: {e}"))?;
    if !out.status.success() {
        return Err(format!("the PlatformIO installer failed: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
    }
    Ok(json!({ "installed": find_pio().is_some() }))
}

/// Writes the hidden PlatformIO project of one firmware and returns its folder.
pub fn write_project(ws: &Path, project: &Value, template_dir: &Path, arduino_dir: &Path) -> Result<PathBuf, String> {
    let folder = project["folder"].as_str().ok_or("not a project")?;
    let dir = ws.join(".specter/build").join(folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let t = std::fs::read_to_string(template_dir.join("platformio.ini")).map_err(|e| format!("cannot read the template: {e}"))?;
    let mut out = format!("; Written by Specter Studio for \"{}\": do not edit (the sketch's sketch.yaml says which boards).\n", project["name"].as_str().unwrap_or(""));
    // the workspace template's own projects (below its projects line) are not this build's
    let t = t.split(projects::PROJECTS_LINE).next().unwrap_or("");
    // its project_src.py picks the source folder per env; here src_dir names the sketch and the build flags carry
    // its name and version, so a do-nothing pre-script takes its place
    let mut noop = false;
    for line in t.lines() {
        let l = line.trim();
        if l.contains("pre:project_src.py") {
            noop = true;
            out += &line.replace("pre:project_src.py", "pre:studio_build.py");
            out.push('\n');
        } else if l.starts_with("src_dir") {
            out += &format!("src_dir = {}\nbuild_dir = {}\n", Path::new(project["dir"].as_str().unwrap_or("")).display(), dir.join(".pio").display());
        } else if l.starts_with("dir = ") {
            out += &format!("dir = {}\n", arduino_dir.display());
        } else if let Some(b) = l.strip_prefix("[env:").and_then(|r| r.strip_suffix(']')) {
            out += &format!("[board_{b}]\n");
        } else if l.starts_with("default_envs") {
            out += &format!("src_dir = {}\nbuild_dir = {}\n", Path::new(project["dir"].as_str().unwrap_or("")).display(), dir.join(".pio").display());
        } else if !l.starts_with(';') {
            out += line;
            out += "\n";
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    for b in project["boards"].as_array().into_iter().flatten() {
        let env = b["env"].as_str().unwrap_or("");
        if seen.insert(env.to_string()) {
            out += &format!("\n[env:{env}]\nextends = board_{}\n", b["board"].as_str().unwrap_or(""));
        }
    }
    std::fs::write(dir.join("platformio.ini"), out).map_err(|e| e.to_string())?;
    if noop {
        std::fs::write(dir.join("studio_build.py"), "# Written by Specter Studio: the sketch folder is src_dir, its name and version come as build flags.\nImport(\"env\")  # noqa: F821\n").map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Compiler errors in plain words: `file:line:col: error: message` -> "line 12 of x.ino: message".
pub fn errors(log: &str) -> Vec<String> {
    log.lines()
        .filter_map(|l| {
            let (loc, msg) = l.split_once(": error: ").or_else(|| l.split_once(": fatal error: "))?;
            let mut parts = loc.rsplitn(3, ':');
            let (_col, line, file) = (parts.next()?, parts.next()?, parts.next()?);
            let file = Path::new(file).file_name()?.to_string_lossy().replace(".ino.cpp", ".ino");
            Some(format!("line {line} of {file}: {msg}"))
        })
        .collect()
}

/// The board environment a board's `mcu` needs.
pub fn board_for_mcu(mcu: &str) -> Option<&'static str> {
    Some(match mcu {
        "esp32-devkit" => "esp32dev",
        "pico-w" => "picow",
        "pico2-w" => "pico2w",
        "pico" => "pico",
        _ => return None,
    })
}

/// Builds `name` for `board` (an environment board such as `esp32dev`, or the sketch's default) and raises
/// its version when the build succeeds. Output lines go out as `Event::Build`.
pub fn build(ws: &Path, name: &str, board: Option<&str>, events: &broadcast::Sender<Event>) -> Result<Value, String> {
    let ard = crate::arduino_dir().ok_or("the firmware library is not installed")?;
    let pio = find_pio().ok_or("PlatformIO is not installed")?;
    let project = projects::projects(ws).into_iter().find(|p| p["name"] == name).ok_or_else(|| format!("there is no firmware called \"{name}\""))?;
    let env = match board {
        Some(b) => project["boards"].as_array().into_iter().flatten().find(|x| x["board"] == b).map(|x| x["env"].clone()).ok_or_else(|| {
            format!("“{name}” is not set up for this kind of board. Add it to the boards in its sketch.yaml.")
        })?,
        None => project["default_env"].clone(),
    };
    let env = env.as_str().ok_or("the sketch.yaml names no board")?.to_string();
    // the board sections: the firmware's workspace-template (current firmware), else its older template/
    let wt = ard.join("workspace-template");
    let template = if wt.join("platformio.ini").exists() { wt } else { ard.join("template") };
    let dir = write_project(ws, &project, &template, &ard)?;
    let next = project["version"].as_u64().unwrap_or(0) + 1;
    let id = format!("{name} v{next}");
    let mut child = Command::new(pio)
        .args(["run", "-e", &env])
        .current_dir(&dir)
        // the same flags as the firmware's workspace build (project_src.py): the sketch names itself and its version
        .env("PLATFORMIO_BUILD_FLAGS", format!(
            "-DPROPTROLLER_FW_BUILD='\"{id}\"' -DPROPTROLLER_FW_NAME='\"{}\"' -DPROPTROLLER_FW_VERSION='\"{next}\"'",
            project["folder"].as_str().unwrap_or("")))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start PlatformIO: {e}"))?;
    let err = child.stderr.take().unwrap();
    let ev = events.clone();
    let p = name.to_string();
    let err_thread = std::thread::spawn(move || BufReader::new(err).lines().map_while(Result::ok).inspect(|l| { let _ = ev.send(Event::Build { project: p.clone(), line: l.clone() }); }).collect::<Vec<_>>().join("\n"));
    let mut log = String::new();
    for l in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        let _ = events.send(Event::Build { project: name.to_string(), line: l.clone() });
        log += &l;
        log.push('\n');
    }
    log += &err_thread.join().unwrap_or_default();
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if !ok {
        let errs = errors(&log);
        return Err(if errs.is_empty() { "the build failed (see the build log)".into() } else { format!("the build failed: {}", errs.join("; ")) });
    }
    projects::bump(ws, name)?;
    let out = dir.join(".pio").join(&env);
    let board = project["boards"].as_array().into_iter().flatten().find(|x| x["env"] == env.as_str()).map(|x| x["board"].clone()).unwrap_or_default();
    Ok(json!({ "build_id": id, "env": env, "board": board, "out": out.to_string_lossy(), "image": out.join("firmware.bin").to_string_lossy(), "log": log }))
}

/// The firmware's `firmware/arduino` where the Pico bootloader can be built: the firmware folder itself when it
/// can be written to (development), else a copy in the user's cache (an installed app's resources are
/// read-only).
fn writable_firmware(ard: &Path) -> Result<PathBuf, String> {
    if std::fs::create_dir_all(ard.join(".pio")).is_ok() && tempfile_ok(&ard.join(".pio")) {
        return Ok(ard.to_path_buf());
    }
    let home = std::env::var("HOME").or_else(|_| std::env::var("LOCALAPPDATA")).unwrap_or_default();
    let cache = Path::new(&home).join(".cache/specter-studio/firmware-arduino");
    for sub in ["lib", "src/picoboot", "tools"] {
        copy_dir(&ard.join(sub), &cache.join(sub))?;
    }
    std::fs::copy(ard.join("platformio.ini"), cache.join("platformio.ini")).map_err(|e| e.to_string())?;
    Ok(cache)
}

fn tempfile_ok(dir: &Path) -> bool {
    let p = dir.join(".specter-write-test");
    let ok = std::fs::write(&p, b"").is_ok();
    let _ = std::fs::remove_file(p);
    ok
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))?.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() { copy_dir(&src, &dst)? } else { std::fs::copy(&src, &dst).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

/// Pico W / Pico 2 W first flash: builds the Pico bootloader (`boot_rp2040` / `boot_rp2350`) and runs the
/// firmware's own merge (`tools/picoboot_image.py merge`) on a build of the sketch (`app_build` is its `.pio`),
/// giving `<app_build>/picoboot-<board>/flash.uf2` (bootloader, erased state sector, firmware).
pub fn merge_pico(app_build: &Path, board: &str, events: &broadcast::Sender<Event>, project: &str) -> Result<PathBuf, String> {
    let (boot_env, name) = match board {
        "picow" => ("boot_rp2040", "pico-w"),
        "pico2w" => ("boot_rp2350", "pico2-w"),
        _ => return Err(format!("{board} has no Pico bootloader")),
    };
    let ard = crate::arduino_dir().ok_or("the firmware library is not installed")?;
    let root = writable_firmware(&ard)?;
    let pio = find_pio().ok_or("PlatformIO is not installed")?;
    let say = |l: &str| { let _ = events.send(Event::Build { project: project.to_string(), line: l.to_string() }); };
    say(&format!("building the Pico bootloader ({boot_env})"));
    let out = Command::new(&pio).args(["run", "-e", boot_env]).current_dir(&root).output().map_err(|e| format!("cannot start PlatformIO: {e}"))?;
    if !out.status.success() {
        return Err(format!("the Pico bootloader did not build: {}", String::from_utf8_lossy(&out.stdout).lines().rev().find(|l| l.contains("rror")).unwrap_or("")));
    }
    let out = Command::new(crate::flash::pio_python())
        .arg(root.join("tools/picoboot_image.py"))
        .args(["merge", name, "--app-build"])
        .arg(app_build)
        .output()
        .map_err(|e| format!("cannot run the merge: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    say(text.trim());
    if !out.status.success() {
        return Err(format!("the first-flash file could not be made: {}", text.trim()));
    }
    Ok(app_build.join(format!("picoboot-{name}")).join("flash.uf2"))
}
