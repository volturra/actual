//! Schema compatibility and the read views this crate queries.
//!
//! The client never migrates a budget itself: it works on files created and
//! migrated by Actual. If the file's applied migrations differ from the set
//! this build was compiled against, the budget opens read-only.

use std::collections::BTreeSet;

use rusqlite::Connection;

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Compatibility {
    Compatible,
    /// The file has migrations this build doesn't know (made by a newer
    /// Actual). Edits are disabled; incoming changes that need the newer
    /// schema are deferred, exactly as an older web client would.
    Newer(Vec<u64>),
    /// The file is missing migrations this build expects. Opening it once in
    /// an up-to-date Actual upgrades it.
    Older(Vec<u64>),
}

impl Compatibility {
    pub fn is_writable(&self) -> bool {
        matches!(self, Compatibility::Compatible)
    }

    pub fn describe(&self) -> Option<String> {
        match self {
            Compatibility::Compatible => None,
            Compatibility::Newer(_) => Some(
                "This budget was upgraded by a newer version of Actual. It is open read-only until this app is updated."
                    .into(),
            ),
            Compatibility::Older(_) => Some(
                "This budget uses an older database format. Open it once in the Actual web app to upgrade it, then sync again."
                    .into(),
            ),
        }
    }
}

pub fn check(conn: &Connection) -> rusqlite::Result<Compatibility> {
    let mut stmt = conn.prepare("SELECT id FROM __migrations__")?;
    let applied: BTreeSet<u64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .filter_map(|r| r.ok())
        .map(|n| n as u64)
        .collect();
    let known: BTreeSet<u64> = KNOWN_MIGRATIONS.iter().copied().collect();
    let newer: Vec<u64> = applied.difference(&known).copied().collect();
    if !newer.is_empty() {
        return Ok(Compatibility::Newer(newer));
    }
    let older: Vec<u64> = known.difference(&applied).copied().collect();
    if !older.is_empty() {
        return Ok(Compatibility::Older(older));
    }
    Ok(Compatibility::Compatible)
}

/// Temporary views mirroring loot-core's `v_transactions_internal`,
/// `v_transactions_internal_alive` and `v_payees` (see
/// `server/aql/schema/index.ts`). They live only on this connection, so the
/// budget file itself is untouched.
pub const VIEWS_SQL: &str = r#"
DROP VIEW IF EXISTS temp.rs_transactions_internal;
CREATE TEMP VIEW rs_transactions_internal AS
  SELECT
    _.id AS id,
    _.isParent AS is_parent,
    _.isChild AS is_child,
    CASE WHEN _.isChild = 0 THEN NULL ELSE _.parent_id END AS parent_id,
    _.acct AS account,
    CASE WHEN _.isParent = 1 THEN NULL ELSE cm.transferId END AS category,
    IFNULL(_.amount, 0) AS amount,
    pm.targetId AS payee,
    _.notes AS notes,
    _.date AS date,
    _.financial_id AS imported_id,
    _.error AS error,
    _.imported_description AS imported_payee,
    _.starting_balance_flag AS starting_balance_flag,
    _.transferred_id AS transfer_id,
    _.sort_order AS sort_order,
    _.cleared AS cleared,
    _.reconciled AS reconciled,
    _.tombstone AS tombstone,
    _.schedule AS schedule
  FROM transactions _
  LEFT JOIN category_mapping cm ON cm.id = _.category
  LEFT JOIN payee_mapping pm ON pm.id = _.description
  WHERE _.date IS NOT NULL AND _.acct IS NOT NULL
    AND (_.isChild = 0 OR _.parent_id IS NOT NULL);

DROP VIEW IF EXISTS temp.rs_transactions_alive;
CREATE TEMP VIEW rs_transactions_alive AS
  SELECT _.* FROM rs_transactions_internal _
  LEFT JOIN transactions t2 ON (_.is_child = 1 AND t2.id = _.parent_id)
  WHERE IFNULL(_.tombstone, 0) = 0 AND (_.is_child = 0 OR t2.tombstone = 0);

DROP VIEW IF EXISTS temp.rs_transactions;
CREATE TEMP VIEW rs_transactions AS
  SELECT _.id, _.is_parent, _.is_child, _.parent_id,
    a.id AS account, c.id AS category, _.amount, p.id AS payee, _.notes, _.date,
    _.imported_id, _.error, _.imported_payee, _.starting_balance_flag,
    _.transfer_id, _.sort_order, _.cleared, _.reconciled, _.schedule
  FROM rs_transactions_alive _
  LEFT JOIN payees p ON (p.id = _.payee AND p.tombstone = 0)
  LEFT JOIN categories c ON (c.id = _.category AND c.tombstone = 0)
  LEFT JOIN accounts a ON (a.id = _.account AND a.tombstone = 0);

DROP VIEW IF EXISTS temp.rs_payees;
CREATE TEMP VIEW rs_payees AS
  SELECT _.id, _.name, _.transfer_acct, _.favorite
  FROM payees _
  LEFT JOIN accounts __accounts ON (_.transfer_acct = __accounts.id AND __accounts.tombstone = 0)
  WHERE (_.transfer_acct IS NULL OR __accounts.id IS NOT NULL) AND _.tombstone = 0;
"#;

pub fn create_views(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(VIEWS_SQL)
}
