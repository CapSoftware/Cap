//! Playback oracle: the editor's decode + render path, driven offline frame
//! by frame, must show exactly the frames the model (and therefore the
//! export) shows: from the start, from the middle, through holds, across
//! cuts and backward timeline jumps.

mod common;

use cap_project::ProjectConfiguration;
use cap_verify::{
    catalog,
    fixture::{FixtureSpec, Rng},
    report::{self, Tier},
};
use common::Decoder;

const RES: (u32, u32) = (480, 270);

fn no_edit(_: &mut ProjectConfiguration) {}

fn cuts(config: &mut ProjectConfiguration) {
    common::set_cuts(
        config,
        &[
            (0.5, 2.0, 1.0),
            (2.5, 4.0, 2.0),
            (1.0, 2.0, 0.5),
            (4.0, 5.8, 1.5),
        ],
    );
}

fn backward_jumps(config: &mut ProjectConfiguration) {
    common::set_cuts(
        config,
        &[(5.0, 35.0, 1.0), (44.0, 50.0, 1.0), (28.0, 45.0, 1.0)],
    );
}

/// Plays `[start, end)` output frames sequentially (the first as a seek).
fn sequential(
    spec: FixtureSpec,
    edit: (&str, fn(&mut ProjectConfiguration)),
    fps: u32,
    start_fraction: f64,
) -> Vec<String> {
    sequential_project(common::project(&spec), edit, fps, start_fraction)
}

fn sequential_project(
    project: common::Project,
    edit: (&str, fn(&mut ProjectConfiguration)),
    fps: u32,
    start_fraction: f64,
) -> Vec<String> {
    let rt = common::runtime();
    let mut failures = Vec::new();
    for decoder in Decoder::all() {
        let id = format!(
            "playback/{}/{}/seq{fps}-from{:.0}/{}",
            project.name,
            edit.0,
            start_fraction * 100.0,
            decoder.label()
        );
        if !report::selected(&id) {
            continue;
        }
        let mut config = project.config();
        (edit.1)(&mut config);
        let model = project.model(&config);
        let total = model.output_frames(fps);
        let first = (f64::from(total) * start_fraction) as u32;
        let Some(mut case) = common::begin(&id, &project, decoder) else {
            continue;
        };
        let frames: Vec<u32> = (first..total).collect();
        let result = rt.block_on(async {
            let mut player = common::Player::open(&project, config, decoder, RES).await?;
            let mut readouts = Vec::new();
            for &f in &frames {
                readouts.push(
                    player
                        .frame(f, fps, f == first, Some(&model.expect(f, fps)))
                        .await?,
                );
            }
            player.check_decoders(&mut case, decoder);
            Ok::<_, String>(readouts)
        });
        match result {
            Ok(readouts) => common::check_requests(&mut case, &model, &frames, &readouts, fps),
            Err(e) => case.problem("error", e),
        }
        if let Err(message) = report::settle(case) {
            failures.push(message);
        }
    }
    failures
}

#[test]
fn basic_sequential() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(sequential(
        catalog::basic(report::tier()),
        ("full", no_edit),
        30,
        0.0,
    ));
    failures.extend(sequential(
        catalog::basic(report::tier()),
        ("cuts-speeds-reorder", cuts),
        60,
        0.0,
    ));
    common::assert_passed(failures);
}

#[test]
fn play_from_middle() {
    let mut failures: Vec<String> = Vec::new();
    let seed = 0x9A1D_0001;
    let mut rng = Rng::new(seed);
    eprintln!("seed {seed:#x}");
    for _ in 0..2 {
        let start = 0.2 + rng.f64() * 0.6;
        failures.extend(sequential(
            catalog::basic(report::tier()),
            ("full", no_edit),
            30,
            start,
        ));
    }
    failures.extend(sequential(
        catalog::vfr_holds(report::tier()),
        ("full", no_edit),
        60,
        0.3,
    ));
    common::assert_passed(failures);
}

#[test]
fn vfr_holds_sequential() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(sequential(
        catalog::vfr_holds(report::tier()),
        ("full", no_edit),
        30,
        0.0,
    ));
    common::assert_passed(failures);
}

#[test]
fn backward_jumps_sequential() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(sequential(
        catalog::backward_hold(report::tier()),
        ("backward-jumps", backward_jumps),
        30,
        0.0,
    ));
    common::assert_passed(failures);
}

#[test]
fn jitter_camera_sequential() {
    let mut failures: Vec<String> = Vec::new();
    let fps = if report::tier() == Tier::Full { 60 } else { 30 };
    failures.extend(sequential(
        catalog::jitter_camera(report::tier()),
        ("full", no_edit),
        fps,
        0.0,
    ));
    common::assert_passed(failures);
}

#[test]
fn multi_segment_sequential() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(sequential(
        catalog::multi_segment(report::tier()),
        ("full", no_edit),
        30,
        0.0,
    ));
    common::assert_passed(failures);
}

#[test]
fn recorded_studio_sequential() {
    let failures = sequential_project(
        common::recorded(&catalog::recorded_studio(report::tier())),
        ("full", no_edit),
        60,
        0.0,
    );
    common::assert_passed(failures);
}

fn transition(config: &mut ProjectConfiguration) {
    common::set_cuts(config, &[(0.0, 2.5, 1.0), (3.5, 6.0, 1.0)]);
    common::add_transition(config, 1, 0.4);
}

fn hide_camera_scene(config: &mut ProjectConfiguration) {
    config
        .timeline
        .as_mut()
        .expect("timeline")
        .scene_segments
        .push(cap_project::SceneSegment {
            start: 2.0,
            end: 4.0,
            mode: cap_project::SceneMode::HideCamera,
            split_layout: None,
            transition_in: 0.3,
            transition_out: 0.3,
        });
}

fn camera_hidden(config: &mut ProjectConfiguration) {
    config.camera.hide = true;
}

#[test]
fn edits_sequential() {
    let mut failures = Vec::new();
    for edit in [
        ("transition", transition as fn(&mut ProjectConfiguration)),
        ("hide-camera-scene", hide_camera_scene),
        ("camera-hidden", camera_hidden),
    ] {
        failures.extend(sequential(catalog::basic(report::tier()), edit, 30, 0.0));
        failures.extend(sequential(catalog::basic(report::tier()), edit, 60, 0.0));
    }
    common::assert_passed(failures);
}

/// Longest acceptable real-time playback warm-up (measured at most 0.53 s,
/// WARP-rendered Windows included).
const REALTIME_WARMUP_LIMIT: std::time::Duration = std::time::Duration::from_secs(2);

/// The real-time playback loop (`cap_editor::Playback`), not just the decode
/// and render path: every frame it delivers must show what the model puts at
/// that frame number. Frames may be dropped under load (macOS CI presents at
/// a few fps); at least `MIN_DELIVERED` must arrive once the clock has
/// started. Under a machine stall the starvation sentinel makes a `dropped`
/// failure inconclusive and the test is retried once.
#[test]
fn realtime_loop() {
    const MIN_DELIVERED: usize = 8;
    let rt = common::runtime();
    let mut failures = Vec::new();
    let project = common::project(&catalog::basic(report::tier()));
    for (edit, apply, start_fraction) in [
        ("full", no_edit as fn(&mut ProjectConfiguration), 0.0),
        ("cuts-speeds-reorder", cuts, 0.25),
        ("transition", transition, 0.2),
    ] {
        for decoder in Decoder::all() {
            let id = format!(
                "playback/{}/{edit}/realtime30-from{:.0}/{}",
                project.name,
                start_fraction * 100.0,
                decoder.label()
            );
            if !report::selected(&id) {
                continue;
            }
            let mut config = project.config();
            apply(&mut config);
            let model = project.model(&config);
            let total = model.output_frames(30);
            let first = (f64::from(total) * start_fraction) as u32;
            let seconds = f64::from(total - first) / 30.0 + 0.5;
            let Some(mut case) = common::begin(&id, &project, decoder) else {
                continue;
            };
            match rt.block_on(common::realtime_playback(
                &mut case,
                &project,
                config,
                decoder,
                RES,
                30,
                first,
                seconds,
                &|f| model.expect(f, 30),
            )) {
                Err(e) => case.problem("error", e),
                Ok((delivered, telemetry)) => {
                    case.note(telemetry.describe());
                    let delivered: Vec<_> =
                        delivered.into_iter().filter(|(f, _)| *f < total).collect();
                    // Performance floor, relative to what the runner class
                    // delivers (measured on runs 38841247123, 38844291490 and
                    // 38846099909): macOS and Linux present 0.88 to 0.99 of
                    // the frames; warm-up took at most 0.53 s. Windows CI
                    // renders on the WARP software rasterizer, whose speed
                    // (0.13 to 0.96 of the frames on Blacksmith, run
                    // 38851482675, depending on the fixture) measures WARP,
                    // not Cap, so only the identity checks and the minimum
                    // below apply there. A wall-clock class: a proven
                    // machine stall makes it inconclusive, never excused.
                    let floor = if cfg!(windows) { 0.0 } else { 0.75 };
                    let due = (total - first) as usize;
                    let share = delivered.len() as f64 / due.max(1) as f64;
                    if let Some(ready) = telemetry.ready_after
                        && ready > REALTIME_WARMUP_LIMIT
                    {
                        case.measure("dropped", "warm-up-s", ready.as_secs_f64());
                        case.problem(
                            "dropped",
                            format!(
                                "playback took {:.2} s to start (limit {:.1} s)",
                                ready.as_secs_f64(),
                                REALTIME_WARMUP_LIMIT.as_secs_f64()
                            ),
                        );
                    }
                    if telemetry.ready_after.is_some() && share < floor {
                        case.measure("dropped", "delivered-share", share);
                        case.problem(
                            "dropped",
                            format!(
                                "real-time playback presented {} of {due} frames ({:.0}%, floor {:.0}% on this runner class)",
                                delivered.len(),
                                share * 100.0,
                                floor * 100.0
                            ),
                        );
                    }
                    if telemetry.ready_after.is_none() {
                        case.problem(
                            "dropped",
                            "the playback clock never started (warm-up did not finish within 20 s)",
                        );
                    } else if delivered.len() < MIN_DELIVERED {
                        case.problem(
                            "dropped",
                            format!(
                                "real-time playback delivered {} frames after it was ready, expected at least {MIN_DELIVERED} ({})",
                                delivered.len(),
                                telemetry.describe()
                            ),
                        );
                    }
                    let frames: Vec<u32> = delivered.iter().map(|(f, _)| *f).collect();
                    let readouts: Vec<_> = delivered.into_iter().map(|(_, r)| r).collect();
                    common::check_requests(&mut case, &model, &frames, &readouts, 30);
                }
            }
            if let Err(message) = report::settle(case) {
                failures.push(message);
            }
        }
    }
    common::assert_passed(failures);
}
