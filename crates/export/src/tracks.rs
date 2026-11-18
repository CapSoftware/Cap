//! Export a Studio project's recorded tracks as separate files that follow
//! the edited timeline, so they line up with the main export in an editor.
//!
//! Video tracks read the same decoders, at the same output frame times, as the
//! rendered export. Audio tracks run the editor's audio renderer with one
//! source loaded, sized by the same per-frame sample budget as the MP4 audio.

use std::{
    fs::File,
    io::{BufWriter, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use cap_editor::{AudioRenderer, SegmentMedia, audio_segment_from_decoded};
use cap_enc_ffmpeg::{h264::H264Encoder, mp4::MP4File};
use cap_media_info::VideoInfo;
use cap_project::{ProjectConfiguration, RecordingMeta};
use cap_rendering::{DecodedFrame, PixelFormat, ProjectRecordingsMeta, cpu_yuv::YuvMatrix};
use ffmpeg::{format::Pixel, frame, software::scaling};

use crate::mp4::{ExportCompression, audio_frame_budget};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TrackKind {
    Screen,
    Camera,
    Microphone,
    SystemAudio,
}

impl TrackKind {
    pub const ALL: [Self; 4] = [
        Self::Screen,
        Self::Camera,
        Self::Microphone,
        Self::SystemAudio,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Self::Screen => "screen",
            Self::Camera => "camera",
            Self::Microphone => "microphone",
            Self::SystemAudio => "system-audio",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Self> {
        match slug.trim().to_ascii_lowercase().as_str() {
            "screen" | "display" => Some(Self::Screen),
            "camera" => Some(Self::Camera),
            "microphone" | "mic" => Some(Self::Microphone),
            "system-audio" | "system_audio" | "system" => Some(Self::SystemAudio),
            _ => None,
        }
    }

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Screen => "Screen.mp4",
            Self::Camera => "Camera.mp4",
            Self::Microphone => "Microphone.wav",
            Self::SystemAudio => "System audio.wav",
        }
    }

    pub fn is_video(self) -> bool {
        matches!(self, Self::Screen | Self::Camera)
    }
}

/// Tracks recorded in at least one clip the timeline plays. A track that only
/// exists in clips the edit removed would export as silence or black.
pub fn available_tracks(
    recordings: &ProjectRecordingsMeta,
    project: &ProjectConfiguration,
) -> Vec<TrackKind> {
    let used = |index: usize| {
        project.timeline.as_ref().is_none_or(|timeline| {
            timeline
                .segments
                .iter()
                .any(|segment| segment.recording_clip as usize == index)
        })
    };
    let clips = || {
        recordings
            .segments
            .iter()
            .enumerate()
            .filter(|(index, _)| used(*index))
            .map(|(_, segment)| segment)
    };
    TrackKind::ALL
        .into_iter()
        .filter(|kind| match kind {
            TrackKind::Screen => clips().next().is_some(),
            TrackKind::Camera => clips().any(|segment| segment.camera.is_some()),
            TrackKind::Microphone => clips().any(|segment| segment.mic.is_some()),
            TrackKind::SystemAudio => clips().any(|segment| segment.system_audio.is_some()),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackExportError {
    Cancelled,
    NotStudio,
    NothingSelected,
    Unavailable(TrackKind),
    Failed(String),
}

impl std::fmt::Display for TrackExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "Export cancelled"),
            Self::NotStudio => write!(
                f,
                "Separate tracks are only recorded in Studio Mode. Instant recordings are a single video."
            ),
            Self::NothingSelected => write!(f, "Choose at least one track to export"),
            Self::Unavailable(kind) => write!(
                f,
                "This recording has no {} track",
                match kind {
                    TrackKind::Screen => "screen",
                    TrackKind::Camera => "camera",
                    TrackKind::Microphone => "microphone",
                    TrackKind::SystemAudio => "system audio",
                }
            ),
            Self::Failed(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for TrackExportError {}

impl From<String> for TrackExportError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

pub struct TrackExportSettings {
    pub tracks: Vec<TrackKind>,
    pub fps: u32,
    pub force_ffmpeg_decoder: bool,
}

/// One export's worth of work: every video frame counts once (screen and
/// camera share a decode pass) and every audio track counts its frames again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackProgress {
    pub done: u64,
    pub total: u64,
}

pub fn progress_total(tracks: &[TrackKind], total_frames: u32) -> u64 {
    let video_pass = u64::from(tracks.iter().any(|kind| kind.is_video()));
    let audio = tracks.iter().filter(|kind| !kind.is_video()).count() as u64;
    (video_pass + audio) * u64::from(total_frames)
}

/// Writes the selected tracks into `output_dir` and returns their paths in
/// [`TrackKind::ALL`] order. Files are written under temporary names and
/// renamed only once every track has finished, so a cancelled or failed
/// export leaves nothing half written and earlier exports untouched.
pub async fn export_tracks(
    project_path: PathBuf,
    config: Option<ProjectConfiguration>,
    settings: TrackExportSettings,
    output_dir: PathBuf,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(TrackProgress) + Send,
) -> Result<Vec<PathBuf>, TrackExportError> {
    let _export_activity = cap_rendering::ExportActivity::begin();
    let mut tracks = settings.tracks.clone();
    tracks.sort();
    tracks.dedup();
    if tracks.is_empty() {
        return Err(TrackExportError::NothingSelected);
    }
    if settings.fps == 0 {
        return Err(TrackExportError::Failed(
            "The frame rate must be greater than zero".into(),
        ));
    }
    let prepared = prepare(
        &project_path,
        config,
        &tracks,
        settings.force_ffmpeg_decoder,
    )
    .await?;
    if cancel.load(Ordering::Relaxed) {
        return Err(TrackExportError::Cancelled);
    }

    if output_dir.is_file() {
        return Err(TrackExportError::Failed(format!(
            "{} is a file, not a folder",
            output_dir.display()
        )));
    }
    std::fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Could not create {}: {error}", output_dir.display()))?;

    let total_frames = total_frames(prepared.duration, settings.fps);
    let total = progress_total(&tracks, total_frames);
    let mut reporter = ProgressReporter {
        done: 0,
        total,
        on_progress: &mut on_progress,
    };
    reporter.report();

    let token = export_token();
    let staged = tracks
        .iter()
        .map(|kind| (*kind, staging_path(&output_dir, *kind, &token)))
        .collect::<Vec<_>>();
    let mut cleanup = StagedFiles(staged.iter().map(|(_, path)| path.clone()).collect());

    let video = staged
        .iter()
        .filter(|(kind, _)| kind.is_video())
        .cloned()
        .collect::<Vec<_>>();
    if !video.is_empty() {
        export_video_tracks(
            &prepared,
            &video,
            settings.fps,
            total_frames,
            &cancel,
            &mut reporter,
        )
        .await?;
    }

    for (kind, path) in staged.iter().filter(|(kind, _)| !kind.is_video()) {
        export_audio_track(
            &prepared,
            *kind,
            path,
            settings.fps,
            total_frames,
            &cancel,
            &mut reporter,
        )
        .await?;
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(TrackExportError::Cancelled);
    }
    let files = staged
        .iter()
        .map(|(kind, path)| (path.clone(), output_dir.join(kind.file_name())))
        .collect::<Vec<_>>();
    publish(&files, &token)?;
    cleanup.0.clear();
    Ok(files
        .into_iter()
        .map(|(_, destination)| destination)
        .collect())
}

struct ProgressReporter<'a, F: FnMut(TrackProgress)> {
    done: u64,
    total: u64,
    on_progress: &'a mut F,
}

impl<F: FnMut(TrackProgress)> ProgressReporter<'_, F> {
    fn advance(&mut self) {
        self.done = (self.done + 1).min(self.total);
        self.report();
    }

    fn report(&mut self) {
        (self.on_progress)(TrackProgress {
            done: self.done,
            total: self.total,
        });
    }
}

pub(crate) struct StagedFiles(pub(crate) Vec<PathBuf>);

impl Drop for StagedFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Names this export's temporary files apart from any other export writing
/// to the same folder at the same time.
pub(crate) fn export_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

fn staging_path(dir: &Path, kind: TrackKind, token: &str) -> PathBuf {
    let extension = if kind.is_video() { "mp4" } else { "wav" };
    dir.join(format!(".{}.{token}.partial.{extension}", kind.slug()))
}

/// Moves every staged file onto its destination, all or nothing. Files
/// already there are set aside first and put back if any move fails, so a
/// failed export never leaves a mix of old and new tracks.
pub(crate) fn publish(files: &[(PathBuf, PathBuf)], token: &str) -> Result<(), String> {
    if let Some((_, folder)) = files.iter().find(|(_, destination)| destination.is_dir()) {
        return Err(format!(
            "{} is a folder, so the track cannot be saved there",
            folder.display()
        ));
    }
    let mut published: Vec<(&Path, Option<PathBuf>)> = Vec::with_capacity(files.len());
    for (staged, destination) in files {
        let name = destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let backup = if destination.exists() {
            let backup = destination.with_file_name(format!(".{name}.{token}.previous"));
            if let Err(error) = std::fs::rename(destination, &backup) {
                roll_back(&published);
                return Err(format!("Could not replace {name}: {error}"));
            }
            Some(backup)
        } else {
            None
        };
        if let Err(error) = std::fs::rename(staged, destination) {
            if let Some(backup) = &backup {
                let _ = std::fs::rename(backup, destination);
            }
            roll_back(&published);
            return Err(format!("Could not save {name}: {error}"));
        }
        published.push((destination, backup));
    }
    for (_, backup) in published {
        if let Some(backup) = backup {
            let _ = std::fs::remove_file(backup);
        }
    }
    Ok(())
}

fn roll_back(published: &[(&Path, Option<PathBuf>)]) {
    for (destination, backup) in published.iter().rev() {
        let _ = std::fs::remove_file(destination);
        if let Some(backup) = backup {
            let _ = std::fs::rename(backup, destination);
        }
    }
}

/// The rendered export's frame count for the same timeline and rate.
pub fn total_frames(duration: f64, fps: u32) -> u32 {
    (fps as f64 * duration).ceil() as u32
}

struct Prepared {
    project: ProjectConfiguration,
    recordings: Arc<ProjectRecordingsMeta>,
    segments: Vec<SegmentMedia>,
    duration: f64,
}

pub(crate) struct PreparedTimeline {
    pub recording_meta: RecordingMeta,
    pub project: ProjectConfiguration,
    pub recordings: Arc<ProjectRecordingsMeta>,
    pub duration: f64,
}

pub(crate) fn prepare_timeline(
    project_path: &Path,
    config: Option<ProjectConfiguration>,
) -> Result<PreparedTimeline, TrackExportError> {
    let recording_meta = RecordingMeta::load_for_project(project_path)
        .map_err(|error| format!("Could not read the recording: {error}"))?;
    let studio_meta = recording_meta
        .studio_meta()
        .ok_or(TrackExportError::NotStudio)?;
    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta)
            .map_err(TrackExportError::Failed)?,
    );
    let mut project = match config {
        Some(config) => config,
        None => ProjectConfiguration::load(project_path)
            .map_err(|error| format!("Could not read the project: {error}"))?,
    };
    crate::synthesize_default_timeline(&mut project, &recordings);
    let recording_durations = recordings
        .segments
        .iter()
        .map(|segment| segment.display.duration)
        .collect::<Vec<_>>();
    crate::fill_clip_offsets(
        &mut project,
        &recording_meta.project_path,
        studio_meta,
        &recording_durations,
    );
    cap_project::clamp_timeline_to_sources(
        &mut project,
        &cap_project::late_audio_trim_limits(studio_meta, &recording_durations),
    );

    Ok(PreparedTimeline {
        recording_meta,
        project,
        recordings,
        duration: 0.0,
    })
}

impl PreparedTimeline {
    pub(crate) fn measured(mut self) -> Result<Self, TrackExportError> {
        let studio_meta = self
            .recording_meta
            .studio_meta()
            .ok_or(TrackExportError::NotStudio)?;
        self.duration = cap_rendering::get_duration(
            &self.recordings,
            &self.recording_meta,
            studio_meta,
            &self.project,
        );
        if !self.duration.is_finite() || self.duration <= 0.0 {
            return Err(TrackExportError::Failed(
                "There is nothing to export: the timeline is empty".into(),
            ));
        }
        if let Some(timeline) = &self.project.timeline
            && timeline
                .segments
                .iter()
                .any(|segment| segment.recording_clip as usize >= self.recordings.segments.len())
        {
            return Err(TrackExportError::Failed(
                "The timeline refers to a clip this recording does not have".into(),
            ));
        }
        Ok(self)
    }
}

async fn prepare(
    project_path: &Path,
    config: Option<ProjectConfiguration>,
    tracks: &[TrackKind],
    force_ffmpeg_decoder: bool,
) -> Result<Prepared, TrackExportError> {
    let timeline = prepare_timeline(project_path, config)?;
    let available = available_tracks(&timeline.recordings, &timeline.project);
    if let Some(missing) = tracks.iter().find(|kind| !available.contains(kind)) {
        return Err(TrackExportError::Unavailable(*missing));
    }
    let PreparedTimeline {
        recording_meta,
        project,
        recordings,
        duration,
    } = timeline.measured()?;
    let studio_meta = recording_meta
        .studio_meta()
        .ok_or(TrackExportError::NotStudio)?;

    // Media Foundation hands out GPU textures that the track encoder cannot
    // read back; the FFmpeg decoders give CPU frames on every platform.
    let force_ffmpeg_decoder = force_ffmpeg_decoder || !cfg!(target_os = "macos");
    cap_editor::release_playback_audio_caches();
    let needs_audio = tracks.iter().any(|kind| !kind.is_video());
    let segments = if needs_audio {
        cap_editor::create_segments(&recording_meta, studio_meta, force_ffmpeg_decoder).await
    } else {
        cap_editor::create_segments_without_audio(
            &recording_meta,
            studio_meta,
            force_ffmpeg_decoder,
        )
        .await
    }
    .map_err(TrackExportError::Failed)?;
    if crate::reads_recordings_forward(&project) {
        for segment in &segments {
            segment.decoders.prefer_sequential_access();
        }
    }

    Ok(Prepared {
        project,
        recordings,
        segments,
        duration,
    })
}

/// The clip and source time the rendered export reads for each output frame:
/// the incoming clip during a transition and the frozen frame under a hold.
pub fn frame_source(project: &ProjectConfiguration, frame: u32, fps: u32) -> Option<(u32, f64)> {
    project
        .get_segment_time(frame as f64 / fps as f64)
        .map(|(time, segment)| (segment.recording_clip, time))
}

enum VideoJob {
    Frame(DecodedFrame),
    Repeat,
    Black,
}

struct VideoTrackWriter {
    jobs: mpsc::SyncSender<VideoJob>,
    thread: std::thread::JoinHandle<Result<(), String>>,
}

impl VideoTrackWriter {
    fn spawn(path: PathBuf, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        let (jobs, rx) = mpsc::sync_channel::<VideoJob>(4);
        let thread = std::thread::Builder::new()
            .name("track-export-video".into())
            .spawn(move || write_video_track(rx, path, width, height, fps))
            .map_err(|error| format!("Could not start the track encoder: {error}"))?;
        Ok(Self { jobs, thread })
    }

    fn send(&self, job: VideoJob) -> Result<(), String> {
        self.jobs
            .send(job)
            .map_err(|_| "The track encoder stopped early".to_string())
    }

    fn finish(self) -> Result<(), String> {
        drop(self.jobs);
        self.thread
            .join()
            .map_err(|_| "The track encoder crashed".to_string())?
    }

    fn abandon(self) {
        drop(self.jobs);
        let _ = self.thread.join();
    }
}

fn write_video_track(
    jobs: mpsc::Receiver<VideoJob>,
    path: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(), String> {
    let input = VideoInfo::from_raw_ffmpeg(Pixel::NV12, width, height, fps);
    let mut file = MP4File::init(
        "track",
        path,
        false,
        |output| {
            H264Encoder::builder(input)
                .with_bpp(ExportCompression::Maximum.bits_per_pixel())
                .with_export_priority()
                .with_export_settings()
                .build(output)
        },
        |_| None,
    )
    .map_err(|error| format!("Could not start the track encoder: {error}"))?;

    let mut converter = Nv12Converter::default();
    let mut current = black_nv12(width, height);
    for (index, job) in jobs.into_iter().enumerate() {
        match job {
            VideoJob::Frame(decoded) => converter.fill(&decoded, &mut current)?,
            VideoJob::Black => fill_black(&mut current),
            VideoJob::Repeat => {}
        }
        let timestamp = Duration::from_secs_f64(index as f64 / fps as f64);
        file.queue_video_frame(current.clone(), timestamp)
            .map_err(|error| format!("Encoding a track frame failed: {error}"))?;
    }
    let result = file
        .finish()
        .map_err(|error| format!("Could not finish the track: {error}"))?;
    result
        .video_finish
        .map_err(|error| format!("Could not finish the track: {error}"))
}

fn black_nv12(width: u32, height: u32) -> frame::Video {
    let mut frame = frame::Video::new(Pixel::NV12, width, height);
    fill_black(&mut frame);
    frame
}

fn fill_black(frame: &mut frame::Video) {
    frame.data_mut(0).fill(16);
    frame.data_mut(1).fill(128);
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ScalerKey {
    format: Pixel,
    width: u32,
    height: u32,
    target_width: u32,
    target_height: u32,
    bt709_source: bool,
}

#[derive(Default)]
struct Nv12Converter {
    scaler: Option<(ScalerKey, scaling::Context)>,
}

const SWS_CS_ITU709: i32 = 1;
const SWS_CS_ITU601: i32 = 5;

impl Nv12Converter {
    /// Writes `decoded` into `target`, NV12 at the track's size, in BT.709
    /// because that is how the encoder tags every track. A BT.709 frame of
    /// the same size is a plane copy; anything else (a BT.601 or untagged
    /// source, which the renderer also reads as BT.601, or a camera swapped
    /// mid-recording) goes through swscale with the source's matrix.
    fn fill(&mut self, decoded: &DecodedFrame, target: &mut frame::Video) -> Result<(), String> {
        let (width, height) = (decoded.width(), decoded.height());
        if width == 0 || height == 0 {
            return Err("A decoded frame has no size".into());
        }
        let bt709_source = decoded.matrix() == YuvMatrix::Bt709;
        if decoded.format() == PixelFormat::Nv12
            && bt709_source
            && width == target.width()
            && height == target.height()
        {
            return copy_nv12(decoded, target);
        }

        let source = source_frame(decoded)?;
        let key = ScalerKey {
            format: source.format(),
            width,
            height,
            target_width: target.width(),
            target_height: target.height(),
            bt709_source,
        };
        if self
            .scaler
            .as_ref()
            .is_none_or(|(current, _)| *current != key)
        {
            let mut context = scaling::Context::get(
                key.format,
                width,
                height,
                Pixel::NV12,
                key.target_width,
                key.target_height,
                scaling::Flags::BILINEAR,
            )
            .map_err(|error| format!("Could not convert a track frame: {error}"))?;
            let source_space = if bt709_source {
                SWS_CS_ITU709
            } else {
                SWS_CS_ITU601
            };
            // SAFETY: the context was just created and is exclusively owned;
            // sws_getCoefficients returns pointers to libswscale's static tables.
            unsafe {
                ffmpeg::ffi::sws_setColorspaceDetails(
                    context.as_mut_ptr(),
                    ffmpeg::ffi::sws_getCoefficients(source_space),
                    0,
                    ffmpeg::ffi::sws_getCoefficients(SWS_CS_ITU709),
                    0,
                    0,
                    1 << 16,
                    1 << 16,
                );
            }
            self.scaler = Some((key, context));
        }
        let Some((_, context)) = self.scaler.as_mut() else {
            return Err("Could not convert a track frame".into());
        };
        context
            .run(&source, target)
            .map_err(|error| format!("Could not convert a track frame: {error}"))
    }
}

fn unreadable() -> String {
    "A decoded frame could not be read back from the decoder".into()
}

fn copy_plane(
    source: &[u8],
    source_stride: usize,
    row_bytes: usize,
    rows: usize,
    target: &mut [u8],
    target_stride: usize,
) -> Result<(), String> {
    for row in 0..rows {
        let from = row * source_stride;
        let to = row * target_stride;
        let source_row = source.get(from..from + row_bytes).ok_or_else(unreadable)?;
        target
            .get_mut(to..to + row_bytes)
            .ok_or_else(unreadable)?
            .copy_from_slice(source_row);
    }
    Ok(())
}

fn copy_nv12(decoded: &DecodedFrame, target: &mut frame::Video) -> Result<(), String> {
    let width = decoded.width() as usize;
    let height = decoded.height() as usize;
    let chroma_rows = height.div_ceil(2);
    let chroma_bytes = width.div_ceil(2) * 2;
    let y = decoded.y_plane().ok_or_else(unreadable)?;
    let uv = decoded.uv_plane().ok_or_else(unreadable)?;
    let y_stride = target.stride(0);
    copy_plane(
        y,
        decoded.y_stride() as usize,
        width,
        height,
        target.data_mut(0),
        y_stride,
    )?;
    let uv_stride = target.stride(1);
    copy_plane(
        uv,
        decoded.uv_stride() as usize,
        chroma_bytes,
        chroma_rows,
        target.data_mut(1),
        uv_stride,
    )
}

fn source_frame(decoded: &DecodedFrame) -> Result<frame::Video, String> {
    let width = decoded.width();
    let height = decoded.height();
    let (w, h) = (width as usize, height as usize);
    match decoded.format() {
        PixelFormat::Nv12 => {
            let mut frame = frame::Video::new(Pixel::NV12, width, height);
            copy_nv12(decoded, &mut frame)?;
            Ok(frame)
        }
        PixelFormat::Yuv420p => {
            let mut frame = frame::Video::new(Pixel::YUV420P, width, height);
            let planes = [
                (decoded.y_plane(), decoded.y_stride(), w, h),
                (
                    decoded.u_plane(),
                    decoded.uv_stride(),
                    w.div_ceil(2),
                    h.div_ceil(2),
                ),
                (
                    decoded.v_plane(),
                    decoded.uv_stride(),
                    w.div_ceil(2),
                    h.div_ceil(2),
                ),
            ];
            for (index, (plane, stride, row_bytes, rows)) in planes.into_iter().enumerate() {
                let stride_out = frame.stride(index);
                copy_plane(
                    plane.ok_or_else(unreadable)?,
                    stride as usize,
                    row_bytes,
                    rows,
                    frame.data_mut(index),
                    stride_out,
                )?;
            }
            Ok(frame)
        }
        PixelFormat::Rgba => {
            let mut frame = frame::Video::new(Pixel::RGBA, width, height);
            let stride_out = frame.stride(0);
            copy_plane(
                decoded.data(),
                w * 4,
                w * 4,
                h,
                frame.data_mut(0),
                stride_out,
            )?;
            Ok(frame)
        }
    }
}

async fn export_video_tracks<F: FnMut(TrackProgress)>(
    prepared: &Prepared,
    tracks: &[(TrackKind, PathBuf)],
    fps: u32,
    total_frames: u32,
    cancel: &AtomicBool,
    reporter: &mut ProgressReporter<'_, F>,
) -> Result<(), TrackExportError> {
    let path_for = |kind| {
        tracks
            .iter()
            .find(|(track, _)| *track == kind)
            .map(|(_, path)| path.clone())
    };
    let used_clips = |kind: TrackKind| {
        prepared
            .recordings
            .segments
            .iter()
            .enumerate()
            .filter(move |(index, _)| {
                prepared.project.timeline.as_ref().is_none_or(|timeline| {
                    timeline
                        .segments
                        .iter()
                        .any(|segment| segment.recording_clip as usize == *index)
                })
            })
            .filter_map(move |(_, segment)| match kind {
                TrackKind::Screen => Some((segment.display.width, segment.display.height)),
                _ => segment
                    .camera
                    .as_ref()
                    .map(|camera| (camera.width, camera.height)),
            })
            .next()
    };

    let mut screen = None;
    let mut camera = None;
    let mut setup = Ok(());
    for (kind, slot) in [
        (TrackKind::Screen, &mut screen),
        (TrackKind::Camera, &mut camera),
    ] {
        let Some(path) = path_for(kind) else {
            continue;
        };
        let spawned = used_clips(kind)
            .ok_or(TrackExportError::Unavailable(kind))
            .and_then(|(width, height)| {
                VideoTrackWriter::spawn(path, width, height, fps).map_err(TrackExportError::from)
            });
        match spawned {
            Ok(writer) => *slot = Some(writer),
            Err(error) => {
                setup = Err(error);
                break;
            }
        }
    }

    let result = match setup {
        Ok(()) => {
            run_video_pass(
                prepared,
                fps,
                total_frames,
                cancel,
                reporter,
                screen.as_ref(),
                camera.as_ref(),
            )
            .await
        }
        Err(error) => Err(error),
    };
    // Every started encoder is joined before returning, so none still holds
    // its partial file open when the caller removes it.
    let mut finished = Ok(());
    for writer in [screen, camera].into_iter().flatten() {
        if result.is_ok() {
            if let Err(error) = writer.finish()
                && finished.is_ok()
            {
                finished = Err(TrackExportError::from(error));
            }
        } else {
            writer.abandon();
        }
    }
    result.and(finished)
}

/// Consecutive output frames a track may go without a decoded frame, as the
/// rendered export allows: few before its first frame, more once running.
const MAX_INITIAL_MISSES: u32 = 8;
const MAX_CONSECUTIVE_MISSES: u32 = 200;

#[derive(Default)]
struct MissTracker {
    decoded: u64,
    consecutive: u32,
}

impl MissTracker {
    fn record(&mut self, kind: TrackKind, decoded: bool, time: f64) -> Result<(), String> {
        if decoded {
            self.decoded += 1;
            self.consecutive = 0;
            return Ok(());
        }
        self.consecutive += 1;
        let limit = if self.decoded == 0 {
            MAX_INITIAL_MISSES
        } else {
            MAX_CONSECUTIVE_MISSES
        };
        if self.consecutive > limit {
            return Err(format!(
                "The {} recording stopped returning frames near {time:.1}s",
                kind.slug()
            ));
        }
        Ok(())
    }
}

async fn run_video_pass<F: FnMut(TrackProgress)>(
    prepared: &Prepared,
    fps: u32,
    total_frames: u32,
    cancel: &AtomicBool,
    reporter: &mut ProgressReporter<'_, F>,
    screen: Option<&VideoTrackWriter>,
    camera: Option<&VideoTrackWriter>,
) -> Result<(), TrackExportError> {
    let mut decoded_any = false;
    let mut screen_misses = MissTracker::default();
    let mut camera_misses = MissTracker::default();
    for frame_number in 0..total_frames {
        if cancel.load(Ordering::Relaxed) {
            return Err(TrackExportError::Cancelled);
        }
        let Some((clip, segment_time)) = frame_source(&prepared.project, frame_number, fps) else {
            // Past the timeline's last instant (the frame count rounds up):
            // hold the last frame so every track keeps the export's length.
            for writer in [screen, camera].into_iter().flatten() {
                writer.send(VideoJob::Repeat)?;
            }
            reporter.advance();
            continue;
        };
        let segment = prepared
            .segments
            .get(clip as usize)
            .ok_or_else(|| format!("Clip {clip} is missing from this recording"))?;
        let offsets = prepared
            .project
            .clips
            .iter()
            .find(|config| config.index == clip)
            .map(|config| config.offsets)
            .unwrap_or_default();
        let wants_camera = camera.is_some() && segment.decoders.camera_video_dimensions().is_some();
        let frames = segment
            .decoders
            .decode_for_export(
                segment_time,
                wants_camera,
                screen.is_some(),
                offsets,
                frame_number,
                !decoded_any,
                fps,
            )
            .await
            .map_err(|error| format!("Decoding frame {frame_number} failed: {error}"))?;
        let (screen_frame, camera_frame) = match frames {
            Some(frames) => (frames.screen_frame, frames.camera_frame),
            None => (None, None),
        };
        decoded_any |= screen_frame.is_some() || camera_frame.is_some();
        let time = frame_number as f64 / fps as f64;
        if screen.is_some() {
            screen_misses.record(TrackKind::Screen, screen_frame.is_some(), time)?;
        }
        if wants_camera {
            camera_misses.record(TrackKind::Camera, camera_frame.is_some(), time)?;
        }
        if let Some(writer) = screen {
            writer.send(screen_frame.map_or(VideoJob::Repeat, VideoJob::Frame))?;
        }
        if let Some(writer) = camera {
            // A clip recorded without a camera is black on the camera track;
            // only a frame the decoder failed to return repeats the last one.
            writer.send(match camera_frame {
                Some(frame) => VideoJob::Frame(frame),
                None if wants_camera => VideoJob::Repeat,
                None => VideoJob::Black,
            })?;
        }
        reporter.advance();
    }
    if screen.is_some() && screen_misses.decoded == 0 {
        return Err(TrackExportError::Failed(
            "The screen recording could not be decoded".into(),
        ));
    }
    if camera.is_some() && camera_misses.decoded == 0 {
        return Err(TrackExportError::Failed(
            "The camera recording could not be decoded".into(),
        ));
    }
    Ok(())
}

/// The editor's mix for one track: every clip edit (cuts, speed and its
/// audio mode, clip volume, enhancement and EQ, transitions, holds) stays,
/// while the project mute and the track level sliders do not, so a track
/// muted in the edit still exports its sound at the level it was recorded.
pub fn track_audio_project(project: &ProjectConfiguration) -> ProjectConfiguration {
    let mut project = project.clone();
    project.audio.mute = false;
    project.audio.mic_volume_db = 0.0;
    project.audio.system_volume_db = 0.0;
    if let Some(timeline) = project.timeline.as_mut() {
        timeline.audio_segments.clear();
    }
    project
}

async fn export_audio_track<F: FnMut(TrackProgress)>(
    prepared: &Prepared,
    kind: TrackKind,
    path: &Path,
    fps: u32,
    total_frames: u32,
    cancel: &AtomicBool,
    reporter: &mut ProgressReporter<'_, F>,
) -> Result<(), TrackExportError> {
    let mut audio_segments = Vec::with_capacity(prepared.segments.len());
    for segment in &prepared.segments {
        let loader = match kind {
            TrackKind::Microphone => &segment.audio,
            _ => &segment.system_audio,
        };
        let audio = loader
            .get()
            .await
            .map_err(|error| format!("Could not read the {} audio: {error}", kind.slug()))?;
        let (mic, system) = match kind {
            TrackKind::Microphone => (audio, None),
            _ => (None, audio),
        };
        audio_segments.push(audio_segment_from_decoded(
            mic,
            system,
            segment.audio_timing_repair,
        ));
    }

    let project = track_audio_project(&prepared.project);
    let mut renderer = AudioRenderer::new(audio_segments);
    renderer.set_playhead(0.0, &project);

    run_blocking(|| {
        let mut wav = WavWriter::create(path)?;
        let sample_rate = u64::from(AudioRenderer::SAMPLE_RATE);
        let fps = u64::from(fps);
        let mut cursor = 0u64;
        for frame_number in 0..u64::from(total_frames) {
            if cancel.load(Ordering::Relaxed) {
                return Err(TrackExportError::Cancelled);
            }
            if let Some((pts, samples)) = audio_frame_budget(frame_number, sample_rate, fps, cursor)
            {
                cursor = pts as u64 + samples as u64;
                let written = match renderer.render_frame_raw(samples, &project) {
                    Some((count, data)) => {
                        let count = count.min(samples).min(data.len() / 2);
                        wav.write(&data[..count * 2])?;
                        count
                    }
                    None => 0,
                };
                wav.write_silence(samples - written)?;
            }
            reporter.advance();
        }
        wav.finish()?;
        Ok(())
    })
}

/// Runs CPU-bound work without stalling the async workers that the video
/// decoders and the app share, when the runtime has others to hand off to.
pub(crate) fn run_blocking<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

struct WavWriter {
    file: BufWriter<File>,
    frames: u64,
}

const WAV_CHANNELS: u16 = 2;
const WAV_BYTES_PER_SAMPLE: u16 = 3;
const WAV_HEADER_BYTES: u64 = 44;

impl WavWriter {
    fn create(path: &Path) -> Result<Self, String> {
        let file = File::create(path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        let mut writer = Self {
            file: BufWriter::with_capacity(1 << 20, file),
            frames: 0,
        };
        writer.header(0)?;
        Ok(writer)
    }

    fn header(&mut self, data_bytes: u32) -> Result<(), String> {
        let header = wav_header(AudioRenderer::SAMPLE_RATE, data_bytes);
        self.file.write_all(&header).map_err(io_error)
    }

    fn write(&mut self, interleaved: &[f32]) -> Result<(), String> {
        let mut bytes = Vec::with_capacity(interleaved.len() * 3);
        for sample in interleaved {
            bytes.extend_from_slice(&pcm24(*sample));
        }
        self.file.write_all(&bytes).map_err(io_error)?;
        self.frames += (interleaved.len() / usize::from(WAV_CHANNELS)) as u64;
        Ok(())
    }

    fn write_silence(&mut self, frames: usize) -> Result<(), String> {
        if frames == 0 {
            return Ok(());
        }
        let bytes = vec![0u8; frames * usize::from(WAV_CHANNELS * WAV_BYTES_PER_SAMPLE)];
        self.file.write_all(&bytes).map_err(io_error)?;
        self.frames += frames as u64;
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        let data_bytes = self.frames * u64::from(WAV_CHANNELS * WAV_BYTES_PER_SAMPLE);
        let data_bytes = u32::try_from(data_bytes)
            .ok()
            .filter(|bytes| u64::from(*bytes) + WAV_HEADER_BYTES <= u64::from(u32::MAX))
            .ok_or("This audio track is too long for a WAV file")?;
        self.file.flush().map_err(io_error)?;
        self.file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        self.header(data_bytes)?;
        let file = self
            .file
            .into_inner()
            .map_err(|error| io_error(error.into_error()))?;
        file.sync_all().map_err(io_error)
    }
}

fn io_error(error: std::io::Error) -> String {
    format!("Writing the audio track failed: {error}")
}

fn wav_header(sample_rate: u32, data_bytes: u32) -> [u8; WAV_HEADER_BYTES as usize] {
    let block_align = WAV_CHANNELS * WAV_BYTES_PER_SAMPLE;
    let mut header = [0u8; WAV_HEADER_BYTES as usize];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&data_bytes.saturating_add(36).to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes());
    header[22..24].copy_from_slice(&WAV_CHANNELS.to_le_bytes());
    header[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    header[28..32].copy_from_slice(&(sample_rate * u32::from(block_align)).to_le_bytes());
    header[32..34].copy_from_slice(&block_align.to_le_bytes());
    header[34..36].copy_from_slice(&(WAV_BYTES_PER_SAMPLE * 8).to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

fn pcm24(sample: f32) -> [u8; 3] {
    let sample = if sample.is_finite() { sample } else { 0.0 };
    let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
    let bytes = value.to_le_bytes();
    [bytes[0], bytes[1], bytes[2]]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(timeline: serde_json::Value) -> ProjectConfiguration {
        serde_json::from_value(serde_json::json!({ "timeline": timeline })).unwrap()
    }

    fn clip(index: u32, start: f64, end: f64, timescale: f64) -> serde_json::Value {
        serde_json::json!({
            "recordingSegment": index,
            "start": start,
            "end": end,
            "timescale": timescale,
        })
    }

    fn timeline(segments: Vec<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({ "segments": segments, "zoomSegments": [] })
    }

    #[test]
    fn frames_follow_cuts_clip_order_and_speed() {
        let project = project(timeline(vec![
            clip(1, 10.0, 12.0, 1.0),
            clip(0, 4.0, 8.0, 2.0),
        ]));
        let fps = 10;
        let duration = project.timeline.as_ref().unwrap().duration();
        assert_eq!(duration, 4.0);
        assert_eq!(total_frames(duration, fps), 40);

        assert_eq!(frame_source(&project, 0, fps), Some((1, 10.0)));
        let (clip, time) = frame_source(&project, 15, fps).unwrap();
        assert_eq!(clip, 1);
        assert!((time - 11.5).abs() < 1e-9);
        assert_eq!(frame_source(&project, 20, fps), Some((0, 4.0)));
        let (clip, time) = frame_source(&project, 35, fps).unwrap();
        assert_eq!(clip, 0);
        assert!((time - 7.0).abs() < 1e-9);
        assert_eq!(frame_source(&project, 40, fps), None);
    }

    #[test]
    fn transitions_read_the_incoming_clip_and_shorten_the_tracks() {
        let mut timeline = timeline(vec![clip(0, 0.0, 4.0, 1.0), clip(1, 0.0, 4.0, 1.0)]);
        timeline["transitions"] = serde_json::json!([
            { "segmentIndex": 1, "type": "cross-fade", "duration": 1.0 }
        ]);
        let project = project(timeline);
        let fps = 30;
        assert_eq!(
            total_frames(project.timeline.as_ref().unwrap().duration(), fps),
            210
        );
        assert_eq!(frame_source(&project, 89, fps).unwrap().0, 0);
        let (clip, time) = frame_source(&project, 90, fps).unwrap();
        assert_eq!(clip, 1);
        assert!(time.abs() < 1e-9);
        let (clip, time) = frame_source(&project, 120, fps).unwrap();
        assert_eq!(clip, 1);
        assert!((time - 1.0).abs() < 1e-9);
    }

    #[test]
    fn fullscreen_text_holds_freeze_the_source_and_lengthen_the_tracks() {
        let mut timeline = timeline(vec![clip(0, 0.0, 4.0, 1.0)]);
        timeline["textSegments"] = serde_json::json!([{
            "start": 2.0,
            "end": 3.0,
            "enabled": true,
            "layout": "fullscreen",
            "content": "Title"
        }]);
        let project = project(timeline);
        let fps = 10;
        assert_eq!(
            total_frames(project.timeline.as_ref().unwrap().duration(), fps),
            50
        );
        let held = frame_source(&project, 20, fps).unwrap();
        assert_eq!(frame_source(&project, 25, fps).unwrap(), held);
        assert_eq!(frame_source(&project, 29, fps).unwrap(), held);
        let (_, after) = frame_source(&project, 30, fps).unwrap();
        assert!((after - 2.0).abs() < 1e-9);
    }

    #[test]
    fn audio_tracks_have_exactly_the_samples_of_the_video_frames() {
        for fps in [15u64, 24, 30, 60] {
            for total in [1u64, 29, 1_000, 5_401] {
                let mut cursor = 0;
                for frame in 0..total {
                    if let Some((pts, samples)) = audio_frame_budget(frame, 48_000, fps, cursor) {
                        assert_eq!(pts as u64, cursor);
                        cursor += samples as u64;
                    }
                }
                assert_eq!(cursor, total * 48_000 / fps, "{fps} fps, {total} frames");
            }
        }
    }

    #[test]
    fn track_audio_keeps_clip_edits_but_ignores_mute_and_track_levels() {
        let mut source = project(timeline(vec![clip(0, 0.0, 4.0, 1.0)]));
        source.audio.mute = true;
        source.audio.improve = true;
        source.audio.mic_volume_db = -12.0;
        source.audio.system_volume_db = -30.0;
        if let Some(timeline) = source.timeline.as_mut() {
            timeline.segments[0].volume = Some(0.5);
        }
        let audio = track_audio_project(&source);
        assert!(!audio.audio.mute);
        assert!(audio.audio.improve);
        assert_eq!(audio.audio.mic_volume_db, 0.0);
        assert_eq!(audio.audio.system_volume_db, 0.0);
        assert_eq!(audio.timeline.unwrap().segments[0].volume, Some(0.5));
    }

    #[test]
    fn slugs_round_trip_and_accept_short_names() {
        for kind in TrackKind::ALL {
            assert_eq!(TrackKind::from_slug(kind.slug()), Some(kind));
        }
        assert_eq!(TrackKind::from_slug("mic"), Some(TrackKind::Microphone));
        assert_eq!(
            TrackKind::from_slug(" System "),
            Some(TrackKind::SystemAudio)
        );
        assert_eq!(TrackKind::from_slug("cursor"), None);
        let names = TrackKind::ALL.map(TrackKind::file_name);
        assert_eq!(
            names,
            [
                "Screen.mp4",
                "Camera.mp4",
                "Microphone.wav",
                "System audio.wav"
            ]
        );
    }

    #[test]
    fn progress_counts_one_video_pass_and_each_audio_track() {
        assert_eq!(progress_total(&[TrackKind::Screen], 100), 100);
        assert_eq!(
            progress_total(&[TrackKind::Screen, TrackKind::Camera], 100),
            100
        );
        assert_eq!(progress_total(&TrackKind::ALL, 100), 300);
        assert_eq!(progress_total(&[TrackKind::Microphone], 100), 100);
    }

    #[test]
    fn wav_header_describes_48k_stereo_24_bit() {
        let header = wav_header(48_000, 600);
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(header[4..8].try_into().unwrap()), 636);
        assert_eq!(u16::from_le_bytes(header[22..24].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(header[24..28].try_into().unwrap()),
            48_000
        );
        assert_eq!(
            u32::from_le_bytes(header[28..32].try_into().unwrap()),
            288_000
        );
        assert_eq!(u16::from_le_bytes(header[32..34].try_into().unwrap()), 6);
        assert_eq!(u16::from_le_bytes(header[34..36].try_into().unwrap()), 24);
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 600);
    }

    #[test]
    fn pcm24_clamps_and_survives_bad_samples() {
        assert_eq!(pcm24(0.0), [0, 0, 0]);
        assert_eq!(pcm24(1.0), [0xff, 0xff, 0x7f]);
        assert_eq!(pcm24(2.0), [0xff, 0xff, 0x7f]);
        assert_eq!(pcm24(-1.0), [0x01, 0x00, 0x80]);
        assert_eq!(pcm24(f32::NAN), [0, 0, 0]);
    }

    #[test]
    fn wav_files_are_sized_on_finish() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        let mut wav = WavWriter::create(&path).unwrap();
        wav.write(&[0.5, -0.5, 0.25, -0.25]).unwrap();
        wav.write_silence(3).unwrap();
        wav.finish().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 44 + 5 * 6);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 30);
        assert_eq!(&bytes[44..47], &pcm24(0.5));
        assert!(bytes[44 + 12..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn staged_files_are_removed_unless_kept() {
        let dir = tempfile::tempdir().unwrap();
        let staged = staging_path(dir.path(), TrackKind::Camera, "a");
        std::fs::write(&staged, b"partial").unwrap();
        drop(StagedFiles(vec![staged.clone()]));
        assert!(!staged.exists());
        assert_ne!(staged, staging_path(dir.path(), TrackKind::Camera, "b"));
        assert_ne!(export_token(), "");
    }

    #[test]
    fn publishing_replaces_every_track_or_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = |name: &str| dir.path().join(name);
        std::fs::write(path("Screen.mp4"), b"old screen").unwrap();
        std::fs::write(path("Camera.mp4"), b"old camera").unwrap();
        std::fs::write(path("screen.new"), b"new screen").unwrap();
        let files = vec![
            (path("screen.new"), path("Screen.mp4")),
            (path("camera.missing"), path("Camera.mp4")),
        ];
        assert!(publish(&files, "t").is_err());
        assert_eq!(std::fs::read(path("Screen.mp4")).unwrap(), b"old screen");
        assert_eq!(std::fs::read(path("Camera.mp4")).unwrap(), b"old camera");

        std::fs::write(path("screen.new"), b"new screen").unwrap();
        std::fs::write(path("camera.new"), b"new camera").unwrap();
        std::fs::write(path("mic.new"), b"new mic").unwrap();
        let files = vec![
            (path("screen.new"), path("Screen.mp4")),
            (path("camera.new"), path("Camera.mp4")),
            (path("mic.new"), path("Microphone.wav")),
        ];
        std::fs::create_dir(path("Microphone.wav")).unwrap();
        assert!(publish(&files, "t").unwrap_err().contains("is a folder"));
        assert_eq!(std::fs::read(path("Screen.mp4")).unwrap(), b"old screen");
        std::fs::remove_dir(path("Microphone.wav")).unwrap();

        publish(&files, "t").unwrap();
        assert_eq!(std::fs::read(path("Screen.mp4")).unwrap(), b"new screen");
        assert_eq!(std::fs::read(path("Camera.mp4")).unwrap(), b"new camera");
        assert_eq!(std::fs::read(path("Microphone.wav")).unwrap(), b"new mic");
        let mut left = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        left.sort();
        assert_eq!(left, ["Camera.mp4", "Microphone.wav", "Screen.mp4"]);
    }

    #[test]
    fn missing_frames_fail_instead_of_exporting_a_blank_track() {
        let mut misses = MissTracker::default();
        for _ in 0..MAX_INITIAL_MISSES {
            misses.record(TrackKind::Screen, false, 0.0).unwrap();
        }
        assert!(misses.record(TrackKind::Screen, false, 0.3).is_err());

        let mut misses = MissTracker::default();
        misses.record(TrackKind::Camera, true, 0.0).unwrap();
        for _ in 0..MAX_CONSECUTIVE_MISSES {
            misses.record(TrackKind::Camera, false, 1.0).unwrap();
        }
        misses.record(TrackKind::Camera, true, 2.0).unwrap();
        for _ in 0..MAX_CONSECUTIVE_MISSES {
            misses.record(TrackKind::Camera, false, 3.0).unwrap();
        }
        let error = misses.record(TrackKind::Camera, false, 9.5).unwrap_err();
        assert!(error.contains("camera") && error.contains("9.5"), "{error}");
    }

    fn nv12_frame(y: u8, u: u8, v: u8, matrix: YuvMatrix) -> DecodedFrame {
        let (width, height) = (16u32, 16u32);
        let mut data = vec![y; (width * height) as usize];
        for _ in 0..(width * height / 4) {
            data.extend_from_slice(&[u, v]);
        }
        DecodedFrame::new_nv12(data, width, height, width, width).with_matrix(matrix)
    }

    #[test]
    fn tracks_come_out_in_bt709_whatever_the_source_matrix() {
        ffmpeg::init().unwrap();
        let mut converter = Nv12Converter::default();
        let mut target = black_nv12(16, 16);

        converter
            .fill(&nv12_frame(81, 90, 240, YuvMatrix::Bt709), &mut target)
            .unwrap();
        assert_eq!(target.data(0)[0], 81);
        assert_eq!(&target.data(1)[..2], &[90, 240]);

        converter
            .fill(&nv12_frame(81, 90, 240, YuvMatrix::Bt601), &mut target)
            .unwrap();
        let close = |actual: u8, expected: u8| actual.abs_diff(expected) <= 3;
        let (y, u, v) = (target.data(0)[0], target.data(1)[0], target.data(1)[1]);
        assert!(
            close(y, 63) && close(u, 102) && close(v, 240),
            "{y} {u} {v}"
        );
    }
}
