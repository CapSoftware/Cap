use std::{
    fs::File,
    io::{BufWriter, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use cap_editor::{
    AudioRenderer, ExportAudioPreparation, ExportAudioRenderer, audio_segment_from_decoded,
};
use cap_enc_ffmpeg::mp3::Mp3Encoder;
use cap_project::ProjectConfiguration;

use crate::{
    mp4::audio_frame_budget,
    tracks::{
        PreparedTimeline, StagedFiles, TrackExportError, TrackProgress, export_token,
        prepare_timeline, publish, run_blocking,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioExportFormat {
    Mp3,
    Wav,
}

pub const WAV_BITS_PER_SAMPLE: u16 = 16;
const WAV_CHANNELS: u16 = 2;
const WAV_HEADER_BYTES: u64 = 44;
const MP3_OVERHEAD_BYTES: u64 = 4_096;
/// Audio renders in steps of this many per second, the budget the MP4 export
/// uses at 30 fps, so both exports cut the same samples at every edit.
const RENDER_STEPS_PER_SECOND: u32 = 30;

impl AudioExportFormat {
    pub const ALL: [Self; 2] = [Self::Mp3, Self::Wav];

    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
        }
    }

    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension.trim().to_ascii_lowercase().as_str() {
            "mp3" => Some(Self::Mp3),
            "wav" | "wave" => Some(Self::Wav),
            _ => None,
        }
    }

    pub fn is_available(self) -> bool {
        match self {
            Self::Mp3 => {
                let _ = ffmpeg::init();
                Mp3Encoder::is_available()
            }
            Self::Wav => true,
        }
    }

    pub fn estimated_bytes(self, duration_secs: f64) -> u64 {
        let duration_secs = if duration_secs.is_finite() {
            duration_secs.max(0.0)
        } else {
            0.0
        };
        match self {
            Self::Mp3 => {
                (duration_secs * Mp3Encoder::DEFAULT_BITRATE as f64 / 8.0).ceil() as u64
                    + MP3_OVERHEAD_BYTES
            }
            Self::Wav => {
                let frames = (duration_secs * f64::from(AudioRenderer::SAMPLE_RATE)).ceil() as u64;
                WAV_HEADER_BYTES
                    + frames * u64::from(WAV_CHANNELS) * u64::from(WAV_BITS_PER_SAMPLE / 8)
            }
        }
    }
}

pub fn has_audio(
    recordings: &cap_rendering::ProjectRecordingsMeta,
    project: &ProjectConfiguration,
) -> bool {
    crate::tracks::available_tracks(recordings, project)
        .iter()
        .any(|kind| !kind.is_video())
}

/// Writes the project's edited sound to `output_path` in `format`. The file
/// is staged next to the destination and moved into place only when it is
/// complete, so a cancelled or failed export leaves any earlier file intact.
pub async fn export_audio(
    project_path: PathBuf,
    config: Option<ProjectConfiguration>,
    format: AudioExportFormat,
    output_path: PathBuf,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(TrackProgress) + Send,
) -> Result<PathBuf, TrackExportError> {
    let _export_activity = cap_rendering::ExportActivity::begin();
    if !format.is_available() {
        return Err(TrackExportError::Failed(
            "MP3 export is not available in this build".into(),
        ));
    }
    let PreparedTimeline {
        recording_meta,
        project,
        recordings,
        duration,
    } = prepare_timeline(&project_path, config)?.measured()?;
    if !has_audio(&recordings, &project) {
        return Err(TrackExportError::Failed(
            "This recording has no sound to export".into(),
        ));
    }
    let studio_meta = recording_meta
        .studio_meta()
        .ok_or(TrackExportError::NotStudio)?;

    let parent = output_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    if output_path.is_dir() {
        return Err(TrackExportError::Failed(format!(
            "{} is a folder, so the audio cannot be saved there",
            output_path.display()
        )));
    }
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    cap_editor::release_playback_audio_caches();
    let force_ffmpeg_decoder = !cfg!(target_os = "macos");
    let mut source = if ExportAudioRenderer::eligible(&project, studio_meta) {
        let abort = Arc::new(AtomicBool::new(false));
        let recording = recording_meta.clone();
        let studio = studio_meta.clone();
        let user_cancel = cancel.clone();
        let source_abort = abort.clone();
        let preparation = tokio::task::spawn_blocking(move || {
            ExportAudioPreparation::open(&recording, &studio, user_cancel, source_abort)
        });
        let segments = cap_editor::create_segments_without_audio(
            &recording_meta,
            studio_meta,
            force_ffmpeg_decoder,
        )
        .await;
        if segments.is_err() {
            abort.store(true, Ordering::Relaxed);
        }
        let preparation = preparation
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let segments = segments.map_err(TrackExportError::Failed)?;
        AudioSource::Streaming(Box::new(
            preparation
                .finish(&segments)
                .map_err(|error| error.to_string())?,
        ))
    } else {
        let segments =
            cap_editor::create_segments(&recording_meta, studio_meta, force_ffmpeg_decoder)
                .await
                .map_err(TrackExportError::Failed)?;
        let mut audio_segments = Vec::with_capacity(segments.len());
        for segment in &segments {
            let mic = segment
                .audio
                .get()
                .await
                .map_err(|error| format!("Could not read the microphone audio: {error}"))?;
            let system = segment
                .system_audio
                .get()
                .await
                .map_err(|error| format!("Could not read the system audio: {error}"))?;
            audio_segments.push(audio_segment_from_decoded(
                mic,
                system,
                segment.audio_timing_repair,
            ));
        }
        let music = cap_editor::load_music_tracks_uncached(&project, &recording_meta.project_path);
        let mut renderer = AudioRenderer::new(audio_segments).with_music(music);
        renderer.set_playhead(0.0, &project);
        AudioSource::Renderer(Box::new(renderer))
    };

    if cancel.load(Ordering::Relaxed) {
        return Err(TrackExportError::Cancelled);
    }

    let token = export_token();
    let file_name = output_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("audio.{}", format.extension()));
    let staged = parent.join(format!(
        ".{file_name}.{token}.partial.{}",
        format.extension()
    ));
    let mut cleanup = StagedFiles(vec![staged.clone()]);

    let steps = crate::tracks::total_frames(duration, RENDER_STEPS_PER_SECOND);
    let total = u64::from(steps);
    on_progress(TrackProgress { done: 0, total });

    run_blocking(|| {
        let mut sink = AudioSink::create(format, &staged)?;
        let sample_rate = u64::from(AudioRenderer::SAMPLE_RATE);
        let steps_per_second = u64::from(RENDER_STEPS_PER_SECOND);
        let mut cursor = 0u64;
        for step in 0..u64::from(steps) {
            if cancel.load(Ordering::Relaxed) {
                return Err(TrackExportError::Cancelled);
            }
            if let Some((pts, samples)) =
                audio_frame_budget(step, sample_rate, steps_per_second, cursor)
            {
                cursor = pts as u64 + samples as u64;
                let written = source.render(samples, &project, &mut sink)?;
                sink.write_silence(samples.saturating_sub(written))?;
            }
            on_progress(TrackProgress {
                done: step + 1,
                total,
            });
        }
        source.finish()?;
        sink.finish()
    })?;

    if cancel.load(Ordering::Relaxed) {
        return Err(TrackExportError::Cancelled);
    }
    publish(&[(staged, output_path.clone())], &token)?;
    cleanup.0.clear();
    Ok(output_path)
}

enum AudioSource {
    Renderer(Box<AudioRenderer>),
    Streaming(Box<ExportAudioRenderer>),
}

impl AudioSource {
    fn render(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
        sink: &mut AudioSink,
    ) -> Result<usize, TrackExportError> {
        match self {
            Self::Renderer(renderer) => match renderer.render_frame_raw(samples, project) {
                Some((count, data)) => {
                    let count = count.min(samples).min(data.len() / 2);
                    sink.write(&data[..count * 2])?;
                    Ok(count)
                }
                None => Ok(0),
            },
            Self::Streaming(renderer) => {
                let mut written = 0usize;
                let mut sink_error = None;
                let rendered = renderer
                    .render_chunks(samples, project, |offset, data| {
                        if offset > written {
                            if let Err(error) = sink.write_silence(offset - written) {
                                sink_error = Some(error);
                                return Err(cap_editor::ExportAudioError::Sink(
                                    "audio sink failed".into(),
                                ));
                            }
                            written = offset;
                        }
                        let frames = (data.len() / 2).min(samples.saturating_sub(written));
                        if let Err(error) = sink.write(&data[..frames * 2]) {
                            sink_error = Some(error);
                            return Err(cap_editor::ExportAudioError::Sink(
                                "audio sink failed".into(),
                            ));
                        }
                        written += frames;
                        Ok(())
                    })
                    .map_err(|error| {
                        sink_error
                            .take()
                            .unwrap_or_else(|| TrackExportError::Failed(error.to_string()))
                    })?;
                Ok(if rendered.is_some() { written } else { 0 })
            }
        }
    }

    fn finish(&mut self) -> Result<(), TrackExportError> {
        match self {
            Self::Renderer(_) => Ok(()),
            Self::Streaming(renderer) => renderer
                .validate_to_end()
                .map_err(|error| TrackExportError::Failed(error.to_string())),
        }
    }
}

enum AudioSink {
    Wav(WavWriter),
    Mp3(Box<Mp3Sink>),
}

struct Mp3Sink {
    output: ffmpeg::format::context::Output,
    encoder: Mp3Encoder,
    written: i64,
}

impl AudioSink {
    fn create(format: AudioExportFormat, path: &Path) -> Result<Self, TrackExportError> {
        match format {
            AudioExportFormat::Wav => Ok(Self::Wav(WavWriter::create(path)?)),
            AudioExportFormat::Mp3 => {
                let mut output = ffmpeg::format::output_as(path, "mp3")
                    .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
                let encoder = Mp3Encoder::init(
                    AudioRenderer::info(),
                    Mp3Encoder::DEFAULT_BITRATE,
                    &mut output,
                )
                .map_err(|error| format!("Could not start the MP3 encoder: {error}"))?;
                output
                    .write_header()
                    .map_err(|error| format!("Could not write the MP3 header: {error}"))?;
                Ok(Self::Mp3(Box::new(Mp3Sink {
                    output,
                    encoder,
                    written: 0,
                })))
            }
        }
    }

    fn write(&mut self, interleaved: &[f32]) -> Result<(), TrackExportError> {
        if interleaved.len() < 2 {
            return Ok(());
        }
        match self {
            Self::Wav(wav) => wav.write(interleaved),
            Self::Mp3(sink) => {
                let Mp3Sink {
                    output,
                    encoder,
                    written,
                } = sink.as_mut();
                let frames = interleaved.len() / 2;
                let mut frame = ffmpeg::frame::Audio::new(
                    AudioRenderer::SAMPLE_FORMAT,
                    frames,
                    ffmpeg::ChannelLayout::STEREO,
                );
                frame.set_rate(AudioRenderer::SAMPLE_RATE);
                for (sample, bytes) in interleaved[..frames * 2].iter().zip(
                    frame
                        .data_mut(0)
                        .chunks_exact_mut(std::mem::size_of::<f32>()),
                ) {
                    bytes.copy_from_slice(&sample.to_ne_bytes());
                }
                frame.set_pts(Some(*written));
                *written += frames as i64;
                encoder
                    .queue_frame(frame, Duration::MAX, output)
                    .map_err(|error| {
                        TrackExportError::Failed(format!("MP3 encoding failed: {error}"))
                    })
            }
        }
    }

    fn write_silence(&mut self, frames: usize) -> Result<(), TrackExportError> {
        if frames == 0 {
            return Ok(());
        }
        match self {
            Self::Wav(wav) => wav.write_silence(frames),
            Self::Mp3(_) => {
                let zeros = vec![0.0f32; frames.min(4_096) * 2];
                let mut left = frames;
                while left > 0 {
                    let count = left.min(4_096);
                    self.write(&zeros[..count * 2])?;
                    left -= count;
                }
                Ok(())
            }
        }
    }

    fn finish(self) -> Result<(), TrackExportError> {
        match self {
            Self::Wav(wav) => wav.finish(),
            Self::Mp3(sink) => {
                let Mp3Sink {
                    mut output,
                    mut encoder,
                    ..
                } = *sink;
                encoder
                    .flush(&mut output)
                    .map_err(|error| format!("MP3 encoding failed: {error}"))?;
                output
                    .write_trailer()
                    .map_err(|error| format!("Could not finish the MP3 file: {error}"))?;
                Ok(())
            }
        }
    }
}

struct WavWriter {
    file: BufWriter<File>,
    frames: u64,
}

impl WavWriter {
    /// A RIFF file's sizes are 32-bit, which caps 48 kHz 16-bit stereo at
    /// about six hours.
    const MAX_DATA_BYTES: u64 = u32::MAX as u64 - WAV_HEADER_BYTES;

    fn create(path: &Path) -> Result<Self, TrackExportError> {
        let file = File::create(path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        let mut writer = Self {
            file: BufWriter::with_capacity(1 << 20, file),
            frames: 0,
        };
        writer.header(0)?;
        Ok(writer)
    }

    fn header(&mut self, data_bytes: u32) -> Result<(), TrackExportError> {
        self.file
            .write_all(&wav_header(AudioRenderer::SAMPLE_RATE, data_bytes))
            .map_err(io_error)
    }

    fn bytes_per_frame() -> u64 {
        u64::from(WAV_CHANNELS) * u64::from(WAV_BITS_PER_SAMPLE / 8)
    }

    fn reserve(&mut self, frames: u64) -> Result<(), TrackExportError> {
        if (self.frames + frames) * Self::bytes_per_frame() > Self::MAX_DATA_BYTES {
            return Err(TrackExportError::Failed(
                "This recording is too long for a WAV file. Export it as MP3 instead.".into(),
            ));
        }
        self.frames += frames;
        Ok(())
    }

    fn write(&mut self, interleaved: &[f32]) -> Result<(), TrackExportError> {
        let frames = interleaved.len() / usize::from(WAV_CHANNELS);
        self.reserve(frames as u64)?;
        let mut bytes = Vec::with_capacity(frames * usize::from(WAV_CHANNELS) * 2);
        for sample in &interleaved[..frames * usize::from(WAV_CHANNELS)] {
            bytes.extend_from_slice(&pcm16(*sample));
        }
        self.file.write_all(&bytes).map_err(io_error)
    }

    fn write_silence(&mut self, frames: usize) -> Result<(), TrackExportError> {
        self.reserve(frames as u64)?;
        let bytes = vec![0u8; frames * Self::bytes_per_frame() as usize];
        self.file.write_all(&bytes).map_err(io_error)
    }

    fn finish(mut self) -> Result<(), TrackExportError> {
        let data_bytes = (self.frames * Self::bytes_per_frame()) as u32;
        self.file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        self.header(data_bytes)?;
        let file = self
            .file
            .into_inner()
            .map_err(|error| io_error(error.into_error()))?;
        file.sync_all().map_err(io_error)
    }
}

fn io_error(error: std::io::Error) -> TrackExportError {
    TrackExportError::Failed(format!("Writing the audio file failed: {error}"))
}

fn wav_header(sample_rate: u32, data_bytes: u32) -> [u8; WAV_HEADER_BYTES as usize] {
    let block_align = WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);
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
    header[34..36].copy_from_slice(&WAV_BITS_PER_SAMPLE.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    header
}

fn pcm16(sample: f32) -> [u8; 2] {
    let sample = if sample.is_finite() { sample } else { 0.0 };
    ((sample.clamp(-1.0, 1.0) * 32_767.0).round() as i16).to_le_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_round_trip_their_extensions() {
        for format in AudioExportFormat::ALL {
            assert_eq!(
                AudioExportFormat::from_extension(format.extension()),
                Some(format)
            );
        }
        assert_eq!(
            AudioExportFormat::from_extension("WAVE"),
            Some(AudioExportFormat::Wav)
        );
        assert_eq!(AudioExportFormat::from_extension("mp4"), None);
    }

    #[test]
    fn both_formats_are_available_in_the_bundled_ffmpeg() {
        for format in AudioExportFormat::ALL {
            assert!(format.is_available(), "{format:?}");
        }
    }

    #[test]
    fn estimates_match_the_constant_rates() {
        let hour = 3_600.0;
        assert_eq!(
            AudioExportFormat::Wav.estimated_bytes(hour),
            44 + 3_600 * 48_000 * 4
        );
        assert_eq!(
            AudioExportFormat::Mp3.estimated_bytes(hour),
            3_600 * 24_000 + MP3_OVERHEAD_BYTES
        );
        assert_eq!(
            AudioExportFormat::Mp3.estimated_bytes(f64::NAN),
            MP3_OVERHEAD_BYTES
        );
        assert_eq!(AudioExportFormat::Wav.estimated_bytes(-1.0), 44);
    }

    #[test]
    fn pcm16_clamps_and_rounds() {
        assert_eq!(i16::from_le_bytes(pcm16(1.5)), 32_767);
        assert_eq!(i16::from_le_bytes(pcm16(-1.5)), -32_767);
        assert_eq!(i16::from_le_bytes(pcm16(0.5)), 16_384);
        assert_eq!(i16::from_le_bytes(pcm16(f32::NAN)), 0);
    }

    #[test]
    fn wav_writer_produces_a_16_bit_file_ffmpeg_reads() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.wav");
        let mut sink = AudioSink::create(AudioExportFormat::Wav, &path).unwrap();
        sink.write(&vec![0.25f32; 48_000 * 2]).unwrap();
        sink.write_silence(24_000).unwrap();
        sink.finish().unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            44 + (72_000 * 4) as u64
        );
        let input = ffmpeg::format::input(&path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Audio).unwrap();
        let decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        assert_eq!(decoder.id(), ffmpeg::codec::Id::PCM_S16LE);
        assert_eq!(decoder.rate(), 48_000);
        assert_eq!(decoder.channels(), 2);
    }

    #[test]
    fn mp3_sink_writes_the_requested_length() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".x.partial.mp3");
        let mut sink = AudioSink::create(AudioExportFormat::Mp3, &path).unwrap();
        for _ in 0..30 {
            sink.write(&vec![0.1f32; 1_600 * 2]).unwrap();
        }
        sink.write_silence(48_000).unwrap();
        sink.finish().unwrap();

        let input = ffmpeg::format::input(&path).unwrap();
        let duration = input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
        assert!((duration - 2.0).abs() < 0.08, "duration {duration}");
        let size = std::fs::metadata(&path).unwrap().len();
        let estimate = AudioExportFormat::Mp3.estimated_bytes(2.0);
        assert!(
            size.abs_diff(estimate) < 8_000,
            "size {size} estimate {estimate}"
        );
    }
}
