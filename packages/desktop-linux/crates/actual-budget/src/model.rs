//! Read-side data model: what the UI shows, read straight from SQLite.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::month::date_from_db;

#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub offbudget: bool,
    pub closed: bool,
    pub sort_order: f64,
    pub balance: i64,
    pub cleared: i64,
    pub uncleared: i64,
    pub last_reconciled: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub is_income: bool,
    pub hidden: bool,
    pub group: String,
    pub sort_order: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CategoryGroup {
    pub id: String,
    pub name: String,
    pub is_income: bool,
    pub hidden: bool,
    pub sort_order: f64,
    pub categories: Vec<Category>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Payee {
    pub id: String,
    pub name: String,
    pub transfer_acct: Option<String>,
    pub favorite: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Transaction {
    pub id: String,
    pub is_parent: bool,
    pub is_child: bool,
    pub parent_id: Option<String>,
    pub account: Option<String>,
    pub category: Option<String>,
    pub amount: i64,
    pub payee: Option<String>,
    pub notes: Option<String>,
    /// `YYYY-MM-DD`
    pub date: String,
    pub imported_payee: Option<String>,
    pub starting_balance_flag: bool,
    pub transfer_id: Option<String>,
    pub sort_order: f64,
    pub cleared: bool,
    pub reconciled: bool,
    pub schedule: Option<String>,
    pub error: Option<String>,
    pub subtransactions: Vec<Transaction>,
}

impl Transaction {
    /// The split's unassigned remainder (`amount - Σ children`), if any.
    pub fn split_remainder(&self) -> i64 {
        if !self.is_parent {
            return 0;
        }
        self.amount - self.subtransactions.iter().map(|t| t.amount).sum::<i64>()
    }
}

fn b(r: &Row, idx: &str) -> rusqlite::Result<bool> {
    Ok(r.get::<_, Option<i64>>(idx)?.unwrap_or(0) != 0)
}

pub fn accounts(conn: &Connection) -> rusqlite::Result<Vec<Account>> {
    let mut balances: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT account, SUM(amount), SUM(CASE WHEN cleared = 1 THEN amount ELSE 0 END)
               FROM rs_transactions WHERE is_parent = 0 AND account IS NOT NULL GROUP BY account",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?;
        for row in rows {
            let (id, bal, cleared) = row?;
            balances.insert(id, (bal, cleared));
        }
    }
    let mut stmt = conn.prepare(
        "SELECT id, name, offbudget, closed, sort_order, last_reconciled FROM accounts
          WHERE tombstone = 0 ORDER BY sort_order, name",
    )?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get("id")?;
        let (balance, cleared) = balances.get(&id).copied().unwrap_or((0, 0));
        Ok(Account {
            name: r.get::<_, Option<String>>("name")?.unwrap_or_default(),
            offbudget: b(r, "offbudget")?,
            closed: b(r, "closed")?,
            sort_order: r.get::<_, Option<f64>>("sort_order")?.unwrap_or(0.0),
            balance,
            cleared,
            uncleared: balance - cleared,
            last_reconciled: r.get("last_reconciled")?,
            id,
        })
    })?;
    rows.collect()
}

/// Category groups with their categories, ordered like the web budget.
pub fn category_groups(conn: &Connection) -> rusqlite::Result<Vec<CategoryGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, is_income, hidden, sort_order FROM category_groups
          WHERE tombstone = 0 ORDER BY is_income, sort_order, id",
    )?;
    let mut groups: Vec<CategoryGroup> = stmt
        .query_map([], |r| {
            Ok(CategoryGroup {
                id: r.get("id")?,
                name: r.get::<_, Option<String>>("name")?.unwrap_or_default(),
                is_income: b(r, "is_income")?,
                hidden: b(r, "hidden")?,
                sort_order: r.get::<_, Option<f64>>("sort_order")?.unwrap_or(0.0),
                categories: Vec::new(),
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, is_income, hidden, cat_group, sort_order FROM categories
          WHERE tombstone = 0 ORDER BY sort_order, id",
    )?;
    let cats = stmt.query_map([], |r| {
        Ok(Category {
            id: r.get("id")?,
            name: r.get::<_, Option<String>>("name")?.unwrap_or_default(),
            is_income: b(r, "is_income")?,
            hidden: b(r, "hidden")?,
            group: r.get::<_, Option<String>>("cat_group")?.unwrap_or_default(),
            sort_order: r.get::<_, Option<f64>>("sort_order")?.unwrap_or(0.0),
        })
    })?;
    let idx: HashMap<String, usize> = groups.iter().enumerate().map(|(i, g)| (g.id.clone(), i)).collect();
    for c in cats {
        let c = c?;
        if let Some(&i) = idx.get(&c.group) {
            groups[i].categories.push(c);
        }
    }
    Ok(groups)
}

pub fn payees(conn: &Connection) -> rusqlite::Result<Vec<Payee>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.transfer_acct, p.favorite, a.name AS acct_name FROM rs_payees p
           LEFT JOIN accounts a ON a.id = p.transfer_acct
          ORDER BY p.transfer_acct IS NOT NULL, LOWER(COALESCE(a.name, p.name))",
    )?;
    let rows = stmt.query_map([], |r| {
        let transfer_acct: Option<String> = r.get("transfer_acct")?;
        let name = if transfer_acct.is_some() {
            r.get::<_, Option<String>>("acct_name")?.unwrap_or_default()
        } else {
            r.get::<_, Option<String>>("name")?.unwrap_or_default()
        };
        Ok(Payee { id: r.get("id")?, name, transfer_acct, favorite: b(r, "favorite")? })
    })?;
    rows.collect()
}

pub(crate) fn tx_from_row(r: &Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get("id")?,
        is_parent: b(r, "is_parent")?,
        is_child: b(r, "is_child")?,
        parent_id: r.get("parent_id")?,
        account: r.get("account")?,
        category: r.get("category")?,
        amount: r.get::<_, Option<i64>>("amount")?.unwrap_or(0),
        payee: r.get("payee")?,
        notes: r.get("notes")?,
        date: r.get::<_, Option<i64>>("date")?.map(date_from_db).unwrap_or_default(),
        imported_payee: r.get("imported_payee")?,
        starting_balance_flag: b(r, "starting_balance_flag")?,
        transfer_id: r.get("transfer_id")?,
        sort_order: r.get::<_, Option<f64>>("sort_order")?.unwrap_or(0.0),
        cleared: b(r, "cleared")?,
        reconciled: b(r, "reconciled")?,
        schedule: r.get("schedule")?,
        error: r.get("error")?,
        subtransactions: Vec::new(),
    })
}

const TX_ORDER: &str = "ORDER BY date DESC, starting_balance_flag, sort_order DESC, id";

/// Transactions grouped like the register shows them: parents carry their
/// children in `subtransactions`. `account: None` lists every account.
pub fn transactions(conn: &Connection, account: Option<&str>) -> rusqlite::Result<Vec<Transaction>> {
    let sql = match account {
        Some(_) => format!("SELECT * FROM rs_transactions WHERE account = ?1 {TX_ORDER}"),
        None => format!("SELECT * FROM rs_transactions WHERE account IS NOT NULL OR ?1 IS NULL {TX_ORDER}"),
    };
    let mut stmt = conn.prepare(&sql)?;
    let all: Vec<Transaction> = stmt.query_map(params![account], tx_from_row)?.collect::<Result<_, _>>()?;
    Ok(group_splits(all))
}

pub fn group_splits(all: Vec<Transaction>) -> Vec<Transaction> {
    let mut children: HashMap<String, Vec<Transaction>> = HashMap::new();
    let mut top = Vec::new();
    for t in all {
        match (&t.is_child, &t.parent_id) {
            (true, Some(p)) => children.entry(p.clone()).or_default().push(t),
            _ => top.push(t),
        }
    }
    for t in top.iter_mut() {
        if t.is_parent {
            if let Some(mut kids) = children.remove(&t.id) {
                kids.sort_by(|a, b| b.sort_order.partial_cmp(&a.sort_order).unwrap_or(std::cmp::Ordering::Equal));
                t.subtransactions = kids;
            }
        }
    }
    top
}

/// One transaction (with children if it's a split parent).
pub fn transaction(conn: &Connection, id: &str) -> rusqlite::Result<Option<Transaction>> {
    let t = conn
        .query_row("SELECT * FROM rs_transactions WHERE id = ?", [id], tx_from_row)
        .optional()?;
    let Some(mut t) = t else { return Ok(None) };
    if t.is_parent {
        let mut stmt = conn.prepare("SELECT * FROM rs_transactions WHERE parent_id = ? AND is_child = 1 ORDER BY sort_order DESC, id")?;
        t.subtransactions = stmt.query_map([id], tx_from_row)?.collect::<Result<_, _>>()?;
    }
    Ok(Some(t))
}

/// A synced preference (`preferences` table), e.g. `budgetType`.
pub fn preference(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM preferences WHERE id = ?", [id], |r| r.get(0)).optional().map(Option::flatten)
}

pub fn note(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT note FROM notes WHERE id = ?", [id], |r| r.get(0)).optional().map(Option::flatten)
}
