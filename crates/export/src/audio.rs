use cap_editor::{AudioRenderer, get_audio_segments, load_music_tracks_uncached};
use cap_project::{AudioExportFormat, AudioSource, ProjectConfiguration};
use cap_rendering::FrameWindows;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tracing::info;

use crate::ExporterBase;

pub const AUDIO_EXPORT_CHUNK_SAMPLES: usize = 1600;
pub(crate) const AUDIO_EXPORT_FPS: u32 = 30;

const EXPORT_CANCELLED: &str = "Export cancelled";
const MP3_BIT_RATE: usize = 192_000;
const MP3_ENCODERS: [&str; 4] = ["libmp3lame", "libshine", "mp3_mf", "mp3"];
const WAV_CONVERT_BLOCK_SAMPLES: usize = 8_192;
const MAX_WAV_DATA_BYTES: u64 = u32::MAX as u64 - 36;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioExportSettings {
    #[serde(default)]
    pub source: AudioSource,
    #[serde(default)]
    pub audio_format: AudioExportFormat,
}

impl AudioExportSettings {
    pub async fn export(
        self,
        mut base: ExporterBase,
        on_progress: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<PathBuf, String> {
        self.export_inner(&mut base, on_progress).await
    }

    async fn export_inner(
        self,
        base: &mut ExporterBase,
        mut on_progress: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<PathBuf, String> {
        let mut output_path = base.output_path.clone();
        if output_path.extension().and_then(|ext| ext.to_str())
            != Some(self.audio_format.extension())
        {
            output_path.set_extension(self.audio_format.extension());
        }
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let audio_segments = get_audio_segments(&base.segments).await;
        let music = load_music_tracks_uncached(&base.project_config, &base.project_path);
        let mut renderer = AudioRenderer::new(audio_segments).with_music(music);
        let mut project = base.project_config.clone();
        crate::apply_audio_source(&mut project, self.source);

        let duration = cap_rendering::get_duration(
            &base.recordings,
            &base.recording_meta,
            &base.studio_meta,
            &project,
        );
        if !duration.is_finite() || duration <= 0.0 {
            return Err("There is nothing to export: the timeline is empty".to_string());
        }

        let total_samples = (duration * f64::from(AudioRenderer::SAMPLE_RATE)).round() as usize;
        let samples = stage_audio_output(&output_path, |staged| {
            let mut writer =
                AudioFileWriter::create(self.audio_format, staged, AudioRenderer::SAMPLE_RATE)?;
            let mut progress = ExportProgress::new(&mut on_progress);
            if let Some(windows) = base.sample_windows.as_ref() {
                render_windows(
                    &mut renderer,
                    &mut writer,
                    windows,
                    &project,
                    base.sample_timing.as_deref(),
                    &mut progress,
                )?;
            } else {
                render_full(
                    &mut renderer,
                    &mut writer,
                    total_samples,
                    &project,
                    &mut progress,
                )?;
            }
            let samples = writer.finish(&mut progress)?;
            if progress.cancelled() {
                return Err(EXPORT_CANCELLED.to_string());
            }
            Ok(samples)
        })?;

        info!(
            source = self.source.label(),
            format = self.audio_format.label(),
            samples,
            "Rendered audio for audio-only export"
        );

        Ok(output_path)
    }
}

fn stage_audio_output(
    output_path: &Path,
    write: impl FnOnce(&Path) -> Result<u64, String>,
) -> Result<u64, String> {
    let staged = crate::mp4::temporary_export_output(output_path)?;
    let samples = write(staged.as_ref())?;
    staged
        .persist_replace(output_path)
        .map_err(|error| error.to_string())?;
    Ok(samples)
}

struct ExportProgress<'a> {
    callback: &'a mut dyn FnMut(u32) -> bool,
    index: u32,
}

impl<'a> ExportProgress<'a> {
    fn new(callback: &'a mut dyn FnMut(u32) -> bool) -> Self {
        Self { callback, index: 0 }
    }

    fn advance(&mut self, index: u32) -> bool {
        self.index = index;
        (self.callback)(index)
    }

    fn cancelled(&mut self) -> bool {
        !(self.callback)(self.index)
    }
}

enum AudioFileWriter {
    Wav(WavWriter),
    Mp3(Mp3Writer),
}

impl AudioFileWriter {
    fn create(format: AudioExportFormat, path: &Path, sample_rate: u32) -> Result<Self, String> {
        match format {
            AudioExportFormat::Wav => Ok(Self::Wav(WavWriter::create(path, sample_rate, 2)?)),
            AudioExportFormat::Mp3 => Ok(Self::Mp3(Mp3Writer::create(path, sample_rate)?)),
        }
    }

    fn write(
        &mut self,
        interleaved: &[f32],
        progress: &mut ExportProgress<'_>,
    ) -> Result<(), String> {
        match self {
            Self::Wav(writer) => writer.write(interleaved, progress),
            Self::Mp3(writer) => writer.write(interleaved, progress),
        }
    }

    fn finish(self, progress: &mut ExportProgress<'_>) -> Result<u64, String> {
        match self {
            Self::Wav(writer) => writer.finish(progress),
            Self::Mp3(writer) => writer.finish(progress),
        }
    }
}

struct WavWriter {
    file: BufWriter<std::fs::File>,
    sample_rate: u32,
    channels: u16,
    data_bytes: u64,
    samples_written: u64,
    scratch: Vec<u8>,
}

impl WavWriter {
    fn create(path: &Path, sample_rate: u32, channels: u16) -> Result<Self, String> {
        if channels == 0 {
            return Err("WAV export expects at least one channel".to_string());
        }
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut file = BufWriter::new(file);
        write_wav_header(&mut file, 0, sample_rate, channels).map_err(|e| e.to_string())?;
        Ok(Self {
            file,
            sample_rate,
            channels,
            data_bytes: 0,
            samples_written: 0,
            scratch: Vec::with_capacity(WAV_CONVERT_BLOCK_SAMPLES * 2),
        })
    }

    fn write(
        &mut self,
        interleaved: &[f32],
        progress: &mut ExportProgress<'_>,
    ) -> Result<(), String> {
        if progress.cancelled() {
            return Err(EXPORT_CANCELLED.to_string());
        }

        let frames = interleaved.len() / self.channels as usize;
        let samples = frames * self.channels as usize;
        let bytes = samples as u64 * 2;
        let data_bytes = self.data_bytes.checked_add(bytes).ok_or_else(|| {
            "WAV export is limited to 4 GB; export MP3 for longer recordings".to_string()
        })?;
        if data_bytes > MAX_WAV_DATA_BYTES {
            return Err(
                "WAV export is limited to 4 GB; export MP3 for longer recordings".to_string(),
            );
        }

        for block in interleaved[..samples].chunks(WAV_CONVERT_BLOCK_SAMPLES) {
            self.scratch.clear();
            for &sample in block {
                let pcm = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                self.scratch.extend_from_slice(&pcm.to_le_bytes());
            }
            self.file
                .write_all(&self.scratch)
                .map_err(|e| e.to_string())?;
        }

        self.data_bytes = data_bytes;
        self.samples_written += frames as u64;
        Ok(())
    }

    fn finish(mut self, progress: &mut ExportProgress<'_>) -> Result<u64, String> {
        if progress.cancelled() {
            return Err(EXPORT_CANCELLED.to_string());
        }
        self.file.flush().map_err(|e| e.to_string())?;
        let end = self
            .file
            .seek(SeekFrom::End(0))
            .map_err(|e| e.to_string())?;
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;
        write_wav_header(
            &mut self.file,
            self.data_bytes as u32,
            self.sample_rate,
            self.channels,
        )
        .map_err(|e| e.to_string())?;
        self.file
            .seek(SeekFrom::Start(end))
            .map_err(|e| e.to_string())?;
        self.file.flush().map_err(|e| e.to_string())?;
        self.file.get_ref().sync_all().map_err(|e| e.to_string())?;
        Ok(self.samples_written)
    }
}

fn write_wav_header(
    file: &mut impl Write,
    data_size: u32,
    sample_rate: u32,
    channels: u16,
) -> std::io::Result<()> {
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_size).to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&channels.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&(sample_rate * u32::from(channels) * 2).to_le_bytes())?;
    file.write_all(&(channels * 2).to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_size.to_le_bytes())?;
    Ok(())
}

struct Mp3Writer {
    output: ffmpeg::format::context::Output,
    encoder: ffmpeg::codec::encoder::audio::Encoder,
    stream_index: usize,
    sample_rate: u32,
    frame_size: usize,
    pending: Vec<f32>,
    frame: ffmpeg::frame::Audio,
    packet: ffmpeg::Packet,
    pts: i64,
    samples_written: u64,
    cancel_countdown: usize,
}

impl Mp3Writer {
    fn create(path: &Path, sample_rate: u32) -> Result<Self, String> {
        ffmpeg::init().map_err(|e| format!("FFmpeg init failed: {e}"))?;
        let mut errors = Vec::new();
        for candidate in MP3_ENCODERS {
            match Self::open(path, candidate, sample_rate) {
                Ok(writer) => return Ok(writer),
                Err(error) => errors.push(format!("{candidate}: {error}")),
            }
        }
        Err(format!(
            "No MP3 encoder succeeded ({}); use WAV instead",
            errors.join("; ")
        ))
    }

    fn open(path: &Path, codec_name: &str, sample_rate: u32) -> Result<Self, String> {
        let codec = ffmpeg::codec::encoder::find_by_name(codec_name)
            .ok_or_else(|| format!("encoder {codec_name} is unavailable"))?;
        let mut output =
            ffmpeg::format::output(path).map_err(|e| format!("MP3 muxer unavailable: {e}"))?;
        let context = ffmpeg::codec::context::Context::new_with_codec(codec);
        let mut encoder = context.encoder().audio().map_err(|e| e.to_string())?;
        let sample_format = ffmpeg::format::Sample::I16(ffmpeg::format::sample::Type::Planar);
        let layout = ffmpeg::ChannelLayout::STEREO;
        encoder.set_bit_rate(MP3_BIT_RATE);
        encoder.set_rate(sample_rate as i32);
        encoder.set_format(sample_format);
        encoder.set_channel_layout(layout);
        encoder.set_time_base(ffmpeg::Rational::new(1, sample_rate as i32));
        let encoder = encoder
            .open_with(ffmpeg::Dictionary::new())
            .map_err(|e| e.to_string())?;
        let mut stream = output.add_stream(codec).map_err(|e| e.to_string())?;
        let index = stream.index();
        stream.set_time_base(ffmpeg::Rational::new(1, sample_rate as i32));
        stream.set_parameters(&encoder);
        output.write_header().map_err(|e| e.to_string())?;

        let frame_size = (encoder.frame_size() as usize).max(1);
        let mut frame = ffmpeg::frame::Audio::new(sample_format, frame_size, layout);
        frame.set_rate(sample_rate);
        Ok(Self {
            output,
            encoder,
            stream_index: index,
            sample_rate,
            frame_size,
            pending: Vec::with_capacity(frame_size * 2),
            frame,
            packet: ffmpeg::Packet::empty(),
            pts: 0,
            samples_written: 0,
            cancel_countdown: sample_rate as usize,
        })
    }

    fn write(
        &mut self,
        interleaved: &[f32],
        progress: &mut ExportProgress<'_>,
    ) -> Result<(), String> {
        self.pending.extend_from_slice(interleaved);
        while self.pending.len() >= self.frame_size * 2 {
            let frame_size = self.frame_size;
            self.encode_frames(frame_size)?;
        }

        self.cancel_countdown = self.cancel_countdown.saturating_sub(interleaved.len() / 2);
        if self.cancel_countdown == 0 {
            if progress.cancelled() {
                return Err(EXPORT_CANCELLED.to_string());
            }
            self.cancel_countdown = self.sample_rate as usize;
        }
        Ok(())
    }

    fn encode_frames(&mut self, frames: usize) -> Result<(), String> {
        let frames = frames.min(self.frame_size).min(self.pending.len() / 2);
        if frames == 0 {
            return Ok(());
        }
        for plane_index in [0usize, 1usize] {
            let plane = self.frame.data_mut(plane_index);
            plane.fill(0);
            for i in 0..frames {
                let sample = self.pending[i * 2 + plane_index].clamp(-1.0, 1.0);
                let pcm = (sample * 32767.0).round() as i16;
                plane[i * 2..i * 2 + 2].copy_from_slice(&pcm.to_le_bytes());
            }
        }
        self.frame.set_pts(Some(self.pts));
        self.encoder
            .send_frame(&self.frame)
            .map_err(|e| e.to_string())?;
        self.drain_packets()?;
        self.pending.drain(..frames * 2);
        self.pts += frames as i64;
        self.samples_written += frames as u64;
        Ok(())
    }

    fn drain_packets(&mut self) -> Result<(), String> {
        while self.encoder.receive_packet(&mut self.packet).is_ok() {
            self.packet.set_stream(self.stream_index);
            self.packet
                .write_interleaved(&mut self.output)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn finish(mut self, progress: &mut ExportProgress<'_>) -> Result<u64, String> {
        if progress.cancelled() {
            return Err(EXPORT_CANCELLED.to_string());
        }
        while self.pending.len() >= 2 {
            let remaining = (self.pending.len() / 2).min(self.frame_size);
            self.encode_frames(remaining)?;
        }
        self.pending.clear();
        self.encoder.send_eof().map_err(|e| e.to_string())?;
        self.drain_packets()?;
        self.output.write_trailer().map_err(|e| e.to_string())?;
        Ok(self.samples_written)
    }
}

fn render_full(
    renderer: &mut AudioRenderer,
    writer: &mut AudioFileWriter,
    total_samples: usize,
    project: &ProjectConfiguration,
    progress: &mut ExportProgress<'_>,
) -> Result<(), String> {
    let mut written_samples = 0usize;
    let mut chunk_index = 0u32;
    while written_samples < total_samples {
        let remaining = total_samples - written_samples;
        let count = AUDIO_EXPORT_CHUNK_SAMPLES.min(remaining);
        match renderer.render_frame_raw(count, project) {
            Some((samples, buffer)) => {
                writer.write(&buffer[..samples * 2], progress)?;
                written_samples += samples;
                if samples == 0 {
                    break;
                }
            }
            None => {
                let silence = vec![0.0; count * 2];
                writer.write(&silence, progress)?;
                written_samples += count;
            }
        }
        chunk_index += 1;
        if !progress.advance(chunk_index) {
            return Err(EXPORT_CANCELLED.to_string());
        }
    }
    Ok(())
}

fn render_windows(
    renderer: &mut AudioRenderer,
    writer: &mut AudioFileWriter,
    windows: &FrameWindows,
    project: &ProjectConfiguration,
    timing: Option<&crate::estimates::SampleTiming>,
    progress: &mut ExportProgress<'_>,
) -> Result<(), String> {
    let samples_per_frame = (AudioRenderer::SAMPLE_RATE / AUDIO_EXPORT_FPS) as usize;
    let mut chunk_index = 0u32;
    for window in windows.windows() {
        renderer.set_playhead(
            f64::from(window.start) / f64::from(AUDIO_EXPORT_FPS),
            project,
        );
        for frame in window.clone() {
            match renderer.render_frame_raw(samples_per_frame, project) {
                Some((samples, buffer)) => {
                    writer.write(&buffer[..samples * 2], progress)?;
                }
                None => {
                    let silence = vec![0.0; samples_per_frame * 2];
                    writer.write(&silence, progress)?;
                }
            }
            if let Some(timing) = timing {
                timing.record_frame(frame);
            }
            chunk_index += 1;
            if !progress.advance(chunk_index) {
                return Err(EXPORT_CANCELLED.to_string());
            }
        }
    }
    Ok(())
}

pub fn write_wav(
    path: &Path,
    interleaved: &[f32],
    sample_rate: u32,
    channels: u16,
) -> std::io::Result<()> {
    let mut writer =
        WavWriter::create(path, sample_rate, channels).map_err(std::io::Error::other)?;
    let mut allow = |_: u32| true;
    let mut progress = ExportProgress::new(&mut allow);
    writer
        .write(interleaved, &mut progress)
        .map_err(std::io::Error::other)?;
    writer
        .finish(&mut progress)
        .map_err(std::io::Error::other)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow_all(_: u32) -> bool {
        true
    }

    #[test]
    fn wav_header_is_valid_and_clamps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.wav");
        let interleaved = vec![0.0, 1.0, -1.0, 2.0, -2.0, 0.5];
        write_wav(&path, &interleaved, 48_000, 2).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"RIFF"));
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(bytes.len(), 44 + interleaved.len() * 2);
        let data_offset = 44;
        let first = i16::from_le_bytes([bytes[data_offset], bytes[data_offset + 1]]);
        assert_eq!(first, 0);
        let second = i16::from_le_bytes([bytes[data_offset + 2], bytes[data_offset + 3]]);
        assert_eq!(second, 32767);
        let third = i16::from_le_bytes([bytes[data_offset + 4], bytes[data_offset + 5]]);
        assert_eq!(third, -32767);
        let fourth = i16::from_le_bytes([bytes[data_offset + 6], bytes[data_offset + 7]]);
        assert_eq!(fourth, 32767);
    }

    #[test]
    fn wav_writer_streams_chunks_and_patches_the_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stream.wav");
        let mut writer = WavWriter::create(&path, 48_000, 2).unwrap();
        let mut allow = allow_all;
        let mut progress = ExportProgress::new(&mut allow);

        writer.write(&[0.25; 3_200], &mut progress).unwrap();
        writer.write(&[0.5, -0.5], &mut progress).unwrap();
        writer.finish(&mut progress).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 44 + 3_202 * 2);
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize,
            bytes.len() - 8
        );
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize,
            3_202 * 2
        );
    }

    #[test]
    fn wav_writer_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cancelled.wav");
        let mut writer = WavWriter::create(&path, 48_000, 2).unwrap();
        let mut calls = 0;
        let mut cancel = |_: u32| {
            calls += 1;
            calls < 2
        };
        let mut progress = ExportProgress::new(&mut cancel);

        writer.write(&[0.0; 3_200], &mut progress).unwrap();
        assert!(writer.write(&[0.0; 3_200], &mut progress).is_err());
    }

    #[test]
    fn wav_writer_rejects_oversized_payload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.wav");
        let mut writer = WavWriter::create(&path, 48_000, 2).unwrap();
        writer.data_bytes = MAX_WAV_DATA_BYTES;
        let mut allow = allow_all;
        let mut progress = ExportProgress::new(&mut allow);

        assert!(writer.write(&[0.0; 4], &mut progress).is_err());
    }

    #[test]
    fn staged_output_is_published_only_after_success() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("existing.wav");
        std::fs::write(&output, b"original").unwrap();

        let result = stage_audio_output(&output, |staged| {
            std::fs::write(staged, b"partial").unwrap();
            Err("failed".to_string())
        });
        assert_eq!(result, Err("failed".to_string()));
        assert_eq!(std::fs::read(&output).unwrap(), b"original");
        assert!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".cap-export-"))
        );

        let samples = stage_audio_output(&output, |staged| {
            std::fs::write(staged, b"replacement").unwrap();
            Ok(3)
        })
        .unwrap();
        assert_eq!(samples, 3);
        assert_eq!(std::fs::read(&output).unwrap(), b"replacement");
    }

    #[test]
    fn mp3_writer_stops_when_cancelled() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cancelled.mp3");
        let mut writer = Mp3Writer::create(&path, 48_000).unwrap();
        writer.cancel_countdown = 1;
        let mut cancel = |_: u32| false;
        let mut progress = ExportProgress::new(&mut cancel);

        assert!(writer.write(&[0.0, 0.0], &mut progress).is_err());
    }

    #[test]
    fn mp3_round_trip_encodes_stereo_audio() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.mp3");
        let sample_rate = AudioRenderer::SAMPLE_RATE;
        let frames = sample_rate as usize;
        let mut interleaved = Vec::with_capacity(frames * 2);
        for index in 0..frames {
            let seconds = index as f32 / sample_rate as f32;
            let sample = (seconds * 440.0 * std::f32::consts::TAU).sin() * 0.5;
            interleaved.push(sample);
            interleaved.push(-sample);
        }

        let mut writer = Mp3Writer::create(&path, sample_rate).unwrap();
        let mut allow = allow_all;
        let mut progress = ExportProgress::new(&mut allow);
        for chunk in interleaved.chunks(AUDIO_EXPORT_CHUNK_SAMPLES * 2) {
            writer.write(chunk, &mut progress).unwrap();
        }
        writer.finish(&mut progress).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert!(
            bytes.len() > 16_000,
            "encoded MP3 is suspiciously small: {} bytes",
            bytes.len()
        );

        let mut input = ffmpeg::format::input(&path).unwrap();
        let (stream_index, parameters) = {
            let stream = input.streams().best(ffmpeg::media::Type::Audio).unwrap();
            (stream.index(), stream.parameters().clone())
        };
        let context = ffmpeg::codec::context::Context::from_parameters(parameters).unwrap();
        let mut decoder = context.decoder().audio().unwrap();
        let mut decoded = 0usize;
        for (stream, packet) in input.packets() {
            if stream.index() != stream_index {
                continue;
            }
            decoder.send_packet(&packet).unwrap();
            let mut frame = ffmpeg::frame::Audio::empty();
            while decoder.receive_frame(&mut frame).is_ok() {
                decoded += frame.samples();
                frame = ffmpeg::frame::Audio::empty();
            }
        }
        decoder.send_eof().unwrap();
        let mut frame = ffmpeg::frame::Audio::empty();
        while decoder.receive_frame(&mut frame).is_ok() {
            decoded += frame.samples();
            frame = ffmpeg::frame::Audio::empty();
        }

        let error = (decoded as f64 - frames as f64).abs() / frames as f64;
        assert!(
            error < 0.05,
            "decoded {decoded} samples for {frames} source frames"
        );
    }
}
