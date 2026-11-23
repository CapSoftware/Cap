use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::{DateTime, Duration, FixedOffset, LocalResult, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    Utc,
    Named(Tz),
    Fixed(FixedOffset),
}

impl Zone {
    pub fn to_utc(self, local: NaiveDateTime) -> DateTime<Utc> {
        match self {
            Zone::Utc => local.and_utc(),
            Zone::Fixed(offset) => {
                let shifted = local
                    .checked_sub_signed(Duration::seconds(i64::from(offset.local_minus_utc())))
                    .unwrap_or(local);
                shifted.and_utc()
            }
            Zone::Named(tz) => named_to_utc(tz, local),
        }
    }

    pub fn from_utc(self, instant: DateTime<Utc>) -> NaiveDateTime {
        match self {
            Zone::Utc => instant.naive_utc(),
            Zone::Fixed(offset) => instant.with_timezone(&offset).naive_local(),
            Zone::Named(tz) => instant.with_timezone(&tz).naive_local(),
        }
    }

    pub fn offset_seconds_at(self, instant: DateTime<Utc>) -> i32 {
        match self {
            Zone::Utc => 0,
            Zone::Fixed(offset) => offset.local_minus_utc(),
            Zone::Named(tz) => tz
                .offset_from_utc_datetime(&instant.naive_utc())
                .fix()
                .local_minus_utc(),
        }
    }
}

fn named_to_utc(tz: Tz, local: NaiveDateTime) -> DateTime<Utc> {
    match tz.from_local_datetime(&local) {
        LocalResult::Single(dt) => dt.with_timezone(&Utc),
        LocalResult::Ambiguous(earliest, _) => earliest.with_timezone(&Utc),
        LocalResult::None => {
            for minutes in [30, 60, 90, 120, 180] {
                let Some(shifted) = local.checked_add_signed(Duration::minutes(minutes)) else {
                    break;
                };
                if let LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) =
                    tz.from_local_datetime(&shifted)
                {
                    let correction = Duration::seconds(i64::from(gap_offset_change(tz, dt)))
                        - Duration::minutes(minutes);
                    let utc = dt.with_timezone(&Utc);
                    return utc.checked_add_signed(correction).unwrap_or(utc);
                }
            }
            local.and_utc()
        }
    }
}

fn gap_offset_change(tz: Tz, after: DateTime<Tz>) -> i32 {
    let after_offset = after.offset().fix().local_minus_utc();
    let after_utc = after.with_timezone(&Utc);
    let before = after_utc
        .checked_sub_signed(Duration::hours(4))
        .unwrap_or(after_utc);
    let before_offset = tz
        .offset_from_utc_datetime(&before.naive_utc())
        .fix()
        .local_minus_utc();
    after_offset - before_offset
}

pub fn resolve_tzid(raw: &str) -> Option<Zone> {
    let name = raw.trim().trim_matches('"').trim();
    if name.is_empty() {
        return None;
    }
    if let Some(zone) = resolve_plain(name) {
        return Some(zone);
    }
    let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty()).collect();
    for take in [3, 2, 1] {
        if parts.len() > take {
            let candidate = parts[parts.len() - take..].join("/");
            if let Some(zone) = resolve_plain(&candidate) {
                return Some(zone);
            }
        }
    }
    if let Some(rest) = name.strip_prefix('(') {
        let label = rest.split_once(')').map(|(_, l)| l.trim()).unwrap_or("");
        if let Some(zone) = resolve_plain(label) {
            return Some(zone);
        }
    }
    None
}

fn resolve_plain(name: &str) -> Option<Zone> {
    let upper = name.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "UTC" | "Z" | "GMT" | "ETC/UTC" | "ETC/GMT" | "UCT" | "ZULU" | "COORDINATED UNIVERSAL TIME"
    ) || upper == "TZONE://MICROSOFT/UTC"
    {
        return Some(Zone::Utc);
    }
    if let Ok(tz) = name.parse::<Tz>() {
        return Some(Zone::Named(tz));
    }
    let lower = name.trim().to_ascii_lowercase();
    let index = lowercase_index();
    if let Some(found) = index.windows.get(&lower) {
        return found.map(Zone::Named);
    }
    if let Some(tz) = index.iana.get(&lower) {
        return Some(Zone::Named(*tz));
    }
    parse_utc_offset_label(name).map(Zone::Fixed)
}

struct LowercaseIndex {
    windows: HashMap<String, Option<Tz>>,
    iana: HashMap<String, Tz>,
}

fn lowercase_index() -> &'static LowercaseIndex {
    static INDEX: OnceLock<LowercaseIndex> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut windows = HashMap::new();
        for (name, iana) in WINDOWS_ZONES {
            windows
                .entry(name.to_ascii_lowercase())
                .or_insert_with(|| iana.parse::<Tz>().ok());
        }
        let mut iana = HashMap::new();
        for tz in chrono_tz::TZ_VARIANTS {
            iana.entry(tz.name().to_ascii_lowercase()).or_insert(tz);
        }
        LowercaseIndex { windows, iana }
    })
}

pub fn parse_utc_offset_label(label: &str) -> Option<FixedOffset> {
    let trimmed = label.trim().trim_start_matches('(');
    let upper = trimmed.to_ascii_uppercase();
    let rest = upper
        .strip_prefix("UTC")
        .or_else(|| upper.strip_prefix("GMT"))?;
    let rest = rest.split(')').next().unwrap_or("").trim();
    if rest.is_empty() {
        return FixedOffset::east_opt(0);
    }
    parse_offset(rest)
}

pub fn parse_offset(value: &str) -> Option<FixedOffset> {
    let value = value.trim();
    let (sign, digits) = match value.as_bytes().first()? {
        b'+' => (1, &value[1..]),
        b'-' => (-1, &value[1..]),
        _ => return None,
    };
    let digits: String = digits.chars().filter(|c| *c != ':').collect();
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (h, m, s) = match digits.len() {
        1 | 2 => (digits.parse::<i32>().ok()?, 0, 0),
        4 => (digits[..2].parse().ok()?, digits[2..].parse().ok()?, 0),
        6 => (
            digits[..2].parse().ok()?,
            digits[2..4].parse().ok()?,
            digits[4..].parse().ok()?,
        ),
        _ => return None,
    };
    if h > 23 || m > 59 || s > 59 {
        return None;
    }
    FixedOffset::east_opt(sign * (h * 3600 + m * 60 + s))
}

pub fn windows_to_iana(name: &str) -> Option<&'static str> {
    let wanted = name.trim();
    WINDOWS_ZONES
        .iter()
        .find(|(windows, _)| windows.eq_ignore_ascii_case(wanted))
        .map(|(_, iana)| *iana)
}

pub fn preferred_zones() -> impl Iterator<Item = Tz> {
    WINDOWS_ZONES
        .iter()
        .filter_map(|(_, iana)| iana.parse::<Tz>().ok())
        .filter(|tz| !tz.name().starts_with("Etc/"))
        .chain(chrono_tz::TZ_VARIANTS.iter().copied())
}

pub const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("Dateline Standard Time", "Etc/GMT+12"),
    ("UTC-11", "Etc/GMT+11"),
    ("Aleutian Standard Time", "America/Adak"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Marquesas Standard Time", "Pacific/Marquesas"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("UTC-09", "Etc/GMT+9"),
    ("Pacific Standard Time (Mexico)", "America/Tijuana"),
    ("UTC-08", "Etc/GMT+8"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time (Mexico)", "America/Mazatlan"),
    ("Mountain Standard Time", "America/Denver"),
    ("Yukon Standard Time", "America/Whitehorse"),
    ("Central America Standard Time", "America/Guatemala"),
    ("Central Standard Time", "America/Chicago"),
    ("Easter Island Standard Time", "Pacific/Easter"),
    ("Central Standard Time (Mexico)", "America/Mexico_City"),
    ("Mexico Standard Time", "America/Mexico_City"),
    ("Mexico Standard Time 2", "America/Chihuahua"),
    ("Canada Central Standard Time", "America/Regina"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("Eastern Standard Time (Mexico)", "America/Cancun"),
    ("Eastern Standard Time", "America/New_York"),
    ("Haiti Standard Time", "America/Port-au-Prince"),
    ("Cuba Standard Time", "America/Havana"),
    ("US Eastern Standard Time", "America/Indiana/Indianapolis"),
    ("Turks And Caicos Standard Time", "America/Grand_Turk"),
    ("Paraguay Standard Time", "America/Asuncion"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Venezuela Standard Time", "America/Caracas"),
    ("Central Brazilian Standard Time", "America/Cuiaba"),
    ("SA Western Standard Time", "America/La_Paz"),
    ("Pacific SA Standard Time", "America/Santiago"),
    ("Newfoundland Standard Time", "America/St_Johns"),
    ("Tocantins Standard Time", "America/Araguaina"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("SA Eastern Standard Time", "America/Cayenne"),
    ("Argentina Standard Time", "America/Argentina/Buenos_Aires"),
    ("Greenland Standard Time", "America/Nuuk"),
    ("Montevideo Standard Time", "America/Montevideo"),
    ("Magallanes Standard Time", "America/Punta_Arenas"),
    ("Saint Pierre Standard Time", "America/Miquelon"),
    ("Bahia Standard Time", "America/Bahia"),
    ("UTC-02", "Etc/GMT+2"),
    ("Mid-Atlantic Standard Time", "Etc/GMT+2"),
    ("Azores Standard Time", "Atlantic/Azores"),
    ("Cape Verde Standard Time", "Atlantic/Cape_Verde"),
    ("UTC", "Etc/UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("Sao Tome Standard Time", "Africa/Sao_Tome"),
    ("Morocco Standard Time", "Africa/Casablanca"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
    ("Jordan Standard Time", "Asia/Amman"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("Middle East Standard Time", "Asia/Beirut"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("Syria Standard Time", "Asia/Damascus"),
    ("West Bank Standard Time", "Asia/Hebron"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("FLE Standard Time", "Europe/Kyiv"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("South Sudan Standard Time", "Africa/Juba"),
    ("Kaliningrad Standard Time", "Europe/Kaliningrad"),
    ("Sudan Standard Time", "Africa/Khartoum"),
    ("Libya Standard Time", "Africa/Tripoli"),
    ("Namibia Standard Time", "Africa/Windhoek"),
    ("Arabic Standard Time", "Asia/Baghdad"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Belarus Standard Time", "Europe/Minsk"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("E. Africa Standard Time", "Africa/Nairobi"),
    ("Volgograd Standard Time", "Europe/Volgograd"),
    ("Iran Standard Time", "Asia/Tehran"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Astrakhan Standard Time", "Europe/Astrakhan"),
    ("Azerbaijan Standard Time", "Asia/Baku"),
    ("Russia Time Zone 3", "Europe/Samara"),
    ("Mauritius Standard Time", "Indian/Mauritius"),
    ("Saratov Standard Time", "Europe/Saratov"),
    ("Georgian Standard Time", "Asia/Tbilisi"),
    ("Caucasus Standard Time", "Asia/Yerevan"),
    ("Armenian Standard Time", "Asia/Yerevan"),
    ("Afghanistan Standard Time", "Asia/Kabul"),
    ("West Asia Standard Time", "Asia/Tashkent"),
    ("Qyzylorda Standard Time", "Asia/Qyzylorda"),
    ("Ekaterinburg Standard Time", "Asia/Yekaterinburg"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Sri Lanka Standard Time", "Asia/Colombo"),
    ("Nepal Standard Time", "Asia/Kathmandu"),
    ("Central Asia Standard Time", "Asia/Almaty"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("Omsk Standard Time", "Asia/Omsk"),
    ("Myanmar Standard Time", "Asia/Yangon"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("Altai Standard Time", "Asia/Barnaul"),
    ("W. Mongolia Standard Time", "Asia/Hovd"),
    ("North Asia Standard Time", "Asia/Krasnoyarsk"),
    ("N. Central Asia Standard Time", "Asia/Novosibirsk"),
    ("Tomsk Standard Time", "Asia/Tomsk"),
    ("China Standard Time", "Asia/Shanghai"),
    ("North Asia East Standard Time", "Asia/Irkutsk"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("Malay Peninsula Standard Time", "Asia/Kuala_Lumpur"),
    ("W. Australia Standard Time", "Australia/Perth"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Ulaanbaatar Standard Time", "Asia/Ulaanbaatar"),
    ("Aus Central W. Standard Time", "Australia/Eucla"),
    ("Transbaikal Standard Time", "Asia/Chita"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("North Korea Standard Time", "Asia/Pyongyang"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("Yakutsk Standard Time", "Asia/Yakutsk"),
    ("Cen. Australia Standard Time", "Australia/Adelaide"),
    ("AUS Central Standard Time", "Australia/Darwin"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("West Pacific Standard Time", "Pacific/Port_Moresby"),
    ("Tasmania Standard Time", "Australia/Hobart"),
    ("Vladivostok Standard Time", "Asia/Vladivostok"),
    ("Lord Howe Standard Time", "Australia/Lord_Howe"),
    ("Bougainville Standard Time", "Pacific/Bougainville"),
    ("Russia Time Zone 10", "Asia/Srednekolymsk"),
    ("Magadan Standard Time", "Asia/Magadan"),
    ("Norfolk Standard Time", "Pacific/Norfolk"),
    ("Sakhalin Standard Time", "Asia/Sakhalin"),
    ("Central Pacific Standard Time", "Pacific/Guadalcanal"),
    ("Russia Time Zone 11", "Asia/Kamchatka"),
    ("Kamchatka Standard Time", "Asia/Kamchatka"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("UTC+12", "Etc/GMT-12"),
    ("Fiji Standard Time", "Pacific/Fiji"),
    ("Chatham Islands Standard Time", "Pacific/Chatham"),
    ("UTC+13", "Etc/GMT-13"),
    ("Tonga Standard Time", "Pacific/Tongatapu"),
    ("Samoa Standard Time", "Pacific/Apia"),
    ("Line Islands Standard Time", "Pacific/Kiritimati"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn naive(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d)
            .and_then(|date| date.and_hms_opt(h, mi, 0))
            .unwrap()
    }

    #[test]
    fn every_windows_zone_maps_to_a_known_iana_zone() {
        for (windows, iana) in WINDOWS_ZONES {
            assert!(iana.parse::<Tz>().is_ok(), "{windows} -> {iana}");
            assert!(resolve_tzid(windows).is_some(), "{windows}");
        }
    }

    #[test]
    fn resolves_common_forms() {
        assert_eq!(
            resolve_tzid("Pacific Standard Time"),
            Some(Zone::Named(Tz::America__Los_Angeles))
        );
        assert_eq!(
            resolve_tzid("\"America/New_York\""),
            Some(Zone::Named(Tz::America__New_York))
        );
        assert_eq!(
            resolve_tzid("/mozilla.org/20050126_1/Europe/Berlin"),
            Some(Zone::Named(Tz::Europe__Berlin))
        );
        assert_eq!(
            resolve_tzid("/freeassociation.sourceforge.net/Tzfile/America/Argentina/Buenos_Aires"),
            Some(Zone::Named(Tz::America__Argentina__Buenos_Aires))
        );
        assert_eq!(resolve_tzid("utc"), Some(Zone::Utc));
        assert_eq!(resolve_tzid("tzone://Microsoft/Utc"), Some(Zone::Utc));
        assert_eq!(
            resolve_tzid("(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi"),
            FixedOffset::east_opt(19800).map(Zone::Fixed)
        );
        assert_eq!(resolve_tzid("Not A Zone"), None);
        assert_eq!(resolve_tzid(""), None);
    }

    #[test]
    fn gap_times_move_forward_and_overlaps_take_the_first() {
        let ny = Zone::Named(Tz::America__New_York);
        let gap = ny.to_utc(naive(2026, 3, 8, 2, 30));
        assert_eq!(gap, naive(2026, 3, 8, 7, 30).and_utc());
        let overlap = ny.to_utc(naive(2026, 11, 1, 1, 30));
        assert_eq!(overlap, naive(2026, 11, 1, 5, 30).and_utc());
        let lord_howe = Zone::Named(Tz::Australia__Lord_Howe);
        let half_hour_gap = lord_howe.to_utc(naive(2026, 10, 4, 2, 15));
        assert_eq!(lord_howe.from_utc(half_hour_gap), naive(2026, 10, 4, 2, 45));
    }

    #[test]
    fn offsets_parse() {
        assert_eq!(parse_offset("-0500"), FixedOffset::west_opt(5 * 3600));
        assert_eq!(
            parse_offset("+05:45"),
            FixedOffset::east_opt(5 * 3600 + 45 * 60)
        );
        assert_eq!(parse_offset("+1"), FixedOffset::east_opt(3600));
        assert_eq!(parse_offset("0500"), None);
        assert_eq!(parse_offset("+99"), None);
        assert_eq!(parse_offset("+"), None);
    }
}
