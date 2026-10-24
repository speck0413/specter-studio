//! What device adapters (extensions that bring another device protocol, docs/DESIGN.md "Device adapters") get
//! from the core besides MQTT: HTTP requests to devices on the local network only. A plugin frame cannot make
//! them itself: every plugin page is served with a CSP that has `connect-src 'none'` (plugins.rs `PLUGIN_CSP`),
//! and through Studio it must not reach the internet or this computer's other services.

use serde_json::{json, Value};
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

/// Addresses an adapter may reach: private (10/8, 172.16/12, 192.168/16, fc00::/7) and link-local. Never this
/// computer's loopback (its other services); practice boards on it are reached through `local_ports`.
pub fn allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_link_local(),
        IpAddr::V6(v) => (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// The most of an answer an adapter gets (a device's page or JSON, never a download).
pub const MAX_BODY: usize = 1024 * 1024;

/// `{url, method?, body?, content_type?}` -> `{status, body}`; only http:// to an allowed address, or to this
/// computer on one of `local_ports` (the practice boards Studio runs). The name is resolved once and the request
/// goes to that address (a DNS answer that changes in between cannot point it at this computer), and the answer
/// is cut off at [`MAX_BODY`].
pub async fn http_request(a: &Value, local_ports: &[u16]) -> Result<Value, String> {
    let url = a["url"].as_str().ok_or("missing \"url\"")?;
    let rest = url.strip_prefix("http://").ok_or("only http:// addresses on the local network")?;
    let host = rest.split('/').next().unwrap_or("");
    let with_port = if host.contains(':') { host.to_string() } else { format!("{host}:80") };
    let addrs: Vec<std::net::SocketAddr> = tokio::task::spawn_blocking(move || with_port.to_socket_addrs().map(|i| i.collect()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| format!("{host} is not on this network"))?;
    let ok = |s: &std::net::SocketAddr| allowed(s.ip()) || (s.ip().is_loopback() && local_ports.contains(&s.port()));
    if addrs.is_empty() || !addrs.iter().all(ok) {
        return Err(format!("{host} is not a device on the local network"));
    }
    // the request goes to the address checked above, not to whatever the name resolves to a moment later
    let name = host.rsplit_once(':').map(|h| h.0).unwrap_or(host).trim_start_matches('[').trim_end_matches(']').to_string();
    let mut cb = reqwest::Client::builder().timeout(Duration::from_secs(5)).redirect(reqwest::redirect::Policy::none());
    if name.parse::<IpAddr>().is_err() {
        cb = cb.resolve(&name, addrs[0]);
    }
    let client = cb.build().map_err(|e| e.to_string())?;
    let method = a["method"].as_str().unwrap_or("GET").to_uppercase();
    let mut req = client.request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "bad method")?, url);
    if let Some(b) = a["body"].as_str() {
        req = req.header("Content-Type", a["content_type"].as_str().unwrap_or("application/json")).body(b.to_string());
    }
    let mut r = req.send().await.map_err(|e| format!("{host} did not answer: {e}"))?;
    let status = r.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|e| format!("{host} stopped answering: {e}"))? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err(format!("{host} sent more than {} KB: too much for an extension", MAX_BODY / 1024));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok(json!({ "status": status, "body": body }))
}
