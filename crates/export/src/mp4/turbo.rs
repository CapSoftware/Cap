//! Turbo export: the timeline is split into contiguous chunks that render and
//! encode at the same time, each with its own decoders, render loop and
//! libx264 encoder, so decode, GPU and every CPU core stay busy. Chunk 0
//! encodes straight into the output like a standard export; later chunks
//! spool their packets to temporary files that are appended in order.
//!
//! libx264 runs in constant quality capped at the export's bitrate. On Apple
//! silicon the single hardware encoder is the standard export's ceiling,
//! while libx264 across all cores is 2-3x faster at matching quality.

use super::*;
use crate::estimates::SampleTiming;
use cap_editor::SegmentMedia;
use cap_enc_ffmpeg::{PacketSink, h264::SoftwareEncoderTuning};
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta};
use cap_rendering::{ProjectRecordingsMeta, RenderVideoConstants};
use std::{
    io::{BufReader, BufWriter, Read, Write},
    ops::Range,
    sync::mpsc,
};

/// Shorter chunks spend more of their time opening decoders and layers.
const MIN_CHUNK_SECS: u32 = 4;
const MAX_CHUNKS: usize = 4;
const CORES_PER_CHUNK: usize = 4;

/// Frames a later chunk renders and discards before its first frame, so
/// state carried from frame to frame (the camera blur's mask smoothing)
/// matches a standard export's at the seam.
fn preroll_frames(fps: u32, start: u32) -> u32 {
    (fps / 2).max(16).min(start)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TurboOptions {
    /// Overrides how many chunks run at once, however short they get.
    pub chunks: Option<usize>,
    /// Returns the turbo pipeline's error instead of exporting again with
    /// the standard pipeline.
    pub strict: bool,
}

pub(crate) enum TurboError {
    Cancelled,
    Failed(String),
    /// The export finished but could not be moved to its destination, which
    /// something else created meanwhile. Exporting again would overwrite it.
    Publish(String),
}

impl From<String> for TurboError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct TurboPlan {
    chunks: Vec<Range<u32>>,
    threads: usize,
}

fn plan(total_frames: u32, fps: u32, cores: usize, requested: Option<usize>) -> TurboPlan {
    let count = match requested {
        Some(count) => count.clamp(1, MAX_CHUNKS).min(total_frames.max(1) as usize),
        None => (cores / CORES_PER_CHUNK)
            .clamp(1, MAX_CHUNKS)
            .min((total_frames / (fps.max(1) * MIN_CHUNK_SECS)).max(1) as usize),
    };
    let length = total_frames / count as u32;
    let remainder = total_frames % count as u32;
    let mut start = 0;
    let chunks = (0..count as u32)
        .map(|index| {
            let end = start + length + u32::from(index < remainder);
            let chunk = start..end;
            start = end;
            chunk
        })
        .collect();
    TurboPlan {
        chunks,
        threads: (cores / count).max(1),
    }
}

/// libx264 constant quality per bits per pixel and frame rate. Each preset's
/// value matched or beat the hardware encoder's SSIM and PSNR at that preset
/// against a lossless render of real recordings, at a smaller file, at 15, 30
/// and 60 fps. At 60 fps the hardware encoder spends its higher bitrate on
/// repeated source frames that libx264 makes nearly free, so matching it
/// takes 3 steps more quality; at 15 fps 2 steps less still beats it.
fn constant_quality(bpp: f32, fps: u32) -> u8 {
    const POINTS: [(f32, f32); 4] = [(0.04, 22.0), (0.08, 20.0), (0.15, 18.0), (0.3, 15.0)];
    let position = bpp.max(f32::MIN_POSITIVE).log2();
    let crf = POINTS
        .windows(2)
        .find_map(|pair| {
            let (low, high) = (pair[0], pair[1]);
            let (from, to) = (low.0.log2(), high.0.log2());
            (position <= to).then(|| {
                let t = ((position - from) / (to - from)).clamp(0.0, 1.0);
                low.1 + (high.1 - low.1) * t
            })
        })
        .unwrap_or(POINTS[POINTS.len() - 1].1);
    let fps = fps as f32;
    let offset = if fps >= 30.0 {
        -3.0 * ((fps - 30.0) / 30.0).min(1.0)
    } else {
        2.0 * ((30.0 - fps) / 15.0).min(1.0)
    };
    (crf + offset).round() as u8
}

struct Progress<F> {
    frames: Mutex<(u32, F)>,
    stop: Arc<AtomicBool>,
    user: Option<Arc<AtomicBool>>,
    cancelled: AtomicBool,
    failure: Mutex<Option<String>>,
}

impl<F: FnMut(u32) -> bool> Progress<F> {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
            || self
                .user
                .as_ref()
                .is_some_and(|user| user.load(Ordering::Relaxed))
    }

    fn frame_rendered(&self) -> bool {
        if self.stopped() {
            return false;
        }
        let mut frames = self.frames.lock().unwrap_or_else(PoisonError::into_inner);
        let (rendered, on_progress) = &mut *frames;
        let keep_going = on_progress(*rendered);
        *rendered += 1;
        if !keep_going {
            self.cancelled.store(true, Ordering::Relaxed);
            self.stop.store(true, Ordering::Relaxed);
        }
        keep_going
    }

    /// Stops every part of the export, keeping the first failure: the parts
    /// it stops fail afterwards only because they were stopped.
    fn fail(&self, error: String) {
        let mut failure = self.failure.lock().unwrap_or_else(PoisonError::into_inner);
        if failure.is_none() && !self.stopped() {
            *failure = Some(error);
        }
        self.stop.store(true, Ordering::Relaxed);
    }

    fn was_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
            || self
                .user
                .as_ref()
                .is_some_and(|user| user.load(Ordering::Relaxed))
    }
}

#[derive(Clone)]
struct RenderShared {
    constants: Arc<RenderVideoConstants>,
    project: Arc<ProjectConfiguration>,
    recording_meta: Arc<RecordingMeta>,
    studio_meta: Arc<StudioRecordingMeta>,
    recordings: Arc<ProjectRecordingsMeta>,
    fps: u32,
    resolution_base: XY<u32>,
}

#[derive(Clone, Copy)]
struct EncoderSettings {
    video_info: VideoInfo,
    bpp: f32,
    optimize_filesize: bool,
    crf: u8,
    tuning: SoftwareEncoderTuning,
}

impl EncoderSettings {
    fn builder(&self) -> cap_enc_ffmpeg::h264::H264EncoderBuilder {
        let builder = H264Encoder::builder(self.video_info)
            .with_bpp(self.bpp)
            .with_export_settings()
            .with_external_conversion()
            .with_encoder_priority_override(&["libx264"])
            .with_software_tuning(self.tuning);
        if self.optimize_filesize {
            builder.with_crf(self.crf)
        } else {
            builder
        }
    }
}

const STOPPED: &str = "Export cancelled";

fn render_chunk<F: FnMut(u32) -> bool + Send + 'static>(
    shared: RenderShared,
    segments: Vec<RenderSegment>,
    frames: cap_rendering::FrameWindows,
    preroll: u32,
    sender: mpsc::SyncSender<ExportFrame>,
    progress: Arc<Progress<F>>,
    screenshot_project_path: Option<PathBuf>,
) -> std::io::Result<std::thread::JoinHandle<Result<(), String>>> {
    std::thread::Builder::new()
        .name("turbo-render".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            let result = runtime
                .block_on(export_render_to_channel(
                    &shared.constants,
                    &shared.project,
                    sender,
                    &shared.recording_meta,
                    &shared.studio_meta,
                    segments,
                    shared.fps,
                    shared.resolution_base,
                    &shared.recordings,
                    Some(frames),
                    None,
                    None,
                    true,
                    {
                        let progress = progress.clone();
                        move |frame| {
                            if frame < preroll {
                                !progress.stopped()
                            } else {
                                progress.frame_rendered()
                            }
                        }
                    },
                    screenshot_project_path,
                ))
                .map_err(|error| match error {
                    cap_rendering::RenderingError::ImageLoadError(message)
                        if message == STOPPED =>
                    {
                        STOPPED.to_string()
                    }
                    error => error.to_string(),
                });
            if let Err(error) = &result
                && error != STOPPED
            {
                progress.fail(error.clone());
            }
            result
        })
}

fn fill_input(
    input: &ExportFrame,
    frame: &mut ffmpeg::frame::Video,
    pts: i64,
) -> Result<(), String> {
    match &input.payload {
        ExportFramePayload::Cpu(nv12_data) => {
            fill_nv12_frame_direct(
                frame,
                nv12_data,
                input.width,
                input.height,
                input.y_stride,
                pts,
            );
            Ok(())
        }
        #[cfg(target_os = "macos")]
        ExportFramePayload::Surface(surface) => {
            fill_nv12_frame_from_surface(frame, surface, input.width, input.height, pts)
                .ok_or_else(|| "failed to lock NV12 surface for encoding".to_string())
        }
    }
}

/// Packets of one chunk, written as they are encoded and read back once the
/// output reaches the chunk. Timestamps are frames from the chunk's start.
struct Spool {
    path: tempfile::TempPath,
    writer: BufWriter<std::fs::File>,
    time_base: ffmpeg::Rational,
    first_packet: Option<Vec<u8>>,
    error: Option<std::io::Error>,
}

struct SpooledChunk {
    path: tempfile::TempPath,
    first_packet: Option<Vec<u8>>,
}

impl Spool {
    fn new(time_base: ffmpeg::Rational) -> std::io::Result<Self> {
        let (file, path) = tempfile::Builder::new()
            .prefix("cap-turbo-")
            .suffix(".packets")
            .tempfile()?
            .into_parts();
        Ok(Self {
            path,
            writer: BufWriter::with_capacity(1 << 20, file),
            time_base,
            first_packet: None,
            error: None,
        })
    }

    fn write(&mut self, packet: &ffmpeg::Packet) -> std::io::Result<()> {
        let data = packet.data().unwrap_or_default();
        if self.first_packet.is_none() {
            self.first_packet = Some(data.to_vec());
        }
        let mut header = [0u8; 29];
        header[0..8].copy_from_slice(&packet.pts().unwrap_or(0).to_le_bytes());
        header[8..16].copy_from_slice(&packet.dts().unwrap_or(0).to_le_bytes());
        header[16..24].copy_from_slice(&packet.duration().to_le_bytes());
        header[24] = u8::from(packet.is_key());
        header[25..29].copy_from_slice(&(data.len() as u32).to_le_bytes());
        self.writer.write_all(&header)?;
        self.writer.write_all(data)
    }

    fn finish(mut self) -> std::io::Result<SpooledChunk> {
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        self.writer.flush()?;
        Ok(SpooledChunk {
            path: self.path,
            first_packet: self.first_packet,
        })
    }
}

impl PacketSink for Spool {
    fn stream_time_base(&self, _stream_index: usize) -> ffmpeg::Rational {
        self.time_base
    }

    fn write_packet(&mut self, packet: ffmpeg::Packet) -> Result<(), ffmpeg::Error> {
        if self.error.is_some() {
            return Err(ffmpeg::Error::External);
        }
        self.write(&packet).map_err(|error| {
            self.error = Some(error);
            ffmpeg::Error::External
        })
    }
}

fn read_spooled_packets(
    chunk: &SpooledChunk,
    mut packet: impl FnMut(ffmpeg::Packet) -> Result<(), TurboError>,
) -> Result<(), TurboError> {
    let file = std::fs::File::open(&chunk.path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut header = [0u8; 29];
    loop {
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.to_string().into()),
        }
        let field = |range: Range<usize>| i64::from_le_bytes(header[range].try_into().unwrap());
        let length = u32::from_le_bytes(header[25..29].try_into().unwrap()) as usize;
        let mut data = vec![0u8; length];
        reader
            .read_exact(&mut data)
            .map_err(|error| error.to_string())?;
        let mut spooled = ffmpeg::Packet::copy(&data);
        spooled.set_pts(Some(field(0..8)));
        spooled.set_dts(Some(field(8..16)));
        spooled.set_duration(field(16..24));
        if header[24] != 0 {
            spooled.set_flags(ffmpeg::packet::Flags::KEY);
        }
        packet(spooled)?;
    }
}

fn encode_chunk<F: FnMut(u32) -> bool>(
    frames: mpsc::Receiver<ExportFrame>,
    settings: EncoderSettings,
    progress: &Progress<F>,
    preroll: u32,
    fail_after: Option<u32>,
) -> Result<SpooledChunk, String> {
    let mut encoder = settings
        .builder()
        .build_software_detached()
        .map_err(|error| error.to_string())?;
    let mut spool = Spool::new(settings.video_info.time_base).map_err(|error| error.to_string())?;
    let mut frame = ffmpeg::frame::Video::new(
        ffmpeg::format::Pixel::NV12,
        settings.video_info.width,
        settings.video_info.height,
    );
    let mut converted = None;
    for input in frames.iter() {
        if progress.stopped() {
            return Err(STOPPED.to_string());
        }
        let Some(frame_number) = input.frame_number.checked_sub(preroll) else {
            continue;
        };
        if fail_after == Some(frame_number) {
            return Err("Injected turbo chunk failure".to_string());
        }
        fill_input(&input, &mut frame, i64::from(frame_number))?;
        encoder
            .queue_frame_reusable(&mut frame, &mut converted, Duration::MAX, &mut spool)
            .map_err(|error| error.to_string())?;
    }
    if progress.stopped() {
        return Err(STOPPED.to_string());
    }
    encoder
        .flush_to(&mut spool)
        .map_err(|error| format!("Video encoding failed: {error}"))?;
    spool.finish().map_err(|error| error.to_string())
}

/// Writes chunk 0's packets to the output and keeps the first one, whose
/// parameter sets every later chunk has to repeat exactly.
struct FirstPacketSink<'a> {
    output: &'a mut ffmpeg::format::context::Output,
    first: Option<Vec<u8>>,
}

impl PacketSink for FirstPacketSink<'_> {
    fn stream_time_base(&self, stream_index: usize) -> ffmpeg::Rational {
        self.output.stream_time_base(stream_index)
    }

    fn write_packet(&mut self, packet: ffmpeg::Packet) -> Result<(), ffmpeg::Error> {
        if self.first.is_none() {
            self.first = Some(packet.data().unwrap_or_default().to_vec());
        }
        packet.write_interleaved(self.output)
    }
}

/// SPS and PPS NAL units of an Annex B access unit.
fn parameter_sets(access_unit: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut index = 0;
    while index + 3 <= access_unit.len() {
        if access_unit[index] == 0 && access_unit[index + 1] == 0 && access_unit[index + 2] == 1 {
            starts.push(index + 3);
            index += 3;
        } else {
            index += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(position, &start)| {
            let mut end = starts
                .get(position + 1)
                .map_or(access_unit.len(), |next| next - 3);
            while end > start && access_unit[end - 1] == 0 {
                end -= 1;
            }
            let unit = &access_unit[start..end];
            unit.first()
                .is_some_and(|header| matches!(header & 0x1f, 7 | 8))
                .then_some(unit)
        })
        .collect()
}

fn same_parameter_sets(first: Option<&[u8]>, other: Option<&[u8]>) -> bool {
    match (first, other) {
        (Some(first), Some(other)) => {
            let sets = parameter_sets(first);
            !sets.is_empty() && sets == parameter_sets(other)
        }
        _ => false,
    }
}

struct AudioOutput {
    worker: ExportAudioWorker,
}

impl AudioOutput {
    /// Writes the audio of every frame up to `frame`, waiting for the audio
    /// thread only when it falls more than its lag limit behind.
    fn write_through(
        &mut self,
        frame: u32,
        output: &mut ffmpeg::format::context::Output,
    ) -> Result<(), Mp4PipelineError> {
        let worker = &mut self.worker;
        while worker.completed <= frame {
            let packets = if frame - worker.completed >= worker.lag_limit {
                worker.packets.recv().ok()
            } else {
                match worker.packets.try_recv() {
                    Ok(packets) => Some(packets),
                    Err(mpsc::TryRecvError::Empty) => return Ok(()),
                    Err(mpsc::TryRecvError::Disconnected) => None,
                }
            };
            let Some(packets) = packets else {
                return Err(worker
                    .thread
                    .take()
                    .and_then(|thread| join_audio_thread(thread).err())
                    .unwrap_or_else(|| {
                        Mp4PipelineError::Failure("Export audio thread stopped early".to_string())
                    }));
            };
            worker.completed += 1;
            for packet in packets {
                packet
                    .write_interleaved(output)
                    .map_err(|error| Mp4PipelineError::Failure(error.to_string()))?;
            }
        }
        Ok(())
    }

    fn finish(self, output: &mut ffmpeg::format::context::Output) -> Result<(), Mp4PipelineError> {
        let ExportAudioWorker {
            jobs,
            packets,
            thread,
            ..
        } = self.worker;
        drop(jobs);
        for batch in packets.iter() {
            for packet in batch {
                packet
                    .write_interleaved(output)
                    .map_err(|error| Mp4PipelineError::Failure(error.to_string()))?;
            }
        }
        let thread = thread.ok_or_else(|| {
            Mp4PipelineError::Failure("Export audio thread stopped early".to_string())
        })?;
        join_audio_thread(thread)?
            .flush(output)
            .map_err(|error| Mp4PipelineError::Failure(format!("Audio encoding failed: {error}")))
    }
}

struct StitchInput {
    path: PathBuf,
    settings: EncoderSettings,
    total_frames: u32,
    first_chunk: mpsc::Receiver<ExportFrame>,
    later_chunks: Vec<(u32, mpsc::Receiver<Result<SpooledChunk, String>>)>,
    audio: Option<(ExportAudioSource, ProjectConfiguration)>,
    streaming_audio: Option<ExportAudioRenderer>,
    sample_timing: Option<Arc<SampleTiming>>,
}

fn stitch<F: FnMut(u32) -> bool>(
    input: StitchInput,
    progress: &Progress<F>,
) -> Result<(), Mp4PipelineError> {
    let StitchInput {
        path,
        settings,
        total_frames,
        first_chunk,
        later_chunks,
        audio,
        mut streaming_audio,
        sample_timing,
    } = input;
    let sampled = sample_timing.is_some();
    let stopped = || {
        if progress.stopped() {
            Err(Mp4PipelineError::Interrupted)
        } else {
            Ok(())
        }
    };
    let failure = |error: String| Mp4PipelineError::Failure(error);

    let first_frame = first_chunk.recv().ok();
    stopped()?;
    let mut path = path;
    path.set_extension("mp4");
    let mut output = ffmpeg::format::output(&path).map_err(|error| failure(error.to_string()))?;
    let mut encoder = settings
        .builder()
        .build(&mut output)
        .map_err(|error| failure(error.to_string()))?;
    if let Some(timing) = &sample_timing {
        encoder.set_packet_stats(timing.packet_stats());
    }
    let audio_encoder = match &audio {
        Some(_) => Some(
            cap_enc_ffmpeg::aac::AACEncoder::init_for_export(AudioRenderer::info(), &mut output)
                .map_err(|error| failure(error.to_string()))?,
        ),
        None => None,
    };
    if settings.optimize_filesize {
        let mut options = ffmpeg::Dictionary::new();
        options.set("movflags", "+faststart");
        output.write_header_with(options).map(|_| ())
    } else {
        output.write_header()
    }
    .map_err(|error| failure(error.to_string()))?;

    let mut audio_output = match (audio, audio_encoder) {
        (Some((source, project)), Some(audio_encoder)) => {
            let stream_time_base = output.stream_time_base(audio_encoder.stream_index());
            let stop = progress.stop.clone();
            let user = progress.user.clone();
            let mut worker = ExportAudioWorker::spawn(
                stream_time_base,
                audio_encoder,
                source,
                ExportAudioTimeline {
                    project,
                    fps: settings.video_info.frame_rate.0 as u32,
                    sampled,
                },
                move || {
                    stop.load(Ordering::Relaxed)
                        || user
                            .as_ref()
                            .is_some_and(|user| user.load(Ordering::Relaxed))
                },
            )?;
            // Audio runs ahead of the video on purpose: later chunks' spools
            // append far faster than they encode, so audio rendered while
            // chunk 0 encodes keeps them from waiting on it. The queued AAC
            // packets cost at most 40 KB per second of timeline.
            if !sampled {
                for frame in 0..total_frames {
                    worker.request(frame, frame);
                }
            }
            Some(AudioOutput { worker })
        }
        _ => None,
    };

    let mut frame = ffmpeg::frame::Video::new(
        ffmpeg::format::Pixel::NV12,
        settings.video_info.width,
        settings.video_info.height,
    );
    let mut converted = None;
    let mut sink = FirstPacketSink {
        output: &mut output,
        first: None,
    };
    let mut written = 0u32;
    for input in first_frame
        .into_iter()
        .chain(std::iter::from_fn(|| first_chunk.recv().ok()))
    {
        stopped()?;
        if sample_timing
            .as_ref()
            .is_some_and(|timing| timing.is_cancelled())
        {
            return Err(Mp4PipelineError::Interrupted);
        }
        if sampled && let Some(audio) = &mut audio_output {
            audio.worker.request(written, input.timeline_frame);
        }
        fill_input(&input, &mut frame, input.frame_number as i64).map_err(failure)?;
        encoder
            .queue_frame_reusable(&mut frame, &mut converted, Duration::MAX, &mut sink)
            .map_err(|error| failure(error.to_string()))?;
        if let Some(audio) = &mut audio_output {
            audio.write_through(written, &mut *sink.output)?;
        }
        if let Some(timing) = &sample_timing {
            timing.record_frame(input.timeline_frame);
        }
        written += 1;
    }
    stopped()?;
    encoder
        .flush_to(&mut sink)
        .map_err(|error| failure(format!("Video encoding failed: {error}")))?;
    let first_packet = sink.first.take();

    let video_time_base = settings.video_info.time_base;
    let stream_time_base = output.stream_time_base(0);
    for (start, chunk) in later_chunks {
        if written != start {
            return Err(failure(format!(
                "Turbo chunk starting at frame {start} follows {written} written frames"
            )));
        }
        let chunk = chunk
            .recv()
            .map_err(|_| failure("Turbo chunk ended without a result".to_string()))?
            .map_err(failure)?;
        stopped()?;
        if !same_parameter_sets(first_packet.as_deref(), chunk.first_packet.as_deref()) {
            return Err(failure(format!(
                "Turbo chunk starting at frame {start} has different H.264 parameter sets"
            )));
        }
        read_spooled_packets(&chunk, |mut packet| {
            let offset = i64::from(start);
            packet.set_pts(packet.pts().map(|pts| pts + offset));
            packet.set_dts(packet.dts().map(|dts| dts + offset));
            packet.set_stream(0);
            packet.rescale_ts(video_time_base, stream_time_base);
            packet
                .write_interleaved(&mut output)
                .map_err(|error| TurboError::Failed(error.to_string()))?;
            if let Some(audio) = &mut audio_output {
                audio
                    .write_through(written, &mut output)
                    .map_err(|error| TurboError::Failed(error.message()))?;
            }
            written += 1;
            Ok(())
        })
        .map_err(|error| match error {
            TurboError::Cancelled => Mp4PipelineError::Interrupted,
            TurboError::Failed(error) | TurboError::Publish(error) => failure(error),
        })?;
    }
    if !sampled && written != total_frames {
        return Err(failure(format!(
            "Turbo export wrote {written} of {total_frames} frames"
        )));
    }

    match audio_output {
        Some(audio) => audio.finish(&mut output)?,
        None => {
            if let Some(audio) = &mut streaming_audio {
                audio.validate_to_end().map_err(Mp4PipelineError::from)?;
            }
        }
    }
    stopped()?;
    output
        .write_trailer()
        .map_err(|error| failure(error.to_string()))
}

/// An export of the base's sample windows through the turbo encoder, for
/// size and time estimates.
pub(crate) async fn export_sampled(
    settings: Mp4ExportSettings,
    mut base: ExporterBase,
    on_progress: impl FnMut(u32) -> bool + Send + 'static,
) -> Result<PathBuf, String> {
    match export(
        settings,
        &mut base,
        TurboOptions {
            chunks: Some(1),
            strict: true,
        },
        Arc::new(Mutex::new(on_progress)),
    )
    .await
    {
        Ok(path) => Ok(path),
        Err(TurboError::Cancelled) => Err(STOPPED.to_string()),
        Err(TurboError::Failed(error) | TurboError::Publish(error)) => Err(error),
    }
}

pub(crate) async fn export<F: FnMut(u32) -> bool + Send + 'static>(
    settings: Mp4ExportSettings,
    base: &mut ExporterBase,
    options: TurboOptions,
    on_progress: Arc<Mutex<F>>,
) -> Result<PathBuf, TurboError> {
    let fps = settings.fps;
    let output_size = ProjectUniforms::get_output_size(
        &base.render_constants.options,
        &base.project_config,
        settings.resolution_base,
    );
    let total_frames = base.total_frames(fps);
    let cores = std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(4);
    let sample_windows = base.sample_windows.clone();
    let plan = plan(
        total_frames,
        fps,
        cores,
        if sample_windows.is_some() {
            Some(1)
        } else {
            options.chunks
        },
    );
    info!(
        chunks = plan.chunks.len(),
        threads = plan.threads,
        total_frames,
        "Exporting mp4 with turbo"
    );

    let mut video_info =
        VideoInfo::from_raw(RawVideoFormat::Nv12, output_size.0, output_size.1, fps);
    video_info.time_base = ffmpeg::Rational::new(1, fps as i32);
    let bpp = settings.effective_bpp();
    let encoder_settings = EncoderSettings {
        video_info,
        bpp,
        optimize_filesize: settings.optimize_filesize,
        crf: settings.compression.crf_value(),
        tuning: SoftwareEncoderTuning {
            threads: plan.threads,
            capped_crf: (!settings.optimize_filesize).then(|| constant_quality(bpp, fps)),
        },
    };

    let mut extra_segments = Vec::with_capacity(plan.chunks.len().saturating_sub(1));
    for _ in 1..plan.chunks.len() {
        extra_segments.push(cap_editor::create_segments_without_audio(
            &base.recording_meta,
            &base.studio_meta,
            settings.force_ffmpeg_decoder,
        ));
    }
    let extra_segments = futures::future::try_join_all(extra_segments).await?;
    if crate::reads_recordings_forward(&base.project_config) {
        for segment in extra_segments.iter().flatten() {
            segment.decoders.prefer_sequential_access();
        }
    }

    let output_path = base.output_path.clone();
    let mut streaming_audio = base.streaming_audio.take();
    let audio_control = base.audio_cancellation.take();
    let temporary_output = match base.streaming_output.take() {
        Some(staged) => Some(staged),
        None => crate::prepare_new_output(&base.output_path).ok().flatten(),
    }
    .map(Arc::new);
    let user_cancellation = base.user_cancellation.clone();
    let stop = audio_control
        .as_ref()
        .map(|control| control.stop.clone())
        .unwrap_or_default();
    let progress = Arc::new(Progress {
        frames: Mutex::new((0, move |frame| {
            (on_progress.lock().unwrap_or_else(PoisonError::into_inner))(frame)
        })),
        stop: stop.clone(),
        user: user_cancellation,
        cancelled: AtomicBool::new(false),
        failure: Mutex::new(None),
    });

    let unused_audio = streaming_audio
        .as_mut()
        .and_then(|audio| audio.take_unused_sources(&base.project_config));
    let audio_validation = unused_audio.map(|validation| {
        let stop = stop.clone();
        tokio::task::spawn_blocking(move || {
            let result = validation.validate_to_end().map_err(Mp4PipelineError::from);
            if result.is_err() {
                stop.store(true, Ordering::Relaxed);
            }
            result
        })
    });

    let audio_segments = get_audio_segments(&base.segments).await;
    let music = load_music_tracks_uncached(&base.project_config, &base.project_path);
    let has_recording_audio = audio_segments
        .first()
        .filter(|_| !base.project_config.audio.mute)
        .is_some();
    let audio = (has_recording_audio || !music.is_empty()).then(|| {
        let source = match streaming_audio.take() {
            Some(audio) => ExportAudioSource::Streaming(audio),
            None => {
                ExportAudioSource::Renderer(AudioRenderer::new(audio_segments).with_music(music))
            }
        };
        (source, base.project_config.clone())
    });

    let shared = RenderShared {
        constants: base.render_constants.clone(),
        project: Arc::new(base.project_config.clone()),
        recording_meta: Arc::new(base.recording_meta.clone()),
        studio_meta: Arc::new(base.studio_meta.clone()),
        recordings: base.recordings.clone(),
        fps,
        resolution_base: settings.resolution_base,
    };
    let render_segments = |segments: &[SegmentMedia]| {
        segments
            .iter()
            .map(|segment| RenderSegment {
                cursor: segment.cursor.clone(),
                keyboard: segment.keyboard.clone(),
                decoders: segment.decoders.clone(),
                render_display: true,
            })
            .collect::<Vec<_>>()
    };

    let mut renders = Vec::with_capacity(plan.chunks.len());
    let mut encoders = Vec::with_capacity(plan.chunks.len().saturating_sub(1));
    let mut later_chunks = Vec::with_capacity(plan.chunks.len().saturating_sub(1));
    let (first_tx, first_chunk) = mpsc::sync_channel::<ExportFrame>(4);
    let spawn_failure = |error: std::io::Error| {
        stop.store(true, Ordering::Relaxed);
        TurboError::Failed(format!("Could not start a turbo export thread: {error}"))
    };
    renders.push(
        render_chunk(
            shared.clone(),
            render_segments(&base.segments),
            sample_windows
                .clone()
                .unwrap_or_else(|| cap_rendering::FrameWindows::new(vec![plan.chunks[0].clone()])),
            0,
            first_tx,
            progress.clone(),
            sample_windows.is_none().then(|| base.project_path.clone()),
        )
        .map_err(spawn_failure)?,
    );
    for (index, (frames, segments)) in plan.chunks.iter().skip(1).zip(&extra_segments).enumerate() {
        #[cfg(feature = "test-hooks")]
        let fail_after = (base.turbo_chunk_failure == Some(index + 1)).then_some(2);
        #[cfg(not(feature = "test-hooks"))]
        let fail_after = {
            let _ = index;
            None
        };
        let preroll = preroll_frames(fps, frames.start);
        let rendered = frames.start - preroll..frames.end;
        let (frame_tx, frame_rx) = mpsc::sync_channel::<ExportFrame>(4);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let worker_progress = progress.clone();
        encoders.push(
            std::thread::Builder::new()
                .name("turbo-encode".to_string())
                .spawn(move || {
                    let result = encode_chunk(
                        frame_rx,
                        encoder_settings,
                        &worker_progress,
                        preroll,
                        fail_after,
                    );
                    if let Err(error) = &result
                        && error != STOPPED
                    {
                        worker_progress.fail(error.clone());
                    }
                    let _ = result_tx.send(result);
                })
                .map_err(spawn_failure)?,
        );
        renders.push(
            render_chunk(
                shared.clone(),
                render_segments(segments),
                cap_rendering::FrameWindows::new(vec![rendered]),
                preroll,
                frame_tx,
                progress.clone(),
                None,
            )
            .map_err(spawn_failure)?,
        );
        later_chunks.push((frames.start, result_rx));
    }

    let encoder_output_path = temporary_output
        .as_ref()
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| output_path.clone());
    let stitch_input = StitchInput {
        path: encoder_output_path,
        settings: encoder_settings,
        total_frames,
        first_chunk,
        later_chunks,
        audio,
        streaming_audio,
        sample_timing: base.sample_timing.clone(),
    };
    let stitch_progress = progress.clone();
    let stitch_temporary_output = temporary_output.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _temporary_output_guard = stitch_temporary_output;
        let stitched = stitch(stitch_input, &stitch_progress);
        if let Err(
            Mp4PipelineError::Failure(error)
            | Mp4PipelineError::AudioSourceFailure { message: error, .. },
        ) = &stitched
        {
            stitch_progress.fail(error.clone());
        }
        let mut errors = vec![stitched.err()];
        for render in renders {
            errors.push(match render.join() {
                Ok(Ok(())) => None,
                Ok(Err(error)) if error == STOPPED => Some(Mp4PipelineError::Interrupted),
                Ok(Err(error)) => Some(Mp4PipelineError::Failure(error)),
                Err(_) => Some(Mp4PipelineError::Failure(
                    "Turbo render thread panicked".to_string(),
                )),
            });
        }
        for encoder in encoders {
            if encoder.join().is_err() {
                errors.push(Some(Mp4PipelineError::Failure(
                    "Turbo encoder thread panicked".to_string(),
                )));
            }
        }
        errors
    })
    .await
    .map_err(|error| TurboError::Failed(error.to_string()))?;
    let validation = match audio_validation {
        Some(task) => task
            .await
            .map_err(|error| Mp4PipelineError::Failure(error.to_string()))
            .and_then(|result| result)
            .err(),
        None => None,
    };
    drop(extra_segments);

    let mut errors = result.into_iter().flatten().chain(validation);
    let error = errors.find(|error| !matches!(error, Mp4PipelineError::Interrupted));
    if progress.was_cancelled() {
        return Err(TurboError::Cancelled);
    }
    let first_failure = progress
        .failure
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(error) = first_failure {
        return Err(TurboError::Failed(error));
    }
    if let Some(error) = error {
        return Err(TurboError::Failed(error.message()));
    }
    if progress.stopped() {
        return Err(TurboError::Failed(
            "Turbo export stopped before it finished".to_string(),
        ));
    }
    if let Some(temporary_output) = temporary_output {
        Arc::try_unwrap(temporary_output)
            .map_err(|_| TurboError::Failed("Export output is still in use".to_string()))?
            .persist_noclobber(&output_path)
            .map_err(|error| TurboError::Publish(error.to_string()))?;
    }
    drop(audio_control);
    Ok(output_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_cover_every_frame_in_order() {
        for (total, fps, cores, requested) in [
            (2312, 60, 10, None),
            (2312, 60, 10, Some(3)),
            (100, 30, 16, None),
            (7, 30, 16, Some(4)),
            (100_000, 60, 64, None),
        ] {
            let plan = plan(total, fps, cores, requested);
            assert!(!plan.chunks.is_empty() && plan.chunks.len() <= MAX_CHUNKS);
            assert_eq!(plan.chunks[0].start, 0);
            assert_eq!(plan.chunks.last().unwrap().end, total);
            for pair in plan.chunks.windows(2) {
                assert_eq!(pair[0].end, pair[1].start);
                assert!(pair[0].len().abs_diff(pair[1].len()) <= 1);
            }
            assert!(plan.threads >= 1);
        }
    }

    #[test]
    fn short_exports_stay_in_one_chunk_unless_asked() {
        assert_eq!(plan(60 * 7, 60, 16, None).chunks.len(), 1);
        assert_eq!(plan(60 * 8, 60, 16, None).chunks.len(), 2);
        assert_eq!(plan(60 * 7, 60, 16, Some(3)).chunks.len(), 3);
        assert_eq!(plan(2, 60, 16, Some(3)).chunks, vec![0..1, 1..2]);
        assert_eq!(plan(0, 60, 16, None).chunks, vec![0..0]);
    }

    #[test]
    fn preroll_covers_mask_smoothing_without_reaching_before_the_timeline() {
        assert_eq!(preroll_frames(60, 1000), 30);
        assert_eq!(preroll_frames(15, 1000), 16);
        assert_eq!(preroll_frames(30, 10), 10);
        assert_eq!(preroll_frames(30, 0), 0);
    }

    #[test]
    fn constant_quality_follows_the_presets() {
        for (compression, crf) in [
            (ExportCompression::Maximum, 15),
            (ExportCompression::Social, 18),
            (ExportCompression::Web, 20),
            (ExportCompression::Potato, 22),
        ] {
            assert_eq!(constant_quality(compression.bits_per_pixel(), 30), crf);
            assert_eq!(constant_quality(compression.bits_per_pixel(), 60), crf - 3);
            assert_eq!(constant_quality(compression.bits_per_pixel(), 15), crf + 2);
        }
        assert_eq!(constant_quality(1.0, 30), 15);
        assert_eq!(constant_quality(0.01, 30), 22);
        assert_eq!(constant_quality(0.0, 30), 22);
        assert_eq!(constant_quality(0.3, 120), 12);
        assert!((15..=22).contains(&constant_quality(0.2, 30)));
    }

    #[test]
    fn parameter_sets_compare_sps_and_pps_only() {
        let unit = |nal: &[u8]| [&[0u8, 0, 0, 1][..], nal].concat();
        let sps = [0x67, 0x64, 0x00, 0x28];
        let pps = [0x68, 0xee, 0x3c, 0x80];
        let sei = [0x06, 0x05, 0x01];
        let first = [unit(&sps), unit(&pps), unit(&sei), unit(&[0x65, 1, 2])].concat();
        let other = [
            unit(&sps),
            unit(&pps),
            unit(&[0x06, 0x09]),
            unit(&[0x65, 3]),
        ]
        .concat();
        assert_eq!(parameter_sets(&first), vec![&sps[..], &pps[..]]);
        assert!(same_parameter_sets(Some(&first), Some(&other)));
        let changed = [unit(&[0x67, 0x4d, 0x00, 0x28]), unit(&pps)].concat();
        assert!(!same_parameter_sets(Some(&first), Some(&changed)));
        assert!(!same_parameter_sets(Some(&first), None));
        assert!(!same_parameter_sets(Some(&[0x65, 1]), Some(&[0x65, 1])));
    }
}
