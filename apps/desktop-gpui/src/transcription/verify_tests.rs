//! cap-verify oracles for caption generation, with a fake transcriber in
//! place of Whisper/Parakeet (no model download):
//!
//! - `fake_transcriber_*`: the real project audio extraction
//!   ([`transcribe_project_with`]) feeds a fake engine that hears the
//!   fixture's audio markers in the 16 kHz WAV and returns Parakeet-style
//!   timed tokens (one word per marker, some followed by a punctuation token
//!   and empty tokens). Every word must sit at its source time on the
//!   concatenated recordings, and the caption segments built by the Parakeet
//!   path ([`caption_segments_from_tokens`]) must match the reference
//!   segmentation below. Multi-segment Studio projects with per-track start
//!   offsets, legacy single-segment Studio projects, and Instant projects
//!   (refused: Instant recordings are transcribed by the web app).
//! - `segmentation_*`: random token streams through the Parakeet path
//!   against the reference segmentation.
//!
//! Reference segmentation (the documented caption rules, written for the
//! test):
//! - Empty tokens are dropped; a token starting with attaching punctuation
//!   (`,.!?;:%)]}'’` and their CJK forms) joins the previous word and extends
//!   its end. Word ends are clamped to `start + 2.5 s`.
//! - Words are grouped six to a caption; a caption whose last word is weak
//!   (one letter, or a short function word such as "of", "to", "is") takes
//!   more words, up to eight; when one or two words would be left over and
//!   the first of them is weak, they join the last caption. Pauses do not
//!   split captions.
//! - A caption spans its first word's start to its last word's end; its text
//!   joins the words with spaces, except before attaching punctuation; ids
//!   are `segment-<n>`.

use cap_verify::{
    audio_code::{self, AudioSource, MARKER_SECS},
    catalog,
    fixture::{self, AudioTrackSpec, FixtureSpec, Rng, SegmentSpec, Timing, VideoTrackSpec},
    media,
    report::{self, Case, Tier},
};

use cap_rendering::Video;

use super::*;

const MAX_WORD_SECS: f32 = 2.5;
const WORD_TOLERANCE_SECS: f64 = 0.0015;
const MARKER_RATE: u32 = 16_000;

fn finish(case: Case) {
    for note in &case.notes {
        eprintln!("[cap-verify]   {}: {note}", case.id);
    }
    if let Err(message) = report::settle(case) {
        panic!("{message}");
    }
}

const ATTACHING: &str = ",.!?;:%)]}'’、。！？；：，";
const WEAK: [&str; 20] = [
    "an", "as", "at", "be", "by", "do", "he", "if", "in", "is", "it", "me", "my", "of", "on", "or",
    "so", "to", "up", "we",
];

fn attaches(text: &str) -> bool {
    text.trim()
        .chars()
        .next()
        .is_some_and(|c| ATTACHING.contains(c))
}

fn weak(text: &str) -> bool {
    let letters: String = text
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    letters.chars().count() <= 1 || WEAK.contains(&letters.as_str())
}

fn reference_words(tokens: &[CaptionWord]) -> Vec<CaptionWord> {
    let mut words: Vec<CaptionWord> = Vec::new();
    for token in tokens {
        let text = token.text.trim();
        if text.is_empty() {
            continue;
        }
        match words.last_mut() {
            Some(previous) if attaches(text) => {
                previous.text.push_str(text);
                previous.end = token.end;
            }
            _ => words.push(CaptionWord {
                text: text.to_string(),
                start: token.start,
                end: token.end,
            }),
        }
    }
    for word in &mut words {
        word.end = word.end.min(word.start + MAX_WORD_SECS);
    }
    words
}

fn reference_text(words: &[CaptionWord]) -> String {
    let mut text = String::new();
    for word in words {
        if !text.is_empty() && !attaches(&word.text) {
            text.push(' ');
        }
        text.push_str(word.text.trim());
    }
    text
}

fn reference_segments(tokens: &[CaptionWord]) -> Vec<CaptionSegment> {
    let words = reference_words(tokens);
    let mut groups: Vec<&[CaptionWord]> = Vec::new();
    let mut rest = &words[..];
    while !rest.is_empty() {
        if rest.len() <= 6 {
            groups.push(rest);
            break;
        }
        let mut take = 6;
        while take < 8 && take < rest.len() && weak(&rest[take - 1].text) {
            take += 1;
        }
        let left = rest.len() - take;
        if (1..3).contains(&left) && weak(&rest[take].text) {
            take = rest.len();
        }
        groups.push(&rest[..take]);
        rest = &rest[take..];
    }
    groups
        .into_iter()
        .enumerate()
        .map(|(i, group)| CaptionSegment {
            id: format!("segment-{i}"),
            start: group[0].start,
            end: group[group.len() - 1].end,
            text: reference_text(group),
            words: group.to_vec(),
        })
        .collect()
}

fn describe(segment: &CaptionSegment) -> String {
    format!(
        "{} {:.3}-{:.3} \"{}\"",
        segment.id, segment.start, segment.end, segment.text
    )
}

/// Differences between the engine's caption segments and the reference's,
/// with times compared to `tolerance` seconds.
fn compare_segments(
    product: &[CaptionSegment],
    reference: &[CaptionSegment],
    tolerance: f64,
) -> Vec<String> {
    let close = |a: f32, b: f32| (f64::from(a) - f64::from(b)).abs() <= tolerance;
    let mut problems = Vec::new();
    if product.len() != reference.len() {
        problems.push(format!(
            "{} caption segments, the reference has {}",
            product.len(),
            reference.len()
        ));
    }
    for (p, r) in product.iter().zip(reference) {
        let same = p.id == r.id
            && p.text == r.text
            && close(p.start, r.start)
            && close(p.end, r.end)
            && p.words.len() == r.words.len()
            && p.words
                .iter()
                .zip(&r.words)
                .all(|(a, b)| a.text == b.text && close(a.start, b.start) && close(a.end, b.end));
        if !same {
            problems.push(format!("engine {}, reference {}", describe(p), describe(r)));
        }
    }
    problems
}

fn marker_word(source: AudioSource, index: u32) -> String {
    format!("{}{index}", source.name())
}

/// Parakeet-style tokens for the markers heard in `audio_path`: one word per
/// marker; every third word is followed by a "," token and an empty token.
fn fake_tokens(audio_path: &Path) -> Result<Vec<CaptionWord>, String> {
    let audio = media::decode_audio(audio_path, Some(MARKER_RATE))
        .map_err(|e| format!("fake transcriber could not read the WAV: {e}"))?;
    let mono = audio.mono();
    let mut heard: Vec<(f64, String)> = [AudioSource::Mic, AudioSource::System]
        .into_iter()
        .flat_map(|source| {
            audio_code::locate_markers(&mono, MARKER_RATE, source)
                .into_iter()
                .filter_map(move |m| {
                    Some((
                        audio.start_secs + m.time_secs,
                        marker_word(source, m.index?),
                    ))
                })
        })
        .collect();
    heard.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut tokens = Vec::new();
    for (i, (time, text)) in heard.into_iter().enumerate() {
        let end = time + MARKER_SECS;
        tokens.push(CaptionWord {
            text: format!(" {text}"),
            start: time as f32,
            end: end as f32,
        });
        if i % 3 == 2 {
            tokens.push(CaptionWord {
                text: ",".into(),
                start: end as f32,
                end: (end + 0.01) as f32,
            });
            tokens.push(CaptionWord {
                text: " ".into(),
                start: (end + 0.01) as f32,
                end: (end + 0.02) as f32,
            });
        }
    }
    Ok(tokens)
}

/// Expected takes of a fixture project: display duration, (audio file,
/// source, start time) per track, latest track start.
type Takes = Vec<(f64, Vec<(PathBuf, AudioSource, f64)>, f64)>;

/// Where each marker must be heard: a track sample at file time `m`
/// happened at `track start + m` on the recording clock; a take's
/// transcription time 0 is its latest track start and takes follow each
/// other by display duration (as the container reports it). Returns
/// `(word, time)` sorted by time.
fn expected_marker_words(project: &Path, takes: &Takes) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    let mut take_start = 0.0;
    for (display_duration, tracks, latest) in takes {
        for (path, source, start_time) in tracks {
            let decoded = media::decode_audio(&project.join(path), Some(48_000))
                .expect("decode source audio");
            for marker in audio_code::locate_markers(&decoded.mono(), 48_000, *source) {
                let Some(index) = marker.index else { continue };
                let t = start_time + decoded.start_secs + marker.time_secs - latest;
                if t >= 0.0 && t + MARKER_SECS <= *display_duration {
                    out.push((marker_word(*source, index), take_start + t));
                }
            }
        }
        take_start += display_duration;
    }
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out
}

fn multi_segment_takes(project: &Path, spec: &FixtureSpec) -> Takes {
    let meta = RecordingMeta::load_for_project(project).expect("meta");
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        panic!("multi-segment fixture");
    };
    inner
        .segments
        .iter()
        .zip(&spec.segments)
        .map(|(segment, seg_spec)| {
            let display = Video::new(segment.display.path.to_path(project), 0.0)
                .expect("display")
                .duration;
            let mut tracks = Vec::new();
            let mut starts = vec![seg_spec.display.start_time];
            for (meta, spec) in [
                (&segment.mic, &seg_spec.mic),
                (&segment.system_audio, &seg_spec.system_audio),
            ] {
                if let (Some(meta), Some(spec)) = (meta, spec) {
                    tracks.push((
                        PathBuf::from(meta.path.as_str()),
                        spec.source,
                        spec.start_time,
                    ));
                    starts.push(spec.start_time);
                }
            }
            let latest = starts.into_iter().fold(f64::NEG_INFINITY, f64::max);
            (display, tracks, latest)
        })
        .collect()
}

fn takes_fixture() -> FixtureSpec {
    let screen = |duration: f64, start_time: f64| {
        let mut v = VideoTrackSpec::new(
            catalog::SCREEN_W,
            catalog::SCREEN_H,
            30,
            Timing::Constant { duration },
        );
        v.start_time = start_time;
        v
    };
    let audio = |source: AudioSource, duration: f64, start_time: f64| AudioTrackSpec {
        source,
        sample_rate: 48_000,
        channels: if source == AudioSource::System { 2 } else { 1 },
        duration,
        start_time,
    };
    FixtureSpec {
        name: "captions-takes".into(),
        segments: vec![
            SegmentSpec {
                display: screen(5.0, 0.05),
                camera: None,
                mic: Some(audio(AudioSource::Mic, 5.0, 0.25)),
                system_audio: Some(audio(AudioSource::System, 5.2, -0.1)),
            },
            SegmentSpec {
                display: screen(4.0, 0.0),
                camera: None,
                mic: Some(audio(AudioSource::Mic, 4.0, 0.0)),
                system_audio: None,
            },
        ],
    }
}

/// Runs the real extraction with the fake engine and checks words and
/// segments.
fn check_project(case: &mut Case, project: &Path, takes: &Takes) {
    let mut tokens = Vec::new();
    let result = transcribe_project_with(
        project,
        None,
        &takes.iter().map(|take| take.0).collect::<Vec<_>>(),
        |audio_path| {
            tokens = fake_tokens(audio_path)?;
            Ok(caption_segments_from_tokens(tokens.clone()))
        },
    );
    let segments = match result {
        Ok(segments) => segments,
        Err(e) => {
            case.problem("error", format!("transcription failed: {e}"));
            return;
        }
    };
    let expected = expected_marker_words(project, takes);
    let words: Vec<&CaptionWord> = segments.iter().flat_map(|s| &s.words).collect();
    let mut problems = Vec::new();
    let mut worst = 0.0f64;
    for (text, time) in &expected {
        let hits: Vec<&&CaptionWord> = words
            .iter()
            .filter(|w| {
                w.text.trim_end_matches(',') == text.as_str()
                    && (f64::from(w.start) - time).abs() < 0.05
            })
            .collect();
        match hits.as_slice() {
            [w] => {
                let error = f64::from(w.start) - time;
                worst = worst.max(error.abs());
                if error.abs() > WORD_TOLERANCE_SECS {
                    problems.push(format!("{text} at {:.4}s, expected {time:.4}s", w.start));
                }
            }
            [] => problems.push(format!("{text} missing (expected at {time:.4}s)")),
            _ => problems.push(format!("{text} heard {} times", hits.len())),
        }
    }
    if words.len() != expected.len() {
        problems.push(format!(
            "{} words, {} expected",
            words.len(),
            expected.len()
        ));
    }
    if expected.len() < 8 {
        problems.push(format!("only {} reference words", expected.len()));
    }
    if problems.is_empty() {
        case.note(format!(
            "{} words at their source times (worst {:.3} ms)",
            words.len(),
            worst * 1000.0
        ));
    } else {
        case.problem(
            "caption-words",
            format!(
                "{} word problems (first: {})",
                problems.len(),
                problems
                    .iter()
                    .take(4)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
        );
    }
    let segment_problems = compare_segments(&segments, &reference_segments(&tokens), 1e-6);
    if segment_problems.is_empty() {
        case.note(format!(
            "{} caption segments match the reference",
            segments.len()
        ));
    } else {
        case.problem(
            "caption-segments",
            format!(
                "{} segment problems (first: {})",
                segment_problems.len(),
                segment_problems[0]
            ),
        );
    }
}

#[test]
fn fake_transcriber_multi_segment_studio() {
    let id = "captions/app/transcribe/studio-takes";
    if !report::selected(id) {
        return;
    }
    let spec = takes_fixture();
    let project = fixture::ensure_fixture(&spec, fixture::write_fixture).expect("fixture");
    let mut case = Case::new(id);
    let takes = multi_segment_takes(&project, &spec);
    check_project(&mut case, &project, &takes);
    finish(case);
}

#[test]
fn fake_transcriber_single_segment_studio() {
    let id = "captions/app/transcribe/studio-single-segment";
    if !report::selected(id) {
        return;
    }
    let spec = catalog::basic(report::tier());
    let source = fixture::ensure_fixture(&spec, fixture::write_fixture).expect("fixture");
    let dir = tempfile::tempdir().expect("temp dir");
    let project = dir.path().join("single.cap");
    let segment_dir = project.join("content");
    std::fs::create_dir_all(&segment_dir).expect("mkdir");
    let meta = RecordingMeta::load_for_project(&source).expect("meta");
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        panic!("multi-segment fixture");
    };
    let segment = &inner.segments[0];
    let mic = segment.mic.as_ref().expect("mic");
    for (from, to) in [
        (segment.display.path.as_str(), "content/display.mp4"),
        (mic.path.as_str(), "content/audio-input.ogg"),
    ] {
        std::fs::copy(source.join(from), project.join(to)).expect("copy track");
    }
    let single = serde_json::json!({
        "pretty_name": "single",
        "display": { "path": "content/display.mp4", "fps": 30 },
        "audio": { "path": "content/audio-input.ogg" }
    });
    std::fs::write(
        project.join("recording-meta.json"),
        serde_json::to_string(&single).expect("meta json"),
    )
    .expect("write meta");
    let mut case = Case::new(id);
    match RecordingMeta::load_for_project(&project) {
        Ok(meta)
            if matches!(
                meta.studio_meta(),
                Some(StudioRecordingMeta::SingleSegment { .. })
            ) => {}
        other => case.problem(
            "error",
            format!(
                "the single-segment project did not load as one: {:?}",
                other.err()
            ),
        ),
    }
    let display = Video::new(project.join("content/display.mp4"), 0.0)
        .expect("display")
        .duration;
    let takes = vec![(
        display,
        vec![(
            PathBuf::from("content/audio-input.ogg"),
            AudioSource::Mic,
            0.0,
        )],
        0.0,
    )];
    check_project(&mut case, &project, &takes);
    finish(case);
}

#[test]
fn instant_project_is_refused() {
    let id = "captions/app/transcribe/instant";
    if !report::selected(id) {
        return;
    }
    let dir = tempfile::tempdir().expect("temp dir");
    let project = dir.path().join("instant.cap");
    std::fs::create_dir_all(project.join("content")).expect("mkdir");
    let meta = serde_json::json!({
        "pretty_name": "instant",
        "fps": 30,
        "sample_rate": 48000
    });
    std::fs::write(
        project.join("recording-meta.json"),
        serde_json::to_string(&meta).expect("meta json"),
    )
    .expect("write meta");
    let mut case = Case::new(id);
    match RecordingMeta::load_for_project(&project) {
        Ok(meta) if matches!(meta.inner, cap_project::RecordingMetaInner::Instant(_)) => {}
        other => case.problem(
            "error",
            format!("the Instant project did not load as one: {:?}", other.err()),
        ),
    }
    let mut called = false;
    let result = transcribe_project_with(&project, None, &[], |_| {
        called = true;
        Ok(Vec::new())
    });
    match result {
        Err(message) if !called && message.contains("Only studio recordings") => {
            case.note(format!("refused before the engine ran: {message}"));
        }
        other => case.problem(
            "error",
            format!("Instant project: engine called {called}, result {other:?}"),
        ),
    }
    finish(case);
}

const ASCII_WORDS: [&str; 22] = [
    "hello", "world", "is", "a", "river", "cloud", "it", "to", "so", "screen", "record", "of",
    "we", "on", "capture", "edit", "timeline", "in", "up", "my", "an", "I",
];
/// Accented and CJK words, and "à", a one-letter (weak) French preposition
/// outside ASCII.
const UNICODE_WORDS: [&str; 5] = ["über", "café", "日本", "à", "ça"];
const PUNCTUATION: [&str; 9] = [",", ".", "?", "!", "'s", "%", "。", "、", ")"];

fn random_tokens(rng: &mut Rng, unicode: bool) -> Vec<CaptionWord> {
    let mut tokens = Vec::new();
    let mut t = rng.f64() * 0.5;
    for _ in 0..rng.range(1, 60) {
        let length = if rng.range(0, 14) == 0 {
            3.0 + rng.f64() * 5.0
        } else {
            0.05 + rng.f64() * 0.6
        };
        let text = match rng.range(0, 9) {
            0 | 1 => PUNCTUATION[rng.range(0, PUNCTUATION.len() as u64 - 1) as usize].to_string(),
            2 => [" ", "", "  "][rng.range(0, 2) as usize].to_string(),
            3 if unicode => {
                format!(
                    " {}",
                    UNICODE_WORDS[rng.range(0, UNICODE_WORDS.len() as u64 - 1) as usize]
                )
            }
            _ => format!(
                " {}",
                ASCII_WORDS[rng.range(0, ASCII_WORDS.len() as u64 - 1) as usize]
            ),
        };
        tokens.push(CaptionWord {
            text,
            start: t as f32,
            end: (t + length) as f32,
        });
        t += length
            + match rng.range(0, 3) {
                0 => 0.0,
                1 => rng.f64() * 0.3,
                2 => rng.f64() * 1.0,
                _ => rng.f64() * 8.0,
            };
    }
    tokens
}

fn segmentation_case(id: &str, unicode: bool) {
    if !report::selected(id) {
        return;
    }
    let mut case = Case::new(id);
    let seeds = match report::tier() {
        Tier::Fast => 2000,
        Tier::Full => 50_000,
    };
    let (mut failed, mut segments, mut empty) = (0, 0usize, 0);
    for seed in 0..seeds {
        let tokens = random_tokens(
            &mut Rng::new(0x5E6_0000 ^ (seed << 1) ^ u64::from(unicode)),
            unicode,
        );
        let reference = reference_segments(&tokens);
        let product = caption_segments_from_tokens(tokens.clone());
        if product.is_empty() {
            empty += 1;
        }
        segments += product.len();
        let problems = compare_segments(&product, &reference, 0.0);
        if !problems.is_empty() {
            failed += 1;
            if failed <= 3 {
                case.problem(
                    "caption-segments",
                    format!(
                        "seed {seed}: {} problems (first: {}); tokens {:?}",
                        problems.len(),
                        problems[0],
                        tokens.iter().map(|t| t.text.as_str()).collect::<Vec<_>>()
                    ),
                );
            }
        }
    }
    case.note(format!(
        "{seeds} token streams, {segments} segments, {empty} without speech, {failed} failed"
    ));
    finish(case);
}

#[test]
fn segmentation_matches_reference() {
    segmentation_case("captions/app/segmentation/ascii", false);
}

#[test]
fn segmentation_matches_reference_unicode() {
    segmentation_case("captions/app/segmentation/unicode", true);
}

#[test]
fn trimmed_transcription_extracts_only_used_audio_and_restores_source_times() {
    let spec = takes_fixture();
    let project = fixture::ensure_fixture(&spec, fixture::write_fixture).expect("fixture");
    let takes = multi_segment_takes(&project, &spec);
    let durations: Vec<f64> = takes.iter().map(|take| take.0).collect();
    for (clips, expected_ranges, expected_starts) in [
        (
            serde_json::json!([
                {"recordingSegment": 0, "start": 1.0, "end": 3.0, "timescale": 2.0}
            ]),
            vec![1.0..3.0],
            vec![0.125],
        ),
        (
            serde_json::json!([
                {"recordingSegment": 1, "start": 1.0, "end": 3.0, "timescale": 0.5},
                {"recordingSegment": 0, "start": 3.0, "end": 4.0, "timescale": 2.0},
                {"recordingSegment": 0, "start": 0.5, "end": 1.5, "timescale": 1.0},
                {"recordingSegment": 0, "start": 1.0, "end": 2.0, "timescale": 1.0},
                {"recordingSegment": 0, "start": 3.0, "end": 4.0, "timescale": 1.0}
            ]),
            vec![0.5..2.0, 3.0..4.0, durations[0] + 1.0..durations[0] + 3.0],
            vec![0.5, 4.125, 4.75, 6.75],
        ),
        (
            serde_json::json!([
                {"recordingSegment":0,"start":4.0,"end":durations[0],"timescale":1.0},
                {"recordingSegment":1,"start":0.0,"end":1.0,"timescale":1.0}
            ]),
            vec![4.0..durations[0] + 1.0],
            vec![0.25],
        ),
    ] {
        let timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": clips, "zoomSegments": []
        }))
        .unwrap();
        let mut called = 0;
        let segments = transcribe_project_with(&project, Some(&timeline), &durations, |path| {
            let expected_duration: f64 = expected_ranges
                .iter()
                .map(|range| range.end - range.start)
                .sum();
            let audio = media::decode_audio(path, Some(MARKER_RATE)).unwrap();
            let duration = audio.mono().len() as f64 / f64::from(MARKER_RATE);
            assert!(
                (duration - expected_duration).abs() < 0.002,
                "extracted {duration}s, expected {expected_duration}s"
            );
            called += 1;
            let mut offset = 0.0;
            Ok(expected_ranges
                .iter()
                .map(|range| {
                    let start = offset + 0.25;
                    let end = offset + 0.5;
                    offset += (range.end - range.start) as f32;
                    CaptionSegment {
                        id: "segment-0".into(),
                        start,
                        end,
                        text: "word".into(),
                        words: vec![CaptionWord {
                            text: "word".into(),
                            start,
                            end,
                        }],
                    }
                })
                .collect())
        })
        .unwrap();
        assert_eq!(called, 1);
        assert_eq!(segments.len(), expected_ranges.len());
        for (segment, range) in segments.iter().zip(expected_ranges) {
            assert!((f64::from(segment.start) - range.start - 0.25).abs() < 1e-5);
            assert!((f64::from(segment.end) - range.start - 0.5).abs() < 1e-5);
            assert_eq!(segment.words[0].start, segment.start);
            assert_eq!(segment.words[0].end, segment.end);
        }
        let ids: std::collections::HashSet<_> =
            segments.iter().map(|segment| &segment.id).collect();
        assert_eq!(ids.len(), segments.len());
        let tracks = derive_caption_track_segments(&segments, &timeline, &durations);
        assert_eq!(tracks.len(), expected_starts.len());
        for (track, expected) in tracks.iter().zip(expected_starts) {
            assert!((track.start - expected).abs() < 1e-5);
        }
    }
}

#[test]
fn trimmed_sources_match_full_audio_with_positive_and_negative_offsets() {
    let spec = takes_fixture();
    let project = fixture::ensure_fixture(&spec, fixture::write_fixture).unwrap();
    let meta = RecordingMeta::load_for_project(&project).unwrap();
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        panic!("studio")
    };
    let segment = &inner.segments[0];
    for audio in [
        segment.mic.as_ref().unwrap(),
        segment.system_audio.as_ref().unwrap(),
    ] {
        let path = meta.path(&audio.path);
        let decoded = cap_audio::AudioData::from_file(&path).unwrap();
        for offset_secs in [-0.4, 0.3] {
            let full = cap_editor::assemble_transcription_audio(
                &[TranscriptionAudioTake {
                    display_duration_secs: 5.0,
                    sources: vec![TranscriptionAudioSource {
                        samples: decoded.samples().to_vec(),
                        channels: usize::from(decoded.channels()),
                        offset_secs,
                    }],
                }],
                DECODE_SAMPLE_RATE,
            )
            .unwrap();
            for range in [0.0..1.0, 1.25..2.5, 3.0..4.0] {
                let source =
                    decode_transcription_source(&path, offset_secs, range.clone()).unwrap();
                let trimmed = cap_editor::assemble_transcription_audio(
                    &[TranscriptionAudioTake {
                        display_duration_secs: range.end - range.start,
                        sources: vec![source],
                    }],
                    DECODE_SAMPLE_RATE,
                )
                .unwrap();
                let start = (range.start * f64::from(DECODE_SAMPLE_RATE)).round() as usize;
                let reference = &full[start..start + trimmed.len()];
                let worst = trimmed
                    .iter()
                    .zip(reference)
                    .fold(0.0_f32, |worst, (a, b)| worst.max((a - b).abs()));
                assert!(
                    worst < 0.001,
                    "offset {offset_secs}, range {range:?}, worst sample error {worst}"
                );
            }
        }
    }
}

#[test]
fn transcription_keeps_speech_after_empty_ranges_and_cleans_up_on_failure() {
    let spec = takes_fixture();
    let project = fixture::ensure_fixture(&spec, fixture::write_fixture).unwrap();
    let takes = multi_segment_takes(&project, &spec);
    let durations: Vec<_> = takes.iter().map(|take| take.0).collect();
    let timeline = serde_json::from_value(serde_json::json!({"segments": [
        {"start":0.0,"end":1.0,"timescale":1.0},
        {"start":3.0,"end":4.0,"timescale":1.0}
    ], "zoomSegments": []}))
    .unwrap();
    let mut calls = 0;
    let mut temporary = PathBuf::new();
    let result = transcribe_project_with(&project, Some(&timeline), &durations, |path| {
        temporary = path.to_path_buf();
        calls += 1;
        Ok(caption_segments_from_tokens([CaptionWord {
            text: "speech".into(),
            start: 1.1,
            end: 1.2,
        }]))
    })
    .unwrap();
    assert_eq!(calls, 1);
    assert!((result[0].words[0].start - 3.1).abs() < 1e-5);
    assert!(!temporary.parent().unwrap().exists());
    let error = transcribe_project_with(&project, Some(&timeline), &durations, |path| {
        temporary = path.to_path_buf();
        Err("test engine failure".into())
    })
    .unwrap_err();
    assert_eq!(error, "test engine failure");
    assert!(!temporary.parent().unwrap().exists());
    let empty = transcribe_project_with(&project, Some(&timeline), &durations, |_| Ok(Vec::new()))
        .unwrap_err();
    assert_eq!(empty, "No speech detected in the audio");
    assert!(caption_segments_from_tokens(Vec::new()).is_empty());
    let empty_timeline =
        serde_json::from_value(serde_json::json!({"segments":[],"zoomSegments":[]})).unwrap();
    let error = transcribe_project_with(&project, Some(&empty_timeline), &durations, |_| {
        panic!("an empty timeline must not run the model")
    })
    .unwrap_err();
    assert!(error.contains("No audio sources"));
}

#[test]
fn source_timestamps_restore_words_in_two_ranges() {
    let offsets = [
        TranscriptionAudioOffset {
            concatenated_start: 0.0,
            source_start: 10.0,
            length: 2.0,
        },
        TranscriptionAudioOffset {
            concatenated_start: 2.0,
            source_start: 20.0,
            length: 3.0,
        },
    ];
    let segments = restore_source_timestamps(
        caption_segments_from_tokens([
            CaptionWord {
                text: "first".into(),
                start: 0.25,
                end: 0.5,
            },
            CaptionWord {
                text: "second".into(),
                start: 2.25,
                end: 2.5,
            },
        ]),
        &offsets,
    );
    assert_eq!(segments.len(), 1);
    let segment = &segments[0];
    assert_eq!((segment.start, segment.end), (10.25, 20.5));
    assert_eq!(
        (segment.words[0].start, segment.words[0].end),
        (10.25, 10.5)
    );
    assert_eq!(
        (segment.words[1].start, segment.words[1].end),
        (20.25, 20.5)
    );
}

#[test]
fn source_timestamps_clamp_words_and_wordless_segments_at_junctions() {
    let offsets = [
        TranscriptionAudioOffset {
            concatenated_start: 0.0,
            source_start: 10.0,
            length: 2.0,
        },
        TranscriptionAudioOffset {
            concatenated_start: 2.0,
            source_start: 20.0,
            length: 3.0,
        },
    ];
    let mut segments = caption_segments_from_tokens([
        CaptionWord {
            text: "across".into(),
            start: 1.75,
            end: 2.25,
        },
        CaptionWord {
            text: "junction".into(),
            start: 2.0,
            end: 2.25,
        },
    ]);
    segments.push(CaptionSegment {
        start: 1.75,
        end: 2.25,
        text: "no words".into(),
        ..Default::default()
    });
    let segments = restore_source_timestamps(segments, &offsets);
    assert_eq!(segments.len(), 2);
    assert_eq!(
        (segments[0].words[0].start, segments[0].words[0].end),
        (11.75, 12.0)
    );
    assert_eq!(
        (segments[0].words[1].start, segments[0].words[1].end),
        (20.0, 20.25)
    );
    assert_eq!((segments[0].start, segments[0].end), (11.75, 20.25));
    assert_eq!((segments[1].start, segments[1].end), (11.75, 12.0));
}

#[test]
fn source_timestamps_for_one_range_match_a_source_offset() {
    let offsets = [TranscriptionAudioOffset {
        concatenated_start: 0.0,
        source_start: 37.0,
        length: 4.0,
    }];
    let segments = caption_segments_from_tokens([CaptionWord {
        text: "word".into(),
        start: 0.25,
        end: 0.5,
    }]);
    let mut reference = segments.clone();
    for segment in &mut reference {
        segment.start += 37.0;
        segment.end += 37.0;
        for word in &mut segment.words {
            word.start += 37.0;
            word.end += 37.0;
        }
    }
    let segments = restore_source_timestamps(segments, &offsets);
    assert!(compare_segments(&segments, &reference, 0.0).is_empty());
}

#[test]
fn source_timestamps_with_empty_ranges_produce_no_captions() {
    let mut segments = caption_segments_from_tokens([CaptionWord {
        text: "word".into(),
        start: 0.25,
        end: 0.5,
    }]);
    segments.push(CaptionSegment {
        start: 0.25,
        end: 0.5,
        text: "no words".into(),
        ..Default::default()
    });
    assert!(restore_source_timestamps(segments, &[]).is_empty());
    assert!(restore_source_timestamps(Vec::new(), &[]).is_empty());
}
