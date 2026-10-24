//! "Share with others": a read-only view of the fleet for anyone on the network. Studio serves one page and a
//! Server-Sent Events feed of the boards (online / offline, effect script, firmware, outputs) on a port of its
//! own; a phone or laptop just opens `http://<this computer>:<port>/`. No controls, optional view password
//! (HTTP Basic: any user name).

use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

const PAGE: &str = include_str!("viewer.html");

pub struct Viewer {
    pub port: u16,
    snapshot: watch::Sender<String>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
fn b64(s: &str) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b = s.as_bytes();
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() { out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char) } else { out.push('=') }
        }
    }
    out
}

impl Viewer {
    /// Serves on `port` (0: any free port) on every interface.
    pub async fn start(port: u16, password: Option<String>) -> Result<Viewer, String> {
        let listener = TcpListener::bind(("0.0.0.0", port)).await.map_err(|e| format!("port {port} is in use: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let (snapshot, rx) = watch::channel(json!({ "boards": [] }).to_string());
        let password = Arc::new(password.filter(|p| !p.is_empty()));
        // wrong passwords in a row: each answer waits longer (1 s doubling, at most 30 s), so the view password
        // cannot be guessed quickly; a right one resets it
        let wrong = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else { continue };
                let (mut rx, password, wrong) = (rx.clone(), password.clone(), wrong.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
                    if let Some(p) = password.as_ref() {
                        let ok = req.lines().any(|l| {
                            let l = l.trim();
                            // any user name, this password
                            l.len() > 21 && l[..21].eq_ignore_ascii_case("authorization: basic ") && decode_ok(&l[21..], p)
                        });
                        let tried = req.lines().any(|l| l.trim().to_ascii_lowercase().starts_with("authorization:"));
                        if ok {
                            wrong.store(0, std::sync::atomic::Ordering::Relaxed);
                        } else if tried {
                            let n = wrong.fetch_add(1, std::sync::atomic::Ordering::Relaxed).min(5);
                            tokio::time::sleep(std::time::Duration::from_millis((1000u64 << n).min(30_000))).await;
                        }
                        if !ok {
                            let _ = s.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Specter Studio\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                            return;
                        }
                    }
                    match path.as_str() {
                        "/" | "/index.html" => {
                            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'\r\nConnection: close\r\n\r\n", PAGE.len());
                            let _ = s.write_all(head.as_bytes()).await;
                            let _ = s.write_all(PAGE.as_bytes()).await;
                        }
                        "/feed" => {
                            if s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n").await.is_err() {
                                return;
                            }
                            loop {
                                let data = rx.borrow_and_update().clone();
                                if s.write_all(format!("data: {data}\n\n").as_bytes()).await.is_err() {
                                    return;
                                }
                                // a change, or every 15 s a keep-alive with the same snapshot
                                let _ = tokio::time::timeout(Duration::from_secs(15), rx.changed()).await;
                            }
                        }
                        _ => {
                            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        }
                    }
                });
            }
        });
        Ok(Viewer { port, snapshot, task })
    }

    /// The boards to show: `[{name, online, kind, firmware, script, outputs}]` (what Studio itself shows).
    pub fn publish(&self, boards: &Value) {
        let _ = self.snapshot.send(json!({ "boards": boards, "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }).to_string());
    }
}

fn decode_ok(given: &str, password: &str) -> bool {
    // "user:password" in base64
    let t: Vec<u8> = given.bytes().filter(|c| *c != b'=').filter_map(|c| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }).collect();
    let mut out = vec![];
    for c in t.chunks(4) {
        let n = c.iter().enumerate().fold(0u32, |n, (i, v)| n | (*v as u32) << (18 - 6 * i));
        for i in 0..c.len().saturating_sub(1) {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    let s = String::from_utf8_lossy(&out);
    s.split_once(':').is_some_and(|(_, p)| p == password)
}

#[cfg(test)]
mod tests {
    #[test]
    fn basic_auth() {
        let enc = super::b64("anyone:ghost123");
        assert!(super::decode_ok(&enc, "ghost123"));
        assert!(!super::decode_ok(&enc, "ghost12"));
    }
}
