#![allow(dead_code)]

use std::path::{Path, PathBuf};

use cap_project::{
    ClipTransition, ClipTransitionType, ProjectConfiguration, RecordingMeta, TimelineSegment, XY,
};
use cap_verify::{
    fixture::{self, FixtureSpec, SourceTruth},
    media,
    model::ReferenceModel,
    oracle::{self, StreamExpectation},
    report::{self, Case},
    video_code::{self, FrameReadout, StreamKind},
};

pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()
        .expect("runtime")
}

/// `CAP_VERIFY_LOG=<filter>` (EnvFilter syntax, e.g. `wgpu_hal=warn,cap_rendering=info`)
/// prints product and wgpu logs to stderr, for triage on remote runners.
pub fn init() {
    media::init();
    static LOG: std::sync::Once = std::sync::Once::new();
    LOG.call_once(|| {
        if let Ok(filter) = std::env::var("CAP_VERIFY_LOG") {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
                .with_writer(std::io::stderr)
                .try_init();
        }
    });
}

/// A ready fixture project plus its decoded source truth.
pub struct Project {
    pub name: String,
    pub path: PathBuf,
    pub meta: RecordingMeta,
    pub truth: SourceTruth,
}

pub fn project(spec: &FixtureSpec) -> Project {
    init();
    let path = fixture::ensure_fixture(spec, fixture::write_fixture)
        .unwrap_or_else(|e| panic!("fixture {}: {e:?}", spec.name));
    load(&spec.name, path)
}

pub fn load(name: &str, path: PathBuf) -> Project {
    let meta = RecordingMeta::load_for_project(&path).expect("fixture meta");
    let truth = SourceTruth::read(&path).expect("fixture truth");
    Project {
        name: name.to_string(),
        path,
        meta,
        truth,
    }
}

/// A fixture recorded through the real recording pipeline (real time on
/// first use, cached afterwards).
pub fn recorded(spec: &cap_verify::pipeline::RecordedSpec) -> Project {
    init();
    let path = fixture::ensure_fixture_keyed(spec.cache_key(), |dir| {
        runtime().block_on(cap_verify::pipeline::record_studio(spec, dir))
    })
    .unwrap_or_else(|e| panic!("recorded fixture {}: {e:?}", spec.name));
    load(&format!("rec-{}", spec.name), path)
}

impl Project {
    pub fn config(&self) -> ProjectConfiguration {
        self.meta.project_config()
    }

    pub fn model(&self, config: &ProjectConfiguration) -> ReferenceModel {
        ReferenceModel::new(&self.meta, config, self.truth.clone()).expect("model")
    }
}

/// Replaces the timeline with `(start, end, timescale)` cuts of clip 0.
pub fn set_cuts(config: &mut ProjectConfiguration, cuts: &[(f64, f64, f64)]) {
    let timeline = config.timeline.as_mut().expect("timeline");
    timeline.segments = cuts
        .iter()
        .map(|&(start, end, timescale)| TimelineSegment {
            recording_clip: 0,
            start,
            end,
            timescale,
            name: None,
            speed_audio_mode: None,
            hide_cursor: None,
            volume: None,
        })
        .collect();
}

/// Replaces the timeline with `(clip, start, end, timescale)` segments.
pub fn set_clip_cuts(config: &mut ProjectConfiguration, cuts: &[(u32, f64, f64, f64)]) {
    let timeline = config.timeline.as_mut().expect("timeline");
    timeline.segments = cuts
        .iter()
        .map(|&(clip, start, end, timescale)| TimelineSegment {
            recording_clip: clip,
            start,
            end,
            timescale,
            name: None,
            speed_audio_mode: None,
            hide_cursor: None,
            volume: None,
        })
        .collect();
}

pub fn add_transition(config: &mut ProjectConfiguration, segment_index: u32, duration: f64) {
    let timeline = config.timeline.as_mut().expect("timeline");
    timeline.transitions.push(ClipTransition {
        segment_index,
        kind: ClipTransitionType::CrossFade,
        duration,
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Mp4,
    Gif,
    Mov,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decoder {
    /// The platform default: AVAssetReader on macOS, Media Foundation on
    /// Windows, FFmpeg on Linux.
    Default,
    /// `--force-ffmpeg-decoder`.
    Ffmpeg,
}

impl Decoder {
    pub fn label(self) -> &'static str {
        match self {
            Decoder::Default if cfg!(target_os = "macos") => "avf",
            Decoder::Default if cfg!(target_os = "windows") => "mf",
            Decoder::Default => "ffmpeg",
            Decoder::Ffmpeg => "ffmpeg",
        }
    }

    /// Decoders that are actually distinct on this platform.
    pub fn all() -> Vec<Decoder> {
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            vec![Decoder::Default, Decoder::Ffmpeg]
        } else {
            vec![Decoder::Default]
        }
    }

    /// The `DecoderType` display prefix this choice must produce. A silent
    /// fallback (Media Foundation or AVAssetReader failing over to FFmpeg)
    /// would otherwise test the wrong decoder under this label.
    pub fn expected_type(self) -> &'static str {
        match self {
            Decoder::Default if cfg!(target_os = "macos") => "AVAssetReader",
            Decoder::Default if cfg!(target_os = "windows") => "MediaFoundation",
            _ => "FFmpeg",
        }
    }
}

/// Records which decoder each stream actually used and flags any stream
/// that is not on the requested decoder.
pub fn check_decoders(case: &mut Case, decoder: Decoder, segments: &[cap_editor::SegmentMedia]) {
    let mut used = Vec::new();
    for (i, segment) in segments.iter().enumerate() {
        let streams =
            std::iter::once(("screen", Some(segment.decoders.screen_decoder_status()))).chain(
                std::iter::once(("camera", segment.decoders.camera_decoder_status())),
            );
        for (stream, status) in streams {
            let Some(status) = status else { continue };
            let kind = status.decoder_type.to_string();
            used.push(format!("{stream}{i}={kind}"));
            if !kind.starts_with(decoder.expected_type()) {
                case.problem(
                    "decoder-fallback",
                    format!(
                        "segment {i} {stream} decoded by {kind}, expected {} (fallback reason: {})",
                        decoder.expected_type(),
                        status.fallback_reason.as_deref().unwrap_or("none")
                    ),
                );
            }
        }
    }
    case.note(format!("decoders: {}", used.join(" ")));
}

/// Why `decoder` cannot run on this machine at all, probed once per
/// process. Only Windows has such a case: the Media Foundation decoder
/// needs a D3D11 device with video support, which GPU-less VMs (hosted CI
/// runners, where D3D11 falls back to WARP) cannot create, so the product
/// falls back to FFmpeg there. Any other Media Foundation failure stays a
/// `decoder-fallback` test failure.
pub fn decoder_unsupported(project: &Project, decoder: Decoder) -> Option<String> {
    if decoder != Decoder::Default || !cfg!(target_os = "windows") {
        return None;
    }
    static PROBE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    PROBE
        .get_or_init(|| {
            let meta = project.meta.studio_meta()?;
            let segments = runtime()
                .block_on(cap_editor::create_segments(&project.meta, meta, false))
                .ok()?;
            let reason = segments
                .first()?
                .decoders
                .screen_decoder_status()
                .fallback_reason
                .clone()?;
            reason.contains("D3D11CreateDevice").then(|| {
                format!(
                    "Media Foundation needs a D3D11 device with video support and this machine has none (WARP has no video decode): {reason}"
                )
            })
        })
        .clone()
}

/// Starts a case, or settles it as unsupported and returns `None` when this
/// machine cannot run `decoder` (see [`decoder_unsupported`]).
pub fn begin(id: &str, project: &Project, decoder: Decoder) -> Option<Case> {
    let mut case = Case::new(id);
    if let Some(reason) = decoder_unsupported(project, decoder) {
        case.unsupported(reason);
        if case.unsupported.is_some() {
            let _ = report::settle(case);
            return None;
        }
    }
    Some(case)
}

/// Opens the project's decoders the way the exporter does and checks them.
/// The exporter's own decoders are private, so this probes the same
/// `create_segments` decision on the same files.
pub async fn probe_decoders(case: &mut Case, project: &Project, decoder: Decoder) {
    let Some(meta) = project.meta.studio_meta() else {
        return;
    };
    match cap_editor::create_segments(&project.meta, meta, decoder == Decoder::Ffmpeg).await {
        Ok(segments) => check_decoders(case, decoder, &segments),
        Err(e) => case.problem("error", format!("decoder probe failed: {e}")),
    }
}

pub struct ExportRun {
    pub custom_bpp: Option<f32>,
    pub fps: u32,
    pub resolution: (u32, u32),
    pub format: Format,
    pub decoder: Decoder,
}

pub async fn export(
    project: &Project,
    config: ProjectConfiguration,
    run: &ExportRun,
    out: &Path,
) -> Result<PathBuf, String> {
    let force = run.decoder == Decoder::Ffmpeg;
    let base = cap_export::ExporterBase::builder(project.path.clone())
        .with_config(config)
        .with_force_ffmpeg_decoder(force)
        .with_output_path(out.to_path_buf())
        .build()
        .await
        .map_err(|e| format!("exporter build: {e}"))?;
    let resolution_base = XY::new(run.resolution.0, run.resolution.1);
    match run.format {
        Format::Mp4 => {
            cap_export::mp4::Mp4ExportSettings {
                fps: run.fps,
                resolution_base,
                compression: cap_export::mp4::ExportCompression::Social,
                custom_bpp: run.custom_bpp,
                force_ffmpeg_decoder: force,
                optimize_filesize: false,
            }
            .export(base, |_| true)
            .await
        }
        Format::Mov => {
            cap_export::mov::MovExportSettings {
                fps: run.fps,
                resolution_base,
                cursor_only: false,
            }
            .export(base, |_| true)
            .await
        }
        Format::Gif => {
            cap_export::gif::GifExportSettings {
                fps: run.fps,
                resolution_base,
                quality: None,
            }
            .export(base, |_| true)
            .await
        }
    }
}

pub struct OutputFrame {
    pub pts_secs: f64,
    pub readout: FrameReadout,
    /// Hash of the decoded picture, for determinism checks.
    pub hash: u64,
    /// Picture size.
    pub size: (usize, usize),
    /// Camera key region of every `LAYOUT_SAMPLE_EVERY`th frame, as fractions
    /// of the picture size.
    pub camera_region: Option<video_code::Region>,
    /// Mean Y, Cb, Cr code values of a flat band of the screen's key colour
    /// and the stream's colour tag, sampled like `camera_region` (YUV
    /// outputs only).
    pub screen_colour: Option<ScreenColour>,
}

#[derive(Clone, Copy, Debug)]
pub struct ScreenColour {
    pub ycbcr: [f64; 3],
    pub space: ffmpeg::util::color::Space,
    pub range: ffmpeg::util::color::Range,
}

/// Measured minus expected (Y, Cb, Cr) code values for `rgb` encoded the way
/// the stream's colour tag says (BT.709 unless tagged BT.601; limited range
/// unless tagged full).
pub fn colour_error(colour: &ScreenColour, rgb: [u8; 3]) -> [f64; 3] {
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
pub fn rect_colour(
    frame: &ffmpeg::frame::Video,
    view: &impl video_code::PixelSource,
    rect: [f64; 4],
) -> Option<ScreenColour> {
    if !matches!(
        frame.format(),
        ffmpeg::format::Pixel::YUV420P | ffmpeg::format::Pixel::NV12
    ) {
        return None;
    }
    let (w, h) = (view.width() as f64, view.height() as f64);
    let (x0, x1) = (
        (rect[0] * w) as usize,
        ((rect[2] * w) as usize).max((rect[0] * w) as usize + 1),
    );
    let (y0, y1) = (
        (rect[1] * h) as usize,
        ((rect[3] * h) as usize).max((rect[1] * h) as usize + 1),
    );
    let mut sum = [0.0; 3];
    let mut n = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            let (cb, cr) = view.chroma(x, y);
            sum[0] += view.luma(x, y);
            sum[1] += cb + 128.0;
            sum[2] += cr + 128.0;
            n += 1.0;
        }
    }
    Some(ScreenColour {
        ycbcr: sum.map(|v| v / n),
        space: frame.color_space(),
        range: frame.color_range(),
    })
}

/// Mean code values of the band 8-16% down the screen's key region, 20-80%
/// across (above the code square and the default camera position).
fn screen_colour(
    frame: &ffmpeg::frame::Video,
    view: &impl video_code::PixelSource,
) -> Option<ScreenColour> {
    if !matches!(
        frame.format(),
        ffmpeg::format::Pixel::YUV420P | ffmpeg::format::Pixel::NV12
    ) {
        return None;
    }
    let region = video_code::locate_region(view, StreamKind::Screen)?;
    let (w, h) = (region.x1 - region.x0, region.y1 - region.y0);
    let (x0, x1) = (
        (region.x0 + 0.2 * w) as usize,
        (region.x0 + 0.8 * w) as usize,
    );
    let (y0, y1) = (
        (region.y0 + 0.08 * h) as usize,
        (region.y0 + 0.16 * h) as usize,
    );
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
    Some(ScreenColour {
        ycbcr: sum.map(|v| v / n),
        space: frame.color_space(),
        range: frame.color_range(),
    })
}

/// Frames between camera placement samples (placement does not change
/// between frames of the verification projects).
pub const LAYOUT_SAMPLE_EVERY: usize = 10;

fn picture_hash(frame: &ffmpeg::frame::Video) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let planes = if frame.format() == ffmpeg::format::Pixel::NV12 {
        2
    } else {
        3
    };
    for plane in 0..planes.min(frame.planes()) {
        let width = frame.plane_width(plane) as usize
            * if frame.format() == ffmpeg::format::Pixel::NV12 && plane == 1 {
                2
            } else {
                1
            };
        let stride = frame.stride(plane);
        let data = frame.data(plane);
        for row in 0..frame.plane_height(plane) as usize {
            for &byte in &data[row * stride..row * stride + width] {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
        }
    }
    hash
}

/// Decodes an output and reads every frame, using the model's expectation
/// for frame `i` (when given) to verify transition blends.
pub fn read_output(
    path: &Path,
    expect: Option<&dyn Fn(usize) -> cap_verify::model::FrameExpectation>,
) -> Vec<OutputFrame> {
    let mut frames = Vec::new();
    media::decode_video(path, |picture| {
        let view = picture.view();
        let readout = match expect {
            Some(expect) => read_expecting(&view, &expect(frames.len())),
            None => video_code::read_frame(&view),
        };
        let size = (
            picture.frame.width() as usize,
            picture.frame.height() as usize,
        );
        let camera_region = (frames.len() % LAYOUT_SAMPLE_EVERY == 0
            && matches!(readout.camera, video_code::Readout::Marker { .. }))
        .then(|| video_code::locate_region(&view, StreamKind::Camera))
        .flatten()
        .map(|r| video_code::Region {
            x0: r.x0 / size.0 as f64,
            x1: r.x1 / size.0 as f64,
            y0: r.y0 / size.1 as f64,
            y1: r.y1 / size.1 as f64,
        });
        let screen_colour = (frames.len() % LAYOUT_SAMPLE_EVERY == 0)
            .then(|| screen_colour(&picture.frame, &view))
            .flatten();
        frames.push(OutputFrame {
            pts_secs: picture.pts_secs,
            readout,
            hash: picture_hash(&picture.frame),
            size,
            camera_region,
            screen_colour,
        })
    })
    .unwrap_or_else(|e| panic!("decode {path:?}: {e:?}"));
    frames
}

pub fn read_expecting(
    img: &impl video_code::PixelSource,
    expectation: &cap_verify::model::FrameExpectation,
) -> FrameReadout {
    let readout = FrameReadout {
        screen: oracle::read_expecting(img, StreamKind::Screen, &expectation.screen),
        camera: oracle::read_expecting(img, StreamKind::Camera, &expectation.camera),
    };
    if std::env::var("CAP_VERIFY_TRACE_BLEND").as_deref() == Ok("1") {
        for (kind, expected, observed) in [
            (StreamKind::Screen, &expectation.screen, &readout.screen),
            (StreamKind::Camera, &expectation.camera, &readout.camera),
        ] {
            if matches!(expected, StreamExpectation::Blend { .. })
                && let Ok(cells) = video_code::read_cells(img, kind)
            {
                eprintln!(
                    "[cap-verify-blend] {}",
                    serde_json::json!({
                        "stream": kind,
                        "expected": expected,
                        "observed": observed,
                        "contrast": cells.contrast,
                        "levels": cells.levels,
                    })
                );
            }
        }
    }
    readout
}

/// Checks a sequential output (export or sequential playback) frame by frame
/// against the model.
pub fn check_sequence(
    case: &mut Case,
    model: &ReferenceModel,
    frames: &[OutputFrame],
    fps: u32,
    check_timestamps: bool,
) {
    let expected_count = model.output_frames(fps);
    if frames.len() as u32 != expected_count {
        case.measure(
            "frame-count",
            "missing",
            f64::from(expected_count) - frames.len() as f64,
        );
        case.problem(
            "frame-count",
            format!(
                "output has {} frames, the model expects {expected_count} ({:.3}s at {fps} fps)",
                frames.len(),
                model.duration()
            ),
        );
    }
    if check_timestamps {
        let off_grid: Vec<(usize, f64)> = frames
            .iter()
            .enumerate()
            .filter(|(i, f)| (f.pts_secs - *i as f64 / f64::from(fps)).abs() > 0.5 / f64::from(fps))
            .map(|(i, f)| (i, f.pts_secs))
            .collect();
        if !off_grid.is_empty() {
            // Signature: how many frames, from which frame, and how far off
            // the grid in frame periods (a one-slot shift is exactly 1).
            for &(i, pts) in &off_grid {
                case.measure("timestamps", "frame", i as f64);
                case.measure(
                    "timestamps",
                    "off-periods",
                    ((pts * f64::from(fps) - i as f64).abs() * 100.0).round() / 100.0,
                );
            }
            case.count("timestamps", "frames", off_grid.len() as f64);
            case.problem(
                "timestamps",
                format!(
                    "output timestamps off the {fps} fps grid in {} frames: {:?}",
                    off_grid.len(),
                    &off_grid[..off_grid.len().min(5)]
                ),
            );
        }
    }
    let n = frames.len().min(expected_count as usize);
    let expectations: Vec<_> = (0..n as u32).map(|i| model.expect(i, fps)).collect();
    for kind in StreamKind::ALL {
        let exp: Vec<StreamExpectation> =
            expectations.iter().map(|e| e.get(kind).clone()).collect();
        let obs: Vec<_> = frames[..n]
            .iter()
            .map(|f| f.readout.get(kind).clone())
            .collect();
        case.stream(oracle::check_stream(kind, &exp, &obs, fps));
    }
}

/// Product contract for exported MP4s: a keyframe at least every
/// `DEFAULT_KEYFRAME_INTERVAL_SECS` (2 s, crates/enc-ffmpeg h264.rs), so
/// shared videos seek quickly.
pub const MAX_KEYFRAME_INTERVAL_SECS: f64 = 2.0;
/// Colour checks on a flat key-colour band (code values).
pub const COLOUR_LEVEL_TOLERANCE: f64 = 4.0;
pub const COLOUR_MATRIX_TOLERANCE: f64 = 2.0;

/// Presentation checks every export gets on top of frame identity: the
/// keyframe interval (MP4), camera mirroring (the code reads mirrored exactly
/// when the project mirrors the camera; the screen never is), and camera
/// placement (the camera's key region lies in the corner/edge the project
/// asks for).
pub fn check_presentation(
    case: &mut Case,
    config: &ProjectConfiguration,
    frames: &[OutputFrame],
    path: &Path,
    fps: u32,
    keyframes: bool,
) {
    if keyframes {
        match media::keyframe_times(path) {
            Err(e) => case.problem("error", format!("keyframes: {e}")),
            Ok(times) => {
                let end = frames.len() as f64 / f64::from(fps);
                let slack = 1.0 / f64::from(fps) + 1e-3;
                let mut previous = 0.0;
                let mut worst: Option<(f64, f64)> = None;
                if times.first().is_none_or(|&t| t > slack) {
                    case.problem(
                        "keyframes",
                        format!("the first frame is not a keyframe (keyframes {times:?})"),
                    );
                }
                for &t in times.iter().chain(std::iter::once(&end)) {
                    let gap = t - previous;
                    if gap > MAX_KEYFRAME_INTERVAL_SECS + slack
                        && worst.is_none_or(|(_, g)| gap > g)
                    {
                        worst = Some((previous, gap));
                    }
                    previous = t;
                }
                if let Some((from, gap)) = worst {
                    case.problem(
                        "keyframes",
                        format!(
                            "{gap:.3} s without a keyframe from {from:.3} s (contract: at most {MAX_KEYFRAME_INTERVAL_SECS} s; {} keyframes in {end:.3} s)",
                            times.len()
                        ),
                    );
                }
            }
        }
    }

    let mut wrong_mirror = Vec::new();
    for (i, frame) in frames.iter().enumerate() {
        for kind in StreamKind::ALL {
            if let video_code::Readout::Marker { mirrored, .. } = frame.readout.get(kind) {
                let expected = kind == StreamKind::Camera && config.camera.mirror;
                if *mirrored != expected {
                    wrong_mirror.push((i, kind.name(), *mirrored));
                }
            }
        }
    }
    if !wrong_mirror.is_empty() {
        case.problem(
            "mirror",
            format!(
                "{} frames show a stream mirrored wrongly (camera mirror setting {}): first {:?}",
                wrong_mirror.len(),
                config.camera.mirror,
                &wrong_mirror[..wrong_mirror.len().min(5)]
            ),
        );
    }

    // Colour level: the screen's key colour must decode, under the stream's
    // own colour tag (what players use), to the source luma. (Its chroma
    // barely separates BT.601 from BT.709; `check_colour` covers the matrix
    // with a saturated colour.)
    let level: Vec<(usize, f64)> = frames
        .iter()
        .enumerate()
        .filter_map(|(i, frame)| {
            let colour = frame.screen_colour?;
            let [dy, _, _] = colour_error(&colour, StreamKind::Screen.key_rgb());
            (dy.abs() > COLOUR_LEVEL_TOLERANCE).then_some((i, dy))
        })
        .collect();
    for (_, dy) in &level {
        case.measure("colour-level", "luma", *dy);
    }
    if let Some((i, dy)) = level.first() {
        case.problem(
            "colour-level",
            format!(
                "screen key colour luma off by {dy:+.1} code values in {} sampled frames (first frame {i}; tolerance {COLOUR_LEVEL_TOLERANCE})",
                level.len()
            ),
        );
    }

    use cap_project::{CameraXPosition, CameraYPosition};
    let mut misplaced = Vec::new();
    for (i, frame) in frames.iter().enumerate() {
        let Some(r) = frame.camera_region else {
            continue;
        };
        let (cx, cy) = ((r.x0 + r.x1) / 2.0, (r.y0 + r.y1) / 2.0);
        let x_ok = match config.camera.position.x {
            CameraXPosition::Left => cx < 0.5,
            CameraXPosition::Center => (cx - 0.5).abs() < 0.05,
            CameraXPosition::Right => cx > 0.5,
        };
        let y_ok = match config.camera.position.y {
            CameraYPosition::Top => cy < 0.5,
            CameraYPosition::Bottom => cy > 0.5,
        };
        if !(x_ok && y_ok) {
            misplaced.push((
                i,
                (cx * 1000.0).round() / 1000.0,
                (cy * 1000.0).round() / 1000.0,
            ));
        }
    }
    if !misplaced.is_empty() {
        case.problem(
            "layout",
            format!(
                "camera drawn away from its {:?}/{:?} position in {} sampled frames (frame, centre x, centre y as fractions): {:?}",
                config.camera.position.x,
                config.camera.position.y,
                misplaced.len(),
                &misplaced[..misplaced.len().min(5)]
            ),
        );
    }
}

pub fn finish(case: Case) {
    if let Err(message) = report::settle(case) {
        panic!("{message}");
    }
}

pub fn scratch_dir(name: &str) -> tempfile::TempDir {
    let root = fixture::fixture_root().join("scratch");
    std::fs::create_dir_all(&root).expect("scratch root");
    tempfile::Builder::new()
        .prefix(&format!("{}-", name.replace('/', "_")))
        .tempdir_in(root)
        .expect("scratch dir")
}

/// Drives the editor's decode + render path offline, one requested frame
/// at a time (no wall clock): `create_segments` decoders, `FrameRenderer`,
/// `RendererLayers`. Seeks use `get_frames_initial` like the preview
/// renderer; frames that follow a seek use `get_frames` like playback.
pub struct Player {
    constants: std::sync::Arc<cap_rendering::RenderVideoConstants>,
    segments: Vec<cap_editor::SegmentMedia>,
    renderer: Option<cap_rendering::FrameRenderer<'static>>,
    layers: cap_rendering::RendererLayers,
    zooms: Vec<cap_rendering::ZoomTransformTimeline>,
    outgoing_zooms: std::collections::HashMap<u32, cap_rendering::ZoomTransformTimeline>,
    config: std::sync::Arc<ProjectConfiguration>,
    duration: f64,
    resolution: XY<u32>,
}

impl Player {
    pub async fn open(
        project: &Project,
        config: ProjectConfiguration,
        decoder: Decoder,
        resolution: (u32, u32),
    ) -> Result<Self, String> {
        let meta = project.meta.studio_meta().ok_or("not studio")?.clone();
        let recordings = cap_rendering::ProjectRecordingsMeta::new(&project.path, &meta)?;
        let constants = std::sync::Arc::new(
            cap_rendering::RenderVideoConstants::new(
                &recordings.segments,
                project.meta.clone(),
                meta.clone(),
            )
            .await
            .map_err(|e| format!("render constants: {e}"))?,
        );
        let segments =
            cap_editor::create_segments(&project.meta, &meta, decoder == Decoder::Ffmpeg).await?;
        let mut layers = cap_rendering::RendererLayers::new_with_options(
            &constants.device,
            &constants.queue,
            constants.is_software_adapter,
        );
        let (sw, sh) = segments[0].decoders.screen_video_dimensions();
        let camera = segments[0].decoders.camera_video_dimensions();
        layers.prepare_for_video_dimensions(
            &constants.device,
            sw,
            sh,
            camera.map(|c| c.0),
            camera.map(|c| c.1),
        );
        let duration = config.timeline.as_ref().map_or(0.0, |t| t.duration());
        let zooms = segments
            .iter()
            .map(|s| {
                cap_rendering::ZoomTransformTimeline::from_project(
                    &config,
                    &s.cursor,
                    duration,
                    constants.options.screen_size,
                )
            })
            .collect();
        // The renderer borrows the constants; both live as long as the
        // player, and the Arc keeps the constants' address stable.
        let constants_ref: &'static cap_rendering::RenderVideoConstants =
            unsafe { &*std::sync::Arc::as_ptr(&constants) };
        Ok(Self {
            renderer: Some(cap_rendering::FrameRenderer::new(constants_ref)),
            constants,
            segments,
            layers,
            zooms,
            outgoing_zooms: Default::default(),
            config: std::sync::Arc::new(config),
            duration,
            resolution: XY::new(resolution.0, resolution.1),
        })
    }

    /// Flags streams that are not on `decoder` (checked after the run, so a
    /// mid-run fallback is caught too).
    pub fn check_decoders(&self, case: &mut Case, decoder: Decoder) {
        check_decoders(case, decoder, &self.segments);
        case.note(format!(
            "render adapter: {}{}",
            self.constants.adapter_name(),
            if self.constants.is_software_adapter {
                " (software)"
            } else {
                ""
            }
        ));
    }

    pub fn prefer_sequential(&self) {
        for segment in &self.segments {
            segment.decoders.prefer_sequential_access();
        }
    }

    /// Renders output frame `frame` and reads its markers. `None` when the
    /// timeline has no segment there or the decoders returned nothing.
    pub async fn frame(
        &mut self,
        frame: u32,
        fps: u32,
        seek: bool,
        expectation: Option<&cap_verify::model::FrameExpectation>,
    ) -> Result<FrameReadout, String> {
        let t = f64::from(frame) / f64::from(fps);
        let mapping = self
            .config
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.get_frame_mapping(t))
            .ok_or_else(|| format!("no timeline segment at {t:.3}s"))?;
        let (incoming, outgoing) = match mapping {
            cap_project::TimelineFrameMapping::Single { source, .. }
            | cap_project::TimelineFrameMapping::Hold { source, .. } => {
                ((source.segment.recording_clip, source.source_time), None)
            }
            cap_project::TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind,
                progress,
                ..
            } => (
                (incoming.segment.recording_clip, incoming.source_time),
                Some((
                    outgoing.segment.recording_clip,
                    outgoing.source_time,
                    kind,
                    progress,
                )),
            ),
        };
        let incoming_frames = self.fetch(incoming.0, incoming.1, seek).await?;
        let rendered = if let Some((clip, time, kind, progress)) = outgoing {
            let outgoing_frames = self.fetch(clip, time, seek).await?;
            let screen_size = self.constants.options.screen_size;
            let outgoing_zoom = self.outgoing_zooms.entry(clip).or_insert_with(|| {
                cap_rendering::ZoomTransformTimeline::from_project_for_outgoing_clip(
                    &self.config,
                    &self.segments[clip as usize].cursor,
                    self.duration,
                    screen_size,
                    clip,
                )
            });
            outgoing_zoom.ensure_precomputed_until((frame as f32 + 1.0) / fps as f32);
            let outgoing_uniforms = cap_rendering::ProjectUniforms::new(
                &self.constants,
                &self.config,
                frame,
                fps,
                self.resolution,
                &self.segments[clip as usize].cursor,
                &outgoing_frames,
                self.duration,
                outgoing_zoom,
            );
            let zoom = &mut self.zooms[incoming.0 as usize];
            zoom.ensure_precomputed_until((frame as f32 + 1.0) / fps as f32);
            let incoming_uniforms = cap_rendering::ProjectUniforms::new(
                &self.constants,
                &self.config,
                frame,
                fps,
                self.resolution,
                &self.segments[incoming.0 as usize].cursor,
                &incoming_frames,
                self.duration,
                zoom,
            );
            self.renderer
                .as_mut()
                .expect("renderer")
                .render_transition_immediate(
                    cap_rendering::TransitionRenderInput {
                        segment_frames: outgoing_frames,
                        uniforms: outgoing_uniforms,
                        cursor: &self.segments[clip as usize].cursor,
                        render_display: true,
                    },
                    cap_rendering::TransitionRenderInput {
                        segment_frames: incoming_frames,
                        uniforms: incoming_uniforms,
                        cursor: &self.segments[incoming.0 as usize].cursor,
                        render_display: true,
                    },
                    kind,
                    progress as f32,
                    &mut self.layers,
                )
                .await
                .map_err(|e| format!("render transition: {e}"))?
        } else {
            let media = &self.segments[incoming.0 as usize];
            let zoom = &mut self.zooms[incoming.0 as usize];
            zoom.ensure_precomputed_until((frame as f32 + 1.0) / fps as f32);
            let uniforms = cap_rendering::ProjectUniforms::new(
                &self.constants,
                &self.config,
                frame,
                fps,
                self.resolution,
                &media.cursor,
                &incoming_frames,
                self.duration,
                zoom,
            );
            self.renderer
                .as_mut()
                .expect("renderer")
                .render_immediate(
                    incoming_frames,
                    uniforms,
                    &media.cursor,
                    true,
                    &mut self.layers,
                )
                .await
                .map_err(|e| format!("render: {e}"))?
        };
        let view = video_code::PackedFrame {
            data: &rendered.data,
            width: rendered.width as usize,
            height: rendered.height as usize,
            stride: rendered.padded_bytes_per_row as usize,
            order: video_code::PixelOrder::Rgba,
        };
        Ok(match expectation {
            Some(expectation) => read_expecting(&view, expectation),
            None => video_code::read_frame(&view),
        })
    }
}

impl Player {
    /// Decodes the frames for recording `clip` at recording `time`, as a
    /// seek (`get_frames_initial`) or as playback (`get_frames`).
    async fn fetch(
        &self,
        clip: u32,
        time: f64,
        seek: bool,
    ) -> Result<cap_rendering::DecodedSegmentFrames, String> {
        let media = &self.segments[clip as usize];
        let offsets = self
            .config
            .clips
            .iter()
            .find(|c| c.index == clip)
            .map(|c| c.offsets)
            .unwrap_or_default();
        let needs_camera = !self.config.camera.hide;
        if seek {
            media
                .decoders
                .get_frames_initial(time as f32, needs_camera, true, offsets)
                .await
        } else {
            media
                .decoders
                .get_frames(time as f32, needs_camera, true, offsets)
                .await
        }
        .ok_or_else(|| format!("decoders returned no frame for clip {clip} at {time:.3}s"))
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // Drop the renderer before the constants it borrows.
        self.renderer.take();
    }
}

/// Checks a list of (output frame, readout) pairs against the model.
pub fn check_requests(
    case: &mut Case,
    model: &ReferenceModel,
    frames: &[u32],
    readouts: &[FrameReadout],
    fps: u32,
) {
    let expectations: Vec<_> = frames.iter().map(|&f| model.expect(f, fps)).collect();
    for kind in StreamKind::ALL {
        let exp: Vec<StreamExpectation> =
            expectations.iter().map(|e| e.get(kind).clone()).collect();
        let obs: Vec<_> = readouts.iter().map(|r| r.get(kind).clone()).collect();
        case.stream(oracle::check_stream_at(kind, &exp, &obs, frames, fps));
    }
}

pub fn assert_passed(failures: Vec<String>) {
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// What the playback loop reported about one real-time run.
#[derive(Debug, Default)]
pub struct RealtimeTelemetry {
    /// From `Playback::start` to the clock starting (warm-up done), if it did.
    pub ready_after: Option<std::time::Duration>,
    pub warmup_buffered: Option<(usize, usize)>,
    /// Frames the loop skipped on purpose, by reason.
    pub skipped: std::collections::BTreeMap<String, u64>,
    pub renderer_dropped: u64,
}

impl RealtimeTelemetry {
    pub fn describe(&self) -> String {
        format!(
            "playback ready after {}, warm-up buffered {}, skipped {:?}, renderer dropped {}",
            self.ready_after.map_or("never".to_string(), |d| format!(
                "{:.0} ms",
                d.as_secs_f64() * 1000.0
            )),
            self.warmup_buffered
                .map_or("-".to_string(), |(b, t)| format!("{b}/{t}")),
            self.skipped,
            self.renderer_dropped
        )
    }
}

/// Runs the editor's real-time playback loop (`cap_editor::Playback`: warm-up,
/// prefetch, frame cache, wall clock) from `start_frame` and returns every
/// frame it delivered, read with `expect(frame number)` (so transition frames
/// are read as blends), plus the loop's telemetry. The `seconds` window starts
/// when the playback clock starts (warm-up finished), not when `start`
/// returns, so a slow warm-up does not eat the measured window.
/// Video only (`create_segments_without_audio`): the audio clock has its own
/// oracle. Dropped frames are normal under load; delivered ones must be right.
#[allow(clippy::too_many_arguments)]
pub async fn realtime_playback(
    case: &mut Case,
    project: &Project,
    config: ProjectConfiguration,
    decoder: Decoder,
    resolution: (u32, u32),
    fps: u32,
    start_frame: u32,
    seconds: f64,
    expect: &dyn Fn(u32) -> cap_verify::model::FrameExpectation,
) -> Result<(Vec<(u32, FrameReadout)>, RealtimeTelemetry), String> {
    use std::sync::{Arc, Mutex};
    const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
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
    let segments = Arc::new(
        cap_editor::create_segments_without_audio(&project.meta, &meta, decoder == Decoder::Ffmpeg)
            .await?,
    );
    // The case is labelled by decoder: it must be the decoder that runs.
    check_decoders(case, decoder, &segments);
    let layers_rx = cap_editor::start_renderer_layers_creation(&constants, &config);
    let layers_rx = cap_editor::finish_renderer_layers_creation(layers_rx).await;
    let delivered: Arc<Mutex<Vec<cap_rendering::RenderedFrame>>> = Default::default();
    let sink = delivered.clone();
    let frame_cb: cap_editor::EditorFrameCallback = Box::new(move |output, _| {
        if let cap_editor::EditorFrameOutput::Rgba(frame) = output {
            sink.lock().unwrap().push(frame);
        }
    });
    let renderer = Arc::new(cap_editor::Renderer::spawn(
        constants.clone(),
        frame_cb,
        layers_rx,
    )?);
    let (_project_tx, project_rx) = tokio::sync::watch::channel(config);
    let (audio_output, _audio_sink) = cap_editor::AudioOutput::new_offline();
    let (telemetry, mut telemetry_rx) = cap_editor::PlaybackTelemetry::channel();
    let playback = cap_editor::Playback {
        renderer,
        render_constants: constants,
        start_frame_number: start_frame,
        project: project_rx,
        segment_medias: segments,
        music: cap_editor::MusicTracks::new(),
        audio_output: Arc::new(audio_output),
        telemetry: Some(telemetry),
    };
    let started = std::time::Instant::now();
    let handle = playback
        .start(fps, XY::new(resolution.0, resolution.1))
        .await
        .map_err(|e| format!("playback start: {e:?}"))?;
    let mut report = RealtimeTelemetry::default();
    let absorb = |event: cap_editor::PlaybackTelemetryEvent, report: &mut RealtimeTelemetry| {
        use cap_editor::PlaybackTelemetryEvent as E;
        match event {
            E::WarmupComplete {
                buffered_frames,
                target_frames,
                ..
            } => report.warmup_buffered = Some((buffered_frames, target_frames)),
            E::ClockStarted { .. } => report.ready_after = Some(started.elapsed()),
            E::FrameSkipped {
                skipped, reason, ..
            } => *report.skipped.entry(format!("{reason:?}")).or_default() += u64::from(skipped),
            E::RendererDropped { .. } => report.renderer_dropped += 1,
            _ => {}
        }
    };
    let ready_deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    while report.ready_after.is_none() {
        match tokio::time::timeout_at(ready_deadline, telemetry_rx.recv()).await {
            Ok(Some(event)) => absorb(event, &mut report),
            _ => break,
        }
    }
    if report.ready_after.is_some() {
        tokio::time::sleep(std::time::Duration::from_secs_f64(seconds)).await;
    }
    handle.stop();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    while let Ok(event) = telemetry_rx.try_recv() {
        absorb(event, &mut report);
    }
    let frames = std::mem::take(&mut *delivered.lock().unwrap());
    let frames = frames
        .into_iter()
        .map(|frame| {
            let view = video_code::PackedFrame {
                data: &frame.data,
                width: frame.width as usize,
                height: frame.height as usize,
                stride: frame.padded_bytes_per_row as usize,
                order: video_code::PixelOrder::Rgba,
            };
            (
                frame.frame_number,
                read_expecting(&view, &expect(frame.frame_number)),
            )
        })
        .collect();
    Ok((frames, report))
}
