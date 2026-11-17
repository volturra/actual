//! Amount formatting and parsing following the budget's synced
//! `numberFormat` / `hideFraction` preferences.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum NumberFormat {
    #[default]
    CommaDot,
    DotComma,
    SpaceComma,
    ApostropheDot,
    CommaDotIn,
}

impl NumberFormat {
    pub fn from_pref(s: Option<&str>) -> NumberFormat {
        match s {
            Some("dot-comma") => NumberFormat::DotComma,
            Some("space-comma") => NumberFormat::SpaceComma,
            Some("apostrophe-dot") => NumberFormat::ApostropheDot,
            Some("comma-dot-in") => NumberFormat::CommaDotIn,
            _ => NumberFormat::CommaDot,
        }
    }

    fn separators(self) -> (&'static str, char) {
        match self {
            NumberFormat::CommaDot | NumberFormat::CommaDotIn => (",", '.'),
            NumberFormat::DotComma => (".", ','),
            NumberFormat::SpaceComma => ("\u{202F}", ','),
            // loot-core uses the right single quotation mark.
            NumberFormat::ApostropheDot => ("\u{2019}", '.'),
        }
    }
}

/// The largest amount (in cents) loot-core accepts (`MAX_SAFE_NUMBER`).
pub const MAX_AMOUNT: i64 = (1 << 51) - 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AmountFormat {
    pub format: NumberFormat,
    pub hide_fraction: bool,
}

impl AmountFormat {
    /// The format for a field the user edits: always with cents, so
    /// hideFraction can't round an amount that's saved back.
    pub fn editable(self) -> AmountFormat {
        AmountFormat { hide_fraction: false, ..self }
    }

    /// Formats integer cents, e.g. `-123456` → `-1,234.56`.
    pub fn format(&self, cents: i64) -> String {
        let (group, decimal) = self.format.separators();
        let neg = cents < 0;
        let abs = cents.unsigned_abs();
        let (whole, frac) = if self.hide_fraction {
            // Round half away from zero like Intl.NumberFormat.
            ((abs + 50) / 100, 0)
        } else {
            (abs / 100, abs % 100)
        };
        let digits = whole.to_string();
        let grouped = if self.format == NumberFormat::CommaDotIn {
            group_indian(&digits, group)
        } else {
            group_thousands(&digits, group)
        };
        let mut s = String::new();
        if neg && (whole != 0 || frac != 0) {
            s.push('-');
        }
        s.push_str(&grouped);
        if !self.hide_fraction {
            s.push(decimal);
            s.push_str(&format!("{frac:02}"));
        }
        s
    }

    /// Parses user input into cents. Accepts either decimal separator,
    /// grouping characters, a leading `-` or parentheses, and simple
    /// `+ - * /` arithmetic like the web app's amount fields.
    pub fn parse(&self, input: &str) -> Option<i64> {
        let (_, decimal) = self.format.separators();
        let cleaned: String = input
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '\u{202F}' && *c != '\'' && *c != '\u{2019}' && !"$€£¥₹".contains(*c))
            .collect();
        if cleaned.is_empty() {
            return None;
        }
        let normalized = normalize_number(&cleaned, decimal);
        let value = eval(&normalized)?;
        if !value.is_finite() {
            return None;
        }
        let cents = (value * 100.0).round();
        // loot-core refuses amounts beyond MAX_SAFE_NUMBER (2^51 - 1).
        (cents.abs() <= MAX_AMOUNT as f64).then_some(cents as i64)
    }
}

fn group_thousands(digits: &str, sep: &str) -> String {
    let bytes = digits.as_bytes();
    let mut out = String::new();
    for (i, c) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push_str(sep);
        }
        out.push(*c as char);
    }
    out
}

fn group_indian(digits: &str, sep: &str) -> String {
    if digits.len() <= 3 {
        return digits.to_string();
    }
    let (head, tail) = digits.split_at(digits.len() - 3);
    let mut out = String::new();
    let hb = head.as_bytes();
    for (i, c) in hb.iter().enumerate() {
        if i > 0 && (hb.len() - i) % 2 == 0 {
            out.push_str(sep);
        }
        out.push(*c as char);
    }
    out.push_str(sep);
    out.push_str(tail);
    out
}

/// Rewrites a number written with `decimal` as its decimal separator into
/// plain `.`-decimal form. The last `.` or `,` followed by 1-2 digits is the
/// decimal point when it matches the user's format or is the only separator.
fn normalize_number(s: &str, decimal: char) -> String {
    let mut out = String::new();
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        let last_sep = token.rfind(['.', ',']);
        let normalized = match last_sep {
            None => token.clone(),
            Some(pos) => {
                let sep = token.as_bytes()[pos] as char;
                let after = &token[pos + 1..];
                let only_one_kind = !token[..pos].contains(if sep == '.' { ',' } else { '.' });
                let is_decimal = sep == decimal || (after.len() != 3 && only_one_kind && token.matches(sep).count() == 1);
                if is_decimal {
                    let whole: String = token[..pos].chars().filter(|c| c.is_ascii_digit()).collect();
                    format!("{whole}.{after}")
                } else {
                    token.chars().filter(|c| c.is_ascii_digit()).collect()
                }
            }
        };
        out.push_str(&normalized);
        token.clear();
    };
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' || c == ',' {
            token.push(c);
        } else {
            flush(&mut token, &mut out);
            out.push(c);
        }
    }
    flush(&mut token, &mut out);
    out
}

/// A tiny arithmetic evaluator: numbers, + - * /, parentheses, unary minus.
fn eval(s: &str) -> Option<f64> {
    struct P<'a> {
        b: &'a [u8],
        i: usize,
    }
    impl P<'_> {
        fn peek(&self) -> Option<u8> {
            self.b.get(self.i).copied()
        }
        fn expr(&mut self) -> Option<f64> {
            let mut v = self.term()?;
            while let Some(c) = self.peek() {
                match c {
                    b'+' => {
                        self.i += 1;
                        v += self.term()?;
                    }
                    b'-' => {
                        self.i += 1;
                        v -= self.term()?;
                    }
                    _ => break,
                }
            }
            Some(v)
        }
        fn term(&mut self) -> Option<f64> {
            let mut v = self.factor()?;
            while let Some(c) = self.peek() {
                match c {
                    b'*' => {
                        self.i += 1;
                        v *= self.factor()?;
                    }
                    b'/' => {
                        self.i += 1;
                        let d = self.factor()?;
                        if d == 0.0 {
                            return None;
                        }
                        v /= d;
                    }
                    _ => break,
                }
            }
            Some(v)
        }
        fn factor(&mut self) -> Option<f64> {
            match self.peek()? {
                b'-' => {
                    self.i += 1;
                    Some(-self.factor()?)
                }
                b'+' => {
                    self.i += 1;
                    self.factor()
                }
                b'(' => {
                    self.i += 1;
                    let v = self.expr()?;
                    if self.peek()? != b')' {
                        return None;
                    }
                    self.i += 1;
                    Some(v)
                }
                _ => {
                    let start = self.i;
                    while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == b'.') {
                        self.i += 1;
                    }
                    std::str::from_utf8(&self.b[start..self.i]).ok()?.parse().ok()
                }
            }
        }
    }
    let mut p = P { b: s.as_bytes(), i: 0 };
    let v = p.expr()?;
    (p.i == s.len()).then_some(v)
}

/// `1234.5` style without grouping, for notes.
pub fn amount_plain(cents: i64) -> String {
    AmountFormat::default().format(cents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        let f = AmountFormat::default();
        assert_eq!(f.format(123456), "1,234.56");
        assert_eq!(f.format(-5), "-0.05");
        assert_eq!(f.format(0), "0.00");
        let de = AmountFormat { format: NumberFormat::DotComma, hide_fraction: false };
        assert_eq!(de.format(123456789), "1.234.567,89");
        let inr = AmountFormat { format: NumberFormat::CommaDotIn, hide_fraction: false };
        assert_eq!(inr.format(1234567800), "1,23,45,678.00");
        let nofrac = AmountFormat { format: NumberFormat::CommaDot, hide_fraction: true };
        assert_eq!(nofrac.format(123450), "1,235");
    }

    #[test]
    fn parses() {
        let f = AmountFormat::default();
        assert_eq!(f.parse("12.34"), Some(1234));
        assert_eq!(f.parse("1,234.5"), Some(123450));
        assert_eq!(f.parse("-7"), Some(-700));
        assert_eq!(f.parse("10+5.5"), Some(1550));
        assert_eq!(f.parse("(3*4)"), Some(1200));
        assert_eq!(f.parse("99999999999999999"), None);
        assert_eq!(f.parse("22517998136852.47"), Some(MAX_AMOUNT));
        assert_eq!(f.parse("22517998136852.48"), None);
        let ap = AmountFormat { format: NumberFormat::ApostropheDot, hide_fraction: false };
        assert_eq!(ap.format(100033), "1\u{2019}000.33");
        assert_eq!(ap.parse("1\u{2019}000.33"), Some(100033));
        assert_eq!(ap.parse("1'000.33"), Some(100033));
        let hidden = AmountFormat { hide_fraction: true, ..f };
        assert_eq!(hidden.format(40045), "400");
        assert_eq!(hidden.editable().format(40045), "400.45");
        assert_eq!(f.parse("$1,000"), Some(100000));
        assert_eq!(f.parse("abc"), None);
        assert_eq!(f.parse(""), None);
        let de = AmountFormat { format: NumberFormat::DotComma, hide_fraction: false };
        assert_eq!(de.parse("1.234,56"), Some(123456));
        assert_eq!(de.parse("12,5"), Some(1250));
    }
}
