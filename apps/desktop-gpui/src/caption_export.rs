//! Captions as subtitle files: SubRip (`.srt`) and WebVTT (`.vtt`), timed to
//! the edited video.
//!
//! Cues come from the caption track the renderer draws, which is already
//! projected through cuts, clip speeds, transitions and fullscreen holds, and
//! are shaped the way the renderer shows them: fillers it hides are left out,
//! a caption lasts while it is drawn or fading out, and where two captions
//! overlap only the one on screen is kept.

use cap_project::caption_words::caption_display_segment;
use cap_project::{CaptionTrackSegment, MAX_CAPTION_WORD_DURATION, ProjectConfiguration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptionFormat {
    Srt,
    Vtt,
}

impl CaptionFormat {
    pub const ALL: [Self; 2] = [Self::Srt, Self::Vtt];

    pub fn label(self) -> &'static str {
        match self {
            Self::Srt => crate::i18n::tr::editor::transcript::download_srt(),
            Self::Vtt => crate::i18n::tr::editor::transcript::download_vtt(),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

fn drawn_until(segment: &CaptionTrackSegment) -> f64 {
    match segment.words.last() {
        Some(last) => segment
            .end
            .min(f64::from(last.start) + f64::from(MAX_CAPTION_WORD_DURATION)),
        None => segment.end,
    }
}

fn milliseconds(seconds: f64) -> u64 {
    (seconds * 1000.0).round().max(0.0) as u64
}

/// One line per line of caption text, with control characters dropped and
/// runs of whitespace collapsed, so a cue can never end early on a blank line.
fn cue_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|line| {
            line.chars()
                .map(|char| if char.is_whitespace() { ' ' } else { char })
                .filter(|char| !char.is_control())
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Disjoint, sorted time ranges.
#[derive(Default)]
struct Covered(Vec<(f64, f64)>);

impl Covered {
    fn uncovered(&self, (start, end): (f64, f64)) -> Vec<(f64, f64)> {
        let mut pieces = Vec::new();
        let mut cursor = start;
        let first = self.0.partition_point(|range| range.1 <= start);
        for &(from, until) in &self.0[first..] {
            if from >= end || cursor >= end {
                break;
            }
            if from > cursor {
                pieces.push((cursor, from));
            }
            cursor = cursor.max(until);
        }
        if cursor < end {
            pieces.push((cursor, end));
        }
        pieces
    }

    fn add(&mut self, (start, end): (f64, f64)) {
        let first = self.0.partition_point(|range| range.1 < start);
        let mut last = first;
        let (mut from, mut until) = (start, end);
        while let Some(&(other_from, other_until)) = self.0.get(last) {
            if other_from > until {
                break;
            }
            from = from.min(other_from);
            until = until.max(other_until);
            last += 1;
        }
        self.0.splice(first..last, [(from, until)]);
    }
}

struct Shown {
    drawn: (f64, f64),
    fading: (f64, f64),
    text: String,
}

/// Mirrors `find_active_caption_segment`: at any moment the first caption in
/// track order that is drawn there wins, and a fade-out shows only where no
/// caption is drawn, again first in track order.
pub(crate) fn cues(project: &ProjectConfiguration) -> Vec<Cue> {
    let (Some(captions), Some(timeline)) = (&project.captions, &project.timeline) else {
        return Vec::new();
    };
    let settings = &captions.settings;
    let hide_fillers = settings.hides_fillers();
    let shown: Vec<Shown> = timeline
        .caption_segments
        .iter()
        .filter_map(|segment| {
            let display = caption_display_segment(segment, hide_fillers)?;
            let start = display.start.max(segment.start).max(0.0);
            let end = drawn_until(&display).min(drawn_until(segment));
            let fade = f64::from(
                display
                    .fade_duration_override
                    .unwrap_or(settings.fade_duration),
            )
            .max(0.0);
            let text = cue_text(&display.text);
            (start.is_finite() && end.is_finite() && end > start && !text.is_empty()).then_some(
                Shown {
                    drawn: (start, end),
                    fading: (end, if fade.is_finite() { end + fade } else { end }),
                    text,
                },
            )
        })
        .collect();

    let mut pieces: Vec<(f64, f64, usize)> = Vec::new();
    let mut drawn = Covered::default();
    for (index, caption) in shown.iter().enumerate() {
        pieces.extend(
            drawn
                .uncovered(caption.drawn)
                .into_iter()
                .map(|(from, until)| (from, until, index)),
        );
        drawn.add(caption.drawn);
    }
    let mut fading = Covered::default();
    for (index, caption) in shown.iter().enumerate() {
        if caption.fading.1 <= caption.fading.0 {
            continue;
        }
        for piece in drawn.uncovered(caption.fading) {
            pieces.extend(
                fading
                    .uncovered(piece)
                    .into_iter()
                    .map(|(from, until)| (from, until, index)),
            );
        }
        fading.add(caption.fading);
    }
    pieces.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut cues: Vec<Cue> = Vec::with_capacity(shown.len());
    let mut last: Option<(usize, f64)> = None;
    for (from, until, index) in pieces {
        let start_ms = milliseconds(from);
        let end_ms = milliseconds(until);
        if end_ms <= start_ms {
            continue;
        }
        match (last, cues.last_mut()) {
            (Some((previous, previous_end)), Some(cue))
                if previous == index && (from - previous_end).abs() < 1e-9 =>
            {
                cue.end_ms = end_ms;
            }
            _ => cues.push(Cue {
                start_ms,
                end_ms,
                text: shown[index].text.clone(),
            }),
        }
        last = Some((index, until));
    }
    cues
}

fn timestamp(ms: u64, separator: char) -> String {
    format!(
        "{:02}:{:02}:{:02}{separator}{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

fn escape_vtt(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) fn format(cues: &[Cue], format: CaptionFormat) -> String {
    let (separator, mut out) = match format {
        CaptionFormat::Srt => (',', String::new()),
        CaptionFormat::Vtt => ('.', String::from("WEBVTT\n")),
    };
    for (index, cue) in cues.iter().enumerate() {
        if index > 0 || format == CaptionFormat::Vtt {
            out.push('\n');
        }
        let text = match format {
            CaptionFormat::Srt => cue.text.clone(),
            CaptionFormat::Vtt => escape_vtt(&cue.text),
        };
        out.push_str(&format!(
            "{}\n{} --> {}\n{text}\n",
            index + 1,
            timestamp(cue.start_ms, separator),
            timestamp(cue.end_ms, separator)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(timeline: serde_json::Value, settings: serde_json::Value) -> ProjectConfiguration {
        serde_json::from_value(serde_json::json!({
            "timeline": timeline,
            "captions": { "segments": [], "settings": settings, "sourceTimed": true }
        }))
        .unwrap()
    }

    fn track(segments: serde_json::Value) -> ProjectConfiguration {
        project(
            serde_json::json!({
                "segments": [{ "start": 0.0, "end": 100.0, "timescale": 1.0 }],
                "zoomSegments": [],
                "captionSegments": segments
            }),
            serde_json::json!({}),
        )
    }

    fn cue(start_ms: u64, end_ms: u64, text: &str) -> Cue {
        Cue {
            start_ms,
            end_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn srt_and_vtt_are_written_to_spec() {
        let cues = [
            cue(111, 445, "hello"),
            cue(3_723_004, 3_725_000, "Cap <b> & fast --> captions"),
        ];
        assert_eq!(
            format(&cues, CaptionFormat::Srt),
            "1\n00:00:00,111 --> 00:00:00,445\nhello\n\n2\n01:02:03,004 --> 01:02:05,000\nCap <b> & fast --> captions\n"
        );
        assert_eq!(
            format(&cues, CaptionFormat::Vtt),
            "WEBVTT\n\n1\n00:00:00.111 --> 00:00:00.445\nhello\n\n2\n01:02:03.004 --> 01:02:05.000\nCap &lt;b&gt; &amp; fast --&gt; captions\n"
        );
        assert_eq!(format(&[], CaptionFormat::Srt), "");
        assert_eq!(format(&[], CaptionFormat::Vtt), "WEBVTT\n");
    }

    #[test]
    fn cue_text_never_breaks_a_cue_and_keeps_unicode() {
        let project = track(serde_json::json!([
            { "id": "a", "start": 1.0, "end": 2.0, "text": "  line\tone \r\n\r\n\u{0007}line two\u{000B}  " },
            { "id": "b", "start": 3.0, "end": 4.0, "text": "שלום עולם 👋🏽 你好、世界 e\u{0301}" },
            { "id": "c", "start": 5.0, "end": 6.0, "text": " \n " }
        ]));
        assert_eq!(
            cues(&project),
            [
                cue(1000, 2150, "line one\nline two"),
                cue(3000, 4150, "שלום עולם 👋🏽 你好、世界 e\u{0301}")
            ]
        );
    }

    #[test]
    fn overlapping_captions_keep_the_one_on_screen() {
        let project = track(serde_json::json!([
            { "id": "a", "start": 1.0, "end": 5.0, "text": "first" },
            { "id": "b", "start": 3.0, "end": 4.0, "text": "hidden" },
            { "id": "c", "start": 4.5, "end": 7.0, "text": "second" },
            { "id": "d", "start": 7.0, "end": 8.0, "text": "third" }
        ]));
        assert_eq!(
            cues(&project),
            [
                cue(1000, 5000, "first"),
                cue(5000, 7000, "second"),
                cue(7000, 8150, "third")
            ]
        );
    }

    #[test]
    fn the_earlier_caption_in_the_track_wins_even_when_it_shows_later() {
        let mut project = track(serde_json::json!([
            { "id": "a", "start": 8.0, "end": 10.0, "text": "um first",
              "words": [
                { "text": "um", "start": 8.0, "end": 8.4 },
                { "text": "first", "start": 9.2, "end": 10.0 }
              ] },
            { "id": "b", "start": 8.5, "end": 10.5, "text": "second" }
        ]));
        project.captions.as_mut().unwrap().settings.filler_language = Some("en".into());
        assert_eq!(
            cues(&project),
            [
                cue(8500, 9200, "second"),
                cue(9200, 10000, "first"),
                cue(10000, 10650, "second")
            ]
        );
    }

    #[test]
    fn a_fade_out_lasts_until_the_next_caption_or_its_own_length() {
        let mut project = track(serde_json::json!([
            { "id": "a", "start": 1.0, "end": 2.0, "text": "slow", "fadeDurationOverride": 0.5 },
            { "id": "b", "start": 2.2, "end": 3.0, "text": "none", "fadeDurationOverride": 0.0 },
            { "id": "c", "start": 4.0, "end": 5.0, "text": "default" }
        ]));
        assert_eq!(
            cues(&project),
            [
                cue(1000, 2200, "slow"),
                cue(2200, 3000, "none"),
                cue(4000, 5150, "default")
            ]
        );
        project.captions.as_mut().unwrap().settings.fade_duration = 0.0;
        assert_eq!(cues(&project)[2], cue(4000, 5000, "default"));
    }

    #[test]
    fn hidden_fillers_and_word_lingers_match_the_renderer() {
        let mut project = track(serde_json::json!([
            { "id": "a", "start": 1.0, "end": 9.0, "text": "um so this",
              "words": [
                { "text": "um", "start": 1.0, "end": 1.4 },
                { "text": "so", "start": 1.5, "end": 1.8 },
                { "text": "this", "start": 2.0, "end": 9.0 }
              ] },
            { "id": "b", "start": 10.0, "end": 10.5, "text": "uh",
              "words": [{ "text": "uh", "start": 10.0, "end": 10.5 }] }
        ]));
        let settings = &mut project.captions.as_mut().unwrap().settings;
        settings.filler_language = Some("en".into());
        let linger = (2.0 + f64::from(MAX_CAPTION_WORD_DURATION) + 0.15) * 1000.0;
        assert_eq!(
            cues(&project),
            [cue(1500, linger.round() as u64, "so this")]
        );

        project
            .captions
            .as_mut()
            .unwrap()
            .settings
            .show_filler_words = true;
        assert_eq!(cues(&project).len(), 2);
        assert_eq!(cues(&project)[0].text, "um so this");
    }

    #[test]
    fn timings_follow_cuts_speed_and_holds_of_the_edited_video() {
        let mut project = project(
            serde_json::json!({
                "segments": [
                    { "start": 0.0, "end": 4.0, "timescale": 2.0 },
                    { "start": 6.0, "end": 10.0, "timescale": 1.0 }
                ],
                "zoomSegments": [],
                "textSegments": [{ "start": 2.0, "end": 3.0, "layout": "fullscreen" }]
            }),
            serde_json::json!({ "enabled": true }),
        );
        project.captions.as_mut().unwrap().segments = serde_json::from_value(serde_json::json!([
            { "id": "fast", "start": 1.0, "end": 3.0, "text": "fast" },
            { "id": "gone", "start": 4.5, "end": 5.5, "text": "cut" },
            { "id": "late", "start": 7.0, "end": 8.0, "text": "after the card" }
        ]))
        .unwrap();
        cap_project::synchronize_captions(&mut project, &[10.0]);
        assert_eq!(
            cues(&project),
            [cue(500, 1650, "fast"), cue(4000, 5150, "after the card")]
        );
        assert!(cues(&ProjectConfiguration::default()).is_empty());
    }

    #[test]
    fn two_hours_of_captions_export_quickly_with_long_timestamps() {
        let segments: Vec<serde_json::Value> = (0..4_000)
            .map(|index| {
                let start = index as f64 * 1.9;
                serde_json::json!({ "id": format!("s{index}"), "start": start, "end": start + 1.5, "text": format!("caption {index}") })
            })
            .collect();
        let mut project = track(serde_json::Value::Array(segments));
        project.timeline.as_mut().unwrap().segments[0].end = 7_700.0;
        let started = std::time::Instant::now();
        let cues = cues(&project);
        let text = format(&cues, CaptionFormat::Vtt);
        let elapsed = started.elapsed();
        assert_eq!(cues.len(), 4_000);
        assert!(text.contains("4000\n02:06:38.100 --> 02:06:39.750\ncaption 3999\n"));
        assert!(elapsed < std::time::Duration::from_secs(1), "{elapsed:?}");
    }
}
