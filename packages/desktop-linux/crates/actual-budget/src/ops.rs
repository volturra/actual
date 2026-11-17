//! Mutations, ported from loot-core so the messages this client sends are
//! the ones the web client would send for the same action (same tables,
//! columns, ids and companion rows such as `category_mapping`).
//!
//! Each function reads the current database and returns the [`Change`]s to
//! record. Like loot-core's `batchMessages`, reads inside one function see the
//! state from before its own changes; follow-up work that depends on the
//! result (transfers) runs as a second step in [`crate::Budget`].

use rusqlite::{params, Connection, OptionalExtension};

use actual_sync::{Change, Value};

use crate::envelope::EnvelopeBudget;
use crate::month::{date_to_db, today, Month};
use crate::BudgetError;

pub const SORT_INCREMENT: f64 = 16384.0;

/// Collects changes the way `db.insert` / `db.update` / `db.delete_` emit
/// messages: one per column, `id` never sent as a column.
#[derive(Debug, Default)]
pub struct ChangeSet {
    pub changes: Vec<Change>,
}

impl ChangeSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, table: &str, id: &str, fields: Vec<(&str, Value)>) -> &mut Self {
        for (col, value) in fields {
            self.changes.push(Change::new(table, id, col, value));
        }
        self
    }

    /// `insertWithSchema`-style insert: null fields are skipped.
    pub fn insert(&mut self, table: &str, id: &str, fields: Vec<(&str, Value)>) -> &mut Self {
        let fields = fields.into_iter().filter(|(_, v)| *v != Value::Null).collect();
        self.set(table, id, fields)
    }

    pub fn delete(&mut self, table: &str, id: &str) -> &mut Self {
        self.set(table, id, vec![("tombstone", Value::from(1i64))])
    }

    pub fn extend(&mut self, other: ChangeSet) -> &mut Self {
        self.changes.extend(other.changes);
        self
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_sort_order() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// `shoveSortOrders`: sort order to insert before `target` (or append).
pub fn shove_sort_orders(items: &[(String, f64)], target: Option<&str>) -> (Vec<(String, f64)>, f64) {
    let to = target.and_then(|t| items.iter().position(|(id, _)| id == t));
    let Some(to) = to else {
        let order = items.last().map(|(_, s)| s + SORT_INCREMENT).unwrap_or(SORT_INCREMENT);
        return (Vec::new(), order);
    };
    let mut updates = Vec::new();
    let before = if to > 0 { items[to - 1].1 } else { 0.0 };
    if items[to].1 - before <= 2.0 {
        let mut next = to;
        let mut order = items[next].1.floor() + SORT_INCREMENT;
        while next < items.len() {
            if order <= items[next].1 {
                break;
            }
            updates.push((items[next].0.clone(), order));
            next += 1;
            order += SORT_INCREMENT;
        }
    }
    let midpoint = if to == 0 { items[0].1 / 2.0 } else { (items[to - 1].1 + items[to].1) / 2.0 };
    (updates, midpoint)
}

fn sort_items(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> rusqlite::Result<Vec<(String, f64)>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(p, |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<f64>>(1)?.unwrap_or(0.0))))?;
    rows.collect()
}

// ---------------------------------------------------------------- budget

fn zero_budget_id(conn: &Connection, month: Month, category: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM zero_budgets WHERE month = ? AND category = ?",
        params![month.to_db(), category],
        |r| r.get(0),
    )
    .optional()
}

/// `setBudget`.
pub fn set_budget(conn: &Connection, month: Month, category: &str, amount: i64) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    match zero_budget_id(conn, month, category)? {
        Some(id) => cs.set("zero_budgets", &id, vec![("amount", amount.into())]),
        None => cs.set(
            "zero_budgets",
            &format!("{}-{}", month.to_db(), category),
            vec![("month", month.to_db().into()), ("category", category.into()), ("amount", amount.into())],
        ),
    };
    Ok(cs)
}

/// `setCarryover` for one month.
fn set_carryover(conn: &Connection, month: Month, category: &str, flag: bool) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    let v = Value::from(flag);
    match zero_budget_id(conn, month, category)? {
        Some(id) => cs.set("zero_budgets", &id, vec![("carryover", v)]),
        None => cs.set(
            "zero_budgets",
            &format!("{}-{}", month.to_db(), category),
            vec![("month", month.to_db().into()), ("category", category.into()), ("carryover", v)],
        ),
    };
    Ok(cs)
}

/// `setCategoryCarryover`: sets the flag from `start` through the last
/// budget month.
pub fn set_category_carryover(
    conn: &Connection,
    budget: &EnvelopeBudget,
    start: Month,
    category: &str,
    flag: bool,
) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    let last = budget.last().unwrap_or(start);
    for m in Month::range_inclusive(start, last) {
        cs.extend(set_carryover(conn, m, category, flag)?);
    }
    Ok(cs)
}

/// `setBuffer`.
pub fn set_buffer(conn: &Connection, month: Month, amount: i64) -> Result<ChangeSet, BudgetError> {
    let id = month.to_string();
    let exists: bool = conn
        .query_row("SELECT 1 FROM zero_budget_months WHERE id = ?", [&id], |_| Ok(()))
        .optional()?
        .is_some();
    let mut cs = ChangeSet::new();
    let _ = exists; // update and insert send the same single message
    cs.set("zero_budget_months", &id, vec![("buffered", amount.into())]);
    Ok(cs)
}

/// `holdForNextMonth`. Returns an empty set when there's nothing to hold.
pub fn hold_for_next_month(
    conn: &Connection,
    budget: &EnvelopeBudget,
    month: Month,
    amount: i64,
) -> Result<ChangeSet, BudgetError> {
    let to_budget = budget.month(month).map(|s| s.to_budget).unwrap_or(0);
    if to_budget <= 0 {
        return Ok(ChangeSet::new());
    }
    let buffered: i64 = conn
        .query_row("SELECT buffered FROM zero_budget_months WHERE id = ?", [month.to_string()], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .optional()?
        .flatten()
        .unwrap_or(0);
    let amount = amount.max(-buffered).min(to_budget.max(0));
    set_buffer(conn, month, buffered + amount)
}

pub fn reset_hold(conn: &Connection, month: Month) -> Result<ChangeSet, BudgetError> {
    set_buffer(conn, month, 0)
}

fn category_name(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT name FROM categories WHERE id = ?", [id], |r| r.get(0)).optional().map(Option::flatten)
}

/// `addMovementNotes`: appends "Reassigned …" to the month's notes.
fn movement_note(conn: &Connection, month: Month, amount: i64, from: Option<&str>, to: Option<&str>, to_overbudgeted: bool) -> Result<ChangeSet, BudgetError> {
    let id = format!("budget-{month}");
    let existing = crate::model::note(conn, &id)?.filter(|n| !n.is_empty());
    let name = |c: Option<&str>| -> rusqlite::Result<String> {
        Ok(match c {
            None => "To Budget".to_string(),
            Some(id) => category_name(conn, id)?.unwrap_or_default(),
        })
    };
    let to_name = if to_overbudgeted { "Overbudgeted".to_string() } else { name(to)? };
    let day = chrono::Local::now().format("%B %d");
    let line = format!(
        "- Reassigned {} from {} → {} on {}",
        crate::format::amount_plain(amount),
        name(from)?,
        to_name,
        day
    );
    let note = match existing {
        Some(prev) => format!("{prev}\n{line}"),
        None => line,
    };
    let mut cs = ChangeSet::new();
    cs.set("notes", &id, vec![("note", note.into())]);
    Ok(cs)
}

/// `transferCategory`. `to: None` moves money back to To Budget.
pub fn transfer_category(
    conn: &Connection,
    budget: &EnvelopeBudget,
    month: Month,
    amount: i64,
    from: &str,
    to: Option<&str>,
) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    let from_budgeted = budget.category(month, from).budgeted;
    cs.extend(set_budget(conn, month, from, from_budgeted - amount)?);
    if let Some(to) = to {
        let to_budgeted = budget.category(month, to).budgeted;
        cs.extend(set_budget(conn, month, to, to_budgeted + amount)?);
    }
    cs.extend(movement_note(conn, month, amount, Some(from), to, false)?);
    Ok(cs)
}

/// `transferAvailable`: budget money from To Budget into a category.
pub fn transfer_available(
    conn: &Connection,
    budget: &EnvelopeBudget,
    month: Month,
    amount: i64,
    category: &str,
) -> Result<ChangeSet, BudgetError> {
    let left = budget.month(month).map(|s| s.to_budget).unwrap_or(0);
    let amount = amount.min(left).max(0);
    let budgeted = budget.category(month, category).budgeted;
    set_budget(conn, month, category, budgeted + amount)
}

/// `coverOverspending`: `from: None` covers from To Budget. `amount: None`
/// covers all of the overspending.
pub fn cover_overspending(
    conn: &Connection,
    budget: &EnvelopeBudget,
    month: Month,
    to: &str,
    from: Option<&str>,
    amount: Option<i64>,
) -> Result<ChangeSet, BudgetError> {
    let s = budget.month(month).cloned().unwrap_or_default();
    let to_budgeted = budget.category(month, to).budgeted;
    let leftover_from = match from {
        None => s.to_budget,
        Some(f) => budget.category(month, f).balance,
    };
    let amount_to_cover = match amount {
        Some(a) if a != 0 => -a,
        _ => budget.category(month, to).balance,
    };
    if amount_to_cover >= 0 || leftover_from <= 0 {
        return Ok(ChangeSet::new());
    }
    let coverable = amount_to_cover.abs().min(leftover_from);
    let mut cs = ChangeSet::new();
    if let Some(f) = from {
        let from_budgeted = budget.category(month, f).budgeted;
        cs.extend(set_budget(conn, month, f, from_budgeted - coverable)?);
    }
    cs.extend(set_budget(conn, month, to, to_budgeted + coverable)?);
    cs.extend(movement_note(conn, month, coverable, from, Some(to), false)?);
    Ok(cs)
}

/// `copyPreviousMonth`: last month's budgeted amounts for visible expense
/// categories.
pub fn copy_previous_month(conn: &Connection, month: Month) -> Result<ChangeSet, BudgetError> {
    let prev = month.prev();
    let mut stmt = conn.prepare(
        "SELECT b.category, b.amount, c.is_income, c.hidden, g.hidden FROM zero_budgets b
           LEFT JOIN categories c ON b.category = c.id
           LEFT JOIN category_groups g ON c.cat_group = g.id
          WHERE c.tombstone = 0 AND b.month = ?",
    )?;
    // (category, amount, is_income, category hidden, group hidden)
    type PrevRow = (String, Option<i64>, i64, i64, Option<i64>);
    let rows: Vec<PrevRow> = stmt
        .query_map([prev.to_db()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<i64>>(2)?.unwrap_or(0), r.get::<_, Option<i64>>(3)?.unwrap_or(0), r.get(4)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut cs = ChangeSet::new();
    for (cat, amount, is_income, hidden, group_hidden) in rows {
        if is_income == 1 || hidden == 1 || group_hidden == Some(1) {
            continue;
        }
        cs.extend(set_budget(conn, month, &cat, amount.unwrap_or(0))?);
    }
    Ok(cs)
}

/// `setZero`: clears every expense category's budget for the month.
pub fn set_zero(conn: &Connection, month: Month) -> Result<ChangeSet, BudgetError> {
    let ids = sort_items(conn, "SELECT id, 0 FROM categories WHERE tombstone = 0 AND is_income = 0", [])?;
    let mut cs = ChangeSet::new();
    for (id, _) in ids {
        cs.extend(set_budget(conn, month, &id, 0)?);
    }
    Ok(cs)
}

/// `setNMonthAvg` (3/6/12): each visible expense category's average
/// spending, budgeted for `month`.
pub fn set_n_month_avg(conn: &Connection, budget: &EnvelopeBudget, month: Month, n: i32) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    for g in budget.groups.iter().filter(|g| !g.is_income && !g.hidden) {
        for c in g.categories.iter().filter(|c| !c.hidden) {
            let avg = category_average(conn, budget, month, n, &c.id)?;
            cs.extend(set_budget(conn, month, &c.id, -avg)?);
        }
    }
    Ok(cs)
}

/// `getCategoryAverage`: average signed spending over up to `n` months
/// before `month` (never counting the current or future months), skipping
/// months before the category's first activity. Rounded like `Math.round`.
pub fn category_average(conn: &Connection, budget: &EnvelopeBudget, month: Month, n: i32, cat: &str) -> Result<i64, BudgetError> {
    let current = Month::current();
    let start = if month.prev() >= current { current.prev() } else { month.prev() };
    let first: Option<i64> = conn.query_row(
        "SELECT MIN(month) FROM (
           SELECT month FROM zero_budgets WHERE category = ?1 AND month <= ?2
           UNION ALL
           SELECT CAST(t.date / 100 AS INTEGER) FROM rs_transactions_alive t
             LEFT JOIN accounts a ON a.id = t.account
            WHERE t.category = ?1 AND CAST(t.date / 100 AS INTEGER) <= ?2 AND a.offbudget = 0)",
        params![cat, start.to_db()],
        |r| r.get(0),
    )?;
    let mut months = Vec::new();
    let mut m = start;
    for _ in 0..n {
        if first.is_some_and(|f| m.to_db() < f) {
            break;
        }
        months.push(m);
        m = m.prev();
    }
    if months.is_empty() {
        return Ok(0);
    }
    let sum: i64 = months.iter().map(|&m| budget.category(m, cat).spent).sum();
    Ok((sum as f64 / months.len() as f64 + 0.5).floor() as i64)
}

// ------------------------------------------------------------ categories

/// `insertCategoryGroup`.
pub fn create_category_group(conn: &Connection, name: &str, is_income: bool) -> Result<(String, ChangeSet), BudgetError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(BudgetError::Invalid("A category group needs a name.".into()));
    }
    let dup: Option<String> = conn
        .query_row(
            "SELECT name FROM category_groups WHERE UPPER(name) = ? and tombstone = 0 LIMIT 1",
            [name.to_uppercase()],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(existing) = dup {
        return Err(BudgetError::Invalid(format!("A '{existing}' category group already exists.")));
    }
    let last: Option<f64> = conn
        .query_row(
            "SELECT sort_order FROM category_groups WHERE tombstone = 0 ORDER BY sort_order DESC, id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let id = new_id();
    let mut cs = ChangeSet::new();
    cs.insert(
        "category_groups",
        &id,
        vec![
            ("name", name.into()),
            ("is_income", Value::from(is_income)),
            ("sort_order", (last.unwrap_or(0.0) + SORT_INCREMENT).into()),
        ],
    );
    Ok((id, cs))
}

/// `insertCategory` (at the top of its group, like the web app's default).
pub fn create_category(conn: &Connection, name: &str, group: &str) -> Result<(String, ChangeSet), BudgetError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(BudgetError::Invalid("A category needs a name.".into()));
    }
    let is_income: i64 = conn
        .query_row("SELECT is_income FROM category_groups WHERE id = ? AND tombstone = 0", [group], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .optional()?
        .ok_or_else(|| BudgetError::Invalid("That category group no longer exists.".into()))?
        .unwrap_or(0);
    let dup: bool = conn
        .query_row(
            "SELECT 1 FROM categories WHERE cat_group = ? and UPPER(name) = ? and tombstone = 0 LIMIT 1",
            params![group, name.to_uppercase()],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if dup {
        return Err(BudgetError::Invalid(format!("Category '{name}' already exists in this group.")));
    }
    let items = sort_items(
        conn,
        "SELECT id, sort_order FROM categories WHERE cat_group = ? AND tombstone = 0 ORDER BY sort_order, id",
        [group],
    )?;
    let first = items.first().map(|(id, _)| id.clone());
    let (updates, sort_order) = shove_sort_orders(&items, first.as_deref());
    let mut cs = ChangeSet::new();
    for (id, so) in updates {
        cs.set("categories", &id, vec![("sort_order", so.into())]);
    }
    let id = new_id();
    cs.insert(
        "categories",
        &id,
        vec![
            ("name", name.into()),
            ("cat_group", group.into()),
            ("is_income", Value::from(is_income != 0)),
            ("sort_order", sort_order.into()),
        ],
    );
    cs.insert("category_mapping", &id, vec![("transferId", id.clone().into())]);
    Ok((id, cs))
}

pub fn update_category(id: &str, name: Option<&str>, hidden: Option<bool>) -> ChangeSet {
    let mut fields = Vec::new();
    if let Some(n) = name {
        fields.push(("name", Value::from(n.trim())));
    }
    if let Some(h) = hidden {
        fields.push(("hidden", Value::from(h)));
    }
    let mut cs = ChangeSet::new();
    cs.set("categories", id, fields);
    cs
}

pub fn update_category_group(id: &str, name: Option<&str>, hidden: Option<bool>) -> ChangeSet {
    let mut fields = Vec::new();
    if let Some(n) = name {
        fields.push(("name", Value::from(n.trim())));
    }
    if let Some(h) = hidden {
        fields.push(("hidden", Value::from(h)));
    }
    let mut cs = ChangeSet::new();
    cs.set("category_groups", id, fields);
    cs
}

/// `moveCategory`: puts the category in `group`, before `target` (or last).
pub fn move_category(conn: &Connection, id: &str, group: &str, target: Option<&str>) -> Result<ChangeSet, BudgetError> {
    let items = sort_items(
        conn,
        "SELECT id, sort_order FROM categories WHERE cat_group = ? AND tombstone = 0 ORDER BY sort_order, id",
        [group],
    )?;
    let (updates, order) = shove_sort_orders(&items, target);
    let mut cs = ChangeSet::new();
    for (uid, o) in updates {
        cs.set("categories", &uid, vec![("sort_order", o.into())]);
    }
    cs.set("categories", id, vec![("sort_order", order.into()), ("cat_group", group.into())]);
    Ok(cs)
}

/// `moveCategoryGroup`: puts the group before `target` (or last).
pub fn move_category_group(conn: &Connection, id: &str, target: Option<&str>) -> Result<ChangeSet, BudgetError> {
    let items = sort_items(conn, "SELECT id, sort_order FROM category_groups WHERE tombstone = 0 ORDER BY sort_order, id", [])?;
    let (updates, order) = shove_sort_orders(&items, target);
    let mut cs = ChangeSet::new();
    for (uid, o) in updates {
        cs.set("category_groups", &uid, vec![("sort_order", o.into())]);
    }
    cs.set("category_groups", id, vec![("sort_order", order.into())]);
    Ok(cs)
}

/// `deleteCategory`, optionally moving its budgets and transactions to
/// `transfer_to` (the mapping forwards existing transactions).
pub fn delete_category(
    conn: &Connection,
    budget: &EnvelopeBudget,
    id: &str,
    transfer_to: Option<&str>,
) -> Result<ChangeSet, BudgetError> {
    let is_income: i64 = conn
        .query_row("SELECT is_income FROM categories WHERE id = ?", [id], |r| r.get::<_, Option<i64>>(0))
        .optional()?
        .ok_or_else(|| BudgetError::Invalid("Category not found.".into()))?
        .unwrap_or(0);
    let mut cs = ChangeSet::new();
    if let Some(t) = transfer_to {
        let t_income: i64 = conn
            .query_row("SELECT is_income FROM categories WHERE id = ?", [t], |r| r.get::<_, Option<i64>>(0))
            .optional()?
            .ok_or_else(|| BudgetError::Invalid("Transfer category not found.".into()))?
            .unwrap_or(0);
        if t_income != is_income {
            return Err(BudgetError::Invalid("Cannot transfer between income and expense categories.".into()));
        }
        if is_income == 0 {
            cs.extend(do_transfer(conn, budget, &[id.to_string()], t)?);
        }
        cs.extend(forward_category(conn, id, t)?);
    }
    cs.delete("categories", id);
    Ok(cs)
}

/// `doTransfer`: adds the categories' budgets onto the target's, one
/// `setBudget` per month.
fn do_transfer(conn: &Connection, budget: &EnvelopeBudget, from: &[String], to: &str) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    for &m in &budget.months {
        let mut total = budget_amount(conn, m, to)?;
        for id in from {
            total += budget_amount(conn, m, id)?;
        }
        cs.extend(set_budget(conn, m, to, total)?);
    }
    Ok(cs)
}

/// The mapping half of `db.deleteCategory`: transactions (and categories
/// already forwarded here) now point at `t`.
fn forward_category(conn: &Connection, id: &str, t: &str) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    {
        let forwarded = sort_items(conn, "SELECT id, 0 FROM category_mapping WHERE transferId = ?", [id])?;
        for (mid, _) in forwarded {
            cs.set("category_mapping", &mid, vec![("transferId", t.into())]);
        }
        cs.set("category_mapping", id, vec![("transferId", t.into())]);
    }
    Ok(cs)
}

fn budget_amount(conn: &Connection, month: Month, category: &str) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row("SELECT amount FROM zero_budgets WHERE month = ? AND category = ?", params![month.to_db(), category], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .optional()?
        .flatten()
        .unwrap_or(0))
}

pub fn delete_category_group(
    conn: &Connection,
    budget: &EnvelopeBudget,
    id: &str,
    transfer_to: Option<&str>,
) -> Result<ChangeSet, BudgetError> {
    let cats: Vec<String> = sort_items(conn, "SELECT id, 0 FROM categories WHERE cat_group = ? AND tombstone = 0", [id])?
        .into_iter()
        .map(|(c, _)| c)
        .collect();
    let mut cs = ChangeSet::new();
    if let Some(t) = transfer_to {
        let (g_income, t_income): (i64, i64) = conn.query_row(
            "SELECT IFNULL((SELECT is_income FROM category_groups WHERE id = ?1), 0),
                    IFNULL((SELECT is_income FROM categories WHERE id = ?2), -1)",
            params![id, t],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if t_income == -1 {
            return Err(BudgetError::Invalid("Transfer category not found.".into()));
        }
        if t_income != g_income {
            return Err(BudgetError::Invalid("Cannot transfer between income and expense categories.".into()));
        }
        if g_income == 0 {
            cs.extend(do_transfer(conn, budget, &cats, t)?);
        }
    }
    for cat in &cats {
        if let Some(t) = transfer_to {
            cs.extend(forward_category(conn, cat, t)?);
        }
        cs.delete("categories", cat);
    }
    cs.delete("category_groups", id);
    Ok(cs)
}

// -------------------------------------------------------------- payees

/// `insertPayee`: a payee row plus its self-mapping.
pub fn insert_payee(name: &str, transfer_acct: Option<&str>) -> (String, ChangeSet) {
    let id = new_id();
    let mut cs = ChangeSet::new();
    cs.insert("payees", &id, vec![("name", name.into()), ("transfer_acct", transfer_acct.map(str::to_string).into())]);
    cs.insert("payee_mapping", &id, vec![("targetId", id.clone().into())]);
    (id, cs)
}

/// `createPayee`: reuses an existing payee with the same name.
pub fn get_or_create_payee(conn: &Connection, name: &str) -> Result<(String, ChangeSet), BudgetError> {
    let name = name.trim();
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM payees WHERE LOWER(name) = LOWER(?) AND tombstone = 0 AND transfer_acct IS NULL LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok((id, ChangeSet::new()));
    }
    Ok(insert_payee(name, None))
}

pub fn transfer_payee(conn: &Connection, account: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0", [account], |r| r.get(0))
        .optional()
}

// ------------------------------------------------------------ accounts

/// `createAccount`: the account, its transfer payee and an optional
/// starting balance transaction.
pub fn create_account(
    conn: &Connection,
    name: &str,
    balance: i64,
    offbudget: bool,
) -> Result<(String, ChangeSet), BudgetError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(BudgetError::Invalid("An account needs a name.".into()));
    }
    let items = sort_items(
        conn,
        "SELECT id, sort_order FROM accounts WHERE offbudget = ? ORDER BY sort_order, name",
        [offbudget as i64],
    )?;
    let (_, sort_order) = shove_sort_orders(&items, None);
    let id = new_id();
    let mut cs = ChangeSet::new();
    cs.insert(
        "accounts",
        &id,
        vec![
            ("name", name.into()),
            ("offbudget", Value::from(offbudget)),
            ("closed", Value::from(false)),
            ("sort_order", sort_order.into()),
        ],
    );
    let (_, payee_cs) = insert_payee("", Some(&id));
    cs.extend(payee_cs);
    if balance != 0 {
        // getStartingBalancePayee
        let category: Option<String> = conn
            .query_row(
                "SELECT id FROM categories WHERE is_income = 1 AND LOWER(name) = 'starting balances' AND tombstone = 0",
                [],
                |r| r.get(0),
            )
            .optional()?
            .or(conn
                .query_row("SELECT id FROM categories WHERE is_income = 1 AND tombstone = 0", [], |r| r.get(0))
                .optional()?);
        let (payee, pcs) = get_or_create_payee(conn, "Starting Balance")?;
        cs.extend(pcs);
        let tx = NewTransaction {
            account: id.clone(),
            date: today(),
            amount: balance,
            payee: Some(payee),
            category: if offbudget { None } else { category },
            notes: None,
            cleared: true,
            starting_balance_flag: true,
            ..Default::default()
        };
        cs.extend(insert_transaction(&tx)?.1);
    }
    Ok((id, cs))
}

pub fn update_account(id: &str, name: Option<&str>, offbudget: Option<bool>) -> ChangeSet {
    let mut fields = Vec::new();
    if let Some(n) = name {
        fields.push(("name", Value::from(n.trim())));
    }
    if let Some(o) = offbudget {
        fields.push(("offbudget", Value::from(o)));
    }
    let mut cs = ChangeSet::new();
    cs.set("accounts", id, fields);
    cs
}

/// `closeAccount`. An account without transactions is deleted. Otherwise a
/// non-zero balance must be moved out first (the caller adds the closing
/// transfer), unless `force`, which deletes the account with all its
/// transactions and unlinks their transfer counterparts, like the web's
/// "force close".
pub fn close_account(conn: &Connection, id: &str, force: bool) -> Result<ChangeSet, BudgetError> {
    let (balance, count): (i64, i64) = conn.query_row(
        "SELECT IFNULL(SUM(CASE WHEN is_parent = 0 THEN amount END), 0), COUNT(*) FROM rs_transactions WHERE account = ?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut cs = ChangeSet::new();
    if count == 0 {
        cs.delete("accounts", id);
        return Ok(cs);
    }
    if force {
        let payee = transfer_payee(conn, id)?
            .ok_or_else(|| BudgetError::Invalid("This account's transfer payee is missing.".into()))?;
        let mut stmt = conn.prepare("SELECT id, transfer_id FROM rs_transactions WHERE account = ?")?;
        let rows: Vec<(String, Option<String>)> =
            stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        for (tid, transfer) in rows {
            if let Some(other) = transfer {
                cs.set("transactions", &other, vec![("description", Value::Null), ("transferred_id", Value::Null)]);
            }
            cs.delete("transactions", &tid);
        }
        cs.delete("accounts", id);
        cs.delete("payees", &payee);
        return Ok(cs);
    }
    if balance != 0 {
        return Err(BudgetError::Invalid("This account still has a balance. Transfer it to another account first.".into()));
    }
    cs.set("accounts", id, vec![("closed", Value::from(true))]);
    Ok(cs)
}

pub fn reopen_account(id: &str) -> ChangeSet {
    let mut cs = ChangeSet::new();
    cs.set("accounts", id, vec![("closed", Value::from(false))]);
    cs
}

// -------------------------------------------------------- transactions

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewTransaction {
    pub id: Option<String>,
    pub account: String,
    /// `YYYY-MM-DD`
    pub date: String,
    pub amount: i64,
    pub payee: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub cleared: bool,
    pub starting_balance_flag: bool,
    /// Split lines; when non-empty this transaction is a split parent.
    pub splits: Vec<SplitLine>,
    pub sort_order: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SplitLine {
    pub id: Option<String>,
    pub amount: i64,
    pub payee: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
}

fn split_error(parent_amount: i64, lines: &[SplitLine]) -> Option<String> {
    let total: i64 = lines.iter().map(|l| l.amount).sum();
    (total != parent_amount).then(|| {
        serde_json::json!({ "type": "SplitTransactionError", "version": 1, "difference": parent_amount - total })
            .to_string()
    })
}

/// `insertTransaction` for a transaction (and its split lines). Returns the
/// ids inserted, parent first.
pub fn insert_transaction(tx: &NewTransaction) -> Result<(Vec<String>, ChangeSet), BudgetError> {
    let date = date_to_db(&tx.date).ok_or_else(|| BudgetError::Invalid(format!("Invalid date: {}", tx.date)))?;
    let id = tx.id.clone().unwrap_or_else(new_id);
    let sort_order = tx.sort_order.unwrap_or_else(now_sort_order);
    let is_parent = !tx.splits.is_empty();
    let mut cs = ChangeSet::new();
    let mut fields = vec![
        ("acct", Value::from(tx.account.clone())),
        ("category", if is_parent { Value::Null } else { tx.category.clone().into() }),
        ("amount", tx.amount.into()),
        ("description", tx.payee.clone().into()),
        ("notes", tx.notes.clone().filter(|n| !n.is_empty()).into()),
        ("date", date.into()),
        ("sort_order", sort_order.into()),
        ("cleared", Value::from(tx.cleared)),
        ("reconciled", Value::from(false)),
    ];
    if tx.starting_balance_flag {
        fields.push(("starting_balance_flag", Value::from(true)));
    }
    if is_parent {
        fields.push(("isParent", Value::from(true)));
        fields.push(("error", split_error(tx.amount, &tx.splits).into()));
    }
    cs.insert("transactions", &id, fields);
    let mut ids = vec![id.clone()];
    for (i, line) in tx.splits.iter().enumerate() {
        let cid = line.id.clone().unwrap_or_else(new_id);
        cs.insert(
            "transactions",
            &cid,
            vec![
                ("isChild", Value::from(true)),
                ("parent_id", id.clone().into()),
                ("acct", tx.account.clone().into()),
                ("category", line.category.clone().into()),
                ("amount", line.amount.into()),
                ("description", line.payee.clone().or(tx.payee.clone()).into()),
                ("notes", line.notes.clone().filter(|n| !n.is_empty()).into()),
                ("date", date.into()),
                ("sort_order", (sort_order - (i as f64 + 1.0)).into()),
                ("cleared", Value::from(tx.cleared)),
                ("reconciled", Value::from(false)),
            ],
        );
        ids.push(cid);
    }
    Ok((ids, cs))
}

/// Field edits to an existing transaction (`updateTransaction`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TransactionUpdate {
    pub account: Option<String>,
    pub date: Option<String>,
    pub amount: Option<i64>,
    pub payee: Option<Option<String>>,
    pub category: Option<Option<String>>,
    pub notes: Option<Option<String>>,
    pub cleared: Option<bool>,
    pub reconciled: Option<bool>,
}

impl TransactionUpdate {
    pub fn is_empty(&self) -> bool {
        *self == TransactionUpdate::default()
    }
}

pub fn update_transaction(conn: &Connection, id: &str, u: &TransactionUpdate) -> Result<ChangeSet, BudgetError> {
    let current = crate::model::transaction(conn, id)?.ok_or_else(|| BudgetError::Invalid("Transaction not found.".into()))?;
    let mut fields: Vec<(&str, Value)> = Vec::new();
    let mut to_offbudget = false;
    if let Some(a) = &u.account {
        fields.push(("acct", a.clone().into()));
        let offbudget: bool = conn
            .query_row("SELECT offbudget FROM accounts WHERE id = ? AND tombstone = 0", [a], |r| r.get::<_, Option<i64>>(0))
            .optional()?
            .flatten()
            .unwrap_or(0)
            != 0;
        if offbudget || current.is_parent {
            fields.push(("category", Value::Null));
        }
        to_offbudget = offbudget;
    }
    if let Some(d) = &u.date {
        let d = date_to_db(d).ok_or_else(|| BudgetError::Invalid(format!("Invalid date: {d}")))?;
        fields.push(("date", d.into()));
    }
    if let Some(a) = u.amount {
        fields.push(("amount", a.into()));
    }
    if let Some(p) = &u.payee {
        fields.push(("description", p.clone().into()));
    }
    if let Some(c) = &u.category {
        if !fields.iter().any(|(k, _)| *k == "category") {
            fields.push(("category", if current.is_parent { Value::Null } else { c.clone().into() }));
        }
    }
    if let Some(n) = &u.notes {
        fields.push(("notes", n.clone().filter(|n| !n.is_empty()).into()));
    }
    if let Some(c) = u.cleared {
        fields.push(("cleared", Value::from(c)));
    }
    if let Some(r) = u.reconciled {
        fields.push(("reconciled", Value::from(r)));
    }
    let mut cs = ChangeSet::new();
    cs.set("transactions", id, fields.clone());
    // A split parent's shared fields flow down to its lines, as the web
    // client's `updateTransaction` does for date, account and cleared.
    if current.is_parent {
        let shared: Vec<(&str, Value)> = fields
            .into_iter()
            .filter(|(k, _)| matches!(*k, "date" | "acct" | "cleared" | "reconciled"))
            .collect();
        if !shared.is_empty() {
            for child in &current.subtransactions {
                let mut f = shared.clone();
                // Off-budget transactions (split lines too) have no category.
                if to_offbudget {
                    f.push(("category", Value::Null));
                }
                cs.set("transactions", &child.id, f);
            }
        }
        // Lines that followed the parent's payee (or had none) take the new
        // one, or none when it's cleared (`updateTransaction` in
        // shared/transactions.ts with `makeChild`).
        if let Some(p) = &u.payee {
            for child in &current.subtransactions {
                if child.payee == current.payee || child.payee.is_none() {
                    cs.set("transactions", &child.id, vec![("description", p.clone().into())]);
                }
            }
        }
    }
    if let Some(a) = u.amount {
        if let Some(parent_id) = current.parent_id.as_deref().filter(|_| current.is_child) {
            cs.extend(refresh_split_error(conn, parent_id, Some((id, a)))?);
        } else if current.is_parent {
            let lines: Vec<SplitLine> = current.subtransactions.iter().map(|t| SplitLine { amount: t.amount, ..Default::default() }).collect();
            cs.set("transactions", id, vec![("error", split_error(a, &lines).into())]);
        }
    }
    Ok(cs)
}

/// Recomputes a split parent's `error` after a line changes.
fn refresh_split_error(conn: &Connection, parent_id: &str, changed: Option<(&str, i64)>) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    let Some(parent) = crate::model::transaction(conn, parent_id)? else { return Ok(cs) };
    let lines: Vec<SplitLine> = parent
        .subtransactions
        .iter()
        .map(|t| SplitLine {
            amount: match changed {
                Some((id, a)) if id == t.id => a,
                _ => t.amount,
            },
            ..Default::default()
        })
        .collect();
    cs.set("transactions", parent_id, vec![("error", split_error(parent.amount, &lines).into())]);
    Ok(cs)
}

/// Replaces a transaction's split lines (turns a normal transaction into a
/// split, edits lines, or with no lines turns a split back into a normal one).
/// Also returns the ids of the lines it removes, which must go to
/// `Budget::edit_transactions` as deleted so their transfers are removed.
pub fn set_splits(conn: &Connection, id: &str, lines: &[SplitLine]) -> Result<(ChangeSet, Vec<String>), BudgetError> {
    set_splits_with_amount(conn, id, lines, None)
}

/// `set_splits` when the parent's amount is changing in the same batch.
pub fn set_splits_with_amount(
    conn: &Connection,
    id: &str,
    lines: &[SplitLine],
    parent_amount: Option<i64>,
) -> Result<(ChangeSet, Vec<String>), BudgetError> {
    let current = crate::model::transaction(conn, id)?.ok_or_else(|| BudgetError::Invalid("Transaction not found.".into()))?;
    let account = current.account.clone().ok_or_else(|| BudgetError::Invalid("Transaction has no account.".into()))?;
    let date = date_to_db(&current.date).ok_or_else(|| BudgetError::Invalid("Invalid date".into()))?;
    let mut cs = ChangeSet::new();
    let mut removed = Vec::new();
    let keep: Vec<&str> = lines.iter().filter_map(|l| l.id.as_deref()).collect();
    for child in &current.subtransactions {
        if !keep.contains(&child.id.as_str()) {
            cs.delete("transactions", &child.id);
            removed.push(child.id.clone());
        }
    }
    if lines.is_empty() {
        if current.is_parent {
            cs.set("transactions", id, vec![("isParent", Value::from(false)), ("error", Value::Null)]);
        }
        return Ok((cs, removed));
    }
    cs.set(
        "transactions",
        id,
        vec![("isParent", Value::from(true)), ("category", Value::Null), ("error", split_error(parent_amount.unwrap_or(current.amount), lines).into())],
    );
    for (i, line) in lines.iter().enumerate() {
        let sort_order = current.sort_order - (i as f64 + 1.0);
        match &line.id {
            Some(cid) if current.subtransactions.iter().any(|c| &c.id == cid) => {
                cs.set(
                    "transactions",
                    cid,
                    vec![
                        ("amount", line.amount.into()),
                        ("category", line.category.clone().into()),
                        ("description", line.payee.clone().or(current.payee.clone()).into()),
                        ("notes", line.notes.clone().filter(|n| !n.is_empty()).into()),
                        ("sort_order", sort_order.into()),
                    ],
                );
            }
            _ => {
                let cid = line.id.clone().unwrap_or_else(new_id);
                cs.insert(
                    "transactions",
                    &cid,
                    vec![
                        ("isChild", Value::from(true)),
                        ("parent_id", id.into()),
                        ("acct", account.clone().into()),
                        ("category", line.category.clone().into()),
                        ("amount", line.amount.into()),
                        ("description", line.payee.clone().or(current.payee.clone()).into()),
                        ("notes", line.notes.clone().filter(|n| !n.is_empty()).into()),
                        ("date", date.into()),
                        ("sort_order", sort_order.into()),
                        ("cleared", Value::from(current.cleared)),
                        ("reconciled", Value::from(false)),
                    ],
                );
            }
        }
    }
    Ok((cs, removed))
}

/// Deletes a transaction and, for a split, its lines (`idsWithChildren`).
pub fn delete_transaction(conn: &Connection, id: &str) -> Result<(Vec<String>, ChangeSet), BudgetError> {
    let mut ids = vec![id.to_string()];
    let kids = sort_items(conn, "SELECT id, 0 FROM rs_transactions_internal WHERE parent_id = ?", [id])?;
    ids.extend(kids.into_iter().map(|(k, _)| k));
    let mut cs = ChangeSet::new();
    for i in &ids {
        cs.delete("transactions", i);
    }
    Ok((ids, cs))
}

/// Runs transfer bookkeeping (`transfer.onInsert` / `onUpdate` / `onDelete`)
/// for transactions changed in a previous step.
pub fn transfer_followups(
    conn: &Connection,
    changed: &[String],
    deleted: &[(String, Option<String>)],
) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    for (id, transfer_id) in deleted {
        if let Some(tid) = transfer_id {
            cs.extend(remove_transfer(conn, id, tid, false)?);
        }
    }
    for id in changed {
        let Some(t) = crate::model::transaction(conn, id)? else { continue };
        if t.is_parent {
            if let Some(tid) = &t.transfer_id {
                cs.extend(remove_transfer(conn, &t.id, tid, true)?);
            }
            continue;
        }
        let transfer_acct: Option<String> = match &t.payee {
            Some(p) => conn
                .query_row("SELECT transfer_acct FROM rs_payees WHERE id = ?", [p], |r| r.get(0))
                .optional()?
                .flatten(),
            None => None,
        };
        match (transfer_acct, &t.transfer_id) {
            (Some(acct), None) => cs.extend(add_transfer(conn, &t, &acct)?),
            (None, Some(tid)) => cs.extend(remove_transfer(conn, &t.id, tid, true)?),
            (Some(acct), Some(tid)) => cs.extend(update_transfer(conn, &t, tid, &acct)?),
            (None, None) => &mut cs,
        };
    }
    Ok(cs)
}

fn offbudget(conn: &Connection, account: &str) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row("SELECT offbudget FROM accounts WHERE id = ?", [account], |r| r.get::<_, Option<i64>>(0))
        .optional()?
        .flatten()
        .unwrap_or(0))
}

fn clear_category_cs(conn: &Connection, t: &crate::model::Transaction, other_id: Option<&str>, transfer_acct: &str) -> rusqlite::Result<ChangeSet> {
    let mut cs = ChangeSet::new();
    let from = t.account.as_deref().map(|a| offbudget(conn, a)).transpose()?.unwrap_or(0);
    if from == offbudget(conn, transfer_acct)? {
        cs.set("transactions", &t.id, vec![("category", Value::Null)]);
        if let Some(o) = other_id {
            cs.set("transactions", o, vec![("category", Value::Null)]);
        }
    }
    Ok(cs)
}

fn add_transfer(conn: &Connection, t: &crate::model::Transaction, transfer_acct: &str) -> Result<ChangeSet, BudgetError> {
    let account = t.account.clone().unwrap_or_default();
    let from_payee = transfer_payee(conn, &account)?;
    let other = NewTransaction {
        account: transfer_acct.to_string(),
        date: t.date.clone(),
        amount: -t.amount,
        payee: from_payee,
        notes: t.notes.clone(),
        cleared: false,
        ..Default::default()
    };
    let (ids, mut cs) = insert_transaction(&other)?;
    let other_id = ids[0].clone();
    cs.set("transactions", &other_id, vec![("transferred_id", t.id.clone().into())]);
    if let Some(s) = &t.schedule {
        cs.set("transactions", &other_id, vec![("schedule", s.clone().into())]);
    }
    cs.set("transactions", &t.id, vec![("transferred_id", other_id.clone().into())]);
    cs.extend(clear_category_cs(conn, t, None, transfer_acct)?);
    Ok(cs)
}

fn remove_transfer(conn: &Connection, id: &str, transfer_id: &str, clear_own: bool) -> Result<ChangeSet, BudgetError> {
    let mut cs = ChangeSet::new();
    if let Some(other) = crate::model::transaction(conn, transfer_id)? {
        if other.is_child {
            cs.set("transactions", transfer_id, vec![("transferred_id", Value::Null), ("description", Value::Null)]);
        } else {
            cs.delete("transactions", transfer_id);
        }
    }
    if clear_own {
        cs.set("transactions", id, vec![("transferred_id", Value::Null)]);
    }
    Ok(cs)
}

fn update_transfer(conn: &Connection, t: &crate::model::Transaction, transfer_id: &str, transfer_acct: &str) -> Result<ChangeSet, BudgetError> {
    let account = t.account.clone().unwrap_or_default();
    let payee = transfer_payee(conn, &account)?;
    let mut cs = ChangeSet::new();
    cs.set(
        "transactions",
        transfer_id,
        vec![
            ("acct", transfer_acct.into()),
            ("description", payee.into()),
            ("notes", t.notes.clone().into()),
            ("amount", (-t.amount).into()),
            ("schedule", t.schedule.clone().into()),
        ],
    );
    cs.extend(clear_category_cs(conn, t, Some(transfer_id), transfer_acct)?);
    Ok(cs)
}

/// Marks every cleared transaction in the account reconciled (the
/// "Reconcile" button's final step) and records when.
pub fn reconcile_account(conn: &Connection, account: &str) -> Result<ChangeSet, BudgetError> {
    let ids = sort_items(
        conn,
        "SELECT id, 0 FROM rs_transactions WHERE account = ? AND cleared = 1 AND reconciled = 0",
        [account],
    )?;
    let mut cs = ChangeSet::new();
    for (id, _) in ids {
        cs.set("transactions", &id, vec![("reconciled", Value::from(true))]);
    }
    cs.set(
        "accounts",
        account,
        vec![("last_reconciled", chrono::Utc::now().timestamp_millis().to_string().into())],
    );
    Ok(cs)
}

pub fn set_note(id: &str, note: &str) -> ChangeSet {
    let mut cs = ChangeSet::new();
    cs.set("notes", id, vec![("note", note.into())]);
    cs
}
