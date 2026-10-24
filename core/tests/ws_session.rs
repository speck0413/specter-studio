//! Wi-Fi sessions against a fake board on a local WebSocket (bench run 2026-10-22, Wi-Fi part, problem 10): a
//! board that restarts or loses power says nothing, so Studio must notice the silence, go offline, and come back
//! by itself as soon as the board answers again.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use studio_core::{Event, Studio};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone)]
struct Fake {
    port: u16,
    /// gone: open sockets fall silent (no close, as a board losing power), new ones are dropped
    gone: Arc<AtomicBool>,
    /// how often it started (info.boots), and when
    boots: Arc<AtomicU64>,
    /// a `reboot`: gone for this long, then back with a new boot
    reboot_ms: u64,
}

async fn fake_board(reboot_ms: u64) -> Fake {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fake { port: l.local_addr().unwrap().port(), gone: Arc::new(AtomicBool::new(false)), boots: Arc::new(AtomicU64::new(1)), reboot_ms };
    let f2 = f.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = l.accept().await else { return };
            if f2.gone.load(Ordering::Relaxed) {
                drop(tcp);
                continue;
            }
            let f3 = f2.clone();
            tokio::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                let boot = f3.boots.load(Ordering::Relaxed);
                let (mut tx, mut rx) = ws.split();
                let mut held: Option<Value> = None; // a `hold` request, answered after the next one
                loop {
                    // gone: stop reading (so not even a pong goes out) and hold the socket open, silent
                    if f3.gone.load(Ordering::Relaxed) || f3.boots.load(Ordering::Relaxed) != boot {
                        tokio::time::sleep(Duration::from_secs(120)).await;
                        return;
                    }
                    let m = match tokio::time::timeout(Duration::from_millis(50), rx.next()).await {
                        Ok(Some(Ok(m))) => m,
                        Ok(_) => return,
                        Err(_) => continue,
                    };
                    if f3.gone.load(Ordering::Relaxed) {
                        continue;
                    }
                    match m {
                        Message::Ping(p) => { let _ = tx.send(Message::Pong(p)).await; }
                        Message::Text(t) => {
                            let v: Value = serde_json::from_str(&t).unwrap_or_default();
                            let id = v["id"].clone();
                            let out = match v["op"].as_str() {
                                Some("info") => json!({ "v": 1, "id": id, "ok": true, "result": { "kind": "info", "id": "fa0b1c2d3e4f", "name": "Fake Wi-Fi", "boots": boot } }),
                                Some("reboot") => {
                                    let (gone, boots, ms) = (f3.gone.clone(), f3.boots.clone(), f3.reboot_ms);
                                    gone.store(true, Ordering::Relaxed);
                                    tokio::spawn(async move {
                                        tokio::time::sleep(Duration::from_millis(ms)).await;
                                        boots.fetch_add(1, Ordering::Relaxed);
                                        gone.store(false, Ordering::Relaxed);
                                    });
                                    json!({ "v": 1, "id": id, "ok": true, "result": { "kind": "done" } })
                                }
                                Some("hold") => {
                                    held = Some(id);
                                    continue;
                                }
                                // newer firmware (PROTOCOL.md: error answers echo the id) while an older request waits
                                Some("wifi_scan_new") => {
                                    let err = json!({ "v": 1, "id": id, "ok": false, "error": { "code": "bad_request", "message": "unknown op `wifi_scan_new`" } });
                                    let _ = tx.send(Message::text(err.to_string())).await;
                                    match held.take() {
                                        Some(h) => json!({ "v": 1, "id": h, "ok": true, "result": { "kind": "done" } }),
                                        None => continue,
                                    }
                                }
                                // firmware 0.1.0-rc.1: an unknown op is answered without the request's id
                                _ => json!({ "v": 1, "ok": false, "error": { "code": "bad_request", "message": format!("unknown op `{}`: this firmware does not have it", v["op"].as_str().unwrap_or("")) } }),
                            };
                            let _ = tx.send(Message::text(out.to_string())).await;
                        }
                        _ => {}
                    }
                }
            });
        }
    });
    f
}

/// Waits for the session's online event with this value; the time it took.
async fn online_becomes(ev: &mut tokio::sync::broadcast::Receiver<Event>, key: &str, want: bool, within: Duration) -> Option<Duration> {
    let t = Instant::now();
    while t.elapsed() < within {
        if let Ok(Ok(Event::Online { key: k, online })) = tokio::time::timeout(Duration::from_millis(200), ev.recv()).await {
            if k == key && online == want {
                return Some(t.elapsed());
            }
        }
    }
    None
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_board_goes_offline_and_comes_back_by_itself() {
    let s = Studio::new();
    let f = fake_board(0).await;
    let r = s.dispatch("connect", json!({ "address": format!("127.0.0.1:{}", f.port) })).await.unwrap();
    let key = r["key"].as_str().unwrap().to_string();
    let mut ev = s.events();
    f.gone.store(true, Ordering::Relaxed); // power cut: no close, just silence
    let off = online_becomes(&mut ev, &key, false, Duration::from_secs(10)).await.expect("offline after the silence");
    assert!(off <= Duration::from_secs(8), "noticed after {off:?}");
    f.gone.store(false, Ordering::Relaxed);
    let on = online_becomes(&mut ev, &key, true, Duration::from_secs(5)).await.expect("back by itself");
    assert!(on <= Duration::from_secs(2), "back after {on:?}");
    let info = s.dispatch("rpc", json!({ "key": key, "req": { "op": "info" } })).await.unwrap();
    assert_eq!(info["result"]["name"], "Fake Wi-Fi");
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_restart_the_session_is_back_as_soon_as_the_board_answers() {
    let s = Studio::new();
    let f = fake_board(1500).await;
    let r = s.dispatch("connect", json!({ "address": format!("127.0.0.1:{}", f.port) })).await.unwrap();
    let key = r["key"].as_str().unwrap().to_string();
    let mut ev = s.events();
    let t = Instant::now();
    let done = s.dispatch("rpc", json!({ "key": key, "req": { "op": "reboot" } })).await.unwrap();
    assert_eq!(done["ok"], true);
    online_becomes(&mut ev, &key, false, Duration::from_secs(2)).await.expect("offline at once after the reboot was taken");
    online_becomes(&mut ev, &key, true, Duration::from_secs(6)).await.expect("back");
    assert!(t.elapsed() < Duration::from_millis(1500 + 1500), "back {:?} after Restart (the board needed 1.5 s)", t.elapsed());
    let info = s.dispatch("rpc", json!({ "key": key, "req": { "op": "info" } })).await.unwrap();
    assert_eq!(info["result"]["boots"], 2, "the new boot answers");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_error_without_the_request_id_answers_it() {
    let s = Studio::new();
    let f = fake_board(0).await;
    let r = s.dispatch("connect", json!({ "address": format!("127.0.0.1:{}", f.port) })).await.unwrap();
    let key = r["key"].as_str().unwrap().to_string();
    let t = Instant::now();
    let a = s.dispatch("rpc", json!({ "key": key, "req": { "op": "restart" } })).await.unwrap();
    assert!(t.elapsed() < Duration::from_secs(2), "answered in {:?}, not a timeout", t.elapsed());
    assert_eq!(a["ok"], false);
    assert!(a["error"]["message"].as_str().unwrap().contains("unknown op `restart`"), "{a}");
    let c = s.dispatch("connections", json!({})).await.unwrap();
    assert_eq!(c[0]["online"], true, "the session stays up");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_error_with_the_request_id_answers_that_request_not_the_oldest() {
    let s = Studio::new();
    let f = fake_board(0).await;
    let r = s.dispatch("connect", json!({ "address": format!("127.0.0.1:{}", f.port) })).await.unwrap();
    let key = r["key"].as_str().unwrap().to_string();
    let older = s.dispatch("rpc", json!({ "key": key, "req": { "op": "hold" } }));
    let newer = async {
        tokio::time::sleep(Duration::from_millis(200)).await; // `hold` is waiting on the board
        let t = Instant::now();
        let a = s.dispatch("rpc", json!({ "key": key, "req": { "op": "wifi_scan_new" } })).await.unwrap();
        (a, t.elapsed())
    };
    let (o, (a, took)) = tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(older, newer) }).await.expect("both answered");
    let o = o.unwrap();
    assert!(took < Duration::from_secs(2), "answered in {took:?}, not a timeout");
    assert_eq!(a["ok"], false, "{a}");
    assert!(a["error"]["message"].as_str().unwrap().contains("wifi_scan_new"), "{a}");
    assert_eq!(o["ok"], true, "the older request gets its own answer, not the error: {o}");
}

#[tokio::test(flavor = "multi_thread")]
async fn one_board_at_two_addresses_is_one_session() {
    let s = Studio::new();
    let f = fake_board(0).await;
    let a = s.dispatch("connect", json!({ "address": format!("127.0.0.1:{}", f.port) })).await.unwrap();
    let b = s.dispatch("connect", json!({ "address": format!("localhost:{}", f.port) })).await.unwrap();
    assert_eq!(b["key"], a["key"], "{b}");
    assert_eq!(b["same_as"], format!("http://localhost:{}", f.port));
    let c = s.dispatch("connections", json!({})).await.unwrap();
    assert_eq!(c.as_array().unwrap().len(), 1, "{c}");
    assert_eq!(c[0]["info"]["id"], "fa0b1c2d3e4f", "the last info is kept for a reloaded page");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_board_at_a_new_address_while_the_old_one_is_away_gets_its_own_session() {
    let s = Studio::new();
    let f = fake_board(0).await;
    let a = s.dispatch("connect", json!({ "address": format!("127.0.0.1:{}", f.port) })).await.unwrap();
    let key = a["key"].as_str().unwrap().to_string();
    let mut ev = s.events();
    f.gone.store(true, Ordering::Relaxed); // it left that network
    online_becomes(&mut ev, &key, false, Duration::from_secs(10)).await.expect("offline");
    // the same board (same id) answers somewhere else (plugged in with USB, say): a session of its own that works
    let g = fake_board(0).await;
    let b = s.dispatch("connect", json!({ "address": format!("127.0.0.1:{}", g.port) })).await.unwrap();
    assert_ne!(b["key"], a["key"], "{b}");
    assert!(b["same_as"].is_null(), "{b}");
    let info = s.dispatch("rpc", json!({ "key": b["key"], "req": { "op": "info" } })).await.unwrap();
    assert_eq!(info["ok"], true, "{info}");
}

/// `localhost` is dialled as 127.0.0.1 (boards listen on IPv4 only; Windows tries `::1` first and waits there).
#[test]
fn localhost_is_dialled_over_ipv4() {
    use studio_core::conn::ws_url;
    assert_eq!(ws_url("http://localhost:8080"), "ws://127.0.0.1:8080/api/v1/ws");
    assert_eq!(ws_url("http://localhost"), "ws://127.0.0.1/api/v1/ws");
    assert_eq!(ws_url("http://localhost.lan:80/"), "ws://localhost.lan:80/api/v1/ws");
    assert_eq!(ws_url("http://door.local:80"), "ws://door.local:80/api/v1/ws");
}
