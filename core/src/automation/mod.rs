//! Automation: "When a message arrives on … send a web request to …" rules on Studio's MQTT server, for clerical
//! work such as logging check-ins to a spreadsheet.
//!
//! * [`pattern`]: the topic pattern (`checkin/*/{roomName}/complete`)
//! * [`template`]: the request's address, headers and body (`{roomName},complete,{timestamp}`)
//! * [`state`]: counters and timers rules keep between messages
//! * [`delivery`]: queues, rate limits, retries and each rule's activity log
//!
//! The MQTT server's thread hands every message to [`Engine::offer`], which never waits: it matches the rules,
//! updates counters and timers, renders the request and puts it in its destination's queue. Rules, state and the
//! waiting requests are kept in Studio's config folder (`automation.json`, `automation-state.json`,
//! `automation-queue.json`; no secrets in any); secret header values and secret address parts are in the system
//! keychain, set-only, and read when a request is sent.

pub mod delivery;
pub mod pattern;
pub mod state;
pub mod template;

use crate::secrets::SecretStore;
use chrono::{DateTime, FixedOffset};
use delivery::{Delivery, Header, Job, Request, Timing, Transport};
use pattern::Pattern;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use state::{Pairing, State};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use template::{Context, Escape, Template, TimerValues};

/// How long after a change counters and timers are written to disk (changes in between are written together).
pub const STATE_SAVE_DELAY: Duration = Duration::from_millis(500);
/// The rules file and the state file in Studio's config folder.
pub const RULES_FILE: &str = "automation.json";
pub const STATE_FILE: &str = "automation-state.json";
/// The requests waiting to be sent (no secret values), so a restart sends them later.
pub const QUEUE_FILE: &str = "automation-queue.json";
/// The export format's version.
pub const EXPORT_VERSION: u32 = 1;
/// The most rules Studio keeps.
pub const MAX_RULES: usize = 200;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    /// one CSV line (`text/csv`)
    #[default]
    Csv,
    Json,
    /// a web form (`application/x-www-form-urlencoded`), as a Google Form takes
    Form,
}

impl ContentType {
    fn mime(self) -> &'static str {
        match self {
            ContentType::Csv => "text/csv; charset=utf-8",
            ContentType::Json => "application/json",
            ContentType::Form => "application/x-www-form-urlencoded",
        }
    }
    fn escape(self) -> Escape {
        match self {
            ContentType::Csv => Escape::Csv,
            ContentType::Json => Escape::Json,
            ContentType::Form => Escape::Url,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HeaderSpec {
    pub name: String,
    /// empty for a secret (its value is in the keychain)
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CountDirection {
    #[default]
    Up,
    Down,
}

/// "Count up / down `name` by `by` (for each `per`)".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CountSpec {
    #[serde(default)]
    pub direction: CountDirection,
    pub name: String,
    /// a number or a value such as `{payload.people}`; empty means 1
    #[serde(default)]
    pub by: String,
    /// a name from the topic pattern (one count per room), or empty for one count
    #[serde(default)]
    pub per: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimerRole {
    #[default]
    Start,
    Complete,
}

/// "Time each group": this rule starts or completes timer `name` (for each `per`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TimerSpec {
    #[serde(default)]
    pub role: TimerRole,
    pub name: String,
    #[serde(default)]
    pub per: String,
    /// which start a complete belongs to
    #[serde(default)]
    pub pairing: Pairing,
}

fn yes() -> bool {
    true
}
fn post() -> String {
    "POST".into()
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub pattern: String,
    #[serde(default = "post")]
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderSpec>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub content_type: ContentType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<CountSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer: Option<TimerSpec>,
    /// the name of a query parameter whose value is secret (`key` for `?key=…`): kept in the keychain, added to
    /// the address when sending, masked wherever the request is shown, never exported
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret_param: String,
}

/// A rule ready to run.
#[derive(Debug)]
pub struct Compiled {
    pub rule: Rule,
    pub pattern: Pattern,
    url: Template,
    headers: Vec<(String, Option<Template>)>,
    body: Template,
    by: Option<Template>,
    /// things worth knowing that do not stop the rule (http instead of https, a GET's unused body)
    pub warnings: Vec<String>,
}

fn header_name_ok(n: &str) -> bool {
    !n.is_empty() && n.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// The keychain name of a rule's secret header value.
pub fn secret_name(rule_id: &str, header: &str) -> String {
    format!("automation-header:{rule_id}:{}", header.to_ascii_lowercase())
}

/// The keychain name of a rule's secret address part (`?key=…`).
pub fn param_secret_name(rule_id: &str, param: &str) -> String {
    format!("automation-param:{rule_id}:{param}")
}

/// Every keychain name a rule uses.
fn secret_names(r: &Rule) -> Vec<String> {
    let mut v: Vec<String> = r.headers.iter().filter(|h| h.secret).map(|h| secret_name(&r.id, &h.name)).collect();
    if !r.secret_param.is_empty() {
        v.push(param_secret_name(&r.id, &r.secret_param));
    }
    v
}

/// Checks a rule and makes it ready to run; the first problem in plain words.
pub fn compile(rule: &Rule) -> Result<Compiled, String> {
    let pattern = Pattern::compile(&rule.pattern)?;
    let names = &pattern.names;
    let has_timer = rule.timer.is_some();
    let mut warnings = vec![];
    let method = if rule.method.trim().is_empty() { "POST".to_string() } else { rule.method.trim().to_ascii_uppercase() };
    if !["POST", "GET", "PUT"].contains(&method.as_str()) {
        return Err(format!("{} is not a method Studio sends: use POST, GET or PUT.", rule.method));
    }
    let url = Template::parse(rule.url.trim()).map_err(|e| format!("Web address: {e}"))?;
    url.check_url()?;
    url.check(names, has_timer).map_err(|e| format!("Web address: {e}"))?;
    if rule.url.trim().to_ascii_lowercase().starts_with("http://") {
        warnings.push("This address starts with http://, so the request crosses the network unencrypted. Use https:// unless the server is on this network.".into());
    }
    let p = rule.secret_param.trim();
    if !p.is_empty() && !p.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) {
        return Err(format!("“{p}”: the secret part of the address is a name such as key (letters, digits, - and _)."));
    }
    let mut headers = vec![];
    for h in &rule.headers {
        let n = h.name.trim();
        if !header_name_ok(n) {
            return Err(format!("“{n}” is not a header name (letters, digits and - only, for example Authorization)."));
        }
        if h.secret {
            headers.push((n.to_string(), None));
        } else {
            let t = Template::parse(&h.value).map_err(|e| format!("Header {n}: {e}"))?;
            t.check(names, has_timer).map_err(|e| format!("Header {n}: {e}"))?;
            headers.push((n.to_string(), Some(t)));
        }
    }
    let body = Template::parse(&rule.body).map_err(|e| format!("Body: {e}"))?;
    body.check(names, has_timer).map_err(|e| format!("Body: {e}"))?;
    if method == "GET" && !rule.body.trim().is_empty() {
        warnings.push("A GET request sends no body; put the values in the web address instead (after ?).".into());
    }
    if rule.content_type == ContentType::Json && method != "GET" && !rule.body.trim().is_empty() {
        // text values stand in as x, values that may be numbers as 0: the body must be JSON (text goes in quotes)
        let text = body.sample();
        if let Err(e) = serde_json::from_str::<Value>(&text) {
            return Err(format!("Body: this is not valid JSON ({e}). Put text values in quotes, for example {{\"room\": \"{{roomName}}\"}}."));
        }
    }
    let by = match &rule.count {
        None => None,
        Some(c) => {
            if !pattern::valid_name(&c.name) {
                return Err("Give the counter a name: letters, digits and _ only, for example inside.".into());
            }
            if !c.per.is_empty() && !names.contains(&c.per) {
                return Err(format!("The counter is kept for each {}, but the topic pattern has no {{{}}}.", c.per, c.per));
            }
            let t = Template::parse(&c.by).map_err(|e| format!("Count by: {e}"))?;
            t.check(names, has_timer).map_err(|e| format!("Count by: {e}"))?;
            Some(t)
        }
    };
    if let Some(t) = &rule.timer {
        if !pattern::valid_name(&t.name) {
            return Err("Give the timer a name: letters, digits and _ only, for example visit.".into());
        }
        if !t.per.is_empty() && !names.contains(&t.per) {
            return Err(format!("The timer is kept for each {}, but the topic pattern has no {{{}}}.", t.per, t.per));
        }
    }
    Ok(Compiled { rule: Rule { method, secret_param: p.to_string(), ..rule.clone() }, pattern, url, headers, body, by, warnings })
}

/// A rule's request for one message, and what happened to counters and timers.
pub struct Fired {
    /// secret values are not in it: they are read from the keychain when it is sent
    pub request: Request,
    pub captured: BTreeMap<String, String>,
    pub notes: Vec<String>,
}

static MESSAGES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A new message's id (unique: the time, a counter and the process).
pub fn new_message_id() -> String {
    let n = MESSAGES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}:{n}:{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0), std::process::id())
}

/// `{event_id}`: 16 hex characters for a message and a rule.
pub fn event_id(message: &str, rule: &str) -> String {
    use sha2::Digest;
    hex::encode(&sha2::Sha256::digest(format!("{message}|{rule}").as_bytes())[..8])
}

impl Compiled {
    /// Applies the rule to a matching message: counts, timers, then the request (so the request shows the
    /// count after this message and the time since the matching start).
    pub fn fire(&self, topic: &str, payload: &[u8], captured: BTreeMap<String, String>, now: DateTime<FixedOffset>, event_id: &str, st: &mut State) -> Fired {
        let payload = String::from_utf8_lossy(payload).to_string();
        let json: Option<Value> = serde_json::from_str(&payload).ok();
        let mut notes = vec![];
        let key_of = |per: &str| if per.is_empty() { String::new() } else { captured.get(per).cloned().unwrap_or_default() };
        let mut timer = None;
        if let Some(t) = &self.rule.timer {
            let key = key_of(&t.per);
            let who = if key.is_empty() { String::new() } else { format!(" for {key}") };
            timer = Some(match t.role {
                TimerRole::Start => st.start(&t.name, &key, now).unwrap_or_else(|e| {
                    notes.push(e);
                    TimerValues::default()
                }),
                TimerRole::Complete => st.complete(&t.name, &key, now, t.pairing).unwrap_or_else(|| {
                    notes.push(format!("warning: no start{who} to match this complete, so the time taken is empty"));
                    TimerValues::default()
                }),
            });
        }
        if let (Some(c), Some(by)) = (&self.rule.count, &self.by) {
            let counts = HashMap::new();
            let cx = Context { topic, payload: &payload, json: json.clone(), captured: &captured, now, event_id, timer: timer.clone(), counts: &counts };
            let (text, n) = by.render(&cx, Escape::Header);
            notes.extend(n);
            let amount = match text.trim() {
                "" => 1,
                t => t.parse::<f64>().map(|f| f.round() as i64).unwrap_or_else(|_| {
                    notes.push(format!("warning: “{t}” is not a number, so the counter changed by 1"));
                    1
                }),
            };
            let delta = if c.direction == CountDirection::Up { amount } else { -amount };
            if let Err(e) = st.count(&c.name, &key_of(&c.per), delta) {
                notes.push(e);
            }
        }
        let cx = Context { topic, payload: &payload, json, captured: &captured, now, event_id, timer, counts: &st.counters };
        let (url, n) = self.url.render(&cx, Escape::Url);
        notes.extend(n);
        let mut headers = vec![];
        for (name, t) in &self.headers {
            match t {
                Some(t) => {
                    let (v, n) = t.render(&cx, Escape::Header);
                    notes.extend(n);
                    headers.push(Header { name: name.clone(), value: v, secret: None });
                }
                None => headers.push(Header { name: name.clone(), value: String::new(), secret: Some(secret_name(&self.rule.id, name)) }),
            }
        }
        let body = if self.rule.method == "GET" {
            None
        } else {
            if !headers.iter().any(|h| h.name.eq_ignore_ascii_case("content-type")) {
                headers.push(Header { name: "Content-Type".into(), value: self.rule.content_type.mime().into(), secret: None });
            }
            let (b, n) = self.body.render(&cx, self.rule.content_type.escape());
            notes.extend(n);
            Some(b)
        };
        notes.dedup();
        let secret_param = (!self.rule.secret_param.is_empty()).then(|| (self.rule.secret_param.clone(), param_secret_name(&self.rule.id, &self.rule.secret_param)));
        Fired { request: Request { method: self.rule.method.clone(), url, headers, body, secret_param }, captured, notes }
    }
}

/// The rules, their queues and their state.
pub struct Engine {
    /// what the person saved (some may not compile: they are kept, with their problem, but do not run)
    rules: Mutex<Vec<Rule>>,
    /// the rules that run, swapped whole on every save (the MQTT thread never waits for a save)
    active: RwLock<Arc<Vec<Arc<Compiled>>>>,
    delivery: Arc<Delivery>,
    state: Mutex<State>,
    /// told when counters, timers or the waiting requests change (the writer saves them)
    dirty: Arc<tokio::sync::Notify>,
    secrets: Arc<dyn SecretStore>,
    /// secret values, read from the keychain once (never on the MQTT thread)
    secret_cache: Arc<Mutex<HashMap<String, String>>>,
    config_dir: Mutex<Option<PathBuf>>,
    runtime: Mutex<Option<tokio::runtime::Handle>>,
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("cannot make {}: {e}", d.display()))?;
    }
    crate::library::write_atomic(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn outcome_json(o: delivery::Outcome) -> Value {
    use delivery::Outcome::*;
    match o {
        Ok(s) => json!({ "ok": true, "status": s, "text": format!("sent ({s})") }),
        Http { status, text, .. } => json!({ "ok": false, "status": status, "text": format!("the server answered {status}{}", if text.is_empty() { String::new() } else { format!(": {text}") }) }),
        NotSent(t) => json!({ "ok": false, "text": format!("not sent: {t}") }),
        MaybeSent(t) => json!({ "ok": false, "text": format!("may have been sent: check the sheet ({t})") }),
    }
}

impl Engine {
    pub fn new(secrets: Arc<dyn SecretStore>, transport: Arc<dyn Transport>, timing: Timing) -> Arc<Engine> {
        let cache: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let dirty = Arc::new(tokio::sync::Notify::new());
        let (c, s) = (cache.clone(), secrets.clone());
        let secret: delivery::SecretFn = Arc::new(move |n: &str| c.lock().unwrap().get(n).cloned().or_else(|| s.get(n)));
        Arc::new(Engine {
            rules: Mutex::new(vec![]),
            active: RwLock::new(Arc::new(vec![])),
            delivery: Delivery::new(timing, transport, secret, dirty.clone()),
            state: Mutex::new(State::default()),
            dirty,
            secrets,
            secret_cache: cache,
            config_dir: Mutex::new(None),
            runtime: Mutex::new(None),
        })
    }

    /// Studio's config folder: rules, state and waiting requests are read from it now and written to it from now on.
    pub fn set_config_dir(self: &Arc<Self>, dir: PathBuf) {
        let read = |f: &str| std::fs::read_to_string(dir.join(f)).ok();
        let rules: Vec<Rule> = read(RULES_FILE).and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| serde_json::from_value(v["rules"].clone()).ok()).unwrap_or_default();
        let state: State = read(STATE_FILE).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let waiting: Vec<Job> = read(QUEUE_FILE).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        *self.config_dir.lock().unwrap() = Some(dir);
        *self.state.lock().unwrap() = state;
        self.install(rules);
        self.delivery.restore(waiting);
    }

    /// Starts the queue workers and the writer (needs the async runtime: called from dispatch).
    pub fn ensure_started(self: &Arc<Self>) {
        let mut rt = self.runtime.lock().unwrap();
        if rt.is_some() {
            return;
        }
        let Ok(h) = tokio::runtime::Handle::try_current() else { return };
        *rt = Some(h.clone());
        drop(rt);
        let me = Arc::downgrade(self);
        let dirty = self.dirty.clone();
        h.spawn(async move {
            loop {
                dirty.notified().await;
                tokio::time::sleep(STATE_SAVE_DELAY).await;
                let Some(e) = me.upgrade() else { break };
                e.save_state();
            }
        });
        self.load_secrets();
        self.delivery.start(h);
    }

    /// Reads every secret value the rules name from the keychain into memory.
    fn load_secrets(&self) {
        let names: Vec<String> = self.rules.lock().unwrap().iter().flat_map(secret_names).collect();
        let mut cache = HashMap::new();
        for n in names {
            if let Some(v) = self.secrets.get(&n) {
                cache.insert(n, v);
            }
        }
        *self.secret_cache.lock().unwrap() = cache;
    }

    /// Puts `rules` in place (no file written); the problem of each rule that does not run, by id.
    fn install(&self, mut rules: Vec<Rule>) -> BTreeMap<String, String> {
        rules.truncate(MAX_RULES);
        let mut errors = BTreeMap::new();
        let mut active = vec![];
        for r in &rules {
            match compile(r) {
                Ok(c) => active.push(Arc::new(c)),
                Err(e) => {
                    errors.insert(r.id.clone(), e);
                }
            }
        }
        self.delivery.keep_rules(&rules.iter().map(|r| r.id.clone()).collect::<Vec<_>>());
        *self.rules.lock().unwrap() = rules;
        *self.active.write().unwrap() = Arc::new(active);
        errors
    }

    /// Saves `rules` (to the config folder too) and runs the ones that check out. Secret values of headers and
    /// address parts that are gone are removed from the keychain.
    pub fn set_rules(&self, rules: Vec<Rule>) -> Result<BTreeMap<String, String>, String> {
        let mut seen = std::collections::HashSet::new();
        for r in &rules {
            if r.id.trim().is_empty() || !seen.insert(r.id.clone()) {
                return Err("every rule needs its own id".into());
            }
        }
        let keep: std::collections::HashSet<String> = rules.iter().flat_map(secret_names).collect();
        let gone: Vec<String> = self.rules.lock().unwrap().iter().flat_map(secret_names).filter(|n| !keep.contains(n)).collect();
        for n in gone {
            self.secrets.delete(&n);
            self.secret_cache.lock().unwrap().remove(&n);
        }
        // a secret value never goes into the rules file
        let rules: Vec<Rule> = rules.into_iter().map(strip_secrets).collect();
        let errors = self.install(rules.clone());
        if let Some(d) = self.config_dir.lock().unwrap().clone() {
            write_private(&d.join(RULES_FILE), serde_json::to_string_pretty(&json!({ "version": EXPORT_VERSION, "rules": rules })).unwrap().as_bytes())?;
        }
        Ok(errors)
    }

    pub fn rules(&self) -> Vec<Rule> {
        self.rules.lock().unwrap().clone()
    }

    /// Sets (or, empty, removes) the secret value `name` (a header's or an address part's keychain name).
    fn set_secret_named(&self, n: String, value: &str) -> Result<(), String> {
        if value.is_empty() {
            self.secrets.delete(&n);
            self.secret_cache.lock().unwrap().remove(&n);
            return Ok(());
        }
        self.secrets.set(&n, value)?;
        self.secret_cache.lock().unwrap().insert(n, value.to_string());
        Ok(())
    }

    pub fn set_secret(&self, rule: &str, header: &str, value: &str) -> Result<(), String> {
        self.set_secret_named(secret_name(rule, header), value)
    }

    pub fn set_param_secret(&self, rule: &str, param: &str, value: &str) -> Result<(), String> {
        self.set_secret_named(param_secret_name(rule, param), value)
    }

    fn is_set(&self, n: &str) -> bool {
        self.secret_cache.lock().unwrap().contains_key(n) || self.secrets.get(n).is_some()
    }

    /// Which secret values are set ("rule:header" and "rule:?param" -> true / false); never the values.
    pub fn secret_status(&self) -> Value {
        let mut out = serde_json::Map::new();
        for r in self.rules.lock().unwrap().iter() {
            for h in r.headers.iter().filter(|h| h.secret) {
                out.insert(format!("{}:{}", r.id, h.name.to_ascii_lowercase()), json!(self.is_set(&secret_name(&r.id, &h.name))));
            }
            if !r.secret_param.is_empty() {
                out.insert(format!("{}:?{}", r.id, r.secret_param), json!(self.is_set(&param_secret_name(&r.id, &r.secret_param))));
            }
        }
        Value::Object(out)
    }

    /// A message on Studio's MQTT server. Never waits (called on the server's thread); returns how many rules
    /// queued a request.
    pub fn offer(&self, topic: &str, payload: &[u8]) -> usize {
        self.offer_at(topic, payload, chrono::Local::now().fixed_offset())
    }

    pub fn offer_at(&self, topic: &str, payload: &[u8], now: DateTime<FixedOffset>) -> usize {
        let active = self.active.read().unwrap().clone();
        let message = new_message_id();
        let mut queued = 0;
        let mut changed = false;
        for c in active.iter().filter(|c| c.rule.enabled) {
            let Some(captured) = c.pattern.matches(topic) else { continue };
            let id = event_id(&message, &c.rule.id);
            let fired = c.fire(topic, payload, captured, now, &id, &mut self.state.lock().unwrap());
            changed |= c.rule.count.is_some() || c.rule.timer.is_some();
            let at = template::iso(&now);
            let lane = self.delivery.rule(&c.rule.id);
            for n in &fired.notes {
                lane.log(delivery::LogEntry::note(at.clone(), n.clone()));
            }
            if self.delivery.push(&c.rule.id, &id, &at, fired.request) {
                queued += 1;
            }
        }
        if changed {
            self.dirty.notify_one();
            if self.runtime.lock().unwrap().is_none() {
                // no writer task yet (tests without a runtime): write now
                self.save_state();
            }
        }
        queued
    }

    /// Writes counters, timers and the waiting requests (no secret values) to the config folder.
    pub fn save_state(&self) {
        let Some(d) = self.config_dir.lock().unwrap().clone() else { return };
        let text = serde_json::to_string(&*self.state.lock().unwrap()).unwrap_or_default();
        let _ = write_private(&d.join(STATE_FILE), text.as_bytes());
        let waiting = serde_json::to_string(&self.delivery.waiting()).unwrap_or_default();
        let _ = write_private(&d.join(QUEUE_FILE), waiting.as_bytes());
    }

    pub fn state(&self) -> State {
        self.state.lock().unwrap().clone()
    }

    /// The requests waiting to be sent, oldest first.
    pub fn waiting(&self) -> Vec<Job> {
        self.delivery.waiting()
    }

    /// Forgets the counters and timers a rule uses.
    pub fn reset(&self, id: &str) -> Result<(), String> {
        let rule = self.rules.lock().unwrap().iter().find(|r| r.id == id).cloned().ok_or("there is no such rule")?;
        let counters: Vec<String> = rule.count.iter().map(|c| c.name.clone()).collect();
        let timers: Vec<String> = rule.timer.iter().map(|t| t.name.clone()).collect();
        self.state.lock().unwrap().reset(&counters, &timers);
        self.save_state();
        Ok(())
    }

    /// "Send again" on an activity entry.
    pub fn send_again(&self, seq: u64) -> Result<(), String> {
        self.delivery.send_again(seq)
    }

    /// "Test this rule": what a message would do, without changing counters or timers; with `send`, the request is
    /// sent once and its result comes back. Secrets are masked in what is shown.
    pub async fn test(&self, rule: &Rule, topic: &str, payload: &str, send: bool) -> Result<Value, String> {
        let c = compile(rule)?;
        let Some(captured) = c.pattern.matches(topic) else {
            return Ok(json!({ "matched": false, "filter": c.pattern.filter, "warnings": c.warnings }));
        };
        let mut st = self.state.lock().unwrap().clone();
        let id = event_id(&new_message_id(), &c.rule.id);
        let mut fired = c.fire(topic, payload.as_bytes(), captured, chrono::Local::now().fixed_offset(), &id, &mut st);
        for h in fired.request.headers.iter().filter(|h| h.secret.as_deref().is_some_and(|n| !self.is_set(n))) {
            fired.notes.push(format!("warning: the secret value of header {} is not set", h.name));
        }
        if let Some((p, n)) = &fired.request.secret_param {
            if !self.is_set(n) {
                fired.notes.push(format!("warning: the secret part of the address ({p}) is not set"));
            }
        }
        let mut out = json!({ "matched": true, "filter": c.pattern.filter, "variables": fired.captured, "request": fired.request.masked(), "notes": fired.notes, "warnings": c.warnings });
        if send {
            out["result"] = outcome_json(self.delivery.send_now(&fired.request).await);
        }
        Ok(out)
    }

    pub fn status(&self) -> Value {
        let errors: BTreeMap<String, String> = self.rules.lock().unwrap().iter().filter_map(|r| compile(r).err().map(|e| (r.id.clone(), e))).collect();
        let st = self.state.lock().unwrap();
        let mut rules = serde_json::Map::new();
        for r in self.rules.lock().unwrap().iter() {
            let mut v = self.delivery.status(&r.id);
            if let Some(e) = errors.get(&r.id) {
                v["problem"] = json!(e);
            }
            if let Some(c) = &r.count {
                v["counts"] = json!(st.counters.get(&c.name).cloned().unwrap_or_default());
            }
            if let Some(t) = &r.timer {
                let open: BTreeMap<String, usize> = st.timers.get(&t.name).map(|m| m.iter().map(|(k, v)| (k.clone(), v.open.len())).collect()).unwrap_or_default();
                v["open_starts"] = json!(open);
            }
            rules.insert(r.id.clone(), v);
        }
        json!({ "rules": rules })
    }

    /// The rules as JSON to keep or move to another computer: no secret values.
    pub fn export(&self) -> Value {
        json!({ "specter_automation": EXPORT_VERSION, "rules": self.rules().into_iter().map(strip_secrets).collect::<Vec<_>>() })
    }

    /// Adds exported rules (a rule whose id is taken gets a new one); returns the rules now saved and the problems.
    pub fn import(&self, text: &str) -> Result<Value, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("This is not an exported rules file ({e})."))?;
        let list = v.get("rules").cloned().unwrap_or(v);
        let incoming: Vec<Rule> = serde_json::from_value(list).map_err(|e| format!("These rules cannot be read: {e}"))?;
        let mut rules = self.rules();
        for (i, mut r) in incoming.into_iter().enumerate() {
            if r.id.is_empty() || rules.iter().any(|x| x.id == r.id) {
                r.id = format!("{}-{}-{i}", if r.id.is_empty() { "rule" } else { &r.id }, chrono::Local::now().timestamp_millis());
            }
            rules.push(strip_secrets(r));
        }
        let errors = self.set_rules(rules)?;
        Ok(json!({ "rules": self.rules(), "errors": errors }))
    }

    pub async fn dispatch(self: &Arc<Self>, cmd: &str, a: &Value) -> Result<Value, String> {
        self.ensure_started();
        let rule = || serde_json::from_value::<Rule>(a["rule"].clone()).map_err(|e| format!("rule: {e}"));
        match cmd {
            "automation_get" => {
                let errors: BTreeMap<String, String> = self.rules().iter().filter_map(|r| compile(r).err().map(|e| (r.id.clone(), e))).collect();
                Ok(json!({ "rules": self.rules(), "errors": errors, "secrets": self.secret_status(), "saved": self.config_dir.lock().unwrap().is_some() }))
            }
            "automation_set" => {
                let rules: Vec<Rule> = serde_json::from_value(a["rules"].clone()).map_err(|e| format!("rules: {e}"))?;
                let errors = self.set_rules(rules)?;
                let me = self.clone();
                let _ = tokio::task::spawn_blocking(move || me.load_secrets()).await;
                Ok(json!({ "errors": errors }))
            }
            "automation_check" => {
                let c = compile(&rule()?)?;
                Ok(json!({ "filter": c.pattern.filter, "names": c.pattern.names, "warnings": c.warnings }))
            }
            "automation_test" => self.test(&rule()?, a["topic"].as_str().unwrap_or(""), a["payload"].as_str().unwrap_or(""), a["send"].as_bool().unwrap_or(false)).await,
            "automation_status" => Ok(self.status()),
            "automation_reset" => self.reset(a["id"].as_str().ok_or("missing \"id\"")?).map(|_| json!(null)),
            "automation_resend" => self.send_again(a["seq"].as_u64().ok_or("missing \"seq\"")?).map(|_| json!(null)),
            "automation_export" => Ok(self.export()),
            "automation_import" => self.import(a["text"].as_str().ok_or("missing \"text\"")?),
            "automation_examples" => Ok(examples()),
            "automation_secret_set" => {
                // {rule, header, value}: a secret header value; {rule, param, value}: the secret part of the address
                let r = a["rule"].as_str().ok_or("missing \"rule\"")?.to_string();
                let v = a["value"].as_str().unwrap_or("").to_string();
                let name = match (a["header"].as_str(), a["param"].as_str()) {
                    (Some(h), _) => secret_name(&r, h),
                    (None, Some(p)) => param_secret_name(&r, p),
                    _ => return Err("missing \"header\" or \"param\"".into()),
                };
                let me = self.clone();
                tokio::task::spawn_blocking(move || me.set_secret_named(name, &v)).await.map_err(|e| e.to_string())??;
                Ok(json!(null))
            }
            "automation_secret_status" => {
                let me = self.clone();
                tokio::task::spawn_blocking(move || {
                    let bridge = me.secrets.get("bridge-password").is_some();
                    json!({ "bridge": bridge, "headers": me.secret_status() })
                })
                .await
                .map_err(|e| e.to_string())
            }
            _ => Err(format!("unknown command {cmd}")),
        }
    }
}

/// A rule without any secret value (only which headers are secret, and the secret address part's name).
pub fn strip_secrets(mut r: Rule) -> Rule {
    for h in r.headers.iter_mut().filter(|h| h.secret) {
        h.value.clear();
    }
    r
}

/// Where a ready-made rule sends until the person pastes their own address.
pub const EXAMPLE_URL: &str = "https://script.google.com/macros/s/PASTE-YOUR-SCRIPT-ID/exec";

fn example_rule(id: &str, name: &str, pattern: &str, body: &str, count: Option<CountSpec>, timer: Option<TimerSpec>) -> Rule {
    Rule { id: id.into(), name: name.into(), enabled: false, pattern: pattern.into(), method: "POST".into(), url: EXAMPLE_URL.into(), headers: vec![], body: body.into(), content_type: ContentType::Csv, count, timer, secret_param: "key".into() }
}

/// "New from example": rule sets for three common cases, each a start rule and a complete rule sending CSV lines
/// (to a Google Sheet through an Apps Script web app, README "Automation"). Each line starts with `{event_id}`, so
/// the script can skip a row it already has. They start switched off, until the person pastes their own web
/// address (and sets the secret `key` the script checks).
pub fn examples() -> Value {
    // each set has its own timer, so two sets can be added side by side
    let timer = |name: &str, role, pairing| Some(TimerSpec { role, name: name.into(), per: "roomName".into(), pairing });
    let count = |direction| Some(CountSpec { direction, name: "inside".into(), by: "{payload.people}".into(), per: "roomName".into() });
    json!([
        {
            "id": "escape-room",
            "title": "Escape room: one group at a time",
            "description": "Logs when each group started and finished, how many people, and the time taken. A finish belongs to the latest start in that room.",
            "rules": [
                example_rule("escape-room-start", "Escape room: group starts", "checkin/*/{roomName}/start", "{event_id},{roomName},start,{timestamp},{sequence},{payload.people}", None, timer("escape_room", TimerRole::Start, Pairing::Latest)),
                example_rule("escape-room-complete", "Escape room: group finishes", "checkin/*/{roomName}/complete", "{event_id},{roomName},complete,{started_at},{timestamp},{elapsed_text},{payload.people}", None, timer("escape_room", TimerRole::Complete, Pairing::Latest)),
            ],
        },
        {
            "id": "haunted-house",
            "title": "Haunted house: groups go through in order",
            "description": "Logs each group's start and finish in order (first in, first out) with its group number and the time it took.",
            "rules": [
                example_rule("haunted-house-start", "Haunted house: group enters", "checkin/*/{roomName}/start", "{event_id},{roomName},start,{sequence},{timestamp},{payload.people}", None, timer("haunted_house", TimerRole::Start, Pairing::FirstInFirstOut)),
                example_rule("haunted-house-complete", "Haunted house: group leaves", "checkin/*/{roomName}/complete", "{event_id},{roomName},complete,{sequence},{started_at},{timestamp},{elapsed_text}", None, timer("haunted_house", TimerRole::Complete, Pairing::FirstInFirstOut)),
            ],
        },
        {
            "id": "maze",
            "title": "Maze: many people inside at once",
            "description": "Counts how many people are inside each area at any moment (up on start, down on complete, by the message's people, else 1).",
            "rules": [
                example_rule("maze-start", "Maze: people enter", "checkin/*/{roomName}/start", "{event_id},{roomName},entered,{timestamp},{count.inside[roomName]}", count(CountDirection::Up), None),
                example_rule("maze-complete", "Maze: people leave", "checkin/*/{roomName}/complete", "{event_id},{roomName},left,{timestamp},{count.inside[roomName]}", count(CountDirection::Down), None),
            ],
        },
    ])
}
