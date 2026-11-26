use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, Utc};

use super::budget::Budget;
use super::lexer::Component;
use super::rule::build_rule;
use super::time::{IcsTime, parse_property};
use crate::tz::{Zone, parse_offset, preferred_zones, resolve_tzid};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoneResolution {
    Named,
    MatchedRules,
    FixedStandardOffset,
}

#[derive(Clone, Debug)]
struct Observance {
    daylight: bool,
    start: NaiveDateTime,
    from: FixedOffset,
    to: FixedOffset,
    rule: Option<String>,
    rdates: Vec<NaiveDateTime>,
}

fn observances(comp: &Component) -> Vec<Observance> {
    comp.children
        .iter()
        .filter(|c| c.name == "STANDARD" || c.name == "DAYLIGHT")
        .filter_map(|c| {
            let to = c.prop("TZOFFSETTO").and_then(|p| parse_offset(&p.value))?;
            let from = c
                .prop("TZOFFSETFROM")
                .and_then(|p| parse_offset(&p.value))
                .unwrap_or(to);
            let start = c
                .prop("DTSTART")
                .map(parse_property)
                .and_then(|v| v.into_iter().next())
                .and_then(|t| match t {
                    IcsTime::Floating(n) | IcsTime::Utc(n) | IcsTime::Zoned(n, _) => Some(n),
                    IcsTime::Date(d) => d.and_hms_opt(0, 0, 0),
                })?;
            let rdates = c
                .props_named("RDATE")
                .flat_map(parse_property)
                .filter_map(|t| match t {
                    IcsTime::Floating(n) | IcsTime::Utc(n) | IcsTime::Zoned(n, _) => Some(n),
                    IcsTime::Date(d) => d.and_hms_opt(0, 0, 0),
                })
                .collect();
            Some(Observance {
                daylight: c.name == "DAYLIGHT",
                start,
                from,
                to,
                rule: c.prop("RRULE").map(|p| p.value.clone()),
                rdates,
            })
        })
        .collect()
}

struct Transition {
    at: DateTime<Utc>,
    from: i32,
    to: i32,
}

const ZONE_MATCH_COST: u64 = 5_000;

fn transitions_in(obs: &Observance, year: i32, budget: &mut Budget) -> Vec<Transition> {
    let mut walls: Vec<NaiveDateTime> = Vec::new();
    if let Some(rule) = &obs.rule {
        let year_start = NaiveDate::from_ymd_opt(year, 1, 1).and_then(|d| d.and_hms_opt(0, 0, 0));
        if let (Ok(rule), Some(year_start)) = (
            build_rule(rule, obs.start, Zone::Fixed(obs.from)),
            year_start,
        ) {
            walls.extend(
                rule.walls(obs.start, year_start, budget)
                    .take_while(|w| w.year() <= year)
                    .filter(|w| w.year() == year)
                    .take(64),
            );
        }
    } else {
        walls.extend(
            obs.rdates
                .iter()
                .chain(std::iter::once(&obs.start))
                .filter(|w| w.year() == year)
                .copied(),
        );
    }
    walls
        .into_iter()
        .map(|wall| Transition {
            at: Zone::Fixed(obs.from).to_utc(wall),
            from: obs.from.local_minus_utc(),
            to: obs.to.local_minus_utc(),
        })
        .collect()
}

fn latest(obs: &[Observance], daylight: bool) -> Option<&Observance> {
    obs.iter()
        .filter(|o| o.daylight == daylight)
        .max_by_key(|o| o.start)
}

pub(crate) fn resolve_vtimezone(
    comp: &Component,
    budget: &mut Budget,
) -> Option<(String, Zone, ZoneResolution)> {
    let tzid = comp.prop("TZID")?.value.trim().to_string();
    if tzid.is_empty() {
        return None;
    }
    if let Some(zone @ (Zone::Named(_) | Zone::Utc)) = resolve_tzid(&tzid) {
        return Some((tzid, zone, ZoneResolution::Named));
    }
    let obs = observances(comp);
    let standard = latest(&obs, false).or_else(|| latest(&obs, true))?;
    let std_offset = standard.to;
    let daylight = latest(&obs, true).filter(|d| !std::ptr::eq(*d, standard));
    let base_year = obs
        .iter()
        .map(|o| o.start.year())
        .max()
        .unwrap_or(2025)
        .max(2025);
    let years = [base_year, base_year + 1];
    let mut transitions = Vec::new();
    for year in years {
        transitions.extend(transitions_in(standard, year, budget));
        if let Some(d) = daylight {
            transitions.extend(transitions_in(d, year, budget));
        }
    }
    transitions.retain(|t| t.from != t.to);
    let dst_offset = daylight.map(|d| d.to.local_minus_utc());
    let samples: Vec<DateTime<Utc>> = years
        .iter()
        .flat_map(|y| [1, 4, 7, 10].map(|m| (*y, m)))
        .filter_map(|(y, m)| NaiveDate::from_ymd_opt(y, m, 15)?.and_hms_opt(12, 0, 0))
        .map(|n| n.and_utc())
        .collect();
    let std_secs = std_offset.local_minus_utc();
    let matches = |zone: Zone| {
        let ok_transitions = transitions.iter().all(|t| {
            zone.offset_seconds_at(t.at - Duration::minutes(1)) == t.from
                && zone.offset_seconds_at(t.at + Duration::minutes(1)) == t.to
        });
        let ok_samples = samples.iter().all(|s| {
            let off = zone.offset_seconds_at(*s);
            if transitions.is_empty() {
                off == std_secs
            } else {
                off == std_secs || Some(off) == dst_offset
            }
        });
        ok_transitions && ok_samples
    };
    if budget.can_afford(ZONE_MATCH_COST) {
        budget.charge(ZONE_MATCH_COST);
        if let Some(tz) = preferred_zones().find(|tz| matches(Zone::Named(*tz))) {
            return Some((tzid, Zone::Named(tz), ZoneResolution::MatchedRules));
        }
    }
    Some((
        tzid,
        Zone::Fixed(std_offset),
        ZoneResolution::FixedStandardOffset,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ics::budget::FEED_BUDGET;
    use crate::ics::lexer::lex;
    use chrono_tz::Tz;

    fn resolve(text: &str) -> (Zone, ZoneResolution) {
        let lexed = lex(text);
        let mut budget = Budget::new(FEED_BUDGET);
        let (_, zone, how) = resolve_vtimezone(&lexed.root.children[0], &mut budget).unwrap();
        (zone, how)
    }

    #[test]
    fn matches_outlook_custom_eastern() {
        let (zone, how) = resolve(
            "BEGIN:VTIMEZONE\nTZID:Customized Time Zone\nBEGIN:STANDARD\nDTSTART:16010101T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11\nEND:STANDARD\nBEGIN:DAYLIGHT\nDTSTART:16010101T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3\nEND:DAYLIGHT\nEND:VTIMEZONE\n",
        );
        assert_eq!(how, ZoneResolution::MatchedRules);
        assert_eq!(zone, Zone::Named(Tz::America__New_York));
    }

    #[test]
    fn matches_southern_hemisphere_rules() {
        let (zone, how) = resolve(
            "BEGIN:VTIMEZONE\nTZID:(UTC+10:00) Canberra\\, Melbourne\\, Sydney\nBEGIN:STANDARD\nDTSTART:16010101T030000\nTZOFFSETFROM:+1100\nTZOFFSETTO:+1000\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4\nEND:STANDARD\nBEGIN:DAYLIGHT\nDTSTART:16010101T020000\nTZOFFSETFROM:+1000\nTZOFFSETTO:+1100\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=10\nEND:DAYLIGHT\nEND:VTIMEZONE\n",
        );
        assert_eq!(how, ZoneResolution::MatchedRules);
        assert_eq!(zone, Zone::Named(Tz::Australia__Sydney));
    }

    #[test]
    fn falls_back_to_fixed_standard_offset() {
        let (zone, how) = resolve(
            "BEGIN:VTIMEZONE\nTZID:Mars Colony\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0317\nTZOFFSETTO:+0317\nEND:STANDARD\nEND:VTIMEZONE\n",
        );
        assert_eq!(how, ZoneResolution::FixedStandardOffset);
        assert_eq!(
            zone,
            FixedOffset::east_opt(3 * 3600 + 17 * 60)
                .map(Zone::Fixed)
                .unwrap()
        );
    }

    #[test]
    fn named_tzid_wins_over_rules() {
        let (zone, how) = resolve(
            "BEGIN:VTIMEZONE\nTZID:Europe/Berlin\nBEGIN:STANDARD\nDTSTART:19701025T030000\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nEND:STANDARD\nEND:VTIMEZONE\n",
        );
        assert_eq!(how, ZoneResolution::Named);
        assert_eq!(zone, Zone::Named(Tz::Europe__Berlin));
    }

    #[test]
    fn matches_zone_without_daylight_saving() {
        let (zone, how) = resolve(
            "BEGIN:VTIMEZONE\nTZID:India\nBEGIN:STANDARD\nDTSTART:16010101T000000\nTZOFFSETFROM:+0530\nTZOFFSETTO:+0530\nEND:STANDARD\nEND:VTIMEZONE\n",
        );
        assert_eq!(how, ZoneResolution::MatchedRules);
        assert_eq!(zone, Zone::Named(Tz::Asia__Kolkata));
    }
}
