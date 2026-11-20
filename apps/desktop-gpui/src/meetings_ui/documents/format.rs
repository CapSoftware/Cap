use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, Timelike, Utc};

use crate::i18n::{self, Locale, tr};

pub fn local(at: DateTime<Utc>) -> NaiveDateTime {
    at.with_timezone(&Local).naive_local()
}

pub fn uses_12_hour(locale: Locale) -> bool {
    matches!(locale, Locale::En | Locale::Hi)
}

pub fn clock(at: NaiveDateTime) -> String {
    clock_for(at, i18n::current())
}

pub fn clock_for(at: NaiveDateTime, locale: Locale) -> String {
    let (hour, minute) = (at.hour(), at.minute());
    if uses_12_hour(locale) {
        let suffix = if hour < 12 { "AM" } else { "PM" };
        let twelve = match hour % 12 {
            0 => 12,
            h => h,
        };
        format!("{twelve}:{minute:02}\u{202f}{suffix}")
    } else {
        format!("{hour:02}:{minute:02}")
    }
}

fn nth_word(list: &str, index: usize) -> String {
    list.split_whitespace()
        .nth(index)
        .map(str::to_string)
        .unwrap_or_default()
}

pub fn month_short(month: u32) -> String {
    nth_word(
        tr::documents::date::months(),
        month.saturating_sub(1) as usize,
    )
}

pub fn weekday_short(date: NaiveDate) -> String {
    nth_word(
        tr::documents::date::weekdays(),
        date.weekday().num_days_from_monday() as usize,
    )
}

pub fn day_label(date: NaiveDate, today: NaiveDate) -> String {
    if date == today {
        return tr::documents::date::today().to_string();
    }
    if today.pred_opt() == Some(date) {
        return tr::documents::date::yesterday().to_string();
    }
    if date.year() == today.year() {
        tr::documents::date::day(weekday_short(date), date.day(), month_short(date.month()))
    } else {
        tr::documents::date::day_year(date.day(), month_short(date.month()), date.year())
    }
}

pub fn short_date(date: NaiveDate, today: NaiveDate) -> String {
    if date == today {
        return tr::documents::date::today().to_string();
    }
    if today.pred_opt() == Some(date) {
        return tr::documents::date::yesterday().to_string();
    }
    if today.succ_opt() == Some(date) {
        return tr::documents::date::tomorrow().to_string();
    }
    if date.year() == today.year() {
        tr::documents::date::short(date.day(), month_short(date.month()))
    } else {
        tr::documents::date::day_year(date.day(), month_short(date.month()), date.year())
    }
}

pub fn duration(ms: u64) -> String {
    let minutes = (ms + 30_000) / 60_000;
    if ms < 60_000 {
        return tr::documents::duration::under_minute().to_string();
    }
    if minutes < 60 {
        return tr::documents::duration::minutes(minutes);
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 {
        tr::documents::duration::hours(hours)
    } else {
        tr::documents::duration::hours_minutes(hours, rest)
    }
}

pub fn elapsed(ms: u64) -> String {
    let total = ms / 1000;
    let (h, m, s) = (total / 3600, (total / 60) % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

pub fn countdown(secs: u64) -> String {
    format!("{}:{:02}", secs / 60, secs % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 12)
            .unwrap()
            .and_hms_opt(h, m, 0)
            .unwrap()
    }

    #[test]
    fn clock_follows_the_locale_hour_cycle() {
        assert_eq!(clock_for(at(0, 5), Locale::En), "12:05\u{202f}AM");
        assert_eq!(clock_for(at(14, 30), Locale::En), "2:30\u{202f}PM");
        assert_eq!(clock_for(at(14, 30), Locale::De), "14:30");
        assert_eq!(clock_for(at(9, 3), Locale::Ja), "09:03");
    }

    #[test]
    fn elapsed_and_countdown_read_like_clocks() {
        assert_eq!(elapsed(0), "0:00");
        assert_eq!(elapsed(65_000), "1:05");
        assert_eq!(elapsed(3_725_000), "1:02:05");
        assert_eq!(countdown(12), "0:12");
        assert_eq!(countdown(75), "1:15");
    }

    #[test]
    fn day_labels_name_today_and_yesterday() {
        let today = NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
        assert_eq!(day_label(today, today), "Today");
        assert_eq!(day_label(today.pred_opt().unwrap(), today), "Yesterday");
        assert_eq!(
            day_label(NaiveDate::from_ymd_opt(2026, 11, 9).unwrap(), today),
            "Mon, 9 Nov"
        );
        assert_eq!(
            day_label(NaiveDate::from_ymd_opt(2025, 3, 2).unwrap(), today),
            "2 Mar 2025"
        );
    }

    #[test]
    fn durations_round_to_minutes() {
        assert_eq!(duration(20_000), "Under a minute");
        assert_eq!(duration(5 * 60_000), "5 min");
        assert_eq!(duration(60 * 60_000), "1 hr");
        assert_eq!(duration(95 * 60_000), "1 hr 35 min");
    }
}
