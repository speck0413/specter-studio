//! "Plugged in with USB" against fake boards on a pseudo-terminal, through the real `connect {serial}` path.
//!
//! An ESP32 DevKit restarts when its port is opened (first bench run, 2026-10-22): its ROM prints noise that is
//! not even text, a request sent into the boot loses its first bytes and reaches the console as garbage, and the
//! board writes no JSON until it gets a whole JSON request after `ready after`. A Pico on its own USB does not
//! restart and answers the first request.
#![cfg(unix)]

use serde_json::{json, Value};
use serialport::SerialPort;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use studio_core::Studio;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// restarts on open: boot noise, the first request byte lost, `ready after` at 450 ms
    Resets,
    /// answers at once (a Pico's USB)
    NoReset,
    /// prints console lines, never JSON (another firmware)
    TextOnly,
    /// says nothing at all
    Silent,
}

struct Fake {
    path: String,
    /// JSON `info` requests the board took (whole lines that start with `{`)
    infos: Arc<AtomicUsize>,
    /// lines the board's console got that were not JSON (garbled requests)
    garbled: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    _slave: serialport::TTYPort,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn fake(kind: Kind, name: &'static str) -> Fake {
    let (mut board, slave) = serialport::TTYPort::pair().expect("pty pair");
    board.set_timeout(Duration::from_millis(20)).unwrap();
    let path = slave.name().unwrap();
    let (infos, garbled, stop) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
    let (i2, g2, s2) = (infos.clone(), garbled.clone(), stop.clone());
    std::thread::spawn(move || {
        let start = Instant::now();
        let ready_at = Duration::from_millis(450);
        let mut out = board.try_clone_native().unwrap();
        let mut line: Vec<u8> = Vec::new();
        let mut dropped_first = false;
        let mut said_ready = false;
        let mut said_noise = false;
        let mut last_text = Instant::now();
        while !s2.load(Ordering::Relaxed) {
            if kind == Kind::Resets && !said_noise {
                // the ROM's 74880-baud boot messages read at 115200: bytes that are not UTF-8, some line ends
                let _ = out.write_all(&[0xff, 0xfe, 0x00, 0xc3, 0x28, b'\n', 0xa0, 0xa1, 0x8e, b'\r', b'\n', 0xf0, 0x28, 0x8c]);
                said_noise = true;
            }
            if kind == Kind::Resets && !said_ready && start.elapsed() >= ready_at {
                let _ = out.write_all(b"\r\nfree heap 181000 B (min 180000, largest block 110000); ready after 412 ms\r\n");
                said_ready = true;
            }
            if kind == Kind::TextOnly && last_text.elapsed() >= Duration::from_millis(300) {
                let _ = out.write_all(b"temperature 21.5\r\n");
                last_text = Instant::now();
            }
            let mut buf = [0u8; 256];
            let n = match board.read(&mut buf) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => 0,
                Err(_) => break,
            };
            for &c in &buf[..n] {
                if kind == Kind::Silent {
                    continue;
                }
                if kind == Kind::Resets && start.elapsed() < ready_at && !dropped_first {
                    dropped_first = true; // lost in the boot
                    continue;
                }
                if c != b'\n' && c != b'\r' {
                    line.push(c);
                    continue;
                }
                let l = String::from_utf8_lossy(&line).to_string();
                line.clear();
                if l.is_empty() {
                    continue; // an empty line: nothing (as the firmware's console)
                }
                let answers_json = kind == Kind::NoReset || (kind == Kind::Resets && said_ready);
                if l.starts_with('{') && answers_json {
                    let v: Value = serde_json::from_str(&l).unwrap_or_default();
                    if v["op"] == "info" {
                        i2.fetch_add(1, Ordering::Relaxed);
                    }
                    let _ = writeln!(out, "{}", json!({ "v": 1, "id": v["id"], "ok": true, "result": { "kind": "info", "name": name, "id": "a0b1c2d3e4f5" } }));
                } else {
                    g2.fetch_add(1, Ordering::Relaxed);
                    let _ = writeln!(out, "error: unknown command or setting \"{l}\"");
                }
            }
        }
    });
    Fake { path, infos, garbled, stop, _slave: slave }
}

/// Problem 1 of the bench run: the opening `info` is lost in the boot; Studio asks again and connects.
#[tokio::test(flavor = "multi_thread")]
async fn a_board_that_restarts_when_its_port_opens_still_connects() {
    let s = Studio::new();
    let f = fake(Kind::Resets, "DevKit");
    let t = Instant::now();
    let r = s.dispatch("connect", json!({ "serial": f.path })).await.expect("connects");
    assert_eq!(r["info"]["name"], "DevKit", "{r}");
    assert!(t.elapsed() < Duration::from_secs(4), "connected in {:?}", t.elapsed());
    assert!(f.garbled.load(Ordering::Relaxed) >= 1, "the first request reached the console garbled, as on the bench");
    // and the session works afterwards
    let key = r["key"].as_str().unwrap().to_string();
    let again = s.dispatch("rpc", json!({ "key": key, "req": { "op": "info" } })).await.unwrap();
    assert_eq!(again["result"]["name"], "DevKit");
}

/// A Pico's USB does not restart: the first `info` is answered, and Studio never asks a second time unasked.
#[tokio::test(flavor = "multi_thread")]
async fn a_board_that_does_not_restart_is_asked_once() {
    let s = Studio::new();
    let f = fake(Kind::NoReset, "Pico");
    let t = Instant::now();
    let r = s.dispatch("connect", json!({ "serial": f.path })).await.expect("connects");
    assert_eq!(r["info"]["name"], "Pico");
    assert!(t.elapsed() < Duration::from_secs(2), "connected in {:?}", t.elapsed());
    tokio::time::sleep(Duration::from_millis(2500)).await; // well past the 500 ms resend
    // the session's opening info and the connect's own info: nothing more, nothing garbled
    assert_eq!(f.infos.load(Ordering::Relaxed), 2);
    assert_eq!(f.garbled.load(Ordering::Relaxed), 0);
}

/// Nothing answers: a plain-words reason that names the port, after the overall wait.
#[tokio::test(flavor = "multi_thread")]
async fn a_silent_port_gives_a_plain_reason() {
    let s = Studio::new();
    let f = fake(Kind::Silent, "");
    let t = Instant::now();
    let e = s.dispatch("connect", json!({ "serial": f.path })).await.unwrap_err();
    let waited = t.elapsed();
    assert!(e.starts_with(&format!("No board answered on {}", f.path)), "{e}");
    assert!(e.contains("cable"), "{e}");
    assert!(waited >= Duration::from_secs(7) && waited < Duration::from_secs(12), "{waited:?}");
    assert!(s.dispatch("connections", json!({})).await.unwrap().as_array().unwrap().is_empty(), "a failed connect leaves no board behind");
}

/// Something prints text but is no Proptroller (another firmware): said so.
#[tokio::test(flavor = "multi_thread")]
async fn a_port_that_only_prints_text_says_it_is_not_a_proptroller() {
    let s = Studio::new();
    let f = fake(Kind::TextOnly, "");
    let e = s.dispatch("connect", json!({ "serial": f.path })).await.unwrap_err();
    assert!(e.contains("did not answer as a Proptroller board"), "{e}");
}

/// A Pico's own USB writes nothing while DTR is low (arduino-pico SerialUSB checks `tud_cdc_connected`): Studio
/// raises DTR for it, and only for it (an ESP32's DTR is wired to its reset).
#[test]
fn only_a_pico_gets_dtr_raised() {
    use studio_core::monitor::wants_dtr;
    assert!(wants_dtr(0x2e8a), "Raspberry Pi");
    for esp in [0x10c4, 0x1a86, 0x0403, 0x303a] {
        assert!(!wants_dtr(esp), "{esp:04x}");
    }
}
