//! Automation rules: topic patterns, request templates, counters and timers, delivery (queue, retries, rate
//! limit), secrets, the ready-made examples, and a rule firing end to end through Studio's MQTT server into a
//! local web server. Nothing here reaches outside this computer.

use chrono::{DateTime, FixedOffset, TimeZone};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use studio_core::automation::delivery::{Delivery, Outcome, Request, Timing, Transport};
use studio_core::automation::pattern::Pattern;
use studio_core::automation::state::{Pairing, State};
use studio_core::automation::template::{escape, Context, Escape, Template, TimerValues};
use studio_core::automation::{self, compile, Engine, Rule};
use studio_core::secrets::{Memory, SecretStore};
use tokio::sync::Notify;

fn at(h: u32, m: u32, s: u32) -> DateTime<FixedOffset> {
    FixedOffset::west_opt(5 * 3600).unwrap().with_ymd_and_hms(2026, 10, 24, h, m, s).unwrap()
}

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("specter-automation-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ---------- patterns ----------

#[test]
fn patterns_compile_to_a_filter_and_capture_names() {
    let p = Pattern::compile("checkin/*/{roomName}/complete").unwrap();
    assert_eq!(p.filter, "checkin/+/+/complete");
    assert_eq!(p.names, vec!["roomName"]);
    let v = p.matches("checkin/front/library/complete").unwrap();
    assert_eq!(v["roomName"], "library");
    assert!(p.matches("checkin/front/library/start").is_none());
    assert!(p.matches("checkin/front/library/complete/extra").is_none());
    assert!(p.matches("checkin/library/complete").is_none());

    // a leading / means the same, on the pattern and on the topic
    let p = Pattern::compile("/checkin/{site}/{roomName}/complete").unwrap();
    assert_eq!(p.filter, "checkin/+/+/complete");
    assert_eq!(p.matches("/checkin/a/b/complete").unwrap()["site"], "a");
    assert_eq!(p.matches("checkin/a/b/complete").unwrap()["roomName"], "b");

    // # and ** match the rest, none or more levels; MQTT's + works like *
    for pat in ["checkin/#", "checkin/**"] {
        let p = Pattern::compile(pat).unwrap();
        assert_eq!(p.filter, "checkin/#");
        assert!(p.matches("checkin/a/b/c").is_some());
        assert!(p.matches("checkin").is_some());
        assert!(p.matches("other/a").is_none());
    }
    assert_eq!(Pattern::compile("a/+/b").unwrap().filter, "a/+/b");
    assert_eq!(Pattern::compile("#").unwrap().filter, "#");
}

#[test]
fn bad_patterns_are_refused_in_plain_words() {
    let err = |p: &str| Pattern::compile(p).unwrap_err();
    assert!(err("").contains("Type the topic"));
    assert!(err("checkin/{}/x").contains("needs a name"));
    assert!(err("checkin/{room}/{room}").contains("used twice"));
    assert!(err("checkin/#/complete").contains("last level"));
    assert!(err("checkin/**/complete").contains("last level"));
    assert!(err("checkin//complete").contains("empty level"));
    assert!(err("checkin/room*").contains("whole level"));
    assert!(err("checkin/{a}b").contains("whole level"));
    assert!(err("checkin/{1st}").contains("starts with a letter"));
    assert!(err("checkin/{topic}").contains("built-in"));
}

// ---------- templates ----------

fn render(t: &str, esc: Escape, payload: &str) -> String {
    let captured: BTreeMap<String, String> = [("roomName".to_string(), "Library, east".to_string())].into();
    let counts = std::collections::HashMap::new();
    let cx = Context { topic: "checkin/front/Library, east/complete", payload, json: serde_json::from_str(payload).ok(), captured: &captured, now: at(21, 4, 5), event_id: "e1", timer: None, counts: &counts };
    Template::parse(t).unwrap().render(&cx, esc).0
}

#[test]
fn templates_fill_in_values_escaped_for_where_they_go() {
    assert_eq!(render("{roomName},complete,{timestamp}", Escape::Csv, ""), "\"Library, east\",complete,2026-10-24T21:04:05-05:00");
    assert_eq!(render("{date} {time} {unix}", Escape::Header, ""), format!("2026-10-24 21:04:05 {}", at(21, 4, 5).timestamp()));
    assert_eq!(render(r#"{"room": "{roomName}", "n": {payload.people}, "who": "{payload.lead.name}"}"#, Escape::Json, r#"{"people": 4, "lead": {"name": "A \"B\""}}"#), r#"{"room": "Library, east", "n": 4, "who": "A \"B\""}"#);
    assert_eq!(render("https://example.test/log?room={roomName}&p={payload}", Escape::Url, "a&b=c"), "https://example.test/log?room=Library%2C%20east&p=a%26b%3Dc");
    assert_eq!(render("{payload}", Escape::Header, "line1\nline2"), "line1 line2");
    // literal braces, {{ and }}
    assert_eq!(render("{{x}} { not a value } {}", Escape::Csv, ""), "{x} { not a value } {}");
    // a missing field or a message that is not JSON: empty, with a note
    let captured = BTreeMap::new();
    let counts = std::collections::HashMap::new();
    let cx = Context { topic: "t", payload: "hello", json: None, captured: &captured, now: at(1, 2, 3), event_id: "e1", timer: None, counts: &counts };
    let (text, notes) = Template::parse("[{payload.people}]").unwrap().render(&cx, Escape::Csv);
    assert_eq!(text, "[]");
    assert!(notes[0].contains("not JSON"));
}

#[test]
fn csv_quotes_and_defuses_formulas() {
    assert_eq!(escape("plain", Escape::Csv), "plain");
    assert_eq!(escape("a,b", Escape::Csv), "\"a,b\"");
    assert_eq!(escape("say \"hi\"", Escape::Csv), "\"say \"\"hi\"\"\"");
    assert_eq!(escape(" edge", Escape::Csv), "\" edge\"");
    assert_eq!(escape("=SUM(A1)", Escape::Csv), "'=SUM(A1)");
    assert_eq!(escape("-5", Escape::Csv), "-5");
    assert_eq!(escape("@x", Escape::Csv), "'@x");
}

#[test]
fn unknown_values_are_errors_when_the_rule_is_saved() {
    let rule = |body: &str| Rule { id: "r".into(), pattern: "checkin/*/{roomName}/complete".into(), url: "https://example.test/x".into(), body: body.into(), ..Default::default() };
    compile(&rule("{roomName},{timestamp},{payload.anything},{count.inside[roomName]}")).unwrap();
    assert!(compile(&rule("{room}")).unwrap_err().contains("not in the topic pattern"));
    assert!(compile(&rule("{elapsed}")).unwrap_err().contains("timer"));
    assert!(compile(&rule("{count.inside[site]}")).unwrap_err().contains("site"));
    assert!(compile(&rule("{roomName")).unwrap_err().contains("closing"));
    // the server is fixed: no value in the host
    let mut r = rule("");
    r.url = "https://{roomName}.example.test/".into();
    assert!(compile(&r).unwrap_err().contains("server"));
    r.url = "ftp://example.test/".into();
    assert!(compile(&r).unwrap_err().contains("https://"));
    r.url = "http://192.168.1.20/log".into();
    assert!(compile(&r).unwrap().warnings[0].contains("unencrypted"));
    // JSON bodies must be JSON
    let mut r = rule(r#"{"room": {roomName}}"#);
    r.content_type = automation::ContentType::Json;
    assert!(compile(&r).unwrap_err().contains("not valid JSON"));
    r.body = r#"{"room": "{roomName}", "n": {payload.people}}"#.into();
    assert!(compile(&r).is_ok());
    let mut r = rule("");
    r.method = "DELETE".into();
    assert!(compile(&r).is_err());
}

// ---------- counters and timers ----------

#[test]
fn latest_pairing_takes_the_newest_start() {
    let mut s = State::default();
    s.start("visit", "library", at(20, 0, 0)).unwrap();
    s.start("visit", "library", at(20, 5, 0)).unwrap(); // started again: the first one was a mistake
    s.start("visit", "attic", at(20, 6, 0)).unwrap();
    let t = s.complete("visit", "library", at(20, 17, 5), Pairing::Latest).unwrap();
    assert_eq!(t.elapsed_ms, Some(12 * 60_000 + 5_000));
    assert_eq!(t.sequence, Some(2));
    assert!(s.complete("visit", "library", at(20, 18, 0), Pairing::Latest).is_none(), "the older start is gone too");
    assert_eq!(s.complete("visit", "attic", at(20, 7, 0), Pairing::Latest).unwrap().elapsed_ms, Some(60_000));
}

#[test]
fn first_in_first_out_pairs_interleaved_groups_in_order() {
    let mut s = State::default();
    // groups 1, 2, 3 enter the house; group 1 leaves, group 4 enters, groups 2 and 3 leave
    s.start("visit", "house", at(19, 0, 0)).unwrap();
    s.start("visit", "house", at(19, 2, 0)).unwrap();
    s.start("visit", "house", at(19, 4, 0)).unwrap();
    // another room meanwhile does not get in the way
    s.start("visit", "maze", at(19, 4, 30)).unwrap();
    let g1 = s.complete("visit", "house", at(19, 10, 0), Pairing::FirstInFirstOut).unwrap();
    s.start("visit", "house", at(19, 11, 0)).unwrap();
    let g2 = s.complete("visit", "house", at(19, 13, 0), Pairing::FirstInFirstOut).unwrap();
    let g3 = s.complete("visit", "house", at(19, 15, 0), Pairing::FirstInFirstOut).unwrap();
    let g4 = s.complete("visit", "house", at(19, 20, 0), Pairing::FirstInFirstOut).unwrap();
    assert_eq!([g1.sequence, g2.sequence, g3.sequence, g4.sequence], [Some(1), Some(2), Some(3), Some(4)]);
    assert_eq!([g1.elapsed_ms, g2.elapsed_ms, g3.elapsed_ms, g4.elapsed_ms].map(|m| m.unwrap() / 60_000), [10, 11, 11, 9]);
    assert!(s.complete("visit", "house", at(19, 21, 0), Pairing::FirstInFirstOut).is_none());
    assert_eq!(s.complete("visit", "maze", at(19, 5, 0), Pairing::FirstInFirstOut).unwrap().sequence, Some(1));
}

#[test]
fn group_numbers_start_again_each_day() {
    let mut s = State::default();
    assert_eq!(s.start("visit", "", at(22, 0, 0)).unwrap().sequence, Some(1));
    assert_eq!(s.start("visit", "", at(23, 0, 0)).unwrap().sequence, Some(2));
    let tomorrow = FixedOffset::west_opt(5 * 3600).unwrap().with_ymd_and_hms(2026, 10, 25, 18, 0, 0).unwrap();
    assert_eq!(s.start("visit", "", tomorrow).unwrap().sequence, Some(1));
}

#[test]
fn counters_never_go_below_zero_and_keep_one_value_per_key() {
    let mut s = State::default();
    assert_eq!(s.count("inside", "maze", 4).unwrap(), 4);
    assert_eq!(s.count("inside", "attic", 2).unwrap(), 2);
    assert_eq!(s.count("inside", "maze", -3).unwrap(), 1);
    assert_eq!(s.count("inside", "maze", -3).unwrap(), 0, "never below 0");
    assert_eq!(s.count("inside", "maze", 1).unwrap(), 1);
    assert_eq!(s.counters["inside"]["attic"], 2);
    s.reset(&["inside".into()], &[]);
    assert!(s.counters.is_empty());
}

// ---------- a fake web client ----------

/// Answers from a script (per destination, else the shared list, else 200) and records every request with its time.
#[derive(Default)]
struct Fake {
    answers: Mutex<VecDeque<Outcome>>,
    by_url: Mutex<std::collections::HashMap<String, VecDeque<Outcome>>>,
    sent: Mutex<Vec<(tokio::time::Instant, Request)>>,
}

impl Transport for Fake {
    fn send<'a>(&'a self, r: &'a Request) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
        Box::pin(async move {
            self.sent.lock().unwrap().push((tokio::time::Instant::now(), r.clone()));
            let mine = self.by_url.lock().unwrap().get_mut(&r.destination()).and_then(|q| q.pop_front());
            mine.or_else(|| self.answers.lock().unwrap().pop_front()).unwrap_or(Outcome::Ok(200))
        })
    }
}

fn engine(fake: &Arc<Fake>, secrets: &Arc<Memory>) -> Arc<Engine> {
    Engine::new(secrets.clone(), fake.clone(), Timing::default())
}

fn bodies(fake: &Fake) -> Vec<String> {
    fake.sent.lock().unwrap().iter().map(|(_, r)| r.body.clone().unwrap_or_default()).collect()
}

fn is_event_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The bodies without their leading `{event_id},` (checked to be one).
fn plain(fake: &Fake) -> Vec<String> {
    bodies(fake)
        .into_iter()
        .map(|b| match b.split_once(',') {
            Some((id, rest)) if is_event_id(id) => rest.to_string(),
            _ => panic!("no event id at the start of {b}"),
        })
        .collect()
}

/// The bodies containing `word`, in the order sent, without their event id.
fn rows(fake: &Fake, word: &str) -> Vec<String> {
    plain(fake).into_iter().filter(|b| b.contains(word)).collect()
}

fn example_rules() -> Vec<Rule> {
    let mut out = vec![];
    for set in automation::examples().as_array().unwrap() {
        for r in set["rules"].as_array().unwrap() {
            let mut r: Rule = serde_json::from_value(r.clone()).unwrap();
            assert_eq!(r.secret_param, "key", "the examples keep the script's key secret");
            r.enabled = true;
            r.url = "http://127.0.0.1:9/log".into();
            r.secret_param.clear();
            out.push(r);
        }
    }
    out
}

fn only(prefix: &str) -> Vec<Rule> {
    example_rules().into_iter().filter(|r| r.id.starts_with(prefix)).collect()
}

async fn drain(fake: &Fake, n: usize) {
    for _ in 0..200 {
        if fake.sent.lock().unwrap().len() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("only {} of {n} requests were sent", fake.sent.lock().unwrap().len());
}

// ---------- the ready-made examples ----------

#[tokio::test]
async fn escape_room_example_logs_start_finish_people_and_time() {
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    let e = engine(&fake, &sec);
    e.ensure_started();
    assert!(e.set_rules(only("escape-room")).unwrap().is_empty());
    e.offer_at("checkin/desk/library/start", br#"{"people": 5}"#, at(20, 0, 0));
    e.offer_at("checkin/desk/library/complete", br#"{"people": 5}"#, at(20, 47, 9));
    drain(&fake, 2).await;
    assert_eq!(rows(&fake, ",start,"), vec!["library,start,2026-10-24T20:00:00-05:00,1,5"]);
    assert_eq!(rows(&fake, ",complete,"), vec!["library,complete,2026-10-24T20:00:00-05:00,2026-10-24T20:47:09-05:00,47 min 09 s,5"]);
    let r = &fake.sent.lock().unwrap()[0].1;
    assert_eq!(r.method, "POST");
    assert!(r.headers.iter().any(|h| h.name == "Content-Type" && h.value.starts_with("text/csv")));
}

#[tokio::test]
async fn haunted_house_example_pairs_groups_in_order() {
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    let e = engine(&fake, &sec);
    e.ensure_started();
    e.set_rules(only("haunted-house")).unwrap();
    e.offer_at("checkin/gate/house/start", br#"{"people": 3}"#, at(19, 0, 0));
    e.offer_at("checkin/gate/house/start", br#"{"people": 6}"#, at(19, 1, 0));
    e.offer_at("checkin/exit/house/complete", b"", at(19, 9, 30));
    e.offer_at("checkin/exit/house/complete", b"", at(19, 12, 0));
    // a complete with no group inside still sends, with the time empty and a warning in the log
    e.offer_at("checkin/exit/house/complete", b"", at(19, 13, 0));
    drain(&fake, 5).await;
    assert_eq!(rows(&fake, ",start,"), vec!["house,start,1,2026-10-24T19:00:00-05:00,3", "house,start,2,2026-10-24T19:01:00-05:00,6"]);
    assert_eq!(rows(&fake, ",complete,"), vec![
        "house,complete,1,2026-10-24T19:00:00-05:00,2026-10-24T19:09:30-05:00,9 min 30 s",
        "house,complete,2,2026-10-24T19:01:00-05:00,2026-10-24T19:12:00-05:00,11 min 00 s",
        "house,complete,,,2026-10-24T19:13:00-05:00,",
    ]);
    let log = &e.status()["rules"]["haunted-house-complete"]["log"];
    assert!(log.as_array().unwrap().iter().any(|l| l["text"].as_str().unwrap().contains("no start for house")), "{log}");
}

#[tokio::test]
async fn maze_example_counts_people_inside_per_area() {
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    let e = engine(&fake, &sec);
    e.ensure_started();
    e.set_rules(only("maze")).unwrap();
    e.offer_at("checkin/a/maze/start", br#"{"people": 4}"#, at(18, 0, 0));
    e.offer_at("checkin/a/corn/start", b"", at(18, 1, 0)); // not JSON: counts 1
    e.offer_at("checkin/a/maze/start", br#"{"people": 2}"#, at(18, 2, 0));
    e.offer_at("checkin/b/maze/complete", br#"{"people": 5}"#, at(18, 20, 0));
    e.offer_at("checkin/b/maze/complete", br#"{"people": 5}"#, at(18, 21, 0)); // more than inside: 0, never below
    drain(&fake, 5).await;
    assert_eq!(rows(&fake, ",entered,"), vec!["maze,entered,2026-10-24T18:00:00-05:00,4", "corn,entered,2026-10-24T18:01:00-05:00,1", "maze,entered,2026-10-24T18:02:00-05:00,6"]);
    assert_eq!(rows(&fake, ",left,"), vec![
        "maze,left,2026-10-24T18:20:00-05:00,1",
        "maze,left,2026-10-24T18:21:00-05:00,0",
    ]);
    assert_eq!(e.status()["rules"]["maze-start"]["counts"], json!({ "maze": 0, "corn": 1 }));
    let log = e.status()["rules"]["maze-start"]["log"].to_string();
    assert!(log.contains("the message is not JSON, so {payload.people} is empty"), "{log}");
    e.reset("maze-start").unwrap();
    assert_eq!(e.status()["rules"]["maze-start"]["counts"], json!({}));
}

#[tokio::test]
async fn rules_counters_and_timers_survive_a_restart() {
    let dir = tmp("restart");
    let sec = Arc::new(Memory::default());
    {
        let fake = Arc::new(Fake::default());
        let e = engine(&fake, &sec);
        e.set_config_dir(dir.clone());
        e.set_rules(example_rules()).unwrap();
        e.offer_at("checkin/desk/library/start", br#"{"people": 2}"#, at(20, 0, 0));
        e.offer_at("checkin/a/maze/start", br#"{"people": 7}"#, at(20, 0, 0));
        e.save_state();
    }
    // Studio starts again
    let fake = Arc::new(Fake::default());
    let e = engine(&fake, &sec);
    e.set_config_dir(dir.clone());
    e.ensure_started();
    assert_eq!(e.rules().len(), 6);
    e.offer_at("checkin/desk/library/complete", b"", at(20, 30, 0));
    e.offer_at("checkin/a/maze/complete", br#"{"people": 3}"#, at(20, 31, 0));
    // the 6 requests that were waiting when Studio closed go first (one address: one queue, in order), then the new ones
    drain(&fake, 12).await;
    let b = plain(&fake);
    assert_eq!(&b[..3], &["library,start,2026-10-24T20:00:00-05:00,1,2", "library,start,1,2026-10-24T20:00:00-05:00,2", "library,entered,2026-10-24T20:00:00-05:00,2"], "{b:?}");
    assert!(b.contains(&"library,complete,2026-10-24T20:00:00-05:00,2026-10-24T20:30:00-05:00,30 min 00 s,".to_string()), "{b:?}");
    assert!(b.contains(&"maze,left,2026-10-24T20:31:00-05:00,4".to_string()), "{b:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join(automation::STATE_FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let _ = std::fs::remove_dir_all(dir);
}

// ---------- delivery ----------

fn request(url: &str, body: &str) -> Request {
    Request { method: "POST".into(), url: url.into(), headers: vec![], body: Some(body.into()), secret_param: None }
}

const SHEET: &str = "https://sheet.example.test/exec";

fn delivery(fake: &Arc<Fake>, t: Timing, start: bool) -> Arc<Delivery> {
    let d = Delivery::new(t, fake.clone(), Arc::new(|_: &str| None), Arc::new(Notify::new()));
    if start {
        d.start(tokio::runtime::Handle::current());
    }
    d
}

async fn settle(d: &Delivery, rule: &str, n: u64) {
    for _ in 0..2000 {
        let s = d.status(rule);
        if s["sent"].as_u64().unwrap() + s["failed"].as_u64().unwrap() + s["unsure"].as_u64().unwrap() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("not settled: {}", d.status(rule));
}

fn times(fake: &Fake, t0: tokio::time::Instant) -> Vec<u64> {
    fake.sent.lock().unwrap().iter().map(|(t, _)| (*t - t0).as_secs()).collect()
}

fn log_texts(d: &Delivery, rule: &str) -> Vec<String> {
    d.status(rule)["log"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(start_paused = true)]
async fn nothing_reached_the_server_is_tried_again_with_backoff() {
    let fake = Arc::new(Fake::default());
    fake.answers.lock().unwrap().extend([Outcome::NotSent("could not connect to sheet.example.test".into()), Outcome::NotSent("could not find sheet.example.test".into()), Outcome::Ok(200)]);
    let d = delivery(&fake, Timing::default(), true);
    let t0 = tokio::time::Instant::now();
    d.push("r", "ev1", "now", request(SHEET, "ev1,library"));
    settle(&d, "r", 1).await;
    assert_eq!(times(&fake, t0), vec![0, 2, 6], "2 s, then 4 s");
    assert_eq!(bodies(&fake), vec!["ev1,library"; 3], "the same request, the same event id, every try");
    let log = log_texts(&d, "r");
    assert!(log[0].starts_with("not sent yet: could not connect to sheet.example.test; trying again in 2 s (try 1 of 5)"), "{log:?}");
    assert_eq!(log.last().unwrap(), "sent (200)");
}

#[tokio::test(start_paused = true)]
async fn busy_answers_wait_for_retry_after_up_to_the_maximum() {
    let fake = Arc::new(Fake::default());
    fake.answers.lock().unwrap().extend([
        Outcome::Http { status: 429, text: "slow down".into(), retry_after: Some(Duration::from_secs(7)) },
        Outcome::Http { status: 503, text: String::new(), retry_after: Some(Duration::from_secs(9999)) },
        Outcome::Http { status: 503, text: String::new(), retry_after: None },
        Outcome::Ok(200),
    ]);
    let t = Timing::default();
    let d = delivery(&fake, t, true);
    let t0 = tokio::time::Instant::now();
    d.push("r", "ev1", "now", request(SHEET, "x"));
    settle(&d, "r", 1).await;
    let cap = t.retry_after_max.as_secs();
    // 7 s as asked, then the cap instead of 9999 s, then the backoff (third try: 8 s)
    assert_eq!(times(&fake, t0), vec![0, 7, 7 + cap, 7 + cap + 8]);
    assert!(log_texts(&d, "r")[0].contains("the server is busy (429: slow down); trying again in 7 s"));
    assert_eq!(studio_core::automation::delivery::retry_after("12"), Some(Duration::from_secs(12)));
    assert_eq!(studio_core::automation::delivery::retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), Some(Duration::ZERO), "a date in the past: now");
}

#[tokio::test(start_paused = true)]
async fn timeouts_and_other_server_errors_are_not_tried_again_and_can_be_sent_again() {
    let fake = Arc::new(Fake::default());
    fake.answers.lock().unwrap().extend([
        Outcome::MaybeSent("sheet.example.test did not answer within 10 s".into()),
        Outcome::Http { status: 500, text: "Internal".into(), retry_after: None },
        Outcome::Http { status: 404, text: "no such script".into(), retry_after: None },
    ]);
    let d = delivery(&fake, Timing::default(), true);
    d.push("r", "ev1", "now", request(SHEET, "ev1,a"));
    d.push("r", "ev2", "now", request(SHEET, "ev2,b"));
    d.push("r", "ev3", "now", request(SHEET, "ev3,c"));
    settle(&d, "r", 3).await;
    tokio::time::sleep(Duration::from_secs(300)).await;
    assert_eq!(fake.sent.lock().unwrap().len(), 3, "none of them was tried again by itself");
    let st = d.status("r");
    assert_eq!((st["unsure"].as_u64(), st["failed"].as_u64(), st["sent"].as_u64()), (Some(2), Some(1), Some(0)));
    let log = st["log"].as_array().unwrap().clone();
    assert_eq!(log[0]["text"], "may have been sent: check the sheet (sheet.example.test did not answer within 10 s)");
    assert_eq!(log[1]["text"], "may have been sent: check the sheet (the server answered 500: Internal)");
    assert_eq!(log[2]["text"], "the server refused it (404: no such script)");
    assert!(log.iter().all(|l| l["resend"].is_u64()), "each one can be sent again");
    // "Send again": the same request (the same event id), once
    d.send_again(log[0]["resend"].as_u64().unwrap()).unwrap();
    settle(&d, "r", 4).await;
    assert_eq!(bodies(&fake).last().unwrap(), "ev1,a");
    assert_eq!(d.status("r")["sent"], 1);
    assert!(d.status("r")["log"][0]["text"].as_str().unwrap().ends_with("(sent again)"));
    assert!(d.send_again(log[0]["resend"].as_u64().unwrap()).is_err(), "only once");
}

#[tokio::test(start_paused = true)]
async fn retries_give_up_after_the_last_try() {
    let fake = Arc::new(Fake::default());
    fake.answers.lock().unwrap().extend((0..10).map(|_| Outcome::NotSent("could not connect".into())));
    let t = Timing::default();
    let d = delivery(&fake, t, true);
    d.push("r", "ev", "now", request(SHEET, "x"));
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(fake.sent.lock().unwrap().len(), t.max_attempts as usize);
    assert_eq!(d.status("r")["failed"], 1);
    assert!(log_texts(&d, "r").last().unwrap().contains("gave up after 5 tries"));
}

#[tokio::test(start_paused = true)]
async fn one_queue_per_address_keeps_a_start_before_its_finish() {
    let fake = Arc::new(Fake::default());
    let other = "https://other.example.test/hook";
    fake.by_url.lock().unwrap().insert(SHEET.into(), [Outcome::NotSent("could not connect".into()), Outcome::NotSent("could not connect".into())].into());
    let d = delivery(&fake, Timing::default(), true);
    let t0 = tokio::time::Instant::now();
    // a start rule and a finish rule send to the same sheet; a third rule elsewhere
    d.push("start", "e1", "now", request(&format!("{SHEET}?room=library"), "start"));
    d.push("finish", "e2", "now", request(&format!("{SHEET}?room=library&x=1"), "finish"));
    d.push("elsewhere", "e3", "now", request(other, "other"));
    settle(&d, "finish", 1).await;
    settle(&d, "elsewhere", 1).await;
    let sent: Vec<(u64, String)> = fake.sent.lock().unwrap().iter().map(|(t, r)| ((*t - t0).as_secs(), r.body.clone().unwrap())).collect();
    let sheet: Vec<&str> = sent.iter().filter(|(_, b)| b != "other").map(|(_, b)| b.as_str()).collect();
    assert_eq!(sheet, vec!["start", "start", "start", "finish"], "the finish waits for its start");
    assert_eq!(sent.iter().find(|(_, b)| b == "other").unwrap().0, 0, "another address is not held up");
}

#[tokio::test(start_paused = true)]
async fn a_full_queue_drops_the_oldest_and_counts_it() {
    let fake = Arc::new(Fake::default());
    // not started: nothing leaves the queues
    let d = delivery(&fake, Timing { queue_limit: 3, burst: 100, ..Timing::default() }, false);
    for i in 0..5 {
        assert!(d.push(if i < 2 { "a" } else { "b" }, "e", "now", request(if i % 2 == 0 { SHEET } else { "https://other.example.test/" }, &i.to_string())));
    }
    assert_eq!(d.waiting().len(), 3);
    assert_eq!(d.status("a")["dropped"], 2, "the two oldest (rule a) went");
    d.start(tokio::runtime::Handle::current());
    tokio::time::sleep(Duration::from_secs(1)).await;
    let mut b = bodies(&fake);
    b.sort();
    assert_eq!(b, vec!["2", "3", "4"]);
}

#[tokio::test(start_paused = true)]
async fn the_rate_limit_allows_a_burst_then_a_steady_rate() {
    let fake = Arc::new(Fake::default());
    let t = Timing::default();
    let d = delivery(&fake, t, false);
    let push = || d.push("r", "e", "now", request(SHEET, "x"));
    let ok = (0..t.burst + 5).filter(|_| push()).count();
    assert_eq!(ok, t.burst as usize);
    assert_eq!(d.status("r")["limited"], 5);
    assert_eq!(d.status("r")["log"].as_array().unwrap().len(), 1, "one log line for a run of skips");
    // a minute later the rate has refilled the burst
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(push());
    let n = (0..t.burst * 2).filter(|_| push()).count();
    assert_eq!(n, t.burst as usize - 1);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(push(), "one more per second at 60 a minute");
    // another rule has its own limit
    assert!(d.push("other", "e", "now", request(SHEET, "x")));
}

#[tokio::test(start_paused = true)]
async fn rate_limited_messages_still_count() {
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    let e = engine(&fake, &sec);
    e.set_rules(only("maze-start")).unwrap();
    for i in 0..30 {
        e.offer_at("checkin/a/maze/start", b"", at(18, 0, i));
    }
    assert_eq!(e.state().counters["inside"]["maze"], 30, "every person counted");
    assert_eq!(e.status()["rules"]["maze-start"]["limited"], 30 - Timing::default().burst as u64);
}

#[tokio::test]
async fn event_ids_are_unique_per_message_and_kept_on_retries() {
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    fake.answers.lock().unwrap().push_back(Outcome::NotSent("could not connect".into()));
    let e = Engine::new(sec.clone(), fake.clone(), Timing { first_delay: Duration::from_millis(20), ..Timing::default() });
    e.ensure_started();
    let rule = Rule { id: "r".into(), enabled: true, pattern: "checkin/#".into(), url: "http://127.0.0.1:9/x".into(), body: "{event_id}".into(), ..Default::default() };
    let other = Rule { id: "r2".into(), ..rule.clone() };
    e.set_rules(vec![rule, other]).unwrap();
    e.offer_at("checkin/a", b"", at(1, 0, 0));
    e.offer_at("checkin/a", b"", at(1, 0, 0));
    drain(&fake, 5).await;
    let b = bodies(&fake);
    assert!(b.iter().all(|x| is_event_id(x)), "{b:?}");
    assert_eq!(b[0], b[1], "a retry keeps its event id");
    let unique: std::collections::HashSet<&String> = b[1..].iter().collect();
    assert_eq!(unique.len(), 4, "one per message and rule: {b:?}");
}

#[tokio::test]
async fn waiting_requests_survive_a_restart_without_their_secrets() {
    let dir = tmp("queue");
    let sec = Arc::new(Memory::default());
    let rule = Rule {
        id: "r".into(),
        enabled: true,
        pattern: "checkin/*/{roomName}/complete".into(),
        url: "https://sheet.example.test/exec".into(),
        body: "{event_id},{roomName}".into(),
        secret_param: "key".into(),
        headers: vec![automation::HeaderSpec { name: "Authorization".into(), value: String::new(), secret: true }],
        ..Default::default()
    };
    {
        // a Studio whose queue never got going (it closed first), with room for 3
        let fake = Arc::new(Fake::default());
        let e = Engine::new(sec.clone(), fake.clone(), Timing { queue_limit: 3, ..Timing::default() });
        e.set_config_dir(dir.clone());
        e.set_rules(vec![rule]).unwrap();
        e.set_param_secret("r", "key", "word-123").unwrap();
        e.set_secret("r", "Authorization", "Bearer tok-456").unwrap();
        for room in ["a", "b", "c", "d", "e"] {
            e.offer_at(&format!("checkin/desk/{room}/complete"), b"", at(20, 0, 0));
        }
        assert_eq!(e.waiting().len(), 3, "bounded");
        e.save_state();
        assert!(fake.sent.lock().unwrap().is_empty());
    }
    let file = std::fs::read_to_string(dir.join(automation::QUEUE_FILE)).unwrap();
    assert!(!file.contains("word-123") && !file.contains("tok-456"), "{file}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join(automation::QUEUE_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Studio starts again: the 3 newest are sent, with the secrets read again
    let fake = Arc::new(Fake::default());
    let e = engine(&fake, &sec);
    e.set_config_dir(dir.clone());
    e.ensure_started();
    drain(&fake, 3).await;
    let sent = fake.sent.lock().unwrap().clone();
    let rooms: Vec<String> = sent.iter().map(|(_, r)| r.body.clone().unwrap().split_once(',').unwrap().1.to_string()).collect();
    assert_eq!(rooms, vec!["c", "d", "e"]);
    assert_eq!(sent[0].1.url, "https://sheet.example.test/exec?key=word-123");
    assert!(sent[0].1.headers.iter().any(|h| h.name == "Authorization" && h.value == "Bearer tok-456"));
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(std::fs::read_to_string(dir.join(automation::QUEUE_FILE)).unwrap(), "[]", "sent, so no longer waiting");
    let _ = std::fs::remove_dir_all(dir);
}

// ---------- secrets ----------

#[tokio::test]
async fn secret_header_values_are_used_but_never_shown_saved_or_exported() {
    let dir = tmp("secrets");
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    let e = engine(&fake, &sec);
    e.set_config_dir(dir.clone());
    e.ensure_started();
    let mut rule = only("escape-room-start").remove(0);
    rule.secret_param = "key".into();
    rule.headers = vec![
        automation::HeaderSpec { name: "Authorization".into(), value: "typed-by-mistake".into(), secret: true },
        automation::HeaderSpec { name: "X-Site".into(), value: "{roomName}".into(), secret: false },
    ];
    e.dispatch("automation_set", &json!({ "rules": [rule] })).await.unwrap();
    assert_eq!(e.dispatch("automation_get", &json!({})).await.unwrap()["secrets"]["escape-room-start:authorization"], false);
    assert_eq!(e.dispatch("automation_get", &json!({})).await.unwrap()["secrets"]["escape-room-start:?key"], false);
    e.dispatch("automation_secret_set", &json!({ "rule": "escape-room-start", "header": "Authorization", "value": "Bearer tok-123" })).await.unwrap();
    e.dispatch("automation_secret_set", &json!({ "rule": "escape-room-start", "param": "key", "value": "word 789" })).await.unwrap();
    let st = e.dispatch("automation_secret_status", &json!({})).await.unwrap();
    assert_eq!(st["headers"]["escape-room-start:authorization"], true);
    assert_eq!(st["headers"]["escape-room-start:?key"], true);

    // used when sending
    e.offer_at("checkin/desk/library/start", b"", at(20, 0, 0));
    drain(&fake, 1).await;
    let sent = fake.sent.lock().unwrap()[0].1.clone();
    assert!(sent.headers.iter().any(|h| h.name == "Authorization" && h.value == "Bearer tok-123"));
    assert!(sent.headers.iter().any(|h| h.name == "X-Site" && h.value == "library"));
    assert_eq!(sent.url, "http://127.0.0.1:9/log?key=word%20789", "the secret part, URL-encoded, added when sending");

    // never in what is shown, saved or exported
    let t = e.dispatch("automation_test", &json!({ "rule": e.rules()[0], "topic": "checkin/desk/library/start", "payload": "" })).await.unwrap();
    let shown = t.to_string();
    assert!(!shown.contains("tok-123") && !shown.contains("word") && shown.contains("(secret)"), "{shown}");
    assert!(t["request"]["url"].as_str().unwrap().starts_with("http://127.0.0.1:9/log?key=••••••"), "{t}");
    for text in [e.dispatch("automation_export", &json!({})).await.unwrap().to_string(), e.dispatch("automation_get", &json!({})).await.unwrap().to_string(), std::fs::read_to_string(dir.join(automation::RULES_FILE)).unwrap()] {
        assert!(!text.contains("tok-123") && !text.contains("typed-by-mistake") && !text.contains("word 789"), "{text}");
    }
    // an exported file imports without secrets (the header is there, its value must be set again)
    let exported = e.dispatch("automation_export", &json!({})).await.unwrap().to_string();
    let r = e.dispatch("automation_import", &json!({ "text": exported })).await.unwrap();
    assert_eq!(r["rules"].as_array().unwrap().len(), 2);
    assert_ne!(r["rules"][1]["id"], "escape-room-start");
    // removing the header removes its secret
    let mut rules = e.rules();
    rules.truncate(1);
    rules[0].headers.clear();
    rules[0].secret_param.clear();
    e.set_rules(rules).unwrap();
    assert!(sec.get(&automation::secret_name("escape-room-start", "Authorization")).is_none());
    assert!(sec.get(&automation::param_secret_name("escape-room-start", "key")).is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_ui_cannot_read_automation_secrets_back() {
    let s = studio_core::Studio::new();
    let e = s.dispatch("secret_get", json!({ "name": automation::secret_name("r", "Authorization") })).await.unwrap_err();
    assert!(e.contains("used by Studio itself"), "{e}");
}

// ---------- end to end: MQTT in, a web request out ----------

/// A web server on this computer that records every request and answers `status`.
async fn web_server(status: u16) -> (u16, tokio::sync::mpsc::UnboundedReceiver<(String, String, String)>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut chunk = [0u8; 4096];
                loop {
                    let n = c.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if body.len() >= len {
                            let first = head.lines().next().unwrap_or("").to_string();
                            let _ = tx.send((first, head.to_string(), body.to_string()));
                            let _ = c.write_all(format!("HTTP/1.1 {status} X\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").as_bytes()).await;
                            return;
                        }
                    }
                }
            });
        }
    });
    (port, rx)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_on_studios_server_sends_the_rule_request() {
    let (web, mut got) = web_server(200).await;
    let s = studio_core::Studio::new();
    let port = free_port();
    s.dispatch("mqtt_start", json!({ "port": port, "bind": "127.0.0.1" })).await.unwrap();
    let rule = json!({ "id": "checkin", "name": "Check-in complete", "pattern": "checkin/*/{roomName}/complete", "url": format!("http://127.0.0.1:{web}/log?room={{roomName}}"), "body": "{roomName},complete,{timestamp}", "content_type": "csv" });
    let r = s.dispatch("automation_set", json!({ "rules": [rule.clone()] })).await.unwrap();
    assert_eq!(r["errors"], json!({}));

    // "Test this rule", then once for real
    let t = s.dispatch("automation_test", json!({ "rule": rule, "topic": "/checkin/front/Room 2/complete", "payload": "" })).await.unwrap();
    assert_eq!(t["variables"]["roomName"], "Room 2");
    assert_eq!(t["request"]["url"], format!("http://127.0.0.1:{web}/log?room=Room%202"));
    assert!(t["warnings"][0].as_str().unwrap().contains("http://"));
    assert!(t.get("result").is_none(), "nothing sent without asking");
    let t = s.dispatch("automation_test", json!({ "rule": rule, "topic": "checkin/front/Room 2/complete", "payload": "", "send": true })).await.unwrap();
    assert_eq!(t["result"]["ok"], true);
    let (line, _, body) = tokio::time::timeout(Duration::from_secs(5), got.recv()).await.unwrap().unwrap();
    assert!(line.starts_with("POST /log?room=Room%202 "), "{line}");
    assert!(body.starts_with("Room 2,complete,20"), "{body}");

    // a board's message on the broker
    let mut o = rumqttc::MqttOptions::new("door-sensor", "127.0.0.1", port);
    o.set_keep_alive(Duration::from_secs(5));
    let (c, mut el) = rumqttc::AsyncClient::new(o, 10);
    tokio::spawn(async move { while el.poll().await.is_ok() {} });
    c.publish("checkin/front/library/complete", rumqttc::QoS::AtLeastOnce, false, "done").await.unwrap();
    let (line, head, body) = tokio::time::timeout(Duration::from_secs(10), got.recv()).await.expect("the rule sent its request").unwrap();
    assert!(line.starts_with("POST /log?room=library "), "{line}");
    assert!(head.to_ascii_lowercase().contains("content-type: text/csv"));
    let fields: Vec<&str> = body.split(',').collect();
    assert_eq!(&fields[..2], &["library", "complete"]);
    assert!(DateTime::parse_from_rfc3339(fields[2]).is_ok(), "{body}");
    for _ in 0..50 {
        if s.dispatch("automation_status", json!({})).await.unwrap()["rules"]["checkin"]["sent"] == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let st = s.dispatch("automation_status", json!({})).await.unwrap();
    assert_eq!(st["rules"]["checkin"]["sent"], 1);
    assert_eq!(st["rules"]["checkin"]["log"][0]["text"], "sent (200)");
}

#[tokio::test]
async fn timer_values_render_in_a_test_without_changing_state() {
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    let e = engine(&fake, &sec);
    e.set_rules(only("escape-room")).unwrap();
    let start = e.rules()[0].clone();
    let t = e.test(&start, "checkin/desk/library/start", r#"{"people": 3}"#, false).await.unwrap();
    assert!(t["request"]["body"].as_str().unwrap().ends_with(",1,3"), "{t}");
    assert!(e.state().timers.is_empty(), "a test does not start a timer");
    let v: Value = e.test(&start, "elsewhere/x", "", false).await.unwrap();
    assert_eq!(v["matched"], false);
    let _ = TimerValues::default();
}

#[tokio::test]
async fn the_readme_example_rule_imports_and_sends_the_owners_line() {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../README.md")).unwrap();
    let start = readme.find("```json\n{\"specter_automation\"").expect("the example in the README") + 8;
    let text = &readme[start..start + readme[start..].find("```").unwrap()];
    let (fake, sec) = (Arc::new(Fake::default()), Arc::new(Memory::default()));
    let e = engine(&fake, &sec);
    e.ensure_started();
    let r = e.import(text).unwrap();
    assert_eq!(r["errors"], json!({}));
    let mut rules = e.rules();
    assert_eq!(rules[0].pattern, "checkin/*/{roomName}/complete");
    assert_eq!(rules[0].secret_param, "key");
    rules[0].url = "http://127.0.0.1:9/exec".into(); // never the real address in a test
    e.set_rules(rules).unwrap();
    e.set_param_secret(&e.rules()[0].id, "key", "a-long-word").unwrap();
    e.offer_at("checkin/front/library/complete", b"", at(21, 4, 5));
    drain(&fake, 1).await;
    assert_eq!(plain(&fake), vec!["library,complete,2026-10-24T21:04:05-05:00"]);
    assert_eq!(fake.sent.lock().unwrap()[0].1.url, "http://127.0.0.1:9/exec?key=a-long-word");
}
