//! Export oracle: every exported frame must show exactly the source frames
//! the reference model computes, for both streams, on every decoder.

mod common;

use cap_project::{ProjectConfiguration, SceneMode, SceneSegment};
use cap_verify::{
    catalog,
    fixture::FixtureSpec,
    report::{self, Case, Tier},
};
use common::{Decoder, ExportRun, Format};

struct Variant {
    edit: &'static str,
    apply: fn(&mut ProjectConfiguration),
}

fn no_edit(_: &mut ProjectConfiguration) {}

fn case_id(fixture: &str, edit: &str, format: Format, fps: u32, decoder: Decoder) -> String {
    let format = match format {
        Format::Mp4 => "mp4",
        Format::Gif => "gif",
    };
    format!("export/{fixture}/{edit}/{format}{fps}/{}", decoder.label())
}

/// Exports `spec` with each edit, format, rate and decoder and checks every
/// frame. With `determinism`, the first combination is exported twice and
/// the decoded pictures must be identical.
fn run(
    spec: FixtureSpec,
    variants: &[Variant],
    formats: &[(Format, u32)],
    decoders: &[Decoder],
    resolution: (u32, u32),
    determinism: bool,
) -> Vec<String> {
    let project = common::project(&spec);
    let rt = common::runtime();
    let mut failures = Vec::new();
    for variant in variants {
        for &(format, fps) in formats {
            for &decoder in decoders {
                let id = case_id(&spec.name, variant.edit, format, fps, decoder);
                if !report::selected(&id) {
                    continue;
                }
                let mut config = project.config();
                (variant.apply)(&mut config);
                let model = project.model(&config);
                let mut case = Case::new(&id);
                let dir = common::scratch_dir(&id);
                let ext = if format == Format::Gif { "gif" } else { "mp4" };
                let run = ExportRun {
                    fps,
                    resolution,
                    format,
                    decoder,
                };
                let first = dir.path().join(format!("a.{ext}"));
                match rt.block_on(common::export(&project, config.clone(), &run, &first)) {
                    Err(e) => case.problem("error", format!("export failed: {e}")),
                    Ok(path) => {
                        let frames = common::read_output(&path);
                        common::check_sequence(
                            &mut case,
                            &model,
                            &frames,
                            fps,
                            format == Format::Mp4,
                        );
                        if determinism {
                            let second = dir.path().join(format!("b.{ext}"));
                            match rt.block_on(common::export(&project, config, &run, &second)) {
                                Err(e) => {
                                    case.problem("error", format!("second export failed: {e}"))
                                }
                                Ok(path) => {
                                    let again = common::read_output(&path);
                                    let differing: Vec<usize> = frames
                                        .iter()
                                        .zip(&again)
                                        .enumerate()
                                        .filter(|(_, (a, b))| a.hash != b.hash)
                                        .map(|(i, _)| i)
                                        .collect();
                                    if !differing.is_empty() || frames.len() != again.len() {
                                        case.problem(
                                            "nondeterministic",
                                            format!(
                                            "nondeterministic: {} of {} frames differ between two exports (first {:?})",
                                            differing.len(),
                                            frames.len(),
                                            &differing[..differing.len().min(5)]
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
                if let Err(message) = report::settle(case) {
                    failures.push(message);
                }
            }
        }
    }
    failures
}

const RES: (u32, u32) = (480, 270);

fn cuts_speeds_reorder(config: &mut ProjectConfiguration) {
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

fn transition(config: &mut ProjectConfiguration) {
    common::set_cuts(config, &[(0.0, 2.5, 1.0), (3.5, 6.0, 1.0)]);
    common::add_transition(config, 1, 0.4);
}

fn camera_hidden(config: &mut ProjectConfiguration) {
    config.camera.hide = true;
}

fn hide_camera_scene(config: &mut ProjectConfiguration) {
    config
        .timeline
        .as_mut()
        .expect("timeline")
        .scene_segments
        .push(SceneSegment {
            start: 2.0,
            end: 4.0,
            mode: SceneMode::HideCamera,
            split_layout: None,
            transition_in: 0.3,
            transition_out: 0.3,
        });
}

#[test]
fn basic() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(run(
        catalog::basic(report::tier()),
        &[
            Variant {
                edit: "full",
                apply: no_edit,
            },
            Variant {
                edit: "cuts-speeds-reorder",
                apply: cuts_speeds_reorder,
            },
            Variant {
                edit: "transition",
                apply: transition,
            },
            Variant {
                edit: "camera-hidden",
                apply: camera_hidden,
            },
            Variant {
                edit: "hide-camera-scene",
                apply: hide_camera_scene,
            },
        ],
        &[(Format::Mp4, 30), (Format::Mp4, 60)],
        &Decoder::all(),
        RES,
        false,
    ));
    common::assert_passed(failures);
}

#[test]
fn gif() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(run(
        catalog::basic(report::tier()),
        &[Variant {
            edit: "cuts-speeds-reorder",
            apply: cuts_speeds_reorder,
        }],
        &[(Format::Gif, 15)],
        &[Decoder::Default],
        (320, 180),
        false,
    ));
    common::assert_passed(failures);
}

#[test]
fn vfr_holds() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(run(
        catalog::vfr_holds(report::tier()),
        &[Variant {
            edit: "full",
            apply: no_edit,
        }],
        &[(Format::Mp4, 30), (Format::Mp4, 60)],
        &Decoder::all(),
        RES,
        false,
    ));
    common::assert_passed(failures);
}

/// Long recordings with a jittery ~12 fps camera at 30 fps nominal exported
/// at 60 fps: the camera must never run ahead of the screen.
#[test]
fn jitter_camera() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(run(
        catalog::jitter_camera(report::tier()),
        &[Variant {
            edit: "full",
            apply: no_edit,
        }],
        &[(Format::Mp4, 60)],
        &Decoder::all(),
        RES,
        report::tier() == Tier::Full,
    ));
    common::assert_passed(failures);
}

fn backward_jumps(config: &mut ProjectConfiguration) {
    common::set_cuts(
        config,
        &[(5.0, 35.0, 1.0), (44.0, 50.0, 1.0), (28.0, 45.0, 1.0)],
    );
}

/// Play past a long hold, elsewhere, then jump back into the hold.
#[test]
fn backward_hold() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(run(
        catalog::backward_hold(report::tier()),
        &[Variant {
            edit: "backward-jumps",
            apply: backward_jumps,
        }],
        &[(Format::Mp4, 30), (Format::Mp4, 60)],
        &Decoder::all(),
        RES,
        false,
    ));
    common::assert_passed(failures);
}

#[test]
fn start_offsets() {
    let mut failures: Vec<String> = Vec::new();
    for spec in [
        catalog::late_camera(report::tier()),
        catalog::early_camera(report::tier()),
        catalog::camera_pts_late(report::tier()),
    ] {
        failures.extend(run(
            spec,
            &[Variant {
                edit: "full",
                apply: no_edit,
            }],
            &[(Format::Mp4, 30)],
            &Decoder::all(),
            RES,
            false,
        ));
    }
    common::assert_passed(failures);
}

#[test]
fn multi_segment() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(run(
        catalog::multi_segment(report::tier()),
        &[Variant {
            edit: "full",
            apply: no_edit,
        }],
        &[(Format::Mp4, 30)],
        &Decoder::all(),
        RES,
        true,
    ));
    common::assert_passed(failures);
}
