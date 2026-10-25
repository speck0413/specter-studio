//! Studio as the fleet server over MQTT, with a fake board (an MQTT client speaking the protocol's topics) on
//! Studio's embedded broker and a second broker standing in for "another server".

use rumqttc::{AsyncClient, Event as MqEvent, LastWill, MqttOptions, Packet, QoS};
use serde_json::{json, Value};
use std::time::Duration;
use studio_core::{mqtt, Event, Studio};


/// Windows has no practice-board simulator yet (the firmware's sim builds on Linux and macOS): a test that needs
/// it is skipped there while none is found, and runs as soon as one is (PROPTROLLER_SIM or a built `sim`).
fn no_simulator_here() -> bool {
    let skip = cfg!(windows) && studio_core::sim::find_program().is_none();
    if skip {
        eprintln!("no simulator on this Windows computer: skipped");
    }
    skip
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// A client on `port`; its event loop runs in a task (abort it to "pull the plug": no disconnect, so the
/// broker publishes the last will).
fn client(id: &str, port: u16, will: Option<LastWill>) -> (AsyncClient, tokio::sync::mpsc::UnboundedReceiver<(String, Vec<u8>)>, tokio::task::JoinHandle<()>) {
    let mut o = MqttOptions::new(id, "127.0.0.1", port);
    o.set_keep_alive(Duration::from_secs(5));
    if let Some(w) = will {
        o.set_last_will(w);
    }
    let (c, mut el) = AsyncClient::new(o, 100);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let h = tokio::spawn(async move {
        loop {
            match el.poll().await {
                Ok(MqEvent::Incoming(Packet::Publish(p))) => { let _ = tx.send((p.topic.clone(), p.payload.to_vec())); }
                Ok(_) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    });
    (c, rx, h)
}

/// Waits for a message on `topic` with `payload` (or any payload when None).
async fn expect(rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, Vec<u8>)>, topic: &str, payload: Option<&str>) -> Vec<u8> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some((t, p))) if t == topic && payload.is_none_or(|w| p == w.as_bytes()) => return p,
            Ok(Some(_)) => continue,
            _ => panic!("no {topic} = {payload:?}"),
        }
    }
}

#[test]
fn retained_topics_follow_the_protocol() {
    for t in ["proptroller/front-door/online", "proptroller/front-door/state", "acme/a1/status/runs_left", "proptroller/x/config/volume"] {
        assert!(mqtt::is_retained(t), "{t}");
    }
    for t in ["proptroller/front-door/event", "proptroller/x/rpc", "proptroller/x/rpc/reply", "proptroller/broadcast/name", "proptroller/x/status/get/a", "proptroller/x/config/set/volume"] {
        assert!(!mqtt::is_retained(t), "{t}");
    }
    let mut b = mqtt::OfflineBuffer::default();
    for i in 0..1000 {
        b.keep("proptroller/front-door/state", format!("{{\"n\":{i}}}").as_bytes());
        b.keep("proptroller/front-door/event", b"{}");
    }
    assert_eq!(b.retained.len(), 1, "only the latest state per topic");
    assert_eq!(b.retained["proptroller/front-door/state"], b"{\"n\":999}");
    assert_eq!(b.dropped, 1000);
}

#[tokio::test(flavor = "multi_thread")]
async fn fleet_server_bridge_and_commands() {
    let s = Studio::new();
    let (a_port, b_port) = (free_port(), free_port());
    let mut ev = s.events();
    s.dispatch("mqtt_start", json!({ "port": a_port })).await.unwrap();
    // "another server": a second broker
    let (_b_tx, _b_rx) = mqtt::start_broker(b_port, "far").unwrap();
    s.dispatch("bridge_start", json!({ "host": "127.0.0.1", "port": b_port, "prefix": "haunt/" })).await.unwrap();

    // a board reporting to Studio, with its last will
    let will = LastWill::new("proptroller/front-door/online", "false", QoS::AtLeastOnce, true);
    let (board, mut board_rx, plug) = client("front-door", a_port, Some(will));
    board.subscribe("proptroller/front-door/rpc", QoS::AtLeastOnce).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    board.publish("proptroller/front-door/online", QoS::AtLeastOnce, true, "true").await.unwrap();
    board.publish("proptroller/front-door/state", QoS::AtLeastOnce, true, r#"{"v":1,"boot_id":"1a2b","mqtt_seq":3,"uptime_ms":1200,"outputs":[{"channel":"OUT1","level":1000}]}"#).await.unwrap();
    board.publish("proptroller/front-door/status/run_count", QoS::AtLeastOnce, true, "3").await.unwrap();

    // Studio sees it
    let mut seen = false;
    for _ in 0..50 {
        if let Ok(Ok(Event::Fleet { board })) = tokio::time::timeout(Duration::from_millis(200), ev.recv()).await {
            if board["name"] == "front-door" && board["online"] == true && board["state"]["outputs"][0]["level"] == 1000 { seen = true; break; }
        }
    }
    assert!(seen, "the fleet shows the board online with its state");
    let list = s.dispatch("mqtt_boards", json!({})).await.unwrap();
    assert_eq!(list[0]["status"]["run_count"], 3);

    // the far side: a client connecting later gets the retained state and online
    tokio::time::sleep(Duration::from_millis(800)).await;
    let (far, mut far_rx, _h) = client("watcher", b_port, None);
    far.subscribe("haunt/#", QoS::AtLeastOnce).await.unwrap();
    let mut got = std::collections::HashMap::new();
    while let Ok(Some((t, p))) = tokio::time::timeout(Duration::from_secs(2), far_rx.recv()).await {
        got.insert(t, p);
    }
    assert_eq!(got.get("haunt/proptroller/front-door/online").map(|v| v.as_slice()), Some(&b"true"[..]));
    assert_eq!(serde_json::from_slice::<Value>(&got["haunt/proptroller/front-door/state"]).unwrap()["uptime_ms"], 1200);
    assert_eq!(got.get("haunt/proptroller/front-door/status/run_count").map(|v| v.as_slice()), Some(&b"3"[..]));
    assert_eq!(got.get("haunt/specter-studio/online").map(|v| v.as_slice()), Some(&b"true"[..]));
    assert_eq!(s.dispatch("mqtt_status", json!({})).await.unwrap()["bridge"]["connected"], true);

    // a request from Studio through the broker; the fake board answers
    let b2 = board.clone();
    tokio::spawn(async move {
        while let Some((t, p)) = board_rx.recv().await {
            if t == "proptroller/front-door/rpc" {
                let req: Value = serde_json::from_slice(&p).unwrap();
                let _ = b2.publish("proptroller/front-door/rpc/reply", QoS::AtLeastOnce, false, json!({ "v": 1, "id": req["id"], "ok": true, "result": { "kind": "info", "name": "Front Door", "asked": req["op"] } }).to_string()).await;
            }
        }
    });
    let r = s.dispatch_dev("mqtt_rpc", json!({ "prefix": "proptroller", "name": "front-door", "req": { "op": "info" } })).await.unwrap();
    assert_eq!(r["result"]["name"], "Front Door");

    // requests from upstream are refused unless allowed: the board answers nothing it never got
    let (up, mut up_rx, _h2) = client("upstream-user", b_port, None);
    up.subscribe("haunt/proptroller/front-door/rpc/reply", QoS::AtLeastOnce).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    up.publish("haunt/proptroller/front-door/rpc", QoS::AtLeastOnce, false, r#"{"v":1,"id":77,"op":"state"}"#).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(1500), async {
        loop { if let Some((t, _)) = up_rx.recv().await { if t.ends_with("rpc/reply") { break } } }
    }).await.is_err(), "a request from upstream reached the board");
    // allowed: it reaches the board, and the answer goes back up
    s.dispatch("bridge_start", json!({ "host": "127.0.0.1", "port": b_port, "prefix": "haunt/", "accept_commands": true })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    up.publish("haunt/proptroller/front-door/rpc", QoS::AtLeastOnce, false, r#"{"v":1,"id":78,"op":"state"}"#).await.unwrap();
    let reply = expect(&mut up_rx, "haunt/proptroller/front-door/rpc/reply", None).await;
    assert_eq!(serde_json::from_slice::<Value>(&reply).unwrap()["id"], 78);

    // the board loses power: its last will says offline, here and on the far side
    plug.abort();
    let mut offline = false;
    for _ in 0..100 {
        if let Ok(Ok(Event::Fleet { board })) = tokio::time::timeout(Duration::from_millis(200), ev.recv()).await {
            if board["name"] == "front-door" && board["online"] == false { offline = true; break; }
        }
    }
    assert!(offline, "the last will arrived (keep-alive 5 s)");
    let (late, mut late_rx, _h3) = client("late-watcher", b_port, None);
    late.subscribe("haunt/proptroller/front-door/online", QoS::AtLeastOnce).await.unwrap();
    expect(&mut late_rx, "haunt/proptroller/front-door/online", Some("false")).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn adapters_get_mqtt_and_local_http_only() {
    if no_simulator_here() {
        return;
    }
    let s = Studio::new();
    let port = free_port();
    s.dispatch("mqtt_start", json!({ "port": port })).await.unwrap();
    let mut ev = s.events();
    s.dispatch("mqtt_publish", json!({ "topic": "demolamp/lamp1/set", "payload": "on" })).await.unwrap();
    let mut seen = false;
    for _ in 0..30 {
        if let Ok(Ok(Event::Mqtt { topic, payload, .. })) = tokio::time::timeout(Duration::from_millis(200), ev.recv()).await {
            if topic == "demolamp/lamp1/set" && payload == "on" { seen = true; break; }
        }
    }
    assert!(seen, "adapters see the messages on Studio's server");
    // retained messages are cached for later subscribers, flagged retained
    let (dev, _rx, _h) = client("lamp", port, None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    dev.publish("demolamp/lamp1/status", QoS::AtLeastOnce, true, r#"{"on":true}"#).await.unwrap();
    dev.publish("demolamp/lamp1/blip", QoS::AtLeastOnce, false, "x").await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let r = s.dispatch("mqtt_retained", json!({ "filter": "demolamp/#" })).await.unwrap();
    assert_eq!(r, json!([{ "topic": "demolamp/lamp1/status", "payload": "{\"on\":true}", "retained": true }]));
    assert!(mqtt::topic_matches("acme/+/status/#", "acme/a1/status/ready") && !mqtt::topic_matches("acme/+/status", "acme/a1/status/ready"));
    // HTTP only to the local network: a simulator on this computer yes, the internet no
    let key = s.dispatch("sim_start", json!({ "name": "Http Prop" })).await.unwrap()["key"].as_str().unwrap().to_string();
    let r = s.dispatch("http_request", json!({ "url": format!("{key}/api/v1/info") })).await.unwrap();
    assert_eq!(r["status"], 200);
    assert_eq!(serde_json::from_str::<Value>(r["body"].as_str().unwrap()).unwrap()["name"], "Http Prop");
    assert!(s.dispatch("http_request", json!({ "url": "http://93.184.216.34/" })).await.unwrap_err().contains("not a device on the local network"));
    assert!(s.dispatch("http_request", json!({ "url": "https://192.168.1.1/" })).await.is_err());
    assert!(studio_core::adapters::allowed("192.168.4.1".parse().unwrap()));
    assert!(!studio_core::adapters::allowed("8.8.8.8".parse().unwrap()));
    // this computer's other services: no (only the practice boards Studio runs)
    assert!(!studio_core::adapters::allowed("127.0.0.1".parse().unwrap()));
    let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let e = s.dispatch("http_request", json!({ "url": format!("http://127.0.0.1:{}/", other.local_addr().unwrap().port()) })).await.unwrap_err();
    assert!(e.contains("not a device on the local network"), "{e}");
    let e = s.dispatch("http_request", json!({ "url": format!("http://localhost:{}/", other.local_addr().unwrap().port()) })).await.unwrap_err();
    assert!(e.contains("not a device on the local network"), "{e}");
}

#[test]
fn board_topics_with_a_slash_in_the_prefix() {
    let s = |t: &str| mqtt::split_board_topic(t).map(|(a, b, c)| format!("{a}|{b}|{c}"));
    assert_eq!(s("proptroller/front-door/online").as_deref(), Some("proptroller|front-door|online"));
    assert_eq!(s("haunt/2026/front-door/status/shots").as_deref(), Some("haunt/2026|front-door|status/shots"));
    assert_eq!(s("haunt/2026/front-door/rpc/reply").as_deref(), Some("haunt/2026|front-door|rpc/reply"));
    assert_eq!(s("proptroller/broadcast/name"), None);
    assert_eq!(s("something/else"), None);
}

/// S9 and S10: only watched topics go to the UI once it watches any; a login keeps out clients without it.
#[tokio::test(flavor = "multi_thread")]
async fn watched_topics_and_a_login() {
    let port = free_port();
    let (tx, mut ev) = tokio::sync::broadcast::channel(1000);
    let o = mqtt::BrokerOptions { bind: Some("127.0.0.1".into()), login: Some(("studio".into(), "s3cret".into())) };
    let f = mqtt::Fleet::start_with(port, &o, tx).unwrap();
    // a client without the login gets nothing through
    let (anon, _r, h1) = client("anon", port, None);
    let _ = anon.publish("probe/a/status", QoS::AtLeastOnce, false, "x").await;
    // one with it
    let mut opts = MqttOptions::new("ok", "127.0.0.1", port);
    opts.set_credentials("studio", "s3cret");
    let (good, mut el) = AsyncClient::new(opts, 100);
    let h2 = tokio::spawn(async move { loop { if el.poll().await.is_err() { tokio::time::sleep(Duration::from_millis(200)).await; } } });
    f.watch("probe/+/status");
    good.publish("probe/a/status", QoS::AtLeastOnce, false, "hello").await.unwrap();
    good.publish("other/topic", QoS::AtLeastOnce, false, "no").await.unwrap();
    let mut got = vec![];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Ok(Event::Mqtt { topic, payload, .. })) = tokio::time::timeout(Duration::from_millis(300), ev.recv()).await {
            got.push(format!("{topic}={payload}"));
            if got.iter().any(|g| g == "probe/a/status=hello") { tokio::time::sleep(Duration::from_millis(500)).await; while let Ok(Event::Mqtt { topic, payload, .. }) = ev.try_recv() { got.push(format!("{topic}={payload}")); } break; }
        }
    }
    assert!(got.contains(&"probe/a/status=hello".to_string()), "{got:?}");
    assert!(!got.iter().any(|g| g.starts_with("other/")), "unwatched topics stay in the core: {got:?}");
    assert!(!got.contains(&"probe/a/status=x".to_string()), "the client without the login got through: {got:?}");
    h1.abort();
    h2.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn board_events_reach_the_dashboard() {
    // a board's `<p>/event` messages (a run, a notice) are passed on with the board they came from; `event/run`
    // repeats the run and is not passed on a second time
    let s = Studio::new();
    let port = free_port();
    let mut ev = s.events();
    s.dispatch("mqtt_start", json!({ "port": port })).await.unwrap();
    let (board, _rx, _h) = client("crypt", port, None);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let run = r#"{"boot_id":"1a2b","mqtt_seq":4,"v":1,"seq":7,"event":"run","data":{"source":"input","kind":"show","show":1,"name":"Door","detail":"TRIG1","runs_since_power_on":3,"runs_lifetime":120,"uptime_ms":5000}}"#;
    board.publish("haunt/2026/crypt/event", QoS::AtLeastOnce, false, run).await.unwrap();
    board.publish("haunt/2026/crypt/event/run", QoS::AtLeastOnce, false, r#"{"source":"input","runs_since_power_on":3}"#).await.unwrap();
    board.publish("haunt/2026/crypt/event", QoS::AtLeastOnce, false, r#"{"v":1,"seq":8,"event":"params_changed"}"#).await.unwrap();
    board.publish("haunt/2026/crypt/event", QoS::AtLeastOnce, false, "not json").await.unwrap();
    let mut got = vec![];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while got.len() < 2 && tokio::time::Instant::now() < deadline {
        if let Ok(Ok(Event::FleetEvent { key, name, msg })) = tokio::time::timeout(Duration::from_millis(200), ev.recv()).await {
            got.push((key, name, msg));
        }
    }
    assert_eq!(got.len(), 2, "the run and params_changed");
    assert_eq!(got[0].0, "haunt/2026/crypt");
    assert_eq!(got[0].1, "crypt");
    assert_eq!(got[0].2["event"], "run");
    assert_eq!(got[0].2["data"]["runs_lifetime"], 120);
    assert_eq!(got[1].2["event"], "params_changed");
    // nothing more: not the event/run copy, not the bad payload
    let mut more = 0;
    while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), ev.recv()).await {
        if matches!(e, Event::FleetEvent { .. }) { more += 1; }
    }
    assert_eq!(more, 0);
    // on the wire: {"kind":"fleet_event","key":..,"name":..,"msg":..}
    let w = serde_json::to_value(Event::FleetEvent { key: "p/x".into(), name: "x".into(), msg: json!({ "event": "run" }) }).unwrap();
    assert_eq!(w["kind"], "fleet_event");
}

#[tokio::test(flavor = "multi_thread")]
async fn nights_are_kept_in_the_library() {
    let ws = std::env::temp_dir().join(format!("specter-nights-{}", std::process::id()));
    std::fs::create_dir_all(&ws).unwrap();
    let s = Studio::new();
    let folder = ws.to_string_lossy().to_string();
    s.dispatch("nights_append", json!({ "folder": folder, "night": "2026-10-23", "events": [{ "t": 1, "type": "run", "board": "Crypt" }] })).await.unwrap();
    assert_eq!(s.dispatch("nights_list", json!({ "folder": folder })).await.unwrap()[0]["night"], "2026-10-23");
    assert_eq!(s.dispatch("nights_read", json!({ "folder": folder, "night": "2026-10-23" })).await.unwrap()[0]["board"], "Crypt");
    assert!(s.dispatch("nights_append", json!({ "folder": folder, "night": "x/../../y", "events": [] })).await.is_err());
    let _ = std::fs::remove_dir_all(&ws);
}

/// Every message on `rx` within `window`.
async fn collect(rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, Vec<u8>)>, window: Duration) -> Vec<(String, String)> {
    let mut out = vec![];
    let end = tokio::time::Instant::now() + window;
    while let Ok(Some((t, p))) = tokio::time::timeout_at(end, rx.recv()).await {
        out.push((t, String::from_utf8_lossy(&p).to_string()));
    }
    out
}

async fn bridge_state(s: &Studio, want: &str) -> Value {
    for _ in 0..150 {
        let st = s.dispatch("mqtt_status", json!({})).await.unwrap()["bridge"].clone();
        if st["state"] == want {
            return st;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the bridge never became {want}: {}", s.dispatch("mqtt_status", json!({})).await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn bridge_both_ways_never_loops() {
    let s = Studio::new();
    let (a_port, b_port) = (free_port(), free_port());
    s.dispatch("mqtt_start", json!({ "port": a_port, "bind": "127.0.0.1" })).await.unwrap();
    let (_b_tx, _b_rx) = mqtt::start_broker_with(b_port, "far", &mqtt::BrokerOptions { bind: Some("127.0.0.1".into()), login: None }).unwrap();
    let cfg = json!({ "host": "127.0.0.1", "port": b_port, "direction": "both", "filters": ["site/#"] });
    s.dispatch("bridge_start", cfg.clone()).await.unwrap();
    bridge_state(&s, "connected").await;
    let (here, mut here_rx, _h1) = client("here", a_port, None);
    let (far, mut far_rx, _h2) = client("far", b_port, None);
    here.subscribe("site/#", QoS::AtLeastOnce).await.unwrap();
    far.subscribe("site/#", QoS::AtLeastOnce).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // out: a local message reaches the far side once and is not taken back in
    here.publish("site/door/state", QoS::AtLeastOnce, true, r#"{"n":1}"#).await.unwrap();
    // in: a far message reaches Studio once and is not sent back up
    far.publish("site/desk/event", QoS::AtLeastOnce, false, "hello").await.unwrap();
    // a topic outside the filters stays where it is
    here.publish("other/x", QoS::AtLeastOnce, false, "local only").await.unwrap();
    let (h, f) = tokio::join!(collect(&mut here_rx, Duration::from_secs(3)), collect(&mut far_rx, Duration::from_secs(3)));
    let count = |v: &[(String, String)], t: &str| v.iter().filter(|(x, _)| x == t).count();
    assert_eq!(count(&h, "site/door/state"), 1, "here: {h:?}");
    assert_eq!(count(&h, "site/desk/event"), 1, "here: {h:?}");
    assert_eq!(count(&f, "site/door/state"), 1, "far: {f:?}");
    assert_eq!(count(&f, "site/desk/event"), 1, "far: {f:?}");
    let st = s.dispatch("mqtt_status", json!({})).await.unwrap()["bridge"].clone();
    assert_eq!(st["direction"], "both");

    // connecting again: the far side sends its retained copy of what Studio sent; it is not taken back in
    s.dispatch("bridge_start", cfg).await.unwrap();
    bridge_state(&s, "connected").await;
    let h = collect(&mut here_rx, Duration::from_secs(2)).await;
    assert_eq!(count(&h, "site/door/state"), 0, "a stale copy came back in: {h:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn bridge_in_refuses_board_requests_unless_allowed() {
    let s = Studio::new();
    let (a_port, b_port) = (free_port(), free_port());
    s.dispatch("mqtt_start", json!({ "port": a_port, "bind": "127.0.0.1" })).await.unwrap();
    let (_b_tx, _b_rx) = mqtt::start_broker_with(b_port, "far", &mqtt::BrokerOptions { bind: Some("127.0.0.1".into()), login: None }).unwrap();
    s.dispatch("bridge_start", json!({ "host": "127.0.0.1", "port": b_port, "direction": "in", "prefix": "hq/" })).await.unwrap();
    bridge_state(&s, "connected").await;
    let (here, mut here_rx, _h1) = client("here", a_port, None);
    let (far, _far_rx, _h2) = client("far", b_port, None);
    here.subscribe("#", QoS::AtLeastOnce).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    for t in ["hq/proptroller/front-door/rpc", "hq/proptroller/front-door/config/set/volume", "hq/proptroller/front-door/control/restart"] {
        far.publish(t, QoS::AtLeastOnce, false, "{}").await.unwrap();
    }
    far.publish("hq/checkin/desk/library/complete", QoS::AtLeastOnce, false, "done").await.unwrap();
    let h = collect(&mut here_rx, Duration::from_secs(2)).await;
    assert!(h.iter().any(|(t, p)| t == "checkin/desk/library/complete" && p == "done"), "{h:?}");
    assert!(!h.iter().any(|(t, _)| t.contains("front-door")), "a request reached the boards: {h:?}");
    // out is off: a local message does not go up
    let st = s.dispatch("mqtt_status", json!({})).await.unwrap()["bridge"].clone();
    assert_eq!(st["refused"], 3);
    assert_eq!(st["received"], 1);
    assert_eq!(st["sent"], 0);
    // bad filters are refused in plain words
    let e = s.dispatch("bridge_start", json!({ "host": "127.0.0.1", "port": b_port, "filters": ["a/#/b"] })).await.unwrap_err();
    assert!(e.contains("last level"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn bridge_retries_with_a_plain_reason_then_connects() {
    let s = Studio::new();
    let (a_port, b_port) = (free_port(), free_port());
    s.dispatch("mqtt_start", json!({ "port": a_port, "bind": "127.0.0.1" })).await.unwrap();
    // nothing is listening on b_port yet
    s.dispatch("bridge_start", json!({ "host": "127.0.0.1", "port": b_port })).await.unwrap();
    let st = bridge_state(&s, "retrying").await;
    assert!(st["last_error"].as_str().unwrap().starts_with("Nothing answered at 127.0.0.1 port"), "{st}");
    assert!(st["retry_in_s"].as_u64().unwrap() <= 30, "{st}");
    assert_eq!(st["connected"], false);
    // Studio's own server and the UI are not held up meanwhile
    let t0 = std::time::Instant::now();
    s.dispatch("mqtt_publish", json!({ "topic": "checkin/a/b/start", "payload": "x" })).await.unwrap();
    assert!(t0.elapsed() < Duration::from_millis(200));
    // the other server comes up: the bridge connects by itself
    let (_b_tx, _b_rx) = mqtt::start_broker_with(b_port, "far", &mqtt::BrokerOptions { bind: Some("127.0.0.1".into()), login: None }).unwrap();
    let st = bridge_state(&s, "connected").await;
    assert_eq!(st["connected"], true);
    assert!(st.get("retry_in_s").is_none(), "{st}");
}

#[test]
fn echo_guard_recognises_both_directions() {
    let mut g = mqtt::EchoGuard::default();
    g.note_injected("site/a", b"1", false);
    assert_eq!(g.came_from_bridge("site/a", b"1"), Some(false));
    assert_eq!(g.came_from_bridge("site/a", b"1"), None, "only once per message brought in");
    assert_eq!(g.came_from_bridge("site/b", b"1"), None);
    g.note_injected("site/c", b"2", true);
    assert_eq!(g.came_from_bridge("site/c", b"2"), Some(true), "a retained copy brought in");
    g.note_sent("hq/site/a", b"on");
    assert!(g.is_own("hq/site/a", b"on", false), "the live echo");
    assert!(!g.is_own("hq/site/a", b"on", false), "a second live message is someone else's");
    assert!(g.is_own("hq/site/a", b"on", true), "a retained copy of the last value sent");
    assert!(g.is_own("hq/site/a", b"on", true), "every time it comes back");
    assert!(!g.is_own("hq/site/a", b"off", true), "a different value is news");
    for t in ["proptroller/x/rpc", "proptroller/x/config/set/volume", "proptroller/x/control/restart", "proptroller/x/script/set", "proptroller/x/cue", "proptroller/broadcast/getName", "proptroller/x/status/get/run_count"] {
        assert!(mqtt::is_board_request(t), "{t}");
    }
    for t in ["proptroller/x/state", "proptroller/x/event", "checkin/a/b/complete", "proptroller/x/rpc/reply"] {
        assert!(!mqtt::is_board_request(t), "{t}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn retained_copies_from_the_far_side_do_not_fire_rules_again_on_reconnect() {
    let s = Studio::new();
    let (a_port, b_port) = (free_port(), free_port());
    s.dispatch("mqtt_start", json!({ "port": a_port, "bind": "127.0.0.1" })).await.unwrap();
    // a counting rule (its web address goes nowhere: only the count matters here)
    let rule = json!({ "id": "enter", "pattern": "checkin/*/{roomName}/start", "url": "http://127.0.0.1:9/log", "body": "{roomName}", "count": { "direction": "up", "name": "inside", "per": "roomName" } });
    s.dispatch("automation_set", json!({ "rules": [rule] })).await.unwrap();
    let (_b_tx, _b_rx) = mqtt::start_broker_with(b_port, "far", &mqtt::BrokerOptions { bind: Some("127.0.0.1".into()), login: None }).unwrap();
    let (far, _far_rx, _h) = client("far", b_port, None);
    tokio::time::sleep(Duration::from_millis(300)).await;
    // stored on the far side before Studio connects: old news, every time the bridge (re)connects
    far.publish("checkin/gate/maze/start", QoS::AtLeastOnce, true, "old").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let cfg = json!({ "host": "127.0.0.1", "port": b_port, "direction": "in", "filters": ["checkin/#"] });
    s.dispatch("bridge_start", cfg.clone()).await.unwrap();
    bridge_state(&s, "connected").await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    // a live one is news
    far.publish("checkin/gate/maze/start", QoS::AtLeastOnce, false, "new").await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    s.dispatch("bridge_start", cfg).await.unwrap();
    bridge_state(&s, "connected").await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let st = s.dispatch("automation_status", json!({})).await.unwrap();
    assert_eq!(st["rules"]["enter"]["counts"], json!({ "maze": 1 }), "{st}");
    let b = s.dispatch("mqtt_status", json!({})).await.unwrap()["bridge"].clone();
    assert_eq!(b["received"], 1, "after the restart, the retained copy still reached Studio's server: {b}");
}
