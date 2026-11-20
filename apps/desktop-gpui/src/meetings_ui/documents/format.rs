use cap_meetings::templates::Template;
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

/// The title a new meeting gets until it is named: the call app it came
/// from, or "Meeting", at its local start time, in the app's language and
/// with the same clock as the rest of the page.
pub fn meeting_title(app_name: Option<&str>, at: NaiveDateTime) -> String {
    let time = clock(at);
    let app = app_name
        .map(|name| name.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(120).collect::<String>());
    match app {
        Some(app) => tr::documents::app_at(app, time),
        None => tr::documents::meeting_at(time),
    }
}

/// A template's name as the app shows it: Cap's own templates in the app's
/// language, the person's templates as they named them. The name sent with
/// a notes request stays the template's own.
pub fn template_name(template: &Template) -> String {
    built_in_template_name(template)
        .map(str::to_string)
        .unwrap_or_else(|| template.name.clone())
}

fn built_in_template_name(template: &Template) -> Option<&'static str> {
    if !template.built_in {
        return None;
    }
    Some(match template.id.as_str() {
        "general" => tr::documents::templates::general(),
        "one-on-one" => tr::documents::templates::one_on_one(),
        "stand-up" => tr::documents::templates::stand_up(),
        "customer-call" => tr::documents::templates::customer_call(),
        "sales-discovery" => tr::documents::templates::sales_discovery(),
        "interview" => tr::documents::templates::interview(),
        "project-kickoff" => tr::documents::templates::project_kickoff(),
        "retrospective" => tr::documents::templates::retrospective(),
        "brainstorm" => tr::documents::templates::brainstorm(),
        "board-update" => tr::documents::templates::board_update(),
        _ => return None,
    })
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
    fn built_in_templates_show_in_the_app_language_and_yours_as_named() {
        let built_in = cap_meetings::templates::built_in_templates();
        assert_eq!(built_in.len(), 10);
        for template in &built_in {
            // Every built-in id has its own string (en matches the crate's name).
            assert!(
                built_in_template_name(template).is_some(),
                "{}",
                template.id
            );
            assert_eq!(template_name(template), template.name, "{}", template.id);
        }
        let mine = Template {
            id: "weekly".into(),
            name: "Weekly sync".into(),
            built_in: false,
            ..Template::default()
        };
        assert_eq!(template_name(&mine), "Weekly sync");
        let unknown = Template {
            id: "from-a-newer-cap".into(),
            name: "Planning".into(),
            built_in: true,
            ..Template::default()
        };
        assert_eq!(template_name(&unknown), "Planning");
    }

    #[test]
    fn a_new_meetings_title_reads_the_time_like_the_page_does() {
        const CHILD: &str = "CAP_GPUI_TEST_MEETING_TITLE";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "meetings_ui::documents::format::tests::a_new_meetings_title_reads_the_time_like_the_page_does",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env_remove(i18n::LOCALE_ENV)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        for (locale, plain, app) in [
            (
                Locale::En,
                "Meeting at 5:46\u{202f}PM",
                "Google Meet at 9:05\u{202f}AM",
            ),
            (Locale::De, "Meeting um 17:46", "Google Meet um 09:05"),
            (Locale::Es, "Reunión a las 17:46", "Google Meet a las 09:05"),
            (Locale::Fr, "Réunion à 17:46", "Google Meet à 09:05"),
            (
                Locale::Hi,
                "5:46\u{202f}PM की मीटिंग",
                "9:05\u{202f}AM की Google Meet कॉल",
            ),
            (Locale::Ja, "17:46の会議", "09:05のGoogle Meet"),
            (Locale::ZhCn, "17:46 的会议", "09:05 的 Google Meet"),
        ] {
            i18n::init(Some(locale.code()));
            assert_eq!(meeting_title(None, at(17, 46)), plain, "{locale:?}");
            assert_eq!(meeting_title(Some("  "), at(17, 46)), plain, "{locale:?}");
            assert_eq!(
                meeting_title(Some(" Google \n Meet "), at(9, 5)),
                app,
                "{locale:?}"
            );
        }
        let general = cap_meetings::templates::built_in_templates().remove(0);
        i18n::init(Some(Locale::De.code()));
        assert_eq!(template_name(&general), "Allgemeines Meeting");
        assert_eq!(
            general.name, "General meeting",
            "the request keeps the template's own name"
        );
        i18n::init(Some(Locale::En.code()));
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
