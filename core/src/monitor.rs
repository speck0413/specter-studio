//! The serial monitor: any USB serial port as plain lines (what a sketch prints), with friendly port names,
//! sending a line, and reconnecting by itself after the board resets or is flashed. Also finds a Raspberry Pi
//! Pico waiting in BOOTSEL mode (its USB drive).

use crate::Event;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// A friendly name from a USB id: what a beginner recognises.
pub fn friendly(vid: u16, pid: u16, product: Option<&str>) -> String {
    match (vid, pid) {
        (0x10c4, 0xea60) => "ESP32 board (CP210x USB chip)".into(),
        (0x1a86, 0x7523) | (0x1a86, 0x55d4) => "ESP32 board (CH340 USB chip)".into(),
        (0x0403, 0x6001) | (0x0403, 0x6015) => "USB serial adapter (FTDI)".into(),
        (0x303a, _) => "ESP32 board (built-in USB)".into(),
        (0x2e8a, 0x000a) | (0x2e8a, 0x0009) => "Raspberry Pi Pico".into(),
        (0x2e8a, 0x000f) => "Raspberry Pi Pico 2".into(),
        (0x2e8a, 0xf00a) | (0x2e8a, 0x00c0) => "Raspberry Pi Pico (Arduino)".into(),
        (0x2e8a, _) => "Raspberry Pi Pico".into(),
        _ => product.map(String::from).unwrap_or_else(|| format!("USB serial device {vid:04x}:{pid:04x}")),
    }
}

/// A USB serial chip that ESP32 boards use (CH340 / CH9102, CP210x, FTDI, Espressif's own USB): a board on one
/// that does not answer may simply have no Specter firmware yet.
pub fn esp_bridge(vid: u16) -> bool {
    matches!(vid, 0x1a86 | 0x10c4 | 0x0403 | 0x303a)
}

/// Every serial port: `{path, what, usb, esp_bridge}`; USB ports first. `SPECTER_TEST_SERIAL_PORTS` (a JSON list
/// of such entries) adds ports, for the UI tests only.
pub fn ports() -> Vec<Value> {
    let mut v: Vec<Value> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| match p.port_type {
            serialport::SerialPortType::UsbPort(u) => json!({ "path": p.port_name, "what": friendly(u.vid, u.pid, u.product.as_deref()), "usb": true, "esp_bridge": esp_bridge(u.vid) }),
            serialport::SerialPortType::BluetoothPort => json!({ "path": p.port_name, "what": "Bluetooth serial", "usb": false }),
            _ => json!({ "path": p.port_name, "what": "Serial port", "usb": false }),
        })
        .filter(|p| p["usb"] == true || !p["path"].as_str().unwrap_or("").starts_with("/dev/ttyS"))
        .collect();
    if let Some(extra) = std::env::var("SPECTER_TEST_SERIAL_PORTS").ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()) {
        v.extend(extra);
    }
    v.sort_by_key(|p| p["usb"] != true);
    v
}

/// Mounted BOOTSEL drives (a Pico waiting for a firmware file): folders holding `INFO_UF2.TXT`.
pub fn bootsel_drives() -> Vec<Value> {
    let mut roots: Vec<PathBuf> = vec![];
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    for base in [format!("/media/{user}"), format!("/run/media/{user}"), "/Volumes".into(), "/media".into()] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            roots.extend(rd.flatten().map(|e| e.path()));
        }
    }
    if cfg!(windows) {
        roots.extend(('D'..='Z').map(|c| PathBuf::from(format!("{c}:\\"))));
    }
    roots
        .into_iter()
        .filter_map(|r| {
            let info = std::fs::read_to_string(r.join("INFO_UF2.TXT")).ok()?;
            let board = info.lines().find_map(|l| l.strip_prefix("Board-ID: ")).unwrap_or("").trim().to_string();
            let what = if board.contains("RP2350") { "Pico 2 in BOOTSEL mode" } else { "Pico in BOOTSEL mode" };
            Some(json!({ "path": r.to_string_lossy(), "board": board, "what": what }))
        })
        .collect()
}

struct Monitor {
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<String>,
}

/// Whether a board with this USB vendor id wants DTR raised to talk: a Raspberry Pi Pico's own USB (the
/// arduino-pico core) drops everything the board writes while DTR is low, and it has no reset circuit on DTR.
pub fn wants_dtr(vid: u16) -> bool {
    vid == 0x2e8a
}

fn usb_vid(path: &str) -> Option<u16> {
    serialport::available_ports().ok()?.into_iter().find(|p| p.port_name == path).and_then(|p| match p.port_type {
        serialport::SerialPortType::UsbPort(u) => Some(u.vid),
        _ => None,
    })
}

/// Opens a serial port without touching the board's reset lines: DTR and RTS stay low (an ESP32 DevKit's
/// auto-reset circuit restarts the board, or holds it in its bootloader, when they toggle), so opening the
/// monitor or a USB session, and opening it again after the port went away, never restarts a running show.
/// A Pico ([`wants_dtr`]) gets DTR raised instead, or it would never answer.
///
/// The system raises DTR and RTS together when it opens the port (that alone does not reset: the circuit pulls
/// EN low only while RTS is raised and DTR is not). They are let go in [`quiet_order`], RTS first: the other way
/// round (serialport's `dtr_on_open(false)`) leaves RTS alone raised for a moment, which restarts the board, and an
/// ESP32 restarted while a new firmware is still being checked goes back to its old firmware.
pub fn open_quiet(path: &str, baud: u32, timeout_ms: u64) -> serialport::Result<Box<dyn serialport::SerialPort>> {
    let mut p = serialport::new(path, baud).timeout(Duration::from_millis(timeout_ms)).open()?;
    let pico = usb_vid(path).is_some_and(wants_dtr);
    for (line, level) in quiet_order(pico) {
        let _ = match line {
            Line::Rts => p.write_request_to_send(level),
            Line::Dtr => p.write_data_terminal_ready(level),
        };
    }
    Ok(p)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Line {
    Rts,
    Dtr,
}

/// The reset lines' levels after an open, in the order they are set: RTS let go first, then DTR (raised only for
/// a Pico). Starting from both raised, no step leaves RTS raised with DTR low (an ESP32 DevKit's reset).
pub const fn quiet_order(pico: bool) -> [(Line, bool); 2] {
    [(Line::Rts, false), (Line::Dtr, pico)]
}

#[derive(Default)]
pub struct Monitors(Mutex<HashMap<String, Monitor>>);

impl Monitors {
    /// Opens `path` at `baud`; every line is an `Event::Serial`. When the port goes away (a reset, a flash) it
    /// is opened again every half second until `close`.
    pub fn open(&self, path: &str, baud: u32, events: broadcast::Sender<Event>) -> Result<(), String> {
        self.close(path);
        // fail now, in plain words, when the port cannot be opened at all
        let first = open_quiet(path, baud, 200).map_err(|e| format!("cannot open {path}: {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<String>();
        let (p, st) = (path.to_string(), stop.clone());
        std::thread::spawn(move || {
            let mut port = Some(first);
            let status = |s: &str| { let _ = events.send(Event::Serial { path: p.clone(), line: String::new(), status: Some(s.into()) }); };
            while !st.load(Ordering::Relaxed) {
                let Some(pt) = port.take().or_else(|| open_quiet(&p, baud, 200).ok()) else {
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                };
                status("connected");
                let Ok(mut writer) = pt.try_clone() else { continue };
                let mut reader = BufReader::new(pt);
                let mut buf = Vec::new();
                loop {
                    if st.load(Ordering::Relaxed) {
                        return;
                    }
                    while let Ok(line) = rx.try_recv() {
                        let _ = writer.write_all(line.as_bytes()).and_then(|_| writer.write_all(b"\n"));
                    }
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) => break,
                        Ok(_) => {
                            if buf.ends_with(b"\n") {
                                let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                                let _ = events.send(Event::Serial { path: p.clone(), line, status: None });
                                buf.clear();
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(_) => break,
                    }
                }
                status("disconnected: waiting for the board to come back");
            }
        });
        self.0.lock().unwrap().insert(path.to_string(), Monitor { stop, tx });
        Ok(())
    }

    pub fn send(&self, path: &str, line: &str) -> Result<(), String> {
        let m = self.0.lock().unwrap();
        m.get(path).ok_or("the serial monitor is not open")?.tx.send(line.to_string()).map_err(|_| "the serial monitor stopped".into())
    }

    pub fn close_all(&self) {
        for (_, m) in self.0.lock().unwrap().drain() {
            m.stop.store(true, Ordering::Relaxed);
        }
    }

    pub fn close(&self, path: &str) {
        if let Some(m) = self.0.lock().unwrap().remove(path) {
            m.stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ESP32 DevKit's auto-reset circuit: EN (reset) is pulled low only while RTS is raised and DTR is not.
    fn resets(rts: bool, dtr: bool) -> bool {
        rts && !dtr
    }

    #[test]
    fn opening_a_port_never_passes_through_the_reset_state() {
        for pico in [false, true] {
            // the system raises both lines when it opens the port
            let (mut rts, mut dtr) = (true, true);
            assert!(!resets(rts, dtr));
            for (line, level) in quiet_order(pico) {
                match line {
                    Line::Rts => rts = level,
                    Line::Dtr => dtr = level,
                }
                assert!(!resets(rts, dtr), "{line:?} -> {level} restarts the board (pico: {pico})");
            }
            assert!(!rts);
            assert_eq!(dtr, pico);
        }
    }
}
