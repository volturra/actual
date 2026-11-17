//! The CRDT message log in a budget's SQLite file, ported from loot-core
//! `server/sync/index.ts` (`applyMessages`, `compareMessages`, deferral) and
//! `replay.ts`.
//!
//! Every change, local or remote, is a `(timestamp, dataset, row, column,
//! value)` message. A message is written to its table cell only if no newer
//! message for that cell is already in `messages_crdt` (last write wins), and
//! every message goes into the merkle trie, which is saved with the clock in
//! `messages_clock` in the same transaction.

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::merkle::Trie;
use crate::timestamp::{make_client_id, now_ms, Clock, ClockError, Timestamp};
use crate::value::Value;
use crate::SyncError;

#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub timestamp: Timestamp,
    pub dataset: String,
    pub row: String,
    pub column: String,
    pub value: Value,
}

/// A local edit before it has been given a timestamp.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub dataset: String,
    pub row: String,
    pub column: String,
    pub value: Value,
}

impl Change {
    pub fn new(dataset: &str, row: &str, column: &str, value: impl Into<Value>) -> Change {
        Change { dataset: dataset.into(), row: row.into(), column: column.into(), value: value.into() }
    }
}

/// What applying a batch did.
#[derive(Debug, Default)]
pub struct ApplyOutcome {
    /// Messages processed (old ones included), excluding deferred ones.
    pub messages: Vec<Message>,
    /// Tables whose rows actually changed.
    pub tables: BTreeSet<String>,
    /// Synced `prefs` dataset values (they live in metadata.json).
    pub prefs: Vec<(String, Value)>,
    /// Messages held in `messages_pending` because they need newer schema.
    pub deferred: usize,
}

pub const PENDING_MESSAGES_TABLE_SQL: &str = "
  CREATE TABLE IF NOT EXISTS messages_pending
    (dataset TEXT NOT NULL,
     row TEXT NOT NULL,
     column TEXT NOT NULL,
     timestamp TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (dataset, row, column));
";

pub fn quote_sql_id(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn is_missing_schema_error(e: &rusqlite::Error) -> bool {
    let msg = e.to_string().to_lowercase();
    msg.contains("no such table") || msg.contains("no such column") || msg.contains("has no column named")
}

pub struct Store {
    pub conn: Connection,
    pub clock: Clock,
}

impl Store {
    /// Wraps an open budget database, loading (or creating) its clock.
    pub fn open(conn: Connection) -> Result<Store, SyncError> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let row: Option<String> = conn
            .query_row("SELECT clock FROM messages_clock", [], |r| r.get(0))
            .optional()?;
        let clock = match row {
            Some(s) => Clock::deserialize(&s)?,
            None => {
                let clock = Clock::new(Timestamp::new(0, 0, make_client_id()), Trie::empty());
                conn.execute(
                    "INSERT INTO messages_clock (id, clock) VALUES (?, ?)",
                    params![1, clock.serialize()],
                )?;
                clock
            }
        };
        Ok(Store { conn, clock })
    }

    pub fn node_id(&self) -> &str {
        self.clock.timestamp.node()
    }

    fn save_clock(conn: &Connection, clock: &Clock) -> Result<(), SyncError> {
        conn.prepare_cached("INSERT OR REPLACE INTO messages_clock (id, clock) VALUES (1, ?)")?
            .execute([clock.serialize()])?;
        Ok(())
    }

    /// Gives this copy of the budget a fresh node id (a newly downloaded file
    /// must never reuse the uploader's node).
    pub fn reset_clock_node(&mut self) -> Result<(), SyncError> {
        self.clock.timestamp = Timestamp::new(
            self.clock.timestamp.millis(),
            self.clock.timestamp.counter(),
            make_client_id(),
        );
        Self::save_clock(&self.conn, &self.clock)
    }

    /// Rebuilds the merkle trie from the whole log (`repairSync`).
    pub fn rebuild_merkle(&mut self) -> Result<usize, SyncError> {
        let trie = self.rebuilt_merkle()?;
        self.clock.merkle = trie.0;
        Self::save_clock(&self.conn, &self.clock)?;
        Ok(trie.1)
    }

    pub fn rebuilt_merkle(&self) -> Result<(Trie, usize), SyncError> {
        let mut stmt = self.conn.prepare("SELECT timestamp FROM messages_crdt")?;
        let mut trie = Trie::empty();
        let mut n = 0;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for ts in rows {
            let ts = ts?;
            let parsed = Timestamp::parse(&ts).ok_or(ClockError::Invalid(ts))?;
            trie.insert(&parsed);
            n += 1;
        }
        Ok((trie, n))
    }

    /// Messages logged after `since` (exclusive), to send to the server.
    pub fn messages_since(&self, since: &str) -> Result<Vec<Message>, SyncError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT timestamp, dataset, row, column, value FROM messages_crdt WHERE timestamp > ?",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                value_column(r, 4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (ts, dataset, row, column, value) = row?;
            let timestamp = Timestamp::parse(&ts).ok_or(ClockError::Invalid(ts))?;
            // The log stores the serialized form; keep it verbatim when
            // re-sending so values round-trip byte for byte.
            out.push(Message { timestamp, dataset, row, column, value: Value::deserialize_safe(&value) });
        }
        Ok(out)
    }

    /// Records local edits: stamps each with a new timestamp and applies them.
    pub fn send_local(&mut self, changes: Vec<Change>) -> Result<ApplyOutcome, SyncError> {
        let now = now_ms();
        let mut messages = Vec::with_capacity(changes.len());
        for c in changes {
            let timestamp = self.clock.send(now)?;
            messages.push(Message { timestamp, dataset: c.dataset, row: c.row, column: c.column, value: c.value });
        }
        self.apply_messages(messages, false)
    }

    /// `applyMessages`. `received` marks messages from the server: they
    /// advance the clock and defer instead of failing on unknown schema.
    pub fn apply_messages(&mut self, messages: Vec<Message>, received: bool) -> Result<ApplyOutcome, SyncError> {
        let saved_clock = self.clock.clone();
        let result = self.apply_in_transaction(messages, received);
        if result.is_err() {
            // Like the JS version, only a received batch rolls the time back;
            // a local batch keeps its sent timestamps (they were never used).
            if received {
                self.clock = saved_clock;
            } else {
                self.clock.merkle = saved_clock.merkle;
            }
        }
        result
    }

    fn apply_in_transaction(&mut self, messages: Vec<Message>, received: bool) -> Result<ApplyOutcome, SyncError> {
        let Store { conn, clock } = self;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if received {
            if let Some(latest) = messages
                .iter()
                .map(|m| &m.timestamp)
                .max_by(|a, b| (a.millis(), a.counter()).cmp(&(b.millis(), b.counter())))
            {
                clock.recv(latest, now_ms())?;
            }
        }

        let mut messages = compare_messages(&tx, messages)?;
        messages.sort_by_cached_key(|(m, _)| m.timestamp.to_string());

        let mut ids_per_table: HashMap<String, Vec<String>> = HashMap::new();
        for (m, _) in &messages {
            if m.dataset != "prefs" {
                ids_per_table.entry(m.dataset.clone()).or_default().push(m.row.clone());
            }
        }
        let existing = fetch_existing(&tx, &ids_per_table)?;

        let mut outcome = ApplyOutcome::default();
        let mut added: HashSet<(String, String)> = HashSet::new();
        let mut merkle = clock.merkle.clone();
        let mut deferred_idx = HashSet::new();

        for (i, (msg, old)) in messages.iter().enumerate() {
            if !old {
                let exists = existing.contains(&(msg.dataset.clone(), msg.row.clone()))
                    || added.contains(&(msg.dataset.clone(), msg.row.clone()));
                if apply_one(&tx, msg, exists, received)? {
                    if msg.dataset == "prefs" {
                        if !msg.value.is_unknown() {
                            outcome.prefs.push((msg.row.clone(), msg.value.clone()));
                        }
                    } else {
                        added.insert((msg.dataset.clone(), msg.row.clone()));
                        if msg.dataset != "spreadsheet_cells" {
                            let table = if msg.dataset == "schedules_next_date" {
                                "schedules".to_string()
                            } else {
                                msg.dataset.clone()
                            };
                            outcome.tables.insert(table);
                        }
                    }
                } else {
                    deferred_idx.insert(i);
                }
            }

            tx.prepare_cached(
                "INSERT INTO messages_crdt (timestamp, dataset, row, column, value) VALUES (?, ?, ?, ?, ?)",
            )?
            .execute(params![
                msg.timestamp.to_string(),
                msg.dataset,
                msg.row,
                msg.column,
                msg.value.serialize()
            ])?;
            merkle.insert(&msg.timestamp);
        }

        let merkle = merkle.prune(2);
        let new_clock = Clock::new(clock.timestamp.clone(), merkle);
        Self::save_clock(&tx, &new_clock)?;
        tx.commit()?;

        clock.merkle = new_clock.merkle;
        outcome.deferred = deferred_idx.len();
        outcome.messages = messages
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !deferred_idx.contains(i))
            .map(|(_, (m, _))| m)
            .collect();
        Ok(outcome)
    }

    /// Applies messages deferred from a newer app version once this build
    /// knows their schema (`replayPendingMessages`). Returns how many applied.
    pub fn replay_pending(&mut self) -> Result<usize, SyncError> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(PENDING_MESSAGES_TABLE_SQL)?;
        tx.execute(
            "DELETE FROM messages_pending WHERE EXISTS
               (SELECT 1 FROM messages_crdt c WHERE c.dataset = messages_pending.dataset
                  AND c.row = messages_pending.row AND c.column = messages_pending.column
                  AND c.timestamp > messages_pending.timestamp)",
            [],
        )?;
        let pending: Vec<(String, String, String, String)> = {
            let mut stmt =
                tx.prepare("SELECT dataset, row, column, value FROM messages_pending ORDER BY timestamp")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut applied = 0;
        let mut failed: Vec<&(String, String, String, String)> = Vec::new();
        let try_one = |tx: &rusqlite::Transaction, p: &(String, String, String, String)| -> Result<Option<bool>, SyncError> {
            let (dataset, row, column, raw) = p;
            let Some(value) = Value::deserialize(raw) else { return Ok(None) };
            let update = format!("UPDATE {} SET {} = ? WHERE id = ?", quote_sql_id(dataset), quote_sql_id(column));
            let res = tx.execute(&update, params![value, row]).and_then(|n| {
                if n == 0 {
                    let insert =
                        format!("INSERT INTO {} (id, {}) VALUES (?, ?)", quote_sql_id(dataset), quote_sql_id(column));
                    tx.execute(&insert, params![row, value])
                } else {
                    Ok(n)
                }
            });
            match res {
                Ok(_) => Ok(Some(true)),
                Err(e) if is_missing_schema_error(&e) => Ok(None),
                Err(e) if is_deterministic_error(&e) => Ok(Some(false)),
                Err(e) => Err(e.into()),
            }
        };
        let delete = |tx: &rusqlite::Transaction, p: &(String, String, String, String)| -> Result<(), SyncError> {
            tx.execute(
                "DELETE FROM messages_pending WHERE dataset = ? AND row = ? AND column = ?",
                params![p.0, p.1, p.2],
            )?;
            Ok(())
        };
        for p in &pending {
            match try_one(&tx, p)? {
                Some(true) => {
                    applied += 1;
                    delete(&tx, p)?;
                }
                Some(false) => failed.push(p),
                None => {}
            }
        }
        while !failed.is_empty() {
            let mut retried = Vec::new();
            for p in &failed {
                match try_one(&tx, p)? {
                    Some(true) => {
                        applied += 1;
                        delete(&tx, p)?;
                    }
                    Some(false) => retried.push(*p),
                    None => {}
                }
            }
            if retried.len() == failed.len() {
                for p in &retried {
                    delete(&tx, p)?;
                }
                break;
            }
            failed = retried;
        }
        if applied > 0 {
            // Values written outside the pipeline: drop the derived cache.
            let _ = tx.execute("DELETE FROM kvcache_key", []);
        }
        tx.commit()?;
        Ok(applied)
    }
}

fn is_deterministic_error(e: &rusqlite::Error) -> bool {
    let m = e.to_string().to_lowercase();
    ["constraint failed", "datatype mismatch", "cannot store", "generated column", "string or blob too big", "syntax error"]
        .iter()
        .any(|p| m.contains(p))
}

fn value_column(r: &rusqlite::Row, idx: usize) -> rusqlite::Result<String> {
    use rusqlite::types::ValueRef;
    Ok(match r.get_ref(idx)? {
        ValueRef::Text(t) | ValueRef::Blob(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Null => String::new(),
    })
}

/// `compareMessages`: drops messages already in the log and flags as old
/// those with a newer message for the same cell.
fn compare_messages(conn: &Connection, messages: Vec<Message>) -> Result<Vec<(Message, bool)>, SyncError> {
    if messages.is_empty() {
        return Ok(Vec::new());
    }
    let mut oldest: HashMap<(String, String, String), String> = HashMap::new();
    for m in &messages {
        let ts = m.timestamp.to_string();
        let key = (m.dataset.clone(), m.row.clone(), m.column.clone());
        match oldest.get(&key) {
            Some(existing) if *existing <= ts => {}
            _ => {
                oldest.insert(key, ts);
            }
        }
    }
    let mut logged: HashMap<(String, String, String), Vec<String>> = HashMap::new();
    let mut stmt = conn.prepare_cached(
        "SELECT timestamp FROM messages_crdt WHERE dataset = ? AND row = ? AND column = ? AND timestamp >= ?",
    )?;
    for (key, ts) in &oldest {
        let rows = stmt.query_map(params![key.0, key.1, key.2, ts], |r| r.get::<_, String>(0))?;
        let list: Vec<String> = rows.collect::<Result<_, _>>()?;
        if !list.is_empty() {
            logged.insert(key.clone(), list);
        }
    }
    let mut out = Vec::with_capacity(messages.len());
    for m in messages {
        let ts = m.timestamp.to_string();
        match logged.get(&(m.dataset.clone(), m.row.clone(), m.column.clone())) {
            None => out.push((m, false)),
            Some(list) if list.contains(&ts) => {}
            Some(list) if list.iter().any(|t| *t > ts) => out.push((m, true)),
            Some(_) => out.push((m, false)),
        }
    }
    Ok(out)
}

fn fetch_existing(
    conn: &Connection,
    ids_per_table: &HashMap<String, Vec<String>>,
) -> Result<HashSet<(String, String)>, SyncError> {
    let mut out = HashSet::new();
    for (table, ids) in ids_per_table {
        let sql = format!("SELECT 1 FROM {} WHERE id = ?", quote_sql_id(table));
        let mut stmt = match conn.prepare_cached(&sql) {
            Ok(s) => s,
            Err(e) if is_missing_schema_error(&e) => continue,
            Err(e) => return Err(e.into()),
        };
        for id in ids {
            if stmt.exists([id])? {
                out.insert((table.clone(), id.clone()));
            }
        }
    }
    Ok(out)
}

fn defer_message(conn: &Connection, msg: &Message) -> Result<(), SyncError> {
    conn.execute_batch(PENDING_MESSAGES_TABLE_SQL)?;
    conn.prepare_cached(
        "INSERT INTO messages_pending (timestamp, dataset, row, column, value)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(dataset, row, column) DO UPDATE
             SET timestamp = excluded.timestamp, value = excluded.value
             WHERE excluded.timestamp > messages_pending.timestamp",
    )?
    .execute(params![msg.timestamp.to_string(), msg.dataset, msg.row, msg.column, msg.value.serialize()])?;
    Ok(())
}

/// Writes one cell. Returns false if the message was deferred.
fn apply_one(conn: &Connection, msg: &Message, exists: bool, defer_unknown: bool) -> Result<bool, SyncError> {
    if msg.dataset == "prefs" || msg.dataset == "spreadsheet_cells" {
        return Ok(true);
    }
    if msg.value.is_unknown() {
        if defer_unknown {
            defer_message(conn, msg)?;
            return Ok(false);
        }
        return Err(SyncError::InvalidSchema(format!("Unknown value format: {}", msg.value.serialize())));
    }
    let sql = if exists {
        format!("UPDATE {} SET {} = ? WHERE id = ?", quote_sql_id(&msg.dataset), quote_sql_id(&msg.column))
    } else {
        format!("INSERT INTO {} (id, {}) VALUES (?, ?)", quote_sql_id(&msg.dataset), quote_sql_id(&msg.column))
    };
    let res = conn.prepare_cached(&sql).and_then(|mut stmt| {
        if exists {
            stmt.execute(params![msg.value, msg.row])
        } else {
            stmt.execute(params![msg.row, msg.value])
        }
    });
    match res {
        Ok(_) => Ok(true),
        Err(e) if defer_unknown && is_missing_schema_error(&e) => {
            defer_message(conn, msg)?;
            Ok(false)
        }
        Err(e) => Err(SyncError::InvalidSchema(format!("{e} ({sql})"))),
    }
}
