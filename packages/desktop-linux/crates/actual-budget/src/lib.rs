//! The Actual Budget data model for the native client: an open budget file,
//! reads for the UI, envelope budget math and edits, all on top of the
//! `actual-sync` CRDT log so every change syncs with the web app.

pub mod config;
pub mod envelope;
pub mod format;
pub mod model;
pub mod month;
pub mod ops;
pub mod schema;

use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

pub use actual_sync;
use actual_sync::client::ServerClient;
use actual_sync::crypto::Key;
use actual_sync::files::{BudgetDir, Metadata};
use actual_sync::sync::{full_sync, SyncResult, SyncTarget};
use actual_sync::{ApplyOutcome, Change, Store, SyncError, Value};

use crate::envelope::EnvelopeBudget;
use crate::format::{AmountFormat, NumberFormat};
use crate::month::Month;
use crate::ops::ChangeSet;
use crate::schema::Compatibility;

#[derive(Debug, thiserror::Error)]
pub enum BudgetError {
    #[error(transparent)]
    Sync(#[from] SyncError),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    ReadOnly(String),
}

/// One undoable user action: the cell values from before it.
#[derive(Clone, Debug, Default)]
struct UndoEntry {
    before: Vec<Change>,
    after: Vec<Change>,
}

/// An open budget.
pub struct Budget {
    pub dir: BudgetDir,
    pub meta: Metadata,
    pub store: Store,
    pub compat: Compatibility,
    key: Option<Key>,
    undo: Vec<UndoEntry>,
    redo: Vec<UndoEntry>,
}

/// What changed, for the UI to refresh.
#[derive(Debug, Default, Clone)]
pub struct Changed {
    pub tables: BTreeSet<String>,
}

impl Changed {
    pub fn touches(&self, table: &str) -> bool {
        self.tables.contains(table)
    }
    fn from_outcome(o: &ApplyOutcome) -> Changed {
        Changed { tables: o.tables.clone() }
    }
}

impl Budget {
    /// Opens a budget directory. `key` is needed for encrypted budgets.
    pub fn open(dir: BudgetDir, key: Option<Key>) -> Result<Budget, BudgetError> {
        let mut meta = dir.read_meta()?;
        let conn = Connection::open(dir.db_path())?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let compat = schema::check(&conn)?;
        schema::create_views(&conn)?;
        let mut store = Store::open(conn)?;
        if meta.bool("resetClock") {
            // A copy downloaded from the server must not reuse the
            // uploader's node id (see loadBudget in loot-core).
            store.reset_clock_node()?;
            meta.set("resetClock", false);
            dir.write_meta(&meta)?;
        }
        if meta.cloud_file_id().is_some() {
            if let Err(e) = store.replay_pending() {
                eprintln!("warning: could not replay deferred changes: {e}");
            }
        }
        Ok(Budget { dir, meta, store, compat, key, undo: Vec::new(), redo: Vec::new() })
    }

    pub fn conn(&self) -> &Connection {
        &self.store.conn
    }

    pub fn id(&self) -> &str {
        self.meta.id().unwrap_or_default()
    }

    pub fn name(&self) -> &str {
        self.meta.budget_name()
    }

    pub fn set_key(&mut self, key: Option<Key>) {
        self.key = key;
    }

    pub fn is_writable(&self) -> bool {
        self.compat.is_writable()
    }

    pub fn budget_type(&self) -> String {
        model::preference(self.conn(), "budgetType").ok().flatten().unwrap_or_else(|| "envelope".into())
    }

    pub fn amount_format(&self) -> AmountFormat {
        let pref = |k| model::preference(self.conn(), k).ok().flatten();
        AmountFormat {
            format: NumberFormat::from_pref(pref("numberFormat").as_deref()),
            hide_fraction: pref("hideFraction").as_deref() == Some("true"),
        }
    }

    pub fn date_format(&self) -> String {
        model::preference(self.conn(), "dateFormat").ok().flatten().unwrap_or_else(|| "MM/dd/yyyy".into())
    }

    pub fn envelope(&self) -> Result<EnvelopeBudget, BudgetError> {
        Ok(envelope::compute(self.conn(), Month::current())?)
    }

    fn ensure_writable(&self) -> Result<(), BudgetError> {
        match self.compat.describe() {
            Some(msg) if !self.compat.is_writable() => Err(BudgetError::ReadOnly(msg)),
            _ => Ok(()),
        }
    }

    fn current_value(&self, c: &Change) -> Result<Option<Value>, BudgetError> {
        let sql = format!(
            "SELECT {} FROM {} WHERE id = ?",
            actual_sync::store::quote_sql_id(&c.column),
            actual_sync::store::quote_sql_id(&c.dataset)
        );
        let v = self
            .conn()
            .query_row(&sql, [&c.row], |r| {
                use rusqlite::types::ValueRef;
                Ok(match r.get_ref(0)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(i) => Value::Number(i as f64),
                    ValueRef::Real(f) => Value::Number(f),
                    ValueRef::Text(t) | ValueRef::Blob(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                })
            })
            .optional()?;
        Ok(v)
    }

    fn has_tombstone(&self, table: &str) -> bool {
        let sql = format!("SELECT tombstone FROM {} LIMIT 0", actual_sync::store::quote_sql_id(table));
        self.conn().prepare(&sql).is_ok()
    }

    /// Records the values `changes` will overwrite, for undo.
    fn snapshot(&self, changes: &[Change]) -> Result<Vec<Change>, BudgetError> {
        let mut seen = HashSet::new();
        let mut before = Vec::new();
        for c in changes {
            if !seen.insert((c.dataset.clone(), c.row.clone(), c.column.clone())) {
                continue;
            }
            match self.current_value(c)? {
                Some(v) => before.push(Change { value: v, ..c.clone() }),
                None => {
                    // The row is new: undo deletes it (or blanks the cell).
                    if self.has_tombstone(&c.dataset) {
                        if seen.insert((c.dataset.clone(), c.row.clone(), "tombstone".into())) {
                            before.push(Change::new(&c.dataset, &c.row, "tombstone", 1i64));
                        }
                    } else {
                        before.push(Change { value: Value::Null, ..c.clone() });
                    }
                }
            }
        }
        Ok(before)
    }

    fn send(&mut self, changes: Vec<Change>) -> Result<Changed, BudgetError> {
        if changes.is_empty() {
            return Ok(Changed::default());
        }
        let outcome = self.store.send_local(changes)?;
        Ok(Changed::from_outcome(&outcome))
    }

    /// Applies a user edit as one undo step.
    pub fn apply(&mut self, cs: ChangeSet) -> Result<Changed, BudgetError> {
        self.apply_steps(vec![cs])
    }

    fn apply_steps(&mut self, steps: Vec<ChangeSet>) -> Result<Changed, BudgetError> {
        self.ensure_writable()?;
        let mut entry = UndoEntry::default();
        let mut changed = Changed::default();
        for cs in steps {
            let before = self.snapshot(&cs.changes)?;
            entry.after.extend(cs.changes.iter().cloned());
            entry.before.splice(0..0, before);
            changed.tables.extend(self.send(cs.changes)?.tables);
        }
        if !entry.after.is_empty() {
            self.undo.push(entry);
            self.redo.clear();
        }
        Ok(changed)
    }

    /// Adds, edits or deletes transactions, then runs transfer bookkeeping
    /// on the result (the second `batchMessages` in `batchUpdateTransactions`).
    pub fn edit_transactions(
        &mut self,
        cs: ChangeSet,
        changed_ids: Vec<String>,
        deleted_ids: Vec<String>,
    ) -> Result<Changed, BudgetError> {
        self.ensure_writable()?;
        let deleted: Vec<(String, Option<String>)> = deleted_ids
            .iter()
            .map(|id| {
                let t = model::transaction(self.conn(), id).ok().flatten();
                (id.clone(), t.and_then(|t| t.transfer_id))
            })
            .collect();
        let before = self.snapshot(&cs.changes)?;
        let after1 = cs.changes.clone();
        let mut changed = self.send(cs.changes)?;
        let followups = ops::transfer_followups(self.conn(), &changed_ids, &deleted)?;
        let before2 = self.snapshot(&followups.changes)?;
        let after2 = followups.changes.clone();
        changed.tables.extend(self.send(followups.changes)?.tables);
        let mut entry = UndoEntry { before: before2, after: after1 };
        entry.before.extend(before);
        entry.after.extend(after2);
        self.undo.push(entry);
        self.redo.clear();
        Ok(changed)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Undo re-sends the old values as new changes, so it syncs like any
    /// other edit (as loot-core's undo does).
    pub fn undo(&mut self) -> Result<Changed, BudgetError> {
        self.ensure_writable()?;
        let Some(entry) = self.undo.pop() else { return Ok(Changed::default()) };
        let changed = self.send(entry.before.clone())?;
        self.redo.push(entry);
        Ok(changed)
    }

    pub fn redo(&mut self) -> Result<Changed, BudgetError> {
        self.ensure_writable()?;
        let Some(entry) = self.redo.pop() else { return Ok(Changed::default()) };
        let changed = self.send(entry.after.clone())?;
        self.undo.push(entry);
        Ok(changed)
    }

    /// Whether this budget is linked to a server file.
    pub fn is_synced(&self) -> bool {
        self.meta.cloud_file_id().is_some() && self.meta.group_id().is_some()
    }

    /// Runs a full sync and saves what it learned (`lastSyncedTimestamp`,
    /// synced prefs such as the budget name).
    pub fn sync(&mut self, client: &ServerClient) -> Result<(SyncResult, Changed), BudgetError> {
        let (Some(file_id), Some(group_id)) =
            (self.meta.cloud_file_id().map(str::to_string), self.meta.group_id().map(str::to_string))
        else {
            return Ok((SyncResult::default(), Changed::default()));
        };
        let key_id = self.meta.encrypt_key_id().map(str::to_string);
        let last = self.meta.last_synced_timestamp().map(str::to_string);
        let target = SyncTarget { file_id: &file_id, group_id: &group_id, key: self.key.as_ref(), key_id: key_id.as_deref() };
        let result = full_sync(&mut self.store, client, &target, last.as_deref())?;
        let mut meta_changed = false;
        for (k, v) in &result.prefs {
            let json = match v {
                Value::Null => serde_json::Value::Null,
                Value::Number(n) => serde_json::json!(n),
                Value::String(s) => serde_json::Value::String(s.clone()),
                Value::Unknown(_) => continue,
            };
            self.meta.set(k, json);
            meta_changed = true;
        }
        if let Some(ts) = &result.last_synced_timestamp {
            self.meta.set("lastSyncedTimestamp", ts.clone());
            meta_changed = true;
        }
        if meta_changed {
            self.dir.write_meta(&self.meta)?;
        }
        let changed = Changed { tables: result.tables.clone() };
        Ok((result, changed))
    }

    /// Uploads the whole file (needed after creating or resetting a budget).
    pub fn upload(&mut self, client: &ServerClient) -> Result<(), BudgetError> {
        let (file_id, group_id) = actual_sync::files::upload(client, &self.dir, self.key.as_ref())?;
        self.meta.set("cloudFileId", file_id);
        self.meta.set("groupId", group_id);
        self.meta.set("lastUploaded", month::today());
        self.dir.write_meta(&self.meta)?;
        Ok(())
    }
}

/// Opens the budget in `root` whose server file is `cloud_file_id`, if any.
pub fn find_local_by_cloud_id(root: &Path, cloud_file_id: &str) -> Option<BudgetDir> {
    actual_sync::files::list_local(root)
        .into_iter()
        .find(|(_, m)| m.cloud_file_id() == Some(cloud_file_id))
        .map(|(d, _)| d)
}

/// Turns the budget's encryption password into its key, checking it against
/// the server's test blob (`key-test` in loot-core).
pub fn unlock_key(client: &ServerClient, cloud_file_id: &str, password: &str) -> Result<Key, BudgetError> {
    let info = client.get_key(cloud_file_id)?;
    let (Some(id), Some(salt)) = (info.id.clone(), info.salt.clone()) else {
        return Err(BudgetError::Invalid("This budget isn't encrypted.".into()));
    };
    let test = info
        .key_test()
        .ok_or_else(|| BudgetError::Invalid("This budget uses an old encryption format. Reset its key in the web app.".into()))?;
    let key = Key::from_password(&id, password, &salt);
    if !test.verify(&key) {
        return Err(BudgetError::Invalid("That password doesn't unlock this budget.".into()));
    }
    Ok(key)
}
