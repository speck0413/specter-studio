//! The SD card tool on temp folders standing in for cards (the fake platform: no command ever runs).

use super::drives::*;
use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("studio-sdcard-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Three sound files on "this computer", and an empty card.
fn setup(name: &str) -> (PathBuf, PathBuf, Vec<Sound>) {
    let base = tmp(name);
    let (src, card) = (base.join("computer"), base.join("card"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&card).unwrap();
    let mut sounds = vec![];
    for (n, body) in [("rain.mp3", "RAIN"), ("elevator.wav", "ELEVATOR!"), ("scream: loud?.mp3", "AAAA")] {
        let p = src.join(n.replace([':', '?'], "_"));
        std::fs::write(&p, body).unwrap();
        sounds.push(Sound { src: p, desc: Path::new(n).file_stem().unwrap().to_str().unwrap().to_string() });
    }
    (src, card, sounds)
}

fn fake(card: &Path) -> FakePlatform {
    FakePlatform::new(vec![Drive { id: "card1".into(), label: "SOUNDS".into(), mount: Some(card.to_string_lossy().into()), size: 8_000_000_000, removable: true, fs: "vfat".into(), ..Default::default() }])
}

fn no_progress(_: &str, _: usize, _: usize, _: &str) {}

/// A runner that must never be called (formatting or ejecting a fake drive).
struct Forbidden(AtomicUsize);
impl Runner for Forbidden {
    fn run(&self, prog: &str, _: &[&str], _: Option<&str>, _: Duration) -> Result<String, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("a command ran in a test: {prog}");
    }
}

#[test]
fn names_are_folder_numbered_and_safe_for_fat() {
    assert_eq!(card_name(1, "rain", "mp3"), "01/001-rain.mp3");
    assert_eq!(card_name(12, "elevator", "WAV"), "12/001-elevator.wav");
    assert_eq!(card_name(3, "scream: loud?", "mp3"), "03/001-scream loud.mp3");
    assert_eq!(card_name(4, "a\\b/c*d\"e<f>g|h\u{7}i", "mp3"), "04/001-abcdefghi.mp3");
    assert_eq!(card_name(5, "trailing dots...  ", "mp3"), "05/001-trailing dots.mp3");
    assert_eq!(card_name(6, "???", "mp3"), "06/001.mp3");
    assert_eq!(card_name(99, "x", "mp3"), "99/001-x.mp3");
    // FAT's 255 characters are per name: the file part
    let long = file_name(&"x".repeat(400), "mp3");
    assert_eq!(long.chars().count(), 255);
    assert!(long.starts_with("001-x") && long.ends_with(".mp3"));
    assert_eq!(card_name(7, &"x".repeat(400), "mp3"), format!("07/{long}"));
    assert_eq!(parse_name("03/001-scream.mp3"), Some((3, "scream".into())));
    assert_eq!(parse_name("10/001.wav"), Some((10, "".into())));
    assert_eq!(parse_name("02/0001_odd.mp3"), Some((2, "odd".into())));
    assert_eq!(parse_name("001-scream.mp3"), None);
    assert_eq!(parse_name("mp3/0001-x.mp3"), None);
    assert_eq!(parse_name("00/001-x.mp3"), None);
    assert_eq!((folder_number("01"), folder_number("99"), folder_number("00"), folder_number("1"), folder_number("100"), folder_number("ab")), (Some(1), Some(99), None, None, None, None));
    assert_eq!(desc_of("002-x.mp3"), "x");
    assert_eq!(desc_of("scream.mp3"), "scream");
    assert_eq!(SOUND_FOLDERS_MAX, 99);
}

#[test]
fn the_keeper_is_001_then_the_lowest_number_then_the_first() {
    assert_eq!(keeper(&[e("b.mp3"), e("002-x.mp3"), e("001-a.wav"), e("001-z.mp3")]), Some(2));
    assert_eq!(keeper(&[e("b.mp3"), e("010-x.mp3"), e("3-y.mp3"), e("cover.jpg")]), Some(2));
    assert_eq!(keeper(&[e("._001-a.mp3"), e("cover.jpg"), e("b.mp3"), e("a.wav")]), Some(2));
    assert_eq!(keeper(&[e("cover.jpg"), Entry { name: "001.mp3".into(), size: 0, dir: true }]), None);
}

#[test]
fn copies_each_sound_into_its_own_folder() {
    let (src, card, sounds) = setup("order");
    let plat = fake(&card);
    let map = write_sounds(&card, &sounds, &plat, &no_progress, None).unwrap();
    let names: Vec<&str> = map.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["01/001-rain.mp3", "02/001-elevator.wav", "03/001-scream loud.mp3"]);
    assert_eq!(map.iter().map(|r| r.number).collect::<Vec<_>>(), [1, 2, 3]);
    let mut root: Vec<String> = std::fs::read_dir(&card).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into()).collect();
    root.sort();
    assert_eq!(root, ["01", "02", "03"]);
    for f in ["01", "02", "03"] { assert_eq!(std::fs::read_dir(card.join(f)).unwrap().count(), 1); }
    assert_eq!(std::fs::read_to_string(card.join("02/001-elevator.wav")).unwrap(), "ELEVATOR!");
    // the source files are still there, unchanged
    assert_eq!(std::fs::read_to_string(src.join("rain.mp3")).unwrap(), "RAIN");
    // and Check finds nothing wrong
    let r = check_card(&card, Some("vfat"), &plat).unwrap();
    assert!(r.problems.is_empty(), "{:?}", r.problems);
    assert_eq!(r.files.iter().map(|f| (f.number.unwrap(), f.position, f.name.as_str(), f.description.as_str())).collect::<Vec<_>>(), [(1, 1, "01/001-rain.mp3", "rain"), (2, 2, "02/001-elevator.wav", "elevator"), (3, 3, "03/001-scream loud.mp3", "scream loud")]);
    // a folder already there is not written into
    let e = write_sounds(&card, &sounds, &plat, &no_progress, None).unwrap_err();
    assert!(e.contains("could not make the folder 01") && e.contains("Nothing was copied yet"), "{e}");
}

#[test]
fn the_100th_sound_is_refused_before_the_card_is_touched() {
    let (src, card, mut sounds) = setup("many");
    let one = sounds[0].clone();
    while sounds.len() < 100 { sounds.push(one.clone()); }
    let plat = fake(&card);
    let e = check_sounds(&sounds, &card).unwrap_err();
    assert!(e.contains("at most 99 sounds") && e.contains("you have 100"), "{e}");
    let e = write_sounds(&card, &sounds, &plat, &no_progress, None).unwrap_err();
    assert!(e.contains("at most 99"), "{e}");
    assert_eq!(std::fs::read_dir(&card).unwrap().count(), 0);
    sounds.pop();
    assert!(check_sounds(&sounds, &card).is_ok());
    let map = write_sounds(&card, &sounds, &plat, &no_progress, None).unwrap();
    assert_eq!(map[98].name, "99/001-rain.mp3");
    assert!(src.join("rain.mp3").exists());
}

#[test]
fn mac_junk_is_removed_from_the_root_and_the_sound_folders() {
    let (_, card, sounds) = setup("junk");
    let plat = fake(&card);
    write_sounds(&card, &sounds, &plat, &no_progress, None).unwrap();
    for f in ["._01", ".DS_Store", "01/._001-rain.mp3", "02/.DS_Store", "03/._001-scream loud.mp3"] { std::fs::write(card.join(f), "x").unwrap(); }
    for d in [".Spotlight-V100", ".fseventsd", ".Trashes"] { std::fs::create_dir_all(card.join(d).join("inner")).unwrap(); }
    // only the card's sound folders are cleaned: a folder that is not one is left alone
    std::fs::create_dir_all(card.join("photos")).unwrap();
    std::fs::write(card.join("photos/._x"), "x").unwrap();
    let mut gone = clean_mac_junk(&card);
    gone.sort();
    assert_eq!(gone, [".DS_Store", ".Spotlight-V100", ".Trashes", "._01", ".fseventsd", "01/._001-rain.mp3", "02/.DS_Store", "03/._001-scream loud.mp3"]);
    for f in ["01", "02", "03"] { assert_eq!(std::fs::read_dir(card.join(f)).unwrap().count(), 1); }
    assert!(card.join("photos/._x").exists());
}

#[test]
fn without_formatting_lists_then_deletes_and_makes_the_folders_new() {
    let (_, card, sounds) = setup("clear");
    let plat = fake(&card);
    std::fs::create_dir_all(card.join("mp3")).unwrap();
    std::fs::write(card.join("mp3/0001-old.mp3"), "old").unwrap();
    std::fs::create_dir_all(card.join("03")).unwrap();
    std::fs::write(card.join("03/001-x.mp3"), "x").unwrap();
    std::fs::write(card.join("03/notes.txt"), "x").unwrap();
    std::fs::write(card.join("notes.txt"), "n").unwrap();
    std::fs::create_dir_all(card.join("photos")).unwrap();
    std::fs::create_dir_all(card.join("System Volume Information")).unwrap();
    assert_eq!(plan_clear(&card).unwrap(), ["03/", "03/001-x.mp3", "03/notes.txt", "mp3/", "notes.txt", "photos/"]);
    let ev = broadcast::channel(64).0;
    let files: Vec<String> = sounds.iter().map(|s| s.src.to_string_lossy().into()).collect();
    let shown = plan_clear(&card).unwrap();
    let r = run("sdcard_write", &json!({ "drive": "card1", "files": files, "format": false, "delete": shown }), &plat, &ev).unwrap();
    assert_eq!(r["map"].as_array().unwrap().len(), 3);
    assert!(!card.join("notes.txt").exists() && !card.join("photos").exists() && !card.join("mp3").exists() && !card.join("03/001-x.mp3").exists());
    assert!(card.join("System Volume Information").exists());
    assert_eq!(std::fs::read_dir(card.join("03")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>(), ["001-scream_ loud_.mp3"]);
    assert!(check_card(&card, Some("vfat"), &plat).unwrap().problems.is_empty());
    // a card that changed since the list was shown is refused
    std::fs::write(card.join("new.txt"), "n").unwrap();
    let e = run("sdcard_write", &json!({ "drive": "card1", "files": files, "format": false, "delete": ["01/"] }), &plat, &ev).unwrap_err();
    assert!(e.contains("changed since"), "{e}");
}

#[test]
fn formatting_a_fake_drive_runs_no_command_and_needs_the_typed_name() {
    let (_, card, sounds) = setup("format");
    std::fs::write(card.join("old.txt"), "x").unwrap();
    let plat = fake(&card);
    let ev = broadcast::channel(64).0;
    let files: Vec<String> = sounds.iter().map(|s| s.src.to_string_lossy().into()).collect();
    let e = run("sdcard_write", &json!({ "drive": "card1", "files": files, "format": true, "confirm": "wrong" }), &plat, &ev).unwrap_err();
    assert!(e.contains("type its name"), "{e}");
    assert!(card.join("old.txt").exists());
    let r = run("sdcard_write", &json!({ "drive": "card1", "files": files, "format": true, "confirm": "sounds" }), &plat, &ev).unwrap();
    assert!(!card.join("old.txt").exists());
    assert_eq!(r["map"][2]["name"], "03/001-scream_ loud_.mp3");
    // the OS platform refuses fake, system and fixed drives before any command
    let os = OsPlatform { runner: Box::new(Forbidden(AtomicUsize::new(0))) };
    let d = plat.drives().unwrap().remove(0);
    assert!(os.format(&d, "X").is_err());
    assert!(os.eject(&d).is_ok());
    let fixed = Drive { removable: false, ..Drive { fake: false, ..d.clone() } };
    assert!(os.format(&fixed, "X").is_err());
    let sys = Drive { system: true, fake: false, ..d };
    assert!(os.format(&sys, "X").is_err());
}


#[test]
fn a_failure_mid_copy_leaves_the_sources_and_says_so() {
    let (src, card, sounds) = setup("fail");
    let plat = fake(&card);
    let e = write_sounds(&card, &sounds, &plat, &no_progress, Some(2)).unwrap_err();
    assert!(e.contains("stopped at sound 2") && e.contains("untouched") && e.contains("Sounds 1 to 1 are on the card (folder 01)"), "{e}");
    assert!(card.join("01/001-rain.mp3").exists());
    // the half-written file and its folder are gone, so Check sees a clean card with sound 1
    assert!(!card.join("02").exists());
    let r = check_card(&card, Some("vfat"), &plat).unwrap();
    assert!(r.problems.is_empty(), "{:?}", r.problems);
    let e = write_sounds(&tmp("fail3"), &sounds, &plat, &no_progress, Some(3)).unwrap_err();
    assert!(e.contains("Sounds 1 to 2 are on the card (folders 01 to 02)"), "{e}");
    for (n, body) in [("rain.mp3", "RAIN"), ("elevator.wav", "ELEVATOR!"), ("scream_ loud_.mp3", "AAAA")] {
        assert_eq!(std::fs::read_to_string(src.join(n)).unwrap(), body);
    }
}

#[test]
fn sounds_are_checked_before_the_card_is_touched() {
    let (src, card, mut sounds) = setup("sources");
    assert!(check_sounds(&sounds, &card).is_ok());
    std::fs::write(src.join("notes.txt"), "x").unwrap();
    sounds.push(Sound::from_path(&src.join("notes.txt")));
    assert!(check_sounds(&sounds, &card).unwrap_err().contains("not an MP3 or WAV"));
    sounds.pop();
    std::fs::write(card.join("oncard.mp3"), "x").unwrap();
    sounds.push(Sound::from_path(&card.join("oncard.mp3")));
    assert!(check_sounds(&sounds, &card).unwrap_err().contains("on the SD card itself"));
    sounds.pop();
    sounds.push(Sound::from_path(&src.join("gone.mp3")));
    assert!(check_sounds(&sounds, &card).unwrap_err().contains("not there any more"));
    assert!(check_sounds(&[], &card).is_err());
}

fn e(name: &str) -> Entry {
    Entry { name: name.into(), size: 10, dir: false }
}
fn d(name: &str) -> Entry {
    Entry { name: name.into(), size: 0, dir: true }
}
fn codes(r: &Report) -> Vec<&'static str> {
    r.problems.iter().map(|p| p.code).collect()
}
fn problem<'a>(r: &'a Report, code: &str) -> &'a Problem {
    r.problems.iter().find(|p| p.code == code).unwrap_or_else(|| panic!("no {code} in {:?}", codes(r)))
}
fn folder(n: &str, es: &[Entry]) -> (String, Vec<Entry>) {
    (n.to_string(), es.to_vec())
}

#[test]
fn check_finds_every_problem_in_plain_words() {
    let root = [d("01"), d("02"), d("03")];
    let good = [folder("01", &[e("001-a.mp3")]), folder("02", &[e("001-b.mp3")]), folder("03", &[e("001.wav")])];
    let r = check(&root, &good, Some("vfat"));
    assert!(r.problems.is_empty(), "{:?}", r.problems);
    assert_eq!(r.files.iter().map(|f| (f.position, f.name.as_str(), f.number)).collect::<Vec<_>>(), [(1, "01/001-a.mp3", Some(1)), (2, "02/001-b.mp3", Some(2)), (3, "03/001.wav", Some(3))]);

    // not FAT, not fixable
    let r = check(&root, &good, Some("exfat"));
    assert_eq!(codes(&r), ["not_fat"]);
    assert!(r.problems[0].words.contains("exFAT") && !r.fixable);

    // hidden Mac files in the root and in folders: fixable
    let r = check(&[d("01"), e("._01"), d(".Trashes")], &[folder("01", &[e("001-a.mp3"), e("._001-a.mp3"), e(".DS_Store")])], Some("vfat"));
    assert_eq!(codes(&r), ["hidden"]);
    assert_eq!(r.problems[0].names, ["._01", ".Trashes", "01/._001-a.mp3", "01/.DS_Store"]);
    assert!(r.fixable);

    // other things in the root (the old mp3 folder among them), not fixable; Windows' folder is fine
    let r = check(&[d("01"), d("mp3"), e("readme.txt"), e("02"), d("100"), d("System Volume Information")], &[folder("01", &[e("001-a.mp3")])], Some("vfat"));
    assert_eq!(codes(&r), ["extra_root"]);
    assert_eq!(r.problems[0].names, ["mp3/", "readme.txt", "02", "100/"]);
    assert!(r.problems[0].words.contains("old layout") && r.problems[0].words.contains("folder 01"), "{}", r.problems[0].words);
    assert!(!r.fixable);
    let r = check(&[d("01"), e("readme.txt")], &[folder("01", &[e("001-a.mp3")])], None);
    assert!(!r.problems[0].words.contains("old layout"));

    // no sound folders at all
    let r = check(&[], &[], Some("vfat"));
    assert_eq!(codes(&r), ["no_sounds"]);
    assert!(r.problems[0].words.contains("Use Copy") && !r.fixable);

    // a folder with no sound file: sound 2 plays nothing; its other file is moved off
    let r = check(&root, &[folder("01", &[e("001-a.mp3")]), folder("02", &[e("cover.jpg")]), folder("03", &[e("001-c.mp3")])], None);
    assert_eq!(codes(&r), ["no_sound", "unsupported"]);
    let p = problem(&r, "no_sound");
    assert_eq!(p.names, ["02"]);
    assert!(p.words.contains("`audio_single = 2`") && !p.fixable, "{}", p.words);
    assert_eq!(problem(&r, "unsupported").names, ["02/cover.jpg"]);
    assert_eq!(r.files.len(), 2);

    // more than one sound file: the 001 one stays, the others are extra (not wrongly named)
    let r = check(&root[..1], &[folder("01", &[e("002-b.mp3"), e("001-a.mp3"), e("loose.wav")])], None);
    assert_eq!(codes(&r), ["several"]);
    assert_eq!(r.problems[0].names, ["01/002-b.mp3", "01/loose.wav"]);
    assert_eq!(r.files[0].name, "01/001-a.mp3");
    assert!(r.fixable);

    // a sound that does not start with 001 (the lowest-numbered of several is the keeper)
    let r = check(&root[..2], &[folder("01", &[e("scream.mp3")]), folder("02", &[e("005-x.mp3"), e("002-y.mp3")])], None);
    assert_eq!(codes(&r), ["several", "not_001"]);
    assert_eq!(problem(&r, "not_001").names, ["01/scream.mp3", "02/002-y.mp3"]);
    assert_eq!(problem(&r, "several").names, ["02/005-x.mp3"]);
    assert_eq!(r.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["01/scream.mp3", "02/002-y.mp3"]);
    assert!(r.fixable);

    // files that are not MP3 or WAV
    let r = check(&root[..1], &[folder("01", &[e("001-a.mp3"), e("cover.jpg"), e("notes.txt")])], None);
    assert_eq!(codes(&r), ["unsupported"]);
    assert_eq!(r.problems[0].names, ["01/cover.jpg", "01/notes.txt"]);
    assert!(r.fixable);

    // folders inside a sound folder: the player ignores them
    let r = check(&root[..1], &[folder("01", &[e("001-a.mp3"), d("more")])], None);
    assert_eq!(codes(&r), ["folders"]);
    assert!(!r.fixable);

    // missing numbers between the folders: informational
    let r = check(&[d("01"), d("03"), d("06")], &[folder("01", &[e("001-a.mp3")]), folder("03", &[e("001-c.mp3")]), folder("06", &[e("001-f.mp3")])], Some("vfat"));
    assert_eq!(codes(&r), ["gaps"]);
    assert_eq!(r.problems[0].names, ["2", "4", "5"]);
    assert!(r.problems[0].words.contains("`audio_single = 2` plays nothing") && !r.fixable, "{}", r.problems[0].words);
    assert_eq!(r.files.iter().map(|f| f.position).collect::<Vec<_>>(), [1, 3, 6]);
}

/// A card with every fixable problem: hidden files, a second sound, a wrongly named sound, an unsupported file.
fn messy_card(name: &str) -> (PathBuf, PathBuf, FakePlatform) {
    let base = tmp(name);
    let card = base.join("card");
    for (f, body) in [("01/001-a.mp3", "A"), ("01/002-extra.mp3", "XX"), ("01/._001-a.mp3", "h"), ("02/0002-b.wav", "BB"), ("02/cover.jpg", "J"), ("03/scream.mp3", "SCREAM"), ("._03", "h"), ("readme.txt", "R")] {
        std::fs::create_dir_all(card.join(f).parent().unwrap()).unwrap();
        std::fs::write(card.join(f), body).unwrap();
    }
    let plat = fake(&card);
    (base, card, plat)
}

fn tree(dir: &Path) -> Vec<String> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if e.path().is_dir() { out.extend(tree(&e.path()).into_iter().map(|x| format!("{n}/{x}"))); } else { out.push(n); }
    }
    out.sort();
    out
}

#[test]
fn fix_backs_up_first_then_moves_off_and_renames() {
    let (base, card, plat) = messy_card("fix");
    let before = check_card(&card, Some("vfat"), &plat).unwrap();
    assert_eq!(codes(&before), ["hidden", "extra_root", "several", "not_001", "unsupported"]);
    let backup = base.join("backup");
    let r = fix(&card, &backup, &plat, &no_progress).unwrap();
    // everything that was in the sound folders is in the backup, the same bytes
    assert_eq!(tree(&backup), ["01/001-a.mp3", "01/002-extra.mp3", "02/0002-b.wav", "02/cover.jpg", "03/scream.mp3"]);
    assert_eq!(std::fs::read_to_string(backup.join("01/002-extra.mp3")).unwrap(), "XX");
    // the card: one sound per folder, each starting with 001; the person's readme in the root is left alone
    assert_eq!(tree(&card), ["01/001-a.mp3", "02/001-b.wav", "03/001-scream.mp3", "readme.txt"]);
    assert_eq!(std::fs::read_to_string(card.join("03/001-scream.mp3")).unwrap(), "SCREAM");
    assert_eq!(r["renamed"], json!([{ "from": "02/0002-b.wav", "to": "02/001-b.wav", "number": 2 }, { "from": "03/scream.mp3", "to": "03/001-scream.mp3", "number": 3 }]));
    assert_eq!(r["left_off"], json!(["01/002-extra.mp3", "02/cover.jpg"]));
    let mut hid: Vec<String> = serde_json::from_value(r["deleted_hidden"].clone()).unwrap();
    hid.sort();
    assert_eq!(hid, ["._03", "01/._001-a.mp3"]);
    assert_eq!(r["map"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap()).collect::<Vec<_>>(), ["01/001-a.mp3", "02/001-b.wav", "03/001-scream.mp3"]);
    assert_eq!(r["backup"], backup.to_string_lossy().as_ref());
    // only the root's extra file is left (not fixable: copying again clears it)
    assert_eq!(codes(&check_card(&card, Some("vfat"), &plat).unwrap()), ["extra_root"]);
}

#[test]
fn fix_changes_nothing_when_the_backup_fails() {
    let (base, card, plat) = messy_card("fixfail");
    let before = tree(&card);
    // folder 01 copies off, then backup/02 cannot be made (a file is in the way)
    let backup = base.join("backup");
    std::fs::create_dir_all(&backup).unwrap();
    std::fs::write(backup.join("02"), "in the way").unwrap();
    let e = fix(&card, &backup, &plat, &no_progress).unwrap_err();
    assert!(e.contains("Nothing on the card was changed") && e.contains("02/"), "{e}");
    assert!(backup.join("01/002-extra.mp3").exists());
    // hidden files, the extra and unsupported files and the old names are all still on the card
    assert_eq!(tree(&card), before);
    assert!(card.join("01/._001-a.mp3").exists() && card.join("03/scream.mp3").exists());
}

#[test]
fn names_for_hints_are_the_sound_of_each_folder() {
    let (_, card, plat) = messy_card("names");
    let ev = broadcast::channel(4).0;
    let r = run("sdcard_names", &json!({ "folder": card.to_string_lossy() }), &plat, &ev).unwrap();
    assert_eq!(r, json!(["01/001-a.mp3", "02/0002-b.wav", "03/scream.mp3"]));
    assert!(run("sdcard_names", &json!({ "folder": card.join("nope").to_string_lossy() }), &plat, &ev).is_err());
    // the drive list tells the page the limit
    let r = run("sdcard_drives", &json!({}), &plat, &ev).unwrap();
    assert_eq!(r["sounds_max"], 99);
}

#[test]
fn drives_are_filtered_removable_and_by_size() {
    let card = Drive { id: "/dev/sdb1".into(), name: "SOUNDS".into(), size: 16_000_000_000, removable: true, fs: "vfat".into(), ..Default::default() };
    let big = Drive { id: "/dev/sdc1".into(), size: 128_000_000_000, removable: true, ..Default::default() };
    let disk = Drive { id: "/dev/nvme0n1p2".into(), size: 500_000_000_000, removable: false, ..Default::default() };
    let sys = Drive { id: "/dev/sdd1".into(), size: 8_000_000_000, removable: true, system: true, ..Default::default() };
    let sold_as_64 = Drive { id: "/dev/sde1".into(), size: 63_864_569_856, removable: true, ..Default::default() };
    let all = [card, big, disk, sys, sold_as_64];
    let shown: Vec<String> = choose(&all, false).into_iter().map(|c| c.drive.id).collect();
    assert_eq!(shown, ["/dev/sdb1", "/dev/sde1"]);
    let every = choose(&all, true);
    assert_eq!(every.len(), 5);
    let by = |id: &str| every.iter().find(|c| c.drive.id == id).unwrap();
    assert!(by("/dev/sdc1").can_write && by("/dev/sdc1").warn.as_ref().unwrap().contains("bigger"));
    assert!(!by("/dev/nvme0n1p2").can_write && by("/dev/nvme0n1p2").why.is_some());
    assert!(!by("/dev/sdd1").can_write);
    assert_eq!(by("/dev/sdb1").fs_words, "FAT");
    assert_eq!(fat_label("my sounds: halloween!"), "MY SOUNDS H");
    assert_eq!(fat_label("??"), "SOUNDS");
    // the core refuses a fixed drive even when the UI asks
    let tmpd = tmp("fixed");
    let plat = FakePlatform::new(vec![Drive { id: "fixed".into(), mount: Some(tmpd.to_string_lossy().into()), removable: false, ..Default::default() }]);
    let ev = broadcast::channel(4).0;
    assert!(run("sdcard_write", &json!({ "drive": "fixed", "files": [], "format": true, "confirm": "fixed" }), &plat, &ev).unwrap_err().contains("not a removable drive"));
    assert!(run("sdcard_fix", &json!({ "drive": "fixed" }), &plat, &ev).is_err());
    // but Check (read only) works on it
    assert!(run("sdcard_check", &json!({ "drive": "fixed" }), &plat, &ev).is_ok());
}

#[test]
fn lsblk_json_is_read_in_both_styles() {
    // util-linux 2.37+: booleans and numbers
    let new = r#"{"blockdevices":[
      {"name":"nvme0n1","path":"/dev/nvme0n1","size":512110190592,"rm":false,"hotplug":false,"tran":"nvme","type":"disk","fstype":null,"label":null,"mountpoint":null,
       "children":[{"name":"nvme0n1p1","path":"/dev/nvme0n1p1","size":536870912,"rm":false,"hotplug":false,"tran":null,"type":"part","fstype":"vfat","label":null,"mountpoint":"/boot/efi"},
                   {"name":"nvme0n1p2","path":"/dev/nvme0n1p2","size":511571000000,"rm":false,"hotplug":false,"tran":null,"type":"part","fstype":"ext4","label":null,"mountpoint":"/"}]},
      {"name":"sdb","path":"/dev/sdb","size":15931539456,"rm":true,"hotplug":true,"tran":"usb","type":"disk","fstype":null,"label":null,"mountpoint":null,
       "children":[{"name":"sdb1","path":"/dev/sdb1","size":15930490880,"rm":true,"hotplug":true,"tran":null,"type":"part","fstype":"vfat","label":"SOUNDS","mountpoint":"/media/me/SOUNDS"}]}
    ]}"#;
    let d = parse_lsblk(new).unwrap();
    assert_eq!(d.len(), 3);
    assert!(d[0].system && d[1].system && !d[0].removable);
    let sd = &d[2];
    assert_eq!((sd.id.as_str(), sd.disk.as_str(), sd.name.as_str(), sd.mount.as_deref(), sd.size, sd.removable, sd.fs.as_str(), sd.system), ("/dev/sdb1", "/dev/sdb", "SOUNDS", Some("/media/me/SOUNDS"), 15931539456, true, "vfat", false));
    // older util-linux: "0"/"1" strings and string sizes, no path; a blank card reader with no partition
    let old = r#"{"blockdevices":[
      {"name":"mmcblk0","size":"31914983424","rm":"0","hotplug":"1","tran":null,"type":"disk","fstype":null,"label":null,"mountpoint":null,
       "children":[{"name":"mmcblk0p1","size":"31910789120","rm":"0","hotplug":"1","tran":null,"type":"part","fstype":"exfat","label":null,"mountpoint":null}]},
      {"name":"sdc","size":"8000000000","rm":"1","hotplug":"1","tran":"usb","type":"disk","fstype":null,"label":null,"mountpoint":null},
      {"name":"loop0","size":"4096","rm":"0","hotplug":"0","tran":null,"type":"loop","fstype":"squashfs","label":null,"mountpoint":"/snap/x"}
    ]}"#;
    let d = parse_lsblk(old).unwrap();
    assert_eq!(d.len(), 2);
    assert_eq!((d[0].id.as_str(), d[0].name.as_str(), d[0].size, d[0].removable, d[0].mount.clone()), ("/dev/mmcblk0p1", "card on mmcblk0p1", 31914983424, true, None));
    assert_eq!((d[1].id.as_str(), d[1].device.as_str(), d[1].disk.as_str(), d[1].fs.as_str()), ("/dev/sdc", "/dev/sdc", "/dev/sdc", ""));
}

#[test]
fn windows_and_mac_listings_are_read() {
    let w = parse_windows(r#"[{"Letter":"C","Label":"Windows","FileSystem":"NTFS","DiskSize":512000000000,"BusType":"NVMe","DriveType":"Fixed","Number":0,"Boot":true},
        {"Letter":"E","Label":"SOUNDS","FileSystem":"FAT32","DiskSize":15931539456,"BusType":"USB","DriveType":"Removable","Number":1,"Boot":false}]"#).unwrap();
    assert!(w[0].system && !w[0].removable);
    assert_eq!((w[1].id.as_str(), w[1].mount.as_deref(), w[1].removable, w[1].fs.as_str()), ("E:", Some("E:\\"), true, "FAT32"));
    assert_eq!(parse_windows(r#"{"Letter":"F","Label":"","FileSystem":"exFAT","DiskSize":"64000000000","BusType":"SD","DriveType":"Removable","Number":2}"#).unwrap()[0].name, "card F:");
    let list = plist(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>AllDisks</key><array><string>disk4</string><string>disk4s1</string></array>
  <key>AllDisksAndPartitions</key><array><dict>
    <key>Content</key><string>FDisk_partition_scheme</string><key>DeviceIdentifier</key><string>disk4</string>
    <key>OSInternal</key><false/><key>Partitions</key><array><dict>
      <key>Content</key><string>DOS_FAT_32</string><key>DeviceIdentifier</key><string>disk4s1</string>
      <key>MountPoint</key><string>/Volumes/SOUNDS</string><key>Size</key><integer>15929393152</integer>
      <key>VolumeName</key><string>SOUNDS &amp; MORE</string></dict></array>
    <key>Size</key><integer>15931539456</integer></dict></array>
</dict></plist>"#).unwrap();
    let mut info = HashMap::new();
    info.insert("disk4".to_string(), plist("<plist><dict><key>RemovableMedia</key><true/><key>Internal</key><false/><key>TotalSize</key><integer>15931539456</integer></dict></plist>").unwrap());
    info.insert("disk4s1".to_string(), plist("<plist><dict><key>FilesystemName</key><string>MS-DOS FAT32</string><key>Bad</key><data>AAAA</data></dict></plist>").unwrap());
    let d = parse_diskutil(&list, &info);
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].id.as_str(), d[0].name.as_str(), d[0].disk.as_str(), d[0].mount.as_deref(), d[0].removable, d[0].fs.as_str()), ("disk4s1", "SOUNDS & MORE", "/dev/disk4", Some("/Volumes/SOUNDS"), true, "MS-DOS FAT32"));
    assert!(fs_is_fat(&d[0].fs));
}

#[test]
fn map_as_text_and_csv() {
    let rows = vec![(1, "01/001-rain.mp3".to_string()), (2, "02/001-a, b.mp3".to_string())];
    assert_eq!(map_text(&rows), "1  01/001-rain.mp3\n2  02/001-a, b.mp3\n");
    assert_eq!(map_csv(&rows), "number,file\n1,01/001-rain.mp3\n2,\"02/001-a, b.mp3\"\n");
}
