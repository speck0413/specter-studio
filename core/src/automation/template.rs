//! Templates for the web request: the address, header values and the body.
//!
//! `{name}` is a value; everything else is copied as it is, so JSON bodies keep their braces
//! (`{"room": "{roomName}"}`). Only `{` followed by a letter or `_` starts a value; `{{` and `}}` are a literal
//! `{` and `}`. Values:
//!
//! | value | what |
//! |---|---|
//! | `{roomName}` | a level the topic pattern named |
//! | `{topic}`, `{payload}` | the topic, the message as text |
//! | `{payload.people}`, `{payload.group.size}`, `{payload.list.0}` | a field of a JSON message (empty, with a note in the rule's log, when it is missing) |
//! | `{timestamp}` | local time with the offset, ISO 8601 (`2026-10-24T21:04:05-05:00`) |
//! | `{date}`, `{time}`, `{unix}` | `2026-10-24`, `21:04:05`, seconds since 1970 |
//! | `{event_id}` | a unique id for this message and rule, the same when the request is sent again |
//! | `{elapsed}`, `{elapsed_text}`, `{started_at}`, `{sequence}` | timers (rules with a timer only) |
//! | `{count.inside}`, `{count.inside[roomName]}` | a counter, or its value for this message's `roomName` |
//!
//! Values are escaped for where they go: CSV quoting, JSON string escaping, URL encoding (address and form
//! bodies), and no line breaks in header values.

use super::pattern::valid_name;
use chrono::{DateTime, FixedOffset, SecondsFormat};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Debug, PartialEq)]
pub enum Var {
    Captured(String),
    Topic,
    Payload,
    Field(Vec<String>),
    Timestamp,
    Date,
    Time,
    Unix,
    EventId,
    Elapsed,
    ElapsedText,
    StartedAt,
    Sequence,
    Count { name: String, key: Option<String> },
}

#[derive(Clone, Debug, PartialEq)]
enum Part {
    Text(String),
    Var(Var, String),
}

/// How values are escaped.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Escape {
    /// header values: line breaks removed
    Header,
    /// one CSV field: quoted when it holds a comma, quote, line break or edge space; a value a spreadsheet would
    /// read as a formula (`=`, `+`, `-`, `@` and not a number) gets a leading `'`
    Csv,
    /// inside a JSON string (or a bare number): JSON escaping without the quotes
    Json,
    /// a web address or a form body: URL encoding
    Url,
}

#[derive(Clone, Debug)]
pub struct Template {
    parts: Vec<Part>,
}

fn ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn parse_var(inner: &str) -> Result<Var, String> {
    let bad = || format!("{{{inner}}} is not a value Studio knows. See the list of values under the body.");
    if let Some(rest) = inner.strip_prefix("count.") {
        let (name, key) = match rest.split_once('[') {
            Some((n, k)) => {
                let k = k.strip_suffix(']').ok_or_else(|| format!("{{{inner}}}: close the [ with ], for example {{count.inside[roomName]}}."))?;
                (n, Some(k.to_string()))
            }
            None => (rest, None),
        };
        if !valid_name(name) || key.as_deref().is_some_and(|k| !valid_name(k)) {
            return Err(format!("{{{inner}}}: write a counter as {{count.inside}} or {{count.inside[roomName]}}."));
        }
        return Ok(Var::Count { name: name.into(), key });
    }
    if let Some(rest) = inner.strip_prefix("payload.") {
        let path: Vec<String> = rest.split('.').map(String::from).collect();
        if path.iter().any(|p| p.is_empty() || !p.chars().all(ident_char)) {
            return Err(format!("{{{inner}}}: a field is written like {{payload.people}} or {{payload.group.size}}."));
        }
        return Ok(Var::Field(path));
    }
    Ok(match inner {
        "topic" => Var::Topic,
        "payload" => Var::Payload,
        "timestamp" => Var::Timestamp,
        "date" => Var::Date,
        "time" => Var::Time,
        "unix" => Var::Unix,
        "event_id" => Var::EventId,
        "elapsed" => Var::Elapsed,
        "elapsed_text" => Var::ElapsedText,
        "started_at" => Var::StartedAt,
        "sequence" => Var::Sequence,
        n if valid_name(n) => Var::Captured(n.into()),
        _ => return Err(bad()),
    })
}

impl Template {
    pub fn parse(text: &str) -> Result<Template, String> {
        let mut parts = vec![];
        let mut lit = String::new();
        let mut it = text.char_indices().peekable();
        while let Some((i, c)) = it.next() {
            match c {
                '{' if it.peek().map(|p| p.1) == Some('{') => {
                    it.next();
                    lit.push('{');
                }
                '}' if it.peek().map(|p| p.1) == Some('}') => {
                    it.next();
                    lit.push('}');
                }
                '{' if it.peek().is_some_and(|p| p.1.is_ascii_alphabetic() || p.1 == '_') => {
                    let rest = &text[i + 1..];
                    let end = rest.find('}').filter(|&e| !rest[..e].contains(['{', '\n', ' ', '"']));
                    let Some(end) = end else {
                        let shown: String = rest.chars().take_while(|c| ident_char(*c) || *c == '.').collect();
                        return Err(format!("{{{shown} is missing its closing }}."));
                    };
                    let inner = &rest[..end];
                    let v = parse_var(inner)?;
                    if !lit.is_empty() {
                        parts.push(Part::Text(std::mem::take(&mut lit)));
                    }
                    parts.push(Part::Var(v, inner.to_string()));
                    for _ in 0..inner.chars().count() + 1 {
                        it.next();
                    }
                }
                c => lit.push(c),
            }
        }
        if !lit.is_empty() {
            parts.push(Part::Text(lit));
        }
        Ok(Template { parts })
    }

    pub fn vars(&self) -> impl Iterator<Item = (&Var, &str)> {
        self.parts.iter().filter_map(|p| match p {
            Part::Var(v, s) => Some((v, s.as_str())),
            _ => None,
        })
    }

    /// Every value is one this rule has: `captured` names from its pattern, timers only with a timer.
    pub fn check(&self, captured: &[String], has_timer: bool) -> Result<(), String> {
        for (v, text) in self.vars() {
            match v {
                Var::Captured(n) if !captured.contains(n) => {
                    return Err(if captured.is_empty() {
                        format!("{{{n}}} is not in the topic pattern. Name a level in the pattern, for example checkin/*/{{{n}}}/complete.")
                    } else {
                        format!("{{{n}}} is not in the topic pattern (it names: {}).", captured.join(", "))
                    });
                }
                Var::Count { key: Some(k), .. } if !captured.contains(k) => {
                    return Err(format!("{{{text}}}: {k} is not a name in the topic pattern."));
                }
                Var::Elapsed | Var::ElapsedText | Var::StartedAt | Var::Sequence if !has_timer => {
                    return Err(format!("{{{text}}} comes from a timer: turn on “Time each group” for this rule first."));
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// `(text, notes)`: the notes say which values were empty and why (for the rule's log).
    pub fn render(&self, cx: &Context, esc: Escape) -> (String, Vec<String>) {
        let mut out = String::new();
        let mut notes = vec![];
        for p in &self.parts {
            match p {
                Part::Text(t) => out.push_str(t),
                Part::Var(v, text) => {
                    let raw = cx.value(v, text, &mut notes);
                    out.push_str(&escape(&raw, esc));
                }
            }
        }
        (out, notes)
    }

    /// The template with stand-ins: text values as `x`, values that may be numbers as `0` (to check that a JSON
    /// body is JSON whatever the message brings).
    pub fn sample(&self) -> String {
        self.parts
            .iter()
            .map(|p| match p {
                Part::Text(t) => t.clone(),
                Part::Var(Var::Field(_) | Var::Count { .. } | Var::Elapsed | Var::Sequence | Var::Unix, _) => "0".into(),
                Part::Var(..) => "x".into(),
            })
            .collect()
    }

    /// For the address: no value before the path (the server is fixed when the rule is saved).
    pub fn check_url(&self) -> Result<(), String> {
        let mut seen = String::new();
        for p in &self.parts {
            match p {
                Part::Text(t) => seen.push_str(t),
                Part::Var(_, text) => {
                    let after_host = seen.split_once("://").is_some_and(|(_, rest)| rest.contains(['/', '?']));
                    if !after_host {
                        return Err(format!("{{{text}}} can only go after the server's address (in the path or after ?), never in the server name."));
                    }
                }
            }
        }
        let lower = seen.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) || seen.len() < 9 {
            return Err("The web address starts with https:// (or http://), for example https://script.google.com/macros/s/…/exec.".into());
        }
        Ok(())
    }
}

/// What a message brings to its request.
pub struct Context<'a> {
    pub topic: &'a str,
    pub payload: &'a str,
    pub json: Option<Value>,
    pub captured: &'a BTreeMap<String, String>,
    pub now: DateTime<FixedOffset>,
    /// unique per message and rule
    pub event_id: &'a str,
    pub timer: Option<TimerValues>,
    pub counts: &'a HashMap<String, BTreeMap<String, i64>>,
}

/// A timer's values for one message (all empty for a complete without a start).
#[derive(Clone, Debug, Default)]
pub struct TimerValues {
    pub started_at: Option<DateTime<FixedOffset>>,
    pub elapsed_ms: Option<i64>,
    pub sequence: Option<u64>,
}

/// `12 min 05 s`, `45 s`, `1 h 02 min 05 s`.
pub fn elapsed_text(ms: i64) -> String {
    let s = (ms.max(0) + 500) / 1000;
    let (h, m, s) = (s / 3600, s / 60 % 60, s % 60);
    if h > 0 {
        format!("{h} h {m:02} min {s:02} s")
    } else if m > 0 {
        format!("{m} min {s:02} s")
    } else {
        format!("{s} s")
    }
}

pub fn iso(t: &DateTime<FixedOffset>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, false)
}

impl Context<'_> {
    fn value(&self, v: &Var, text: &str, notes: &mut Vec<String>) -> String {
        let t = self.timer.as_ref();
        match v {
            Var::Captured(n) => self.captured.get(n).cloned().unwrap_or_default(),
            Var::Topic => self.topic.to_string(),
            Var::Payload => self.payload.to_string(),
            Var::Field(path) => {
                let Some(mut cur) = self.json.as_ref() else {
                    notes.push(format!("the message is not JSON, so {{{text}}} is empty"));
                    return String::new();
                };
                for k in path {
                    let next = match cur {
                        Value::Object(m) => m.get(k),
                        Value::Array(a) => k.parse::<usize>().ok().and_then(|i| a.get(i)),
                        _ => None,
                    };
                    match next {
                        Some(n) => cur = n,
                        None => {
                            notes.push(format!("the message has no {}, so {{{text}}} is empty", path.join(".")));
                            return String::new();
                        }
                    }
                }
                match cur {
                    Value::String(s) => s.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                }
            }
            Var::Timestamp => iso(&self.now),
            Var::Date => self.now.format("%Y-%m-%d").to_string(),
            Var::Time => self.now.format("%H:%M:%S").to_string(),
            Var::Unix => self.now.timestamp().to_string(),
            Var::EventId => self.event_id.to_string(),
            Var::Elapsed => t.and_then(|t| t.elapsed_ms).map(|ms| ((ms + 500) / 1000).to_string()).unwrap_or_default(),
            Var::ElapsedText => t.and_then(|t| t.elapsed_ms).map(elapsed_text).unwrap_or_default(),
            Var::StartedAt => t.and_then(|t| t.started_at.as_ref()).map(iso).unwrap_or_default(),
            Var::Sequence => t.and_then(|t| t.sequence).map(|n| n.to_string()).unwrap_or_default(),
            Var::Count { name, key } => {
                let k = key.as_ref().and_then(|k| self.captured.get(k)).map(String::as_str).unwrap_or("");
                self.counts.get(name).and_then(|m| m.get(k)).copied().unwrap_or(0).to_string()
            }
        }
    }
}

/// `s` escaped for `esc`.
pub fn escape(s: &str, esc: Escape) -> String {
    match esc {
        Escape::Header => s.replace(['\r', '\n'], " "),
        Escape::Json => {
            let q = serde_json::to_string(s).unwrap_or_default();
            q[1..q.len() - 1].to_string()
        }
        Escape::Url => {
            let mut o = String::new();
            for b in s.bytes() {
                if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                    o.push(b as char);
                } else {
                    o.push_str(&format!("%{b:02X}"));
                }
            }
            o
        }
        Escape::Csv => {
            let formula = s.starts_with(['=', '+', '-', '@', '\t', '\r']) && s.trim().parse::<f64>().is_err();
            let s = if formula { format!("'{s}") } else { s.to_string() };
            if s.contains([',', '"', '\n', '\r']) || s.starts_with(' ') || s.ends_with(' ') {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s
            }
        }
    }
}
