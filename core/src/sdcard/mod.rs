//! The SD card for the board's sound player (a DFPlayer Mini).
//!
//! One sound per folder: sound N is the single file in the folder `NN` in the card's root, `01/001-rain.mp3`,
//! `02/001-elevator.mp3` ... (folders 01 to 99, two digits; the file starts with `001`, the rest of the name is
//! free). A script says `audio_single = 2` and the player plays folder 02, track 1, so the order the files were
//! written to the card does not matter. Studio's Check reads the root and every two-digit folder and says in
//! plain words what would make a number play nothing or the wrong sound.
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

/// The most sounds a card holds: one per folder, folders 01 to 99.
pub const SOUND_FOLDERS_MAX: usize = 99;
/// The sound formats the player plays (MP3 and WAV, 8 to 48 kHz).
pub const AUDIO_EXTS: [&str; 2] = ["mp3", "wav"];
/// Junk the Mac leaves on cards (Spotlight, file system events, the trash).
pub const MAC_FOLDERS: [&str; 3] = [".Spotlight-V100", ".fseventsd", ".Trashes"];

fn ext_of(name: &str) -> String {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

fn is_audio(name: &str) -> bool {
    AUDIO_EXTS.contains(&ext_of(name).as_str())
}

/// A description FAT accepts: no `\ / : * ? " < > |` or control characters, no dots or spaces at the end.
pub fn sanitize(desc: &str) -> String {
    let s: String = desc.chars().filter(|c| !c.is_control() && !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    s.trim().trim_end_matches(['.', ' ']).trim().to_string()
}

/// A sound folder's number: `03` -> 3. Only two digits, 01 to 99.
pub fn folder_number(name: &str) -> Option<usize> {
    let b = name.as_bytes();
    if b.len() != 2 || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let n: usize = name.parse().ok()?;
    (n >= 1).then_some(n)
}

/// The folder of sound `n`: `03`.
pub fn folder_name(n: usize) -> String {
    format!("{n:02}")
}

/// The file name of a sound in its folder: `001-rain.mp3` (at most 255 characters, FAT's limit for one name; no
/// description: `001.mp3`).
pub fn file_name(desc: &str, ext: &str) -> String {
    let ext = ext.to_lowercase();
    let room = 255 - 4 - 1 - ext.chars().count();
    let d: String = sanitize(desc).chars().take(room).collect();
    let d = d.trim_end_matches(['.', ' ']).to_string();
    if d.is_empty() { format!("001.{ext}") } else { format!("001-{d}.{ext}") }
}

/// The card name of sound `n`: `01/001-rain.mp3`.
pub fn card_name(n: usize, desc: &str, ext: &str) -> String {
    format!("{}/{}", folder_name(n), file_name(desc, ext))
}

/// A sound file's description: its name without the extension, the leading digits and the `-` after them
/// (`001-scream.mp3`, `0003_scream.mp3` and `scream.mp3` -> `scream`).
pub fn desc_of(file: &str) -> String {
    let stem = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or(file);
    stem.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches(['-', '_', ' ', '.']).to_string()
}

/// The number a file name starts with (`002-x.mp3` -> 2), `None` when it does not start with a digit.
fn leading_number(file: &str) -> Option<u64> {
    let digits: String = file.chars().take_while(char::is_ascii_digit).take(18).collect();
    digits.parse().ok()
}

/// A card name's sound number (its folder) and description: `03/001-scream.mp3` -> (3, "scream").
pub fn parse_name(name: &str) -> Option<(u32, String)> {
    let (folder, file) = name.split_once(['/', '\\'])?;
    let n = folder_number(folder)?;
    Some((n as u32, desc_of(file)))
}

/// The sound file the player plays from a folder (an index into `entries`, which are in directory order): the
/// first one whose name starts with `001`, else the lowest-numbered, else the first. Check, Fix and the
/// typeahead names all use this one choice.
pub fn keeper(entries: &[Entry]) -> Option<usize> {
    let sounds: Vec<usize> = (0..entries.len()).filter(|&i| !entries[i].dir && !hidden(&entries[i].name) && is_audio(&entries[i].name)).collect();
    if let Some(&i) = sounds.iter().find(|&&i| entries[i].name.starts_with("001")) {
        return Some(i);
    }
    let numbered = sounds.iter().filter_map(|&i| leading_number(&entries[i].name).map(|n| (n, i))).min();
    numbered.map(|x| x.1).or_else(|| sounds.first().copied())
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

fn too_many(n: usize) -> String {
    format!("A card holds at most {SOUND_FOLDERS_MAX} sounds (each one goes in its own folder, 01 to {SOUND_FOLDERS_MAX}); you have {n}. Take some off the list.")
}

/// Checks the sounds before anything on the card is touched: each one a readable .mp3 or .wav file, not on the
/// card itself, at most [`SOUND_FOLDERS_MAX`].
pub fn check_sounds(sounds: &[Sound], card: &Path) -> Result<(), String> {
    if sounds.is_empty() {
        return Err("Add at least one sound first.".into());
    }
    if sounds.len() > SOUND_FOLDERS_MAX {
        return Err(too_many(sounds.len()));
    }
    let card = dunce::canonicalize(card).unwrap_or_else(|_| card.to_path_buf());
    for s in sounds {
        let name = s.src.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        let m = std::fs::metadata(&s.src).map_err(|_| format!("“{name}” is not there any more ({}). Remove it from the list or add it again.", s.src.display()))?;
        if !m.is_file() {
            return Err(format!("“{name}” is not a sound file."));
        }
        if !is_audio(&name) {
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
/// into `._` files on FAT) and makes sure it is on the card before going on.
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

/// Writes sound n into its own new folder `NN` (made fresh: it must not exist yet) as `001-<desc>.<ext>`, in list
/// order. `fail_at` (tests): sound number that fails. A failure stops the copy, removes the half written file
/// (and its folder) and says plainly how far it got; the person's own files are only read.
pub fn write_sounds(card: &Path, sounds: &[Sound], plat: &dyn Platform, progress: Progress, fail_at: Option<usize>) -> Result<Vec<MapRow>, String> {
    if sounds.len() > SOUND_FOLDERS_MAX {
        return Err(too_many(sounds.len()));
    }
    let mut map = vec![];
    for (i, s) in sounds.iter().enumerate() {
        let n = i + 1;
        let folder = folder_name(n);
        let file = file_name(&s.desc, &ext_of(&s.src.to_string_lossy()));
        let name = format!("{folder}/{file}");
        let src_name = s.src.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
        let stopped = |what: String| {
            let done = match n {
                1 => "Nothing was copied yet".to_string(),
                2 => "Sounds 1 to 1 are on the card (folder 01)".to_string(),
                _ => format!("Sounds 1 to {} are on the card (folders 01 to {})", n - 1, folder_name(n - 1)),
            };
            format!("Copying stopped at sound {n} (“{src_name}”): {what}. {done}. Your sound files on this computer are untouched. Check the card is in properly and not locked (the little switch on its side), then press Copy again: Studio starts over.")
        };
        progress("copy", i, sounds.len(), &name);
        let dir = card.join(&folder);
        std::fs::create_dir(&dir).map_err(|e| stopped(format!("Studio could not make the folder {folder} on the card ({e})")))?;
        plat.created(card, &folder);
        let dst = dir.join(&file);
        let r = if fail_at == Some(n) { Err(std::io::Error::other("the card stopped answering (test)")) } else { copy_bytes(&s.src, &dst) };
        if let Err(e) = r {
            let _ = std::fs::remove_file(&dst);
            let _ = std::fs::remove_dir(&dir);
            plat.removed(&dir);
            return Err(stopped(e.to_string()));
        }
        plat.created(&dir, &file);
        sync_dir(&dir);
        map.push(MapRow { number: n, name, description: sanitize(&s.desc), source: s.src.to_string_lossy().into_owned() });
    }
    sync_dir(card);
    progress("copy", sounds.len(), sounds.len(), "");
    Ok(map)
}

/// The card's sound folders (`01` … `99`), sorted.
fn sound_folders(card: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(card).into_iter().flatten().flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| folder_number(n).is_some()).collect();
    v.sort();
    v
}

/// Deletes what macOS leaves on a card: `._*` and `.DS_Store` files (in the root and in every sound folder) and
/// its index, event and trash folders in the root. Gives back what it deleted.
pub fn clean_mac_junk(card: &Path) -> Vec<String> {
    let mut gone = vec![];
    let dirs = std::iter::once((card.to_path_buf(), String::new())).chain(sound_folders(card).into_iter().map(|f| (card.join(&f), format!("{f}/"))));
    for (dir, prefix) in dirs {
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

/// What "copy without formatting" deletes: everything in the card's root and in each sound folder, as `name`,
/// `folder/` and `03/001-x.mp3`.
pub fn plan_clear(card: &Path) -> Result<Vec<String>, String> {
    let mut out = vec![];
    let mut root: Vec<_> = std::fs::read_dir(card).map_err(|e| format!("Studio cannot read the card ({e})."))?.flatten().collect();
    root.sort_by_key(|e| e.file_name());
    for e in root {
        let n = e.file_name().to_string_lossy().into_owned();
        if n == WINDOWS_FOLDER { continue; }
        let dir = e.path().is_dir();
        out.push(if dir { format!("{n}/") } else { n.clone() });
        if dir && folder_number(&n).is_some() {
            let mut inner: Vec<String> = std::fs::read_dir(e.path()).into_iter().flatten().flatten().map(|x| x.file_name().to_string_lossy().into_owned()).collect();
            inner.sort();
            out.extend(inner.into_iter().map(|x| format!("{n}/{x}")));
        }
    }
    Ok(out)
}

/// Deletes everything in the card's root (the sound folders too, so they are made new). Windows' own system
/// folder is left alone.
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

/// A sound on the card as Check sees it: the file the player plays from folder `number`.
#[derive(Clone, Debug, Serialize)]
pub struct CardFile {
    /// the folder number (sound N is folder N)
    pub position: usize,
    /// `03/001-scream.mp3`
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
    /// Fix mends it
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

/// What is wrong with a card: its root, its sound folders (`("03", entries in directory order)`, sorted by
/// number) and its file system (`None`: not known, a plain folder).
pub fn check(root: &[Entry], folders: &[(String, Vec<Entry>)], fs: Option<&str>) -> Report {
    let mut problems = vec![];
    let mut p = |code, words: String, names: Vec<String>, fixable| problems.push(Problem { code, words, names, fixable });
    let fs_words = fs.map(drives::fs_words);
    if let Some(f) = fs {
        if !drives::fs_is_fat(f) {
            p("not_fat", format!("The card uses {}. The sound player reads only FAT32 (or FAT16) cards: copy your sounds again with “Erase and format FAT32” ticked.", drives::fs_words(f)), vec![], false);
        }
    }
    let mut hid: Vec<String> = root.iter().filter(|e| hidden(&e.name)).map(|e| e.name.clone()).collect();
    for (f, es) in folders {
        hid.extend(es.iter().filter(|e| hidden(&e.name)).map(|e| format!("{f}/{}", e.name)));
    }
    if !hid.is_empty() {
        p("hidden", format!("Hidden files a Mac leaves behind are on the card: {}. They can confuse the player. Fix deletes them.", list_words(&hid)), hid, true);
    }
    let extra: Vec<String> = root
        .iter()
        .filter(|e| e.name != WINDOWS_FOLDER && !hidden(&e.name) && !(e.dir && folder_number(&e.name).is_some()))
        .map(|e| if e.dir { format!("{}/", e.name) } else { e.name.clone() })
        .collect();
    if !extra.is_empty() {
        let old = if extra.iter().any(|x| x.eq_ignore_ascii_case("mp3/")) {
            " The mp3 folder is the old layout: the player now plays sound 1 from folder 01, sound 2 from folder 02 and so on."
        } else {
            ""
        };
        p("extra_root", format!("Other things are in the card's top folder: {}.{old} The player only plays sounds in the folders 01, 02 …, and other files can confuse it. Copy your sounds again with Studio (it clears the card).", list_words(&extra)), extra, false);
    }
    if folders.is_empty() {
        p("no_sounds", "There are no sound folders (01, 02 …) on this card, so the sound player finds no sounds. Use Copy to put your sounds on it.".into(), vec![], false);
    }
    let (mut files, mut subfolders, mut empty, mut several, mut not_001, mut unsupported) = (vec![], vec![], vec![], vec![], vec![], vec![]);
    for (f, es) in folders {
        let n = folder_number(f).unwrap_or(0);
        let k = keeper(es);
        for (i, e) in es.iter().enumerate() {
            if hidden(&e.name) || Some(i) == k { continue; }
            let name = format!("{f}/{}", e.name);
            if e.dir { subfolders.push(format!("{name}/")); } else if is_audio(&e.name) { several.push(name); } else { unsupported.push(name); }
        }
        match k {
            None => empty.push(f.clone()),
            Some(k) => {
                let e = &es[k];
                if !e.name.starts_with("001") { not_001.push(format!("{f}/{}", e.name)); }
                files.push(CardFile { position: n, name: format!("{f}/{}", e.name), number: Some(n as u32), description: desc_of(&e.name), size: e.size });
            }
        }
    }
    if !subfolders.is_empty() {
        p("folders", format!("Sound folders have folders inside them ({}). The player ignores them; each sound folder holds just one sound file.", list_words(&subfolders)), subfolders, false);
    }
    if !empty.is_empty() {
        let nums: Vec<String> = empty.iter().map(|f| folder_number(f).unwrap_or(0).to_string()).collect();
        let plays = if nums.len() == 1 { format!("Sound {} plays nothing (`audio_single = {}`)", nums[0], nums[0]) } else { format!("Sounds {} play nothing", list_words(&nums)) };
        p("no_sound", format!("These sound folders have no MP3 or WAV file in them: {}. {plays}. Put one sound in each, or copy your sounds again.", list_words(&empty)), empty, false);
    }
    if !several.is_empty() {
        p("several", format!("Some sound folders have more than one sound file: {}. Each folder holds one sound. Fix keeps the one starting with 001 (or the lowest-numbered) and moves the others off the card (a copy is kept on this computer).", list_words(&several)), several, true);
    }
    if !not_001.is_empty() {
        p("not_001", format!("These sounds do not start with 001, so the player does not find them as their folder's sound: {}. Fix renames them to 001-…, keeping the rest of the name.", list_words(&not_001)), not_001, true);
    }
    if !unsupported.is_empty() {
        p("unsupported", format!("These files are not MP3 or WAV, so the player cannot play them: {}. Fix moves them off the card (a copy is kept on this computer).", list_words(&unsupported)), unsupported, true);
    }
    let have: Vec<usize> = folders.iter().filter_map(|(f, _)| folder_number(f)).collect();
    if let Some(&max) = have.iter().max() {
        let missing: Vec<String> = (1..=max).filter(|n| !have.contains(n)).map(|n| n.to_string()).collect();
        if !missing.is_empty() {
            let first = &missing[0];
            p("gaps", format!("Some numbers have no sound folder: {}. That is fine if you meant it, but `audio_single = {first}` plays nothing.", list_words(&missing)), missing, false);
        }
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

/// The sound folders listed in `root` with their entries, sorted by number.
fn read_folders(card: &Path, root: &[Entry], plat: &dyn Platform) -> Result<Vec<(String, Vec<Entry>)>, String> {
    let mut names: Vec<String> = root.iter().filter(|e| e.dir && folder_number(&e.name).is_some()).map(|e| e.name.clone()).collect();
    names.sort();
    names.into_iter().map(|f| Ok((f.clone(), read_entries(&card.join(&f), plat)?.unwrap_or_default()))).collect()
}

/// Check a card (or a folder standing in for one).
pub fn check_card(card: &Path, fs: Option<&str>, plat: &dyn Platform) -> Result<Report, String> {
    let root = read_entries(card, plat)?.ok_or_else(|| format!("Studio cannot open {}.", card.display()))?;
    let folders = read_folders(card, &root, plat)?;
    Ok(check(&root, &folders, fs))
}

/// Fix: copies every file of every sound folder off the card into `backup/NN/` and checks the sizes BEFORE
/// changing anything; then deletes the hidden Mac files, moves extra sound files and files the player cannot
/// play off the card (they stay in the backup) and renames a folder's sound to `001-<desc>.<ext>` when it does
/// not start with 001.
pub fn fix(card: &Path, backup: &Path, plat: &dyn Platform, progress: Progress) -> Result<Value, String> {
    let root = read_entries(card, plat)?.ok_or_else(|| format!("Studio cannot open {}.", card.display()))?;
    let folders = read_folders(card, &root, plat)?;
    let unchanged = "Nothing on the card was changed.";
    std::fs::create_dir_all(backup).map_err(|e| format!("Studio could not make a folder on this computer for the copy ({e}). {unchanged}"))?;
    // 1. copy off and verify
    let todo: Vec<(&str, &Entry)> = folders.iter().flat_map(|(f, es)| es.iter().filter(|e| !e.dir && !hidden(&e.name)).map(move |e| (f.as_str(), e))).collect();
    for (i, (f, e)) in todo.iter().enumerate() {
        let shown = format!("{f}/{}", e.name);
        progress("backup", i, todo.len(), &shown);
        let dir = backup.join(f);
        std::fs::create_dir_all(&dir).map_err(|err| format!("Studio could not make a folder on this computer for the copy of “{shown}” ({err}). {unchanged}"))?;
        let to = dir.join(&e.name);
        let _ = std::fs::remove_file(&to);
        let n = copy_bytes(&card.join(f).join(&e.name), &to).map_err(|err| format!("Studio could not copy “{shown}” off the card ({err}). {unchanged}"))?;
        let back = std::fs::metadata(&to).map(|m| m.len()).unwrap_or(u64::MAX);
        if n != e.size || back != e.size {
            return Err(format!("The copy of “{shown}” on this computer is not the same size as on the card, so Studio stopped. {unchanged}"));
        }
    }
    progress("backup", todo.len(), todo.len(), "");
    let safe = format!("A copy of everything that was in the sound folders is in {}.", backup.display());
    // 2. hidden files
    let junk = clean_mac_junk(card);
    // 3. one sound per folder, starting with 001
    let (mut map, mut renamed, mut left_off) = (vec![], vec![], vec![]);
    for (f, es) in &folders {
        let n = folder_number(f).unwrap_or(0);
        let dir = card.join(f);
        let k = keeper(es);
        for (i, e) in es.iter().enumerate() {
            if e.dir || hidden(&e.name) || Some(i) == k { continue; }
            std::fs::remove_file(dir.join(&e.name)).map_err(|err| format!("Studio could not move “{f}/{}” off the card ({err}). {safe}", e.name))?;
            left_off.push(format!("{f}/{}", e.name));
        }
        if let Some(k) = k {
            let e = &es[k];
            let mut name = e.name.clone();
            if !name.starts_with("001") {
                let to = file_name(&desc_of(&e.name), &ext_of(&e.name));
                std::fs::rename(dir.join(&e.name), dir.join(&to)).map_err(|err| format!("Studio could not rename “{f}/{}” to “{to}” ({err}). {safe}", e.name))?;
                plat.created(&dir, &to);
                renamed.push(json!({ "from": format!("{f}/{}", e.name), "to": format!("{f}/{to}"), "number": n }));
                name = to;
            }
            map.push(MapRow { number: n, name: format!("{f}/{name}"), description: desc_of(&name), source: backup.join(f).join(&e.name).to_string_lossy().into_owned() });
        }
        sync_dir(&dir);
    }
    sync_dir(card);
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
            Ok(json!({ "drives": drives::choose(&all, a["show_all"] == true), "card_max_bytes": drives::CARD_MAX_BYTES, "sounds_max": SOUND_FOLDERS_MAX, "windows": cfg!(windows), "windows_fat32_max_bytes": drives::WINDOWS_FAT32_MAX_BYTES }))
        }
        // the sounds the person added: name, size, and whether they can go on the card
        "sdcard_sounds" => Ok(json!(a["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(|p| {
            let path = Path::new(p);
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(p).to_string();
            let m = std::fs::metadata(path).ok();
            let why = match &m {
                None => Some("not found".to_string()),
                Some(m) if !m.is_file() => Some("not a file".to_string()),
                _ if !is_audio(&name) => Some("not an MP3 or WAV file".to_string()),
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
        // the sound names of a card or folder (for "3 · scream" hints): `03/001-scream.mp3`, the sound the player
        // plays from each two-digit folder
        "sdcard_names" => {
            let f = PathBuf::from(a["folder"].as_str().filter(|s| !s.is_empty()).ok_or("Choose a card or a folder.")?);
            let root = read_entries(&f, plat)?.ok_or_else(|| format!("Studio cannot read {}.", f.display()))?;
            let names: Vec<String> = read_folders(&f, &root, plat)?.into_iter().filter_map(|(d, es)| keeper(&es).map(|k| format!("{d}/{}", es[k].name))).collect();
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
