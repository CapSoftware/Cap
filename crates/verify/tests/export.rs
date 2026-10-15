//! Export oracle: every exported frame must show exactly the source frames
//! the reference model computes, for both streams, on every decoder.

mod common;

use cap_project::{ProjectConfiguration, SceneMode, SceneSegment, XY};
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
                            format != Format::Mov,
                        );
                        common::check_presentation(
                            &mut case,
                            &config,
                            &frames,
                            &path,
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

/// A camera offset the user set on the clip (not auto-calculated): the camera
/// shows the frame `0.3 s` later than the screen's.
fn camera_user_offset(config: &mut ProjectConfiguration) {
    match config.clips.iter_mut().find(|c| c.index == 0) {
        Some(clip) => {
            clip.offsets.camera = 0.3;
            clip.offsets_auto_calculated = false;
        }
        None => config.clips.push(cap_project::ClipConfiguration {
            index: 0,
            offsets: cap_project::ClipOffsets {
                camera: 0.3,
                ..Default::default()
            },
            offsets_auto_calculated: false,
        }),
    }
}

#[test]
fn camera_offset() {
    let mut failures: Vec<String> = Vec::new();
    failures.extend(run(
        catalog::basic(report::tier()),
        &[Variant {
            edit: "camera-user-offset",
            apply: camera_user_offset,
        }],
        &[(Format::Mp4, 30)],
        &Decoder::all(),
        RES,
        false,
    ));
    common::assert_passed(failures);
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

/// Background crop: the export must show the cropped part of the screen.
/// Frame identity alone cannot see a crop (the code is still readable when
/// the crop is ignored), so the screen code's square is located in every
/// tenth frame (the low-chroma block inside the screen's key region) and
/// must sit where the crop puts it.
#[test]
fn crop() {
    use cap_project::Crop;
    use cap_verify::{
        media,
        video_code::{self, PixelSource, StreamKind},
    };
    let spec = catalog::basic(report::tier());
    let id = case_id(&spec.name, "crop", Format::Mp4, 30, Decoder::Default);
    if !report::selected(&id) {
        return;
    }
    let project = common::project(&spec);
    let (src_w, src_h) = (f64::from(catalog::SCREEN_W), f64::from(catalog::SCREEN_H));
    let crop = Crop {
        position: XY::new(20, 10),
        size: XY::new(256, 144),
    };
    let mut config = project.config();
    config.camera.hide = true;
    config.background.crop = Some(crop.clone());
    let model = project.model(&config);
    let mut case = Case::new(&id);
    let dir = common::scratch_dir(&id);
    let run = ExportRun {
        fps: 30,
        resolution: RES,
        format: Format::Mp4,
        decoder: Decoder::Default,
    };
    let out = dir.path().join("a.mp4");
    match common::runtime().block_on(common::export(&project, config.clone(), &run, &out)) {
        Err(e) => case.problem("error", format!("export failed: {e}")),
        Ok(path) => {
            let mut frames = Vec::new();
            let (cx0, cy0) = (f64::from(crop.position.x), f64::from(crop.position.y));
            let (cw, ch) = (f64::from(crop.size.x), f64::from(crop.size.y));
            let side = StreamKind::Screen.code_side_fraction() * src_h;
            let mut misplaced = Vec::new();
            let mut index = 0usize;
            let decoded = media::decode_video(&path, |picture| {
                let i = index;
                index += 1;
                let view = picture.view();
                let region = video_code::locate_region(&view, StreamKind::Screen);
                let expected = region.map(|region| {
                    let (rw, rh) = (region.x1 - region.x0, region.y1 - region.y0);
                    (
                        region.x0 + (src_w / 2.0 - cx0) / cw * rw,
                        region.y0 + (src_h / 2.0 - cy0) / ch * rh,
                        side / ch * rh,
                    )
                });
                // The code is off the screen region's centre, so it is read
                // where the crop puts it.
                let screen = match expected {
                    Some((x, y, s)) => {
                        video_code::read_code_near(&view, StreamKind::Screen, x, y, s)
                    }
                    None => video_code::Readout::Absent,
                };
                frames.push(common::OutputFrame {
                    pts_secs: picture.pts_secs,
                    readout: video_code::FrameReadout {
                        screen,
                        camera: video_code::read_stream(&view, StreamKind::Camera),
                    },
                    hash: 0,
                    size: (view.width(), view.height()),
                    camera_region: None,
                    screen_colour: None,
                });
                if i % common::LAYOUT_SAMPLE_EVERY != 0 {
                    return;
                }
                let (Some(region), Some((expect_cx, expect_cy, expect_side))) = (region, expected)
                else {
                    misplaced.push(format!("frame {i}: no screen region"));
                    return;
                };
                let rh = region.y1 - region.y0;
                let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
                for y in (region.y0.ceil() as usize)..(region.y1 as usize).min(view.height()) {
                    for x in (region.x0.ceil() as usize)..(region.x1 as usize).min(view.width()) {
                        let (cb, cr) = view.chroma(x, y);
                        if cb.hypot(cr) < 16.0 {
                            x0 = x0.min(x as f64);
                            y0 = y0.min(y as f64);
                            x1 = x1.max(x as f64 + 1.0);
                            y1 = y1.max(y as f64 + 1.0);
                        }
                    }
                }
                let tolerance = 0.03 * rh;
                let (cx, cy, s) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0, y1 - y0);
                if x1 < x0
                    || (cx - expect_cx).abs() > tolerance
                    || (cy - expect_cy).abs() > tolerance
                    || (s - expect_side).abs() > tolerance
                {
                    misplaced.push(format!(
                        "frame {i}: code square centre ({cx:.1}, {cy:.1}) side {s:.1}, crop puts it at ({expect_cx:.1}, {expect_cy:.1}) side {expect_side:.1}"
                    ));
                }
            });
            if let Err(e) = decoded {
                case.problem("error", format!("decode: {e:?}"));
            }
            common::check_sequence(&mut case, &model, &frames, 30, true);
            if !misplaced.is_empty() {
                case.problem(
                    "layout",
                    format!(
                        "cropped screen misplaced in {} sampled frames: {}",
                        misplaced.len(),
                        misplaced[..misplaced.len().min(3)].join("; ")
                    ),
                );
            }
        }
    }
    common::finish(case);
}

/// Colour fidelity of exported pixels the renderer generates in RGB: a
/// saturated background must decode, under the stream's own colour tag (what
/// players use), to the configured colour. BT.601 and BT.709 differ here by
/// about 13 luma and 9 chroma code values.
#[test]
fn colour() {
    use cap_project::BackgroundSource;
    use cap_verify::media;
    const BACKGROUND: [u8; 3] = [220, 40, 40];
    let spec = catalog::basic(report::tier());
    for decoder in Decoder::all() {
        let id = case_id(&spec.name, "colour", Format::Mp4, 30, decoder);
        if !report::selected(&id) {
            continue;
        }
        let project = common::project(&spec);
        let mut config = project.config();
        config.background.source = BackgroundSource::Color {
            value: BACKGROUND.map(u16::from),
            alpha: 255,
        };
        config.background.padding = 40.0;
        let mut case = Case::new(&id);
        let dir = common::scratch_dir(&id);
        let run = ExportRun {
            fps: 30,
            resolution: RES,
            format: Format::Mp4,
            decoder,
        };
        let out = dir.path().join("a.mp4");
        match common::runtime().block_on(common::export(&project, config, &run, &out)) {
            Err(e) => case.problem("error", format!("export failed: {e}")),
            Ok(path) => {
                let mut errors = Vec::new();
                let mut index = 0usize;
                let decoded = media::decode_video(&path, |picture| {
                    let i = index;
                    index += 1;
                    if i % common::LAYOUT_SAMPLE_EVERY != 0 {
                        return;
                    }
                    let view = picture.view();
                    if let Some(colour) =
                        common::rect_colour(&picture.frame, &view, [0.01, 0.01, 0.06, 0.06])
                    {
                        errors.push((i, common::colour_error(&colour, BACKGROUND), colour.space));
                    }
                });
                if let Err(e) = decoded {
                    case.problem("error", format!("decode: {e:?}"));
                }
                if errors.is_empty() {
                    case.problem("error", "no YUV frames to measure");
                }
                if let Some((i, [dy, _, _], space)) = errors
                    .iter()
                    .find(|(_, e, _)| e[0].abs() > common::COLOUR_LEVEL_TOLERANCE)
                {
                    case.problem(
                        "colour-level",
                        format!("background luma off by {dy:+.1} code values for the stream's {space:?} tag (frame {i})"),
                    );
                }
                if let Some((i, [_, dcb, dcr], space)) = errors
                    .iter()
                    .find(|(_, e, _)| e[1].abs().max(e[2].abs()) > common::COLOUR_MATRIX_TOLERANCE)
                {
                    case.problem(
                        "colour-matrix",
                        format!("background chroma off by Cb {dcb:+.1} Cr {dcr:+.1} for the stream's {space:?} tag (frame {i})"),
                    );
                }
            }
        }
        common::finish(case);
    }
}

/// Audio of a Studio project recorded through the real recording pipeline:
/// every marker the synthetic mic and loopback system audio emitted (at a
/// known time on the same clock as the screen frames) must be heard once in
/// the export, in sync with the screen frame emitted at the same time. This
/// checks the recording pipeline's audio timestamps (anchoring, gap filling,
/// start times in recording-meta) end to end; the audio oracle's own fixtures
/// are written with exact timing and never pass through the recorder.
#[test]
fn recorded_studio_audio() {
    use cap_verify::{
        audio_code::{self, AudioSource, MARKER_SECS},
        media,
        video_code::StreamKind,
    };
    let spec = catalog::recorded_studio(report::tier());
    let id = case_id(
        &format!("rec-{}", spec.name),
        "full-audio",
        Format::Mp4,
        30,
        Decoder::Default,
    );
    if !report::selected(&id) {
        return;
    }
    let project = common::recorded(&spec);
    let mut case = Case::new(&id);
    let dir = common::scratch_dir(&id);
    let run = ExportRun {
        fps: 30,
        resolution: RES,
        format: Format::Mp4,
        decoder: Decoder::Default,
    };
    let out = dir.path().join("a.mp4");
    match common::runtime().block_on(common::export(&project, project.config(), &run, &out)) {
        Err(e) => case.problem("error", format!("export failed: {e}")),
        Ok(path) => {
            let frames = common::read_output(&path, None);
            match media::decode_audio(&path, Some(48_000)) {
                Err(e) => case.problem("error", format!("decode audio: {e:?}")),
                Ok(decoded) => {
                    let mut mono = decoded.mono();
                    let lead = (decoded.start_secs * 48_000.0).round() as i64;
                    if lead > 0 {
                        let mut padded = vec![0.0; lead as usize];
                        padded.extend_from_slice(&mono);
                        mono = padded;
                    } else if lead < 0 {
                        mono.drain(..(-lead as usize).min(mono.len()));
                    }
                    let frame = 1.0 / 30.0;
                    let mut missing = Vec::new();
                    let mut doubled = Vec::new();
                    let mut off = Vec::new();
                    let mut checked = 0;
                    for (source, emitted_from) in [
                        (
                            AudioSource::Mic,
                            spec.segments
                                .iter()
                                .map(|s| s.mic_delay)
                                .collect::<Vec<_>>(),
                        ),
                        (
                            AudioSource::System,
                            spec.segments
                                .iter()
                                .map(|s| s.system_audio.then_some(0.0))
                                .collect(),
                        ),
                    ] {
                        let heard = audio_code::locate_markers(&mono, 48_000, source);
                        if std::env::var_os("CAP_VERIFY_DUMP_AUDIO").is_some() {
                            for h in &heard {
                                eprintln!(
                                    "  heard {}: {:?} at {:.4}s gain {:.3}",
                                    source.name(),
                                    h.index,
                                    h.time_secs,
                                    h.gain
                                );
                            }
                            let file = project.path.join("content/segments/segment-0").join(
                                if source == AudioSource::Mic {
                                    "audio-input.ogg"
                                } else {
                                    "system_audio.ogg"
                                },
                            );
                            if let Ok(src) = media::decode_audio(&file, Some(48_000)) {
                                for h in audio_code::locate_markers(&src.mono(), 48_000, source) {
                                    eprintln!(
                                        "  file {}: {:?} at {:.4}s (+{:.4}) gain {:.3}",
                                        source.name(),
                                        h.index,
                                        h.time_secs,
                                        src.start_secs,
                                        h.gain
                                    );
                                }
                            }
                        }
                        for (clip, segment) in spec.segments.iter().enumerate() {
                            let Some(from) = emitted_from[clip] else {
                                continue;
                            };
                            let schedule = audio_code::standard_schedule(
                                source,
                                0.1,
                                segment.duration - 0.1,
                                0.5,
                            );
                            for placement in schedule {
                                let t = placement.time_secs;
                                if t < from || t + MARKER_SECS > segment.duration - 0.05 {
                                    continue;
                                }
                                let slot = (t * 30.0).floor() as u32;
                                let Some(shown) = frames.iter().position(|f| {
                                    f.readout.get(StreamKind::Screen).marker().is_some_and(|m| {
                                        usize::from(m.segment) == clip && m.index == slot
                                    })
                                }) else {
                                    continue;
                                };
                                let shown_at = shown as f64 * frame;
                                let hits: Vec<_> = heard
                                    .iter()
                                    .filter(|h| {
                                        h.index == Some(placement.index)
                                            && (h.time_secs - shown_at).abs() < 1.0
                                    })
                                    .collect();
                                let what = format!(
                                    "{} #{} (clip {clip}, {t:.3} s)",
                                    source.name(),
                                    placement.index
                                );
                                match hits.as_slice() {
                                    [] => missing.push(what),
                                    [h] => {
                                        checked += 1;
                                        let av = h.time_secs - shown_at;
                                        if av.abs() > frame + 0.005 {
                                            off.push(format!("{what} {:+.1} ms", av * 1000.0));
                                        }
                                    }
                                    _ => doubled.push(what),
                                }
                            }
                        }
                    }
                    if !missing.is_empty() || !doubled.is_empty() {
                        case.problem(
                            "audio",
                            format!(
                                "recorded markers: {} missing (first {:?}), {} heard twice (first {:?})",
                                missing.len(),
                                missing.first(),
                                doubled.len(),
                                doubled.first()
                            ),
                        );
                    }
                    if !off.is_empty() {
                        case.problem(
                            "sync",
                            format!(
                                "{} of {checked} recorded markers out of sync with the screen frame emitted with them (limit one frame + 5 ms): {}",
                                off.len(),
                                off[..off.len().min(3)].join("; ")
                            ),
                        );
                    } else {
                        case.note(format!("{checked} recorded markers in sync"));
                    }
                }
            }
        }
    }
    common::finish(case);
}
