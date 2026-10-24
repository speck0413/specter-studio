//! Which drives are SD cards, and the computer's own tools for them (list, erase and format, eject).
//!
//! Everything that touches the operating system sits behind [`Platform`]: the real one runs `lsblk` /
//! `diskutil` / PowerShell through a [`Runner`] (every command with a timeout); the fake one
//! (`SPECTER_TEST_DRIVES`, a JSON list of drives whose mount point is a temp folder) never runs a command at all:
//! formatting it empties its folder.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The biggest drive offered as an SD card without "Show all drives": 64 GiB, so every card sold as 64 GB fits.
pub const CARD_MAX_BYTES: u64 = 64 * 1024 * 1024 * 1024;
/// Windows' own format tool refuses FAT32 above this size.
pub const WINDOWS_FAT32_MAX_BYTES: u64 = 32 * 1024 * 1024 * 1024;

/// One drive (on a card: the part of it that holds files, which is what gets a name and a mount point).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Drive {
    /// stable id the UI sends back: `/dev/sdb1`, `disk4s1`, `E:`, or the fake drive's id
    pub id: String,
    /// the name the person sees and types to confirm (the volume label, else a made-up one)
    pub name: String,
    /// the volume label as the card has it ("" when it has none)
    pub label: String,
    /// what the format tool is pointed at: `/dev/sdb1`, `E:`
    pub device: String,
    /// the whole card: `/dev/sdb`, `/dev/disk4`, a disk number
    pub disk: String,
    /// where its files are, when the computer has opened it
    pub mount: Option<String>,
    /// the whole card's size in bytes
    pub size: u64,
    pub removable: bool,
    /// the file system as the computer names it: vfat, msdos, FAT32, exfat, ntfs ...
    pub fs: String,
    /// it holds the operating system (never written to)
    pub system: bool,
    /// a test drive (SPECTER_TEST_DRIVES): no command ever runs for it
    pub fake: bool,
}

/// A drive as the card picker shows it: whether Studio may write to it, and why not.
#[derive(Clone, Debug, Serialize)]
pub struct DriveChoice {
    #[serde(flatten)]
    pub drive: Drive,
    /// "FAT32", "exFAT", "NTFS", "no file system" ...
    pub fs_words: String,
    pub can_write: bool,
    /// why Studio will not write to it (plain words)
    pub why: Option<String>,
    /// a warning that does not stop it (a big card)
    pub warn: Option<String>,
}

/// The file system in plain words.
pub fn fs_words(fs: &str) -> String {
    let l = fs.to_lowercase();
    match l.as_str() {
        "" => "no file system".into(),
        "vfat" | "fat" | "msdos" | "ms-dos" => "FAT".into(),
        "fat32" | "ms-dos fat32" | "dos_fat_32" | "windows_fat_32" => "FAT32".into(),
        "fat16" | "ms-dos fat16" | "dos_fat_16" | "windows_fat_16" => "FAT16".into(),
        "exfat" => "exFAT".into(),
        "ntfs" => "NTFS".into(),
        _ => fs.to_string(),
    }
}

/// Whether the sound player can read this file system: FAT32 or FAT16 (`vfat` / `msdos` is one of them).
pub fn fs_is_fat(fs: &str) -> bool {
    matches!(fs_words(fs).as_str(), "FAT" | "FAT32" | "FAT16")
}

/// The drives the card picker shows. Without `show_all`: only removable drives up to [`CARD_MAX_BYTES`].
/// With it: every drive, but a drive that is not removable, or holds the operating system, is shown only to
/// read (Check), never to write.
pub fn choose(drives: &[Drive], show_all: bool) -> Vec<DriveChoice> {
    let gb = |b: u64| format!("{:.0} GB", b as f64 / 1e9);
    drives
        .iter()
        .filter_map(|d| {
            let mut why = None;
            let mut warn = None;
            if d.system {
                why = Some("This drive holds your computer's system. Studio never writes to it.".to_string());
            } else if !d.removable {
                why = Some("This is not a removable drive (it is built into the computer, or the computer does not say it can be taken out). Studio never erases or writes to it, but you can check it.".to_string());
            } else if d.size > CARD_MAX_BYTES {
                warn = Some(format!("This drive is {}, bigger than the {} an SD card for the sound player usually is. Make sure it really is the SD card before you go on.", gb(d.size), gb(CARD_MAX_BYTES)));
            }
            let hidden = why.is_some() || warn.is_some();
            if hidden && !show_all {
                return None;
            }
            Some(DriveChoice { fs_words: fs_words(&d.fs), can_write: why.is_none(), why, warn, drive: d.clone() })
        })
        .collect()
}

/// A volume name the FAT format tools accept: at most 11 letters, digits, spaces, `_` or `-`, upper case.
pub fn fat_label(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '_' || *c == '-').collect::<String>().trim().to_uppercase();
    let s: String = s.chars().take(11).collect();
    let s = s.trim().to_string();
    if s.is_empty() { "SOUNDS".into() } else { s }
}

// ---------------------------------------------------------------- running commands

/// Runs an external command and gives back what it printed. Every command has a timeout; errors are plain words.
pub trait Runner: Send + Sync {
    fn run(&self, prog: &str, args: &[&str], input: Option<&str>, timeout: Duration) -> Result<String, String>;
}

pub struct OsRunner;

impl Runner for OsRunner {
    fn run(&self, prog: &str, args: &[&str], input: Option<&str>, timeout: Duration) -> Result<String, String> {
        use std::process::{Command, Stdio};
        let mut cmd = Command::new(prog);
        cmd.args(args).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // no console window
        }
        let mut child = cmd.spawn().map_err(|e| format!("Studio could not start “{prog}” ({e}). It may not be installed on this computer."))?;
        if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
            use std::io::Write;
            let _ = stdin.write_all(text.as_bytes());
        }
        let mut out = child.stdout.take().unwrap();
        let mut err = child.stderr.take().unwrap();
        let ot = std::thread::spawn(move || { let mut s = String::new(); let _ = out.read_to_string(&mut s); s });
        let et = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
        let end = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if Instant::now() >= end => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("“{prog}” did not finish within {} seconds, so Studio stopped it.", timeout.as_secs()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(format!("“{prog}” stopped unexpectedly ({e}).")),
            }
        };
        let (stdout, stderr) = (ot.join().unwrap_or_default(), et.join().unwrap_or_default());
        if status.success() {
            return Ok(stdout);
        }
        let code = status.code().unwrap_or(-1);
        if prog == "pkexec" && (code == 126 || code == 127) {
            return Err("The password question was cancelled, or this account is not allowed to do that. Nothing was changed.".into());
        }
        let said = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        Err(format!("“{prog}” did not work (it answered: {}).", if said.is_empty() { format!("error {code}") } else { said.lines().take(4).collect::<Vec<_>>().join(" ") }))
    }
}

// ---------------------------------------------------------------- the platform

pub trait Platform: Send + Sync {
    /// Every drive the computer has (unfiltered: [`choose`] filters).
    fn drives(&self) -> Result<Vec<Drive>, String>;
    /// Erases and formats the card as FAT32 named `label`; gives the drive back as the computer now sees it.
    fn format(&self, d: &Drive, label: &str) -> Result<Drive, String>;
    /// Ejects the card safely; the answer says what to do next.
    fn eject(&self, d: &Drive) -> Result<String, String>;
    /// The names in `dir` in the order the card holds them (on FAT: the directory entries, which is the order
    /// the files were written).
    fn dir_order(&self, dir: &Path) -> Result<Vec<String>, String> {
        Ok(std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
    }
    /// A file or folder was just made in `dir` (the fake card keeps the order; a real card's directory does).
    fn created(&self, _dir: &Path, _name: &str) {}
    /// `dir` was deleted.
    fn removed(&self, _dir: &Path) {}
    /// Tells the computer not to index the card (macOS Spotlight); `None` when not needed or not allowed.
    fn no_index(&self, _d: &Drive) -> Option<String> {
        None
    }
}

/// The platform: fake drives when `SPECTER_TEST_DRIVES` is set, else the operating system's tools.
pub fn platform() -> &'static dyn Platform {
    static P: std::sync::OnceLock<Box<dyn Platform>> = std::sync::OnceLock::new();
    P.get_or_init(|| match std::env::var("SPECTER_TEST_DRIVES") {
        Ok(t) if !t.trim().is_empty() => Box::new(FakePlatform::from_json(&t).unwrap_or_else(|e| panic!("SPECTER_TEST_DRIVES: {e}"))),
        _ => Box::new(OsPlatform { runner: Box::new(OsRunner) }),
    })
    .as_ref()
}

/// Test drives: folders standing in for cards. Formatting empties the folder; ejecting does nothing; no command
/// ever runs. The directory order is the order Studio wrote things (a temp folder's own order is not FAT's).
pub struct FakePlatform {
    pub list: Vec<Drive>,
    order: Mutex<HashMap<PathBuf, Vec<String>>>,
}

impl FakePlatform {
    pub fn new(mut list: Vec<Drive>) -> Self {
        for d in &mut list {
            d.fake = true;
            if d.device.is_empty() { d.device = d.id.clone(); }
            if d.name.is_empty() { d.name = if d.label.is_empty() { d.id.clone() } else { d.label.clone() }; }
            if d.label.is_empty() { d.label = d.name.clone(); }
        }
        FakePlatform { list, order: Mutex::new(HashMap::new()) }
    }
    pub fn from_json(text: &str) -> Result<Self, String> {
        Ok(Self::new(serde_json::from_str(text).map_err(|e| format!("not a JSON list of drives: {e}"))?))
    }
    fn key(dir: &Path) -> PathBuf {
        dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
    }
}

impl Platform for FakePlatform {
    fn drives(&self) -> Result<Vec<Drive>, String> {
        Ok(self.list.clone())
    }
    fn format(&self, d: &Drive, label: &str) -> Result<Drive, String> {
        let root = PathBuf::from(d.mount.clone().ok_or("the test drive has no folder")?);
        for e in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            let p = e.path();
            if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) }.map_err(|e| e.to_string())?;
        }
        self.order.lock().unwrap().retain(|k, _| !k.starts_with(Self::key(&root)));
        let mut d = d.clone();
        d.label = label.to_string();
        d.fs = "vfat".into();
        Ok(d)
    }
    fn eject(&self, _d: &Drive) -> Result<String, String> {
        Ok("The card can be taken out now.".into())
    }
    fn dir_order(&self, dir: &Path) -> Result<Vec<String>, String> {
        let mut now: Vec<String> = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        now.sort();
        let rec = self.order.lock().unwrap().get(&Self::key(dir)).cloned().unwrap_or_default();
        let mut out: Vec<String> = rec.into_iter().filter(|n| now.contains(n)).collect();
        let rest: Vec<String> = now.into_iter().filter(|n| !out.contains(n)).collect();
        out.extend(rest);
        Ok(out)
    }
    fn created(&self, dir: &Path, name: &str) {
        let mut o = self.order.lock().unwrap();
        let v = o.entry(Self::key(dir)).or_default();
        v.retain(|n| n != name);
        v.push(name.to_string());
    }
    fn removed(&self, dir: &Path) {
        let k = Self::key(dir);
        self.order.lock().unwrap().retain(|p, _| !p.starts_with(&k));
    }
}

/// The real computer.
pub struct OsPlatform {
    pub runner: Box<dyn Runner>,
}

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const FORMAT_TIMEOUT: Duration = Duration::from_secs(600);
const SHORT: Duration = Duration::from_secs(60);

impl Platform for OsPlatform {
    fn drives(&self) -> Result<Vec<Drive>, String> {
        if cfg!(target_os = "macos") {
            let list = self.runner.run("diskutil", &["list", "-plist", "external", "physical"], None, LIST_TIMEOUT)?;
            let disks = plist(&list)?;
            let mut info = HashMap::new();
            for id in mac_ids(&disks) {
                if let Ok(t) = self.runner.run("diskutil", &["info", "-plist", &id], None, LIST_TIMEOUT) {
                    if let Ok(v) = plist(&t) { info.insert(id, v); }
                }
            }
            Ok(parse_diskutil(&disks, &info))
        } else if cfg!(windows) {
            let t = self.runner.run("powershell", &["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST], None, LIST_TIMEOUT)?;
            parse_windows(&t)
        } else {
            let t = self.runner.run("lsblk", &["-J", "-b", "-o", "NAME,PATH,SIZE,RM,HOTPLUG,TRAN,TYPE,FSTYPE,LABEL,MOUNTPOINT"], None, LIST_TIMEOUT)?;
            parse_lsblk(&t)
        }
    }

    fn format(&self, d: &Drive, label: &str) -> Result<Drive, String> {
        if d.fake || d.system || !d.removable {
            return Err("Studio does not erase this drive.".into());
        }
        if cfg!(target_os = "macos") {
            self.runner.run("diskutil", &["eraseDisk", "FAT32", label, "MBRFormat", &d.disk], None, FORMAT_TIMEOUT)?;
            // the card's first part, now named `label`
            let again = self.drives()?;
            return again.into_iter().find(|x| x.disk == d.disk && x.label.eq_ignore_ascii_case(label)).ok_or_else(|| "The card was formatted, but the computer has not opened it again. Take it out, put it back in, and press Refresh.".into());
        }
        if cfg!(windows) {
            if d.size > WINDOWS_FAT32_MAX_BYTES {
                return Err(WINDOWS_TOO_BIG.into());
            }
            let letter = d.device.trim_end_matches('\\');
            // format asks to press Enter for a removable disk: the newline answers it
            self.runner.run("format", &[letter, "/FS:FAT32", "/Q", &format!("/V:{label}"), "/Y"], Some("\r\n\r\n"), FORMAT_TIMEOUT)
                .map_err(|e| format!("{e} Windows may ask for administrator rights to format: run Studio as administrator, or untick “Erase and format” and Studio deletes the files instead."))?;
            let again = self.drives()?;
            return again.into_iter().find(|x| x.id == d.id).ok_or_else(|| "The card was formatted, but Windows has not shown it again yet. Press Refresh.".into());
        }
        // Linux: the card needs a partition (the part of the card that holds the files) to format
        if d.device == d.disk {
            return Err("This card has no partition (the part of a card that holds the files), so Studio cannot format it. Use the Disks app (or GParted) to make one FAT32 partition, then try again.".into());
        }
        if d.mount.is_some() {
            self.runner.run("udisksctl", &["unmount", "-b", &d.device], None, SHORT)?;
        }
        // admin rights: pkexec asks the person for their password (never sudo, never silently)
        self.runner.run("pkexec", &["mkfs.vfat", "-F", "32", "-n", label, &d.device], None, FORMAT_TIMEOUT)?;
        let _ = self.runner.run("udisksctl", &["mount", "-b", &d.device], None, SHORT);
        let again = self.drives()?;
        let nd = again.into_iter().find(|x| x.id == d.id).ok_or("The card was formatted, but the computer does not show it any more. Take it out, put it back in, and press Refresh.")?;
        if nd.mount.is_none() {
            return Err("The card was formatted, but the computer has not opened it. Take it out, put it back in, and press Refresh; then copy again without “Erase and format”.".into());
        }
        Ok(nd)
    }

    fn eject(&self, d: &Drive) -> Result<String, String> {
        if d.fake { return Ok("The card can be taken out now.".into()); }
        if cfg!(target_os = "macos") {
            self.runner.run("diskutil", &["eject", &d.disk], None, SHORT)?;
        } else if cfg!(windows) {
            let letter = d.device.trim_end_matches('\\').to_string();
            let script = format!("(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{letter}').InvokeVerb('Eject')");
            if self.runner.run("powershell", &["-NoProfile", "-NonInteractive", "-Command", &script], None, SHORT).is_err() {
                return Ok(format!("Windows did not eject {letter} by itself: click the USB icon near the clock, choose to eject the card, then take it out."));
            }
        } else {
            if d.mount.is_some() {
                self.runner.run("udisksctl", &["unmount", "-b", &d.device], None, SHORT)?;
            }
            if let Err(e) = self.runner.run("udisksctl", &["power-off", "-b", &d.disk], None, SHORT) {
                return Ok(format!("The card is closed and can be taken out now. (The computer could not switch the card reader off: {e})"));
            }
        }
        Ok("The card can be taken out now.".into())
    }

    fn no_index(&self, d: &Drive) -> Option<String> {
        if !cfg!(target_os = "macos") { return None; }
        let m = d.mount.as_deref()?;
        // only when it works without admin rights; never asks for a password
        match self.runner.run("mdutil", &["-i", "off", m], None, Duration::from_secs(15)) {
            Ok(_) => Some("Spotlight will not index the card.".into()),
            Err(_) => None,
        }
    }
}

pub const WINDOWS_TOO_BIG: &str = "Windows' own format tool will not make FAT32 on a card bigger than 32 GB. Either use a card of 32 GB or less (plenty for sounds), or format this one with a free tool such as “FAT32 Format” or Rufus, then come back and copy with “Erase and format” unticked.";

const WINDOWS_LIST: &str = "Get-Partition | Where-Object DriveLetter | ForEach-Object { $d = Get-Disk -Number $_.DiskNumber; $v = Get-Volume -Partition $_; [pscustomobject]@{ Letter = [string]$_.DriveLetter; Label = $v.FileSystemLabel; FileSystem = $v.FileSystem; DiskSize = $d.Size; BusType = [string]$d.BusType; DriveType = [string]$v.DriveType; Number = $_.DiskNumber; Boot = ($d.IsBoot -or $d.IsSystem) } } | ConvertTo-Json -Compress";

// ---------------------------------------------------------------- parsing what the tools print

fn num(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).or_else(|| v.as_f64().map(|f| f as u64)).unwrap_or(0)
}
fn flag(v: &Value) -> bool {
    v.as_bool().unwrap_or_else(|| matches!(v.as_str().map(str::trim), Some("1" | "true")) || v.as_u64() == Some(1))
}
fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

/// `lsblk -J -b -o NAME,PATH,SIZE,RM,HOTPLUG,TRAN,TYPE,FSTYPE,LABEL,MOUNTPOINT`: one drive per partition (or per
/// disk without partitions). `rm`/`hotplug` may be booleans or "0"/"1", `size` a number or a string (util-linux
/// versions differ).
pub fn parse_lsblk(text: &str) -> Result<Vec<Drive>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("could not read the drive list ({e})"))?;
    let mut out = vec![];
    for disk in v["blockdevices"].as_array().into_iter().flatten() {
        if s(&disk["type"]) != "disk" {
            continue;
        }
        let dpath = if disk["path"].is_string() { s(&disk["path"]) } else { format!("/dev/{}", s(&disk["name"])) };
        let tran = s(&disk["tran"]).to_lowercase();
        let removable = flag(&disk["rm"]) || flag(&disk["hotplug"]) || tran == "usb" || tran == "mmc";
        let size = num(&disk["size"]);
        let parts: Vec<&Value> = disk["children"].as_array().map(|c| c.iter().filter(|p| s(&p["type"]) == "part").collect()).unwrap_or_default();
        let mount_of = |p: &Value| -> Option<String> {
            let m = if p["mountpoint"].is_string() { s(&p["mountpoint"]) } else { p["mountpoints"].as_array().and_then(|a| a.iter().find_map(|x| x.as_str().map(String::from))).unwrap_or_default() };
            (!m.is_empty()).then_some(m)
        };
        let all_mounts: Vec<String> = std::iter::once(disk).chain(disk["children"].as_array().into_iter().flatten()).filter_map(&mount_of).collect();
        let system = all_mounts.iter().any(|m| m == "/" || m == "/boot" || m == "/boot/efi" || m == "/home" || m == "[SWAP]" || m.starts_with("/usr") || m.starts_with("/var"));
        let mk = |p: &Value, short: &str| {
            let device = if p["path"].is_string() { s(&p["path"]) } else { format!("/dev/{}", s(&p["name"])) };
            let label = s(&p["label"]);
            Drive {
                id: device.clone(),
                name: if label.is_empty() { format!("card on {short}") } else { label.clone() },
                label,
                device,
                disk: dpath.clone(),
                mount: mount_of(p),
                size,
                removable,
                fs: s(&p["fstype"]),
                system,
                fake: false,
            }
        };
        if parts.is_empty() {
            if size > 0 && (removable || !s(&disk["fstype"]).is_empty()) {
                out.push(mk(disk, &s(&disk["name"])));
            }
        } else {
            for p in parts {
                out.push(mk(p, &s(&p["name"])));
            }
        }
    }
    Ok(out)
}

/// PowerShell's JSON (one object, or a list).
pub fn parse_windows(text: &str) -> Result<Vec<Drive>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(vec![]);
    }
    let v: Value = serde_json::from_str(t).map_err(|e| format!("could not read the drive list ({e})"))?;
    let list = if v.is_array() { v.as_array().unwrap().clone() } else { vec![v] };
    let sys = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_uppercase();
    Ok(list
        .iter()
        .map(|d| {
            let letter = format!("{}:", s(&d["Letter"]).trim());
            let bus = s(&d["BusType"]).to_uppercase();
            let label = s(&d["Label"]);
            Drive {
                id: letter.clone(),
                name: if label.is_empty() { format!("card {letter}") } else { label.clone() },
                label,
                device: letter.clone(),
                disk: num(&d["Number"]).to_string(),
                mount: Some(format!("{letter}\\")),
                size: num(&d["DiskSize"]),
                removable: matches!(bus.as_str(), "USB" | "SD" | "MMC") || s(&d["DriveType"]).eq_ignore_ascii_case("Removable"),
                fs: s(&d["FileSystem"]),
                system: flag(&d["Boot"]) || letter.to_uppercase() == sys,
                fake: false,
            }
        })
        .collect())
}

/// The disk ids in `diskutil list -plist` (whole disks and their parts) to ask `diskutil info` about.
fn mac_ids(list: &Value) -> Vec<String> {
    let mut out = vec![];
    for d in list["AllDisksAndPartitions"].as_array().into_iter().flatten() {
        out.push(s(&d["DeviceIdentifier"]));
        for p in d["Partitions"].as_array().into_iter().flatten() {
            out.push(s(&p["DeviceIdentifier"]));
        }
    }
    out.retain(|x| !x.is_empty());
    out
}

/// `diskutil list -plist external physical` plus `diskutil info -plist <id>` for each disk and part.
pub fn parse_diskutil(list: &Value, info: &HashMap<String, Value>) -> Vec<Drive> {
    let mut out = vec![];
    for d in list["AllDisksAndPartitions"].as_array().into_iter().flatten() {
        let did = s(&d["DeviceIdentifier"]);
        let di = info.get(&did).cloned().unwrap_or(Value::Null);
        let removable = flag(&di["RemovableMedia"]) || flag(&di["Removable"]) || flag(&di["Ejectable"]) || (di["Internal"].is_boolean() && !flag(&di["Internal"]));
        let size = num(&d["Size"]).max(num(&di["TotalSize"]));
        let parts: Vec<Value> = d["Partitions"].as_array().cloned().unwrap_or_default();
        let entries: Vec<Value> = if parts.is_empty() { vec![d.clone()] } else { parts };
        for p in entries {
            let pid = s(&p["DeviceIdentifier"]);
            let pi = info.get(&pid).cloned().unwrap_or(Value::Null);
            let label = if p["VolumeName"].is_string() { s(&p["VolumeName"]) } else { s(&pi["VolumeName"]) };
            let mount = [s(&p["MountPoint"]), s(&pi["MountPoint"])].into_iter().find(|m| !m.is_empty());
            let fs = [s(&pi["FilesystemName"]), s(&pi["FilesystemType"]), s(&p["Content"])].into_iter().find(|m| !m.is_empty()).unwrap_or_default();
            out.push(Drive {
                id: pid.clone(),
                name: if label.is_empty() { format!("card {pid}") } else { label.clone() },
                label,
                device: format!("/dev/{pid}"),
                disk: format!("/dev/{did}"),
                system: mount.as_deref() == Some("/"),
                mount,
                size,
                removable,
                fs,
                fake: false,
            });
        }
    }
    out
}

/// A small reader for Apple's XML property lists (what `diskutil -plist` prints), into JSON.
pub fn plist(text: &str) -> Result<Value, String> {
    let mut p = Plist { t: text, i: 0 };
    // to the first value inside <plist>
    let start = text.find("<plist").ok_or("not a property list")?;
    p.i = start + text[start..].find('>').ok_or("not a property list")? + 1;
    p.value()
}

struct Plist<'a> {
    t: &'a str,
    i: usize,
}

impl Plist<'_> {
    fn tag(&mut self) -> Result<String, String> {
        loop {
            let at = self.t[self.i..].find('<').ok_or("the property list ends early")? + self.i;
            let end = self.t[at..].find('>').ok_or("the property list ends early")? + at;
            self.i = end + 1;
            let tag = &self.t[at + 1..end];
            if tag.starts_with('?') || tag.starts_with('!') {
                continue;
            }
            return Ok(tag.trim().to_string());
        }
    }
    fn text_until(&mut self, close: &str) -> Result<String, String> {
        let end = self.t[self.i..].find(close).ok_or("the property list ends early")? + self.i;
        let raw = &self.t[self.i..end];
        self.i = end + close.len();
        Ok(raw.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&"))
    }
    fn value(&mut self) -> Result<Value, String> {
        let tag = self.tag()?;
        self.value_from(&tag)
    }
    fn value_from(&mut self, tag: &str) -> Result<Value, String> {
        match tag {
            "dict" => {
                let mut m = serde_json::Map::new();
                loop {
                    let t = self.tag()?;
                    if t == "/dict" { break; }
                    if t == "key" {
                        let k = self.text_until("</key>")?;
                        let v = self.value()?;
                        m.insert(k, v);
                    } else {
                        return Err(format!("unexpected <{t}> in a property list"));
                    }
                }
                Ok(Value::Object(m))
            }
            "dict/" => Ok(Value::Object(Default::default())),
            "array" => {
                let mut a = vec![];
                loop {
                    let t = self.tag()?;
                    if t == "/array" { break; }
                    a.push(self.value_from(&t)?);
                }
                Ok(Value::Array(a))
            }
            "array/" => Ok(Value::Array(vec![])),
            "true/" => Ok(Value::Bool(true)),
            "false/" => Ok(Value::Bool(false)),
            "string" => Ok(Value::String(self.text_until("</string>")?)),
            "string/" => Ok(Value::String(String::new())),
            "integer" => Ok(self.text_until("</integer>")?.trim().parse::<i64>().map(Value::from).unwrap_or(Value::Null)),
            "real" => Ok(self.text_until("</real>")?.trim().parse::<f64>().ok().map(Value::from).unwrap_or(Value::Null)),
            "date" => Ok(Value::String(self.text_until("</date>")?)),
            "data" => { self.text_until("</data>")?; Ok(Value::Null) }
            t => Err(format!("unexpected <{t}> in a property list")),
        }
    }
}
