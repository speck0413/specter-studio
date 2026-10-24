//! One live session per connected board: a WebSocket (`/api/v1/ws`) or a USB serial port (JSON lines).
//! Requests go over the session (so grants such as the remote trigger enable live as long as it does),
//! answers are matched by `id`, and everything else the board pushes is an event.

use crate::Event;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_EVERY: Duration = Duration::from_secs(2);

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

pub struct Conn {
    pub key: String,
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
    pub online: Arc<AtomicBool>,
    /// Serial only: something on the port printed text lines (a console, a boot log) that were not JSON. Used to
    /// say in plain words why a USB board did not connect (another firmware, or nothing at all).
    pub heard_text: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    /// Set while another device than the first one answers at this address (an address handed out again by the
    /// router): requests are refused with this message, so actions and page passwords never reach it.
    other_device: Arc<Mutex<Option<String>>>,
    /// The board's last `info` (from connecting): its `id` keeps one session per board (`connect` reuses it), and
    /// a reloaded page shows the board from it while it is away.
    pub info: Mutex<Option<Value>>,
    /// Wakes a WebSocket session to drop its socket and reconnect at once (after a `reboot` the board took).
    kick: Arc<tokio::sync::Notify>,
}

impl Conn {
    /// The board's own id, once known.
    pub fn board_id(&self) -> Option<String> {
        self.info.lock().unwrap().as_ref().and_then(|i| i["id"].as_str()).map(String::from)
    }

    /// Sends one request (`op` and its fields) and waits for the answer envelope.
    pub async fn rpc(&self, mut req: Value) -> Result<Value, String> {
        // never queue while the board is away: a request must not fire minutes later when it comes back
        if let Some(m) = self.other_device.lock().unwrap().clone() {
            return Err(m);
        }
        if !self.online.load(Ordering::Relaxed) {
            return Err("the board is not connected".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let obj = req.as_object_mut().ok_or("a request is a JSON object")?;
        obj.insert("v".into(), json!(1));
        obj.insert("id".into(), json!(id));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self.out.send(req.to_string()).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("the connection is closed".into());
        }
        let restarting = matches!(req["op"].as_str(), Some("reboot" | "factory_reset"));
        match tokio::time::timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(v)) => {
                if restarting && v["ok"] == true {
                    self.kick.notify_one(); // the board goes away now: reconnect as soon as it answers again
                }
                Ok(v)
            }
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err("the board did not answer".into())
            }
        }
    }

    pub fn close(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.out.send(String::new()); // wakes the writer
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.close();
    }
}

fn new_conn(key: &str) -> (Arc<Conn>, mpsc::UnboundedReceiver<String>) {
    let (out, rx) = mpsc::unbounded_channel();
    let conn = Arc::new(Conn {
        key: key.to_string(),
        out,
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: AtomicU64::new(1),
        online: Arc::new(AtomicBool::new(false)),
        heard_text: Arc::new(AtomicBool::new(false)),
        stop: Arc::new(AtomicBool::new(false)),
        other_device: Arc::new(Mutex::new(None)),
        info: Mutex::new(None),
        kick: Arc::new(tokio::sync::Notify::new()),
    });
    (conn, rx)
}

/// One line or text frame from the board: an answer (has `ok`) or an event (has `event`).
fn incoming(key: &str, text: &str, pending: &Pending, events: &broadcast::Sender<Event>) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    if v.get("event").is_some() {
        let _ = events.send(Event::Board { key: key.to_string(), msg: v });
    } else if v.get("ok").is_some() {
        let mut p = pending.lock().unwrap();
        let id = match v.get("id").and_then(Value::as_u64) {
            Some(id) => Some(id),
            // an error without the request's id (firmware 0.1.0-rc.1 answers an unknown `op` so): it answers the
            // oldest request still waiting, which then gets the board's message instead of a timeout
            None if v["ok"] == false => p.keys().filter(|k| **k != WHO_ID).min().copied(),
            None => None,
        };
        if let Some(tx) = id.and_then(|id| p.remove(&id)) {
            let _ = tx.send(v);
        }
    }
}

fn set_online(conn_online: &AtomicBool, key: &str, on: bool, events: &broadcast::Sender<Event>) {
    if conn_online.swap(on, Ordering::Relaxed) != on {
        let _ = events.send(Event::Online { key: key.to_string(), online: on });
    }
}

/// The request id of the identity check sent first on every session (callers' ids start at 1).
const WHO_ID: u64 = 0;

/// How often a WebSocket session pings the board, and how long it may hear nothing at all (no pong, no ping, no
/// event) before the board counts as gone. The board pings every 2 s and ends a session after 5 s of silence
/// (PROTOCOL.md), so a live board is never quiet that long.
pub const WS_PING_EVERY: Duration = Duration::from_secs(2);
pub const WS_SILENT: Duration = Duration::from_secs(5);
/// After a session ends: try again every 500 ms for [`WS_FAST_FOR`] (a restart takes about 3 s), then less and
/// less often, up to every [`WS_SLOWEST`].
const WS_FAST: Duration = Duration::from_millis(500);
const WS_FAST_FOR: Duration = Duration::from_secs(20);
const WS_SLOWEST: Duration = Duration::from_secs(10);

/// The wait before the next try, `since` the board was last online.
fn backoff(since: Duration) -> Duration {
    if since < WS_FAST_FOR {
        return WS_FAST;
    }
    let past = (since - WS_FAST_FOR).as_secs();
    Duration::from_secs((1u64 << (past / 10).min(4)).min(WS_SLOWEST.as_secs()))
}

/// The session's WebSocket URL for `base` (`http://host:port`). `localhost` is dialled as 127.0.0.1: boards and
/// practice boards listen on IPv4 only, and Windows tries `::1` first, where a refused connection takes about 2 s
/// (the whole connect wait), so the IPv4 address would never be tried.
pub fn ws_url(base: &str) -> String {
    let rest = base.strip_prefix("http://").unwrap_or(base);
    let rest = match rest.strip_prefix("localhost") {
        Some(after) if after.is_empty() || after.starts_with(':') || after.starts_with('/') => format!("127.0.0.1{after}"),
        _ => rest.to_string(),
    };
    format!("ws://{}/api/v1/ws", rest.trim_end_matches('/'))
}

/// `base` is `http://host:port`. The session pings the board every 2 s and counts it gone after 5 s without a
/// word; it then reconnects by itself (every 500 ms at first, so a restarted board is back as soon as it
/// answers, then less often) until closed. A `reboot` the board accepted drops the socket at once and reconnects
/// the same way. Every session first asks the board's `info`: the first answer's `id` is the board's identity,
/// and a later session whose board has another id (the address now belongs to another device) stays offline:
/// requests are refused in plain words and one log event says why.
pub fn open_ws(key: &str, base: &str, events: broadcast::Sender<Event>) -> Arc<Conn> {
    let (conn, mut rx) = new_conn(key);
    let url = ws_url(base);
    let (pending, online, stop, other, kick, key) = (conn.pending.clone(), conn.online.clone(), conn.stop.clone(), conn.other_device.clone(), conn.kick.clone(), key.to_string());
    let address = base.to_string();
    tokio::spawn(async move {
        let mut identity: Option<String> = None;
        let mut last_online = tokio::time::Instant::now();
        while !stop.load(Ordering::Relaxed) {
            let fast = last_online.elapsed() < WS_FAST_FOR;
            let connect_wait = if fast { Duration::from_secs(2) } else { Duration::from_secs(5) };
            if let Ok(Ok((ws, _))) = tokio::time::timeout(connect_wait, tokio_tungstenite::connect_async(&url)).await {
                let (mut sink, mut stream) = ws.split();
                // who answers here? (only then is the session online)
                let ask = json!({ "v": 1, "op": "info", "id": WHO_ID }).to_string();
                let mut who: Option<Value> = None;
                if sink.send(Message::text(ask)).await.is_ok() {
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                    while let Ok(Some(Ok(m))) = tokio::time::timeout_at(deadline, stream.next()).await {
                        match m {
                            Message::Text(t) => {
                                let v: Value = serde_json::from_str(&t).unwrap_or_default();
                                if v.get("ok").is_some() && v["id"] == WHO_ID {
                                    who = Some(v);
                                    break;
                                }
                                incoming(&key, &t, &pending, &events);
                            }
                            Message::Ping(p) => { let _ = sink.send(Message::Pong(p)).await; }
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                }
                let id = who.as_ref().and_then(|v| v["result"]["id"].as_str()).map(String::from);
                match (&identity, &id) {
                    (_, None) if who.is_none() => {
                        // no answer: try again later
                        if !stop.load(Ordering::Relaxed) { tokio::time::sleep(backoff(last_online.elapsed())).await; }
                        continue;
                    }
                    (Some(want), Some(got)) if want != got => {
                        let msg = format!("a different device answers at {address} (it is not the board Studio knew there)");
                        let first = other.lock().unwrap().replace(msg.clone()).is_none();
                        if first {
                            let _ = events.send(Event::Board { key: key.clone(), msg: json!({ "v": 1, "event": "log", "data": msg, "other_device": true }) });
                        }
                        set_online(&online, &key, false, &events);
                        let _ = sink.close().await;
                        if !stop.load(Ordering::Relaxed) { tokio::time::sleep(RECONNECT_EVERY).await; }
                        continue;
                    }
                    _ => {
                        if identity.is_none() { identity = id.clone(); }
                        if other.lock().unwrap().take().is_some() {
                            let _ = events.send(Event::Board { key: key.clone(), msg: json!({ "v": 1, "event": "log", "data": "the board is back at its address" }) });
                        }
                    }
                }
                set_online(&online, &key, true, &events);
                let mut heard = tokio::time::Instant::now();
                let mut ping = tokio::time::interval(WS_PING_EVERY);
                ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        msg = rx.recv() => match msg {
                            Some(s) if !s.is_empty() => { if sink.send(Message::text(s)).await.is_err() { break } }
                            _ => { if stop.load(Ordering::Relaxed) { let _ = sink.close().await; break } }
                        },
                        msg = stream.next() => {
                            heard = tokio::time::Instant::now();
                            match msg {
                                Some(Ok(Message::Text(t))) => incoming(&key, &t, &pending, &events),
                                Some(Ok(Message::Ping(p))) => { if sink.send(Message::Pong(p)).await.is_err() { break } }
                                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                _ => {}
                            }
                        },
                        _ = ping.tick() => {
                            // a board that restarted or lost power says nothing: silence is the only sign
                            if heard.elapsed() >= WS_SILENT { break }
                            if tokio::time::timeout(Duration::from_secs(1), sink.send(Message::Ping(Vec::new().into()))).await.map_or(true, |r| r.is_err()) { break }
                        },
                        _ = kick.notified() => {
                            let _ = tokio::time::timeout(Duration::from_millis(300), sink.close()).await;
                            break;
                        },
                    }
                }
                last_online = tokio::time::Instant::now();
                set_online(&online, &key, false, &events);
                pending.lock().unwrap().clear(); // waiting callers get "did not answer"
                while rx.try_recv().is_ok() {} // and nothing sent meanwhile goes out later
            }
            if !stop.load(Ordering::Relaxed) {
                tokio::time::sleep(backoff(last_online.elapsed())).await;
            }
        }
    });
    conn
}

pub type Lines = (Box<dyn Read + Send>, Box<dyn Write + Send>);

/// The opening `info` of a serial session.
const ASK_INFO: &[u8] = b"{\"v\":1,\"op\":\"info\"}\n";
/// The same again, after a newline that ends whatever half line the board's console holds (bytes from its boot).
const ASK_INFO_AGAIN: &[u8] = b"\n{\"v\":1,\"op\":\"info\"}\n";
/// While nothing answers: ask again this often for the first [`ASK_FAST_FOR`], then every [`ASK_SLOW`].
pub const ASK_EVERY: Duration = Duration::from_millis(500);
const ASK_FAST_FOR: Duration = Duration::from_secs(10);
const ASK_SLOW: Duration = Duration::from_secs(3);
/// A board that is online writes its state at least every 5 s; silent longer than this, it is asked again (it may
/// have restarted with the port kept open, and a board pushes nothing until it gets a request).
const QUIET_ASK: Duration = Duration::from_secs(6);

/// JSON lines over a serial port (or anything that reads and writes lines, such as a test's pty). `open` gives
/// the port, again after it went away (a reset, an unplug): the session comes back by itself. Lines that are
/// not JSON (the console, logs, a boot's noise, bytes that are not even text) are skipped. The board starts
/// pushing events after the first request line, so `info` is sent on every open, and again every 500 ms until a
/// JSON line comes back: opening the port of an ESP32 DevKit restarts it, and an `info` that lands in its boot
/// loses bytes. A board that does not restart (a Pico's own USB) answers the first one and is never asked
/// twice. The board's `ready after` line (it has just started) and a long silence also ask again; after `ready
/// after` the session is offline until the board answers (`Event::Online` false, then true).
pub fn open_lines(key: &str, mut open: impl FnMut() -> Option<Lines> + Send + 'static, events: broadcast::Sender<Event>) -> Arc<Conn> {
    let (conn, mut rx) = new_conn(key);
    let (pending, online, heard, stop, k) = (conn.pending.clone(), conn.online.clone(), conn.heard_text.clone(), conn.stop.clone(), key.to_string());
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let Some((reader, mut writer)) = open() else {
                std::thread::sleep(RECONNECT_EVERY);
                continue;
            };
            let dead = Arc::new(AtomicBool::new(false));
            let ready = Arc::new(AtomicBool::new(false)); // the board printed "ready after": it has just started
            let last_json = Arc::new(Mutex::new(std::time::Instant::now()));
            let (p, o, h, s, d, r, lj, kk, ev) = (pending.clone(), online.clone(), heard.clone(), stop.clone(), dead.clone(), ready.clone(), last_json.clone(), k.clone(), events.clone());
            std::thread::spawn(move || {
                let mut lines = BufReader::new(reader);
                let mut buf: Vec<u8> = Vec::new(); // kept over read timeouts: a line may arrive in pieces
                while !s.load(Ordering::Relaxed) {
                    match lines.read_until(b'\n', &mut buf) {
                        Ok(0) => break,
                        Ok(_) if buf.ends_with(b"\n") => {
                            let text = String::from_utf8_lossy(&buf);
                            let t = text.trim();
                            if t.starts_with('{') {
                                *lj.lock().unwrap() = std::time::Instant::now();
                                set_online(&o, &kk, true, &ev);
                                incoming(&kk, t, &p, &ev);
                            } else if !t.is_empty() {
                                h.store(true, Ordering::Relaxed);
                                if t.contains("ready after") {
                                    // the board has just started (a restart, a new firmware): offline until it
                                    // answers again, so Studio reads its info anew, as after a network board's restart
                                    set_online(&o, &kk, false, &ev);
                                    r.store(true, Ordering::Relaxed);
                                }
                            }
                            buf.clear();
                        }
                        Ok(_) => {}
                        Err(e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}
                        Err(_) => break,
                    }
                    if buf.len() > 64 * 1024 {
                        buf.clear(); // noise with no line end: never kept
                    }
                }
                d.store(true, Ordering::Relaxed);
            });
            let opened = std::time::Instant::now();
            let mut asked = opened;
            let mut ok = writer.write_all(ASK_INFO).and_then(|_| writer.flush()).is_ok();
            while ok && !dead.load(Ordering::Relaxed) && !stop.load(Ordering::Relaxed) {
                let on = online.load(Ordering::Relaxed);
                let every = if opened.elapsed() < ASK_FAST_FOR { ASK_EVERY } else { ASK_SLOW };
                let again = ready.swap(false, Ordering::Relaxed)
                    || (!on && asked.elapsed() >= every)
                    || (on && last_json.lock().unwrap().elapsed() >= QUIET_ASK && asked.elapsed() >= QUIET_ASK);
                if again {
                    asked = std::time::Instant::now();
                    ok = writer.write_all(ASK_INFO_AGAIN).and_then(|_| writer.flush()).is_ok();
                    continue;
                }
                match rx.try_recv() {
                    Ok(s) if !s.is_empty() => ok = writer.write_all(s.as_bytes()).and_then(|_| writer.write_all(b"\n")).and_then(|_| writer.flush()).is_ok(),
                    Ok(_) => {}
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(10)),
                    Err(_) => return,
                }
            }
            set_online(&online, &k, false, &events);
            pending.lock().unwrap().clear();
            while rx.try_recv().is_ok() {}
            if !stop.load(Ordering::Relaxed) {
                std::thread::sleep(RECONNECT_EVERY);
            }
        }
    });
    conn
}

pub fn open_serial(path: &str, events: broadcast::Sender<Event>) -> Result<Arc<Conn>, String> {
    let open_port = |p: &str| -> Result<Lines, String> {
        let port = crate::monitor::open_quiet(p, 115_200, 500).map_err(|e| format!("cannot open {p}: {e}"))?;
        let _ = port.clear(serialport::ClearBuffer::Input); // whatever waited from before: not this session's
        let reader = port.try_clone().map_err(|e| e.to_string())?;
        Ok((Box::new(reader), Box::new(port)))
    };
    let mut first = Some(open_port(path)?); // fail now, in plain words, when the port cannot be opened at all
    let p = path.to_string();
    Ok(open_lines(&format!("serial:{path}"), move || first.take().or_else(|| open_port(&p).ok()), events))
}
