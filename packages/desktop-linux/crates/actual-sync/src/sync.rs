//! The full-sync loop (`_fullSync` in loot-core `server/sync/index.ts`).
//!
//! Each pass sends every local message newer than `since`, applies what the
//! server returns, then compares merkle tries. If they still differ, the
//! diff gives an earlier time to sync from and the loop repeats; repeated
//! failure to converge is reported as out-of-sync.

use std::collections::BTreeMap;

use prost::Message as _;

use crate::client::ServerClient;
use crate::crypto::Key;
use crate::merkle::{self, Trie};
use crate::proto;
use crate::store::{ApplyOutcome, Message, Store};
use crate::timestamp::{now_ms, Timestamp};
use crate::value::Value;
use crate::SyncError;

/// The server rejects requests over 20MB by default.
pub const SYNC_BATCH_MAX_BYTES: usize = 4 * 1024 * 1024;
const SYNC_MESSAGE_OVERHEAD_BYTES: usize = 100;

/// Which server file and group a budget syncs with, plus its key.
pub struct SyncTarget<'a> {
    pub file_id: &'a str,
    pub group_id: &'a str,
    pub key: Option<&'a Key>,
    /// `encryptKeyId` from the budget's prefs; when set, `key` must match.
    pub key_id: Option<&'a str>,
}

#[derive(Debug, Default)]
pub struct SyncResult {
    /// Every applied server message, across all passes.
    pub received: Vec<Message>,
    pub tables: std::collections::BTreeSet<String>,
    pub prefs: Vec<(String, Value)>,
    pub deferred: usize,
    /// New value for the `lastSyncedTimestamp` pref when fully synced.
    pub last_synced_timestamp: Option<String>,
    pub passes: usize,
}

fn key_for<'a>(target: &'a SyncTarget) -> Result<Option<&'a Key>, bool> {
    match target.key_id {
        None => Ok(None),
        Some(id) => match target.key {
            Some(k) if k.id == id => Ok(Some(k)),
            _ => Err(true),
        },
    }
}

pub fn encode(target: &SyncTarget, since: &str, messages: &[Message]) -> Result<Vec<u8>, SyncError> {
    let key = key_for(target).map_err(|missing_key| SyncError::EncryptFailure { missing_key })?;
    let mut req = proto::SyncRequest {
        messages: Vec::with_capacity(messages.len()),
        file_id: target.file_id.to_string(),
        group_id: target.group_id.to_string(),
        key_id: target.key_id.unwrap_or("").to_string(),
        since: since.to_string(),
    };
    for msg in messages {
        let binary = proto::Message {
            dataset: msg.dataset.clone(),
            row: msg.row.clone(),
            column: msg.column.clone(),
            value: msg.value.serialize(),
        }
        .encode_to_vec();
        let (content, is_encrypted) = match key {
            Some(key) => {
                let enc = key.encrypt(&binary).map_err(|_| SyncError::EncryptFailure { missing_key: false })?;
                let data = proto::EncryptedData { iv: enc.iv, auth_tag: enc.auth_tag, data: enc.value };
                (data.encode_to_vec(), true)
            }
            None => (binary, false),
        };
        req.messages.push(proto::MessageEnvelope { timestamp: msg.timestamp.to_string(), is_encrypted, content });
    }
    Ok(req.encode_to_vec())
}

pub fn decode(target: &SyncTarget, data: &[u8]) -> Result<(Vec<Message>, Trie), SyncError> {
    let res = proto::SyncResponse::decode(data).map_err(|e| SyncError::Protocol(e.to_string()))?;
    let trie: Trie = serde_json::from_str(&res.merkle).map_err(|e| SyncError::Protocol(format!("merkle: {e}")))?;
    let mut out = Vec::with_capacity(res.messages.len());
    for env in res.messages {
        let raw = if env.is_encrypted {
            let key = match target.key {
                Some(k) if target.key_id.is_none_or(|id| id == k.id) => k,
                _ => return Err(SyncError::DecryptFailure { missing_key: true }),
            };
            let enc = proto::EncryptedData::decode(env.content.as_slice())
                .map_err(|_| SyncError::DecryptFailure { missing_key: false })?;
            key.decrypt(&enc.data, &enc.iv, &enc.auth_tag)
                .map_err(|_| SyncError::DecryptFailure { missing_key: false })?
        } else {
            env.content
        };
        let msg = proto::Message::decode(raw.as_slice()).map_err(|e| SyncError::Protocol(e.to_string()))?;
        let timestamp = Timestamp::parse(&env.timestamp)
            .ok_or_else(|| SyncError::Protocol(format!("bad timestamp {}", env.timestamp)))?;
        out.push(Message {
            timestamp,
            dataset: msg.dataset,
            row: msg.row,
            column: msg.column,
            value: Value::deserialize_safe(&msg.value),
        });
    }
    Ok((out, trie))
}

fn estimate_size(m: &Message) -> usize {
    m.dataset.len()
        + m.row.len()
        + m.column.len()
        + match &m.value {
            Value::Null => 0,
            v => v.serialize().len().saturating_sub(2),
        }
        + SYNC_MESSAGE_OVERHEAD_BYTES
}

/// Always returns at least one (possibly empty) batch.
pub fn split_into_batches(messages: Vec<Message>) -> Vec<Vec<Message>> {
    let mut batches = vec![Vec::new()];
    let mut size = 0;
    for m in messages {
        let s = estimate_size(&m);
        if size > 0 && size + s > SYNC_BATCH_MAX_BYTES {
            batches.push(Vec::new());
            size = 0;
        }
        batches.last_mut().expect("non-empty").push(m);
        size += s;
    }
    batches
}

/// Runs a full sync. `last_synced` is the `lastSyncedTimestamp` pref.
pub fn full_sync(
    store: &mut Store,
    client: &ServerClient,
    target: &SyncTarget,
    last_synced: Option<&str>,
) -> Result<SyncResult, SyncError> {
    let mut result = SyncResult::default();
    let mut since_override: Option<String> = None;
    let mut count = 0usize;
    let mut prev_diff: Option<i64> = None;

    loop {
        result.passes += 1;
        let current_time = store.clock.timestamp.to_string();
        let since = since_override
            .clone()
            .or_else(|| last_synced.map(str::to_string))
            .unwrap_or_else(|| Timestamp::since_millis(now_ms() - 5 * 60 * 1000));

        let messages = store.messages_since(&since)?;
        let batches = split_into_batches(messages);
        let mut server_messages: BTreeMap<String, Message> = BTreeMap::new();
        let mut server_merkle = None;
        for (i, batch) in batches.iter().enumerate() {
            let body = encode(target, if i == 0 { &since } else { &current_time }, batch)?;
            let res = client.sync(body)?;
            let (msgs, trie) = decode(target, &res)?;
            for m in msgs {
                server_messages.insert(m.timestamp.to_string(), m);
            }
            server_merkle = Some(trie);
        }
        let server_merkle = server_merkle.expect("at least one batch");
        let local_time_changed = store.clock.timestamp.to_string() != current_time;

        if !server_messages.is_empty() {
            let ApplyOutcome { messages, tables, prefs, deferred } =
                store.apply_messages(server_messages.into_values().collect(), true)?;
            result.received.extend(messages);
            result.tables.extend(tables);
            result.prefs.extend(prefs);
            result.deferred += deferred;
        }

        match merkle::diff(&server_merkle, &store.clock.merkle) {
            Some(diff_time) => {
                if (count >= 10 && Some(diff_time) == prev_diff) || count >= 100 {
                    return Err(SyncError::OutOfSync);
                }
                since_override = Some(Timestamp::new(diff_time, 0, "0").to_string());
                count = if local_time_changed { 0 } else { count + 1 };
                prev_diff = Some(diff_time);
            }
            None => {
                let now = store.clock.timestamp.to_string();
                if last_synced != Some(now.as_str()) {
                    result.last_synced_timestamp = Some(now);
                }
                return Ok(result);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(ts: &str, value: Value) -> Message {
        Message {
            timestamp: Timestamp::parse(ts).unwrap(),
            dataset: "accounts".into(),
            row: "a1".into(),
            column: "name".into(),
            value,
        }
    }

    #[test]
    fn encode_decode_encrypted() {
        let key = Key::from_password("kid", "pw", "salt");
        let target = SyncTarget { file_id: "f", group_id: "g", key: Some(&key), key_id: Some("kid") };
        let m = msg("2024-01-01T00:00:00.000Z-0000-0123456789ABCDEF", Value::String("Checking".into()));
        let req = proto::SyncRequest::decode(encode(&target, "since", std::slice::from_ref(&m)).unwrap().as_slice()).unwrap();
        assert!(req.messages[0].is_encrypted);
        assert_eq!(req.key_id, "kid");
        // Server echoes envelopes back verbatim.
        let res = proto::SyncResponse { messages: req.messages, merkle: "{\"hash\":0}".into() }.encode_to_vec();
        let (back, trie) = decode(&target, &res).unwrap();
        assert_eq!(back, vec![m]);
        assert_eq!(trie.hash, Some(0));

        let no_key = SyncTarget { file_id: "f", group_id: "g", key: None, key_id: Some("kid") };
        assert!(matches!(decode(&no_key, &res), Err(SyncError::DecryptFailure { missing_key: true })));
    }

    #[test]
    fn batches() {
        assert_eq!(split_into_batches(vec![]).len(), 1);
        let big = "x".repeat(3 * 1024 * 1024);
        let ms = vec![
            msg("2024-01-01T00:00:00.000Z-0000-0123456789ABCDEF", Value::String(big.clone())),
            msg("2024-01-01T00:00:00.000Z-0001-0123456789ABCDEF", Value::String(big)),
        ];
        assert_eq!(split_into_batches(ms).len(), 2);
    }
}
