//! Editing oracle: seeded random sequences of timeline edits (split, delete,
//! trim start/end, speed, reorder, clip volume, clip transitions, fullscreen
//! text holds) on project configs.
//!
//! - `mapping_*`: for every sequence, the engine's timeline mapping
//!   (`TimelineConfiguration::duration`, `get_frame_mapping`,
//!   `get_segment_time`) must agree with the independent model in
//!   `edits::TimeModel` on a 1/60 s grid, at random times and just inside
//!   every edge; without holds, also with the core reference model
//!   (`cap_verify::model`). Failing sequences are shrunk to a minimal list
//!   of ops before reporting.
//! - `export_*`: a few random edit sequences per fixture exported and
//!   checked frame for frame against the core reference model.
//!
//! Undo/redo lives in the desktop app (`ProjectHistory` snapshots whole
//! project configs), not in an engine crate, so it is out of scope here.

mod common;
mod edits;

use cap_project::ProjectConfiguration;
use cap_verify::{
    catalog,
    fixture::Rng,
    model::ReferenceModel,
    report::{self, Case, Tier},
};
use common::{Decoder, ExportRun, Format};
use edits::{Mapping, Op, OpMix, TimeModel};

const TOLERANCE: f64 = 1e-9;
const EDGE_EPSILON: f64 = 1e-6;

// At 320x180, lossy compression can turn a camera crossfade's tiny marker
// cells into a different valid index. Keep this timing oracle's signal readable.
const MARKER_EXPORT_BPP: f32 = 1.0;

/// Output times to probe: a 1/60 s grid, random times and both sides of
/// every edge.
fn probe_times(model: &TimeModel, rng: &mut Rng) -> Vec<f64> {
    let duration = model.duration();
    let mut times: Vec<f64> = (0..(duration * 60.0).ceil() as usize)
        .map(|i| i as f64 / 60.0)
        .collect();
    times.extend((0..64).map(|_| rng.f64() * duration));
    let mut edges = Vec::new();
    for (k, s) in model.segments.iter().enumerate() {
        let next_in = model.segments.get(k + 1).map_or(0.0, |n| n.transition_in);
        for e in [
            s.out_start,
            s.out_start + s.transition_in,
            s.out_start + s.duration - next_in,
        ] {
            edges.push(model.to_output(e));
        }
    }
    for &(a, b) in &model.holds {
        edges.extend([a, b]);
    }
    for edge in edges {
        times.extend([edge - 1e-4, edge + 1e-4]);
    }
    times.retain(|&t| t >= 0.0 && t < duration);
    times
}

#[derive(Clone, Copy, PartialEq)]
enum Check {
    /// Engine mapping against the models.
    Mapping,
    /// Every output time inside `duration()` has a source frame.
    Coverage,
}

impl Check {
    fn class(self) -> &'static str {
        match self {
            Check::Mapping => "mapping",
            Check::Coverage => "coverage",
        }
    }
}

/// Checks one edited config; returns the problems.
fn check_config(
    config: &ProjectConfiguration,
    durations: &[f64],
    seed: u64,
    check: Check,
) -> Vec<String> {
    let timeline = edits::timeline(config);
    let model = TimeModel::new(config);
    let mut problems = Vec::new();
    if check == Check::Coverage {
        let mut rng = Rng::new(seed);
        for t in probe_times(&model, &mut rng) {
            if !model.near_edge(t, EDGE_EPSILON) && timeline.get_frame_mapping(t).is_none() {
                problems.push(format!(
                    "t={t:.6}: no source frame inside the {:.6}s timeline",
                    timeline.duration()
                ));
            }
        }
        return problems;
    }
    if (timeline.duration() - model.duration()).abs() > TOLERANCE {
        problems.push(format!(
            "duration {:.9}, the model expects {:.9}",
            timeline.duration(),
            model.duration()
        ));
    }
    let core = if model.holds.is_empty() {
        let (meta, truth) = edits::synthetic_meta(durations);
        Some(ReferenceModel::new(&meta, config, truth).expect("core model"))
    } else {
        None
    };
    let mut rng = Rng::new(seed ^ 0x7123_4567);
    for t in probe_times(&model, &mut rng) {
        if model.near_edge(t, EDGE_EPSILON) {
            continue;
        }
        let expected = model.map(t);
        let actual = edits::product_map(timeline, t);
        match (&expected, &actual) {
            (Some(e), Some(a)) if edits::same_mapping(e, a, TOLERANCE) => {}
            (None, None) => {}
            _ => problems.push(format!("t={t:.6}: engine {actual:?}, model {expected:?}")),
        }
        let shown = config.get_segment_time(t).map(|(time, segment)| {
            let index = timeline
                .segments
                .iter()
                .position(|s| std::ptr::eq(s, segment))
                .expect("segment from this timeline");
            (index, time)
        });
        let expected_shown = expected.map(|m| (m.shown().segment, m.shown().time));
        let shown_ok = match (shown, expected_shown) {
            (Some((a, x)), Some((b, y))) => a == b && (x - y).abs() <= TOLERANCE,
            (None, None) => true,
            _ => false,
        };
        if !shown_ok {
            problems.push(format!(
                "t={t:.6}: get_segment_time {shown:?}, model {expected_shown:?}"
            ));
        }
        if let (Some(core), Some(Mapping::Single { source, .. })) = (&core, &expected) {
            let clip = timeline.segments[source.segment].recording_clip as usize;
            match core.expect_at(t).source {
                Some((c, time)) if c == clip && (time - source.time).abs() <= TOLERANCE => {}
                other => problems.push(format!(
                    "t={t:.6}: core reference model {other:?}, edit model clip {clip} at {:.9}",
                    source.time
                )),
            }
        }
    }
    problems
}

fn mapping_case(name: &str, mix: OpMix, seeds: u64, check: Check) {
    let id = format!("editing/mapping/{name}");
    if !report::selected(&id) {
        return;
    }
    let mut case = Case::new(&id);
    let mut failed = 0;
    let mut probes = 0usize;
    for seed in 0..seeds {
        let mut rng = Rng::new(0xED17_0000 ^ (seed << 8) ^ name.len() as u64);
        let durations = edits::random_durations(&mut rng);
        let base = edits::base_config(&durations);
        let count = rng.range(1, 10) as usize;
        let ops = edits::random_sequence(&mut rng, &base, count, mix);
        let config = edits::replay(&base, &ops);
        probes += probe_times(&TimeModel::new(&config), &mut Rng::new(seed)).len();
        let problems = check_config(&config, &durations, seed, check);
        if problems.is_empty() {
            continue;
        }
        failed += 1;
        if failed > 3 {
            continue;
        }
        let minimal = edits::shrink(&ops, |ops| {
            !check_config(&edits::replay(&base, ops), &durations, seed, check).is_empty()
        });
        let minimal_problems =
            check_config(&edits::replay(&base, &minimal), &durations, seed, check);
        case.problem(check.class(), format!(
            "seed {seed}: clips {durations:?}, shrunk from {} to {} ops {minimal:?}: {} mismatches (first: {})",
            ops.len(),
            minimal.len(),
            minimal_problems.len(),
            minimal_problems
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    case.note(format!(
        "{seeds} random edit sequences, {probes} probe times, {failed} sequences failed"
    ));
    if failed > 3 {
        case.problem(check.class(), format!("{failed} sequences failed in total"));
    }
    if failed > 0 {
        // The share of the (seeded, deterministic) sequences that fail: the
        // signature an expectation bounds.
        case.measure(
            check.class(),
            "failed-per-mille",
            (failed as f64 * 10_000.0 / seeds as f64).round() / 10.0,
        );
    }
    finish(case);
}

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

#[test]
fn mapping_cuts_speeds() {
    mapping_case(
        "cuts-speeds",
        OpMix {
            transitions: false,
            holds: false,
        },
        seeds(1000, 20000),
        Check::Mapping,
    );
}

#[test]
fn mapping_transitions() {
    mapping_case(
        "transitions",
        OpMix {
            transitions: true,
            holds: false,
        },
        seeds(1000, 20000),
        Check::Mapping,
    );
}

#[test]
fn mapping_holds() {
    mapping_case(
        "holds",
        OpMix {
            transitions: false,
            holds: true,
        },
        seeds(1000, 20000),
        Check::Mapping,
    );
}

#[test]
fn mapping_all() {
    mapping_case(
        "all",
        OpMix {
            transitions: true,
            holds: true,
        },
        seeds(1000, 20000),
        Check::Mapping,
    );
}

/// Fullscreen text holds left past the end of the clips (place a text card,
/// then trim or delete clips) still count towards `duration()`, but those
/// output times have no source frame, so renders stop early.
#[test]
fn mapping_duration_covered() {
    mapping_case(
        "duration-covered",
        OpMix {
            transitions: true,
            holds: true,
        },
        seeds(1000, 20000),
        Check::Coverage,
    );
}

/// Random edits of a real fixture exported and checked frame by frame.
fn export_cases(spec: cap_verify::fixture::FixtureSpec, seeds: u64) -> Vec<String> {
    let project = common::project(&spec);
    let base = project.config();
    let rt = common::runtime();
    let fps = 30;
    let decoders = Decoder::all();
    let mut failures = Vec::new();
    for seed in 0..seeds {
        let id = format!("editing/export/{}/seed-{seed}", spec.name);
        if !report::selected(&id) {
            continue;
        }
        let mut rng = Rng::new(0xED17_1000 ^ (seed << 8) ^ spec.name.len() as u64);
        let count = rng.range(3, 8) as usize;
        let mut ops = edits::random_sequence(
            &mut rng,
            &base,
            count,
            OpMix {
                transitions: true,
                holds: false,
            },
        );
        // Odd seeds end with a transition on every boundary, long ones and
        // ones below the minimum included, so clamping is always exercised.
        if seed % 2 == 1 {
            let segments = edits::timeline(&edits::replay(&base, &ops)).segments.len();
            for segment in 1..segments {
                ops.push(Op::Transition {
                    segment,
                    duration: [3.0, 0.02, 0.4][(segment + seed as usize) % 3],
                });
            }
        }
        let config = edits::replay(&base, &ops);
        let mut case = Case::new(&id);
        case.note(format!("ops: {ops:?}"));
        let model = project.model(&config);
        let dir = common::scratch_dir(&id);
        let run = ExportRun {
            custom_bpp: Some(MARKER_EXPORT_BPP),
            fps,
            resolution: (320, 180),
            format: Format::Mp4,
            decoder: decoders[seed as usize % decoders.len()],
        };
        case.note(format!("decoder {}", run.decoder.label()));
        match rt.block_on(common::export(
            &project,
            config,
            &run,
            &dir.path().join("out.mp4"),
        )) {
            Err(e) => case.problem("error", format!("export failed: {e}")),
            Ok(out) => {
                let frames = common::read_output(&out, Some(&|i| model.expect(i as u32, fps)));
                common::check_sequence(&mut case, &model, &frames, fps, true);
            }
        }
        failures.extend(settle(case));
    }
    failures
}

#[test]
fn export_single_clip() {
    common::assert_passed(export_cases(catalog::basic(report::tier()), seeds(8, 40)));
}

#[test]
fn export_multi_clip() {
    common::assert_passed(export_cases(
        catalog::multi_segment(report::tier()),
        seeds(6, 30),
    ));
}

/// A cross-fade between two parts of the same recording clip: the export
/// reads one decoder at two positions, interleaved, for the whole
/// transition. Forward (later part incoming) and backward.
#[test]
fn same_clip_transition_export() {
    let project = common::project(&catalog::basic(report::tier()));
    let rt = common::runtime();
    let fps = 30;
    let mut failures = Vec::new();
    for (name, cuts) in [
        ("forward", [(0.0, 2.0, 1.0), (3.0, 5.5, 1.0)]),
        ("backward", [(3.0, 5.5, 1.0), (0.5, 2.5, 1.0)]),
    ] {
        for decoder in Decoder::all() {
            let id = format!(
                "editing/export/same-clip-transition/{name}/{}",
                decoder.label()
            );
            if !report::selected(&id) {
                continue;
            }
            let mut config = project.config();
            common::set_cuts(&mut config, &cuts);
            common::add_transition(&mut config, 1, 0.8);
            let model = project.model(&config);
            let mut case = Case::new(&id);
            let dir = common::scratch_dir(&id);
            let run = ExportRun {
                custom_bpp: Some(MARKER_EXPORT_BPP),
                fps,
                resolution: (320, 180),
                format: Format::Mp4,
                decoder,
            };
            match rt.block_on(common::export(
                &project,
                config,
                &run,
                &dir.path().join("out.mp4"),
            )) {
                Err(e) => case.problem("error", format!("export failed: {e}")),
                Ok(out) => {
                    let frames = common::read_output(&out, Some(&|i| model.expect(i as u32, fps)));
                    common::check_sequence(&mut case, &model, &frames, fps, true);
                }
            }
            failures.extend(settle(case));
        }
    }
    common::assert_passed(failures);
}

/// Deterministic repro for `editing/mapping/duration-covered`: a 1 s
/// fullscreen text card at 5.4 s, then the clip trimmed to 3.2 s. The
/// timeline reports 4.2 s; the export must have as many frames.
#[test]
fn hold_past_end_export() {
    let id = "editing/export/hold-past-end";
    if !report::selected(id) {
        return;
    }
    let project = common::project(&catalog::basic(report::tier()));
    let mut config = project.config();
    let timeline = config.timeline.as_mut().expect("timeline");
    timeline
        .text_segments
        .push(edits::fullscreen_text(5.4, 6.4));
    timeline.segments[0].end = 3.2;
    let duration = timeline.duration();
    let fps = 30;
    let mut case = Case::new(id);
    let dir = common::scratch_dir(id);
    let run = ExportRun {
        custom_bpp: Some(MARKER_EXPORT_BPP),
        fps,
        resolution: (320, 180),
        format: Format::Mp4,
        decoder: Decoder::Default,
    };
    match common::runtime().block_on(common::export(
        &project,
        config,
        &run,
        &dir.path().join("out.mp4"),
    )) {
        Err(e) => case.problem("error", format!("export failed: {e}")),
        Ok(out) => {
            let frames = common::read_output(&out, None).len();
            let expected = (duration * f64::from(fps)).ceil() as usize;
            if frames == expected {
                case.note(format!("{frames} frames for the {duration:.3}s timeline"));
            } else {
                case.measure("frame-count", "missing", expected as f64 - frames as f64);
                case.problem(
                    "frame-count",
                    format!(
                        "{frames} frames exported, the {duration:.3}s timeline needs {expected}"
                    ),
                );
            }
        }
    }
    finish(case);
}

#[test]
fn shrinker_finds_the_minimal_sequence() {
    let base = edits::base_config(&[6.0]);
    let ops = vec![
        Op::Volume {
            segment: 0,
            volume: 0.5,
        },
        Op::Split {
            segment: 0,
            at: 0.5,
        },
        Op::Speed {
            segment: 1,
            timescale: 2.0,
        },
        Op::Move { from: 0, to: 1 },
    ];
    let fails = |ops: &[Op]| {
        let config = edits::replay(&base, ops);
        edits::timeline(&config)
            .segments
            .first()
            .is_some_and(|s| s.timescale == 2.0)
    };
    assert!(fails(&ops));
    let minimal = edits::shrink(&ops, fails);
    assert_eq!(minimal.len(), 3, "{minimal:?}");
    assert!(!minimal.iter().any(|op| matches!(op, Op::Volume { .. })));
}
