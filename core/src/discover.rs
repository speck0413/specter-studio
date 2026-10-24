//! Finding boards: UDP broadcast on port 47800 (also unicast to listed addresses), mDNS
//! `_proptroller._tcp`, and probing a typed address (`GET /api/v1/info`).

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

pub const DISCOVERY_PORT: u16 = 47800;
pub const BOARD_AP: &str = "http://192.168.4.1";

/// Normalises what a person types ("192.168.1.5", "door.local:8080", "http://x/") to `http://host:port`.
pub fn normalise(addr: &str) -> String {
    let a = addr.trim().trim_end_matches('/');
    let a = a.strip_prefix("http://").unwrap_or(a);
    format!("http://{a}")
}

pub async fn probe(base: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().map_err(|e| e.to_string())?;
    let r = client.get(format!("{}/api/v1/info", normalise(base))).send().await.map_err(|_| format!("no board answers at {base}"))?;
    r.json::<Value>().await.map_err(|_| format!("{base} answered, but it is not a Proptroller"))
}

fn udp(timeout: Duration, unicast: &[SocketAddr]) -> Vec<Value> {
    let mut found = vec![];
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return found };
    let _ = sock.set_broadcast(true);
    let msg = br#"{"proptroller":"discover","v":1}"#;
    let _ = sock.send_to(msg, ("255.255.255.255", DISCOVERY_PORT));
    for a in unicast {
        let _ = sock.send_to(msg, a);
    }
    let end = Instant::now() + timeout;
    let mut buf = [0u8; 2048];
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        let _ = sock.set_read_timeout(Some(left.max(Duration::from_millis(1))));
        let Ok((n, from)) = sock.recv_from(&mut buf) else { break };
        let Ok(v) = serde_json::from_slice::<Value>(&buf[..n]) else { continue };
        if v["proptroller"] != "announce" {
            continue;
        }
        let port = v["port"].as_u64().unwrap_or(80);
        found.push(json!({
            "id": v["id"], "name": v["name"], "fw": v["fw"], "fw_version": v["fw_version"], "mcu": v["mcu"],
            "board": crate::fleet::board_of(&v),
            "address": format!("http://{}:{}", from.ip(), port), "via": "udp" }));
    }
    found
}

fn mdns(timeout: Duration) -> Vec<Value> {
    let mut found = vec![];
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return found };
    let Ok(rx) = daemon.browse("_proptroller._tcp.local.") else { return found };
    let end = Instant::now() + timeout;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let Some(ip) = info.get_addresses_v4().into_iter().next().copied() else { continue };
                let txt = |k: &str| info.get_property_val_str(k).unwrap_or("").to_string();
                found.push(json!({
                    "id": txt("id"), "name": txt("name"), "fw": txt("fw"), "fw_version": txt("fwv"), "mcu": txt("mcu"),
                    "board": if txt("board").is_empty() { crate::fleet::DEFAULT_BOARD.to_string() } else { txt("board") },
                    "address": format!("http://{}:{}", ip, info.get_port()), "via": "mdns" }));
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    found
}

/// Every board that answers within `timeout`, one entry per id (UDP wins over mDNS: it carries the address
/// the board answered from).
pub async fn discover(timeout: Duration, unicast: Vec<SocketAddr>, use_mdns: bool) -> Vec<Value> {
    let u = tokio::task::spawn_blocking(move || udp(timeout, &unicast));
    let m = tokio::task::spawn_blocking(move || if use_mdns { mdns(timeout) } else { vec![] });
    let mut by_id = BTreeMap::new();
    for v in m.await.unwrap_or_default().into_iter().chain(u.await.unwrap_or_default()) {
        by_id.insert(v["id"].as_str().unwrap_or("").to_string(), v);
    }
    by_id.into_values().collect()
}
