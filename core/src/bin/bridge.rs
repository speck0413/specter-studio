//! The device layer for a browser (development and UI tests): the same `dispatch` and events as the Tauri
//! shell, over one WebSocket, plus plugin files over HTTP.
//!
//!   cargo run -p studio-core --bin bridge -- [--port 18790]
//!
//! WebSocket `/?token=<token>`: `{"id":1,"cmd":"discover","args":{}}` in; `{"id":1,"ok":true,"result":...}` or
//! `{"id":1,"ok":false,"error":"..."}` out; events as `{"event":{...}}`. HTTP `GET /plugins/<id>/<file>`.
//! Listens on 127.0.0.1 only. The WebSocket needs the bridge's token: `SPECTER_BRIDGE_TOKEN`, else a random one
//! made at start, printed and written to `<temp dir>/specter-bridge-<port>.token` (the dev server reads it from
//! there and adds it to its `/__bridge` proxy, so the page itself never holds it). Any other process on this
//! computer without the token is refused.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use studio_core::Studio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = args.iter().position(|a| a == "--port").and_then(|i| args.get(i + 1)).and_then(|p| p.parse().ok()).unwrap_or(18790u16);
    let studio = Arc::new(Studio::new());
    {
        let examples = std::env::var_os("SPECTER_STUDIO_EXAMPLE_PLUGINS");
        let extra = std::env::var_os("SPECTER_STUDIO_PLUGINS");
        studio.plugin_dirs.lock().unwrap().extend(studio_core::plugins::bridge_dirs(examples.as_deref(), extra.as_deref()));
        // extensions added from git: only where SPECTER_STUDIO_EXTENSIONS_DIR says (the desktop app uses its config folder)
        if let Some(d) = std::env::var_os("SPECTER_STUDIO_EXTENSIONS_DIR") {
            studio.set_extensions_dir(d.into());
        }
    }
    // automation rules and their counters and timers are kept here when it is set (else only until the bridge stops)
    if let Some(dir) = std::env::var_os("SPECTER_STUDIO_CONFIG") {
        studio.automation.set_config_dir(dir.into());
    }
    let token = std::env::var("SPECTER_BRIDGE_TOKEN").ok().filter(|t| !t.is_empty()).unwrap_or_else(random_token);
    let token_file = std::env::temp_dir().join(format!("specter-bridge-{port}.token"));
    let _ = std::fs::write(&token_file, &token);
    let listener = TcpListener::bind(("127.0.0.1", port)).await.expect("bridge port");
    println!("bridge on ws://127.0.0.1:{port}/?token={token} (token also in {})", token_file.display());
    let token: Arc<str> = token.into();
    // practice boards stop with the bridge (Ctrl-C or a terminate signal)
    let st = studio.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        st.shutdown();
        std::process::exit(0);
    });
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let (s, t) = (studio.clone(), token.clone());
        tokio::spawn(async move { serve(s, stream, &t).await });
    }
}

/// 32 random hex digits from the system's random source.
fn random_token() -> String {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut b).expect("random");
    hex::encode(b)
}

/// The `token` of a request target such as `/?token=abc`, compared in constant time.
fn token_ok(target: &str, token: &str) -> bool {
    let given = target.split_once('?').map(|q| q.1).unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("token=")).unwrap_or("");
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

async fn serve(studio: Arc<Studio>, mut stream: TcpStream, token: &str) {
    let mut head = [0u8; 4096];
    let n = stream.peek(&mut head).await.unwrap_or(0);
    let req = String::from_utf8_lossy(&head[..n]).to_lowercase();
    if req.contains("upgrade: websocket") {
        // only pages served from this computer (the dev server, the tests) may drive the device layer: a web
        // page elsewhere could otherwise open this WebSocket, since browsers apply no same-origin rule to it
        let check = |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
            let origin = req.headers().get("origin").and_then(|o| o.to_str().ok()).unwrap_or("");
            let local = origin.is_empty() || ["http://localhost:", "http://127.0.0.1:"].iter().any(|p| origin.starts_with(p));
            let target = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("");
            if local && token_ok(target, token) { Ok(resp) } else {
                let mut r = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some(if local { "token missing or wrong" } else { "origin not allowed" }.into()));
                *r.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                Err(r)
            }
        };
        if let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, check).await {
            session(studio, ws).await;
        }
        return;
    }
    // GET /plugins/<id>/<path>
    let path = String::from_utf8_lossy(&head[..n]).split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    let path = studio_core::plugins::percent_decode(&path);
    let found = path.strip_prefix("/plugins/").and_then(|rest| {
        let (id, rel) = rest.split_once('/').unwrap_or((rest, "index.html"));
        let dirs = studio.plugin_dirs.lock().unwrap().clone();
        studio_core::plugins::file(&dirs, id, rel)
    });
    let resp = match found {
        Some((body, mime)) => {
            let extra: String = studio_core::plugins::plugin_headers().iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
            let mut r = format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len()).into_bytes();
            r.extend(body);
            r
        }
        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    };
    // consume the request (only peeked so far): closing with unread bytes would reset the connection
    let mut sink = vec![0u8; n];
    let _ = stream.read_exact(&mut sink).await;
    let _ = stream.write_all(&resp).await;
    let _ = stream.shutdown().await;
}

async fn session(studio: Arc<Studio>, ws: tokio_tungstenite::WebSocketStream<TcpStream>) {
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let mut events = studio.events();
    let etx = tx.clone();
    let fwd = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(e) => { if etx.send(json!({ "event": e })).is_err() { break } }
                // events were dropped (an online/offline or update among them, perhaps): the page reads again
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => { if etx.send(json!({ "event": studio_core::Event::Resync })).is_err() { break } }
                Err(_) => break,
            }
        }
    });
    let writer = tokio::spawn(async move {
        while let Some(v) = rx.recv().await {
            if sink.send(Message::text(v.to_string())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(t) = msg else { continue };
        let Ok(req) = serde_json::from_str::<Value>(&t) else { continue };
        let (s, tx) = (studio.clone(), tx.clone());
        tokio::spawn(async move {
            let id = req["id"].clone();
            let cmd = req["cmd"].as_str().unwrap_or("").to_string();
            let r = s.dispatch(&cmd, req["args"].clone()).await;
            let _ = tx.send(match r {
                Ok(v) => json!({ "id": id, "ok": true, "result": v }),
                Err(e) => json!({ "id": id, "ok": false, "error": e }),
            });
        });
    }
    fwd.abort();
    writer.abort();
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_websocket_needs_the_token() {
        let t = random_token();
        assert_eq!(t.len(), 32);
        assert_ne!(t, random_token());
        assert!(token_ok(&format!("/?token={t}"), &t));
        assert!(token_ok(&format!("/?x=1&token={t}"), &t));
        assert!(!token_ok("/", &t));
        assert!(!token_ok("/?token=", &t));
        assert!(!token_ok(&format!("/?token={}", &t[..31]), &t));
        assert!(!token_ok(&format!("/?token={}0", &t[..31]), &t) || t.ends_with('0'));
    }
}
