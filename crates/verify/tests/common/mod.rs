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
    pub path: PathBuf,
    pub meta: RecordingMeta,
    pub truth: SourceTruth,
}

pub fn project(spec: &FixtureSpec) -> Project {
    init();
    let path = fixture::ensure_fixture(spec, fixture::write_fixture)
        .unwrap_or_else(|e| panic!("fixture {}: {e:?}", spec.name));
    let meta = RecordingMeta::load_for_project(&path).expect("fixture meta");
    let truth = SourceTruth::read(&path).expect("fixture truth");
    Project { path, meta, truth }
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
    let planes = if frame.format() == ffmpeg::format::Pixel::NV12 { 2 } else { 3 };
    for plane in 0..planes.min(frame.planes()) {
        let width = frame.plane_width(plane) as usize
            * if frame.format() == ffmpeg::format::Pixel::NV12 && plane == 1 { 2 } else { 1 };
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
        case.problem(format!(
            "output has {} frames, the model expects {expected_count} ({:.3}s at {fps} fps)",
            frames.len(),
            model.duration()
        ));
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
            case.problem(format!("output timestamps off the {fps} fps grid: {off_grid:?}"));
        }
    }
    let n = frames.len().min(expected_count as usize);
    let expectations: Vec<_> = (0..n as u32).map(|i| model.expect(i, fps)).collect();
    for kind in StreamKind::ALL {
        let exp: Vec<StreamExpectation> = expectations.iter().map(|e| e.get(kind).clone()).collect();
        let obs: Vec<_> = frames[..n].iter().map(|f| f.readout.get(kind).clone()).collect();
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
