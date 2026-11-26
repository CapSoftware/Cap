use chrono::{
    Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Weekday,
};
use rrule::{Frequency, RRule, RRuleSet, RRuleSetIter, Unvalidated};

use super::budget::Budget;
use super::time::{IcsTime, parse_one};
use crate::tz::Zone;

const RRULE_LOOP_LIMIT: u64 = 100_000;
const RRULE_MAX_YEAR: i32 = 10_000;
const MAX_TIMES_PER_DAY: usize = 96;
const YIELD_COST: u64 = 8;

const KNOWN_PARTS: [&str; 13] = [
    "FREQ",
    "INTERVAL",
    "COUNT",
    "BYSECOND",
    "BYMINUTE",
    "BYHOUR",
    "BYDAY",
    "BYMONTHDAY",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYMONTH",
    "BYSETPOS",
    "WKST",
];

fn as_wall(dt: NaiveDateTime) -> chrono::DateTime<rrule::Tz> {
    rrule::Tz::UTC.from_utc_datetime(&dt)
}

#[derive(Clone, Debug)]
pub(crate) struct Recurrence {
    rule: RRule,
    until: Option<NaiveDateTime>,
    count: Option<u32>,
    freq: Frequency,
    interval: i64,
    week_start: Weekday,
    period_cost: u64,
}

impl Recurrence {
    fn period_index(&self, wall: NaiveDateTime) -> i64 {
        match self.freq {
            Frequency::Yearly => i64::from(wall.year()),
            Frequency::Monthly => i64::from(wall.year()) * 12 + i64::from(wall.month0()),
            Frequency::Weekly => week_start_of(wall.date(), self.week_start)
                .num_days_from_ce()
                .div_euclid(7)
                .into(),
            Frequency::Daily => wall.date().num_days_from_ce().into(),
            _ => i64::from(wall.date().num_days_from_ce()) * 24 + i64::from(wall.time().hour()),
        }
    }

    fn period_start(&self, index: i64) -> Option<NaiveDateTime> {
        let midnight = |date: NaiveDate| date.and_time(NaiveTime::MIN);
        match self.freq {
            Frequency::Yearly => {
                NaiveDate::from_ymd_opt(i32::try_from(index).ok()?, 1, 1).map(midnight)
            }
            Frequency::Monthly => {
                let year = i32::try_from(index.div_euclid(12)).ok()?;
                let month = u32::try_from(index.rem_euclid(12) + 1).ok()?;
                NaiveDate::from_ymd_opt(year, month, 1).map(midnight)
            }
            Frequency::Weekly => {
                let last_day = index.checked_mul(7)?.checked_add(6)?;
                NaiveDate::from_num_days_from_ce_opt(i32::try_from(last_day).ok()?)
                    .map(|d| midnight(week_start_of(d, self.week_start)))
            }
            Frequency::Daily => {
                NaiveDate::from_num_days_from_ce_opt(i32::try_from(index).ok()?).map(midnight)
            }
            _ => {
                let day = i32::try_from(index.div_euclid(24)).ok()?;
                let hour = u32::try_from(index.rem_euclid(24)).ok()?;
                NaiveDate::from_num_days_from_ce_opt(day)?.and_hms_opt(hour, 0, 0)
            }
        }
    }

    fn periods_between(&self, from: NaiveDateTime, to: NaiveDateTime) -> u64 {
        let steps = (self.period_index(to) - self.period_index(from)).max(0) / self.interval;
        u64::try_from(steps).unwrap_or(0).max(1)
    }

    fn worst_call(&self, position: NaiveDateTime) -> u64 {
        let loops = match self.freq {
            Frequency::Yearly => {
                let years = i64::from(RRULE_MAX_YEAR - position.year()).max(0) / self.interval;
                u64::try_from(years + 1).unwrap_or(1).min(RRULE_LOOP_LIMIT)
            }
            _ => RRULE_LOOP_LIMIT,
        };
        loops.saturating_mul(self.period_cost)
    }

    fn fast_forward(&self, dtstart_wall: NaiveDateTime, anchor: NaiveDateTime) -> NaiveDateTime {
        if self.count.is_some() || anchor <= dtstart_wall {
            return dtstart_wall;
        }
        let first = self.period_index(dtstart_wall);
        let skip = (self.period_index(anchor) - first).div_euclid(self.interval);
        if skip < 1 {
            return dtstart_wall;
        }
        skip.checked_mul(self.interval)
            .and_then(|offset| first.checked_add(offset))
            .and_then(|index| self.period_start(index))
            .filter(|start| *start > dtstart_wall && *start <= anchor)
            .unwrap_or(dtstart_wall)
    }

    pub fn walls<'a>(
        &'a self,
        dtstart_wall: NaiveDateTime,
        anchor: NaiveDateTime,
        budget: &'a mut Budget,
    ) -> Walls<'a> {
        let start = self.fast_forward(dtstart_wall, anchor);
        let set = RRuleSet::new(as_wall(start))
            .rrule(self.rule.clone())
            .limit();
        Walls {
            iter: (&set).into_iter(),
            rec: self,
            budget,
            position: start,
            yielded: 0,
            done: false,
        }
    }
}

fn week_start_of(date: NaiveDate, week_start: Weekday) -> NaiveDate {
    let back = (7 + date.weekday().num_days_from_monday() - week_start.num_days_from_monday()) % 7;
    date.checked_sub_signed(Duration::days(i64::from(back)))
        .unwrap_or(date)
}

pub(crate) struct Walls<'a> {
    iter: RRuleSetIter,
    rec: &'a Recurrence,
    budget: &'a mut Budget,
    position: NaiveDateTime,
    yielded: u32,
    done: bool,
}

impl Iterator for Walls<'_> {
    type Item = NaiveDateTime;

    fn next(&mut self) -> Option<NaiveDateTime> {
        if self.done {
            return None;
        }
        // rrule scans up to 100,000 empty periods inside one call, so a call is only made when
        // the budget could pay for that scan; the real cost is charged once the result is known.
        if !self.budget.can_afford(self.rec.worst_call(self.position)) {
            self.budget.charge(u64::MAX);
            self.done = true;
            return None;
        }
        let Some(next) = self.iter.next().map(|dt| dt.naive_utc()) else {
            let finished_by_count = self.rec.count.is_some_and(|c| self.yielded >= c);
            self.budget.charge(if finished_by_count {
                1
            } else {
                self.rec.worst_call(self.position)
            });
            self.done = true;
            return None;
        };
        let periods = self.rec.periods_between(self.position, next);
        self.budget.charge(
            periods
                .saturating_mul(self.rec.period_cost)
                .saturating_add(YIELD_COST),
        );
        self.position = next;
        self.yielded = self.yielded.saturating_add(1);
        if self.rec.until.is_some_and(|until| next > until) {
            self.done = true;
            return None;
        }
        Some(next)
    }
}

fn times_per_day(rule: &RRule) -> usize {
    let minutes_seconds = rule.get_by_minute().len().max(1) * rule.get_by_second().len().max(1);
    match rule.get_freq() {
        Frequency::Hourly => {
            let interval = usize::from(rule.get_interval().max(1));
            let hours = if rule.get_by_hour().is_empty() {
                24usize.div_ceil(interval)
            } else {
                rule.get_by_hour().len().min(24usize.div_ceil(interval))
            };
            hours * minutes_seconds
        }
        _ => rule.get_by_hour().len().max(1) * minutes_seconds,
    }
}

fn period_cost(freq: Frequency, times_per_day: usize) -> u64 {
    let (base, days) = match freq {
        Frequency::Yearly => (16, 366),
        Frequency::Monthly => (2, 31),
        Frequency::Weekly => (1, 7),
        Frequency::Hourly => (2, 1),
        _ => (1, 1),
    };
    base + days * times_per_day as u64 / 32
}

pub(crate) fn build_rule(
    value: &str,
    dtstart_wall: NaiveDateTime,
    zone: Zone,
) -> Result<Recurrence, String> {
    // rrule 0.14 slices BYDAY values by byte offset and panics on non-ASCII input.
    if !value.is_ascii() {
        return Err("RRULE contains non-ASCII characters".to_string());
    }
    let mut parts: Vec<String> = Vec::new();
    let mut until = None;
    let mut has_freq = false;
    for part in value.split(';') {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_uppercase();
        let val = val.trim().to_ascii_uppercase();
        if val.is_empty() {
            continue;
        }
        if key == "UNTIL" {
            until = Some(val);
            continue;
        }
        if !KNOWN_PARTS.contains(&key.as_str())
            || parts
                .iter()
                .any(|p| p.split('=').next() == Some(key.as_str()))
        {
            continue;
        }
        if key == "FREQ" {
            if val == "MINUTELY" || val == "SECONDLY" {
                return Err(format!("FREQ={val} is not a meeting cadence"));
            }
            has_freq = true;
        }
        if key == "INTERVAL" && val.parse::<u32>().is_ok_and(|n| n == 0) {
            continue;
        }
        if key == "COUNT" && val.parse::<u32>().is_ok_and(|n| n == 0) {
            return Err("COUNT=0".to_string());
        }
        parts.push(format!("{key}={val}"));
    }
    if !has_freq {
        return Err(format!("RRULE without FREQ: {value}"));
    }
    let rule: RRule<Unvalidated> = parts
        .join(";")
        .parse()
        .map_err(|e: rrule::RRuleError| e.to_string())?;
    let until = match until {
        Some(until) => {
            let wall = match parse_one(&until, None, false) {
                Some(IcsTime::Date(date)) => {
                    date.and_time(NaiveTime::from_hms_opt(23, 59, 59).unwrap_or_default())
                }
                Some(IcsTime::Utc(naive)) => zone.from_utc(naive.and_utc()),
                Some(IcsTime::Floating(naive) | IcsTime::Zoned(naive, _)) => naive,
                None => return Err(format!("bad UNTIL: {until}")),
            };
            if wall < dtstart_wall {
                return Err("UNTIL before DTSTART".to_string());
            }
            Some(wall)
        }
        None => None,
    };
    let rule = rule
        .validate(as_wall(dtstart_wall))
        .map_err(|e| e.to_string())?;
    let times = times_per_day(&rule);
    if times > MAX_TIMES_PER_DAY {
        return Err(format!(
            "{times} occurrences a day is not a meeting cadence"
        ));
    }
    let freq = rule.get_freq();
    Ok(Recurrence {
        count: rule.get_count(),
        interval: i64::from(rule.get_interval().max(1)),
        week_start: rule.get_week_start(),
        period_cost: period_cost(freq, times),
        freq,
        until,
        rule,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ics::budget::FEED_BUDGET;

    fn wall(y: i32, m: u32, d: u32, h: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .and_then(|d| d.and_hms_opt(h, 0, 0))
            .unwrap()
    }

    fn all(rule: &Recurrence, start: NaiveDateTime) -> Vec<NaiveDateTime> {
        let mut budget = Budget::new(FEED_BUDGET);
        rule.walls(start, start, &mut budget).collect()
    }

    #[test]
    fn rebuilds_messy_rules() {
        let start = wall(2026, 1, 5, 9);
        let rule = build_rule(
            "freq=weekly;;byday=MO,WE;X-NAME=foo;INTERVAL=0;WKST=SU;",
            start,
            Zone::Utc,
        )
        .unwrap();
        let mut budget = Budget::new(FEED_BUDGET);
        let got: Vec<_> = rule.walls(start, start, &mut budget).take(3).collect();
        assert_eq!(got, vec![start, wall(2026, 1, 7, 9), wall(2026, 1, 12, 9)]);
    }

    #[test]
    fn until_in_utc_is_converted_to_wall_clock() {
        let start = wall(2026, 3, 2, 9);
        let ny = Zone::Named(chrono_tz::Tz::America__New_York);
        let rule = build_rule("FREQ=DAILY;UNTIL=20260304T140000Z", start, ny).unwrap();
        assert_eq!(all(&rule, start).len(), 3);
    }

    #[test]
    fn rejects_bad_rules() {
        let start = wall(2026, 1, 5, 9);
        assert!(build_rule("BYDAY=MO", start, Zone::Utc).is_err());
        assert!(build_rule("FREQ=SOMETIMES", start, Zone::Utc).is_err());
        assert!(build_rule("FREQ=DAILY;UNTIL=20200101T000000Z", start, Zone::Utc).is_err());
        assert!(build_rule("FREQ=DAILY;COUNT=0", start, Zone::Utc).is_err());
        assert!(build_rule("FREQ=MONTHLY;BYMONTHDAY=40", start, Zone::Utc).is_err());
        assert!(build_rule("FREQ=DAILY;UNTIL=nope", start, Zone::Utc).is_err());
    }

    #[test]
    fn sub_hourly_cadences_are_not_rules() {
        let start = wall(2026, 1, 5, 9);
        assert!(build_rule("FREQ=SECONDLY", start, Zone::Utc).is_err());
        assert!(build_rule("FREQ=MINUTELY;INTERVAL=30", start, Zone::Utc).is_err());
        assert!(build_rule("FREQ=HOURLY;BYMINUTE=0,5,10,15,20", start, Zone::Utc).is_err());
        assert!(
            build_rule(
                "FREQ=DAILY;BYHOUR=0,1,2,3,4,5,6,7,8,9,10,11;BYMINUTE=0,5,10,15,20,25,30,35,40",
                start,
                Zone::Utc
            )
            .is_err()
        );
        assert!(build_rule("FREQ=HOURLY;INTERVAL=2;BYMINUTE=0,30", start, Zone::Utc).is_ok());
        assert!(
            build_rule(
                "FREQ=DAILY;BYHOUR=9,10,11,12;BYMINUTE=0,15,30,45",
                start,
                Zone::Utc
            )
            .is_ok()
        );
    }

    fn naive_window(
        rule: &Recurrence,
        start: NaiveDateTime,
        from: NaiveDateTime,
        to: NaiveDateTime,
    ) -> Vec<NaiveDateTime> {
        let mut budget = Budget::new(u64::MAX / 2);
        rule.walls(start, start, &mut budget)
            .skip_while(|w| *w < from)
            .take_while(|w| *w <= to)
            .collect()
    }

    fn fast_window(
        rule: &Recurrence,
        start: NaiveDateTime,
        from: NaiveDateTime,
        to: NaiveDateTime,
    ) -> (Vec<NaiveDateTime>, u64) {
        let mut budget = Budget::new(FEED_BUDGET);
        let got = rule
            .walls(start, from, &mut budget)
            .skip_while(|w| *w < from)
            .take_while(|w| *w <= to)
            .collect();
        (got, FEED_BUDGET - budget.left())
    }

    #[test]
    fn fast_forward_matches_naive_stepping() {
        let rules = [
            "FREQ=YEARLY",
            "FREQ=YEARLY;INTERVAL=3",
            "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
            "FREQ=YEARLY;BYMONTH=3,11;BYDAY=2SU",
            "FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;BYHOUR=1,3",
            "FREQ=YEARLY;BYWEEKNO=1,20,53;BYDAY=MO",
            "FREQ=YEARLY;BYYEARDAY=1,100,-1",
            "FREQ=YEARLY;INTERVAL=2;BYMONTH=1,7;BYDAY=FR;BYSETPOS=-1",
            "FREQ=MONTHLY",
            "FREQ=MONTHLY;INTERVAL=5",
            "FREQ=MONTHLY;BYMONTHDAY=31",
            "FREQ=MONTHLY;BYMONTHDAY=-1,15",
            "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
            "FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1",
            "FREQ=MONTHLY;BYDAY=-2TH;BYMONTH=1,4,7,10",
            "FREQ=WEEKLY",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
            "FREQ=WEEKLY;INTERVAL=3;BYDAY=SU,SA;WKST=SU",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;WKST=WE",
            "FREQ=WEEKLY;INTERVAL=4;BYDAY=MO,FR;BYHOUR=9,15;BYMINUTE=0,30",
            "FREQ=WEEKLY;BYMONTH=6,12;BYDAY=WE",
            "FREQ=DAILY",
            "FREQ=DAILY;INTERVAL=3",
            "FREQ=DAILY;INTERVAL=10;BYDAY=MO,WE,FR",
            "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=28,29",
            "FREQ=DAILY;BYHOUR=8,12,17;BYMINUTE=15",
            "FREQ=DAILY;INTERVAL=2;BYDAY=TU,TH;BYSETPOS=1",
            "FREQ=HOURLY",
            "FREQ=HOURLY;INTERVAL=5",
            "FREQ=HOURLY;INTERVAL=7;BYHOUR=9,10,11,12,13,14,15,16,17",
            "FREQ=HOURLY;INTERVAL=3;BYDAY=MO,TU,WE,TH,FR;BYMINUTE=0,30",
            "FREQ=HOURLY;INTERVAL=25",
        ];
        let starts = [
            wall(2019, 1, 1, 0),
            NaiveDate::from_ymd_opt(2020, 2, 29)
                .and_then(|d| d.and_hms_opt(23, 45, 10))
                .unwrap(),
            wall(2021, 7, 18, 13),
            wall(2022, 12, 31, 9),
        ];
        let anchors = [
            wall(2026, 1, 1, 0),
            NaiveDate::from_ymd_opt(2026, 3, 29)
                .and_then(|d| d.and_hms_opt(5, 17, 0))
                .unwrap(),
            wall(2026, 11, 2, 23),
        ];
        let mut cases = 0;
        let mut empty = 0;
        for text in rules {
            for start in starts {
                let rule = build_rule(text, start, Zone::Utc).unwrap();
                let span = match rule.freq {
                    Frequency::Yearly => Duration::days(366 * 9),
                    Frequency::Monthly => Duration::days(400),
                    Frequency::Weekly => Duration::days(120),
                    _ => Duration::days(21),
                };
                for from in anchors {
                    let to = from + span;
                    let naive = naive_window(&rule, start, from, to);
                    let (fast, cost) = fast_window(&rule, start, from, to);
                    assert_eq!(fast, naive, "{text} from {start} window {from}..{to}");
                    empty += usize::from(naive.is_empty());
                    assert!(
                        cost <= 2 * naive.len() as u64 * rule.period_cost + 50_000,
                        "{text} from {start}: cost {cost} for {} walls",
                        naive.len()
                    );
                    cases += 1;
                }
            }
        }
        assert_eq!(cases, rules.len() * starts.len() * anchors.len());
        assert!(empty * 10 < cases, "{empty} of {cases} windows were empty");
    }

    #[test]
    fn hourly_series_from_years_ago_reaches_the_window() {
        let start = wall(2015, 1, 1, 9);
        let rule = build_rule("FREQ=HOURLY", start, Zone::Utc).unwrap();
        let from = wall(2026, 9, 1, 0);
        let (got, cost) = fast_window(&rule, start, from, wall(2026, 9, 1, 23));
        assert_eq!(got.len(), 24);
        assert_eq!(got[0], from);
        assert!(cost < 1_000, "{cost}");
    }

    #[test]
    fn counted_rules_step_from_the_start_and_stay_exact() {
        let start = wall(2025, 1, 6, 9);
        let rule = build_rule("FREQ=WEEKLY;COUNT=60", start, Zone::Utc).unwrap();
        let (got, _) = fast_window(&rule, start, wall(2026, 2, 1, 0), wall(2026, 12, 31, 0));
        assert_eq!(got.len(), 4);
        assert_eq!(got.last(), Some(&wall(2026, 2, 23, 9)));
    }

    #[test]
    fn rules_without_occurrences_are_bounded_by_the_budget() {
        let start = wall(2000, 1, 1, 0);
        let rule = build_rule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", start, Zone::Utc).unwrap();
        let mut budget = Budget::new(FEED_BUDGET);
        assert_eq!(rule.walls(start, start, &mut budget).count(), 0);
        assert!(budget.left() < FEED_BUDGET);
        let mut empty = Budget::new(10);
        let rule = build_rule("FREQ=DAILY", start, Zone::Utc).unwrap();
        assert_eq!(rule.walls(start, start, &mut empty).next(), None);
        assert_eq!(empty.left(), 0);
    }
}
