use cap_meetings::library::DocMeta;
use gpui::App;

use crate::{i18n::tr, meetings::Meetings};

const WORDS_WORTH_SAYING: usize = 50;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pitch {
    pub minutes: Option<u64>,
    pub names: Vec<String>,
    pub words: Option<usize>,
}

impl Pitch {
    pub fn from_meta(meta: &DocMeta, words: Option<usize>) -> Self {
        let Some(meeting) = meta.meeting.as_ref() else {
            return Self::default();
        };
        let minutes =
            (meeting.duration_ms > 0).then(|| meeting.duration_ms.div_ceil(60_000).max(1));
        let mut names: Vec<String> = Vec::new();
        let attendees = meeting
            .event
            .iter()
            .flat_map(|e| e.attendees.iter())
            .filter(|a| !a.is_self)
            .filter_map(|a| a.name.clone());
        for name in attendees.chain(meeting.participants.iter().cloned()) {
            let first = name
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string();
            if !first.is_empty() && !names.contains(&first) {
                names.push(first);
            }
        }
        Self {
            minutes,
            names,
            words: words.filter(|w| *w >= WORDS_WORTH_SAYING),
        }
    }

    pub fn people(&self) -> Option<String> {
        match self.names.as_slice() {
            [] => None,
            [one] => Some(one.clone()),
            [a, b] => Some(tr::cap_ai::names::two(a, b)),
            [a, b, c] => Some(tr::cap_ai::names::three(a, b, c)),
            [a, b, ..] => Some(tr::cap_ai::names::several(a, b)),
        }
    }

    pub fn headline(&self) -> String {
        match (self.minutes, self.people()) {
            (Some(minutes), Some(names)) => {
                tr::cap_ai::sheet::headline_people(minutes as usize, names)
            }
            (Some(minutes), None) => tr::cap_ai::sheet::headline_call(minutes as usize),
            (None, _) => tr::cap_ai::sheet::headline_any().to_string(),
        }
    }

    pub fn ask_line(&self) -> String {
        match self.words {
            Some(words) => tr::cap_ai::sheet::ask_words(&grouped(words, crate::i18n::current())),
            None => tr::cap_ai::sheet::ask_any().to_string(),
        }
    }
}

fn grouped(n: usize, locale: crate::i18n::Locale) -> String {
    use crate::i18n::Locale;
    let separator = match locale {
        Locale::De | Locale::Es => ".",
        Locale::Fr => "\u{202f}",
        _ => ",",
    };
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + 4);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push_str(separator);
        }
        out.push(digit);
    }
    out
}

pub fn generic_headline() -> String {
    tr::cap_ai::sheet::headline_any().to_string()
}

pub fn for_doc(doc_id: &str, cx: &mut App) -> Option<Pitch> {
    let meetings = Meetings::try_global(cx)?;
    meetings.update(cx, |m, _| {
        let meta = m.library()?.load(doc_id).ok()?;
        let words = m.transcript(doc_id).map(|t| {
            t.utterances()
                .iter()
                .map(|u| u.text.split_whitespace().count())
                .sum::<usize>()
        });
        Some(Pitch::from_meta(&meta, words))
    })
}

#[cfg(test)]
mod tests {
    use cap_meetings::library::{Attendee, DocKind, EventSnapshot, MeetingDetails};
    use chrono::Utc;

    use super::*;

    fn meta(duration_ms: u64, attendees: &[(&str, bool)], participants: &[&str]) -> DocMeta {
        let mut meta = DocMeta::new("doc".into(), DocKind::Meeting, Utc::now());
        meta.meeting = Some(MeetingDetails {
            duration_ms,
            participants: participants.iter().map(|p| p.to_string()).collect(),
            event: (!attendees.is_empty()).then(|| EventSnapshot {
                id: "e".into(),
                title: "Sync".into(),
                start: None,
                end: None,
                link: None,
                attendees: attendees
                    .iter()
                    .map(|(name, is_self)| Attendee {
                        name: Some(name.to_string()),
                        email: None,
                        is_self: *is_self,
                    })
                    .collect(),
                calendar_name: None,
            }),
            ..MeetingDetails::default()
        });
        meta
    }

    #[test]
    fn the_pitch_uses_the_meeting_itself() {
        let pitch = Pitch::from_meta(
            &meta(
                36 * 60_000 - 5_000,
                &[("Hana Kim", false), ("Me Myself", true)],
                &["Jun Wei", "Hana Kim"],
            ),
            Some(4_200),
        );
        assert_eq!(pitch.minutes, Some(36));
        assert_eq!(pitch.names, vec!["Hana".to_string(), "Jun".to_string()]);
        assert_eq!(pitch.words, Some(4_200));
        let headline = pitch.headline();
        assert!(headline.contains("36") && headline.contains("Hana") && headline.contains("Jun"));
        assert!(pitch.ask_line().contains("4,200"));
    }

    #[test]
    fn word_counts_are_grouped_for_the_reader() {
        use crate::i18n::Locale;
        assert_eq!(super::grouped(4_132, Locale::En), "4,132");
        assert_eq!(super::grouped(1_234_567, Locale::De), "1.234.567");
        assert_eq!(super::grouped(4_132, Locale::Fr), "4\u{202f}132");
        assert_eq!(super::grouped(999, Locale::En), "999");
    }

    #[test]
    fn the_pitch_falls_back_when_details_are_missing() {
        let quiet = Pitch::from_meta(&meta(20_000, &[], &[]), Some(12));
        assert_eq!(quiet.minutes, Some(1));
        assert!(quiet.names.is_empty());
        assert_eq!(quiet.words, None);
        assert_eq!(quiet.ask_line(), tr::cap_ai::sheet::ask_any());
        let note = DocMeta::new("n".into(), DocKind::Note, Utc::now());
        assert_eq!(Pitch::from_meta(&note, None).headline(), generic_headline());
        let crowd = Pitch::from_meta(&meta(60_000, &[], &["A a", "B b", "C c", "D d"]), None);
        assert_eq!(crowd.people(), Some(tr::cap_ai::names::several("A", "B")));
    }
}
