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

fn camera_green_screen(config: &mut ProjectConfiguration) {
    config.camera.chroma_key = Some(cap_project::ChromaKey::default());
}

#[test]
fn edits_sequential() {
    let mut failures = Vec::new();
    for edit in [
        ("transition", transition as fn(&mut ProjectConfiguration)),
        ("hide-camera-scene", hide_camera_scene),
        ("camera-hidden", camera_hidden),
        ("camera-green-screen", camera_green_screen),
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

/// Real-time audio/video sync at an editor preview speed. Plays a long
/// fixture with sample-accurate audio markers through the editor's own
/// playback engine and a device-paced headless audio sink, notes the wall
/// time each marker becomes audible and where the video clock stands at that
/// moment, and reports how far apart they are over the whole run. It takes as
/// long as it measures, so it only runs on request:
/// `CAP_VERIFY_SYNC_SPEED=2 CAP_VERIFY_SYNC_SECS=300 cargo test -p cap-verify
/// --test playback preview_speed_av_sync -- --ignored --nocapture`.
#[test]
#[ignore = "real-time measurement that runs for minutes"]
fn preview_speed_av_sync() {
    use cap_verify::{
        audio_code::{self, AudioSource},
        fixture::{AudioTrackSpec, SegmentSpec, Timing, VideoTrackSpec},
    };
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    const PLAYBACK_FPS: u32 = 60;
    const ONSET_LEVEL: f32 = 0.02;
    const ONSET_SILENCE_SECS: f64 = 0.06;
    const WARMUP_SECS: f64 = 2.0;

    let env = |name: &str, default: f64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(default)
    };
    let speed = cap_editor::PreviewSpeed::from_f64(env("CAP_VERIFY_SYNC_SPEED", 2.0))
        .expect("CAP_VERIFY_SYNC_SPEED must be an offered preview speed");
    let seconds = env("CAP_VERIFY_SYNC_SECS", 300.0);
    let duration = (seconds * speed.as_f64() + 10.0).ceil();
    let spec = FixtureSpec {
        name: format!("av-sync-{duration:.0}s"),
        segments: vec![SegmentSpec {
            display: VideoTrackSpec::new(320, 180, 30, Timing::Constant { duration }),
            camera: None,
            mic: Some(AudioTrackSpec {
                source: AudioSource::Mic,
                sample_rate: 48_000,
                channels: 1,
                duration,
                start_time: 0.0,
            }),
            system_audio: None,
        }],
    };
    let project = common::project(&spec);
    let schedule: Vec<f64> =
        audio_code::standard_schedule(AudioSource::Mic, 0.1, duration - 0.1, 0.5)
            .into_iter()
            .map(|marker| marker.time_secs)
            .collect();

    let frames: Arc<Mutex<Vec<(Instant, u32)>>> = Default::default();
    let onsets: Arc<Mutex<Vec<Instant>>> = Default::default();
    let rate = f64::from(cap_editor::HEADLESS_SAMPLE_RATE);
    let channels = usize::from(cap_editor::HEADLESS_CHANNELS);
    let tap: cap_editor::HeadlessAudioTap = {
        let onsets = onsets.clone();
        let mut quiet = usize::MAX;
        let silence = (ONSET_SILENCE_SECS * rate) as usize;
        Box::new(move |block: &[f32], deadline: Instant| {
            for (index, frame) in block.chunks(channels).enumerate() {
                if frame[0].abs() >= ONSET_LEVEL {
                    if quiet >= silence {
                        onsets
                            .lock()
                            .unwrap()
                            .push(deadline + Duration::from_secs_f64(index as f64 / rate));
                    }
                    quiet = 0;
                } else {
                    quiet = quiet.saturating_add(1);
                }
            }
        })
    };

    let rt = common::runtime();
    let result: Result<(), String> = rt.block_on(async {
        let meta = project.meta.studio_meta().ok_or("not studio")?.clone();
        let recordings = cap_rendering::ProjectRecordingsMeta::new(&project.path, &meta)?;
        let constants = Arc::new(
            cap_rendering::RenderVideoConstants::new(
                &recordings.segments,
                project.meta.clone(),
                meta.clone(),
            )
            .await
            .map_err(|e| format!("render constants: {e}"))?,
        );
        let segments = Arc::new(cap_editor::create_segments(&project.meta, &meta, false).await?);
        let config = project.config();
        let layers = cap_editor::start_renderer_layers_creation(&constants, &config);
        let layers = cap_editor::finish_renderer_layers_creation(layers).await;
        let sink = frames.clone();
        let frame_cb: cap_editor::EditorFrameCallback = Box::new(move |output, _| {
            if let cap_editor::EditorFrameOutput::Rgba(frame) = output {
                sink.lock()
                    .unwrap()
                    .push((Instant::now(), frame.frame_number));
            }
        });
        let renderer = Arc::new(cap_editor::Renderer::spawn(
            constants.clone(),
            frame_cb,
            layers,
        )?);
        let (_project_tx, project_rx) = tokio::sync::watch::channel(config);
        let playback = cap_editor::Playback {
            renderer: renderer.clone(),
            render_constants: constants,
            start_frame_number: 0,
            project: project_rx,
            segment_medias: segments,
            music: cap_editor::MusicTracks::new(),
            audio_output: Arc::new(cap_editor::AudioOutput::new_headless(tap)),
            telemetry: None,
            preview_speed: cap_editor::PreviewSpeedHandle::new(speed),
        };
        let handle = playback
            .start(PLAYBACK_FPS, cap_project::XY::new(320, 180))
            .await
            .map_err(|e| format!("playback start: {e:?}"))?;
        tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
        handle.stop();
        tokio::time::sleep(Duration::from_millis(300)).await;
        renderer.stop().await;
        Ok(())
    });
    result.expect("real-time playback");

    let frames = std::mem::take(&mut *frames.lock().unwrap());
    let onsets = std::mem::take(&mut *onsets.lock().unwrap());
    let first = frames.first().expect("no video frames were delivered").0;
    let video_secs = |at: Instant| -> Option<f64> {
        let index = frames.partition_point(|(time, _)| *time <= at);
        let (time, frame) = frames.get(index.checked_sub(1)?)?;
        Some(
            f64::from(*frame) / f64::from(PLAYBACK_FPS)
                + at.saturating_duration_since(*time).as_secs_f64() * speed.as_f64(),
        )
    };
    let mut drifts: Vec<(f64, f64)> = Vec::new();
    for onset in &onsets {
        if onset.saturating_duration_since(first).as_secs_f64() < WARMUP_SECS {
            continue;
        }
        let Some(video) = video_secs(*onset) else {
            continue;
        };
        let nearest = schedule
            .iter()
            .copied()
            .min_by(|a, b| (a - video).abs().total_cmp(&(b - video).abs()))
            .unwrap();
        if (nearest - video).abs() < 0.2 {
            drifts.push((
                onset.saturating_duration_since(first).as_secs_f64(),
                nearest - video,
            ));
        }
    }
    assert!(
        drifts.len() > 10,
        "only {} markers were heard",
        drifts.len()
    );
    let values: Vec<f64> = drifts.iter().map(|(_, drift)| *drift).collect();
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let spread =
        (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64).sqrt();
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let minute = |from: f64, to: f64| {
        let window: Vec<f64> = drifts
            .iter()
            .filter(|(at, _)| (from..to).contains(at))
            .map(|(_, drift)| *drift)
            .collect();
        window.iter().sum::<f64>() / window.len().max(1) as f64
    };
    let end = drifts.last().map_or(0.0, |(at, _)| *at);
    let first_minute = minute(WARMUP_SECS, WARMUP_SECS + 60.0);
    let last_minute = minute(end - 60.0, end + 1.0);
    let mut heard: Vec<f64> = Vec::new();
    for onset in &onsets {
        if let Some(video) = video_secs(*onset)
            && onset.saturating_duration_since(first).as_secs_f64() >= WARMUP_SECS
            && let Some(nearest) = schedule
                .iter()
                .copied()
                .filter(|time| (time - video).abs() < 0.2)
                .min_by(|a, b| (a - video).abs().total_cmp(&(b - video).abs()))
            && !heard.contains(&nearest)
        {
            heard.push(nearest);
        }
    }
    let span = heard.first().copied().unwrap_or(0.0)..=heard.last().copied().unwrap_or(0.0);
    let expected_markers = schedule.iter().filter(|time| span.contains(time)).count();
    let timeline_heard = span.end() - span.start();
    println!(
        "preview {} for {seconds:.0}s: {} of {expected_markers} markers heard over {timeline_heard:.0}s of timeline, audio minus video: mean {:+.1} ms, sd {:.1} ms, min {:+.1} ms, max {:+.1} ms, first minute {:+.1} ms, last minute {:+.1} ms, drift {:+.1} ms",
        speed.label(),
        heard.len(),
        mean * 1000.0,
        spread * 1000.0,
        min * 1000.0,
        max * 1000.0,
        first_minute * 1000.0,
        last_minute * 1000.0,
        (last_minute - first_minute) * 1000.0,
    );
    assert!(
        heard.len() * 100 >= expected_markers * 98,
        "{} of {expected_markers} markers were heard",
        heard.len()
    );
    let tolerance = 0.045 * speed.as_f64().max(1.0);
    assert!(
        min > -tolerance && max < tolerance,
        "audio and video drifted apart by more than {:.0} ms of timeline",
        tolerance * 1000.0
    );
}
