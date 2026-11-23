use cap_meetings::{
    library::{DocKind, DocMeta},
    transcript::{Header, SpeakerLabel, Transcript},
};

use super::format;
use crate::i18n::tr;

pub struct Parts<'a> {
    pub meta: &'a DocMeta,
    pub notes_markdown: Option<String>,
    pub enhanced_markdown: Option<String>,
    pub transcript: Option<&'a Transcript>,
    pub folder: Option<&'a str>,
}

pub fn display_title(meta: &DocMeta) -> String {
    let title = meta.title.trim();
    if title.is_empty() {
        tr::documents::untitled().to_string()
    } else {
        title.to_string()
    }
}

pub fn participants(meta: &DocMeta) -> Vec<String> {
    let Some(meeting) = meta.meeting.as_ref() else {
        return Vec::new();
    };
    let mut names: Vec<String> = meeting
        .participants
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if let Some(event) = meeting.event.as_ref() {
        for attendee in &event.attendees {
            if attendee.is_self {
                continue;
            }
            let name = attendee
                .name
                .as_deref()
                .filter(|n| !n.trim().is_empty())
                .or(attendee.email.as_deref())
                .map(|n| n.trim().to_string());
            if let Some(name) = name
                && !names.iter().any(|n| n.eq_ignore_ascii_case(&name))
            {
                names.push(name);
            }
        }
    }
    names
}

pub fn self_name(meta: &DocMeta) -> Option<String> {
    crate::meetings::speakers::user_name(meta)
}

pub fn when_line(meta: &DocMeta) -> String {
    let start = format::local(meta.sort_time());
    let date = format::day_label(start.date(), chrono::Local::now().date_naive());
    let mut line = format!("{date} {}", format::clock(start));
    if let Some(meeting) = meta.meeting.as_ref()
        && meeting.duration_ms > 0
    {
        line.push_str(" · ");
        line.push_str(&format::duration(meeting.duration_ms));
    }
    line
}

pub fn transcript_header(meta: &DocMeta) -> Header {
    Header {
        title: display_title(meta),
        date: Some(when_line(meta)),
        participants: participants(meta),
        self_name: self_name(meta),
    }
}

pub fn plain_transcript(meta: &DocMeta, transcript: &Transcript) -> String {
    let header = transcript_header(meta);
    let mut out = String::new();
    out.push_str(&header.title);
    out.push('\n');
    if let Some(date) = &header.date {
        out.push_str(date);
        out.push('\n');
    }
    out.push('\n');
    for turn in transcript.turns() {
        let label = speaker_label(transcript, &turn, header.self_name.as_deref());
        out.push_str(&format!(
            "[{}] {}: {}\n",
            cap_meetings::transcript::format_timestamp(turn.start_ms),
            label,
            turn.text
        ));
    }
    out
}

pub fn speaker_label(
    transcript: &Transcript,
    turn: &cap_meetings::transcript::Turn,
    self_name: Option<&str>,
) -> String {
    word_speaker(&transcript.turn_speaker(turn), self_name)
}

/// Words a speaker in the interface's language.
pub fn word_speaker(label: &SpeakerLabel, self_name: Option<&str>) -> String {
    match label {
        SpeakerLabel::Named(name) => name.clone(),
        SpeakerLabel::User => self_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| tr::documents::transcript::you().to_string()),
        SpeakerLabel::Person(n) => tr::documents::transcript::person(*n as usize),
        SpeakerLabel::Others => tr::documents::transcript::others().to_string(),
    }
}

pub fn compose(parts: &Parts<'_>) -> String {
    let meta = parts.meta;
    let mut out = format!("# {}\n\n", display_title(meta));
    let mut details = vec![when_line(meta)];
    let people = participants(meta);
    if !people.is_empty() {
        details.push(format!(
            "{}: {}",
            tr::documents::export::participants(),
            people.join(", ")
        ));
    }
    if let Some(folder) = parts.folder {
        details.push(format!("{}: {folder}", tr::documents::export::folder()));
    }
    for line in details {
        out.push_str(&line);
        out.push_str("  \n");
    }
    let section = |out: &mut String, heading: &str, body: &str| {
        let body = body.trim();
        if body.is_empty() {
            return;
        }
        out.push_str(&format!("\n## {heading}\n\n{body}\n"));
    };
    if let Some(enhanced) = parts.enhanced_markdown.as_deref() {
        section(&mut out, tr::documents::export::notes(), enhanced);
    }
    if let Some(notes) = parts.notes_markdown.as_deref() {
        let heading = if meta.kind == DocKind::Meeting {
            tr::documents::export::my_notes()
        } else {
            tr::documents::export::notes()
        };
        section(&mut out, heading, notes);
    }
    if let Some(transcript) = parts.transcript
        && !transcript.is_empty()
    {
        let self_name = self_name(meta);
        let lines: Vec<String> = transcript
            .turns()
            .iter()
            .map(|turn| {
                format!(
                    "**{}** [{}]: {}",
                    speaker_label(transcript, turn, self_name.as_deref()),
                    cap_meetings::transcript::format_timestamp(turn.start_ms),
                    turn.text
                )
            })
            .collect();
        section(
            &mut out,
            tr::documents::export::transcript(),
            &lines.join("\n\n"),
        );
    }
    out
}

pub fn file_name(meta: &DocMeta) -> String {
    let title = display_title(meta);
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // A name that starts with a dot is a hidden file (".NET migration").
    let cleaned = cleaned.trim_start_matches(['.', ' ']);
    let cleaned: String = cleaned.chars().take(100).collect();
    format!(
        "{}.md",
        if cleaned.is_empty() {
            tr::documents::untitled().to_string()
        } else {
            cleaned
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_meetings::{
        library::MeetingDetails,
        transcript::{LogLine, Source, Utterance},
    };
    use chrono::Utc;

    fn meeting() -> DocMeta {
        let mut meta = DocMeta::new(
            "20261112T100000000Z-abcdef".into(),
            DocKind::Meeting,
            Utc::now(),
        );
        meta.title = "Design review".into();
        meta.meeting = Some(MeetingDetails {
            started_at: Some(Utc::now()),
            duration_ms: 30 * 60_000,
            participants: vec!["Ana".into(), "Ben".into()],
            ..MeetingDetails::default()
        });
        meta
    }

    fn transcript() -> Transcript {
        let mut t = Transcript::new();
        for (i, (source, text)) in [
            (Source::Mic, "Shall we start"),
            (Source::System, "Yes, the mockups are ready"),
        ]
        .into_iter()
        .enumerate()
        {
            t.apply(LogLine::Upsert {
                utterance: Utterance {
                    id: format!("u{i}"),
                    source,
                    start_ms: i as u64 * 5_000,
                    end_ms: i as u64 * 5_000 + 2_000,
                    text: text.into(),
                    is_final: true,
                    ..Utterance::default()
                },
            });
        }
        t
    }

    #[test]
    fn export_has_every_section_in_order() {
        let meta = meeting();
        let t = transcript();
        let out = compose(&Parts {
            meta: &meta,
            notes_markdown: Some("- my point".into()),
            enhanced_markdown: Some("### Decisions\n\n- Ship it".into()),
            transcript: Some(&t),
            folder: Some("Work"),
        });
        assert!(out.starts_with("# Design review\n"));
        assert!(out.contains("Participants: Ana, Ben"));
        assert!(out.contains("Folder: Work"));
        let notes = out.find("## Summary").unwrap();
        let mine = out.find("## My notes").unwrap();
        let transcript = out.find("## Transcript").unwrap();
        assert!(notes < mine && mine < transcript);
        assert!(out.contains("**You** [00:00]: Shall we start"));
        assert!(out.contains("**Others** [00:05]: Yes, the mockups are ready"));
    }

    #[test]
    fn empty_sections_are_left_out() {
        let mut meta = meeting();
        meta.kind = DocKind::Note;
        meta.meeting = None;
        let out = compose(&Parts {
            meta: &meta,
            notes_markdown: Some("   ".into()),
            enhanced_markdown: None,
            transcript: None,
            folder: None,
        });
        assert!(!out.contains("##"));
    }

    #[test]
    fn file_names_are_safe() {
        let mut meta = meeting();
        meta.title = "Q3: plan / review?".into();
        assert_eq!(file_name(&meta), "Q3 plan review.md");
        meta.title = "  ".into();
        assert_eq!(file_name(&meta), "Untitled.md");
        meta.title = ".NET migration".into();
        assert_eq!(file_name(&meta), "NET migration.md");
        meta.title = "...".into();
        assert_eq!(file_name(&meta), "Untitled.md");
    }
}
