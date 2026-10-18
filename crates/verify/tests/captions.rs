//! Captions oracle, with no transcription model anywhere:
//!
//! - `projection_*`: random source-timed captions (gaps, punctuation, words
//!   stretched across silences, text-only captions, style overrides) through
//!   random edit sequences (`edits.rs`) must project onto the output timeline
//!   exactly as the reference model below says (`derive_caption_track_segments`
//!   via `synchronize_captions`, the call the editor, export and render farm
//!   make).
//! - `legacy_migration`: output-timed captions from older projects are moved
//!   to source time on load; checked against the model and for round trips.
//! - `round_trip_on_disk`: captions, settings and overrides survive
//!   project-config.json and the legacy captions.json sidecar.
//! - `transcription_audio`: a fake transcriber hears the fixture's audio
//!   markers in the transcription input assembled the way the app does
//!   (per-take mic + system audio aligned by the clip offsets, takes
//!   concatenated by display duration) and returns one word per marker; every
//!   word must sit at its source time.
//! - `render_*`: exports with captions; every output frame must show exactly
//!   the caption the model puts there (identified against per-text glyph
//!   templates), or none.
//! - `editor_open`: opening a project in the editor engine migrates and
//!   re-projects stored captions as the model says.
//!
//! Reference model (documented rules of the caption projection, written for
//! the test):
//! - Source time is the recordings concatenated: clip `c` starts at the sum
//!   of the earlier clips' display durations.
//! - A word's end is clamped to `start + 2.5 s`; a caption with words ends at
//!   its last clamped word.
//! - Each caption is cut by every timeline segment, in timeline order: the
//!   part of each word inside the segment's source range (non-empty) is
//!   placed at `segment output start + (t - range start) / timescale` and
//!   moved past fullscreen-text holds (a range ending exactly at a hold ends
//!   before it). A piece spans its first to last word; its text joins the
//!   words with spaces, except before punctuation that attaches to the
//!   previous word. A caption without words maps its own range.
//! - A caption cut into several pieces gets ids `<id>::edl<n>`; pieces are
//!   sorted by output start (stable); style overrides follow the source id.
//! - Rendering: at output time `t` the first piece with
//!   `start <= t < min(end, last word start + 2.5)` is shown.

mod common;
mod edits;

use std::path::Path;

use cap_project::{
    CaptionSegment, CaptionSettings, CaptionTrackSegment, CaptionWord, CaptionsData,
    ProjectConfiguration, RecordingMeta, StudioRecordingMeta,
};
use cap_verify::{
    audio_code::{self, AudioSource, MARKER_SECS},
    catalog,
    fixture::{AudioTrackSpec, FixtureSpec, Rng, SegmentSpec, Timing, VideoTrackSpec},
    media,
    report::{self, Case, Tier},
    video_code::PixelSource,
};
use edits::{Op, OpMix, TimeModel};

const MAX_WORD_SECS: f64 = 2.5;
/// Projected times are stored as f32.
const TIME_TOLERANCE: f64 = 1e-4;
const WORD_TOLERANCE_SECS: f64 = 0.001;

/// Settles a case, printing its notes (the core report prints them only in
/// the JSON report).
fn settle(case: Case) -> Option<String> {
    for note in &case.notes {
        eprintln!("[cap-verify]   {}: {note}", case.id);
    }
    report::settle(case).err()
}

fn finish(case: Case) {
    if let Some(message) = settle(case) {
        panic!("{message}");
    }
}

fn seeds(fast: u64, full: u64) -> u64 {
    match report::tier() {
        Tier::Fast => fast,
        Tier::Full => full,
    }
}

fn attaches_to_previous(text: &str) -> bool {
    const ATTACHING: &str = ",.!?;:%)]}'’、。！？；：，";
    text.trim()
        .chars()
        .next()
        .is_some_and(|c| ATTACHING.contains(c))
}

fn join_words<'a>(words: impl IntoIterator<Item = &'a str>) -> String {
    let mut text = String::new();
    for word in words.into_iter().map(str::trim).filter(|w| !w.is_empty()) {
        if !text.is_empty() && !attaches_to_previous(word) {
            text.push(' ');
        }
        text.push_str(word);
    }
    text
}

#[derive(Clone, Debug, Default)]
struct Overrides {
    fade: Option<f32>,
    position: Option<String>,
    color: Option<String>,
    font_size: Option<u32>,
}

#[derive(Clone, Debug)]
struct Piece {
    id: String,
    start: f64,
    end: f64,
    text: String,
    words: Vec<(String, f64, f64)>,
    overrides: Overrides,
}

impl Piece {
    /// Where the renderer stops showing the piece.
    fn visible_end(&self) -> f64 {
        match self.words.last() {
            Some(w) => self.end.min(w.1 + MAX_WORD_SECS),
            None => self.end,
        }
    }
}

fn clip_starts(durations: &[f64]) -> Vec<f64> {
    let mut starts = vec![0.0];
    for d in durations {
        starts.push(starts.last().unwrap() + d);
    }
    starts
}

/// Projects source-timed captions through `config`'s edit list.
fn model_project(
    captions: &[CaptionSegment],
    config: &ProjectConfiguration,
    durations: &[f64],
) -> Vec<Piece> {
    let time = TimeModel::new(config);
    let starts = clip_starts(durations);
    let mut overrides: Vec<(String, Overrides)> = Vec::new();
    for t in &edits::timeline(config).caption_segments {
        let source = t.id.split("::edl").next().unwrap_or(&t.id).to_string();
        if !overrides.iter().any(|(id, _)| *id == source) {
            overrides.push((
                source,
                Overrides {
                    fade: t.fade_duration_override,
                    position: t.position_override.clone(),
                    color: t.color_override.clone(),
                    font_size: t.font_size_override,
                },
            ));
        }
    }
    let mut out = Vec::new();
    for caption in captions {
        let words: Vec<(String, f64, f64)> = caption
            .words
            .iter()
            .map(|w| {
                let start = f64::from(w.start);
                let end = f64::from(w.end).min(start + MAX_WORD_SECS);
                (w.text.clone(), start, end)
            })
            .collect();
        let mut pieces = Vec::new();
        for s in &time.segments {
            let lo = starts[s.clip as usize] + s.start;
            let hi = starts[s.clip as usize] + s.end;
            let place = |a: f64, b: f64| -> Option<(f64, f64)> {
                let (a, b) = (a.max(lo), b.min(hi));
                (a < b).then(|| {
                    (
                        time.to_output(s.out_start + (a - lo) / s.timescale),
                        time.to_output_end(s.out_start + (b - lo) / s.timescale),
                    )
                })
            };
            if words.is_empty() {
                let end = f64::from(caption.end);
                if let Some((a, b)) = place(f64::from(caption.start), end) {
                    pieces.push((a, b, caption.text.clone(), Vec::new()));
                }
                continue;
            }
            let placed: Vec<(String, f64, f64)> = words
                .iter()
                .filter_map(|(text, a, b)| place(*a, *b).map(|(a, b)| (text.clone(), a, b)))
                .collect();
            if let (Some(first), Some(last)) = (placed.first(), placed.last()) {
                let text = join_words(placed.iter().map(|w| w.0.as_str()));
                pieces.push((first.1, last.2, text, placed.clone()));
            }
        }
        let count = pieces.len();
        let source_overrides = overrides
            .iter()
            .find(|(id, _)| *id == caption.id)
            .map(|(_, o)| o.clone())
            .unwrap_or_default();
        for (i, (start, end, text, words)) in pieces.into_iter().enumerate() {
            out.push(Piece {
                id: if count == 1 {
                    caption.id.clone()
                } else {
                    format!("{}::edl{i}", caption.id)
                },
                start,
                end,
                text,
                words,
                overrides: source_overrides.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

/// Moves output-timed (legacy) captions to source time: a caption keeps
/// only if both ends map; unmappable words drop.
fn model_migrate(
    legacy: &[CaptionSegment],
    config: &ProjectConfiguration,
    durations: &[f64],
) -> Vec<CaptionSegment> {
    let time = TimeModel::new(config);
    let starts = clip_starts(durations);
    let to_source = |o: f32| time.output_to_source(f64::from(o), &starts);
    let mut out: Vec<CaptionSegment> = legacy
        .iter()
        .filter_map(|c| {
            Some(CaptionSegment {
                id: c.id.clone(),
                start: to_source(c.start)? as f32,
                end: to_source(c.end)? as f32,
                text: c.text.clone(),
                words: c
                    .words
                    .iter()
                    .filter_map(|w| {
                        Some(CaptionWord {
                            text: w.text.clone(),
                            start: to_source(w.start)? as f32,
                            end: to_source(w.end)? as f32,
                        })
                    })
                    .collect(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= TIME_TOLERANCE
}

fn describe(p: &Piece) -> String {
    format!("{} {:.4}-{:.4} \"{}\"", p.id, p.start, p.end, p.text)
}

fn describe_track(t: &CaptionTrackSegment) -> String {
    format!("{} {:.4}-{:.4} \"{}\"", t.id, t.start, t.end, t.text)
}

/// Indices of `starts` in output order, pieces starting together (within
/// the time tolerance) ordered by id: which of two pieces that start
/// together is listed first is not specified.
fn tie_order(items: &[(f64, &str)]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| items[a].0.total_cmp(&items[b].0));
    let mut i = 0;
    while i < order.len() {
        let mut j = i + 1;
        while j < order.len() && items[order[j]].0 - items[order[j - 1]].0 <= TIME_TOLERANCE {
            j += 1;
        }
        order[i..j].sort_by(|&a, &b| items[a].1.cmp(items[b].1));
        i = j;
    }
    order
}

/// Compares the engine's caption track with the model's pieces.
fn compare_track(product: &[CaptionTrackSegment], model: &[Piece]) -> Vec<String> {
    let product_order = tie_order(
        &product
            .iter()
            .map(|p| (p.start, p.id.as_str()))
            .collect::<Vec<_>>(),
    );
    let model_order = tie_order(
        &model
            .iter()
            .map(|p| (p.start, p.id.as_str()))
            .collect::<Vec<_>>(),
    );
    let product: Vec<&CaptionTrackSegment> = product_order.iter().map(|&i| &product[i]).collect();
    let model: Vec<&Piece> = model_order.iter().map(|&i| &model[i]).collect();
    let mut problems = Vec::new();
    if product.len() != model.len() {
        problems.push(format!(
            "{} caption track segments, the model expects {}",
            product.len(),
            model.len()
        ));
    }
    for (p, m) in product.iter().zip(&model) {
        let words_match = p.words.len() == m.words.len()
            && p.words.iter().zip(&m.words).all(|(a, b)| {
                a.text == b.0 && close(f64::from(a.start), b.1) && close(f64::from(a.end), b.2)
            });
        let overrides_match = p.fade_duration_override == m.overrides.fade
            && p.position_override == m.overrides.position
            && p.color_override == m.overrides.color
            && p.font_size_override == m.overrides.font_size;
        if p.id != m.id
            || !close(p.start, m.start)
            || !close(p.end, m.end)
            || p.text != m.text
            || !words_match
            || !overrides_match
        {
            problems.push(format!(
                "engine {}{}, model {}",
                describe_track(p),
                if overrides_match {
                    ""
                } else {
                    " (overrides differ)"
                },
                describe(m)
            ));
        }
    }
    problems
}

const VOCABULARY: [&str; 24] = [
    "hello", "world", "is", "a", "river", "cloud", "it", "to", "über", "café", "日本", "so",
    "screen", "record", "of", "we", "on", "capture", "edit", "timeline", "in", "up", "my", "an",
];
const PUNCTUATION: [&str; 6] = [",", ".", "?", "!", "'s", "%"];

fn random_captions(rng: &mut Rng, total: f64) -> Vec<CaptionSegment> {
    let mut captions = Vec::new();
    let mut t = rng.f64() * 0.5;
    while t < total + 1.0 {
        let id = format!("c{}", captions.len());
        if rng.range(0, 9) == 0 {
            let end = t + 0.2 + rng.f64() * 2.0;
            captions.push(CaptionSegment {
                id,
                start: t as f32,
                end: end as f32,
                text: format!("plain text {}", captions.len()),
                words: Vec::new(),
            });
            t = end + rng.f64() * 0.5;
            continue;
        }
        let mut words = Vec::new();
        for i in 0..rng.range(1, 8) {
            if i > 0 {
                t += match rng.range(0, 3) {
                    0 => 0.0,
                    1 => rng.f64() * 0.2,
                    2 => rng.f64() * 0.6,
                    _ => rng.f64() * 1.5,
                };
            }
            let length = if rng.range(0, 19) == 0 {
                3.0 + rng.f64() * 4.0
            } else {
                0.05 + rng.f64() * 0.6
            };
            let text = if i > 0 && rng.range(0, 5) == 0 {
                PUNCTUATION[rng.range(0, PUNCTUATION.len() as u64 - 1) as usize]
            } else {
                VOCABULARY[rng.range(0, VOCABULARY.len() as u64 - 1) as usize]
            };
            words.push(CaptionWord {
                text: text.to_string(),
                start: t as f32,
                end: (t + length) as f32,
            });
            t += length;
        }
        let start = words[0].start;
        let mut end = words.last().unwrap().end;
        if rng.range(0, 3) == 0 {
            end += (rng.f64() * 1.0) as f32;
        }
        captions.push(CaptionSegment {
            id,
            start,
            end,
            text: join_words(words.iter().map(|w| w.text.as_str())),
            words,
        });
        t += rng.f64() * 1.2;
    }
    captions
}

fn caption_settings() -> CaptionSettings {
    CaptionSettings {
        enabled: true,
        ..Default::default()
    }
}

fn set_captions(
    config: &mut ProjectConfiguration,
    captions: Vec<CaptionSegment>,
    source_timed: bool,
) {
    config.captions = Some(CaptionsData {
        segments: captions,
        settings: caption_settings(),
        source_timed,
    });
}

/// Style overrides on some current track pieces. `per_source` styles every
/// piece of a caption alike; otherwise pieces of one caption may differ and
/// the first piece's style is the one that survives re-projection.
fn random_overrides(rng: &mut Rng, config: &mut ProjectConfiguration, per_source: bool) {
    let timeline = config.timeline.as_mut().expect("timeline");
    let mut styled: Vec<(String, CaptionTrackSegment)> = Vec::new();
    for piece in &mut timeline.caption_segments {
        let source = cap_project::source_caption_id(&piece.id).to_string();
        if per_source && let Some((_, style)) = styled.iter().find(|(id, _)| *id == source) {
            piece.fade_duration_override = style.fade_duration_override;
            piece.position_override = style.position_override.clone();
            piece.color_override = style.color_override.clone();
            piece.font_size_override = style.font_size_override;
            continue;
        }
        if rng.range(0, 3) == 0 {
            piece.fade_duration_override = Some(rng.range(0, 5) as f32 / 10.0);
            piece.position_override = Some("top-center".into());
            piece.color_override = Some(format!("#{:06X}", rng.range(0, 0xFF_FFFF)));
            piece.font_size_override = Some(rng.range(12, 96) as u32);
        }
        styled.push((source, piece.clone()));
    }
}

fn projection_problems(
    base: &ProjectConfiguration,
    ops: &[Op],
    captions: &[CaptionSegment],
    durations: &[f64],
    override_seed: u64,
) -> Vec<String> {
    let mut config = base.clone();
    set_captions(&mut config, captions.to_vec(), true);
    cap_project::synchronize_captions(&mut config, durations);
    random_overrides(&mut Rng::new(override_seed), &mut config, false);
    for op in ops {
        edits::apply(&mut config, op);
    }
    let model = model_project(captions, &config, durations);
    cap_project::synchronize_captions(&mut config, durations);
    let mut problems = compare_track(&edits::timeline(&config).caption_segments, &model);
    let again = edits::timeline(&config).caption_segments.clone();
    cap_project::synchronize_captions(&mut config, durations);
    let after = &edits::timeline(&config).caption_segments;
    if serde_json::to_value(&again).ok() != serde_json::to_value(after).ok() {
        problems.push("re-synchronizing an unchanged project changed the caption track".into());
    }
    problems
}

fn projection_case(name: &str, mix: OpMix, seeds: u64) {
    let id = format!("captions/projection/{name}");
    if !report::selected(&id) {
        return;
    }
    let mut case = Case::new(&id);
    let (mut failed, mut pieces) = (0, 0usize);
    for seed in 0..seeds {
        let mut rng = Rng::new(0xCA97_0000 ^ (seed << 8) ^ name.len() as u64);
        let durations = edits::random_durations(&mut rng);
        let base = edits::base_config(&durations);
        let captions = random_captions(&mut rng, durations.iter().sum());
        let count = rng.range(0, 8) as usize;
        let ops = edits::random_sequence(&mut rng, &base, count, mix);
        let problems = projection_problems(&base, &ops, &captions, &durations, seed);
        pieces += model_project(&captions, &edits::replay(&base, &ops), &durations).len();
        if problems.is_empty() {
            continue;
        }
        failed += 1;
        if failed > 3 {
            continue;
        }
        let minimal = edits::shrink(&ops, |ops| {
            !projection_problems(&base, ops, &captions, &durations, seed).is_empty()
        });
        let minimal_problems = projection_problems(&base, &minimal, &captions, &durations, seed);
        case.problem("caption-track", format!(
            "seed {seed}: clips {durations:?}, {} captions, shrunk from {} to {} ops {minimal:?}: {} problems (first: {})",
            captions.len(),
            ops.len(),
            minimal.len(),
            minimal_problems.len(),
            minimal_problems.iter().take(3).cloned().collect::<Vec<_>>().join("; ")
        ));
    }
    case.note(format!(
        "{seeds} random caption sets and edit sequences, {pieces} projected pieces, {failed} failed"
    ));
    if failed > 3 {
        case.problem(
            "caption-track",
            format!("{failed} sequences failed in total"),
        );
    }
    finish(case);
}

#[test]
fn projection_cuts_speeds() {
    projection_case(
        "cuts-speeds",
        OpMix {
            transitions: false,
            holds: false,
        },
        seeds(1000, 20000),
    );
}

#[test]
fn projection_transitions() {
    projection_case(
        "transitions",
        OpMix {
            transitions: true,
            holds: false,
        },
        seeds(1000, 20000),
    );
}

#[test]
fn projection_holds() {
    projection_case(
        "holds",
        OpMix {
            transitions: false,
            holds: true,
        },
        seeds(1000, 20000),
    );
}

#[test]
fn projection_all() {
    projection_case(
        "all",
        OpMix {
            transitions: true,
            holds: true,
        },
        seeds(1000, 20000),
    );
}

/// Fullscreen text holds placed exactly where captions end or start (as when
/// a text card is snapped to a caption): a caption ending exactly at a hold
/// ends before it, one starting there starts after it, also when an earlier
/// hold has already moved the boundary.
#[test]
fn projection_hold_boundaries() {
    let id = "captions/projection/hold-boundaries";
    if !report::selected(id) {
        return;
    }
    let mut case = Case::new(id);
    let durations = [6.0];
    let mut config = edits::base_config(&durations);
    {
        let timeline = config.timeline.as_mut().expect("timeline");
        // Output time; the second hold starts at gapless 4.0 s.
        timeline
            .text_segments
            .push(edits::fullscreen_text(2.0, 3.0));
        timeline
            .text_segments
            .push(edits::fullscreen_text(5.0, 5.5));
    }
    let word = |text: &str, start: f32, end: f32| CaptionWord {
        text: text.into(),
        start,
        end,
    };
    let captions = vec![
        CaptionSegment {
            id: "ends-at-hold".into(),
            start: 1.0,
            end: 2.0,
            text: "apple river".into(),
            words: vec![word("apple", 1.0, 1.5), word("river", 1.5, 2.0)],
        },
        CaptionSegment {
            id: "starts-at-hold".into(),
            start: 2.0,
            end: 3.0,
            text: "cloud stone".into(),
            words: vec![word("cloud", 2.0, 2.5), word("stone", 2.5, 3.0)],
        },
        CaptionSegment {
            id: "text-only-ends-at-second-hold".into(),
            start: 3.5,
            end: 4.0,
            text: "maple tiger".into(),
            words: Vec::new(),
        },
    ];
    set_captions(&mut config, captions.clone(), true);
    cap_project::synchronize_captions(&mut config, &durations);
    let model = model_project(&captions, &config, &durations);
    let product = &edits::timeline(&config).caption_segments;
    let mut problems = compare_track(product, &model);
    // The documented outcome, written out: the model must agree with it.
    for (id, start, end) in [
        ("ends-at-hold", 1.0, 2.0),
        ("starts-at-hold", 3.0, 4.0),
        ("text-only-ends-at-second-hold", 4.5, 5.0),
    ] {
        if !model
            .iter()
            .any(|p| p.id == id && close(p.start, start) && close(p.end, end))
        {
            problems.push(format!("model has no piece {id} {start:.1}-{end:.1}"));
        }
    }
    if problems.is_empty() {
        case.note(format!("{} pieces at hold boundaries", model.len()));
    } else {
        case.problem(
            "caption-track",
            format!("{} problems: {}", problems.len(), problems.join("; ")),
        );
    }
    finish(case);
}

fn track_as_captions(track: &[CaptionTrackSegment]) -> Vec<CaptionSegment> {
    track
        .iter()
        .map(|t| CaptionSegment {
            id: t.id.clone(),
            start: t.start as f32,
            end: t.end as f32,
            text: t.text.clone(),
            words: t.words.clone(),
        })
        .collect()
}

fn migration_problems(
    base: &ProjectConfiguration,
    ops: &[Op],
    captions: &[CaptionSegment],
    durations: &[f64],
) -> Vec<String> {
    let mut config = edits::replay(base, ops);
    set_captions(&mut config, captions.to_vec(), true);
    cap_project::synchronize_captions(&mut config, durations);
    let mut shown = edits::timeline(&config).caption_segments.clone();
    // Captions ending exactly at the timeline end are covered by
    // `legacy_migration_caption_at_timeline_end`.
    let end = TimeModel::new(&config).duration();
    shown.retain(|t| (t.end - end).abs() > TIME_TOLERANCE);
    let legacy = track_as_captions(&shown);
    config
        .timeline
        .as_mut()
        .expect("timeline")
        .caption_segments
        .clear();
    set_captions(&mut config, legacy.clone(), false);
    let expected = model_migrate(&legacy, &config, durations);
    cap_project::synchronize_captions(&mut config, durations);
    let captions_data = config.captions.as_ref().expect("captions");
    let mut problems = Vec::new();
    if !captions_data.source_timed {
        problems.push("captions still marked output-timed after loading".into());
    }
    let migrated = &captions_data.segments;
    if migrated.len() != expected.len() {
        problems.push(format!(
            "{} captions after migration, the model expects {}",
            migrated.len(),
            expected.len()
        ));
    }
    for (a, b) in migrated.iter().zip(&expected) {
        let same = a.id == b.id
            && close(f64::from(a.start), f64::from(b.start))
            && close(f64::from(a.end), f64::from(b.end))
            && a.words.len() == b.words.len()
            && a.words.iter().zip(&b.words).all(|(x, y)| {
                x.text == y.text
                    && close(f64::from(x.start), f64::from(y.start))
                    && close(f64::from(x.end), f64::from(y.end))
            });
        if !same {
            problems.push(format!(
                "migrated {} {:.4}-{:.4}, model {} {:.4}-{:.4}",
                a.id, a.start, a.end, b.id, b.start, b.end
            ));
        }
    }
    problems.extend(compare_track(
        &edits::timeline(&config).caption_segments,
        &model_project(&expected, &config, durations),
    ));
    // A legacy caption inside one segment, away from transitions and holds,
    // must come back where it was.
    let time = TimeModel::new(&config);
    let track = &edits::timeline(&config).caption_segments;
    for piece in &shown {
        let inside = time.segments.iter().enumerate().any(|(k, s)| {
            let next_in = time.segments.get(k + 1).map_or(0.0, |n| n.transition_in);
            let lo = time.to_output(s.out_start + s.transition_in);
            let hi = time.to_output_end(s.out_start + s.duration - next_in);
            piece.start > lo + TIME_TOLERANCE
                && piece.end < hi - TIME_TOLERANCE
                && time.held_before(piece.end) == time.held_before(piece.start)
        });
        let clean = piece
            .words
            .iter()
            .all(|w| f64::from(w.end - w.start) < MAX_WORD_SECS);
        if inside
            && clean
            && !track.iter().any(|t| {
                t.text == piece.text && close(t.start, piece.start) && close(t.end, piece.end)
            })
        {
            problems.push(format!(
                "legacy caption {} did not come back in place after loading",
                describe_track(piece)
            ));
        }
    }
    problems
}

/// A legacy caption that ends exactly where the timeline ends (its last
/// word ran to the end of the recording) must survive loading.
#[test]
fn legacy_migration_caption_at_timeline_end() {
    let id = "captions/legacy-migration/ends-at-timeline-end";
    if !report::selected(id) {
        return;
    }
    let durations = [41.0 / 15.0, 82.0 / 15.0];
    let mut config = edits::base_config(&durations);
    common::add_transition(&mut config, 1, 0.2);
    let end = edits::timeline(&config).duration() as f32;
    let legacy = vec![CaptionSegment {
        id: "last".into(),
        start: end - 2.2,
        end,
        text: "until the end".into(),
        words: vec![
            CaptionWord {
                text: "until".into(),
                start: end - 2.2,
                end: end - 1.5,
            },
            CaptionWord {
                text: "the".into(),
                start: end - 1.5,
                end: end - 1.0,
            },
            CaptionWord {
                text: "end".into(),
                start: end - 1.0,
                end,
            },
        ],
    }];
    let expected = model_migrate(&legacy, &config, &durations);
    set_captions(&mut config, legacy, false);
    cap_project::synchronize_captions(&mut config, &durations);
    let mut case = Case::new(id);
    let migrated = &config.captions.as_ref().expect("captions").segments;
    if migrated.len() == expected.len() && expected.len() == 1 {
        case.note(format!(
            "caption ending at {end:.4}s kept at source {:.4}-{:.4}",
            migrated[0].start, migrated[0].end
        ));
    } else {
        case.problem(
            "caption-migration",
            format!(
                "a legacy caption ending at the {end:.4}s timeline end: {} captions after loading, the model keeps {}",
                migrated.len(),
                expected.len()
            ),
        );
    }
    finish(case);
}

#[test]
fn legacy_migration() {
    let id = "captions/legacy-migration";
    if !report::selected(id) {
        return;
    }
    let mut case = Case::new(id);
    let seeds = seeds(1000, 20000);
    let mut failed = 0;
    for seed in 0..seeds {
        let mut rng = Rng::new(0xCA97_1000 ^ (seed << 8));
        let durations = edits::random_durations(&mut rng);
        let base = edits::base_config(&durations);
        let captions = random_captions(&mut rng, durations.iter().sum());
        let count = rng.range(0, 8) as usize;
        let ops = edits::random_sequence(
            &mut rng,
            &base,
            count,
            OpMix {
                transitions: true,
                holds: true,
            },
        );
        if migration_problems(&base, &ops, &captions, &durations).is_empty() {
            continue;
        }
        failed += 1;
        if failed > 3 {
            continue;
        }
        let minimal = edits::shrink(&ops, |ops| {
            !migration_problems(&base, ops, &captions, &durations).is_empty()
        });
        let problems = migration_problems(&base, &minimal, &captions, &durations);
        case.problem("caption-migration", format!(
            "seed {seed}: clips {durations:?}, shrunk to ops {minimal:?}: {} problems (first: {})",
            problems.len(),
            problems
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    case.note(format!("{seeds} legacy projects migrated, {failed} failed"));
    if failed > 3 {
        case.problem(
            "caption-migration",
            format!("{failed} sequences failed in total"),
        );
    }
    finish(case);
}

fn styled_settings(rng: &mut Rng) -> CaptionSettings {
    CaptionSettings {
        enabled: true,
        font: ["System Sans-Serif", "System Serif", "System Monospace"][rng.range(0, 2) as usize]
            .into(),
        size: rng.range(12, 96) as u32,
        color: "#12AB34".into(),
        background_color: "#00C800".into(),
        background_opacity: rng.range(0, 100) as u32,
        position: "top-left".into(),
        italic: true,
        font_weight: 500,
        outline: true,
        outline_color: "#FF0000".into(),
        export_with_subtitles: true,
        highlight_color: "#0000FF".into(),
        fade_duration: 0.3,
        linger_duration: 0.7,
        word_transition_duration: 0.1,
        active_word_highlight: true,
        manual_position: Some(cap_project::XY::new(0.25, 0.75)),
        preset: "custom".into(),
        animation: "pop".into(),
        highlight_style: "pill".into(),
        uppercase: true,
    }
}

#[test]
fn round_trip_on_disk() {
    let id = "captions/round-trip";
    if !report::selected(id) {
        return;
    }
    let mut case = Case::new(id);
    let dir = common::scratch_dir(id);
    let seeds = seeds(20, 200);
    for seed in 0..seeds {
        let mut rng = Rng::new(0xCA97_2000 ^ seed);
        let durations = edits::random_durations(&mut rng);
        let base = edits::base_config(&durations);
        let ops = edits::random_sequence(
            &mut rng,
            &base,
            4,
            OpMix {
                transitions: true,
                holds: true,
            },
        );
        let mut config = edits::replay(&base, &ops);
        config.captions = Some(CaptionsData {
            segments: random_captions(&mut rng, durations.iter().sum()),
            settings: styled_settings(&mut rng),
            source_timed: true,
        });
        cap_project::synchronize_captions(&mut config, &durations);
        random_overrides(&mut rng, &mut config, true);
        let project = dir.path().join(format!("seed-{seed}"));
        std::fs::create_dir_all(&project).expect("project dir");
        if let Err(e) = config.write(&project) {
            case.problem("error", format!("seed {seed}: write failed: {e}"));
            continue;
        }
        let loaded = match ProjectConfiguration::load(&project) {
            Ok(loaded) => loaded,
            Err(e) => {
                case.problem("error", format!("seed {seed}: load failed: {e}"));
                continue;
            }
        };
        let json = |c: &ProjectConfiguration| {
            (
                serde_json::to_value(&c.captions).expect("captions json"),
                serde_json::to_value(&edits::timeline(c).caption_segments).expect("track json"),
            )
        };
        if json(&config) != json(&loaded) {
            case.problem(
                "caption-roundtrip",
                format!("seed {seed}: captions changed through project-config.json"),
            );
        }
        let mut resynced = loaded.clone();
        cap_project::synchronize_captions(&mut resynced, &durations);
        if json(&resynced) != json(&loaded) {
            case.problem(
                "caption-roundtrip",
                format!("seed {seed}: re-projecting a loaded project changed its captions"),
            );
        }
    }
    // The legacy captions.json sidecar of older projects: output-timed
    // captions with no track, picked up when project-config.json has none.
    let project = common::project(&catalog::basic(report::tier()));
    let copy = dir.path().join("sidecar.cap");
    copy_project(&project.path, &copy);
    let mut rng = Rng::new(0xCA97_2FFF);
    let legacy = CaptionsData {
        segments: random_captions(&mut rng, 5.0),
        settings: styled_settings(&mut rng),
        source_timed: false,
    };
    std::fs::write(
        copy.join("captions.json"),
        serde_json::to_string(&legacy).expect("sidecar json"),
    )
    .expect("write sidecar");
    let meta = RecordingMeta::load_for_project(&copy).expect("meta");
    let loaded = meta.project_config();
    match &loaded.captions {
        None => case.problem("caption-roundtrip", "captions.json sidecar was not loaded"),
        Some(c) => {
            if serde_json::to_value(c).ok() != serde_json::to_value(&legacy).ok() {
                case.problem(
                    "caption-roundtrip",
                    "captions.json sidecar loaded with different captions",
                );
            }
        }
    }
    case.note(format!(
        "{seeds} projects through project-config.json, plus the captions.json sidecar"
    ));
    finish(case);
}

fn copy_project(from: &Path, to: &Path) {
    for entry in walk(from) {
        let rel = entry.strip_prefix(from).expect("inside project");
        let target = to.join(rel);
        std::fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
        std::fs::copy(&entry, &target).expect("copy");
    }
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).expect("read dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

/// Two takes; every track starts at a different time, so the clip offsets
/// matter (mic 0.25 s late, system audio 0.1 s early, display 0.05 s late).
fn transcription_fixture() -> FixtureSpec {
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

const RATE: u32 = 48_000;

/// Display durations as the recordings' containers report them: the length
/// of each take on the concatenated source timeline. Checked against the
/// spec (whole frames) to within one frame.
fn display_durations(case: &mut Case, project: &common::Project, spec: &FixtureSpec) -> Vec<f64> {
    let durations: Vec<f64> = cap_rendering::ProjectRecordingsMeta::new(
        &project.path,
        project.meta.studio_meta().expect("studio"),
    )
    .expect("recordings meta")
    .segments
    .iter()
    .map(|s| s.display.duration)
    .collect();
    for (d, s) in durations.iter().zip(&spec.segments) {
        let truth = s.display.timing.duration(s.display.fps);
        if (d - truth).abs() > 1.0 / f64::from(s.display.fps) + 1e-6 {
            case.problem(
                "duration",
                format!("display duration {d:.4}s, the track has {truth:.4}s of frames"),
            );
        }
    }
    durations
}

fn interleaved(decoded: &media::DecodedAudio) -> Vec<f32> {
    let frames = decoded.channels.iter().map(Vec::len).min().unwrap_or(0);
    let mut samples = Vec::with_capacity(frames * decoded.channels.len());
    for i in 0..frames {
        for channel in &decoded.channels {
            samples.push(channel[i]);
        }
    }
    samples
}

/// The transcription input, built the way the app's transcription does:
/// per take, system audio then mic, aligned by the clip offsets, over the
/// take's display duration; takes concatenated.
fn transcription_audio(project: &common::Project) -> Vec<f32> {
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = project.meta.studio_meta() else {
        panic!("multi-segment fixture");
    };
    let recordings = cap_rendering::ProjectRecordingsMeta::new(
        &project.path,
        project.meta.studio_meta().expect("studio"),
    )
    .expect("recordings meta");
    let takes: Vec<cap_editor::TranscriptionAudioTake> = inner
        .segments
        .iter()
        .zip(&recordings.segments)
        .map(|(segment, recording)| {
            let offsets = segment.calculate_audio_offsets();
            let mut sources = Vec::new();
            for (audio, offset) in [
                (&segment.system_audio, offsets.system_audio),
                (&segment.mic, offsets.mic),
            ] {
                let Some(audio) = audio else { continue };
                let decoded =
                    media::decode_audio(&project.path.join(audio.path.as_str()), Some(RATE))
                        .expect("decode source audio");
                sources.push(cap_editor::TranscriptionAudioSource {
                    samples: interleaved(&decoded),
                    channels: decoded.channels.len(),
                    offset_secs: f64::from(offset),
                });
            }
            cap_editor::TranscriptionAudioTake {
                display_duration_secs: recording.display.duration,
                sources,
            }
        })
        .collect();
    cap_editor::assemble_transcription_audio(&takes, RATE).expect("assemble")
}

fn word_text(source: AudioSource, index: u32) -> String {
    format!("{}{index}", source.name())
}

/// The fake transcriber: one word per audio marker heard, timed from the
/// marker's chirp to its end.
fn fake_transcribe(audio: &[f32]) -> Vec<CaptionWord> {
    let mut words: Vec<CaptionWord> = [AudioSource::Mic, AudioSource::System]
        .into_iter()
        .flat_map(|source| {
            audio_code::locate_markers(audio, RATE, source)
                .into_iter()
                .filter_map(move |m| {
                    Some(CaptionWord {
                        text: word_text(source, m.index?),
                        start: m.time_secs as f32,
                        end: (m.time_secs + MARKER_SECS) as f32,
                    })
                })
        })
        .collect();
    words.sort_by(|a, b| a.start.total_cmp(&b.start));
    words
}

/// Where every marker must be heard, from each source file's own markers
/// and the spec's track start times: a track sample at file time `m`
/// happened at `track start + m`; a take's transcription time 0 is its
/// latest track start, and takes follow each other by display length.
fn expected_words(
    project: &common::Project,
    spec: &FixtureSpec,
    durations: &[f64],
) -> Vec<(String, f64)> {
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = project.meta.studio_meta() else {
        panic!("multi-segment fixture");
    };
    let mut take_start = 0.0;
    let mut out = Vec::new();
    for ((segment, seg_spec), &display) in inner.segments.iter().zip(&spec.segments).zip(durations)
    {
        let latest = [
            Some(seg_spec.display.start_time),
            seg_spec.mic.as_ref().map(|a| a.start_time),
            seg_spec.system_audio.as_ref().map(|a| a.start_time),
        ]
        .into_iter()
        .flatten()
        .fold(f64::NEG_INFINITY, f64::max);
        for (meta, track) in [
            (&segment.mic, &seg_spec.mic),
            (&segment.system_audio, &seg_spec.system_audio),
        ] {
            let (Some(meta), Some(track)) = (meta, track) else {
                continue;
            };
            let decoded = media::decode_audio(&project.path.join(meta.path.as_str()), Some(RATE))
                .expect("decode source audio");
            for marker in audio_code::locate_markers(&decoded.mono(), RATE, track.source) {
                let Some(index) = marker.index else { continue };
                let t = track.start_time + decoded.start_secs + marker.time_secs - latest;
                if t >= 0.0 && t + MARKER_SECS <= display {
                    out.push((word_text(track.source, index), take_start + t));
                }
            }
        }
        take_start += display;
    }
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out
}

#[test]
fn transcription_audio_words() {
    let id = "captions/transcription-audio/takes";
    if !report::selected(id) {
        return;
    }
    let spec = transcription_fixture();
    let project = common::project(&spec);
    let mut case = Case::new(id);
    let durations = display_durations(&mut case, &project, &spec);
    let words = fake_transcribe(&transcription_audio(&project));
    let expected = expected_words(&project, &spec, &durations);
    let mut problems = Vec::new();
    let mut worst = 0.0f64;
    for (text, time) in &expected {
        let hits: Vec<&CaptionWord> = words
            .iter()
            .filter(|w| &w.text == text && (f64::from(w.start) - time).abs() < 0.05)
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
            "{} words heard, {} expected",
            words.len(),
            expected.len()
        ));
    }
    if expected.len() < 10 {
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
                "{} problems (first: {})",
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
    // The transcribed captions through a reorder of the two takes, projected
    // with the spec's display lengths as the source of truth.
    let captions: Vec<CaptionSegment> = words
        .chunks(3)
        .enumerate()
        .map(|(i, chunk)| CaptionSegment {
            id: format!("segment-{i}"),
            start: chunk[0].start,
            end: chunk[chunk.len() - 1].end,
            text: join_words(chunk.iter().map(|w| w.text.as_str())),
            words: chunk.to_vec(),
        })
        .collect();
    let mut config = project.config();
    config
        .timeline
        .as_mut()
        .expect("timeline")
        .segments
        .reverse();
    set_captions(&mut config, captions.clone(), true);
    cap_project::synchronize_captions(&mut config, &durations);
    let track_problems = compare_track(
        &edits::timeline(&config).caption_segments,
        &model_project(&captions, &config, &durations),
    );
    if !track_problems.is_empty() {
        case.problem(
            "caption-track",
            format!(
                "reordered takes: {} caption problems (first: {})",
                track_problems.len(),
                track_problems[0]
            ),
        );
    }
    finish(case);
}

/// Caption style that is easy to find: an opaque green box with white text,
/// no fades, animation or word highlight.
fn render_settings() -> CaptionSettings {
    CaptionSettings {
        enabled: true,
        size: 72,
        color: "#FFFFFF".into(),
        background_color: "#00C800".into(),
        background_opacity: 100,
        position: "bottom-center".into(),
        outline: false,
        fade_duration: 0.0,
        animation: "none".into(),
        active_word_highlight: false,
        ..Default::default()
    }
}

const WORDS: [&str; 30] = [
    "apple", "river", "cloud", "stone", "maple", "tiger", "piano", "lemon", "orbit", "glass",
    "honey", "zebra", "candle", "forest", "rocket", "violet", "marble", "tunnel", "pepper",
    "falcon", "garden", "silver", "anchor", "button", "copper", "dragon", "eclipse", "fabric",
    "harbor", "island",
];

/// Scripted words: three per caption, one caption every ~1.35 s, with a
/// word stretched across a silence in the third caption.
fn scripted_captions(total: f64) -> Vec<CaptionSegment> {
    let mut captions = Vec::new();
    let mut t = 0.2;
    let mut word = 0;
    while t + 1.2 < total && word + 3 <= WORDS.len() {
        let mut words = Vec::new();
        for i in 0..3 {
            let start = t + 0.4 * i as f64;
            let mut end = start + 0.35;
            if captions.len() == 2 && i == 2 {
                end = start + 6.0;
            }
            words.push(CaptionWord {
                text: WORDS[word].into(),
                start: start as f32,
                end: end as f32,
            });
            word += 1;
        }
        captions.push(CaptionSegment {
            id: format!("segment-{}", captions.len()),
            start: words[0].start,
            end: words[2].end,
            text: join_words(words.iter().map(|w| w.text.as_str())),
            words,
        });
        t += 1.35;
    }
    captions
}

#[derive(Clone)]
struct CaptionPixels {
    box_pixels: usize,
    /// Bright (text) pixels inside the box's rows, full width.
    glyphs: Vec<bool>,
    bbox: Option<(usize, usize, usize, usize)>,
}

fn caption_pixels(view: &impl PixelSource) -> CaptionPixels {
    let (w, h) = (view.width(), view.height());
    let mut box_pixels = 0;
    let mut bbox: Option<(usize, usize, usize, usize)> = None;
    for y in h / 2..h {
        for x in 0..w {
            let (cb, cr) = view.chroma(x, y);
            if cb < -35.0 && cr < -40.0 {
                box_pixels += 1;
                bbox = Some(match bbox {
                    None => (x, y, x, y),
                    Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                });
            }
        }
    }
    let glyphs = (h / 2..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            bbox.is_some_and(|(x0, y0, x1, y1)| x >= x0 && x <= x1 && y >= y0 && y <= y1)
                && view.luma(x, y) > 170.0
        })
        .collect();
    CaptionPixels {
        box_pixels,
        glyphs,
        bbox,
    }
}

fn iou(a: &[bool], b: &[bool]) -> f64 {
    let (mut both, mut any) = (0usize, 0usize);
    for (x, y) in a.iter().zip(b) {
        both += usize::from(*x && *y);
        any += usize::from(*x || *y);
    }
    if any == 0 {
        1.0
    } else {
        both as f64 / any as f64
    }
}

/// A frame shows a caption box when this many box pixels are present.
const BOX_PRESENT: usize = 200;
const SAME_TEXT_IOU: f64 = 0.75;

fn decode_captions(path: &Path) -> Vec<CaptionPixels> {
    let mut frames = Vec::new();
    media::decode_video(path, |picture| frames.push(caption_pixels(&picture.view())))
        .expect("decode export");
    frames
}

const RENDER_FPS: u32 = 30;
const RENDER_RES: (u32, u32) = (480, 270);

fn render_export(
    rt: &tokio::runtime::Runtime,
    project: &common::Project,
    config: ProjectConfiguration,
    out: &Path,
) -> Result<Vec<CaptionPixels>, String> {
    let run = common::ExportRun {
        custom_bpp: None,
        fps: RENDER_FPS,
        resolution: RENDER_RES,
        format: common::Format::Mp4,
        decoder: common::Decoder::Default,
    };
    let path = rt.block_on(common::export(project, config, &run, out))?;
    Ok(decode_captions(&path))
}

/// Glyph templates: every piece text rendered alone in its own window of an
/// unedited timeline.
fn templates(
    rt: &tokio::runtime::Runtime,
    project: &common::Project,
    texts: &[String],
    durations: &[f64],
    out: &Path,
) -> Result<Vec<(String, CaptionPixels)>, String> {
    let slot = 0.3;
    let mut config = project.config();
    config.camera.hide = true;
    let captions: Vec<CaptionSegment> = texts
        .iter()
        .enumerate()
        .map(|(i, text)| CaptionSegment {
            id: format!("t{i}"),
            start: (i as f64 * slot) as f32,
            end: (i as f64 * slot + slot - 0.05) as f32,
            text: text.clone(),
            words: Vec::new(),
        })
        .collect();
    config.captions = Some(CaptionsData {
        segments: captions,
        settings: render_settings(),
        source_timed: true,
    });
    // Projected here so the templates do not depend on the export's own
    // projection (which `render_*` checks).
    cap_project::synchronize_captions(&mut config, durations);
    let duration = edits::timeline(&config).duration();
    if texts.len() as f64 * slot > duration {
        return Err(format!(
            "{} templates do not fit in {duration:.1}s",
            texts.len()
        ));
    }
    let frames = render_export(rt, project, config, out)?;
    texts
        .iter()
        .enumerate()
        .map(|(i, text)| {
            let frame = ((i as f64 * slot + 0.12) * f64::from(RENDER_FPS)).round() as usize;
            let pixels = frames
                .get(frame)
                .filter(|p| p.box_pixels >= BOX_PRESENT)
                .ok_or_else(|| format!("template \"{text}\" not rendered at frame {frame}"))?;
            Ok((text.clone(), pixels.clone()))
        })
        .collect()
}

struct RenderEdit {
    name: &'static str,
    apply: fn(&mut ProjectConfiguration),
    /// Apply the edit after the caption track was projected, leaving the
    /// stored track stale (the export must re-project it).
    stale_track: bool,
    /// Source captions for the recording's total length.
    captions: fn(f64) -> Vec<CaptionSegment>,
    /// Check frames that fall exactly on a caption start or end too. Only
    /// for captions whose boundaries are exact in f32 and on the frame grid.
    strict_edges: bool,
}

fn render_case(
    spec: FixtureSpec,
    edit: &RenderEdit,
    rt: &tokio::runtime::Runtime,
) -> Option<String> {
    let id = format!("captions/render/{}/{}", spec.name, edit.name);
    if !report::selected(&id) {
        return None;
    }
    let project = common::project(&spec);
    let mut case = Case::new(&id);
    let durations = display_durations(&mut case, &project, &spec);
    let captions = (edit.captions)(durations.iter().sum());
    let mut config = project.config();
    config.camera.hide = true;
    if !edit.stale_track {
        (edit.apply)(&mut config);
    }
    config.captions = Some(CaptionsData {
        segments: captions.clone(),
        settings: render_settings(),
        source_timed: true,
    });
    cap_project::synchronize_captions(&mut config, &durations);
    if edit.stale_track {
        (edit.apply)(&mut config);
    }
    let pieces = model_project(&captions, &config, &durations);
    let dir = common::scratch_dir(&id);
    let mut texts: Vec<String> = pieces.iter().map(|p| p.text.clone()).collect();
    texts.sort();
    texts.dedup();
    let result = templates(
        rt,
        &project,
        &texts,
        &durations,
        &dir.path().join("templates.mp4"),
    )
    .and_then(|templates| {
        render_export(rt, &project, config.clone(), &dir.path().join("out.mp4"))
            .map(|frames| (templates, frames))
    });
    match result {
        Err(e) => case.problem("error", format!("export failed: {e}")),
        Ok((templates, frames)) => {
            let time = TimeModel::new(&config);
            let expected_frames = (time.duration() * f64::from(RENDER_FPS)).ceil() as usize;
            if frames.len() != expected_frames {
                case.problem(
                    "frame-count",
                    format!(
                        "{} frames, the timeline needs {expected_frames}",
                        frames.len()
                    ),
                );
            }
            let mut wrong = Vec::new();
            let (mut checked, mut shown) = (0, 0);
            for (i, pixels) in frames.iter().enumerate() {
                let t = i as f64 / f64::from(RENDER_FPS);
                let edge = pieces
                    .iter()
                    .any(|p| (t - p.start).abs() < 1e-3 || (t - p.visible_end()).abs() < 1e-3);
                if edge && !edit.strict_edges {
                    continue;
                }
                checked += 1;
                let expected = pieces
                    .iter()
                    .find(|p| t >= p.start && t < p.visible_end())
                    .map(|p| p.text.as_str());
                let present = pixels.box_pixels >= BOX_PRESENT;
                let seen = present.then(|| {
                    templates
                        .iter()
                        .map(|(text, template)| {
                            (text.as_str(), iou(&template.glyphs, &pixels.glyphs))
                        })
                        .max_by(|a, b| a.1.total_cmp(&b.1))
                        .filter(|(_, score)| *score >= SAME_TEXT_IOU)
                        .map(|(text, _)| text)
                });
                let ok = match (expected, seen) {
                    (None, None) => true,
                    (Some(e), Some(Some(s))) => e == s,
                    _ => false,
                };
                shown += usize::from(expected.is_some());
                if !ok {
                    wrong.push(format!(
                        "frame {i} ({t:.3}s): expected {expected:?}, shows {}",
                        match seen {
                            None => "no caption".to_string(),
                            Some(None) => format!("an unknown caption (box {:?})", pixels.bbox),
                            Some(Some(s)) => format!("\"{s}\""),
                        }
                    ));
                }
            }
            let summary = format!(
                "{} pieces, {checked} frames checked, {shown} with a caption",
                pieces.len()
            );
            if wrong.is_empty() {
                case.note(summary);
            } else {
                case.problem(
                    "caption-frame",
                    format!(
                        "{summary}; {} frames wrong (first: {})",
                        wrong.len(),
                        wrong.iter().take(4).cloned().collect::<Vec<_>>().join("; ")
                    ),
                );
            }
        }
    }
    settle(case)
}

fn render_edits() -> Vec<RenderEdit> {
    vec![
        RenderEdit {
            name: "full",
            apply: |_| {},
            stale_track: false,
            captions: scripted_captions,
            strict_edges: false,
        },
        RenderEdit {
            name: "cuts-speeds-reorder",
            apply: |c| {
                common::set_cuts(
                    c,
                    &[
                        (0.5, 2.0, 1.0),
                        (2.5, 4.0, 2.0),
                        (1.0, 2.0, 0.5),
                        (4.0, 5.8, 1.5),
                    ],
                )
            },
            stale_track: false,
            captions: scripted_captions,
            strict_edges: false,
        },
        RenderEdit {
            name: "transition",
            apply: |c| {
                common::set_cuts(c, &[(0.0, 2.5, 1.0), (3.5, 6.0, 1.0)]);
                common::add_transition(c, 1, 0.4);
            },
            stale_track: false,
            captions: scripted_captions,
            strict_edges: false,
        },
        RenderEdit {
            name: "stale-track",
            apply: |c| common::set_cuts(c, &[(2.7, 6.0, 1.0), (0.0, 2.0, 1.0)]),
            stale_track: true,
            captions: scripted_captions,
            strict_edges: false,
        },
        RenderEdit {
            // Half speed: the third caption's stretched last word lasts
            // 4.6 s on the output, so the renderer's 2.5 s word limit
            // decides when it disappears.
            name: "slow",
            apply: |c| common::set_cuts(c, &[(0.0, 6.0, 0.5)]),
            stale_track: false,
            captions: scripted_captions,
            strict_edges: false,
        },
        RenderEdit {
            name: "back-to-back",
            apply: |_| {},
            stale_track: false,
            captions: back_to_back_captions,
            strict_edges: true,
        },
    ]
}

/// Captions that follow each other without a gap, every boundary on a half
/// second (exact in f32 and on the 30 fps frame grid): on the frame where
/// one caption ends the next one shows, and after the last one nothing.
fn back_to_back_captions(total: f64) -> Vec<CaptionSegment> {
    let mut captions = Vec::new();
    let mut start = 0.5;
    while start + 1.0 <= total - 0.5 && captions.len() < 5 {
        let k = captions.len() * 2;
        let words: Vec<CaptionWord> = (0..2)
            .map(|i| CaptionWord {
                text: WORDS[k + i].into(),
                start: (start + 0.5 * i as f64) as f32,
                end: (start + 0.5 * (i + 1) as f64) as f32,
            })
            .collect();
        captions.push(CaptionSegment {
            id: format!("segment-{}", captions.len()),
            start: words[0].start,
            end: words[1].end,
            text: join_words(words.iter().map(|w| w.text.as_str())),
            words,
        });
        start += 1.0;
    }
    captions
}

#[test]
fn render_single_clip() {
    let rt = common::runtime();
    let failures: Vec<String> = render_edits()
        .iter()
        .filter_map(|edit| render_case(catalog::basic(report::tier()), edit, &rt))
        .collect();
    common::assert_passed(failures);
}

#[test]
fn render_multi_clip() {
    let rt = common::runtime();
    let edit = RenderEdit {
        name: "reorder",
        apply: |c| {
            let timeline = c.timeline.as_mut().expect("timeline");
            timeline.segments.reverse();
        },
        stale_track: true,
        captions: scripted_captions,
        strict_edges: false,
    };
    let failures: Vec<String> = render_case(catalog::multi_segment(report::tier()), &edit, &rt)
        .into_iter()
        .collect();
    common::assert_passed(failures);
}

/// Opens a copy of `project` whose stored config is `config` in the editor
/// engine and returns the config it settles on.
fn open_in_editor(
    rt: &tokio::runtime::Runtime,
    project: &common::Project,
    config: &ProjectConfiguration,
    dir: &Path,
    sidecar: Option<&CaptionsData>,
) -> Result<ProjectConfiguration, String> {
    let copy = dir.join("project.cap");
    copy_project(&project.path, &copy);
    config
        .write(&copy)
        .map_err(|e| format!("write config: {e}"))?;
    if let Some(sidecar) = sidecar {
        std::fs::write(
            copy.join("captions.json"),
            serde_json::to_string(sidecar).expect("sidecar json"),
        )
        .map_err(|e| format!("write sidecar: {e}"))?;
    }
    rt.block_on(async {
        let editor = cap_editor::EditorInstance::new(
            copy.clone(),
            |_| {},
            Box::new(|_: cap_editor::EditorFrameOutput, _: cap_editor::FrameLayout| {}),
            None,
        )
        .await?;
        let loaded = editor.project_config.1.borrow().clone();
        editor.dispose().await;
        Ok(loaded)
    })
}

#[test]
fn editor_open() {
    let rt = common::runtime();
    let spec = catalog::multi_segment(report::tier());
    let project = common::project(&spec);
    let mut durations_check = Case::new("captions/editor-open/durations");
    let durations = display_durations(&mut durations_check, &project, &spec);
    let captions = (0..)
        .map(|seed| random_captions(&mut Rng::new(0xCA97_3000 + seed), durations.iter().sum()))
        .find(|captions| captions.len() >= 5)
        .expect("captions");
    let edit = |config: &mut ProjectConfiguration| {
        let timeline = config.timeline.as_mut().expect("timeline");
        timeline.segments.reverse();
        timeline.segments[0].start += 0.5;
        timeline.segments[1].timescale = 1.5;
    };
    let mut failures = Vec::new();
    for variant in [
        "source-timed-stale-track",
        "legacy-output-timed",
        "legacy-sidecar",
    ] {
        let id = format!("captions/editor-open/{variant}");
        if !report::selected(&id) {
            continue;
        }
        let mut case = Case::new(&id);
        for problem in &durations_check.problems {
            case.problem("duration", problem.clone());
        }
        let dir = common::scratch_dir(&id);
        let mut config = project.config();
        let (expected_captions, sidecar) = match variant {
            "source-timed-stale-track" => {
                set_captions(&mut config, captions.clone(), true);
                cap_project::synchronize_captions(&mut config, &durations);
                edit(&mut config);
                (captions.clone(), None)
            }
            _ => {
                edit(&mut config);
                let mut shown = config.clone();
                set_captions(&mut shown, captions.clone(), true);
                cap_project::synchronize_captions(&mut shown, &durations);
                let legacy = track_as_captions(&edits::timeline(&shown).caption_segments);
                let migrated = model_migrate(&legacy, &config, &durations);
                if variant == "legacy-output-timed" {
                    set_captions(&mut config, legacy, false);
                    (migrated, None)
                } else {
                    let sidecar = CaptionsData {
                        segments: legacy,
                        settings: caption_settings(),
                        source_timed: false,
                    };
                    (migrated, Some(sidecar))
                }
            }
        };
        match open_in_editor(&rt, &project, &config, dir.path(), sidecar.as_ref()) {
            Err(e) => case.problem("error", format!("editor failed to open: {e}")),
            Ok(loaded) => match &loaded.captions {
                None => case.problem("caption-migration", "no captions after opening"),
                Some(data) => {
                    if !data.source_timed {
                        case.problem(
                            "caption-migration",
                            "captions still output-timed after opening",
                        );
                    }
                    let same = data.segments.len() == expected_captions.len()
                        && data.segments.iter().zip(&expected_captions).all(|(a, b)| {
                            a.id == b.id
                                && close(f64::from(a.start), f64::from(b.start))
                                && close(f64::from(a.end), f64::from(b.end))
                                && a.words.len() == b.words.len()
                        });
                    if !same {
                        case.problem(
                            "caption-migration",
                            format!(
                                "stored captions after opening differ from the model ({} vs {})",
                                data.segments.len(),
                                expected_captions.len()
                            ),
                        );
                    }
                    let problems = compare_track(
                        &edits::timeline(&loaded).caption_segments,
                        &model_project(&expected_captions, &loaded, &durations),
                    );
                    if problems.is_empty() {
                        case.note(format!(
                            "{} captions, {} track pieces as the model says",
                            data.segments.len(),
                            edits::timeline(&loaded).caption_segments.len()
                        ));
                    } else {
                        case.problem(
                            "caption-track",
                            format!("{} track problems (first: {})", problems.len(), problems[0]),
                        );
                    }
                }
            },
        }
        failures.extend(settle(case));
    }
    common::assert_passed(failures);
}
