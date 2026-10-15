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
                let Some(mut case) = common::begin(&id, &project, decoder) else {
                    continue;
                };
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

#[test]
#[ignore]
fn prepare_recorded_fixtures() {
    common::recorded(&catalog::recorded_studio(report::tier()));
    for spec in catalog::instant_variants(report::tier()) {
        cap_verify::fixture::ensure_fixture_keyed(spec.cache_key(), |dir| {
            common::runtime().block_on(cap_verify::pipeline::record_instant(&spec, dir))
        })
        .expect("instant fixture");
    }
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
    // Frames within the start gate's margin have no recorded emit time and
    // are not timed.
    let video_offsets: Vec<f64> = shown
        .iter()
        .filter_map(|&(pts, slot)| {
            emitted
                .screen
                .iter()
                .find(|e| e.0 == slot)
                .map(|e| pts - e.1)
        })
        .collect();
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
    if video_offsets.is_empty() {
        case.problem(
            "dropped",
            "no emitted screen frame identified in the output",
        );
        case.unobserved("timestamps", "no emitted screen frame identified");
        case.unobserved("sync", "no emitted screen frame identified");
    }
    let video_spread = spread(&video_offsets);
    case.note(format!("video timing spread {:.2} ms", video_spread * 1e3));
    let late = emitted
        .screen_sent
        .iter()
        .filter_map(|&(slot, sent)| {
            let planned = emitted.screen.iter().find(|e| e.0 == slot)?.1;
            Some((slot, sent - planned))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1));
    if let Some((slot, late)) = late {
        case.note(format!(
            "test emitter at most {:.2} ms late (slot {slot})",
            late * 1e3
        ));
    }
    if !video_offsets.is_empty() && video_spread > frame / 2.0 {
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
        // Markers are matched by their decoded identity anywhere in the
        // track, so an arbitrarily large A/V offset is still measured.
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
            let undecoded = found.iter().filter(|f| f.index.is_none()).count();
            case.problem(
                "audio",
                format!(
                    "{}: {} markers missing (first {:?}), {} unexpected ({} chirps without a decodable identity)",
                    source.name(),
                    absent.len(),
                    &absent[..absent.len().min(5)],
                    extra,
                    undecoded
                ),
            );
            let listed: Vec<String> = found
                .iter()
                .take(16)
                .map(|f| {
                    format!(
                        "{:.4}s {} corr {:.2} gain {:.3}",
                        f.time_secs + audio.start_secs,
                        f.index.map_or("undecoded".to_string(), |i| format!("#{i}")),
                        f.correlation,
                        f.gain
                    )
                })
                .collect();
            case.note(format!(
                "{} chirps found: [{}]; expected {:?}",
                source.name(),
                listed.join(", "),
                expected
                    .iter()
                    .map(|&(i, t)| format!("#{i} {t:.4}s"))
                    .collect::<Vec<_>>()
            ));
        }
        // Chirps whose payload was damaged can still be identified by the
        // schedule's timing pattern, so a large offset stays measurable.
        let chirps: Vec<f64> = found
            .iter()
            .filter(|f| f.index.is_none())
            .map(|f| f.time_secs + audio.start_secs)
            .collect();
        if let Some(pattern) = audio_code::identify_by_schedule(&expected, &chirps, 0.002) {
            let mut added = 0;
            for (index, time) in pattern {
                if absent.contains(&index)
                    && let Some(&(_, t)) = expected.iter().find(|e| e.0 == index)
                {
                    offsets.push(time - t);
                    added += 1;
                }
            }
            case.note(format!(
                "{}: {added} markers without a decodable identity identified by their timing pattern",
                source.name()
            ));
        }
        if offsets.is_empty() {
            case.unobserved(
                "sync",
                format!(
                    "{}: none of the {} expected markers was identified in the output",
                    source.name(),
                    expected.len()
                ),
            );
            continue;
        }
        if video_offsets.is_empty() {
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

/// Fixed aspect ratios (Wide, Vertical, Square, Classic, Tall): the frame is
/// the crop's longer side (relative to the aspect) with the other side
/// derived from the aspect, rounded up to even numbers. It must hold the
/// exact aspect-fit size (never smaller, or the picture is squeezed into a
/// frame that is too small) and be at most 2 px larger on each side.
#[test]
fn aspect_frame_size() {
    use cap_project::AspectRatio;
    use cap_rendering::{ProjectUniforms, RenderOptions};
    let id = "export/frame-size/aspect-ratios";
    if !report::selected(id) {
        return;
    }
    let mut case = Case::new(id);
    let mut checked = 0;
    let mut wrong = Vec::new();
    for (w, h) in [
        (1000u32, 700u32),
        (1512, 982),
        (1920, 1080),
        (1081, 1919),
        (333, 777),
        (2559, 1599),
        (1470, 956),
        (3024, 1964),
    ] {
        for (aspect, ratio) in [
            (AspectRatio::Wide, 16.0 / 9.0),
            (AspectRatio::Vertical, 9.0 / 16.0),
            (AspectRatio::Square, 1.0),
            (AspectRatio::Classic, 4.0 / 3.0),
            (AspectRatio::Tall, 3.0 / 4.0),
        ] {
            let mut config = cap_verify::fixture::verification_project_config();
            config.aspect_ratio = Some(aspect.clone());
            config.background.padding = 0.0;
            config.background.crop = None;
            let options = RenderOptions {
                camera_size: None,
                screen_size: cap_project::XY::new(w, h),
                preserve_screen_alpha: false,
            };
            let (bw, bh) = ProjectUniforms::get_base_size(&options, &config);
            let (fw, fh) = (f64::from(w), f64::from(h));
            let (ew, eh) = if fw / fh > ratio {
                (fw, fw / ratio)
            } else {
                (fh * ratio, fh)
            };
            checked += 1;
            let fits = |got: u32, exact: f64| {
                got % 2 == 0 && f64::from(got) >= exact - 1e-6 && f64::from(got) < exact + 2.0
            };
            if !fits(bw, ew) || !fits(bh, eh) {
                wrong.push(format!(
                    "{w}x{h} at {aspect:?}: frame {bw}x{bh}, exact fit {ew:.2}x{eh:.2}"
                ));
            }
        }
    }
    if wrong.is_empty() {
        case.note(format!("{checked} crop sizes and aspect ratios"));
    } else {
        case.problem(
            "frame-size",
            format!(
                "{} of {checked} frames are not the smallest even size holding the aspect fit: {}",
                wrong.len(),
                wrong[..wrong.len().min(4)].join("; ")
            ),
        );
    }
    common::finish(case);
}

#[derive(Clone, Copy, Debug)]
struct MeasuredColour {
    ycbcr: [f64; 3],
    space: ffmpeg::util::color::Space,
    range: ffmpeg::util::color::Range,
}

/// Measured minus expected (Y, Cb, Cr) code values for `rgb` encoded the way
/// the stream's colour tag says (BT.709 unless tagged BT.601; limited range
/// unless tagged full), the way players decode it.
fn colour_error(colour: &MeasuredColour, rgb: [u8; 3]) -> [f64; 3] {
    use ffmpeg::util::color::{Range, Space};
    let [r, g, b] = rgb.map(|v| f64::from(v) / 255.0);
    let (kr, kb) = if matches!(colour.space, Space::BT470BG | Space::SMPTE170M) {
        (0.299, 0.114)
    } else {
        (0.2126, 0.0722)
    };
    let y = kr * r + (1.0 - kr - kb) * g + kb * b;
    let (cb, cr) = ((b - y) / (2.0 * (1.0 - kb)), (r - y) / (2.0 * (1.0 - kr)));
    let expected = if colour.range == Range::JPEG {
        [255.0 * y, 128.0 + 255.0 * cb, 128.0 + 255.0 * cr]
    } else {
        [16.0 + 219.0 * y, 128.0 + 224.0 * cb, 128.0 + 224.0 * cr]
    };
    [0, 1, 2].map(|k| colour.ycbcr[k] - expected[k])
}

/// Mean code values and tag of a rectangle (fractions of the picture).
fn rect_colour(
    frame: &ffmpeg::frame::Video,
    view: &impl cap_verify::video_code::PixelSource,
    rect: [f64; 4],
) -> Option<MeasuredColour> {
    if !matches!(
        frame.format(),
        ffmpeg::format::Pixel::YUV420P | ffmpeg::format::Pixel::NV12
    ) {
        return None;
    }
    let (w, h) = (view.width() as f64, view.height() as f64);
    let (x0, x1) = ((rect[0] * w) as usize, (rect[2] * w) as usize);
    let (y0, y1) = ((rect[1] * h) as usize, (rect[3] * h) as usize);
    let mut sum = [0.0; 3];
    let mut n = 0.0;
    for y in y0..y1.max(y0 + 1) {
        for x in x0..x1.max(x0 + 1) {
            let (cb, cr) = view.chroma(x, y);
            sum[0] += view.luma(x, y);
            sum[1] += cb + 128.0;
            sum[2] += cr + 128.0;
            n += 1.0;
        }
    }
    Some(MeasuredColour {
        ycbcr: sum.map(|v| v / n),
        space: frame.color_space(),
        range: frame.color_range(),
    })
}

/// Allowed error of a flat background (code values): luma level, chroma.
const COLOUR_LEVEL_TOLERANCE: f64 = 4.0;
const COLOUR_MATRIX_TOLERANCE: f64 = 2.0;

/// Colour fidelity of pixels the renderer generates in RGB (the background):
/// a flat background must decode, under the stream's own colour tag (what
/// players use), to the configured colour. Red separates BT.601 from BT.709
/// (about 13 luma and 9 chroma code values apart); black and white sit at
/// the ends of the limited range (Y 16 and 235, neutral chroma) under every
/// matrix, so they pin the range independently of the matrix question.
#[test]
fn colour() {
    use cap_project::BackgroundSource;
    use cap_verify::media;
    let spec = catalog::basic(report::tier());
    let mut failures = Vec::new();
    for (name, background) in [
        ("colour-red", [220u8, 40, 40]),
        ("colour-black", [0, 0, 0]),
        ("colour-white", [255, 255, 255]),
    ] {
        let id = case_id(&spec.name, name, Format::Mp4, 30, Decoder::Default);
        if !report::selected(&id) {
            continue;
        }
        let project = common::project(&spec);
        let mut config = project.config();
        config.background.source = BackgroundSource::Color {
            value: background.map(u16::from),
            alpha: 255,
        };
        config.background.padding = 40.0;
        let mut case = Case::new(&id);
        let dir = common::scratch_dir(&id);
        let run = ExportRun {
            fps: 30,
            resolution: RES,
            format: Format::Mp4,
            decoder: Decoder::Default,
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
                    if i % 10 != 0 {
                        return;
                    }
                    let view = picture.view();
                    if let Some(colour) =
                        rect_colour(&picture.frame, &view, [0.01, 0.01, 0.06, 0.06])
                    {
                        errors.push((i, colour_error(&colour, background), colour));
                    }
                });
                if let Err(e) = decoded {
                    case.problem("error", format!("decode: {e:?}"));
                }
                if errors.is_empty() {
                    case.problem("error", "no YUV frames to measure");
                }
                if let Some((i, [dy, _, _], colour)) = errors
                    .iter()
                    .find(|(_, e, _)| e[0].abs() > COLOUR_LEVEL_TOLERANCE)
                {
                    case.problem(
                        "colour-level",
                        format!(
                            "background luma off by {dy:+.1} code values (Y {:.1}) for the stream's {:?} {:?} tag (frame {i})",
                            colour.ycbcr[0], colour.space, colour.range
                        ),
                    );
                }
                if let Some((i, [_, dcb, dcr], colour)) = errors
                    .iter()
                    .find(|(_, e, _)| e[1].abs().max(e[2].abs()) > COLOUR_MATRIX_TOLERANCE)
                {
                    case.problem(
                        "colour-matrix",
                        format!(
                            "background chroma off by Cb {dcb:+.1} Cr {dcr:+.1} for the stream's {:?} tag (frame {i})",
                            colour.space
                        ),
                    );
                }
                if let Some((_, e, colour)) = errors.first() {
                    case.note(format!(
                        "frame 0: Y {:.1} Cb {:.1} Cr {:.1} ({:?} {:?}), error {:+.1} {:+.1} {:+.1}",
                        colour.ycbcr[0],
                        colour.ycbcr[1],
                        colour.ycbcr[2],
                        colour.space,
                        colour.range,
                        e[0],
                        e[1],
                        e[2]
                    ));
                }
            }
        }
        if let Err(message) = report::settle(case) {
            failures.push(message);
        }
    }
    common::assert_passed(failures);
}
