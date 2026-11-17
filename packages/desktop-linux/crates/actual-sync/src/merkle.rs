//! The base-3 merkle radix trie keyed by message minute, ported from
//! `packages/crdt/src/crdt/merkle.ts`. Two nodes compare root hashes to tell
//! whether they've seen the same messages, and `diff` finds the earliest
//! minute where they differ so only messages since then are re-sent.
//!
//! Hashes behave like the JavaScript original: XOR of unsigned murmur3 hashes
//! coerced to signed 32-bit integers. A node may have no hash at all (the
//! `{}` of a fresh clock), which is distinct from a zero hash in `diff`.

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};

use crate::timestamp::Timestamp;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Trie {
    pub hash: Option<i32>,
    pub children: [Option<Box<Trie>>; 3],
}

impl Trie {
    /// `emptyTrie()`: `{ hash: 0 }`.
    pub fn empty() -> Trie {
        Trie { hash: Some(0), children: Default::default() }
    }

    fn child(&self, k: usize) -> Option<&Trie> {
        self.children[k].as_deref()
    }

    fn keys(&self) -> impl Iterator<Item = usize> + '_ {
        (0..3).filter(|&k| self.children[k].is_some())
    }

    pub fn root_hash(&self) -> i32 {
        self.hash.unwrap_or(0)
    }

    /// Inserts a timestamp, XOR-ing its hash into every node on its path.
    pub fn insert(&mut self, timestamp: &Timestamp) {
        let hash = timestamp.hash() as i32;
        let minutes = timestamp.millis().div_euclid(1000 * 60);
        let key = to_base3(minutes);
        self.hash = Some(self.hash.unwrap_or(0) ^ hash);
        let mut node = self;
        for c in key.bytes() {
            let k = (c - b'0') as usize;
            let child = node.children[k].get_or_insert_with(|| Box::new(Trie::default()));
            child.hash = Some(child.hash.unwrap_or(0) ^ hash);
            node = child;
        }
    }

    pub fn build<'a>(timestamps: impl IntoIterator<Item = &'a Timestamp>) -> Trie {
        let mut trie = Trie::empty();
        for ts in timestamps {
            trie.insert(ts);
        }
        trie
    }

    /// Keeps only the newest `n` children at every level, like `prune`.
    /// A node with a falsy hash is returned as-is (children included).
    pub fn prune(&self, n: usize) -> Trie {
        if self.hash.unwrap_or(0) == 0 {
            return self.clone();
        }
        let keys: Vec<usize> = self.keys().collect();
        let keep = &keys[keys.len().saturating_sub(n)..];
        let mut next = Trie { hash: self.hash, children: Default::default() };
        for &k in keep {
            next.children[k] = Some(Box::new(self.child(k).expect("key exists").prune(n)));
        }
        next
    }
}

/// `merkle.diff`: the millisecond time to sync from, or `None` if equal.
pub fn diff(trie1: &Trie, trie2: &Trie) -> Option<i64> {
    if trie1.hash == trie2.hash {
        return None;
    }
    let mut node1 = trie1.clone();
    let mut node2 = trie2.clone();
    let mut k = String::new();
    loop {
        let mut diffkey = None;
        for key in 0..3 {
            if node1.children[key].is_none() && node2.children[key].is_none() {
                continue;
            }
            let (Some(n1), Some(n2)) = (node1.child(key), node2.child(key)) else {
                break;
            };
            if n1.hash != n2.hash {
                diffkey = Some(key);
                break;
            }
        }
        let Some(dk) = diffkey else {
            return Some(key_to_timestamp(&k));
        };
        k.push((b'0' + dk as u8) as char);
        node1 = node1.child(dk).cloned().unwrap_or_else(Trie::empty);
        node2 = node2.child(dk).cloned().unwrap_or_else(Trie::empty);
    }
}

pub fn key_to_timestamp(key: &str) -> i64 {
    let mut full = key.to_string();
    while full.len() < 16 {
        full.push('0');
    }
    i64::from_str_radix(&full, 3).unwrap_or(0) * 1000 * 60
}

fn to_base3(mut n: i64) -> String {
    if n <= 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(b'0' + (n % 3) as u8);
        n /= 3;
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii")
}

impl Serialize for Trie {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let len = self.keys().count() + usize::from(self.hash.is_some());
        let mut map = serializer.serialize_map(Some(len))?;
        for k in self.keys() {
            map.serialize_entry(&k.to_string(), self.child(k).expect("key exists"))?;
        }
        if let Some(h) = self.hash {
            map.serialize_entry("hash", &h)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Trie {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Trie, D::Error> {
        struct TrieVisitor;
        impl<'de> Visitor<'de> for TrieVisitor {
            type Value = Trie;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a merkle trie node")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Trie, A::Error> {
                let mut trie = Trie::default();
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "hash" => {
                            // JS may have serialized `null`; also accept floats.
                            let v: serde_json::Value = map.next_value()?;
                            trie.hash = match v {
                                serde_json::Value::Number(n) => {
                                    Some(n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0) as i32)
                                }
                                _ => None,
                            };
                        }
                        "0" | "1" | "2" => {
                            let k = (key.as_bytes()[0] - b'0') as usize;
                            trie.children[k] = Some(Box::new(map.next_value()?));
                        }
                        _ => {
                            let _: de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(trie)
            }
        }
        deserializer.deserialize_map(TrieVisitor)
    }
}

/// Debug view (`merkle.debug`), handy in logs.
pub fn debug(trie: &Trie) -> String {
    fn go(t: &Trie, k: &str, indent: usize, out: &mut String) {
        out.push_str(&" ".repeat(indent));
        if !k.is_empty() {
            out.push_str(&format!("k: {k} "));
        }
        match t.hash {
            Some(h) if h != 0 => out.push_str(&format!("hash: {h}\n")),
            _ => out.push_str("hash: (empty)\n"),
        }
        for c in t.keys() {
            go(t.child(c).expect("key"), &c.to_string(), indent + 2, out);
        }
    }
    let mut out = String::new();
    go(trie, "", 0, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    #[test]
    fn insert_matches_js_snapshot_hashes() {
        let mut trie = Trie::empty();
        trie.insert(&ts("2018-11-12T13:21:40.122Z-0000-0123456789ABCDEF"));
        assert_eq!(trie.hash, Some(1983295247));
        trie.insert(&ts("2018-11-13T13:21:40.122Z-0000-0123456789ABCDEF"));
        // Both paths share the top digits; the root carries the XOR.
        let h2 = ts("2018-11-13T13:21:40.122Z-0000-0123456789ABCDEF").hash() as i32;
        assert_eq!(trie.hash, Some(1983295247 ^ h2));
        let c1 = trie.children[1].as_ref().unwrap();
        assert_eq!(c1.hash, trie.hash);
    }

    #[test]
    fn json_roundtrip() {
        let mut trie = Trie::empty();
        trie.insert(&ts("2018-11-12T13:21:40.122Z-0000-0123456789ABCDEF"));
        let json = serde_json::to_string(&trie).unwrap();
        let back: Trie = serde_json::from_str(&json).unwrap();
        assert_eq!(back, trie);
        let empty: Trie = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.hash, None);
    }

    #[test]
    fn diff_with_empty() {
        let mut t2 = Trie::empty();
        t2.insert(&ts("2009-01-02T10:17:37.789Z-0000-0000testinguuid1"));
        assert_eq!(diff(&Trie::empty(), &t2), Some(0));
    }

    #[test]
    fn diff_finds_time_and_converges() {
        // Port of the "diff returns the correct time difference" test, with
        // real hashes in place of the injected ones.
        let a = [
            "2018-11-13T13:20:40.122Z-0000-0123456789ABCDEF",
            "2018-11-14T13:05:35.122Z-0000-0123456789ABCDEF",
            "2018-11-15T22:19:00.122Z-0000-0123456789ABCDEF",
        ];
        let b = [
            "2018-11-20T13:19:40.122Z-0000-0123456789ABCDEF",
            "2018-11-25T13:19:40.122Z-0000-0123456789ABCDEF",
        ];
        let mut t1 = Trie::empty();
        let mut t2 = Trie::empty();
        a.iter().for_each(|s| t1.insert(&ts(s)));
        b.iter().for_each(|s| t2.insert(&ts(s)));
        let d = diff(&t1, &t2).unwrap();
        assert!(d <= ts(a[0]).millis());
        b.iter().for_each(|s| t1.insert(&ts(s)));
        a.iter().for_each(|s| t2.insert(&ts(s)));
        assert_eq!(t1.hash, t2.hash);
        assert_eq!(diff(&t1, &t2), None);
    }

    #[test]
    fn prune_keeps_hash() {
        let mut trie = Trie::empty();
        for day in 1..28 {
            trie.insert(&ts(&format!("2018-11-{day:02}T13:21:40.122Z-0000-0123456789ABCDEF")));
        }
        let pruned = trie.prune(2);
        assert_eq!(pruned.hash, trie.hash);
        fn max_width(t: &Trie) -> usize {
            let n = t.keys().count();
            t.keys().map(|k| max_width(t.child(k).unwrap())).max().unwrap_or(0).max(n)
        }
        assert!(max_width(&pruned) <= 2);
    }
}
