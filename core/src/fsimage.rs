//! The board package in a USB install (firmware FLASH-MAP.md "A board package in the first flash"): a LittleFS
//! image holding only `/board-a.bin`, written at the board's file system offset in the same write as the firmware,
//! so the board starts on its own pins from the first second and applies the package's defaults once.
//!
//! * `/board-a.bin` is the firmware's A/B frame ([`ab_frame`]: "PTC1", sequence 1, payload length, zlib CRC-32,
//!   payload) around the board record ([`board_record`]: "PTBP", format 1, flags, JSON length, the JSON packed
//!   with the firmware's LZSS, [`lz_pack`]). The record is at most [`BOARD_STORE_CAPACITY`] bytes.
//! * The image is made with the C littlefs (2.9, on-disk version 2.1) and exactly the firmware's geometry
//!   ([`Layout`], per chip). Writing it replaces whatever the file system held (settings, Wi-Fi, shows, script).
//! * An ESP32 gets it as a second part of the esptool write; a Pico gets its blocks added to the UF2 file
//!   ([`uf2_with`]).
//!
//! `fs-image` (core/src/bin/fs-image.rs) writes an image to a file for bench tests.

use littlefs2_sys as lfs;
use serde_json::Value;
use std::ffi::{c_int, c_void, CString};

/// The whole board record (PTBP header and packed JSON), the firmware's `BOARD_STORE_CAPACITY`.
pub const BOARD_STORE_CAPACITY: usize = 4048;
/// The board record format (`BOARD_RECORD_VERSION`).
pub const BOARD_RECORD_VERSION: u16 = 1;
/// Record flag: apply the package's defaults once at the next power-on.
pub const FLAG_APPLY_DEFAULTS: u16 = 1;
/// The A/B frame's sequence number of a fresh file.
pub const FIRST_SEQ: u32 = 1;
/// The file the firmware reads its board record from.
pub const RECORD_FILE: &str = "/board-a.bin";
/// The name limit written to the superblock: at most what every reader takes (esp_littlefs is built with 64).
pub const NAME_MAX: u32 = 64;
/// LZSS (firmware lz.h): window, shortest and longest match, candidates tried per position.
pub const LZ_WINDOW: usize = 4096;
pub const LZ_MIN_MATCH: usize = 3;
pub const LZ_MAX_MATCH: usize = 18;
const LZ_MAX_CHAIN: usize = 48;
const LZ_HASH_BITS: u32 = 10;
/// The UF2 base address of a Pico's flash, and the payload of one UF2 block.
pub const PICO_FLASH_BASE: u32 = 0x1000_0000;
pub const UF2_PAYLOAD: usize = 256;

/// A board's file system: where it is and the LittleFS geometry its firmware mounts it with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub offset: u32,
    pub size: u32,
    pub block_size: u32,
    pub read_size: u32,
    pub prog_size: u32,
    pub cache_size: u32,
    pub lookahead_size: u32,
}

impl Layout {
    pub fn block_count(&self) -> u32 {
        self.size / self.block_size
    }
}

const KB: u32 = 1024;
/// The Pico's 4 KB EEPROM sector at the end of flash, and its file system sizes (picoboot_map.h, flash_map.h).
const PICO_EEPROM: u32 = 4 * KB;
const PICO_W_FS: u32 = 188 * KB;
const PICO_FS: u32 = 256 * KB;
const fn pico(flash: u32, fs: u32) -> Layout {
    Layout { offset: flash - PICO_EEPROM - fs, size: fs, block_size: 4096, read_size: 256, prog_size: 256, cache_size: 256, lookahead_size: 256 }
}

/// The file system of a board (`info.mcu`), FLASH-MAP.md's table.
pub fn layout(mcu: &str) -> Result<Layout, String> {
    match mcu {
        // partition `spiffs` (esp_littlefs, arduino-esp32 2.0.17)
        "esp32-devkit" => Ok(Layout { offset: 0x3D_0000, size: 128 * KB, block_size: 4096, read_size: 128, prog_size: 128, cache_size: 512, lookahead_size: 128 }),
        "pico-w" => Ok(pico(2048 * KB, PICO_W_FS)),
        "pico2-w" => Ok(pico(4096 * KB, PICO_W_FS)),
        "pico" => Ok(pico(2048 * KB, PICO_FS)),
        _ => Err(format!("Studio cannot put a board package on a {mcu} board over USB")),
    }
}

/// zlib's CRC-32 (reflected, polynomial 0xEDB88320, init and final xor 0xFFFFFFFF).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

fn hash3(s: &[u8], p: usize) -> usize {
    let v = (s[p] as u32) << 16 | (s[p + 1] as u32) << 8 | s[p + 2] as u32;
    (v.wrapping_mul(2_654_435_761) >> (32 - LZ_HASH_BITS)) as usize
}

/// The firmware's LZSS (lz.cpp `lzPack`, the same search): groups of eight items behind a flag byte (bit 0 first,
/// 1 = literal), a match is two bytes little endian (low 12 bits distance - 1, high 4 bits length - 3).
pub fn lz_pack(s: &[u8]) -> Vec<u8> {
    const NO_POS: usize = usize::MAX;
    let n = s.len();
    let mut out = Vec::with_capacity(n + n.div_ceil(8));
    let mut head = vec![NO_POS; 1 << LZ_HASH_BITS];
    let mut prev = vec![0u16; LZ_WINDOW];
    let insert = |p: usize, head: &mut Vec<usize>, prev: &mut Vec<u16>| {
        if p + LZ_MIN_MATCH > n {
            return;
        }
        let h = hash3(s, p);
        let last = head[h];
        prev[p % LZ_WINDOW] = if last != NO_POS && p - last < LZ_WINDOW { (p - last) as u16 } else { 0 };
        head[h] = p;
    };
    let (mut flag_at, mut items, mut i) = (0usize, 8, 0usize);
    while i < n {
        if items == 8 {
            flag_at = out.len();
            out.push(0);
            items = 0;
        }
        let (mut best_len, mut best_dist) = (0usize, 0usize);
        if i + LZ_MIN_MATCH <= n {
            let mut cand = head[hash3(s, i)];
            let max_len = (n - i).min(LZ_MAX_MATCH);
            let mut tries = 0;
            while cand != NO_POS && tries < LZ_MAX_CHAIN {
                tries += 1;
                let dist = i - cand;
                if dist == 0 || dist > LZ_WINDOW {
                    break;
                }
                let mut l = 0;
                while l < max_len && s[cand + l] == s[i + l] {
                    l += 1;
                }
                if l > best_len {
                    best_len = l;
                    best_dist = dist;
                    if l == max_len {
                        break;
                    }
                }
                let back = prev[cand % LZ_WINDOW] as usize;
                if back == 0 || back > cand {
                    break;
                }
                let next = cand - back;
                if i - next > LZ_WINDOW {
                    break;
                }
                cand = next;
            }
        }
        if best_len >= LZ_MIN_MATCH {
            let code = ((best_dist - 1) | (best_len - LZ_MIN_MATCH) << 12) as u16;
            out.extend(code.to_le_bytes());
            for k in 0..best_len {
                insert(i + k, &mut head, &mut prev);
            }
            i += best_len;
        } else {
            out[flag_at] |= 1 << items;
            out.push(s[i]);
            insert(i, &mut head, &mut prev);
            i += 1;
        }
        items += 1;
    }
    out
}

/// The firmware's `lzUnpack`: exactly `out_len` bytes, every byte of the stream used; None when damaged.
pub fn lz_unpack(p: &[u8], out_len: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(out_len);
    let mut at = 0;
    while out.len() < out_len {
        let flags = *p.get(at)?;
        at += 1;
        for b in 0..8 {
            if out.len() >= out_len {
                break;
            }
            if flags & (1 << b) != 0 {
                out.push(*p.get(at)?);
                at += 1;
                continue;
            }
            let code = u16::from_le_bytes([*p.get(at)?, *p.get(at + 1)?]) as usize;
            at += 2;
            let (dist, len) = ((code & 0x0FFF) + 1, (code >> 12) + LZ_MIN_MATCH);
            if dist > out.len() || out.len() + len > out_len {
                return None;
            }
            let from = out.len() - dist;
            for k in 0..len {
                out.push(out[from + k]);
            }
        }
    }
    (at == p.len()).then_some(out)
}

/// The board record: "PTBP", format, flags, JSON length, the JSON packed. Refused (plain words) when it would not
/// fit the board's store.
pub fn board_record(json: &str, apply_defaults: bool) -> Result<Vec<u8>, String> {
    let mut r = b"PTBP".to_vec();
    r.extend(BOARD_RECORD_VERSION.to_le_bytes());
    r.extend((if apply_defaults { FLAG_APPLY_DEFAULTS } else { 0 }).to_le_bytes());
    r.extend((json.len() as u32).to_le_bytes());
    r.extend(lz_pack(json.as_bytes()));
    if r.len() > BOARD_STORE_CAPACITY {
        return Err(format!("the board package is too big to store on the board: {} bytes packed, the board keeps at most {BOARD_STORE_CAPACITY}", r.len()));
    }
    Ok(r)
}

/// A board record read back: (JSON, apply defaults), None when damaged.
pub fn read_record(r: &[u8]) -> Option<(String, bool)> {
    if r.len() < 12 || &r[..4] != b"PTBP" || u16::from_le_bytes([r[4], r[5]]) != BOARD_RECORD_VERSION {
        return None;
    }
    let flags = u16::from_le_bytes([r[6], r[7]]);
    let len = u32::from_le_bytes([r[8], r[9], r[10], r[11]]) as usize;
    let json = String::from_utf8(lz_unpack(&r[12..], len)?).ok()?;
    Some((json, flags & FLAG_APPLY_DEFAULTS != 0))
}

/// The A/B frame around a payload (storage_ab.cpp).
pub fn ab_frame(payload: &[u8], seq: u32) -> Vec<u8> {
    let mut f = b"PTC1".to_vec();
    f.extend(seq.to_le_bytes());
    f.extend((payload.len() as u32).to_le_bytes());
    f.extend(crc32(payload).to_le_bytes());
    f.extend(payload);
    f
}

/// The payload of an A/B frame, None when the frame or its CRC is wrong.
pub fn ab_payload(f: &[u8]) -> Option<&[u8]> {
    if f.len() < 16 || &f[..4] != b"PTC1" {
        return None;
    }
    let len = u32::from_le_bytes([f[8], f[9], f[10], f[11]]) as usize;
    let crc = u32::from_le_bytes([f[12], f[13], f[14], f[15]]);
    let p = f.get(16..16 + len)?;
    (crc32(p) == crc && f.len() == 16 + len).then_some(p)
}

// ---------------------------------------------------------------- LittleFS on a byte buffer

struct Disk {
    bytes: Vec<u8>,
    block_size: usize,
}

unsafe fn disk<'a>(c: *const lfs::lfs_config) -> &'a mut Disk {
    unsafe { &mut *((*c).context as *mut Disk) }
}

unsafe extern "C" fn bd_read(c: *const lfs::lfs_config, block: lfs::lfs_block_t, off: lfs::lfs_off_t, buf: *mut c_void, size: lfs::lfs_size_t) -> c_int {
    let d = unsafe { disk(c) };
    let at = block as usize * d.block_size + off as usize;
    let Some(src) = d.bytes.get(at..at + size as usize) else { return lfs::lfs_error_LFS_ERR_IO };
    unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), buf as *mut u8, size as usize) };
    0
}

unsafe extern "C" fn bd_prog(c: *const lfs::lfs_config, block: lfs::lfs_block_t, off: lfs::lfs_off_t, buf: *const c_void, size: lfs::lfs_size_t) -> c_int {
    let d = unsafe { disk(c) };
    let at = block as usize * d.block_size + off as usize;
    let Some(dst) = d.bytes.get_mut(at..at + size as usize) else { return lfs::lfs_error_LFS_ERR_IO };
    unsafe { std::ptr::copy_nonoverlapping(buf as *const u8, dst.as_mut_ptr(), size as usize) };
    0
}

unsafe extern "C" fn bd_erase(c: *const lfs::lfs_config, block: lfs::lfs_block_t) -> c_int {
    let d = unsafe { disk(c) };
    let at = block as usize * d.block_size;
    let Some(b) = d.bytes.get_mut(at..at + d.block_size) else { return lfs::lfs_error_LFS_ERR_IO };
    b.fill(0xFF);
    0
}

unsafe extern "C" fn bd_sync(_: *const lfs::lfs_config) -> c_int {
    0
}

/// A mounted (or formattable) LittleFS over `disk`, with its buffers (littlefs is built without malloc).
struct Fs {
    cfg: Box<lfs::lfs_config>,
    lfs: Box<lfs::lfs_t>,
    _bufs: (Vec<u8>, Vec<u8>, Vec<u8>),
    disk: Box<Disk>,
}

fn err(what: &str, code: c_int) -> String {
    format!("the board package image could not be made ({what}: littlefs error {code})")
}

impl Fs {
    fn new(l: &Layout, bytes: Vec<u8>) -> Fs {
        let mut disk = Box::new(Disk { bytes, block_size: l.block_size as usize });
        let mut bufs = (vec![0u8; l.cache_size as usize], vec![0u8; l.cache_size as usize], vec![0u8; l.lookahead_size as usize]);
        let cfg = Box::new(lfs::lfs_config {
            context: &mut *disk as *mut Disk as *mut c_void,
            read: Some(bd_read),
            prog: Some(bd_prog),
            erase: Some(bd_erase),
            sync: Some(bd_sync),
            read_size: l.read_size,
            prog_size: l.prog_size,
            block_size: l.block_size,
            block_count: l.block_count(),
            block_cycles: -1,
            cache_size: l.cache_size,
            lookahead_size: l.lookahead_size,
            read_buffer: bufs.0.as_mut_ptr() as *mut c_void,
            prog_buffer: bufs.1.as_mut_ptr() as *mut c_void,
            lookahead_buffer: bufs.2.as_mut_ptr() as *mut c_void,
            name_max: NAME_MAX,
            ..Default::default()
        });
        Fs { cfg, lfs: Box::new(Default::default()), _bufs: bufs, disk }
    }

    fn file_cfg(&self, buf: &mut Vec<u8>) -> lfs::lfs_file_config {
        buf.resize(self.cfg.cache_size as usize, 0);
        lfs::lfs_file_config { buffer: buf.as_mut_ptr() as *mut c_void, ..Default::default() }
    }

    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        let name = CString::new(path).map_err(|e| e.to_string())?;
        let mut fbuf = vec![];
        let fcfg = self.file_cfg(&mut fbuf);
        let mut file: lfs::lfs_file_t = Default::default();
        unsafe {
            let flags = (lfs::lfs_open_flags_LFS_O_WRONLY | lfs::lfs_open_flags_LFS_O_CREAT | lfs::lfs_open_flags_LFS_O_TRUNC) as c_int;
            let r = lfs::lfs_file_opencfg(&mut *self.lfs, &mut file, name.as_ptr(), flags, &fcfg);
            if r < 0 {
                return Err(err("open", r));
            }
            let w = lfs::lfs_file_write(&mut *self.lfs, &mut file, data.as_ptr() as *const c_void, data.len() as lfs::lfs_size_t);
            let c = lfs::lfs_file_close(&mut *self.lfs, &mut file);
            if w < 0 || w as usize != data.len() {
                return Err(err("write", w));
            }
            if c < 0 {
                return Err(err("close", c));
            }
        }
        Ok(())
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>, String> {
        let name = CString::new(path).map_err(|e| e.to_string())?;
        let mut fbuf = vec![];
        let fcfg = self.file_cfg(&mut fbuf);
        let mut file: lfs::lfs_file_t = Default::default();
        unsafe {
            let r = lfs::lfs_file_opencfg(&mut *self.lfs, &mut file, name.as_ptr(), lfs::lfs_open_flags_LFS_O_RDONLY as c_int, &fcfg);
            if r < 0 {
                return Err(err("open", r));
            }
            let size = lfs::lfs_file_size(&mut *self.lfs, &mut file);
            let mut out = vec![0u8; size.max(0) as usize];
            let n = lfs::lfs_file_read(&mut *self.lfs, &mut file, out.as_mut_ptr() as *mut c_void, out.len() as lfs::lfs_size_t);
            lfs::lfs_file_close(&mut *self.lfs, &mut file);
            if n < 0 {
                return Err(err("read", n));
            }
            out.truncate(n as usize);
            Ok(out)
        }
    }
}

/// A fresh file system image (the whole partition, erased bytes 0xFF) holding only `files`.
pub fn build_fs(l: &Layout, files: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    let mut fs = Fs::new(l, vec![0xFF; l.size as usize]);
    unsafe {
        let r = lfs::lfs_format(&mut *fs.lfs, &*fs.cfg);
        if r < 0 {
            return Err(err("format", r));
        }
        let r = lfs::lfs_mount(&mut *fs.lfs, &*fs.cfg);
        if r < 0 {
            return Err(err("mount", r));
        }
    }
    for (path, data) in files {
        fs.write(path, data)?;
    }
    unsafe { lfs::lfs_unmount(&mut *fs.lfs) };
    Ok(std::mem::take(&mut fs.disk.bytes))
}

/// One file of an image, mounted with the board's geometry (tests and the bench check).
pub fn read_fs(l: &Layout, image: &[u8], path: &str) -> Result<Vec<u8>, String> {
    let mut fs = Fs::new(l, image.to_vec());
    unsafe {
        let r = lfs::lfs_mount(&mut *fs.lfs, &*fs.cfg);
        if r < 0 {
            return Err(err("mount", r));
        }
    }
    let out = fs.read(path);
    unsafe { lfs::lfs_unmount(&mut *fs.lfs) };
    out
}

/// Whether a package made for chip `pkg` (its `mcu`: `esp32-devkit` or `pico`) goes on a board `mcu` (info.mcu);
/// a package without `mcu` (one on a `base`) goes on any.
pub fn chip_fits(pkg: Option<&str>, mcu: &str) -> bool {
    match pkg {
        None => true,
        Some("pico") => mcu.starts_with("pico"),
        Some(p) => p == mcu,
    }
}

fn chip_words(mcu: &str) -> &'static str {
    if mcu.starts_with("pico") { "a Raspberry Pi Pico board" } else if mcu.starts_with("esp32") { "an ESP32 board" } else { "another kind of board" }
}

/// The image of a board package (checked JSON) for a board `mcu`: `/board-a.bin` with the defaults flag set. A
/// package made for another chip is refused here, before anything is written (the board would refuse it at power-on
/// and drive no pins).
pub fn package_image(mcu: &str, package: &Value) -> Result<Vec<u8>, String> {
    crate::boardpkg::check_package_value(package)?;
    let want = package["mcu"].as_str();
    if !chip_fits(want, mcu) {
        return Err(format!("the board package “{}” is made for {}, and this is {}: choose the package made for this board",
            package["name"].as_str().unwrap_or(""), chip_words(want.unwrap_or("")), chip_words(mcu)));
    }
    let l = layout(mcu)?;
    let file = ab_frame(&board_record(&package.to_string(), true)?, FIRST_SEQ);
    build_fs(&l, &[(RECORD_FILE, &file)])
}

/// The image of a USB install: the package with the chosen profile and script as its own defaults (applied at
/// the first power-on). When that no longer fits the board's store, the package alone, and `false`: the profile
/// and script are then sent once the board answers.
pub fn install_image(mcu: &str, package: &Value, profile: Option<&Value>, script: Option<&str>) -> Result<(Vec<u8>, bool), String> {
    if profile.is_none() && script.is_none() {
        return Ok((package_image(mcu, package)?, true));
    }
    let mut with = package.clone();
    if !with["defaults"].is_object() {
        with["defaults"] = serde_json::json!({});
    }
    if let Some(p) = profile {
        with["defaults"]["profile"] = p.clone();
    }
    if let Some(t) = script {
        with["defaults"]["script"] = Value::String(t.to_string());
    }
    match package_image(mcu, &with) {
        Ok(img) => Ok((img, true)),
        Err(_) => Ok((package_image(mcu, package)?, false)),
    }
}

/// The board package JSON in an image, with its defaults flag (the bench check of `fs-image --read`).
pub fn image_package(mcu: &str, image: &[u8]) -> Result<(String, bool), String> {
    let f = read_fs(&layout(mcu)?, image, RECORD_FILE)?;
    let p = ab_payload(&f).ok_or("the file's frame or CRC is wrong")?;
    read_record(p).ok_or_else(|| "the board record is damaged".to_string())
}

// ---------------------------------------------------------------- UF2 (Pico)

const UF2_MAGIC0: u32 = 0x0A32_4655;
const UF2_MAGIC1: u32 = 0x9E5D_5157;
const UF2_MAGIC_END: u32 = 0x0AB1_6F30;
const UF2_FAMILY_FLAG: u32 = 0x2000;
const UF2_BLOCK: usize = 512;

/// A UF2 file with `data` added at flash offset `offset` (blocks of [`UF2_PAYLOAD`] bytes, the first block's
/// family), every block renumbered. Refused when the UF2 already writes there.
pub fn uf2_with(uf2: &[u8], offset: u32, data: &[u8]) -> Result<Vec<u8>, String> {
    if uf2.len() % UF2_BLOCK != 0 || uf2.is_empty() {
        return Err("the firmware's UF2 file is damaged".into());
    }
    let w = |b: &[u8], i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let first = &uf2[..UF2_BLOCK];
    if w(first, 0) != UF2_MAGIC0 || w(first, 4) != UF2_MAGIC1 {
        return Err("the firmware's UF2 file is damaged".into());
    }
    let (flags, family) = (w(first, 8), w(first, 28));
    let start = PICO_FLASH_BASE + offset;
    let end = start + data.len() as u32;
    for b in uf2.chunks(UF2_BLOCK) {
        let (addr, size) = (w(b, 12), w(b, 16));
        if addr < end && addr + size > start {
            return Err("the firmware image reaches into the board's file system".into());
        }
    }
    let mut blocks: Vec<Vec<u8>> = uf2.chunks(UF2_BLOCK).map(|b| b.to_vec()).collect();
    for (i, chunk) in data.chunks(UF2_PAYLOAD).enumerate() {
        let mut b = vec![0u8; UF2_BLOCK];
        let put = |b: &mut Vec<u8>, at: usize, v: u32| b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        put(&mut b, 0, UF2_MAGIC0);
        put(&mut b, 4, UF2_MAGIC1);
        put(&mut b, 8, flags & UF2_FAMILY_FLAG);
        put(&mut b, 12, start + (i * UF2_PAYLOAD) as u32);
        put(&mut b, 16, UF2_PAYLOAD as u32);
        put(&mut b, 28, if flags & UF2_FAMILY_FLAG != 0 { family } else { 0 });
        b[32..32 + chunk.len()].copy_from_slice(chunk);
        put(&mut b, UF2_BLOCK - 4, UF2_MAGIC_END);
        blocks.push(b);
    }
    let total = blocks.len() as u32;
    for (i, b) in blocks.iter_mut().enumerate() {
        b[20..24].copy_from_slice(&(i as u32).to_le_bytes());
        b[24..28].copy_from_slice(&total.to_le_bytes());
    }
    Ok(blocks.concat())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lamp() -> Value {
        json!({ "board_package": 1, "id": "lamp-board", "name": "Demo lamp board", "mcu": "esp32-devkit",
            "terminals": { "OUT1": { "pin": 23 }, "OUT2": { "pin": 22 }, "TRIG1": { "pin": 36, "active": "low", "pull": "board" } },
            "defaults": { "settings": { "out1_name": "Lamp" }, "script": "effect1: lamp\n" } })
    }

    #[test]
    fn a_package_for_another_chip_is_refused_before_anything_is_written() {
        let mut pico = lamp();
        pico["mcu"] = json!("pico");
        let e = package_image("esp32-devkit", &pico).unwrap_err();
        assert!(e.contains("made for a Raspberry Pi Pico board, and this is an ESP32 board"), "{e}");
        assert!(package_image("pico-w", &pico).is_ok());
        assert!(package_image("pico-w", &lamp()).unwrap_err().contains("made for an ESP32 board"));
        // a package on a base names no chip: any
        let base = json!({ "board_package": 1, "id": "lamp-words", "name": "Lamp words", "base": "proptroller" });
        assert!(package_image("esp32-devkit", &base).is_ok() && package_image("pico2-w", &base).is_ok());
    }

    #[test]
    fn the_authors_key_order_is_kept() {
        // the board applies defaults.settings in object order
        let text = r#"{"board_package":1,"name":"Z first","id":"z","defaults":{"settings":{"zeta":1,"alpha":2,"mid":3}}}"#;
        let v = crate::boardpkg::check_package(text).unwrap();
        let img = package_image("esp32-devkit", &v).unwrap();
        assert_eq!(image_package("esp32-devkit", &img).unwrap().0, text);
        let (img, _) = install_image("esp32-devkit", &v, None, Some("effect1: x\n")).unwrap();
        let j = image_package("esp32-devkit", &img).unwrap().0;
        assert!(j.find("zeta").unwrap() < j.find("alpha").unwrap() && j.find("alpha").unwrap() < j.find("mid").unwrap(), "{j}");
        assert!(j.starts_with(r#"{"board_package":1,"name":"Z first","id":"z""#), "{j}");
    }

    #[test]
    fn crc32_is_zlibs() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn lz_round_trips_and_packs_repeats() {
        for s in [&b""[..], b"a", b"abcabcabcabcabcabcabcabc", lamp().to_string().as_bytes(), &[7u8; 5000][..]] {
            let p = lz_pack(s);
            assert_eq!(lz_unpack(&p, s.len()).as_deref(), Some(s));
        }
        assert!(lz_pack(&[7u8; 5000]).len() < 700);
        // an all-literal stream decodes too (what the firmware accepts)
        let lit: Vec<u8> = [0xFF, b'a', b'b', b'c', b'd', b'e', b'f', b'g', b'h', 0x01, b'i'].to_vec();
        assert_eq!(lz_unpack(&lit, 9).unwrap(), b"abcdefghi");
        assert!(lz_unpack(&lit, 10).is_none());
        assert!(lz_unpack(&[0x00, 0x05, 0x00], 3).is_none(), "a match before the start");
    }

    #[test]
    fn the_record_and_frame_read_back() {
        let j = lamp().to_string();
        let r = board_record(&j, true).unwrap();
        assert_eq!(&r[..4], b"PTBP");
        assert_eq!(read_record(&r), Some((j.clone(), true)));
        assert_eq!(read_record(&board_record(&j, false).unwrap()).unwrap().1, false);
        let f = ab_frame(&r, FIRST_SEQ);
        assert_eq!(&f[..4], b"PTC1");
        assert_eq!(u32::from_le_bytes(f[4..8].try_into().unwrap()), 1);
        assert_eq!(ab_payload(&f), Some(&r[..]));
        let mut bad = f.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(ab_payload(&bad).is_none());
        // too big for the board's store: refused in plain words
        let mut x = 0x2545_F491u32;
        let noise: String = (0..9000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                char::from(b'!' + (x % 90) as u8)
            })
            .collect();
        assert!(board_record(&noise, true).unwrap_err().contains("too big to store on the board"));
    }

    #[test]
    fn layouts_follow_the_flash_map() {
        let e = layout("esp32-devkit").unwrap();
        assert_eq!((e.offset, e.size, e.block_count(), e.read_size, e.cache_size, e.lookahead_size), (0x3D_0000, 0x2_0000, 32, 128, 512, 128));
        let w = layout("pico-w").unwrap();
        assert_eq!((w.offset, w.size, w.block_count()), (0x1D_0000, 188 * 1024, 47));
        assert_eq!(layout("pico2-w").unwrap().offset, 0x3D_0000);
        let p = layout("pico").unwrap();
        assert_eq!((p.offset, p.block_count()), (0x1B_F000, 64));
        assert!(layout("sim").is_err());
    }

    #[test]
    fn the_image_mounts_with_the_boards_geometry_and_holds_the_package() {
        for mcu in ["esp32-devkit", "pico-w", "pico2-w", "pico"] {
            let mut pkg = lamp();
            if mcu.starts_with("pico") {
                pkg["mcu"] = json!("pico");
            }
            let img = package_image(mcu, &pkg).unwrap();
            let l = layout(mcu).unwrap();
            assert_eq!(img.len(), l.size as usize);
            let (json, apply) = image_package(mcu, &img).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&json).unwrap(), pkg);
            assert!(apply);
            // the only file
            assert!(read_fs(&l, &img, "/board-b.bin").is_err());
        }
        // a big package (a long script in its defaults) goes into blocks of its own, not inline
        let mut big = lamp();
        big["defaults"]["script"] = json!("effect1: lamp on 1s\n".repeat(150));
        let img = package_image("esp32-devkit", &big).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&image_package("esp32-devkit", &img).unwrap().0).unwrap(), big);
        assert!(package_image("esp32-devkit", &json!({ "id": "x" })).unwrap_err().contains("board_package"));
    }

    #[test]
    fn a_chosen_profile_and_script_become_the_packages_defaults_when_they_fit() {
        let (img, inside) = install_image("esp32-devkit", &lamp(), Some(&json!({ "title": "Lamp" })), Some("effect1: blink\n")).unwrap();
        assert!(inside);
        let v: Value = serde_json::from_str(&image_package("esp32-devkit", &img).unwrap().0).unwrap();
        assert_eq!(v["defaults"]["profile"]["title"], "Lamp");
        assert_eq!(v["defaults"]["script"], "effect1: blink\n");
        assert_eq!(v["defaults"]["settings"]["out1_name"], "Lamp");
        // a script that does not fit beside the package: the package alone, the script is sent afterwards
        let mut x = 7u32;
        let big: String = (0..7000).map(|_| { x ^= x << 13; x ^= x >> 17; x ^= x << 5; char::from(b'a' + (x % 26) as u8) }).collect();
        let (img, inside) = install_image("esp32-devkit", &lamp(), None, Some(&big)).unwrap();
        assert!(!inside);
        assert_eq!(serde_json::from_str::<Value>(&image_package("esp32-devkit", &img).unwrap().0).unwrap(), lamp());
    }

    #[test]
    fn the_firmwares_own_record_reads_back() {
        // firmware/arduino/test/fixtures/records/board-record.bin (a /board-a.bin the firmware wrote), when the
        // firmware tree is there
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../firmware/firmware/arduino/test/fixtures/records");
        let (Ok(bin), Ok(json)) = (std::fs::read(dir.join("board-record.bin")), std::fs::read_to_string(dir.join("board-record.json"))) else {
            eprintln!("no firmware fixture here: skipped");
            return;
        };
        let (got, _) = read_record(ab_payload(&bin).expect("frame")).expect("record");
        assert_eq!(serde_json::from_str::<Value>(&got).unwrap(), serde_json::from_str::<Value>(&json).unwrap());
        // and Studio's packing of the same JSON is byte for byte the firmware's (the same LZSS search)
        let rec = ab_payload(&bin).unwrap();
        let flags = u16::from_le_bytes([rec[6], rec[7]]) & FLAG_APPLY_DEFAULTS != 0;
        assert_eq!(board_record(&got, flags).unwrap(), rec);
    }

    #[test]
    fn a_pico_uf2_gets_the_file_system_blocks() {
        let mut fw = vec![0u8; 512];
        let put = |b: &mut Vec<u8>, at: usize, v: u32| b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        put(&mut fw, 0, UF2_MAGIC0);
        put(&mut fw, 4, UF2_MAGIC1);
        put(&mut fw, 8, UF2_FAMILY_FLAG);
        put(&mut fw, 12, PICO_FLASH_BASE);
        put(&mut fw, 16, 256);
        put(&mut fw, 24, 1);
        put(&mut fw, 28, 0xE48B_FF56);
        put(&mut fw, 508, UF2_MAGIC_END);
        let data = vec![0xABu8; 1000];
        let out = uf2_with(&fw, 0x1D_0000, &data).unwrap();
        assert_eq!(out.len(), 512 * 5);
        let w = |i: usize, at: usize| u32::from_le_bytes(out[i * 512 + at..i * 512 + at + 4].try_into().unwrap());
        for i in 0..5 {
            assert_eq!((w(i, 20), w(i, 24), w(i, 28)), (i as u32, 5, 0xE48B_FF56));
        }
        assert_eq!(w(1, 12), PICO_FLASH_BASE + 0x1D_0000);
        assert_eq!(w(4, 12), PICO_FLASH_BASE + 0x1D_0000 + 768);
        assert_eq!(crate::flash::uf2_family(&out), Some(0xE48B_FF56));
        // a firmware that already writes there is refused
        assert!(uf2_with(&fw, 0, &data).unwrap_err().contains("file system"));
    }
}
