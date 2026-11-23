//! Editing when a note or meeting happened: a small month to pick the day,
//! the start time and, for meetings, the end time. Opened from the date in the
//! note's header; every change is saved as it is made.

use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone, Utc,
};
use gpui::{
    AnyElement, App, ClickEvent, Div, FontWeight, InteractiveElement, IntoElement, ParentElement,
    Stateful, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};

use super::{format, style::Palette};
use crate::i18n::tr;

/// "14:30", "9", "930", "2:30 pm", "2.30pm", "14h30": None when it is not a
/// time of day.
pub fn parse_clock(text: &str) -> Option<NaiveTime> {
    let lower = text.trim().to_lowercase();
    let (body, pm) = if let Some(rest) = lower
        .strip_suffix("pm")
        .or_else(|| lower.strip_suffix("p.m."))
        .or_else(|| lower.strip_suffix('p'))
    {
        (rest.trim().to_string(), Some(true))
    } else if let Some(rest) = lower
        .strip_suffix("am")
        .or_else(|| lower.strip_suffix("a.m."))
        .or_else(|| lower.strip_suffix('a'))
    {
        (rest.trim().to_string(), Some(false))
    } else {
        (lower, None)
    };
    let digits: String = body.chars().filter(|c| c.is_ascii_digit()).collect();
    let separated = body.contains([':', '.', 'h', ' ']);
    let (mut hour, minute) = if separated {
        let mut parts = body.split([':', '.', 'h', ' ']).filter(|p| !p.is_empty());
        let h: u32 = parts.next()?.trim().parse().ok()?;
        let m: u32 = match parts.next() {
            Some(m) => m.trim().parse().ok()?,
            None => 0,
        };
        if parts.next().is_some() {
            return None;
        }
        (h, m)
    } else {
        match digits.len() {
            1 | 2 => (digits.parse().ok()?, 0),
            3 | 4 => {
                let (h, m) = digits.split_at(digits.len() - 2);
                (h.parse().ok()?, m.parse().ok()?)
            }
            _ => return None,
        }
    };
    if digits.len() != body.chars().filter(|c| !c.is_whitespace()).count() && !separated {
        return None;
    }
    match pm {
        Some(true) if (1..=12).contains(&hour) => hour = hour % 12 + 12,
        Some(false) if (1..=12).contains(&hour) => hour %= 12,
        Some(_) => return None,
        None => {}
    }
    NaiveTime::from_hms_opt(hour, minute, 0)
}

/// A local wall-clock time as UTC; the earlier one when the clocks go back.
pub fn to_utc(local: NaiveDateTime) -> Option<DateTime<Utc>> {
    Local
        .from_local_datetime(&local)
        .earliest()
        .map(|t| t.with_timezone(&Utc))
}

/// The weeks of a month, Monday first, with the days of the months around it
/// filling the first and last week.
pub fn month_weeks(month: NaiveDate) -> Vec<[NaiveDate; 7]> {
    let first = month.with_day(1).unwrap_or(month);
    let start = first - ChronoDuration::days(first.weekday().num_days_from_monday() as i64);
    let mut weeks = Vec::new();
    let mut day = start;
    loop {
        let mut week = [day; 7];
        for slot in week.iter_mut() {
            *slot = day;
            day += ChronoDuration::days(1);
        }
        weeks.push(week);
        if day.month() != first.month() || weeks.len() == 6 {
            break;
        }
    }
    weeks
}

pub fn shift_month(month: NaiveDate, by: i32) -> NaiveDate {
    let index = month.year() * 12 + month.month0() as i32 + by;
    NaiveDate::from_ymd_opt(index.div_euclid(12), index.rem_euclid(12) as u32 + 1, 1)
        .unwrap_or(month)
}

fn round_button(id: &'static str, palette: &Palette, icon: &'static str) -> Stateful<Div> {
    let palette = *palette;
    div()
        .id(id)
        .size(px(26.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .cursor_pointer()
        .hover(move |s| s.bg(palette.hover))
        .child(
            gpui::svg()
                .path(icon)
                .size(px(12.))
                .text_color(palette.muted),
        )
}

/// The month grid. `on_day` gets the picked day, `on_month` -1 or +1.
pub fn month_grid(
    palette: &Palette,
    month: NaiveDate,
    selected: NaiveDate,
    on_day: impl Fn(NaiveDate, &mut Window, &mut App) + Clone + 'static,
    on_month: impl Fn(i32, &mut Window, &mut App) + Clone + 'static,
) -> AnyElement {
    let palette = *palette;
    let today = Local::now().date_naive();
    let title = format!("{} {}", format::month_short(month.month()), month.year());
    let prev = on_month.clone();
    let next = on_month;
    let weekdays: Vec<String> = tr::documents::date::weekdays()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let cell = |child: AnyElement| {
        div()
            .w(px(34.))
            .h(px(30.))
            .flex()
            .items_center()
            .justify_center()
            .child(child)
    };
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .pb(px(4.))
                .child(
                    round_button("when-prev", &palette, "icons/chevron-left.svg")
                        .on_click(move |_: &ClickEvent, window, cx| prev(-1, window, cx)),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(title),
                )
                .child(
                    round_button("when-next", &palette, "icons/chevron-right.svg")
                        .on_click(move |_: &ClickEvent, window, cx| next(1, window, cx)),
                ),
        )
        .child(div().flex().children(weekdays.into_iter().map(|w| {
            cell(
                div()
                    .text_size(px(11.))
                    .text_color(palette.faint)
                    .child(w)
                    .into_any_element(),
            )
        })))
        .children(
            month_weeks(month)
                .into_iter()
                .enumerate()
                .map(|(row, week)| {
                    div()
                        .flex()
                        .children(week.into_iter().enumerate().map(|(col, day)| {
                            let pick = on_day.clone();
                            let picked = day == selected;
                            let outside = day.month() != month.month();
                            cell(
                                div()
                                    .id(("when-day", row * 7 + col))
                                    .size(px(28.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .text_size(px(12.5))
                                    .cursor_pointer()
                                    .text_color(if picked {
                                        palette.on_ink
                                    } else if outside {
                                        palette.faint
                                    } else {
                                        palette.text
                                    })
                                    .when(picked, |el| el.bg(palette.text))
                                    .when(!picked, |el| el.hover(move |s| s.bg(palette.hover)))
                                    .when(day == today && !picked, |el| {
                                        el.font_weight(FontWeight::SEMIBOLD)
                                    })
                                    .child(day.day().to_string())
                                    .on_click(move |_: &ClickEvent, window, cx| {
                                        pick(day, window, cx)
                                    })
                                    .into_any_element(),
                            )
                        }))
                }),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(h: u32, m: u32) -> Option<NaiveTime> {
        NaiveTime::from_hms_opt(h, m, 0)
    }

    #[test]
    fn times_parse_the_ways_people_type_them() {
        assert_eq!(parse_clock("14:30"), t(14, 30));
        assert_eq!(parse_clock("9"), t(9, 0));
        assert_eq!(parse_clock("0930"), t(9, 30));
        assert_eq!(parse_clock("930"), t(9, 30));
        assert_eq!(parse_clock("2:30 pm"), t(14, 30));
        assert_eq!(parse_clock("2.30PM"), t(14, 30));
        assert_eq!(parse_clock("12 am"), t(0, 0));
        assert_eq!(parse_clock("12pm"), t(12, 0));
        assert_eq!(parse_clock("14h30"), t(14, 30));
        assert_eq!(parse_clock("2:30\u{202f}PM"), t(14, 30));
        assert_eq!(parse_clock("25:00"), None);
        assert_eq!(parse_clock("13pm"), None);
        assert_eq!(parse_clock("soon"), None);
        assert_eq!(parse_clock(""), None);
    }

    #[test]
    fn a_month_is_whole_weeks_monday_first() {
        let nov = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        let weeks = month_weeks(nov);
        assert_eq!(weeks[0][0], NaiveDate::from_ymd_opt(2026, 10, 26).unwrap());
        assert!(
            weeks
                .iter()
                .flatten()
                .any(|d| *d == NaiveDate::from_ymd_opt(2026, 11, 30).unwrap())
        );
        assert!(weeks.len() >= 5 && weeks.len() <= 6);
        assert_eq!(
            shift_month(nov, 2),
            NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()
        );
        assert_eq!(
            shift_month(nov, -11),
            NaiveDate::from_ymd_opt(2025, 12, 1).unwrap()
        );
    }
}
