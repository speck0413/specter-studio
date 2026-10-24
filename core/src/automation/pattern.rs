//! Topic patterns for "When a message arrives on …": MQTT topic levels with names.
//!
//! * levels are split on `/`; a leading `/` means the same as none (`/checkin/a` = `checkin/a`)
//! * `*` (or MQTT's `+`) matches exactly one level
//! * `{name}` matches one level and keeps it as `name` (for `{name}` in the request)
//! * `#` (or `**`) as the last level matches the rest (none or more levels)
//!
//! `checkin/*/{roomName}/complete` compiles to the MQTT filter `checkin/+/+/complete` plus a matcher that hands
//! back `roomName`.

use std::collections::BTreeMap;

/// Names that are always there in a request and so cannot be used for a level.
pub const BUILT_IN: [&str; 12] = ["topic", "payload", "timestamp", "date", "time", "unix", "event_id", "elapsed", "elapsed_text", "started_at", "sequence", "count"];

#[derive(Clone, Debug, PartialEq)]
enum Level {
    Exact(String),
    One,
    Named(String),
    Rest,
}

#[derive(Clone, Debug)]
pub struct Pattern {
    levels: Vec<Level>,
    /// the MQTT subscription filter (`checkin/+/+/complete`)
    pub filter: String,
    /// the captured names, in order
    pub names: Vec<String>,
}

/// A name for `{name}`: a letter or `_`, then letters, digits or `_`.
pub fn valid_name(n: &str) -> bool {
    let mut c = n.chars();
    matches!(c.next(), Some(f) if f.is_ascii_alphabetic() || f == '_') && c.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl Pattern {
    pub fn compile(text: &str) -> Result<Pattern, String> {
        let t = text.trim();
        let t = t.strip_prefix('/').unwrap_or(t);
        if t.is_empty() {
            return Err("Type the topic the message arrives on, for example checkin/*/{roomName}/complete.".into());
        }
        let parts: Vec<&str> = t.split('/').collect();
        let mut levels = vec![];
        let mut names: Vec<String> = vec![];
        for (i, p) in parts.iter().enumerate() {
            let last = i == parts.len() - 1;
            let level = match *p {
                "" => return Err(format!("“{text}” has an empty level (two / in a row, or a / at the end). Remove the extra /.")),
                "*" | "+" => Level::One,
                "#" | "**" => {
                    if !last {
                        return Err(format!("{p} matches the rest of the topic, so it can only be the last level (“{text}”)."));
                    }
                    Level::Rest
                }
                p if p.starts_with('{') && p.ends_with('}') => {
                    let n = &p[1..p.len() - 1];
                    if n.is_empty() {
                        return Err("{} needs a name inside, for example {roomName}.".into());
                    }
                    if !valid_name(n) {
                        return Err(format!("{{{n}}}: a name has letters, digits and _ only, and starts with a letter."));
                    }
                    if BUILT_IN.contains(&n) {
                        return Err(format!("{{{n}}} is already a built-in value; give this level another name."));
                    }
                    if names.iter().any(|x| x == n) {
                        return Err(format!("{{{n}}} is used twice in “{text}”; give each level its own name."));
                    }
                    names.push(n.to_string());
                    Level::Named(n.to_string())
                }
                p if p.contains(['*', '+', '#', '{', '}']) => {
                    return Err(format!("“{p}”: a *, # or {{name}} must be a whole level on its own (between two /)."));
                }
                p => Level::Exact(p.to_string()),
            };
            levels.push(level);
        }
        let filter = levels
            .iter()
            .map(|l| match l {
                Level::Exact(s) => s.as_str(),
                Level::One | Level::Named(_) => "+",
                Level::Rest => "#",
            })
            .collect::<Vec<_>>()
            .join("/");
        Ok(Pattern { levels, filter, names })
    }

    /// The captured names and their levels when `topic` matches (a leading `/` on the topic is ignored too).
    pub fn matches(&self, topic: &str) -> Option<BTreeMap<String, String>> {
        let topic = topic.strip_prefix('/').unwrap_or(topic);
        let t: Vec<&str> = topic.split('/').collect();
        let mut vars = BTreeMap::new();
        for (i, l) in self.levels.iter().enumerate() {
            match l {
                Level::Rest => return Some(vars),
                _ if i >= t.len() => return None,
                Level::Exact(s) if s != t[i] => return None,
                Level::Named(n) => {
                    vars.insert(n.clone(), t[i].to_string());
                }
                _ => {}
            }
        }
        (self.levels.len() == t.len()).then_some(vars)
    }
}

/// Whether `f` is a valid MQTT subscription filter (for the bridge's topic list), in plain words when not.
pub fn check_filter(f: &str) -> Result<(), String> {
    if f.is_empty() {
        return Err("a topic filter is empty".into());
    }
    let parts: Vec<&str> = f.split('/').collect();
    for (i, p) in parts.iter().enumerate() {
        if p.contains('#') && (*p != "#" || i != parts.len() - 1) {
            return Err(format!("“{f}”: # matches the rest, so it can only be the last level on its own"));
        }
        if p.contains('+') && *p != "+" {
            return Err(format!("“{f}”: + must be a whole level on its own"));
        }
    }
    Ok(())
}
