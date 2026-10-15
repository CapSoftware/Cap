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

pub fn init() {
    media::init();
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

fn load(name: &str, path: PathBuf) -> Project {
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
                custom_bpp: None,
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
}

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
        frames.push(OutputFrame {
            pts_secs: picture.pts_secs,
            readout,
            hash: picture_hash(&picture.frame),
        })
    })
    .unwrap_or_else(|e| panic!("decode {path:?}: {e:?}"));
    frames
}

pub fn read_expecting(
    img: &impl video_code::PixelSource,
    expectation: &cap_verify::model::FrameExpectation,
) -> FrameReadout {
    FrameReadout {
        screen: oracle::read_expecting(img, StreamKind::Screen, &expectation.screen),
        camera: oracle::read_expecting(img, StreamKind::Camera, &expectation.camera),
    }
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
            .take(5)
            .collect();
        if !off_grid.is_empty() {
            case.problem(
                "timestamps",
                format!("output timestamps off the {fps} fps grid: {off_grid:?}"),
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
    config: ProjectConfiguration,
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
            config,
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
