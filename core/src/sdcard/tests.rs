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
fn names_are_numbered_and_safe_for_fat() {
    assert_eq!(card_name(1, "rain", "mp3"), "0001-rain.mp3");
    assert_eq!(card_name(12, "elevator", "WAV"), "0012-elevator.wav");
    assert_eq!(card_name(3, "scream: loud?", "mp3"), "0003-scream loud.mp3");
    assert_eq!(card_name(4, "a\\b/c*d\"e<f>g|h\u{7}i", "mp3"), "0004-abcdefghi.mp3");
    assert_eq!(card_name(5, "trailing dots...  ", "mp3"), "0005-trailing dots.mp3");
    assert_eq!(card_name(6, "???", "mp3"), "0006.mp3");
    assert_eq!(card_name(3000, "x", "mp3"), "3000-x.mp3");
    let long = card_name(7, &"x".repeat(400), "mp3");
    assert_eq!(long.chars().count(), 255);
    assert!(long.starts_with("0007-x") && long.ends_with(".mp3"));
    assert_eq!(parse_name("0003-scream.mp3"), Some((3, "scream".into())));
    assert_eq!(parse_name("0010.wav"), Some((10, "".into())));
    assert_eq!(parse_name("00012_odd.mp3"), Some((1, "2_odd".into())));
    assert_eq!(parse_name("scream.mp3"), None);
    assert_eq!(parse_name("12-x.mp3"), None);
    assert_eq!(MP3_FOLDER_MAX, 3000);
}

#[test]
fn copies_in_list_order_and_records_the_write_order() {
    let (src, card, sounds) = setup("order");
    let plat = fake(&card);
    let map = write_sounds(&card, &sounds, &plat, &no_progress, None).unwrap();
    let names: Vec<&str> = map.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["0001-rain.mp3", "0002-elevator.wav", "0003-scream loud.mp3"]);
    // the order the card got them is the list order
    assert_eq!(plat.dir_order(&card.join("mp3")).unwrap(), names);
    assert_eq!(std::fs::read_to_string(card.join("mp3/0002-elevator.wav")).unwrap(), "ELEVATOR!");
    // the source files are still there, unchanged
    assert_eq!(std::fs::read_to_string(src.join("rain.mp3")).unwrap(), "RAIN");
    // and Check finds nothing wrong
    let r = check_card(&card, Some("vfat"), &plat).unwrap();
    assert!(r.problems.is_empty(), "{:?}", r.problems);
    assert_eq!(r.files.iter().map(|f| f.number.unwrap()).collect::<Vec<_>>(), [1, 2, 3]);
}

#[test]
fn mac_junk_is_removed() {
    let (_, card, sounds) = setup("junk");
    let plat = fake(&card);
    write_sounds(&card, &sounds, &plat, &no_progress, None).unwrap();
    for f in ["._0001-rain.mp3", "mp3/._0002-elevator.wav", "mp3/.DS_Store"] { std::fs::write(card.join(f), "x").unwrap(); }
    for d in [".Spotlight-V100", ".fseventsd", ".Trashes"] { std::fs::create_dir_all(card.join(d).join("inner")).unwrap(); }
    let mut gone = clean_mac_junk(&card);
    gone.sort();
    assert_eq!(gone, [".Spotlight-V100", ".Trashes", "._0001-rain.mp3", ".fseventsd", "mp3/.DS_Store", "mp3/._0002-elevator.wav"]);
    let left: Vec<String> = std::fs::read_dir(card.join("mp3")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into()).collect();
    assert_eq!(left.len(), 3);
    assert_eq!(std::fs::read_dir(&card).unwrap().count(), 1);
}

#[test]
fn without_formatting_lists_then_deletes_and_makes_mp3_new() {
    let (_, card, sounds) = setup("clear");
    let plat = fake(&card);
    std::fs::create_dir_all(card.join("mp3")).unwrap();
    std::fs::write(card.join("mp3/0001-old.mp3"), "old").unwrap();
    std::fs::write(card.join("notes.txt"), "n").unwrap();
    std::fs::create_dir_all(card.join("photos")).unwrap();
    std::fs::create_dir_all(card.join("System Volume Information")).unwrap();
    assert_eq!(plan_clear(&card).unwrap(), ["mp3/", "mp3/0001-old.mp3", "notes.txt", "photos/"]);
    let ev = broadcast::channel(64).0;
    let files: Vec<String> = sounds.iter().map(|s| s.src.to_string_lossy().into()).collect();
    let shown = plan_clear(&card).unwrap();
    let r = run("sdcard_write", &json!({ "drive": "card1", "files": files, "format": false, "delete": shown }), &plat, &ev).unwrap();
    assert_eq!(r["map"].as_array().unwrap().len(), 3);
    assert!(!card.join("notes.txt").exists() && !card.join("photos").exists() && !card.join("mp3/0001-old.mp3").exists());
    assert!(card.join("System Volume Information").exists());
    // the mp3 folder was deleted and made again (the fake card's record of it starts empty)
    assert_eq!(plat.dir_order(&card.join("mp3")).unwrap(), ["0001-rain.mp3", "0002-elevator.wav", "0003-scream_ loud_.mp3"]);
    // a card that changed since the list was shown is refused
    std::fs::write(card.join("new.txt"), "n").unwrap();
    let e = run("sdcard_write", &json!({ "drive": "card1", "files": files, "format": false, "delete": ["mp3/"] }), &plat, &ev).unwrap_err();
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
    assert_eq!(r["map"][2]["name"], "0003-scream_ loud_.mp3");
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
    assert!(e.contains("stopped at sound 2") && e.contains("untouched") && e.contains("Sounds 1 to 1"), "{e}");
    assert!(card.join("mp3/0001-rain.mp3").exists());
    assert!(!card.join("mp3/0002-elevator.wav").exists());
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
fn codes(r: &Report) -> Vec<&'static str> {
    r.problems.iter().map(|p| p.code).collect()
}

#[test]
fn check_finds_order_gaps_duplicates_and_strays() {
    let root = [Entry { name: "mp3".into(), size: 0, dir: true }];
    let good = [e("0001-a.mp3"), e("0002-b.mp3"), e("0003-c.wav")];
    assert!(check(&root, Some(&good), Some("vfat")).problems.is_empty());
    // written 1, 3, 2: out of order (3 plays as 2)
    let r = check(&root, Some(&[e("0001-a.mp3"), e("0003-c.mp3"), e("0002-b.mp3")]), Some("FAT32"));
    assert_eq!(codes(&r), ["out_of_order"]);
    assert_eq!(r.problems[0].names, ["0002-b.mp3"]);
    assert!(r.problems[0].words.contains("`audio_single = 2` plays “0003-c.mp3”"), "{}", r.problems[0].words);
    assert!(r.fixable);
    // gaps and duplicates
    let r = check(&root, Some(&[e("0001-a.mp3"), e("0001-b.mp3"), e("0004-c.mp3")]), None);
    assert_eq!(codes(&r), ["duplicates", "gaps"]);
    assert_eq!(r.problems[1].names, ["2", "3"]);
    // no number, unsupported, hidden, extra root files, not FAT
    let root2 = [Entry { name: "mp3".into(), size: 0, dir: true }, e("readme.txt"), e("._mp3"), Entry { name: "System Volume Information".into(), size: 0, dir: true }];
    let r = check(&root2, Some(&[e("0001-a.mp3"), e("scream.mp3"), e("cover.jpg"), e("._0001-a.mp3")]), Some("exfat"));
    assert_eq!(codes(&r), ["not_fat", "extra_root", "hidden", "unsupported", "no_number"]);
    assert_eq!(r.problems[1].names, ["readme.txt"]);
    assert_eq!(r.problems[2].names, ["._mp3", "mp3/._0001-a.mp3"]);
    assert!(r.problems[0].words.contains("exFAT"));
    // no mp3 folder at all
    let r = check(&[e("x.mp3")], None, Some("vfat"));
    assert_eq!(codes(&r), ["extra_root", "no_mp3"]);
    // too many
    let many: Vec<Entry> = (1..=3001).map(|n| e(&format!("{n:04}.mp3"))).collect();
    assert_eq!(codes(&check(&root, Some(&many), None)), ["too_many"]);
}

#[test]
fn fix_copies_off_first_then_rewrites_in_order() {
    let base = tmp("fix");
    let card = base.join("card");
    std::fs::create_dir_all(card.join("mp3")).unwrap();
    let plat = fake(&card);
    // written out of order, with a gap, a stray and a hidden file
    for (n, body) in [("0003-c.mp3", "C"), ("0001-a.mp3", "A"), ("loose.wav", "L"), ("0005-e.mp3", "E"), ("cover.jpg", "J"), ("._0001-a.mp3", "x")] {
        std::fs::write(card.join("mp3").join(n), body).unwrap();
        plat.created(&card.join("mp3"), n);
    }
    let before = check_card(&card, Some("vfat"), &plat).unwrap();
    assert!(codes(&before).contains(&"out_of_order") && codes(&before).contains(&"gaps"));
    let backup = base.join("backup");
    let r = fix(&card, &backup, &plat, &no_progress).unwrap();
    assert_eq!(plat.dir_order(&card.join("mp3")).unwrap(), ["0001-a.mp3", "0002-c.mp3", "0003-e.mp3", "0004-loose.wav"]);
    assert_eq!(std::fs::read_to_string(card.join("mp3/0002-c.mp3")).unwrap(), "C");
    assert_eq!(r["left_off"], json!(["cover.jpg"]));
    assert!(backup.join("cover.jpg").exists() && backup.join("0003-c.mp3").exists());
    assert_eq!(r["renamed"].as_array().unwrap().len(), 3);
    assert!(check_card(&card, Some("vfat"), &plat).unwrap().problems.is_empty());
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
    let rows = vec![(1, "0001-rain.mp3".to_string()), (2, "0002-a, b.mp3".to_string())];
    assert_eq!(map_text(&rows), "1  0001-rain.mp3\n2  0002-a, b.mp3\n");
    assert_eq!(map_csv(&rows), "number,file\n1,0001-rain.mp3\n2,\"0002-a, b.mp3\"\n");
}
