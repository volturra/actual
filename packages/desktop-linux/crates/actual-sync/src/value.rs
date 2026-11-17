//! Sync message values travel as tagged strings: `0:` for null, `N:` for
//! numbers, `S:` for strings (see loot-core `sync/serialization.ts`). Newer
//! app versions may add prefixes; those are carried opaquely as `Unknown`.

use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Number(f64),
    String(String),
    /// Raw value with a type tag this version doesn't understand.
    Unknown(String),
}

impl Value {
    pub fn serialize(&self) -> String {
        match self {
            Value::Null => "0:".to_string(),
            Value::Number(n) => format!("N:{}", js_number_to_string(*n)),
            Value::String(s) => format!("S:{s}"),
            Value::Unknown(raw) => raw.clone(),
        }
    }

    /// Strict decode (`deserializeValue`).
    pub fn deserialize(raw: &str) -> Option<Value> {
        let bytes = raw.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' {
            match bytes[0] {
                b'0' => return Some(Value::Null),
                b'N' => return Some(Value::Number(js_parse_float(&raw[2..]))),
                b'S' => return Some(Value::String(raw[2..].to_string())),
                _ => {}
            }
        }
        None
    }

    /// Lenient decode for inbound messages (`deserializeValueSafe`).
    pub fn deserialize_safe(raw: &str) -> Value {
        Value::deserialize(raw).unwrap_or_else(|| Value::Unknown(raw.to_string()))
    }

    pub fn is_unknown(&self) -> bool {
        matches!(self, Value::Unknown(_))
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::String(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::String(s)
    }
}
impl From<i64> for Value {
    fn from(n: i64) -> Self {
        Value::Number(n as f64)
    }
}
impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Number(n)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Number(if b { 1.0 } else { 0.0 })
    }
}
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Self {
        v.map(Into::into).unwrap_or(Value::Null)
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.serialize())
    }
}

impl rusqlite::ToSql for Value {
    /// Binds like better-sqlite3 binds JS values: integral numbers as
    /// INTEGER, others as REAL, strings as TEXT.
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        use rusqlite::types::{ToSqlOutput, Value as V};
        Ok(match self {
            Value::Null => ToSqlOutput::Owned(V::Null),
            Value::Number(n) if n.is_nan() => ToSqlOutput::Owned(V::Null),
            Value::Number(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => {
                ToSqlOutput::Owned(V::Integer(*n as i64))
            }
            Value::Number(n) => ToSqlOutput::Owned(V::Real(*n)),
            Value::String(s) => ToSqlOutput::Borrowed(rusqlite::types::ValueRef::Text(s.as_bytes())),
            Value::Unknown(raw) => ToSqlOutput::Borrowed(rusqlite::types::ValueRef::Text(raw.as_bytes())),
        })
    }
}

/// JavaScript's `Number.prototype.toString()` for the values that occur in
/// budgets (integers, sort orders, the odd fraction).
pub fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == 0.0 {
        return "0".into();
    }
    let abs = n.abs();
    if (1e-6..1e21).contains(&abs) {
        if n.fract() == 0.0 {
            return format!("{}", n as i128);
        }
        return format!("{n}");
    }
    // Exponent form: JS writes `1e+21` / `1.5e-7`.
    let s = format!("{n:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

/// JavaScript's `parseFloat`: the longest numeric prefix, else NaN.
pub fn js_parse_float(s: &str) -> f64 {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    let mut end = 0;
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    if s[i..].starts_with("Infinity") {
        return if bytes.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let mut seen_digit = false;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        seen_digit = true;
        end = i;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            seen_digit = true;
            end = i;
        }
    }
    if seen_digit && i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > start {
            end = j;
        }
    }
    if !seen_digit {
        return f64::NAN;
    }
    s[..end].parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for v in [
            Value::Null,
            Value::Number(1200.0),
            Value::Number(-0.5),
            Value::Number(16384.25),
            Value::String("hello:world".into()),
            Value::String(String::new()),
        ] {
            assert_eq!(Value::deserialize(&v.serialize()), Some(v));
        }
    }

    #[test]
    fn js_formatting() {
        assert_eq!(Value::Number(1200.0).serialize(), "N:1200");
        assert_eq!(Value::Number(-1.5).serialize(), "N:-1.5");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
    }

    #[test]
    fn unknown_prefixes() {
        assert_eq!(Value::deserialize("N16:12"), None);
        assert_eq!(Value::deserialize_safe("X:12"), Value::Unknown("X:12".into()));
        assert_eq!(Value::deserialize(""), None);
    }

    #[test]
    fn parse_float_prefix() {
        assert_eq!(js_parse_float("12abc"), 12.0);
        assert_eq!(js_parse_float("-3.5e2x"), -350.0);
        assert!(js_parse_float("abc").is_nan());
        assert_eq!(js_parse_float(".5"), 0.5);
    }
}
