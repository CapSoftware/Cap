//! Seek oracle: random seek storms, keyframe-exact seeks, scrubbing in both
//! directions, seeks into holds and cold opens, all checked against the
//! model. Seeds are fixed and printed; the full tier runs many more seeks.

mod common;

use cap_project::ProjectConfiguration;
use cap_verify::{
    catalog,
    fixture::{FixtureSpec, Rng},
    media,
    report::{self, Tier},
};
use common::{Decoder, Player};

const RES: (u32, u32) = (480, 270);

#[test]
fn paused_preview_at_timeline_end() {
    use std::{sync::Arc, time::Duration};

    use cap_editor::{AudioOutput, EditorFrameOutput, EditorInstance};
    use cap_project::XY;
    use cap_verify::fixture;
    use cap_verify::video_code::{FrameMarker, StreamKind};

    let id = "seek/basic/paused-end30/editor";
    if !report::selected(id) {
        return;
    }
    common::init();
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("preview.cap");
    let mut spec = catalog::basic(report::tier());
    spec.segments[0].mic = None;
    spec.segments[0].system_audio = None;
    fixture::write_fixture(&spec, &path).unwrap();
    let project = common::load("basic", path);
    let mut case = report::Case::new(id);
    let rt = common::runtime();
    rt.block_on(async {
        let (sender, receiver) = flume::unbounded();
        let (audio, _sink) = AudioOutput::new_offline();
        let instance = EditorInstance::new_with_audio_output(
            project.path.clone(),
            |_| {},
            Box::new(move |output, _| {
                if let EditorFrameOutput::Rgba(frame) = output {
                    let _ = sender.send(frame);
                }
            }),
            None,
            Arc::new(audio),
        )
        .await
        .unwrap();

        let result = async {
            for (cuts, requested, expected, expected_source) in [
                (vec![(0.0, 6.0, 1.0)], 0, 0, 0),
                (vec![(0.0, 6.0, 1.0)], 180, 179, 179),
                (vec![(3.0, 4.0, 1.0)], 179, 29, 119),
                (vec![(3.0, 4.01, 1.0)], 31, 30, 120),
                (vec![(3.0, 3.01, 1.0)], 1, 0, 90),
                (vec![(0.0, 31.0 / 30.0, 1.0)], 31, 30, 30),
                (vec![(0.0, 1.0, 1.0), (3.0, 4.0, 1.0)], 30, 30, 90),
            ] {
                let mut config = project.config();
                common::set_cuts(&mut config, &cuts);
                let model = project.model(&config);
                instance.project_config.0.send(config).unwrap();
                instance
                    .preview_tx
                    .send(Some((requested, 30, XY::new(RES.0, RES.1))))
                    .unwrap();
                let frame = tokio::time::timeout(Duration::from_secs(10), receiver.recv_async())
                    .await
                    .map_err(|_| {
                        format!("no preview for request {requested}, expected {expected}")
                    })?
                    .map_err(|e| e.to_string())?;
                if frame.frame_number != expected {
                    return Err(format!(
                        "request {requested}: got frame {}, expected {expected}",
                        frame.frame_number
                    ));
                }
                let view = cap_verify::video_code::PackedFrame {
                    data: &frame.data,
                    width: frame.width as usize,
                    height: frame.height as usize,
                    stride: frame.padded_bytes_per_row as usize,
                    order: cap_verify::video_code::PixelOrder::Rgba,
                };
                let readout = common::read_expecting(&view, &model.expect(expected, 30));
                for kind in StreamKind::ALL {
                    let marker = FrameMarker::new(kind, 0, expected_source);
                    if readout.get(kind).marker() != Some(marker) {
                        return Err(format!(
                            "request {requested}: got {:?}, expected {marker:?}",
                            readout.get(kind)
                        ));
                    }
                }
                common::check_requests(&mut case, &model, &[expected], &[readout], 30);
            }
            Ok::<_, String>(())
        }
        .await;
        instance.dispose().await;
        if let Err(error) = result {
            case.problem("error", error);
        }
    });
    report::settle(case).unwrap();
}

/// One request: output frame and whether it is a seek (vs a follow-on
/// playback frame).
type Request = (u32, bool);

fn run(
    spec: FixtureSpec,
    name: &str,
    fps: u32,
    edit: fn(&mut ProjectConfiguration),
    make: &dyn Fn(u32, &common::Project) -> Vec<Request>,
) -> Vec<String> {
    run_project(common::project(&spec), name, fps, edit, make)
}

fn run_project(
    project: common::Project,
    name: &str,
    fps: u32,
    edit: fn(&mut ProjectConfiguration),
    make: &dyn Fn(u32, &common::Project) -> Vec<Request>,
) -> Vec<String> {
    let rt = common::runtime();
    let mut failures = Vec::new();
    for decoder in Decoder::all() {
        let id = format!("seek/{}/{name}{fps}/{}", project.name, decoder.label());
        if !report::selected(&id) {
            continue;
        }
        let mut config = project.config();
        edit(&mut config);
        let model = project.model(&config);
        let requests = make(model.output_frames(fps), &project);
        let Some(mut case) = common::begin(&id, &project, decoder) else {
            continue;
        };
        case.note(format!("{} requests", requests.len()));
        let result = rt.block_on(async {
            let mut player = Player::open(&project, config, decoder, RES).await?;
            let mut readouts = Vec::new();
            for &(frame, seek) in &requests {
                readouts.push(
                    player
                        .frame(frame, fps, seek, Some(&model.expect(frame, fps)))
                        .await?,
                );
            }
            player.check_decoders(&mut case, decoder);
            Ok::<_, String>(readouts)
        });
        let frames: Vec<u32> = requests.iter().map(|r| r.0).collect();
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

fn no_edit(_: &mut ProjectConfiguration) {}

fn seek_count(fast: usize, full: usize) -> usize {
    match report::tier() {
        Tier::Fast => fast,
        Tier::Full => full,
    }
}

/// Random seeks, each followed by 0..=3 playback frames.
fn storm(seed: u64, count: usize) -> impl Fn(u32, &common::Project) -> Vec<Request> {
    move |total, _| {
        eprintln!("seek storm seed {seed:#x}, {count} seeks");
        let mut rng = Rng::new(seed);
        let mut out = Vec::new();
        for _ in 0..count {
            let frame = rng.range(0, u64::from(total - 4)) as u32;
            out.push((frame, true));
            for k in 1..=rng.range(0, 3) as u32 {
                out.push((frame + k, false));
            }
        }
        out
    }
}

// One test per fixture: a storm is the slowest seek workload (FULL tier on
// the macos-15 runner: 240 to 570 s per decoder), and as one test the three
// storms of a shard ran past nextest's per-test limit.
#[test]
fn storm_seek_gop() {
    let count = seek_count(150, 3000);
    common::assert_passed(run(
        catalog::seek_gop(report::tier()),
        "storm",
        30,
        no_edit,
        &storm(0x5EE4_0001, count),
    ));
}

#[test]
fn storm_vfr_holds() {
    let count = seek_count(150, 3000);
    common::assert_passed(run(
        catalog::vfr_holds(report::tier()),
        "storm",
        60,
        no_edit,
        &storm(0x5EE4_0002, count),
    ));
}

#[test]
fn storm_seek_native() {
    let count = seek_count(150, 3000);
    common::assert_passed(run(
        catalog::seek_gop_native(report::tier()),
        "storm",
        30,
        no_edit,
        &storm(0x5EE4_0004, count),
    ));
}

/// Seeks landing on and around every source keyframe, at 60 fps output so
/// requests also fall between the keyframe's pts and the next source slot,
/// in shuffled order: a reader started a hair before the keyframe decodes
/// the previous GOP and shows its last frame under the keyframe's number.
#[test]
fn keyframe_seeks() {
    let mut failures: Vec<String> = Vec::new();
    let keyframes = |total: u32, project: &common::Project| {
        let display = project.path.join("content/segments/segment-0/display.mp4");
        let times = media::keyframe_times(&display).expect("keyframes");
        let mut frames: Vec<u32> = times
            .iter()
            .flat_map(|t| {
                let f = (t * 60.0).round() as u32;
                [f, f.saturating_sub(1), f + 1, f + 2]
            })
            .filter(|&f| f < total)
            .collect();
        let mut rng = Rng::new(0x5EE4_0003);
        for i in (1..frames.len()).rev() {
            let j = rng.range(0, i as u64) as usize;
            frames.swap(i, j);
        }
        frames.into_iter().map(|f| (f, true)).collect()
    };
    failures.extend(run(
        catalog::seek_gop(report::tier()),
        "keyframes",
        60,
        no_edit,
        &keyframes,
    ));
    failures.extend(run(
        catalog::seek_gop_native(report::tier()),
        "keyframes",
        60,
        no_edit,
        &keyframes,
    ));
    common::assert_passed(failures);
}

/// The editor's "jump to start" after watching later in the file, then a
/// click 2 s in and playback: seek 6.1 s, seek 0, seek 2.0 s and play 4 s.
#[test]
fn home_then_play() {
    let mut failures: Vec<String> = Vec::new();
    let home = |total: u32, _: &common::Project| {
        let fps = 30.0;
        let mut out: Vec<Request> = vec![((6.1 * fps) as u32, true), (0, true)];
        let start = (2.0 * fps) as u32;
        out.push((start, true));
        out.extend((1..=120).map(|k| (start + k, false)));
        out.retain(|&(f, _)| f < total);
        out
    };
    failures.extend(run(
        catalog::seek_gop(report::tier()),
        "home-then-play",
        30,
        no_edit,
        &home,
    ));
    common::assert_passed(failures);
}

/// Scrubbing: seek every 0.25 s forwards, then backwards.
#[test]
fn scrub() {
    let mut failures: Vec<String> = Vec::new();
    let scrub = |total: u32, _: &common::Project| {
        let step = 7;
        let mut out: Vec<Request> = (0..total).step_by(step).map(|f| (f, true)).collect();
        out.extend((0..total).rev().step_by(step).map(|f| (f, true)));
        out
    };
    failures.extend(run(
        catalog::seek_gop(report::tier()),
        "scrub",
        30,
        no_edit,
        &scrub,
    ));
    failures.extend(run(
        catalog::vfr_holds(report::tier()),
        "scrub",
        60,
        no_edit,
        &scrub,
    ));
    common::assert_passed(failures);
}

/// Ad-hoc repro runner: `CAP_VERIFY_SEEK_SCRIPT="<fixture>@<fps>:<secs>+<follow>,..."`
/// seeks to each time and plays `follow` frames after it (fixtures:
/// seek-gop, seek-native, vfr-holds). Ignored without the variable.
#[test]
fn script() {
    let Ok(script) = std::env::var("CAP_VERIFY_SEEK_SCRIPT") else {
        return;
    };
    let (head, steps) = script.split_once(':').expect("<fixture>@<fps>:<steps>");
    let (fixture, fps) = head.split_once('@').expect("<fixture>@<fps>");
    let fps: u32 = fps.parse().expect("fps");
    let spec = match fixture {
        "seek-gop" => catalog::seek_gop(report::tier()),
        "seek-native" => catalog::seek_gop_native(report::tier()),
        "vfr-holds" => catalog::vfr_holds(report::tier()),
        other => panic!("unknown fixture {other}"),
    };
    let steps: Vec<(f64, u32)> = steps
        .split(',')
        .map(|step| {
            let (t, n) = step.split_once('+').unwrap_or((step, "0"));
            (t.parse().expect("secs"), n.parse().expect("follow"))
        })
        .collect();
    let make = move |total: u32, _: &common::Project| {
        let mut out = Vec::new();
        for &(t, n) in &steps {
            let f = ((t * f64::from(fps)) as u32).min(total - 1);
            out.push((f, true));
            out.extend((1..=n).map(|k| (f + k, false)).filter(|&(f, _)| f < total));
        }
        out
    };
    common::assert_passed(run(spec, "script", fps, no_edit, &make));
}

/// Seeks into the middle of static holds and across them, then playback
/// out of the hold.
#[test]
fn seek_into_holds() {
    let mut failures: Vec<String> = Vec::new();
    let into_holds = |total: u32, _: &common::Project| {
        let mut out = Vec::new();
        for t in [2.0, 3.5, 1.2, 9.0, 11.1, 5.2, 7.05, 2.3] {
            let f = (t * 60.0) as u32;
            if f + 30 < total {
                out.push((f, true));
                out.extend((1..30).map(|k| (f + k, false)));
            }
        }
        out
    };
    failures.extend(run(
        catalog::vfr_holds(report::tier()),
        "into-holds",
        60,
        no_edit,
        &into_holds,
    ));
    // Minimal deterministic sequence for the AVAssetReader camera answering
    // one frame stale after revisiting a region (found by into-holds).
    let revisit = |total: u32, _: &common::Project| {
        let mut out = Vec::new();
        for t in [2.0, 3.5, 1.2, 2.3] {
            let f = (t * 60.0) as u32;
            if f + 30 < total {
                out.push((f, true));
                out.extend((1..30).map(|k| (f + k, false)));
            }
        }
        out
    };
    failures.extend(run(
        catalog::vfr_holds(report::tier()),
        "revisit",
        60,
        no_edit,
        &revisit,
    ));
    common::assert_passed(failures);
}

/// The first frame after opening a project, at several positions.
#[test]
fn cold_open() {
    let spec = catalog::seek_gop(report::tier());
    let project = common::project(&spec);
    let rt = common::runtime();
    let mut failures = Vec::new();
    for decoder in Decoder::all() {
        let id = format!("seek/{}/cold-open30/{}", project.name, decoder.label());
        if !report::selected(&id) {
            continue;
        }
        let config = project.config();
        let model = project.model(&config);
        let total = model.output_frames(30);
        let frames: Vec<u32> = [0.0, 0.37, 0.71, 0.93]
            .iter()
            .map(|p| (f64::from(total - 1) * p) as u32)
            .collect();
        let Some(mut case) = common::begin(&id, &project, decoder) else {
            continue;
        };
        let mut readouts = Vec::new();
        for &frame in &frames {
            let result = rt.block_on(async {
                let mut player = Player::open(&project, config.clone(), decoder, RES).await?;
                let readout = player.frame(frame, 30, true, None).await;
                player.check_decoders(&mut case, decoder);
                readout
            });
            match result {
                Ok(readout) => readouts.push(readout),
                Err(e) => case.problem("error", e),
            }
        }
        if readouts.len() == frames.len() {
            common::check_requests(&mut case, &model, &frames, &readouts, 30);
        }
        if let Err(message) = report::settle(case) {
            failures.push(message);
        }
    }
    common::assert_passed(failures);
}
