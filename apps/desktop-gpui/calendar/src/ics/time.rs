use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

use super::lexer::Property;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum IcsTime {
    Date(NaiveDate),
    Floating(NaiveDateTime),
    Utc(NaiveDateTime),
    Zoned(NaiveDateTime, String),
}

const MIN_YEAR: i32 = 1000;
const MAX_YEAR: i32 = 3000;

pub(crate) fn parse_date(value: &str) -> Option<NaiveDate> {
    let digits: String = value.chars().filter(|c| *c != '-').collect();
    if digits.len() != 8 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year: i32 = digits[..4].parse().ok()?;
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, digits[4..6].parse().ok()?, digits[6..8].parse().ok()?)
}

pub(crate) fn parse_date_time(value: &str) -> Option<(NaiveDateTime, bool)> {
    let value = value.trim();
    let (body, utc) = match value.strip_suffix(['Z', 'z']) {
        Some(body) => (body, true),
        None => (value, false),
    };
    let (date_part, time_part) = body.split_once(['T', 't'])?;
    let date = parse_date(date_part)?;
    let time_digits: String = time_part.chars().filter(|c| *c != ':').collect();
    let time_digits = time_digits.split('.').next().unwrap_or("");
    if !time_digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (h, m, s) = match time_digits.len() {
        4 => (
            time_digits[..2].parse().ok()?,
            time_digits[2..].parse().ok()?,
            0,
        ),
        6 => (
            time_digits[..2].parse().ok()?,
            time_digits[2..4].parse().ok()?,
            time_digits[4..].parse::<u32>().ok()?.min(59),
        ),
        _ => return None,
    };
    let time = NaiveTime::from_hms_opt(h, m, s)?;
    Some((date.and_time(time), utc))
}

pub(crate) fn parse_one(value: &str, tzid: Option<&str>, is_date: bool) -> Option<IcsTime> {
    let value = value.trim();
    let looks_like_date = !value.contains(['T', 't']);
    if is_date || looks_like_date {
        if let Some(date) = parse_date(value) {
            return Some(IcsTime::Date(date));
        }
        if looks_like_date {
            return None;
        }
    }
    let (naive, utc) = parse_date_time(value)?;
    if utc {
        return Some(IcsTime::Utc(naive));
    }
    match tzid.map(str::trim).filter(|t| !t.is_empty()) {
        Some(tzid) => Some(IcsTime::Zoned(naive, tzid.to_string())),
        None => Some(IcsTime::Floating(naive)),
    }
}

pub(crate) fn parse_property(prop: &Property) -> Vec<IcsTime> {
    let is_date = prop
        .param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
    let is_period = prop
        .param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("PERIOD"));
    let tzid = prop.param("TZID");
    prop.value
        .split(',')
        .filter(|v| !v.trim().is_empty())
        .filter_map(|v| {
            let v = if is_period || v.contains('/') {
                v.split('/').next().unwrap_or(v)
            } else {
                v
            };
            parse_one(v, tzid, is_date)
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn parse_duration(value: &str) -> Option<chrono::Duration> {
    let (days, seconds) = parse_duration_parts(value)?;
    Some(chrono::Duration::seconds(
        days.checked_mul(86_400)?.checked_add(seconds)?,
    ))
}

pub(crate) fn parse_duration_parts(value: &str) -> Option<(i64, i64)> {
    let value = value.trim();
    let (negative, rest) = match value.as_bytes().first()? {
        b'-' => (true, &value[1..]),
        b'+' => (false, &value[1..]),
        _ => (false, value),
    };
    let rest = rest.strip_prefix(['P', 'p'])?;
    let mut days: i64 = 0;
    let mut seconds: i64 = 0;
    let mut number = String::new();
    let mut in_time = false;
    let mut any = false;
    for c in rest.chars() {
        match c.to_ascii_uppercase() {
            d if d.is_ascii_digit() => number.push(d),
            'T' => in_time = true,
            unit => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                match (unit, in_time) {
                    ('W', false) => days = days.checked_add(n.checked_mul(7)?)?,
                    ('D', false) => days = days.checked_add(n)?,
                    ('H', true) => seconds = seconds.checked_add(n.checked_mul(3_600)?)?,
                    ('M', true) => seconds = seconds.checked_add(n.checked_mul(60)?)?,
                    ('S', true) => seconds = seconds.checked_add(n)?,
                    _ => return None,
                }
                any = true;
            }
        }
    }
    let total = days.checked_mul(86_400)?.checked_add(seconds)?;
    if !any || !number.is_empty() || total > 366 * 86_400 * 10 {
        return None;
    }
    Some(if negative {
        (-days, -seconds)
    } else {
        (days, seconds)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn parses_all_value_forms() {
        let d = NaiveDate::from_ymd_opt(2026, 3, 9).unwrap();
        assert_eq!(parse_one("20260309", None, true), Some(IcsTime::Date(d)));
        assert_eq!(parse_one("20260309", None, false), Some(IcsTime::Date(d)));
        let dt = d.and_hms_opt(9, 30, 0).unwrap();
        assert_eq!(
            parse_one("20260309T093000Z", None, false),
            Some(IcsTime::Utc(dt))
        );
        assert_eq!(
            parse_one("20260309T093000", Some("Europe/Paris"), false),
            Some(IcsTime::Zoned(dt, "Europe/Paris".into()))
        );
        assert_eq!(
            parse_one("20260309T0930", None, false),
            Some(IcsTime::Floating(dt))
        );
        assert_eq!(
            parse_one("2026-03-09T09:30:00Z", None, false),
            Some(IcsTime::Utc(dt))
        );
        assert_eq!(parse_one("20261309T093000Z", None, false), None);
        assert_eq!(parse_one("99999999T000000Z", None, false), None);
        assert_eq!(parse_one("garbage", None, false), None);
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("P1D"), Some(Duration::days(1)));
        assert_eq!(parse_duration("P2W"), Some(Duration::weeks(2)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
        assert_eq!(parse_duration("P1DT2H"), Some(Duration::hours(26)));
        assert_eq!(parse_duration_parts("P1DT2H"), Some((1, 7_200)));
        assert_eq!(parse_duration_parts("P1W"), Some((7, 0)));
        assert_eq!(parse_duration_parts("PT24H"), Some((0, 86_400)));
        assert_eq!(parse_duration_parts("-P1D"), Some((-1, 0)));
        assert_eq!(parse_duration("PT"), None);
        assert_eq!(parse_duration("P1H"), None);
        assert_eq!(parse_duration("P99999999999999999999D"), None);
        assert_eq!(parse_duration(""), None);
    }
}
