//! Playback oracle: the editor's decode + render path, driven offline frame
//! by frame, must show exactly the frames the model (and therefore the
//! export) shows: from the start, from the middle, through holds, across
//! cuts and backward timeline jumps.

mod common;

use cap_project::ProjectConfiguration;
use cap_verify::{
    catalog,
    fixture::{FixtureSpec, Rng},
    report::{self, Case, Tier},
};
use common::Decoder;

const RES: (u32, u32) = (480, 270);

fn no_edit(_: &mut ProjectConfiguration) {}

fn cuts(config: &mut ProjectConfiguration) {
    common::set_cuts(
        config,
        &[(0.5, 2.0, 1.0), (2.5, 4.0, 2.0), (1.0, 2.0, 0.5), (4.0, 5.8, 1.5)],
    );
}

fn backward_jumps(config: &mut ProjectConfiguration) {
    common::set_cuts(config, &[(5.0, 35.0, 1.0), (44.0, 50.0, 1.0), (28.0, 45.0, 1.0)]);
}

/// Plays `[start, end)` output frames sequentially (the first as a seek).
fn sequential(
    spec: FixtureSpec,
    edit: (&str, fn(&mut ProjectConfiguration)),
    fps: u32,
    start_fraction: f64,
) {
    let project = common::project(&spec);
    let rt = common::runtime();
    let mut failures = Vec::new();
    for decoder in Decoder::all() {
        let id = format!(
            "playback/{}/{}/seq{fps}-from{:.0}/{}",
            spec.name,
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
        let mut case = Case::new(&id);
        let frames: Vec<u32> = (first..total).collect();
        let result = rt.block_on(async {
            let mut player = common::Player::open(&project, config, decoder, RES).await?;
            let mut readouts = Vec::new();
            for &f in &frames {
                readouts.push(player.frame(f, fps, f == first).await?);
            }
            Ok::<_, String>(readouts)
        });
        match result {
            Ok(readouts) => common::check_requests(&mut case, &model, &frames, &readouts, fps),
            Err(e) => case.problem(e),
        }
        if let Err(message) = report::settle(case) {
            failures.push(message);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn basic_sequential() {
    sequential(catalog::basic(report::tier()), ("full", no_edit), 30, 0.0);
    sequential(catalog::basic(report::tier()), ("cuts-speeds-reorder", cuts), 60, 0.0);
}

#[test]
fn play_from_middle() {
    let seed = 0x9A1D_0001;
    let mut rng = Rng::new(seed);
    eprintln!("seed {seed:#x}");
    for _ in 0..2 {
        let start = 0.2 + rng.f64() * 0.6;
        sequential(catalog::basic(report::tier()), ("full", no_edit), 30, start);
    }
    sequential(catalog::vfr_holds(report::tier()), ("full", no_edit), 60, 0.3);
}

#[test]
fn vfr_holds_sequential() {
    sequential(catalog::vfr_holds(report::tier()), ("full", no_edit), 30, 0.0);
}

#[test]
fn backward_jumps_sequential() {
    sequential(catalog::backward_hold(report::tier()), ("backward-jumps", backward_jumps), 30, 0.0);
}

#[test]
fn jitter_camera_sequential() {
    let fps = if report::tier() == Tier::Full { 60 } else { 30 };
    sequential(catalog::jitter_camera(report::tier()), ("full", no_edit), fps, 0.0);
}

#[test]
fn multi_segment_sequential() {
    sequential(catalog::multi_segment(report::tier()), ("full", no_edit), 30, 0.0);
}
