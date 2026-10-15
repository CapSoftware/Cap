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
    /// The platform default (AVAssetReader on macOS, FFmpeg elsewhere).
    Default,
    /// `--force-ffmpeg-decoder`.
    Ffmpeg,
}

impl Decoder {
    pub fn label(self) -> &'static str {
        match self {
            Decoder::Default if cfg!(target_os = "macos") => "avf",
            Decoder::Default => "ffmpeg",
            Decoder::Ffmpeg => "ffmpeg",
        }
    }

    /// Decoders that are actually distinct on this platform.
    pub fn all() -> Vec<Decoder> {
        if cfg!(target_os = "macos") {
            vec![Decoder::Default, Decoder::Ffmpeg]
        } else {
            vec![Decoder::Default]
        }
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

pub fn read_output(path: &Path) -> Vec<OutputFrame> {
    let mut frames = Vec::new();
    media::decode_video(path, |picture| {
        frames.push(OutputFrame {
            pts_secs: picture.pts_secs,
            readout: video_code::read_frame(&picture.view()),
            hash: picture_hash(&picture.frame),
        })
    })
    .unwrap_or_else(|e| panic!("decode {path:?}: {e:?}"));
    frames
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
            config,
            duration,
            resolution: XY::new(resolution.0, resolution.1),
        })
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
    ) -> Result<FrameReadout, String> {
        let t = f64::from(frame) / f64::from(fps);
        let (segment_time, segment) = self
            .config
            .get_segment_time(t)
            .ok_or_else(|| format!("no timeline segment at {t:.3}s"))?;
        let clip = segment.recording_clip;
        let media = &self.segments[clip as usize];
        let offsets = self
            .config
            .clips
            .iter()
            .find(|c| c.index == clip)
            .map(|c| c.offsets)
            .unwrap_or_default();
        let needs_camera = !self.config.camera.hide;
        let frames = if seek {
            media
                .decoders
                .get_frames_initial(segment_time as f32, needs_camera, true, offsets)
                .await
        } else {
            media
                .decoders
                .get_frames(segment_time as f32, needs_camera, true, offsets)
                .await
        }
        .ok_or_else(|| format!("decoders returned no frame at {t:.3}s"))?;
        let zoom = &mut self.zooms[clip as usize];
        zoom.ensure_precomputed_until((frame as f32 + 1.0) / fps as f32);
        let uniforms = cap_rendering::ProjectUniforms::new(
            &self.constants,
            &self.config,
            frame,
            fps,
            self.resolution,
            &media.cursor,
            &frames,
            self.duration,
            zoom,
        );
        let rendered = self
            .renderer
            .as_mut()
            .expect("renderer")
            .render_immediate(frames, uniforms, &media.cursor, true, &mut self.layers)
            .await
            .map_err(|e| format!("render: {e}"))?;
        let view = video_code::PackedFrame {
            data: &rendered.data,
            width: rendered.width as usize,
            height: rendered.height as usize,
            stride: rendered.padded_bytes_per_row as usize,
            order: video_code::PixelOrder::Rgba,
        };
        Ok(video_code::read_frame(&view))
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
