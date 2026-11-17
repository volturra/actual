//! Hybrid Unique Logical Clock timestamps, ported from
//! `packages/crdt/src/crdt/timestamp.ts`.
//!
//! Timestamps serialize into a 46-character collatable string such as
//! `2015-04-24T22:23:42.123Z-1000-0123456789ABCDEF`. String order is time
//! order, which the rest of the sync code relies on.

use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};

use crate::merkle::Trie;
use crate::murmur::murmur3_32;

/// Maximum clock drift allowed between nodes (5 minutes, as in Actual).
pub const MAX_DRIFT_MS: i64 = 5 * 60 * 1000;
pub const MAX_COUNTER: u32 = 0xFFFF;
pub const MAX_NODE_LENGTH: usize = 16;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ClockError {
    #[error("maximum clock drift exceeded")]
    Drift,
    #[error("timestamp counter overflow")]
    Overflow,
    #[error("timestamp is not valid: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Timestamp {
    millis: i64,
    counter: u32,
    node: String,
}

impl Timestamp {
    pub fn new(millis: i64, counter: u32, node: impl Into<String>) -> Self {
        Timestamp { millis, counter, node: node.into() }
    }

    pub fn millis(&self) -> i64 {
        self.millis
    }

    pub fn counter(&self) -> u32 {
        self.counter
    }

    pub fn node(&self) -> &str {
        &self.node
    }

    pub fn zero() -> Self {
        Timestamp::new(0, 0, "0000000000000000")
    }

    /// `Timestamp.since(iso)`: the smallest timestamp at a given instant.
    pub fn since_millis(millis: i64) -> String {
        Timestamp::new(millis, 0, "0").to_string()
    }

    /// The 32-bit murmur3 hash of the string form, used in the merkle trie.
    pub fn hash(&self) -> u32 {
        murmur3_32(self.to_string().as_bytes(), 0)
    }

    /// Parses the fixed-length string form. Mirrors `Timestamp.parse`.
    pub fn parse(s: &str) -> Option<Timestamp> {
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() != 5 {
            return None;
        }
        let date = parts[0..3].join("-");
        let millis = DateTime::parse_from_rfc3339(&date)
            .ok()?
            .with_timezone(&Utc)
            .timestamp_millis();
        if millis < 0 {
            return None;
        }
        let counter = u32::from_str_radix(parts[3], 16).ok()?;
        let node = parts[4];
        if counter > MAX_COUNTER || node.len() > MAX_NODE_LENGTH {
            return None;
        }
        Some(Timestamp::new(millis, counter, node))
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let date = DateTime::<Utc>::from_timestamp_millis(self.millis)
            .unwrap_or_default()
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let node = format!("{:0>16}", self.node);
        let node = &node[node.len() - 16..];
        write!(f, "{}-{:04X}-{}", date, self.counter & 0xFFFF, node)
    }
}

impl PartialOrd for Timestamp {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Timestamp {
    /// Ordered like Actual orders them: by string form.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.to_string().cmp(&other.to_string())
    }
}

/// The per-budget clock: the latest timestamp and the merkle trie of every
/// message this node has seen. Serialized into `messages_clock`.
#[derive(Clone, Debug)]
pub struct Clock {
    pub timestamp: Timestamp,
    pub merkle: Trie,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SerializedClock {
    timestamp: String,
    merkle: Trie,
}

impl Clock {
    pub fn new(timestamp: Timestamp, merkle: Trie) -> Self {
        Clock { timestamp, merkle }
    }

    pub fn serialize(&self) -> String {
        serde_json::to_string(&SerializedClock {
            timestamp: self.timestamp.to_string(),
            merkle: self.merkle.clone(),
        })
        .expect("clock serializes")
    }

    /// Mirrors `deserializeClock`: unparseable JSON yields a zero clock with
    /// a fresh node id; a parseable clock with a bad timestamp is an error.
    pub fn deserialize(s: &str) -> Result<Clock, ClockError> {
        match serde_json::from_str::<SerializedClock>(s) {
            Ok(data) => {
                let ts = Timestamp::parse(&data.timestamp)
                    .ok_or(ClockError::Invalid(data.timestamp))?;
                Ok(Clock::new(ts, data.merkle))
            }
            Err(_) => Ok(Clock::new(Timestamp::new(0, 0, make_client_id()), Trie::default())),
        }
    }

    /// `Timestamp.send()`: a new unique, monotonic timestamp for a local change.
    pub fn send(&mut self, now_ms: i64) -> Result<Timestamp, ClockError> {
        let l_old = self.timestamp.millis;
        let c_old = self.timestamp.counter;
        let l_new = l_old.max(now_ms);
        let c_new = if l_old == l_new { c_old + 1 } else { 0 };
        if l_new - now_ms > MAX_DRIFT_MS {
            return Err(ClockError::Drift);
        }
        if c_new > MAX_COUNTER {
            return Err(ClockError::Overflow);
        }
        self.timestamp.millis = l_new;
        self.timestamp.counter = c_new;
        Ok(self.timestamp.clone())
    }

    /// `Timestamp.recv()`: merge a remote timestamp into the local clock.
    pub fn recv(&mut self, msg: &Timestamp, now_ms: i64) -> Result<Timestamp, ClockError> {
        let l_msg = msg.millis;
        let c_msg = msg.counter;
        if l_msg - now_ms > MAX_DRIFT_MS {
            return Err(ClockError::Drift);
        }
        let l_old = self.timestamp.millis;
        let c_old = self.timestamp.counter;
        let l_new = l_old.max(now_ms).max(l_msg);
        let c_new = if l_new == l_old && l_new == l_msg {
            c_old.max(c_msg) + 1
        } else if l_new == l_old {
            c_old + 1
        } else if l_new == l_msg {
            c_msg + 1
        } else {
            0
        };
        if l_new - now_ms > MAX_DRIFT_MS {
            return Err(ClockError::Drift);
        }
        if c_new > MAX_COUNTER {
            return Err(ClockError::Overflow);
        }
        self.timestamp.millis = l_new;
        self.timestamp.counter = c_new;
        Ok(self.timestamp.clone())
    }
}

/// A new random 16-hex-char node id (`makeClientId`).
pub fn make_client_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    id[id.len() - 16..].to_string()
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for s in [
            "2015-04-24T22:23:42.123Z-1000-0123456789ABCDEF",
            "1970-01-01T00:00:00.000Z-0000-0000000000000000",
            "9999-12-31T23:59:59.999Z-FFFF-FFFFFFFFFFFFFFFF",
        ] {
            assert_eq!(Timestamp::parse(s).unwrap().to_string(), s);
        }
    }

    #[test]
    fn pads_node_and_counter() {
        let ts = Timestamp::new(0, 1, "abc");
        assert_eq!(ts.to_string(), "1970-01-01T00:00:00.000Z-0001-0000000000000abc");
    }

    #[test]
    fn rejects_invalid() {
        assert!(Timestamp::parse("").is_none());
        assert!(Timestamp::parse("2015-04-24T22:23:42.123Z-10000-0123456789ABCDEF").is_none());
        assert!(Timestamp::parse("2015-04-24T22:23:42.123Z-1000-0123456789ABCDEF0").is_none());
        assert!(Timestamp::parse("notadate-xx-yy-1000-0123456789ABCDEF").is_none());
    }

    #[test]
    fn hash_matches_js() {
        // From packages/crdt merkle snapshot: a single insert's hash.
        let ts = Timestamp::parse("2018-11-12T13:21:40.122Z-0000-0123456789ABCDEF").unwrap();
        assert_eq!(ts.hash() as i32, 1983295247);
    }

    #[test]
    fn send_is_monotonic() {
        let mut clock = Clock::new(Timestamp::new(0, 0, "node"), Trie::default());
        let a = clock.send(1000).unwrap();
        let b = clock.send(1000).unwrap();
        let c = clock.send(999).unwrap();
        assert!(a < b && b < c);
        assert_eq!(b.counter(), 1);
        assert_eq!(c.millis(), 1000);
        assert_eq!(c.counter(), 2);
    }

    #[test]
    fn recv_merges() {
        let mut clock = Clock::new(Timestamp::new(1000, 5, "a"), Trie::default());
        let remote = Timestamp::new(2000, 3, "b");
        let t = clock.recv(&remote, 1500).unwrap();
        assert_eq!((t.millis(), t.counter()), (2000, 4));
        assert_eq!(t.node(), "a");
        assert_eq!(
            clock.recv(&Timestamp::new(1_000_000_000, 0, "b"), 0),
            Err(ClockError::Drift)
        );
    }

    #[test]
    fn counter_overflow() {
        let mut clock = Clock::new(Timestamp::new(1000, 0xFFFF, "a"), Trie::default());
        assert_eq!(clock.send(1000), Err(ClockError::Overflow));
    }
}
