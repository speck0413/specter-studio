//! The SD card for the board's sound player (a DFPlayer Mini).
//!
//! The player plays files from the folder `mp3` in the card's root by number: `mp3/0001-rain.mp3`,
//! `mp3/0002-elevator.mp3` ... (four digits; the rest of the name is free). A script says `audio_single = 2`.
//! The player numbers files by the order they were *written* to the card, not by name, so Studio writes them
//! one at a time in number order, into a freshly made `mp3` folder (an emptied one would reuse old directory
//! slots and could break the order), and its Check reads the card's directory order to find files out of order.
//!
//! Safety: a drive is always looked up again here from its id (the UI never names a device or a path to write
//! to); a drive that is not removable, or holds the system, is never erased or written; the person's own sound
//! files are only ever read.

pub mod drives;

use crate::Event;
use drives::{Drive, Platform};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tokio::sync::broadcast;

/// The most files the player plays from the `mp3` folder.
pub const MP3_FOLDER_MAX: usize = 3000;
/// The sound formats the player plays (MP3 and WAV, 8 to 48 kHz).
pub const AUDIO_EXTS: [&str; 2] = ["mp3", "wav"];
/// Junk the Mac leaves on cards (Spotlight, file system events, the trash).
pub const MAC_FOLDERS: [&str; 3] = [".Spotlight-V100", ".fseventsd", ".Trashes"];

fn ext_of(name: &str) -> String {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

/// A description FAT accepts: no `\ / : * ? " < > |` or control characters, no dots or spaces at the end.
pub fn sanitize(desc: &str) -> String {
    let s: String = desc.chars().filter(|c| !c.is_control() && !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    s.trim().trim_end_matches(['.', ' ']).trim().to_string()
}

/// The card name of sound `n`: `0001-rain.mp3` (the full name at most 255 characters; no description:
/// `0001.mp3`).
pub fn card_name(n: usize, desc: &str, ext: &str) -> String {
    let ext = ext.to_lowercase();
    let room = 255 - 5 - 1 - ext.chars().count();
    let d: String = sanitize(desc).chars().take(room).collect();
    let d = d.trim_end_matches(['.', ' ']).to_string();
    if d.is_empty() { format!("{n:04}.{ext}") } else { format!("{n:04}-{d}.{ext}") }
}

/// A card file name's number and description: `0003-scream.mp3` -> (3, "scream"). Only the first 4 digits count.
pub fn parse_name(name: &str) -> Option<(u32, String)> {
    let b = name.as_bytes();
    if b.len() < 4 || !b[..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let n: u32 = name[..4].parse().ok()?;
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let desc = stem.get(4..).unwrap_or("").trim_start_matches(['-', '_', ' ', '.']).to_string();
    Some((n, desc))
}

/// One line of the map: sound `number` is `name` on the card (from `source`).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MapRow {
    pub number: usize,
    pub name: String,
    pub description: String,
    pub source: String,
}

/// One sound to copy: where it is and the description it gets on the card.
#[derive(Clone, Debug)]
pub struct Sound {
    pub src: PathBuf,
    pub desc: String,
}

impl Sound {
    pub fn from_path(p: &Path) -> Sound {
        Sound { src: p.to_path_buf(), desc: p.file_stem().and_then(|s| s.to_str()).unwrap_or("sound").to_string() }
    }
}

/// Checks the sounds before anything on the card is touched: each one a readable .mp3 or .wav file, not on the
/// card itself, at most [`MP3_FOLDER_MAX`].
pub fn check_sounds(sounds: &[Sound], card: &Path) -> Result<(), String> {
    if sounds.is_empty() {
        return Err("Add at least one sound first.".into());
    }
    if sounds.len() > MP3_FOLDER_MAX {
        return Err(format!("The sound player plays at most {MP3_FOLDER_MAX} files from one card; you have {}.", sounds.len()));
    }
    let card = dunce::canonicalize(card).unwrap_or_else(|_| card.to_path_buf());
    for s in sounds {
        let name = s.src.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        let m = std::fs::metadata(&s.src).map_err(|_| format!("“{name}” is not there any more ({}). Remove it from the list or add it again.", s.src.display()))?;
        if !m.is_file() {
            return Err(format!("“{name}” is not a sound file."));
        }
        if !AUDIO_EXTS.contains(&ext_of(&name).as_str()) {
            return Err(format!("“{name}” is not an MP3 or WAV file: the sound player plays only those."));
        }
        let real = dunce::canonicalize(&s.src).unwrap_or_else(|_| s.src.clone());
        if real.starts_with(&card) {
            return Err(format!("“{name}” is on the SD card itself. Copy it to your computer first: Studio is about to clear the card."));
        }
    }
    Ok(())
}

/// Copies one file byte by byte (not `std::fs::copy`, which on a Mac also copies extended attributes that turn
/// into `._` files between the numbered ones on FAT) and makes sure it is on the card before going on.
fn copy_bytes(src: &Path, dst: &Path) -> std::io::Result<u64> {
    let mut from = std::fs::File::open(src)?;
    let mut to = std::fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 { break; }
        to.write_all(&buf[..n])?;
        total += n as u64;
    }
    to.flush()?;
    to.sync_all()?;
    Ok(total)
}

/// Makes sure a folder's list of files is on the card (where the computer allows it).
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(f) = std::fs::File::open(dir) {
        let _ = f.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Progress: (what, done, total, file).
pub type Progress<'a> = &'a (dyn Fn(&str, usize, usize, &str) + Sync);

/// Writes the sounds into `<card>/mp3` (made fresh: it must not exist yet) one at a time, in list order, as
/// `0001-<desc>.<ext>` ... `fail_at` (tests): sound number that fails. A failure stops the copy, removes the half
/// written file and says plainly how far it got; the person's own files are only read.
pub fn write_sounds(card: &Path, sounds: &[Sound], plat: &dyn Platform, progress: Progress, fail_at: Option<usize>) -> Result<Vec<MapRow>, String> {
    let dir = card.join("mp3");
    std::fs::create_dir(&dir).map_err(|e| format!("Studio could not make the mp3 folder on the card ({e}). Is the card locked (the little switch on its side)?"))?;
    plat.created(card, "mp3");
    sync_dir(card);
    let mut map = vec![];
    for (i, s) in sounds.iter().enumerate() {
        let n = i + 1;
        let ext = ext_of(&s.src.to_string_lossy());
        let name = card_name(n, &s.desc, &ext);
        let src_name = s.src.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        progress("copy", i, sounds.len(), &name);
        let dst = dir.join(&name);
        let r = if fail_at == Some(n) { Err(std::io::Error::other("the card stopped answering (test)")) } else { copy_bytes(&s.src, &dst) };
        if let Err(e) = r {
            let _ = std::fs::remove_file(&dst);
            let done = if n == 1 { "Nothing was copied yet".to_string() } else { format!("Sounds 1 to {} are on the card", n - 1) };
            return Err(format!("Copying stopped at sound {n} (“{src_name}”): {e}. {done}. Your sound files on this computer are untouched. Check the card is in properly, then press Copy again: Studio starts over."));
        }
        plat.created(&dir, &name);
        map.push(MapRow { number: n, name, description: sanitize(&s.desc), source: s.src.to_string_lossy().into_owned() });
    }
    sync_dir(&dir);
    progress("copy", sounds.len(), sounds.len(), "");
    Ok(map)
}

/// Deletes what macOS leaves on a card: `._*` files (in the root and in /mp3) and its index, event and trash
/// folders. Gives back what it deleted.
pub fn clean_mac_junk(card: &Path) -> Vec<String> {
    let mut gone = vec![];
    for (dir, prefix) in [(card.to_path_buf(), ""), (card.join("mp3"), "mp3/")] {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            let junk = n.starts_with("._") || n == ".DS_Store" || (prefix.is_empty() && MAC_FOLDERS.contains(&n.as_str()));
            if !junk { continue; }
            let ok = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
            if ok.is_ok() { gone.push(format!("{prefix}{n}")); }
        }
    }
    gone
}

/// Windows makes this folder on every card itself and does not let it be deleted; it does no harm.
const WINDOWS_FOLDER: &str = "System Volume Information";

/// What "copy without formatting" deletes: everything in the card's root and in /mp3, as `name`, `folder/` and
/// `mp3/name`.
pub fn plan_clear(card: &Path) -> Result<Vec<String>, String> {
    let mut out = vec![];
    let mut root: Vec<_> = std::fs::read_dir(card).map_err(|e| format!("Studio cannot read the card ({e})."))?.flatten().collect();
    root.sort_by_key(|e| e.file_name());
    for e in root {
        let n = e.file_name().to_string_lossy().into_owned();
        if n == WINDOWS_FOLDER { continue; }
        let dir = e.path().is_dir();
        out.push(if dir { format!("{n}/") } else { n.clone() });
        if dir && n == "mp3" {
            let mut inner: Vec<String> = std::fs::read_dir(e.path()).into_iter().flatten().flatten().map(|x| x.file_name().to_string_lossy().into_owned()).collect();
            inner.sort();
            out.extend(inner.into_iter().map(|x| format!("mp3/{x}")));
        }
    }
    Ok(out)
}

/// Deletes everything in the card's root (the `mp3` folder itself included, so it is made new and its directory
/// starts empty). Windows' own system folder is left alone.
pub fn clear_card(card: &Path, plat: &dyn Platform) -> Result<(), String> {
    for e in std::fs::read_dir(card).map_err(|e| format!("Studio cannot read the card ({e})."))?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n == WINDOWS_FOLDER { continue; }
        let p = e.path();
        let r = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        r.map_err(|err| format!("Studio could not delete “{n}” from the card ({err}). Is the card locked (the little switch on its side)?"))?;
        if p.is_dir() { plat.removed(&p); }
    }
    sync_dir(card);
    Ok(())
}

// ---------------------------------------------------------------- Check

/// One file in a card folder, in directory order.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub dir: bool,
}

/// A file in /mp3 as Check sees it.
#[derive(Clone, Debug, Serialize)]
pub struct CardFile {
    /// its place in the card's directory (1 = written first)
    pub position: usize,
    pub name: String,
    pub number: Option<u32>,
    pub description: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Problem {
    pub code: &'static str,
    pub words: String,
    pub names: Vec<String>,
    /// Fix (re-copy in order) mends it
    pub fixable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub files: Vec<CardFile>,
    pub problems: Vec<Problem>,
    pub fs_words: Option<String>,
    pub fixable: bool,
}

fn hidden(n: &str) -> bool {
    n.starts_with("._") || n == ".DS_Store" || MAC_FOLDERS.contains(&n)
}

fn list_words(v: &[String]) -> String {
    let shown: Vec<&str> = v.iter().take(8).map(String::as_str).collect();
    let more = if v.len() > 8 { format!(" and {} more", v.len() - 8) } else { String::new() };
    format!("{}{more}", shown.join(", "))
}

/// What is wrong with a card: its root and its /mp3 folder (in directory order, `None`: no /mp3 folder) and its
/// file system (`None`: not known, a plain folder).
pub fn check(root: &[Entry], mp3: Option<&[Entry]>, fs: Option<&str>) -> Report {
    let mut problems = vec![];
    let mut p = |code, words: String, names: Vec<String>, fixable| problems.push(Problem { code, words, names, fixable });
    let fs_words = fs.map(drives::fs_words);
    if let Some(f) = fs {
        if !drives::fs_is_fat(f) {
            p("not_fat", format!("The card uses {}. The sound player reads only FAT32 (or FAT16) cards: copy your sounds again with “Erase and format FAT32” ticked.", drives::fs_words(f)), vec![], false);
        }
    }
    let hidden_root: Vec<String> = root.iter().filter(|e| hidden(&e.name)).map(|e| e.name.clone()).collect();
    let extra: Vec<String> = root.iter().filter(|e| e.name != "mp3" && e.name != WINDOWS_FOLDER && !hidden(&e.name)).map(|e| if e.dir { format!("{}/", e.name) } else { e.name.clone() }).collect();
    if !extra.is_empty() {
        p("extra_root", format!("Other files are in the card's top folder: {}. The player only plays the mp3 folder; extra files can confuse some players. Delete them, or copy your sounds again (it clears the card).", list_words(&extra)), extra, false);
    }
    let Some(mp3) = mp3 else {
        p("no_mp3", "There is no mp3 folder on this card, so the sound player finds no sounds. Use Copy to put your sounds on it.".into(), vec![], false);
        let fixable = false;
        return Report { files: vec![], problems, fs_words, fixable };
    };
    let mut hid: Vec<String> = hidden_root;
    hid.extend(mp3.iter().filter(|e| hidden(&e.name)).map(|e| format!("mp3/{}", e.name)));
    let real: Vec<&Entry> = mp3.iter().filter(|e| !hidden(&e.name)).collect();
    let files: Vec<CardFile> = real
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let parsed = if e.dir { None } else { parse_name(&e.name) };
            CardFile { position: i + 1, name: e.name.clone(), number: parsed.as_ref().map(|x| x.0), description: parsed.map(|x| x.1).unwrap_or_default(), size: e.size }
        })
        .collect();
    if !hid.is_empty() {
        p("hidden", format!("Hidden files a Mac leaves behind are on the card: {}. The player can count them as sounds, which moves every number after them. Fix deletes them.", list_words(&hid)), hid, true);
    }
    let folders: Vec<String> = real.iter().filter(|e| e.dir).map(|e| format!("mp3/{}/", e.name)).collect();
    if !folders.is_empty() {
        p("folders", format!("The mp3 folder has folders inside it ({}). The player ignores them; put the sounds straight in mp3.", list_words(&folders)), folders, false);
    }
    let unsupported: Vec<String> = real.iter().filter(|e| !e.dir && !AUDIO_EXTS.contains(&ext_of(&e.name).as_str())).map(|e| e.name.clone()).collect();
    if !unsupported.is_empty() {
        p("unsupported", format!("These files are not MP3 or WAV, so the player cannot play them: {}. Fix moves them off the card (a copy is kept on this computer).", list_words(&unsupported)), unsupported.clone(), true);
    }
    let no_number: Vec<String> = real.iter().filter(|e| !e.dir && AUDIO_EXTS.contains(&ext_of(&e.name).as_str()) && parse_name(&e.name).is_none()).map(|e| e.name.clone()).collect();
    if !no_number.is_empty() {
        p("no_number", format!("These sounds do not start with a 4-digit number (like 0001-): {}. Fix numbers them after the others.", list_words(&no_number)), no_number, true);
    }
    let sounds: Vec<&CardFile> = files.iter().filter(|f| f.number.is_some() && AUDIO_EXTS.contains(&ext_of(&f.name).as_str())).collect();
    if sounds.len() > MP3_FOLDER_MAX {
        p("too_many", format!("The mp3 folder has {} sounds; the player plays at most {MP3_FOLDER_MAX}.", sounds.len()), vec![], false);
    }
    // duplicates
    let mut seen = std::collections::BTreeMap::<u32, Vec<String>>::new();
    for f in &sounds { seen.entry(f.number.unwrap()).or_default().push(f.name.clone()); }
    let dups: Vec<String> = seen.values().filter(|v| v.len() > 1).flatten().cloned().collect();
    if !dups.is_empty() {
        p("duplicates", format!("Two or more sounds have the same number: {}. Only one can be that number. Fix gives each its own number.", list_words(&dups)), dups, true);
    }
    // gaps
    if let Some(max) = seen.keys().max().copied() {
        let missing: Vec<String> = (1..=max).filter(|n| !seen.contains_key(n)).map(|n| n.to_string()).collect();
        if !missing.is_empty() {
            p("gaps", format!("Numbers are missing: {}. The player counts the files, so after a gap every number plays the sound one further along. Fix numbers them 1, 2, 3 … without gaps (scripts using the changed numbers need updating).", list_words(&missing)), missing, true);
        }
    }
    // out of order: the directory order must be number order
    let mut wrong = vec![];
    let mut best: Option<u32> = None;
    for f in &sounds {
        let n = f.number.unwrap();
        if best.is_some_and(|b| n < b) { wrong.push(f.name.clone()); } else { best = Some(n); }
    }
    if !wrong.is_empty() {
        let first = sounds.iter().enumerate().find(|(i, f)| f.number != Some(*i as u32 + 1)).map(|(i, f)| format!(" For example, `audio_single = {}` plays “{}”.", i + 1, f.name)).unwrap_or_default();
        p("out_of_order", format!("The files are on the card in a different order than their numbers ({}). The player goes by the order files were written, not by their names.{first} Fix copies them again in order.", list_words(&wrong)), wrong, true);
    }
    let fixable = problems.iter().any(|x| x.fixable);
    Report { files, problems, fs_words, fixable }
}

/// The entries of a card folder in directory order (`None` when it is not there).
pub fn read_entries(dir: &Path, plat: &dyn Platform) -> Result<Option<Vec<Entry>>, String> {
    if !dir.is_dir() {
        return Ok(None);
    }
    let names = plat.dir_order(dir)?;
    Ok(Some(names.into_iter().map(|n| { let m = std::fs::symlink_metadata(dir.join(&n)).ok(); Entry { size: m.as_ref().map(|m| m.len()).unwrap_or(0), dir: m.is_some_and(|m| m.is_dir()), name: n } }).collect()))
}

/// Check a card (or a folder standing in for one).
pub fn check_card(card: &Path, fs: Option<&str>, plat: &dyn Platform) -> Result<Report, String> {
    let root = read_entries(card, plat)?.ok_or_else(|| format!("Studio cannot open {}.", card.display()))?;
    let mp3 = read_entries(&card.join("mp3"), plat)?;
    Ok(check(&root, mp3.as_deref(), fs))
}

/// Fix: copies everything in /mp3 off the card into `backup` and checks the sizes BEFORE deleting anything,
/// then makes /mp3 new and writes the sounds back in number order, numbered 1, 2, 3 … (files without a number
/// after the others). Unsupported files stay only in the backup. Hidden Mac files are deleted.
pub fn fix(card: &Path, backup: &Path, plat: &dyn Platform, progress: Progress) -> Result<Value, String> {
    let dir = card.join("mp3");
    let entries = read_entries(&dir, plat)?.ok_or("There is no mp3 folder on this card to fix.")?;
    std::fs::create_dir_all(backup).map_err(|e| format!("Studio could not make a folder on this computer for the copy ({e}). Nothing on the card was changed."))?;
    let files: Vec<&Entry> = entries.iter().filter(|e| !e.dir && !hidden(&e.name)).collect();
    // 1. copy off and verify
    for (i, e) in files.iter().enumerate() {
        progress("backup", i, files.len(), &e.name);
        let to = backup.join(&e.name);
        let _ = std::fs::remove_file(&to);
        let n = copy_bytes(&dir.join(&e.name), &to).map_err(|err| format!("Studio could not copy “{}” off the card ({err}). Nothing on the card was changed.", e.name))?;
        let back = std::fs::metadata(&to).map(|m| m.len()).unwrap_or(u64::MAX);
        if n != e.size || back != e.size {
            return Err(format!("The copy of “{}” on this computer is not the same size as on the card, so Studio stopped. Nothing on the card was changed.", e.name));
        }
    }
    // 2. the new order
    let mut numbered: Vec<(u32, usize, &Entry)> = vec![];
    let mut rest: Vec<&Entry> = vec![];
    let mut left_off: Vec<String> = vec![];
    for (i, e) in files.iter().enumerate() {
        if !AUDIO_EXTS.contains(&ext_of(&e.name).as_str()) { left_off.push(e.name.clone()); continue; }
        match parse_name(&e.name) { Some((n, _)) => numbered.push((n, i, e)), None => rest.push(e) }
    }
    numbered.sort_by_key(|x| (x.0, x.1));
    let order: Vec<&Entry> = numbered.into_iter().map(|x| x.2).chain(rest).collect();
    let sounds: Vec<Sound> = order.iter().map(|e| Sound { src: backup.join(&e.name), desc: parse_name(&e.name).map(|x| x.1).unwrap_or_else(|| Path::new(&e.name).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()) }).collect();
    // 3. delete and write again
    let junk = clean_mac_junk(card);
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Studio could not delete the old mp3 folder ({e}). Your sounds are safe on this computer in {}.", backup.display()))?;
    plat.removed(&dir);
    let map = write_sounds(card, &sounds, plat, progress, None).map_err(|e| format!("{e} A copy of everything that was on the card is in {}.", backup.display()))?;
    let renamed: Vec<Value> = order.iter().zip(&map).filter(|(e, r)| e.name != r.name).map(|(e, r)| json!({ "from": e.name, "to": r.name, "number": r.number })).collect();
    let _ = clean_mac_junk(card);
    Ok(json!({ "map": map, "renamed": renamed, "left_off": left_off, "deleted_hidden": junk, "backup": backup.to_string_lossy() }))
}

// ---------------------------------------------------------------- the map as text

pub fn map_text(rows: &[(usize, String)]) -> String {
    rows.iter().map(|(n, name)| format!("{n}  {name}\n")).collect()
}

pub fn map_csv(rows: &[(usize, String)]) -> String {
    let mut s = String::from("number,file\n");
    for (n, name) in rows {
        let q = if name.contains([',', '"', '\n']) { format!("\"{}\"", name.replace('"', "\"\"")) } else { name.clone() };
        s.push_str(&format!("{n},{q}\n"));
    }
    s
}

// ---------------------------------------------------------------- the commands

/// The drive `id` as the computer lists it now; refuses one Studio must not write to (checked here, not only in
/// the UI).
fn drive_for_write(plat: &dyn Platform, id: &str) -> Result<Drive, String> {
    let d = plat.drives()?.into_iter().find(|d| d.id == id).ok_or("That card is not there any more. Put it back in and press Refresh.")?;
    if d.system {
        return Err("This drive holds your computer's system. Studio never writes to it.".into());
    }
    if !d.removable {
        return Err("This is not a removable drive. Studio never erases or writes to a drive built into the computer.".into());
    }
    Ok(d)
}

fn mount_of(d: &Drive) -> Result<PathBuf, String> {
    d.mount.clone().map(PathBuf::from).filter(|p| p.is_dir()).ok_or_else(|| "The computer has not opened this card, so Studio cannot see its files. Take it out, put it back in, and press Refresh (or tick “Erase and format”).".into())
}

fn sounds_arg(a: &Value) -> Vec<Sound> {
    a["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(|p| Sound::from_path(Path::new(p))).collect()
}

fn emit(ev: &broadcast::Sender<Event>, phase: &str, done: usize, total: usize, file: &str) {
    let _ = ev.send(Event::SdCard { phase: phase.into(), done, total, file: file.into() });
}

/// `sdcard_*` commands (lib.rs dispatch).
pub async fn dispatch(cmd: &str, a: &Value, ev: &broadcast::Sender<Event>) -> Result<Value, String> {
    let (cmd, a, ev) = (cmd.to_string(), a.clone(), ev.clone());
    tokio::task::spawn_blocking(move || run(&cmd, &a, drives::platform(), &ev)).await.map_err(|e| e.to_string())?
}

/// The commands, on any platform (tests pass a fake one).
pub fn run(cmd: &str, a: &Value, plat: &dyn Platform, ev: &broadcast::Sender<Event>) -> Result<Value, String> {
    let progress = |phase: &str, done: usize, total: usize, file: &str| emit(ev, phase, done, total, file);
    match cmd {
        "sdcard_drives" => {
            let all = plat.drives()?;
            Ok(json!({ "drives": drives::choose(&all, a["show_all"] == true), "card_max_bytes": drives::CARD_MAX_BYTES, "mp3_folder_max": MP3_FOLDER_MAX, "windows": cfg!(windows), "windows_fat32_max_bytes": drives::WINDOWS_FAT32_MAX_BYTES }))
        }
        // the sounds the person added: name, size, and whether they can go on the card
        "sdcard_sounds" => Ok(json!(a["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(|p| {
            let path = Path::new(p);
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(p).to_string();
            let m = std::fs::metadata(path).ok();
            let why = match &m {
                None => Some("not found".to_string()),
                Some(m) if !m.is_file() => Some("not a file".to_string()),
                _ if !AUDIO_EXTS.contains(&ext_of(&name).as_str()) => Some("not an MP3 or WAV file".to_string()),
                _ => None,
            };
            json!({ "path": p, "name": name, "description": sanitize(path.file_stem().and_then(|s| s.to_str()).unwrap_or("")), "ext": ext_of(&name), "size": m.map(|m| m.len()).unwrap_or(0), "ok": why.is_none(), "why": why })
        }).collect::<Vec<_>>())),
        // what copying without formatting would delete
        "sdcard_plan" => {
            let d = drive_for_write(plat, a["drive"].as_str().unwrap_or(""))?;
            let root = mount_of(&d)?;
            Ok(json!({ "drive": d, "delete": plan_clear(&root)? }))
        }
        "sdcard_write" => {
            let mut d = drive_for_write(plat, a["drive"].as_str().unwrap_or(""))?;
            let sounds = sounds_arg(a);
            let mut notes: Vec<String> = vec![];
            if a["format"] == true {
                // the person typed the card's name to confirm
                let typed = a["confirm"].as_str().unwrap_or("").trim();
                if !typed.eq_ignore_ascii_case(d.name.trim()) {
                    return Err(format!("To erase the card, type its name exactly: {}", d.name));
                }
                if let Some(m) = d.mount.as_deref() { check_sounds(&sounds, Path::new(m))?; } else { check_sounds(&sounds, Path::new("/nonexistent-card"))?; }
                let label = drives::fat_label(a["label"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or(if d.label.is_empty() { "SOUNDS" } else { &d.label }));
                progress("format", 0, 1, &d.name);
                d = plat.format(&d, &label)?;
                notes.push(format!("The card was erased and formatted as FAT32, named {label}."));
            } else {
                let root = mount_of(&d)?;
                check_sounds(&sounds, &root)?;
                // the list the person was shown and agreed to (sdcard_plan): refuse when the card changed since
                if let Some(shown) = a["delete"].as_array() {
                    let now = plan_clear(&root)?;
                    let shown: Vec<String> = shown.iter().filter_map(|x| x.as_str().map(String::from)).collect();
                    if now.iter().any(|n| !shown.contains(n)) {
                        return Err("The files on the card changed since Studio listed them. Press Copy again to see the new list.".into());
                    }
                }
                progress("clear", 0, 1, &d.name);
                clear_card(&root, plat)?;
            }
            let root = mount_of(&d)?;
            let map = write_sounds(&root, &sounds, plat, &progress, None)?;
            let junk = clean_mac_junk(&root);
            if !junk.is_empty() { notes.push(format!("Deleted hidden Mac files: {}.", junk.join(", "))); }
            if let Some(n) = plat.no_index(&d) { notes.push(n); }
            progress("done", map.len(), map.len(), "");
            Ok(json!({ "map": map, "notes": notes, "drive": d }))
        }
        "sdcard_eject" => {
            let d = plat.drives()?.into_iter().find(|d| d.id == a["drive"].as_str().unwrap_or("")).ok_or("That card is not there any more: it may already be out.")?;
            Ok(json!({ "message": plat.eject(&d)? }))
        }
        // Check: a drive (by id, any drive: it only reads) or a folder
        "sdcard_check" => {
            let (root, fs) = if let Some(id) = a["drive"].as_str().filter(|s| !s.is_empty()) {
                let d = plat.drives()?.into_iter().find(|d| d.id == id).ok_or("That card is not there any more. Put it back in and press Refresh.")?;
                (mount_of(&d)?, Some(d.fs.clone()))
            } else {
                (PathBuf::from(a["folder"].as_str().filter(|s| !s.is_empty()).ok_or("Choose a card or a folder to check.")?), None)
            };
            Ok(json!(check_card(&root, fs.as_deref(), plat)?))
        }
        "sdcard_fix" => {
            let d = drive_for_write(plat, a["drive"].as_str().unwrap_or(""))?;
            let root = mount_of(&d)?;
            let backup = std::env::temp_dir().join(format!("specter-sd-card-copy-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
            let r = fix(&root, &backup, plat, &progress)?;
            progress("done", 1, 1, "");
            Ok(r)
        }
        // the /mp3 names of a card or folder (for "3 · scream" hints)
        "sdcard_names" => {
            let f = PathBuf::from(a["folder"].as_str().filter(|s| !s.is_empty()).ok_or("Choose a card or a folder.")?);
            let dir = if f.join("mp3").is_dir() { f.join("mp3") } else { f };
            let mut names: Vec<String> = std::fs::read_dir(&dir).map_err(|e| format!("Studio cannot read {} ({e}).", dir.display()))?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !hidden(n)).collect();
            names.sort();
            Ok(json!(names))
        }
        // Save list…: the text is made here from the numbers and names; only .csv or .txt files
        "sdcard_save_list" => {
            let path = PathBuf::from(a["path"].as_str().filter(|s| !s.is_empty()).ok_or("Choose where to save the list.")?);
            let ext = ext_of(&path.to_string_lossy());
            let rows: Vec<(usize, String)> = a["rows"].as_array().into_iter().flatten().map(|r| (r["number"].as_u64().unwrap_or(0) as usize, r["name"].as_str().unwrap_or("").replace(['\n', '\r'], " "))).collect();
            let text = match ext.as_str() { "csv" => map_csv(&rows), "txt" => map_text(&rows), _ => return Err("Save the list as a .csv or .txt file.".into()) };
            crate::library::write_atomic(&path, text.as_bytes())?;
            Ok(json!({ "path": path.to_string_lossy() }))
        }
        _ => Err(format!("unknown command {cmd}")),
    }
}

#[cfg(test)]
mod tests;
