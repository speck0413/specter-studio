//! Studio as the on-site fleet server over MQTT (PROTOCOL.md "MQTT").
//!
//! * An embedded broker (rumqttd): boards set `mqtt_broker` to this computer and report to it; Studio watches
//!   every board's `online`, `state` and `status/*`, passes its `event` messages on to the UI (the Dashboard's
//!   feed: runs, notices, logs) and can send it requests (`<p>/rpc`, answer on `<p>/rpc/reply`).
//! * "Connect to another MQTT server": a bridge to an upstream broker (TLS optional, user and password, a topic
//!   prefix, topic filters, out / in / both ways), QoS 1. A message that came in over the bridge is never sent back
//!   out, and one Studio sent up is never taken back in ([`EchoGuard`]). Which topics are retained follows the protocol (`online`, `state`,
//!   `config/*`, `status/*`): they are published retained upstream, so the far side always has each board's
//!   latest state and its online / offline (the board's last will arrives like any other `online`). While the
//!   upstream is away only the latest retained message per topic is kept (bounded), never a growing queue;
//!   reconnects back off from [`BRIDGE_RETRY_FIRST`] to [`BRIDGE_RETRY_MAX`] without holding anything up, and the
//!   status says "connected", "retrying in N s" and the last error in plain words. Requests to boards from
//!   upstream (`rpc`, `config/set`, `control`, `cue`, `script/set`, ...) are refused unless explicitly allowed
//!   (the board checks its page password as always).
//! * Automation rules ([`crate::automation`]) see every message on the broker.

use crate::Event;
use rumqttc::{AsyncClient, LastWill, MqttOptions, QoS, Transport};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, oneshot};

/// Topics the protocol publishes retained.
pub fn is_retained(topic: &str) -> bool {
    let parts: Vec<&str> = topic.split('/').collect();
    if parts.len() < 3 || parts[1] == "broadcast" {
        return false;
    }
    matches!(parts[2], "online" | "state") && parts.len() == 3 || (matches!(parts[2], "config" | "status") && parts.len() == 4 && parts[3] != "get")
}

/// Starts a broker on `port` (all interfaces) and returns its local link.
pub fn start_broker(port: u16, link_name: &str) -> Result<(rumqttd::local::LinkTx, rumqttd::local::LinkRx), String> {
    start_broker_with(port, link_name, &BrokerOptions::default())
}

/// Who may use Studio's broker. Proptroller boards speak MQTT without a user name (PROTOCOL.md "MQTT"), so a
/// user and password lock them out: they are for networks where only other devices report here.
#[derive(Clone, Debug, Default)]
pub struct BrokerOptions {
    /// the address to listen on (`0.0.0.0`, every network, when empty); `127.0.0.1` keeps it to this computer
    pub bind: Option<String>,
    /// a user name and password every client must give
    pub login: Option<(String, String)>,
}

/// Starts a broker on `port` with `o` and returns its local link (Studio's own link needs no login).
pub fn start_broker_with(port: u16, link_name: &str, o: &BrokerOptions) -> Result<(rumqttd::local::LinkTx, rumqttd::local::LinkRx), String> {
    let mut conn = json!({ "connection_timeout_ms": 60000, "max_payload_size": 262144, "max_inflight_count": 200, "dynamic_filters": true });
    if let Some((u, p)) = &o.login {
        conn["auth"] = json!({ u.clone(): p.clone() });
    }
    let bind = o.bind.clone().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "0.0.0.0".into());
    let ip: std::net::IpAddr = bind.parse().map_err(|_| format!("{bind} is not an address of this computer"))?;
    let cfg = json!({
        "id": 0,
        "router": { "id": 0, "max_connections": 1000, "max_outgoing_packet_count": 200, "max_segment_size": 10485760, "max_segment_count": 10 },
        "v4": { "1": { "name": "v4-1", "listen": std::net::SocketAddr::new(ip, port).to_string(), "next_connection_delay_ms": 1, "connections": conn } },
    });
    let config: rumqttd::Config = serde_json::from_value(cfg).map_err(|e| e.to_string())?;
    // a port already taken fails here, in plain words, instead of inside the broker's thread
    std::net::TcpListener::bind((ip, port)).map_err(|e| format!("port {port} is in use: {e}"))?;
    let mut broker = rumqttd::Broker::new(config);
    let link = broker.link(link_name).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = broker.start();
    });
    Ok(link)
}

/// The latest retained message per topic while the upstream is away; anything else is dropped (and counted).
#[derive(Default)]
pub struct OfflineBuffer {
    pub retained: BTreeMap<String, Vec<u8>>,
    pub dropped: u64,
}

impl OfflineBuffer {
    pub const MAX_TOPICS: usize = 10_000;
    pub fn keep(&mut self, topic: &str, payload: &[u8]) {
        if is_retained(topic) && (self.retained.len() < Self::MAX_TOPICS || self.retained.contains_key(topic)) {
            self.retained.insert(topic.to_string(), payload.to_vec());
        } else {
            self.dropped += 1;
        }
    }
}

/// Which way the bridge passes messages.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// Studio -> the other server
    #[default]
    Out,
    /// the other server -> Studio
    In,
    Both,
}

impl Direction {
    pub fn sends(self) -> bool {
        self != Direction::In
    }
    pub fn receives(self) -> bool {
        self != Direction::Out
    }
}

/// The wait before the bridge connects again after losing the other server; it doubles up to [`BRIDGE_RETRY_MAX`].
pub const BRIDGE_RETRY_FIRST: Duration = Duration::from_secs(1);
pub const BRIDGE_RETRY_MAX: Duration = Duration::from_secs(30);
pub const BRIDGE_KEEP_ALIVE: Duration = Duration::from_secs(15);
/// How long a message the bridge passed on is remembered, to recognise it when it comes straight back.
pub const ECHO_TTL: Duration = Duration::from_secs(10);
/// The most messages and topics [`EchoGuard`] remembers.
pub const ECHO_MAX: usize = 10_000;

fn all_topics() -> Vec<String> {
    vec!["#".into()]
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct BridgeConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub tls: bool,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// prepended to every topic upstream, e.g. "site-a/" (empty: the same topics)
    #[serde(default)]
    pub prefix: String,
    /// requests to boards from upstream reach them (off unless the person turns it on)
    #[serde(default)]
    pub accept_commands: bool,
    #[serde(default)]
    pub direction: Direction,
    /// which of Studio's topics (local names, without the prefix) are passed on; `#` is all
    #[serde(default = "all_topics")]
    pub filters: Vec<String>,
}

/// A request to a board (PROTOCOL.md "MQTT", the "in" topics): never taken from upstream unless allowed.
pub fn is_board_request(topic: &str) -> bool {
    let segs: Vec<&str> = topic.split('/').collect();
    if segs.len() >= 2 && segs[segs.len() - 2] == "broadcast" && segs[segs.len() - 1] == "getName" {
        return true;
    }
    match split_board_topic(topic) {
        Some((_, _, rest)) => rest == "rpc" || rest == "cue" || rest == "script/set" || rest == "script/check" || rest.starts_with("config/set/") || rest.starts_with("control/") || rest.starts_with("status/get"),
        None => segs.last().is_some_and(|l| *l == "rpc" || *l == "cue"),
    }
}

/// `<p>/<name>/rpc`: the one request an older "let that server send requests" passed down.
fn is_rpc(topic: &str) -> bool {
    let parts: Vec<&str> = topic.split('/').collect();
    parts.len() == 3 && parts[2] == "rpc" && parts[1] != "broadcast"
}

fn hash(b: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    b.hash(&mut h);
    h.finish()
}

type Seen = HashMap<(String, u64), (u32, Instant)>;

/// Loop prevention for the bridge in both directions.
/// * A message the bridge put on Studio's server comes back to Studio's own subscription: it is not sent up.
/// * A message Studio sent up comes back from the other server's subscription: live copies are recognised for
///   [`ECHO_TTL`]; retained copies come back again on every reconnect, so the last payload sent per topic is
///   kept (bounded) and a retained copy equal to it is not taken in.
#[derive(Default)]
pub struct EchoGuard {
    injected: Seen,
    injected_retained: Seen,
    sent_live: Seen,
    sent_last: HashMap<String, u64>,
    order: VecDeque<String>,
}

fn note(m: &mut Seen, topic: &str, payload: &[u8]) {
    let now = Instant::now();
    if m.len() >= ECHO_MAX {
        m.retain(|_, v| v.1 > now);
    }
    if m.len() >= ECHO_MAX {
        return;
    }
    let e = m.entry((topic.to_string(), hash(payload))).or_insert((0, now));
    e.0 += 1;
    e.1 = now + ECHO_TTL;
}

fn take(m: &mut Seen, topic: &str, payload: &[u8]) -> bool {
    let k = (topic.to_string(), hash(payload));
    match m.get_mut(&k) {
        Some(e) if e.1 > Instant::now() => {
            e.0 -= 1;
            if e.0 == 0 {
                m.remove(&k);
            }
            true
        }
        Some(_) => {
            m.remove(&k);
            false
        }
        None => false,
    }
}

impl EchoGuard {
    /// The bridge publishes `topic` on Studio's server (`retained`: the far side's stored copy, not news).
    pub fn note_injected(&mut self, topic: &str, payload: &[u8], retained: bool) {
        note(if retained { &mut self.injected_retained } else { &mut self.injected }, topic, payload);
    }
    /// Studio's server delivered `topic`: `Some(retained)` when it is one the bridge put there (never sent back
    /// up; a retained copy, which the far side sends again on every reconnect, does not fire automation rules).
    pub fn came_from_bridge(&mut self, topic: &str, payload: &[u8]) -> Option<bool> {
        if take(&mut self.injected, topic, payload) {
            Some(false)
        } else if take(&mut self.injected_retained, topic, payload) {
            Some(true)
        } else {
            None
        }
    }
    /// The bridge sends `remote_topic` up.
    pub fn note_sent(&mut self, remote_topic: &str, payload: &[u8]) {
        note(&mut self.sent_live, remote_topic, payload);
        if !self.sent_last.contains_key(remote_topic) {
            self.order.push_back(remote_topic.to_string());
            if self.order.len() > ECHO_MAX {
                if let Some(old) = self.order.pop_front() {
                    self.sent_last.remove(&old);
                }
            }
        }
        self.sent_last.insert(remote_topic.to_string(), hash(payload));
    }
    /// The other server delivered `remote_topic`: true when it is Studio's own message coming back.
    pub fn is_own(&mut self, remote_topic: &str, payload: &[u8], retained: bool) -> bool {
        if retained {
            self.sent_last.get(remote_topic) == Some(&hash(payload))
        } else {
            take(&mut self.sent_live, remote_topic, payload)
        }
    }
}

/// Why the bridge is not connected, in plain words.
pub fn plain_bridge_error(e: &rumqttc::ConnectionError, host: &str, port: u16) -> String {
    use rumqttc::{ConnectReturnCode as C, ConnectionError as E};
    match e {
        E::Io(io) => {
            let text = io.to_string();
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => format!("Nothing answered at {host} port {port}. Is the server running, and is the port right?"),
                std::io::ErrorKind::TimedOut => format!("{host} did not answer. Check the address, the network and any firewall."),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof => format!("{host} closed the connection."),
                _ if text.contains("lookup") || text.contains("resolve") || text.contains("not known") || text.contains("No such host") => format!("Could not find a server called {host}. Check the address."),
                _ => format!("Network problem reaching {host}: {text}"),
            }
        }
        E::ConnectionRefused(C::BadUserNamePassword) | E::ConnectionRefused(C::NotAuthorized) => format!("{host} did not accept the user name or password."),
        E::ConnectionRefused(C::ServiceUnavailable) => format!("{host} is not taking connections right now."),
        E::ConnectionRefused(C::BadClientId) => format!("{host} refused Studio's client name."),
        E::ConnectionRefused(C::RefusedProtocolVersion) => format!("{host} does not speak MQTT 3.1.1."),
        E::Tls(t) => format!("The encrypted connection (TLS) to {host} failed ({t}). Is TLS right for this port (often 8883 with TLS, 1883 without)?"),
        E::NetworkTimeout | E::FlushTimeout => format!("{host} did not answer in time."),
        E::MqttState(s) => format!("The connection to {host} dropped ({s})."),
        other => format!("The connection to {host} failed: {other}"),
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Bridge {
    tx: mpsc::UnboundedSender<(String, Vec<u8>)>,
    status: Arc<Mutex<Value>>,
    task: tokio::task::JoinHandle<()>,
}

pub struct Fleet {
    pub port: u16,
    link_tx: Mutex<rumqttd::local::LinkTx>,
    boards: Arc<Mutex<BTreeMap<String, Value>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
    bridge: Arc<Mutex<Option<Bridge>>>,
    /// The topic filters the UI watches (`mqtt_watch`, counted): only those are passed on as `Event::Mqtt`.
    /// None until the first watch: then every message is passed on (the UI from before watches existed).
    watches: Mutex<Option<HashMap<String, usize>>>,
    /// loop prevention for the bridge (bounded; kept when the bridge starts again)
    echo: Arc<Mutex<EchoGuard>>,
    /// automation rules: every message is offered to them (never waits)
    automation: Mutex<Option<Arc<crate::automation::Engine>>>,
}

impl Fleet {
    /// The embedded broker on `port`; Studio watches every board that reports to it.
    pub fn start(port: u16, events: broadcast::Sender<Event>) -> Result<Arc<Fleet>, String> {
        Self::start_with(port, &BrokerOptions::default(), events)
    }

    /// As [`Fleet::start`], with who may use the broker.
    pub fn start_with(port: u16, o: &BrokerOptions, events: broadcast::Sender<Event>) -> Result<Arc<Fleet>, String> {
        let (mut link_tx, mut link_rx) = start_broker_with(port, "specter-studio", o)?;
        link_tx.subscribe("#").map_err(|e| e.to_string())?;
        let fleet = Arc::new(Fleet {
            port,
            link_tx: Mutex::new(link_tx),
            boards: Arc::new(Mutex::new(BTreeMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            bridge: Arc::new(Mutex::new(None)),
            watches: Mutex::new(None),
            echo: Arc::new(Mutex::new(EchoGuard::default())),
            automation: Mutex::new(None),
        });
        let f = fleet.clone();
        std::thread::spawn(move || loop {
            match link_rx.recv() {
                Ok(Some(rumqttd::Notification::Forward(fw))) => {
                    let topic = String::from_utf8_lossy(&fw.publish.topic).to_string();
                    f.seen(&topic, &fw.publish.payload, &events);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        });
        Ok(fleet)
    }

    /// Automation rules see every message from now on.
    pub fn set_automation(&self, engine: Arc<crate::automation::Engine>) {
        *self.automation.lock().unwrap() = Some(engine);
    }

    fn seen(&self, topic: &str, payload: &[u8], events: &broadcast::Sender<Event>) {
        let mut from_bridge = None;
        if let Some(b) = self.bridge.lock().unwrap().as_ref() {
            // a message the bridge brought in never goes back out
            from_bridge = self.echo.lock().unwrap().came_from_bridge(topic, payload);
            if from_bridge.is_none() {
                let _ = b.tx.send((topic.to_string(), payload.to_vec()));
            }
        }
        // rules see news only: not the far side's retained copies, which come again on every reconnect
        let engine = self.automation.lock().unwrap().clone();
        if let (Some(e), false) = (engine, from_bridge == Some(true)) {
            e.offer(topic, payload);
        }
        // every message, for device adapters (the app passes on only the topics an adapter declared)
        // live messages are never "retained" (MQTT's rule for live delivery); cached ones come from retained_matching
        let watched = match &*self.watches.lock().unwrap() {
            None => true,
            Some(w) => w.keys().any(|f| topic_matches(f, topic)),
        };
        if watched {
            let _ = events.send(Event::Mqtt { topic: topic.to_string(), payload: String::from_utf8_lossy(payload).to_string(), retained: false });
        }
        let Some((prefix, name, rest)) = split_board_topic(topic) else { return };
        let (prefix, name, rest) = (prefix.as_str(), name.as_str(), rest.as_str());
        let text = String::from_utf8_lossy(payload).to_string();
        if rest == "rpc/reply" {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(tx) = v["id"].as_u64().and_then(|id| self.pending.lock().unwrap().remove(&id)) {
                    let _ = tx.send(v);
                }
            }
            return;
        }
        let key = format!("{prefix}/{name}");
        // the board's events (runs, notices, logs, settings changed): passed on with the board they came from, for
        // the Dashboard's feed; `event/run` repeats a run that is on `event` too, so only `event` is passed on
        if rest == "event" {
            if let Ok(msg) = serde_json::from_str::<Value>(&text) {
                if msg.is_object() {
                    let _ = events.send(Event::FleetEvent { key: key.clone(), name: name.to_string(), msg });
                }
            }
            return;
        }
        let mut boards = self.boards.lock().unwrap();
        let b = boards.entry(key.clone()).or_insert_with(|| json!({ "key": key, "prefix": prefix, "name": name, "online": false, "status": {} }));
        let changed = match rest {
            "online" => { b["online"] = json!(text == "true"); true }
            "state" => { b["state"] = serde_json::from_str(&text).unwrap_or(Value::Null); true }
            r if r.starts_with("status/") && !r.starts_with("status/get/") => { b["status"][&r[7..]] = serde_json::from_str(&text).unwrap_or(json!(text)); true }
            _ => false,
        };
        if changed {
            let _ = events.send(Event::Fleet { board: b.clone() });
        }
    }

    /// From now on `filter` is passed on to the UI (counted: every watch needs its own `unwatch`).
    pub fn watch(&self, filter: &str) {
        *self.watches.lock().unwrap().get_or_insert_with(HashMap::new).entry(filter.to_string()).or_insert(0) += 1;
    }

    pub fn unwatch(&self, filter: &str) {
        if let Some(w) = self.watches.lock().unwrap().as_mut() {
            if let Some(n) = w.get_mut(filter) {
                *n -= 1;
                if *n == 0 {
                    w.remove(filter);
                }
            }
        }
    }

    /// Studio is closing: boards it relayed upstream are reported offline there (their last wills die with this
    /// broker), so the far side never shows a board online for good.
    pub fn shutdown(&self) {
        if let Some(b) = self.bridge.lock().unwrap().as_ref() {
            for v in self.boards.lock().unwrap().values().filter(|v| v["online"] == true) {
                let topic = format!("{}/{}/online", v["prefix"].as_str().unwrap_or(""), v["name"].as_str().unwrap_or(""));
                let _ = b.tx.send((topic, b"false".to_vec()));
            }
        }
    }

    /// Publishes on the broker (device adapters; the app checks the topic against the adapter's allowlist).
    pub fn publish(&self, topic: &str, payload: &str) -> Result<(), String> {
        self.link_tx.lock().unwrap().publish(topic.to_string(), payload.as_bytes().to_vec()).map(|_| ()).map_err(|e| e.to_string())
    }

    /// The broker's retained messages for `filter`, as a new subscriber gets them (MQTT marks exactly those
    /// retained): a short-lived client subscribes and collects them.
    pub async fn retained_matching(&self, filter: &str) -> Vec<Value> {
        let id = format!("specter-retained-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (client, mut el) = AsyncClient::new(MqttOptions::new(id, "127.0.0.1", self.port), 100);
        let _ = client.subscribe(filter, QoS::AtMostOnce).await;
        let mut out = vec![];
        let mut subscribed = false;
        loop {
            match tokio::time::timeout(Duration::from_millis(if subscribed { 300 } else { 3000 }), el.poll()).await {
                Ok(Ok(rumqttc::Event::Incoming(rumqttc::Packet::SubAck(_)))) => subscribed = true,
                Ok(Ok(rumqttc::Event::Incoming(rumqttc::Packet::Publish(p)))) if p.retain => {
                    out.push(json!({ "topic": p.topic, "payload": String::from_utf8_lossy(&p.payload), "retained": true }));
                }
                Ok(Ok(_)) => {}
                _ => break,
            }
        }
        let _ = client.disconnect().await;
        out
    }

    pub fn boards(&self) -> Vec<Value> {
        self.boards.lock().unwrap().values().cloned().collect()
    }

    /// A request to a board through the broker (`<prefix>/<name>/rpc`), its answer from `rpc/reply`.
    pub async fn rpc(&self, prefix: &str, name: &str, mut req: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1_000_000;
        req["v"] = json!(1);
        req["id"] = json!(id);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.link_tx.lock().unwrap().publish(format!("{prefix}/{name}/rpc"), req.to_string().into_bytes()).map_err(|e| e.to_string())?;
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{name} did not answer through the MQTT server"))
            }
        }
    }

    /// Starts (or replaces) the bridge to an upstream broker; refused in plain words when a topic filter is wrong.
    pub fn bridge(self: &Arc<Self>, mut cfg: BridgeConfig) -> Result<(), String> {
        cfg.filters.retain(|f| !f.trim().is_empty());
        if cfg.filters.is_empty() {
            cfg.filters = all_topics();
        }
        for f in &cfg.filters {
            crate::automation::pattern::check_filter(f.trim())?;
        }
        if cfg.host.trim().is_empty() {
            return Err("Type the other server's address.".into());
        }
        // the echo guard is kept: retained copies of what Studio sent come back after every (re)connect
        self.stop_bridge();
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
        let base = json!({ "host": cfg.host, "port": cfg.port, "prefix": cfg.prefix, "accept_commands": cfg.accept_commands, "direction": cfg.direction, "filters": cfg.filters, "tls": cfg.tls });
        let mut first = base.clone();
        first.as_object_mut().unwrap().extend(json!({ "connected": false, "state": "connecting", "buffered": 0, "dropped": 0, "sent": 0, "received": 0, "refused": 0 }).as_object().unwrap().clone());
        let status = Arc::new(Mutex::new(first));
        let me = self.clone();
        let st = status.clone();
        let task = tokio::spawn(async move {
            let set = |k: &str, v: Value| { st.lock().unwrap()[k] = v; };
            let bump = |k: &str| { let mut s = st.lock().unwrap(); let n = s[k].as_u64().unwrap_or(0) + 1; s[k] = json!(n); };
            let id = format!("specter-studio-{}", std::process::id());
            let mut o = MqttOptions::new(id, cfg.host.clone(), cfg.port);
            o.set_keep_alive(BRIDGE_KEEP_ALIVE);
            o.set_last_will(LastWill::new(format!("{}specter-studio/online", cfg.prefix), "false", QoS::AtLeastOnce, true));
            if let (Some(u), Some(p)) = (&cfg.username, &cfg.password) {
                o.set_credentials(u.clone(), p.clone());
            }
            if cfg.tls {
                o.set_transport(Transport::tls_with_default_config());
            }
            let (client, mut eventloop) = AsyncClient::new(o, 1000);
            let filters: Vec<String> = cfg.filters.iter().map(|f| f.trim().to_string()).collect();
            let wanted = |t: &str| filters.iter().any(|f| topic_matches(f, t));
            let mut connected = false;
            let mut buffer = OfflineBuffer::default();
            let mut backoff = BRIDGE_RETRY_FIRST;
            let mut retry_at: Option<tokio::time::Instant> = None;
            loop {
                tokio::select! {
                    msg = rx.recv() => {
                        let Some((topic, payload)) = msg else { break };
                        // requests stay local (and one passed down from upstream must not echo back up)
                        if !cfg.direction.sends() || topic.ends_with("/rpc") || !wanted(&topic) { continue }
                        if connected {
                            let remote = format!("{}{topic}", cfg.prefix);
                            me.echo.lock().unwrap().note_sent(&remote, &payload);
                            let _ = client.try_publish(remote, QoS::AtLeastOnce, is_retained(&topic), payload);
                            bump("sent");
                        } else {
                            buffer.keep(&topic, &payload);
                            set("buffered", json!(buffer.retained.len()));
                            set("dropped", json!(buffer.dropped));
                        }
                    }
                    _ = async { tokio::time::sleep_until(retry_at.unwrap()).await }, if retry_at.is_some() => {
                        retry_at = None;
                        set("state", json!("connecting"));
                    }
                    ev = eventloop.poll(), if retry_at.is_none() => match ev {
                        Ok(rumqttc::Event::Incoming(rumqttc::Packet::ConnAck(_))) => {
                            connected = true;
                            backoff = BRIDGE_RETRY_FIRST;
                            let online = format!("{}specter-studio/online", cfg.prefix);
                            me.echo.lock().unwrap().note_sent(&online, b"true");
                            let _ = client.try_publish(online, QoS::AtLeastOnce, true, "true");
                            for (t, p) in std::mem::take(&mut buffer.retained) {
                                if cfg.direction.sends() && wanted(&t) {
                                    let remote = format!("{}{t}", cfg.prefix);
                                    me.echo.lock().unwrap().note_sent(&remote, &p);
                                    let _ = client.publish(remote, QoS::AtLeastOnce, true, p).await;
                                }
                            }
                            if cfg.direction.receives() {
                                for f in &filters {
                                    let _ = client.try_subscribe(format!("{}{f}", cfg.prefix), QoS::AtLeastOnce);
                                }
                            } else if cfg.accept_commands {
                                let _ = client.try_subscribe(format!("{}+/+/rpc", cfg.prefix), QoS::AtLeastOnce);
                            }
                            let mut s = st.lock().unwrap();
                            s["connected"] = json!(true);
                            s["state"] = json!("connected");
                            s["buffered"] = json!(0);
                            s["dropped"] = json!(buffer.dropped);
                            s["since_ms"] = json!(unix_ms());
                            s.as_object_mut().unwrap().remove("retry_at_ms");
                        }
                        Ok(rumqttc::Event::Incoming(rumqttc::Packet::Publish(p))) => {
                            let Some(local) = p.topic.strip_prefix(&cfg.prefix).map(String::from) else { continue };
                            // Studio's own message coming back from the other server
                            if me.echo.lock().unwrap().is_own(&p.topic, &p.payload, p.retain) { continue }
                            let request = is_board_request(&local);
                            let pass = if request {
                                cfg.accept_commands && (cfg.direction.receives() && wanted(&local) || is_rpc(&local))
                            } else {
                                cfg.direction.receives() && wanted(&local)
                            };
                            if !pass {
                                if request { bump("refused"); }
                                continue;
                            }
                            me.echo.lock().unwrap().note_injected(&local, &p.payload, p.retain);
                            let _ = me.link_tx.lock().unwrap().publish(local, p.payload.to_vec());
                            bump("received");
                        }
                        Ok(_) => {}
                        Err(e) => {
                            connected = false;
                            let words = plain_bridge_error(&e, &cfg.host, cfg.port);
                            retry_at = Some(tokio::time::Instant::now() + backoff);
                            {
                                let mut s = st.lock().unwrap();
                                s["connected"] = json!(false);
                                s["state"] = json!("retrying");
                                s["last_error"] = json!(words);
                                s["retry_at_ms"] = json!(unix_ms() + backoff.as_millis() as u64);
                            }
                            backoff = (backoff * 2).min(BRIDGE_RETRY_MAX);
                        }
                    },
                }
            }
        });
        *self.bridge.lock().unwrap() = Some(Bridge { tx, status, task });
        Ok(())
    }

    pub fn stop_bridge(&self) {
        if let Some(b) = self.bridge.lock().unwrap().take() {
            b.task.abort();
        }
    }

    /// The bridge's status: `state` connecting / connected / retrying, `retry_in_s` while retrying, `last_error`
    /// in plain words, and counters (sent, received, refused requests, buffered and dropped while away).
    pub fn bridge_status(&self) -> Value {
        let mut v = self.bridge.lock().unwrap().as_ref().map(|b| b.status.lock().unwrap().clone()).unwrap_or(json!(null));
        if let Some(at) = v["retry_at_ms"].as_u64() {
            v["retry_in_s"] = json!(at.saturating_sub(unix_ms()).div_ceil(1000));
        }
        v
    }
}

/// MQTT filter match (`+` one level, `#` the rest).
/// `(prefix, name, rest)` of a board's topic: the rest starts at the first protocol word (`online`, `state`,
/// `event`, `status`, `config`, `rpc`, ...) after at least a prefix and a name, so a `topic_prefix` with `/`
/// (`haunt/2026`) is read whole. None for the broadcast topics and anything else.
pub fn split_board_topic(topic: &str) -> Option<(String, String, String)> {
    const WORDS: [&str; 8] = ["online", "state", "event", "status", "config", "rpc", "script", "control"];
    let segs: Vec<&str> = topic.split('/').collect();
    let i = (2..segs.len()).find(|&i| WORDS.contains(&segs[i]))?;
    let (prefix, name) = (segs[..i - 1].join("/"), segs[i - 1].to_string());
    if name == "broadcast" || segs[1] == "broadcast" {
        return None;
    }
    Some((prefix, name, segs[i..].join("/")))
}

pub fn topic_matches(filter: &str, topic: &str) -> bool {
    let f: Vec<&str> = filter.split('/').collect();
    let t: Vec<&str> = topic.split('/').collect();
    for (i, p) in f.iter().enumerate() {
        if *p == "#" {
            return true;
        }
        if i >= t.len() || (*p != "+" && *p != t[i]) {
            return false;
        }
    }
    f.len() == t.len()
}
