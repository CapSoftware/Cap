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
        Format::Mov => "mov",
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
    run_project(
        common::project(&spec),
        variants,
        formats,
        decoders,
        resolution,
        determinism,
    )
}

fn run_project(
    project: common::Project,
    variants: &[Variant],
    formats: &[(Format, u32)],
    decoders: &[Decoder],
    resolution: (u32, u32),
    determinism: bool,
) -> Vec<String> {
    let rt = common::runtime();
    let mut failures = Vec::new();
    for variant in variants {
        for &(format, fps) in formats {
            for &decoder in decoders {
                let id = case_id(&project.name, variant.edit, format, fps, decoder);
                if !report::selected(&id) {
                    continue;
                }
                let mut config = project.config();
                (variant.apply)(&mut config);
                let model = project.model(&config);
                let mut case = Case::new(&id);
                let dir = common::scratch_dir(&id);
                let ext = match format {
                    Format::Gif => "gif",
                    Format::Mov => "mov",
                    Format::Mp4 => "mp4",
                };
                let run = ExportRun {
                    fps,
                    resolution,
                    format,
                    decoder,
                };
                rt.block_on(common::probe_decoders(&mut case, &project, decoder));
                let first = dir.path().join(format!("a.{ext}"));
                match rt.block_on(common::export(&project, config.clone(), &run, &first)) {
                    Err(e) => case.problem("error", format!("export failed: {e}")),
                    Ok(path) => {
                        let frames =
                            common::read_output(&path, Some(&|i| model.expect(i as u32, fps)));
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
                                    let again = common::read_output(&path, None);
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

fn across_segments(config: &mut ProjectConfiguration) {
    common::set_clip_cuts(
        config,
        &[(0, 0.5, 3.0, 1.0), (1, 0.5, 2.5, 1.0), (0, 3.5, 5.5, 1.5)],
    );
}

/// A Studio project recorded through the real recording pipeline.
#[test]
fn recorded_studio() {
    let failures = run_project(
        common::recorded(&catalog::recorded_studio(report::tier())),
        &[
            Variant {
                edit: "full",
                apply: no_edit,
            },
            Variant {
                edit: "across-segments",
                apply: across_segments,
            },
        ],
        &[(Format::Mp4, 30), (Format::Mp4, 60)],
        &Decoder::all(),
        RES,
        false,
    );
    common::assert_passed(failures);
}

/// Instant mode: the finalised `output.mp4` is the deliverable. Every
/// emitted screen frame must appear once, in order, on its own timing, and
/// every audio marker must be present, within 5 ms of the screen.
#[test]
fn instant_output() {
    let mut failures = Vec::new();
    for spec in catalog::instant_variants(report::tier()) {
        if let Some(failure) = instant_case(spec) {
            failures.push(failure);
        }
    }
    common::assert_passed(failures);
}

fn instant_case(spec: cap_verify::pipeline::InstantSpec) -> Option<String> {
    use cap_verify::{
        audio_code::{self, AudioSource},
        fixture, media,
        pipeline::{self, Emitted},
        video_code::{self, StreamKind},
    };
    let id = format!("export/{}/output/mp4/native", spec.name);
    if !report::selected(&id) {
        return None;
    }
    common::init();
    let dir = fixture::ensure_fixture_keyed(spec.cache_key(), |dir| {
        common::runtime().block_on(pipeline::record_instant(&spec, dir))
    })
    .expect("instant fixture");
    let emitted: Emitted = serde_json::from_str(
        &std::fs::read_to_string(dir.join("verify-emitted.json")).expect("emitted"),
    )
    .expect("emitted json");
    let output = dir.join("content/output.mp4");
    let mut case = Case::new(&id);
    let mut frames = Vec::new();
    media::decode_video(&output, |p| {
        frames.push((
            p.pts_secs,
            video_code::read_stream(&p.view(), StreamKind::Screen),
        ))
    })
    .expect("decode instant output");
    let shown: Vec<(f64, u32)> = frames
        .iter()
        .filter_map(|(pts, r)| r.marker().map(|m| (*pts, m.index)))
        .collect();
    if shown.len() != frames.len() {
        case.problem(
            "unreadable",
            format!(
                "{} of {} frames unreadable",
                frames.len() - shown.len(),
                frames.len()
            ),
        );
    }
    let emitted_slots: Vec<u32> = emitted.screen.iter().map(|e| e.0).collect();
    let shown_slots: Vec<u32> = shown.iter().map(|s| s.1).collect();
    let missing: Vec<u32> = emitted_slots
        .iter()
        .filter(|s| !shown_slots.contains(s))
        .copied()
        .collect();
    let repeated: Vec<u32> = shown_slots
        .windows(2)
        .filter(|w| w[1] <= w[0])
        .map(|w| w[1])
        .collect();
    if !missing.is_empty() {
        case.problem(
            "dropped",
            format!(
                "{} emitted frames missing from the output (first {:?})",
                missing.len(),
                &missing[..missing.len().min(8)]
            ),
        );
    }
    if !repeated.is_empty() {
        case.problem(
            "stale",
            format!(
                "{} frames repeated or out of order (first {:?})",
                repeated.len(),
                &repeated[..repeated.len().min(8)]
            ),
        );
    }
    let emit_time = |slot: u32| {
        emitted
            .screen
            .iter()
            .find(|e| e.0 == slot)
            .map(|e| e.1)
            .unwrap_or(f64::NAN)
    };
    let video_offsets: Vec<f64> = shown.iter().map(|&(pts, s)| pts - emit_time(s)).collect();
    let spread = |v: &[f64]| {
        let lo = v.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        hi - lo
    };
    let median = |v: &[f64]| {
        let mut v = v.to_vec();
        v.sort_by(f64::total_cmp);
        v.get(v.len() / 2).copied().unwrap_or(f64::NAN)
    };
    let frame = 1.0 / f64::from(emitted.fps);
    let video_spread = spread(&video_offsets);
    case.note(format!("video timing spread {:.2} ms", video_spread * 1e3));
    if video_spread > frame / 2.0 {
        case.problem(
            "timestamps",
            format!(
                "video frame times drift by {:.1} ms against emission (allowed {:.1})",
                video_spread * 1e3,
                frame / 2.0 * 1e3
            ),
        );
    }
    let audio = media::decode_audio(&output, None).expect("decode instant audio");
    let mono = audio.mono();
    for source in [AudioSource::Mic, AudioSource::System] {
        let expected: Vec<(u32, f64)> = emitted
            .audio
            .iter()
            .filter(|e| e.0 == source)
            .map(|e| (e.1, e.2))
            .collect();
        if expected.is_empty() {
            continue;
        }
        let found = audio_code::locate_markers(&mono, audio.sample_rate, source);
        let mut offsets = Vec::new();
        let mut absent = Vec::new();
        for &(index, t) in &expected {
            match found.iter().find(|f| f.index == Some(index)) {
                Some(f) => offsets.push(f.time_secs + audio.start_secs - t),
                None => absent.push(index),
            }
        }
        let extra = found.len().saturating_sub(expected.len() - absent.len());
        if !absent.is_empty() || extra > 0 {
            case.problem(
                "audio",
                format!(
                    "{}: {} markers missing (first {:?}), {} unexpected",
                    source.name(),
                    absent.len(),
                    &absent[..absent.len().min(5)],
                    extra
                ),
            );
        }
        if offsets.is_empty() {
            continue;
        }
        let av = median(&offsets) - median(&video_offsets);
        case.note(format!(
            "{}: {} markers, spread {:.2} ms, A/V offset {:+.2} ms",
            source.name(),
            offsets.len(),
            spread(&offsets) * 1e3,
            av * 1e3
        ));
        eprintln!(
            "[cap-verify] instant {}: spread {:.2} ms, A/V {:+.2} ms",
            source.name(),
            spread(&offsets) * 1e3,
            av * 1e3
        );
        if spread(&offsets) > 0.005 {
            case.problem(
                "audio",
                format!(
                    "{} marker timing drifts by {:.2} ms",
                    source.name(),
                    spread(&offsets) * 1e3
                ),
            );
        }
        if av.abs() > 0.005 {
            case.problem(
                "sync",
                format!("{} is {:+.1} ms off the screen", source.name(), av * 1e3),
            );
        }
    }
    report::settle(case).err()
}

/// ProRes MOV export.
#[test]
fn mov() {
    let failures = run(
        catalog::basic(report::tier()),
        &[Variant {
            edit: "cuts-speeds-reorder",
            apply: cuts_speeds_reorder,
        }],
        &[(Format::Mov, 30)],
        &[Decoder::Default],
        RES,
        false,
    );
    common::assert_passed(failures);
}

fn short_cut(config: &mut ProjectConfiguration) {
    common::set_cuts(config, &[(1.0, 2.5, 1.0), (4.0, 5.0, 2.0)]);
}

/// 4K output (sources upscaled): the full-size encode and render path.
#[test]
fn uhd() {
    let (formats, decoders): (&[(Format, u32)], Vec<Decoder>) = match report::tier() {
        Tier::Fast => (&[(Format::Mp4, 30)], vec![Decoder::Default]),
        Tier::Full => (&[(Format::Mp4, 30), (Format::Mp4, 60)], Decoder::all()),
    };
    let failures = run(
        catalog::basic(report::tier()),
        &[Variant {
            edit: "uhd-short-cut",
            apply: short_cut,
        }],
        formats,
        &decoders,
        (3840, 2160),
        false,
    );
    common::assert_passed(failures);
}
