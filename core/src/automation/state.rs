//! What rules remember between messages: counters ("how many people are inside") and timers ("how long did
//! this group take"). Kept in memory and written to Studio's config folder, so a restart loses nothing.
//!
//! * A counter has a name and, optionally, one value per key (`inside` for each `roomName`). It never goes
//!   below 0.
//! * A timer has a name; a start rule marks a time for a key, a complete rule finds the start it belongs to:
//!   the latest one ("one group at a time", an escape room) or the oldest still open ("in order, first in
//!   first out", a haunted house). Every start gets a group number for its key that begins again at 1 each day.

use super::template::TimerValues;
use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};

/// Starts kept per timer and key while waiting for their complete; the oldest go first beyond this.
pub const MAX_OPEN_STARTS_PER_KEY: usize = 200;
/// Keys per counter or timer (each new room name is a key); a message with yet another key is not counted.
pub const MAX_KEYS: usize = 10_000;

/// Which start a complete belongs to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pairing {
    /// the most recent start for that key (one group at a time); older open starts are forgotten
    #[default]
    Latest,
    /// the oldest start still open for that key (groups go through in order)
    FirstInFirstOut,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Start {
    /// RFC 3339
    pub at: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TimerKey {
    pub open: VecDeque<Start>,
    /// the day `seq` counts for (`2026-10-24`)
    pub day: String,
    pub seq: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct State {
    #[serde(default)]
    pub counters: HashMap<String, BTreeMap<String, i64>>,
    #[serde(default)]
    pub timers: HashMap<String, BTreeMap<String, TimerKey>>,
}

impl State {
    /// Adds `delta` to counter `name` for `key` ("" for one value), never below 0; the new value, or an error
    /// in plain words when there are too many keys already.
    pub fn count(&mut self, name: &str, key: &str, delta: i64) -> Result<i64, String> {
        let m = self.counters.entry(name.to_string()).or_default();
        if !m.contains_key(key) && m.len() >= MAX_KEYS {
            return Err(format!("counter {name} already has {MAX_KEYS} different keys; {key} was not counted (reset the rule to start again)"));
        }
        let v = m.entry(key.to_string()).or_insert(0);
        *v = (*v + delta).max(0);
        Ok(*v)
    }

    /// A group starts: its time and its number for today.
    pub fn start(&mut self, name: &str, key: &str, now: DateTime<FixedOffset>) -> Result<TimerValues, String> {
        let m = self.timers.entry(name.to_string()).or_default();
        if !m.contains_key(key) && m.len() >= MAX_KEYS {
            return Err(format!("timer {name} already has {MAX_KEYS} different keys; {key} was not timed (reset the rule to start again)"));
        }
        let k = m.entry(key.to_string()).or_default();
        let today = now.format("%Y-%m-%d").to_string();
        if k.day != today {
            k.day = today;
            k.seq = 0;
        }
        k.seq += 1;
        k.open.push_back(Start { at: super::template::iso(&now), sequence: k.seq });
        while k.open.len() > MAX_OPEN_STARTS_PER_KEY {
            k.open.pop_front();
        }
        Ok(TimerValues { started_at: Some(now), elapsed_ms: None, sequence: Some(k.seq) })
    }

    /// A group finishes: the start it belongs to, or None when there is no open start for that key.
    pub fn complete(&mut self, name: &str, key: &str, now: DateTime<FixedOffset>, pairing: Pairing) -> Option<TimerValues> {
        let k = self.timers.get_mut(name)?.get_mut(key)?;
        let s = match pairing {
            Pairing::Latest => {
                let s = k.open.pop_back();
                k.open.clear();
                s
            }
            Pairing::FirstInFirstOut => k.open.pop_front(),
        }?;
        let at = DateTime::parse_from_rfc3339(&s.at).ok()?;
        Some(TimerValues { started_at: Some(at), elapsed_ms: Some((now - at).num_milliseconds()), sequence: Some(s.sequence) })
    }

    /// Forgets the named counters and timers (every key).
    pub fn reset(&mut self, counters: &[String], timers: &[String]) {
        for c in counters {
            self.counters.remove(c);
        }
        for t in timers {
            self.timers.remove(t);
        }
    }
}
