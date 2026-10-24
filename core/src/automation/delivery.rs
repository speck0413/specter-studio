//! Sending the web requests. Never blocks the MQTT server or the UI.
//!
//! * **One queue per destination** (scheme, host and path of the address), worked by its own task, one request at
//!   a time: a start row always lands before its finish row when both go to the same sheet, and one unreachable
//!   address never holds up another.
//! * **Bounded and kept on disk**: at most [`QUEUE_LIMIT`] requests wait in all; when full, the oldest waiting
//!   request is dropped and counted. The engine writes the waiting requests to Studio's config folder (no secret
//!   values: those are read from the keychain when sending), so a restart sends them later.
//! * **A rate limit per rule** (a burst, then a steady rate): messages over it still update counters and timers,
//!   but their request is skipped and counted.
//! * **Retries only when it is safe**: when nothing reached the server (connection refused, the name not found,
//!   the TLS handshake failed), and on 429 / 503 (the server asks to come back later; `Retry-After` is honoured
//!   up to [`RETRY_AFTER_MAX`]). A timeout or another 5xx may already have added the row: it is not tried again
//!   but marked "may have been sent: check the sheet", with "Send again" in the rule's activity. Every request
//!   carries its `{event_id}` (the same when sent again), so the sheet can skip a row it already has.
//! * The last few results per rule (time, status, a short reason) for the Automation page.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;

/// Requests waiting in all (every destination); beyond this the oldest is dropped.
pub const QUEUE_LIMIT: usize = 1000;
/// How long one request may take (connecting, sending, the answer).
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// The wait before the first retry; it doubles after each try, up to [`RETRY_MAX_DELAY`].
pub const RETRY_FIRST_DELAY: Duration = Duration::from_secs(2);
pub const RETRY_MAX_DELAY: Duration = Duration::from_secs(60);
/// The longest `Retry-After` Studio waits for (a longer one is shortened to this).
pub const RETRY_AFTER_MAX: Duration = Duration::from_secs(120);
/// Tries per request, the first included.
pub const MAX_ATTEMPTS: u32 = 5;
/// Requests a rule may send at once after a quiet time...
pub const RATE_LIMIT_BURST: u32 = 10;
/// ...and then per minute.
pub const RATE_LIMIT_PER_MINUTE: u32 = 60;
/// Results kept per rule for its activity log.
pub const LOG_LEN: usize = 20;
/// The longest error or answer text kept in the log.
pub const LOG_TEXT_MAX: usize = 160;
/// Requests kept for "Send again" (the ones that failed or may not have arrived).
pub const RESEND_KEEP: usize = 100;

/// What stands in for a secret wherever a request is shown.
pub const MASK: &str = "•••••• (secret)";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Header {
    pub name: String,
    /// empty for a secret one until it is sent
    pub value: String,
    /// the keychain name of a secret value
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub method: String,
    /// the address without its secret part
    pub url: String,
    pub headers: Vec<Header>,
    pub body: Option<String>,
    /// a secret query parameter added when sending: (its name, its keychain name)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_param: Option<(String, String)>,
}

fn add_param(url: &str, name: &str, value: &str) -> String {
    let (base, frag) = url.split_once('#').map(|(a, b)| (a, format!("#{b}"))).unwrap_or((url, String::new()));
    let sep = if base.contains('?') { if base.ends_with('?') || base.ends_with('&') { "" } else { "&" } } else { "?" };
    format!("{base}{sep}{name}={value}{frag}")
}

impl Request {
    /// The request as it may be shown: secret values masked.
    pub fn masked(&self) -> Value {
        let url = match &self.secret_param {
            Some((n, _)) => add_param(&self.url, n, MASK),
            None => self.url.clone(),
        };
        let headers: Vec<Value> = self.headers.iter().map(|h| json!({ "name": h.name, "value": if h.secret.is_some() { MASK.to_string() } else { h.value.clone() } })).collect();
        json!({ "method": self.method, "url": url, "headers": headers, "body": self.body })
    }

    /// The request as it is sent: secret values filled in (an error in plain words when one is not set).
    pub fn resolve(&self, secret: &dyn Fn(&str) -> Option<String>) -> Result<Request, String> {
        let mut r = self.clone();
        for h in r.headers.iter_mut() {
            if let Some(n) = h.secret.take() {
                h.value = secret(&n).ok_or_else(|| format!("the secret value of header {} is not set (set it in the rule)", h.name))?;
            }
        }
        if let Some((name, key)) = r.secret_param.take() {
            let v = secret(&key).ok_or_else(|| format!("the secret part of the address ({name}) is not set (set it in the rule)"))?;
            r.url = add_param(&r.url, &name, &super::template::escape(&v, super::template::Escape::Url));
        }
        Ok(r)
    }

    /// Where it goes, for its queue: the address without the query or fragment.
    pub fn destination(&self) -> String {
        self.url.split(['?', '#']).next().unwrap_or("").to_string()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// a 2xx (after following redirects)
    Ok(u16),
    /// any other answer, with the start of its text and its `Retry-After`
    Http { status: u16, text: String, retry_after: Option<Duration> },
    /// nothing reached the server (safe to try again)
    NotSent(String),
    /// the request may have arrived (a timeout, a broken connection): not tried again by itself
    MaybeSent(String),
}

pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, r: &'a Request) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;
}

/// The real web client (rustls; redirects followed, as a Google Apps Script web app answers with one).
pub struct Web(reqwest::Client);

impl Web {
    pub fn new() -> Web {
        Web(reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().unwrap_or_default())
    }
}

impl Default for Web {
    fn default() -> Self {
        Self::new()
    }
}

fn short(s: &str) -> String {
    let s = s.trim().replace(['\r', '\n'], " ");
    if s.chars().count() > LOG_TEXT_MAX {
        format!("{}…", s.chars().take(LOG_TEXT_MAX).collect::<String>())
    } else {
        s
    }
}

/// `Retry-After`: seconds, or a date.
pub fn retry_after(v: &str) -> Option<Duration> {
    let v = v.trim();
    if let Ok(s) = v.parse::<u64>() {
        return Some(Duration::from_secs(s));
    }
    let at = chrono::DateTime::parse_from_rfc2822(v).ok()?;
    let ms = (at.timestamp_millis() - chrono::Utc::now().timestamp_millis()).max(0);
    Some(Duration::from_millis(ms as u64))
}

impl Transport for Web {
    fn send<'a>(&'a self, r: &'a Request) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(r.method.as_bytes()).unwrap_or(reqwest::Method::POST);
            let mut b = self.0.request(method, &r.url);
            for h in &r.headers {
                b = b.header(&h.name, &h.value);
            }
            if let Some(body) = &r.body {
                b = b.body(body.clone());
            }
            match b.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        Outcome::Ok(status)
                    } else {
                        let ra = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(retry_after);
                        Outcome::Http { status, text: short(&resp.text().await.unwrap_or_default()), retry_after: ra }
                    }
                }
                Err(e) => web_error(&e),
            }
        })
    }
}

fn web_error(e: &reqwest::Error) -> Outcome {
    let host = e.url().and_then(|u| u.host_str()).unwrap_or("the server").to_string();
    let detail = format!("{e:?}").to_ascii_lowercase();
    // the connection was never made (refused, the name not found, the TLS handshake failed): nothing was sent
    if e.is_connect() {
        return Outcome::NotSent(if detail.contains("dns") || detail.contains("lookup") || detail.contains("resolve") {
            format!("could not find {host} (check the address and the internet connection)")
        } else if detail.contains("certificate") || detail.contains("tls") || detail.contains("handshake") {
            format!("the secure connection to {host} failed (its certificate or encryption)")
        } else {
            format!("could not connect to {host}")
        });
    }
    if e.is_builder() {
        return Outcome::NotSent("the web address is not valid".into());
    }
    if e.is_timeout() {
        return Outcome::MaybeSent(format!("{host} did not answer within {} s", HTTP_TIMEOUT.as_secs()));
    }
    Outcome::MaybeSent(short(&format!("the connection to {host} broke off: {e}")))
}

/// Delays and limits; the named constants, smaller in tests.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub first_delay: Duration,
    pub max_delay: Duration,
    pub retry_after_max: Duration,
    pub max_attempts: u32,
    pub burst: u32,
    pub per_minute: u32,
    pub queue_limit: usize,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { first_delay: RETRY_FIRST_DELAY, max_delay: RETRY_MAX_DELAY, retry_after_max: RETRY_AFTER_MAX, max_attempts: MAX_ATTEMPTS, burst: RATE_LIMIT_BURST, per_minute: RATE_LIMIT_PER_MINUTE, queue_limit: QUEUE_LIMIT }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    /// local time with offset
    pub at: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub text: String,
    /// "Send again" sends this request again (its number)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resend: Option<u64>,
}

impl LogEntry {
    pub fn note(at: String, text: String) -> LogEntry {
        LogEntry { at, ok: false, status: None, text, resend: None }
    }
}

#[derive(Default, Debug, Serialize, Clone)]
pub struct Stats {
    pub sent: u64,
    /// refused, or given up
    pub failed: u64,
    /// may have been sent (a timeout, a server error): check the sheet
    pub unsure: u64,
    /// dropped because too many were waiting
    pub dropped: u64,
    /// skipped because of the rate limit
    pub limited: u64,
    pub log: VecDeque<LogEntry>,
}

/// A request waiting to be sent (kept on disk: no secret values).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub seq: u64,
    pub rule: String,
    pub event_id: String,
    /// when the message arrived (local time)
    pub at: String,
    pub req: Request,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

/// One rule's rate limit and results.
pub struct RuleLane {
    stats: Mutex<Stats>,
    bucket: Mutex<Bucket>,
}

pub fn now_text() -> String {
    super::template::iso(&chrono::Local::now().fixed_offset())
}

impl RuleLane {
    fn new(t: &Timing) -> Arc<RuleLane> {
        Arc::new(RuleLane { stats: Mutex::new(Stats::default()), bucket: Mutex::new(Bucket { tokens: t.burst as f64, last: Instant::now() }) })
    }

    fn allow(&self, t: &Timing) -> bool {
        let mut b = self.bucket.lock().unwrap();
        let now = Instant::now();
        let refill = now.duration_since(b.last).as_secs_f64() * t.per_minute as f64 / 60.0;
        b.tokens = (b.tokens + refill).min(t.burst as f64);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub fn log(&self, e: LogEntry) {
        let mut s = self.stats.lock().unwrap();
        // the same note again (a field missing from every message): one line, with the latest time
        if let Some(last) = s.log.back_mut().filter(|l| !l.ok && !e.ok && l.text == e.text && l.resend.is_none() && e.resend.is_none()) {
            last.at = e.at;
            return;
        }
        s.log.push_back(e);
        while s.log.len() > LOG_LEN {
            s.log.pop_front();
        }
    }

    pub fn stats(&self) -> Stats {
        self.stats.lock().unwrap().clone()
    }
}

#[derive(Default)]
struct Queues {
    by_dest: HashMap<String, VecDeque<Job>>,
    total: usize,
    next_seq: u64,
}

pub type SecretFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Every queue, every rule's results, and the requests kept for "Send again".
pub struct Delivery {
    timing: Timing,
    transport: Arc<dyn Transport>,
    secret: SecretFn,
    queues: Mutex<Queues>,
    notify: Mutex<HashMap<String, Arc<Notify>>>,
    workers: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    rules: Mutex<HashMap<String, Arc<RuleLane>>>,
    resend: Mutex<VecDeque<Job>>,
    runtime: Mutex<Option<tokio::runtime::Handle>>,
    /// told whenever the waiting requests change (the engine writes them to disk)
    changed: Arc<Notify>,
}

impl Delivery {
    pub fn new(timing: Timing, transport: Arc<dyn Transport>, secret: SecretFn, changed: Arc<Notify>) -> Arc<Delivery> {
        Arc::new(Delivery { timing, transport, secret, queues: Mutex::default(), notify: Mutex::default(), workers: Mutex::default(), rules: Mutex::default(), resend: Mutex::default(), runtime: Mutex::new(None), changed })
    }

    pub fn rule(&self, id: &str) -> Arc<RuleLane> {
        self.rules.lock().unwrap().entry(id.to_string()).or_insert_with(|| RuleLane::new(&self.timing)).clone()
    }

    /// Keeps the results of these rules only.
    pub fn keep_rules(&self, ids: &[String]) {
        self.rules.lock().unwrap().retain(|id, _| ids.contains(id));
    }

    /// Starts the queue workers (needs the async runtime).
    pub fn start(self: &Arc<Self>, h: tokio::runtime::Handle) {
        *self.runtime.lock().unwrap() = Some(h);
        let dests: Vec<String> = self.queues.lock().unwrap().by_dest.keys().cloned().collect();
        for d in dests {
            self.worker(&d);
        }
    }

    fn notifier(&self, dest: &str) -> Arc<Notify> {
        self.notify.lock().unwrap().entry(dest.to_string()).or_default().clone()
    }

    fn worker(self: &Arc<Self>, dest: &str) {
        let Some(h) = self.runtime.lock().unwrap().clone() else { return };
        let mut w = self.workers.lock().unwrap();
        if w.get(dest).is_some_and(|t| !t.is_finished()) {
            return;
        }
        let me = self.clone();
        let d = dest.to_string();
        w.insert(dest.to_string(), h.spawn(async move { me.run(d).await }));
    }

    /// A rule's request for a message: false when the rate limit skipped it. Never waits.
    pub fn push(self: &Arc<Self>, rule: &str, event_id: &str, at: &str, req: Request) -> bool {
        let lane = self.rule(rule);
        if !lane.allow(&self.timing) {
            let mut s = lane.stats.lock().unwrap();
            s.limited += 1;
            let text = format!("skipped: more than {} requests a minute from this rule ({} skipped so far)", self.timing.per_minute, s.limited);
            // one line for a run of skips, not one per message
            if let Some(last) = s.log.back_mut().filter(|l| l.text.starts_with("skipped: more than")) {
                last.text = text;
                last.at = at.to_string();
            } else {
                drop(s);
                lane.log(LogEntry::note(at.to_string(), text));
            }
            return false;
        }
        let seq = self.next_seq();
        self.enqueue(Job { seq, rule: rule.to_string(), event_id: event_id.to_string(), at: at.to_string(), req });
        true
    }

    fn next_seq(&self) -> u64 {
        let mut q = self.queues.lock().unwrap();
        q.next_seq += 1;
        q.next_seq
    }

    fn enqueue(self: &Arc<Self>, job: Job) {
        let dest = job.req.destination();
        let mut dropped = None;
        {
            let busy: Vec<String> = self.workers.lock().unwrap().keys().cloned().collect();
            let mut q = self.queues.lock().unwrap();
            q.next_seq = q.next_seq.max(job.seq);
            if q.total >= self.timing.queue_limit {
                // the oldest waiting request anywhere (never the one a worker is sending: the front of its queue)
                let oldest = q
                    .by_dest
                    .iter()
                    .filter_map(|(d, v)| {
                        let skip = usize::from(busy.contains(d));
                        v.get(skip).map(|j| (j.seq, d.clone(), skip))
                    })
                    .min();
                if let Some((_, d, i)) = oldest {
                    if let Some(j) = q.by_dest.get_mut(&d).and_then(|v| v.remove(i)) {
                        q.total -= 1;
                        dropped = Some(j.rule);
                    }
                }
            }
            q.by_dest.entry(dest.clone()).or_default().push_back(job);
            q.total += 1;
        }
        if let Some(r) = dropped {
            self.rule(&r).stats.lock().unwrap().dropped += 1;
        }
        self.notifier(&dest).notify_one();
        self.worker(&dest);
        self.changed.notify_one();
    }

    /// Every waiting request, oldest first (for the file on disk).
    pub fn waiting(&self) -> Vec<Job> {
        let q = self.queues.lock().unwrap();
        let mut v: Vec<Job> = q.by_dest.values().flatten().cloned().collect();
        v.sort_by_key(|j| j.seq);
        v
    }

    /// Requests that were waiting when Studio last closed.
    pub fn restore(self: &Arc<Self>, mut jobs: Vec<Job>) {
        jobs.sort_by_key(|j| j.seq);
        let skip = jobs.len().saturating_sub(self.timing.queue_limit);
        for j in jobs.into_iter().skip(skip) {
            self.enqueue(j);
        }
    }

    pub fn queued_for(&self, rule: &str) -> usize {
        self.queues.lock().unwrap().by_dest.values().flatten().filter(|j| j.rule == rule).count()
    }

    pub fn status(&self, rule: &str) -> Value {
        let s = self.rule(rule).stats();
        json!({ "queued": self.queued_for(rule), "sent": s.sent, "failed": s.failed, "unsure": s.unsure, "dropped": s.dropped, "limited": s.limited, "log": s.log })
    }

    /// "Send again": the request of log entry `seq`, at the end of its queue, with the same event id.
    pub fn send_again(self: &Arc<Self>, seq: u64) -> Result<(), String> {
        let job = {
            let mut r = self.resend.lock().unwrap();
            let i = r.iter().position(|j| j.seq == seq).ok_or("that request is no longer kept (only the latest ones are)")?;
            r.remove(i).unwrap()
        };
        for e in self.rule(&job.rule).stats.lock().unwrap().log.iter_mut().filter(|e| e.resend == Some(seq)) {
            e.resend = None;
            e.text.push_str(" (sent again)");
        }
        let seq = self.next_seq();
        self.enqueue(Job { seq, ..job });
        Ok(())
    }

    fn keep_for_resend(&self, job: &Job) {
        let mut r = self.resend.lock().unwrap();
        r.push_back(job.clone());
        while r.len() > RESEND_KEEP {
            r.pop_front();
        }
    }

    /// Works one destination's queue for good, one request at a time, in order.
    async fn run(self: Arc<Self>, dest: String) {
        let n = self.notifier(&dest);
        loop {
            let job = self.queues.lock().unwrap().by_dest.get(&dest).and_then(|v| v.front().cloned());
            match job {
                Some(job) => {
                    self.deliver(&job).await;
                    let mut q = self.queues.lock().unwrap();
                    if let Some(v) = q.by_dest.get_mut(&dest) {
                        if v.front().is_some_and(|j| j.seq == job.seq) {
                            v.pop_front();
                            q.total -= 1;
                        }
                    }
                    drop(q);
                    self.changed.notify_one();
                }
                None => n.notified().await,
            }
        }
    }

    async fn deliver(&self, job: &Job) {
        let lane = self.rule(&job.rule);
        let t = self.timing;
        let mut delay = t.first_delay;
        let entry = |ok, status, text: String, resend: bool| LogEntry { at: now_text(), ok, status, text, resend: resend.then_some(job.seq) };
        let with = |st: u16, text: &str| format!("{st}{}", if text.is_empty() { String::new() } else { format!(": {text}") });
        let req = match job.req.resolve(&*self.secret) {
            Ok(r) => r,
            Err(e) => {
                lane.stats.lock().unwrap().failed += 1;
                self.keep_for_resend(job);
                lane.log(entry(false, None, format!("not sent: {e}"), true));
                return;
            }
        };
        for attempt in 1..=t.max_attempts {
            let out = self.transport.send(&req).await;
            let (wait, why, status) = match &out {
                Outcome::Ok(st) => {
                    lane.stats.lock().unwrap().sent += 1;
                    lane.log(entry(true, Some(*st), format!("sent ({st})"), false));
                    return;
                }
                Outcome::NotSent(why) => (delay, why.clone(), None),
                Outcome::Http { status: st @ (429 | 503), text, retry_after } => (retry_after.map(|r| r.min(t.retry_after_max)).unwrap_or(delay), format!("the server is busy ({})", with(*st, text)), Some(*st)),
                Outcome::Http { status: st, text, .. } if *st >= 500 => {
                    lane.stats.lock().unwrap().unsure += 1;
                    self.keep_for_resend(job);
                    lane.log(entry(false, Some(*st), format!("may have been sent: check the sheet (the server answered {})", with(*st, text)), true));
                    return;
                }
                Outcome::Http { status: st, text, .. } => {
                    lane.stats.lock().unwrap().failed += 1;
                    self.keep_for_resend(job);
                    lane.log(entry(false, Some(*st), format!("the server refused it ({})", with(*st, text)), true));
                    return;
                }
                Outcome::MaybeSent(why) => {
                    lane.stats.lock().unwrap().unsure += 1;
                    self.keep_for_resend(job);
                    lane.log(entry(false, None, format!("may have been sent: check the sheet ({why})"), true));
                    return;
                }
            };
            if attempt == t.max_attempts {
                lane.stats.lock().unwrap().failed += 1;
                self.keep_for_resend(job);
                lane.log(entry(false, status, format!("not sent: {why} (gave up after {attempt} tries)"), true));
                return;
            }
            lane.log(entry(false, status, format!("not sent yet: {why}; trying again in {} s (try {attempt} of {})", wait.as_secs_f64().ceil(), t.max_attempts), false));
            tokio::time::sleep(wait).await;
            delay = (delay * 2).min(t.max_delay);
        }
    }

    /// Sends one request now, outside the queues ("Test this rule", Send it once).
    pub async fn send_now(&self, req: &Request) -> Outcome {
        match req.resolve(&*self.secret) {
            Ok(r) => self.transport.send(&r).await,
            Err(e) => Outcome::NotSent(e),
        }
    }
}
