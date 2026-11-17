//! Calendar months and the integer date forms loot-core stores
//! (`YYYYMMDD` for days, `YYYYMM` for budget months).

use std::fmt;

use chrono::{Datelike, Local, NaiveDate};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Month {
    pub year: i32,
    /// 1-12
    pub month: u32,
}

impl Month {
    pub fn new(year: i32, month: u32) -> Month {
        assert!((1..=12).contains(&month), "month out of range");
        Month { year, month }
    }

    pub fn current() -> Month {
        let d = Local::now().date_naive();
        Month::new(d.year(), d.month())
    }

    /// Parses `YYYY-MM` (or a `YYYY-MM-DD` day).
    pub fn parse(s: &str) -> Option<Month> {
        let mut it = s.split('-');
        let year = it.next()?.parse().ok()?;
        let month = it.next()?.parse().ok()?;
        (1..=12).contains(&month).then(|| Month::new(year, month))
    }

    /// From the `YYYYMM` integer stored in `zero_budgets.month`.
    pub fn from_db(n: i64) -> Option<Month> {
        let month = (n % 100) as u32;
        (1..=12).contains(&month).then(|| Month::new((n / 100) as i32, month))
    }

    pub fn from_db_date(date: i64) -> Option<Month> {
        Month::from_db(date / 100)
    }

    pub fn to_db(self) -> i64 {
        self.year as i64 * 100 + self.month as i64
    }

    pub fn plus(self, n: i32) -> Month {
        let total = self.year * 12 + (self.month as i32 - 1) + n;
        Month::new(total.div_euclid(12), (total.rem_euclid(12) + 1) as u32)
    }

    pub fn prev(self) -> Month {
        self.plus(-1)
    }

    pub fn next(self) -> Month {
        self.plus(1)
    }

    /// First and last day as `YYYYMMDD` integers (`monthUtils.bounds`).
    pub fn bounds(self) -> (i64, i64) {
        let start = self.to_db() * 100 + 1;
        let end = self.to_db() * 100 + self.days() as i64;
        (start, end)
    }

    pub fn days(self) -> u32 {
        let first = NaiveDate::from_ymd_opt(self.year, self.month, 1).expect("valid");
        let next = self.next();
        let next_first = NaiveDate::from_ymd_opt(next.year, next.month, 1).expect("valid");
        (next_first - first).num_days() as u32
    }

    /// Inclusive range of months.
    pub fn range_inclusive(start: Month, end: Month) -> Vec<Month> {
        let mut out = Vec::new();
        let mut m = start;
        while m <= end {
            out.push(m);
            m = m.next();
        }
        out
    }

    pub fn name(self) -> String {
        const NAMES: [&str; 12] = [
            "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
            "November", "December",
        ];
        NAMES[(self.month - 1) as usize].to_string()
    }

    pub fn short_name(self) -> String {
        self.name()[..3].to_string()
    }

    pub fn year_end(self) -> Month {
        Month::new(self.year, 12)
    }
}

impl fmt::Display for Month {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}

/// `YYYY-MM-DD` to the `YYYYMMDD` integer form. Dates before 1995 are
/// rejected like loot-core's `convertInputType`.
pub fn date_to_db(day: &str) -> Option<i64> {
    let d = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    if day < "1995-01-01" {
        return None;
    }
    Some(d.year() as i64 * 10000 + d.month() as i64 * 100 + d.day() as i64)
}

pub fn date_from_db(n: i64) -> String {
    format!("{:04}-{:02}-{:02}", n / 10000, (n / 100) % 100, n % 100)
}

pub fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetic() {
        let m = Month::new(2024, 1);
        assert_eq!(m.prev(), Month::new(2023, 12));
        assert_eq!(m.plus(13), Month::new(2025, 2));
        assert_eq!(Month::new(2024, 2).bounds(), (20240201, 20240229));
        assert_eq!(Month::parse("2024-07-15"), Some(Month::new(2024, 7)));
        assert_eq!(Month::from_db(202412), Some(Month::new(2024, 12)));
        assert_eq!(Month::range_inclusive(Month::new(2024, 11), Month::new(2025, 1)).len(), 3);
    }

    #[test]
    fn dates() {
        assert_eq!(date_to_db("2024-03-05"), Some(20240305));
        assert_eq!(date_to_db("1990-03-05"), None);
        assert_eq!(date_to_db("2024-02-30"), None);
        assert_eq!(date_from_db(20240305), "2024-03-05");
    }
}
