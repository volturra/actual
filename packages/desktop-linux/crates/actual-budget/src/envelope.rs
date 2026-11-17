//! Envelope ("zero-based") budget math, ported cell for cell from loot-core
//! `server/budget/envelope.ts` and `base.ts`. The web app keeps these values
//! in a reactive spreadsheet; here they are computed directly, month by month,
//! from the same tables, so both clients show the same numbers.
//!
//! Per expense category and month:
//!   leftover = budgeted + spent + (prev carryover ? prev leftover : max(prev leftover, 0))
//! Per month:
//!   from-last-month      = prev to-budget + prev buffered-selected
//!   available-funds      = income + from-last-month
//!   last-month-overspent = Σ min(prev leftover, 0) over categories without prev carryover
//!   total-budgeted       = -Σ budgeted
//!   buffered-selected    = manual hold if set, else Σ income of "auto-hold" income categories
//!   to-budget            = available + overspent + total-budgeted - buffered-selected

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::model::{self, CategoryGroup};
use crate::month::{date_from_db, Month};

const MIN_MONTHS_AHEAD: i32 = 12;
const MONTHS_AFTER_LATEST_ALLOCATION: i32 = 3;
const MAX_MONTHS_AHEAD: i32 = 60;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CategoryMonth {
    pub budgeted: i64,
    pub spent: i64,
    /// `leftover`: what's available in the envelope.
    pub balance: i64,
    /// Rollover overspending into next month instead of taking it from
    /// To Budget (the "carryover" arrow).
    pub carryover: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GroupMonth {
    pub budgeted: i64,
    pub spent: i64,
    pub balance: i64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MonthSummary {
    pub total_income: i64,
    pub from_last_month: i64,
    pub available_funds: i64,
    pub last_month_overspent: i64,
    /// Negative sum of budgeted amounts, as loot-core stores it.
    pub total_budgeted: i64,
    /// Manually held for next month (`zero_budget_months.buffered`).
    pub buffered: i64,
    pub buffered_auto: i64,
    pub buffered_selected: i64,
    pub to_budget: i64,
    pub total_spent: i64,
    pub total_balance: i64,
    pub categories: HashMap<String, CategoryMonth>,
    pub groups: HashMap<String, GroupMonth>,
}

#[derive(Clone, Debug, Default)]
pub struct EnvelopeBudget {
    /// The months loot-core would create for this budget, in order.
    pub months: Vec<Month>,
    pub data: HashMap<Month, MonthSummary>,
    pub groups: Vec<CategoryGroup>,
}

impl EnvelopeBudget {
    pub fn month(&self, m: Month) -> Option<&MonthSummary> {
        self.data.get(&m)
    }

    pub fn category(&self, m: Month, cat: &str) -> CategoryMonth {
        self.data.get(&m).and_then(|s| s.categories.get(cat)).cloned().unwrap_or_default()
    }

    pub fn first(&self) -> Option<Month> {
        self.months.first().copied()
    }

    pub fn last(&self) -> Option<Month> {
        self.months.last().copied()
    }
}

/// `getBudgetRange` with the earliest transaction and allocation.
pub fn budget_range(conn: &Connection, current: Month) -> rusqlite::Result<(Month, Month)> {
    let earliest: Option<i64> = conn
        .query_row(
            "SELECT date FROM transactions WHERE isChild=0 AND date IS NOT NULL ORDER BY date ASC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let mut start = earliest.and_then(|d| Month::parse(&date_from_db(d))).unwrap_or(current);
    let end = current;
    if start > end {
        start = end;
    }
    let max_end = end.plus(MAX_MONTHS_AHEAD);
    let start = start.plus(-3);
    let mut end = end.plus(MIN_MONTHS_AHEAD);
    let latest: Option<i64> = conn
        .query_row(
            "SELECT MAX(b.month) FROM zero_budgets b JOIN categories c ON c.id = b.category
              WHERE c.tombstone = 0 AND b.amount != 0",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(latest) = latest.and_then(Month::from_db) {
        let planned = latest.plus(MONTHS_AFTER_LATEST_ALLOCATION);
        if planned > end {
            end = if planned < max_end { planned } else { max_end };
        }
    }
    Ok((start, end))
}

/// Computes every month of the budget.
pub fn compute(conn: &Connection, current: Month) -> rusqlite::Result<EnvelopeBudget> {
    let (start, end) = budget_range(conn, current)?;
    let months = Month::range_inclusive(start, end);
    let groups = model::category_groups(conn)?;

    // budget-<cat> and carryover-<cat> per month (only live categories)
    let mut budgets: HashMap<(i64, String), (i64, bool)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT b.month, b.category, b.amount, b.carryover FROM zero_budgets b
               LEFT JOIN categories c ON c.id = b.category WHERE c.tombstone = 0",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<i64>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        })?;
        for row in rows {
            if let (Some(m), Some(cat), amount, carry) = row? {
                if m != 0 && !cat.is_empty() {
                    budgets.insert((m, cat), (amount.unwrap_or(0), carry == Some(1)));
                }
            }
        }
    }

    // buffered per month; a row with NULL counts as "set" (to null)
    let mut buffered: HashMap<String, Option<i64>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, buffered FROM zero_budget_months")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)))?;
        for row in rows {
            let (id, v) = row?;
            buffered.insert(id, v);
        }
    }

    // sum-amount-<cat> per month, one grouped query like getSumAmountsByMonth
    let mut sums: HashMap<(i64, String), i64> = HashMap::new();
    {
        let (range_start, _) = start.bounds();
        let (_, range_end) = end.bounds();
        let mut stmt = conn.prepare(
            "SELECT t.category, t.date / 100, SUM(t.amount)
               FROM rs_transactions_alive t
               LEFT JOIN accounts a ON a.id = t.account
              WHERE t.date >= ?1 AND t.date <= ?2
                AND t.category IS NOT NULL AND a.offbudget = 0
              GROUP BY t.category, t.date / 100",
        )?;
        let rows = stmt.query_map([range_start, range_end], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?))
        })?;
        for row in rows {
            let (cat, m, amount) = row?;
            sums.insert((m, cat), amount.unwrap_or(0));
        }
    }

    let income_group = groups.iter().find(|g| g.is_income);
    let all_cats: Vec<&model::Category> = groups.iter().flat_map(|g| g.categories.iter()).collect();
    let expense_cats: Vec<&model::Category> = all_cats.iter().copied().filter(|c| !c.is_income).collect();
    let income_cats: Vec<&model::Category> = all_cats.iter().copied().filter(|c| c.is_income).collect();

    let mut data: HashMap<Month, MonthSummary> = HashMap::new();
    // The blank month before the first: carryover false, leftovers 0.
    let mut prev_leftover: HashMap<&str, i64> = HashMap::new();
    let mut prev_carryover: HashMap<&str, bool> = HashMap::new();
    let mut prev_to_budget = 0i64;
    let mut prev_buffered_selected = 0i64;

    for &m in &months {
        let db_month = m.to_db();
        let mut s = MonthSummary::default();
        let sum = |cat: &str| sums.get(&(db_month, cat.to_string())).copied().unwrap_or(0);
        let budget = |cat: &str| budgets.get(&(db_month, cat.to_string())).copied().unwrap_or((0, false));

        for c in &all_cats {
            let spent = sum(&c.id);
            let (budgeted, carryover) = budget(&c.id);
            let cm = if c.is_income {
                CategoryMonth { budgeted: 0, spent, balance: 0, carryover }
            } else {
                let pl = prev_leftover.get(c.id.as_str()).copied().unwrap_or(0);
                let pc = prev_carryover.get(c.id.as_str()).copied().unwrap_or(false);
                let leftover = budgeted + spent + if pc { pl } else { pl.max(0) };
                CategoryMonth { budgeted, spent, balance: leftover, carryover }
            };
            s.categories.insert(c.id.clone(), cm);
        }

        for g in &groups {
            let mut gm = GroupMonth::default();
            for c in &g.categories {
                let cm = &s.categories[&c.id];
                gm.spent += cm.spent;
                if !g.is_income && !c.is_income {
                    gm.budgeted += cm.budgeted;
                    gm.balance += cm.balance;
                }
            }
            s.groups.insert(g.id.clone(), gm);
        }

        s.from_last_month = prev_to_budget + prev_buffered_selected;
        s.total_income = income_group.map(|g| s.groups[&g.id].spent).unwrap_or(0);
        s.available_funds = s.total_income + s.from_last_month;
        s.last_month_overspent = expense_cats
            .iter()
            .map(|c| {
                if prev_carryover.get(c.id.as_str()).copied().unwrap_or(false) {
                    0
                } else {
                    prev_leftover.get(c.id.as_str()).copied().unwrap_or(0).min(0)
                }
            })
            .sum();
        let expense_groups = groups.iter().filter(|g| !g.is_income);
        s.total_budgeted = -expense_groups.clone().map(|g| s.groups[&g.id].budgeted).sum::<i64>();
        s.total_spent = expense_groups.clone().map(|g| s.groups[&g.id].spent).sum();
        s.total_balance = expense_groups.map(|g| s.groups[&g.id].balance).sum();

        s.buffered_auto = income_cats
            .iter()
            .filter(|c| s.categories[&c.id].carryover)
            .map(|c| s.categories[&c.id].spent)
            .sum();
        let manual = buffered.get(&m.to_string());
        s.buffered = manual.copied().flatten().unwrap_or(0);
        s.buffered_selected = match manual {
            // A NULL row still overrides the automatic hold, as in the sheet.
            Some(None) => 0,
            Some(Some(v)) if *v != 0 => *v,
            _ => s.buffered_auto,
        };
        s.to_budget = s.available_funds + s.last_month_overspent + s.total_budgeted - s.buffered_selected;

        prev_leftover.clear();
        prev_carryover.clear();
        for c in &expense_cats {
            let cm = &s.categories[&c.id];
            prev_leftover.insert(c.id.as_str(), cm.balance);
            prev_carryover.insert(c.id.as_str(), cm.carryover);
        }
        prev_to_budget = s.to_budget;
        prev_buffered_selected = s.buffered_selected;
        data.insert(m, s);
    }

    Ok(EnvelopeBudget { months, data, groups })
}
