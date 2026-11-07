use cap_editor::{AudioRenderer, get_audio_segments, load_music_tracks_uncached};
use cap_project::{AudioExportFormat, AudioSource, ProjectConfiguration};
use cap_rendering::FrameWindows;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tracing::info;

use crate::ExporterBase;

pub const AUDIO_EXPORT_CHUNK_SAMPLES: usize = 1600;
pub(crate) const AUDIO_EXPORT_FPS: u32 = 30;

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

        let mut rendered = Vec::new();
        if let Some(windows) = base.sample_windows.clone() {
            render_windows(
                &mut renderer,
                &mut rendered,
                &windows,
                &project,
                base.sample_timing.as_deref(),
                &mut on_progress,
            )?;
        } else {
            let total_samples = (duration * f64::from(AudioRenderer::SAMPLE_RATE)).round() as usize;
            render_full(
                &mut renderer,
                &mut rendered,
                total_samples,
                &project,
                &mut on_progress,
            )?;
        }

        info!(
            source = self.source.label(),
            format = self.audio_format.label(),
            samples = rendered.len() / 2,
            "Rendered audio for audio-only export"
        );

        match self.audio_format {
            AudioExportFormat::Wav => {
                write_wav(&output_path, &rendered, AudioRenderer::SAMPLE_RATE, 2)
                    .map_err(|e| format!("Failed to write WAV: {e}"))?;
            }
            AudioExportFormat::Mp3 => {
                write_mp3(&output_path, &rendered, AudioRenderer::SAMPLE_RATE, 2)
                    .map_err(|e| format!("Failed to write MP3: {e}"))?;
            }
        }
        Ok(output_path)
    }
}

fn render_full(
    renderer: &mut AudioRenderer,
    rendered: &mut Vec<f32>,
    total_samples: usize,
    project: &ProjectConfiguration,
    on_progress: &mut impl FnMut(u32) -> bool,
) -> Result<(), String> {
    let mut written_samples = 0usize;
    let mut chunk_index = 0u32;
    while written_samples < total_samples {
        let remaining = total_samples - written_samples;
        let count = AUDIO_EXPORT_CHUNK_SAMPLES.min(remaining);
        match renderer.render_frame_raw(count, project) {
            Some((samples, buffer)) => {
                rendered.extend_from_slice(&buffer[..samples * 2]);
                written_samples += samples;
                if samples == 0 {
                    break;
                }
            }
            None => {
                rendered.extend(std::iter::repeat_n(0.0, count * 2));
                written_samples += count;
            }
        }
        chunk_index += 1;
        if !on_progress(chunk_index) {
            return Err("Export cancelled".to_string());
        }
    }
    Ok(())
}

fn render_windows(
    renderer: &mut AudioRenderer,
    rendered: &mut Vec<f32>,
    windows: &FrameWindows,
    project: &ProjectConfiguration,
    timing: Option<&crate::estimates::SampleTiming>,
    on_progress: &mut impl FnMut(u32) -> bool,
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
                    rendered.extend_from_slice(&buffer[..samples * 2]);
                }
                None => rendered.extend(std::iter::repeat_n(0.0, samples_per_frame * 2)),
            }
            if let Some(timing) = timing {
                timing.record_frame(frame);
            }
            chunk_index += 1;
            if !on_progress(chunk_index) {
                return Err("Export cancelled".to_string());
            }
        }
    }
    Ok(())
}

pub fn write_wav(
    path: &std::path::Path,
    interleaved: &[f32],
    sample_rate: u32,
    channels: u16,
) -> std::io::Result<()> {
    let frames = interleaved.len() / channels as usize;
    let data_size = frames as u32 * u32::from(channels) * 2;
    let mut file = std::fs::File::create(path)?;
    use std::io::Write;
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
    for &sample in interleaved {
        let clamped = sample.clamp(-1.0, 1.0);
        let pcm = (clamped * 32767.0).round() as i16;
        file.write_all(&pcm.to_le_bytes())?;
    }
    file.sync_all()?;
    Ok(())
}

fn write_mp3(
    path: &std::path::Path,
    interleaved: &[f32],
    sample_rate: u32,
    channels: u16,
) -> std::result::Result<(), String> {
    if channels != 2 {
        return Err("MP3 export expects stereo audio".to_string());
    }
    ffmpeg::init().map_err(|e| format!("FFmpeg init failed: {e}"))?;
    let mut errors = Vec::new();
    for candidate in ["libmp3lame", "libshine", "mp3_mf", "mp3"] {
        match write_mp3_with_encoder(path, candidate, interleaved, sample_rate) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(format!("{candidate}: {error}")),
        }
        let _ = std::fs::remove_file(path);
    }
    Err(format!(
        "No MP3 encoder succeeded ({}); use WAV instead",
        errors.join("; ")
    ))
}

fn write_mp3_with_encoder(
    path: &std::path::Path,
    codec_name: &str,
    interleaved: &[f32],
    sample_rate: u32,
) -> std::result::Result<(), String> {
    let codec = ffmpeg::codec::encoder::find_by_name(codec_name)
        .ok_or_else(|| format!("encoder {codec_name} is unavailable"))?;
    let mut output =
        ffmpeg::format::output(path).map_err(|e| format!("MP3 muxer unavailable: {e}"))?;
    let context = ffmpeg::codec::context::Context::new_with_codec(codec);
    let mut encoder = context.encoder().audio().map_err(|e| e.to_string())?;
    let sample_format = ffmpeg::format::Sample::I16(ffmpeg::format::sample::Type::Planar);
    let layout = ffmpeg::ChannelLayout::STEREO;
    encoder.set_bit_rate(192_000);
    encoder.set_rate(sample_rate as i32);
    encoder.set_format(sample_format);
    encoder.set_channel_layout(layout);
    encoder.set_time_base(ffmpeg::Rational::new(1, sample_rate as i32));
    let mut encoder = encoder
        .open_with(ffmpeg::Dictionary::new())
        .map_err(|e| e.to_string())?;
    let mut stream = output.add_stream(codec).map_err(|e| e.to_string())?;
    let index = stream.index();
    stream.set_time_base(ffmpeg::Rational::new(1, sample_rate as i32));
    stream.set_parameters(&encoder);
    output.write_header().map_err(|e| e.to_string())?;

    let frame_size = (encoder.frame_size() as usize).max(1);
    let frames_total = interleaved.len() / 2;
    let mut frame = ffmpeg::frame::Audio::new(sample_format, frame_size, layout);
    frame.set_rate(sample_rate);
    let mut packet = ffmpeg::Packet::empty();
    let mut frame_index = 0usize;
    let mut pts = 0i64;
    while frame_index < frames_total {
        let count = frame_size.min(frames_total - frame_index);
        for plane_index in 0..2 {
            let plane = frame.data_mut(plane_index);
            plane.fill(0);
            for i in 0..count {
                let sample = interleaved[(frame_index + i) * 2 + plane_index].clamp(-1.0, 1.0);
                let pcm = (sample * 32767.0).round() as i16;
                plane[i * 2..i * 2 + 2].copy_from_slice(&pcm.to_le_bytes());
            }
        }
        frame.set_pts(Some(pts));
        encoder.send_frame(&frame).map_err(|e| e.to_string())?;
        while encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(index);
            packet
                .write_interleaved(&mut output)
                .map_err(|e| e.to_string())?;
        }
        pts += frame_size as i64;
        frame_index += count;
    }
    encoder.send_eof().map_err(|e| e.to_string())?;
    while encoder.receive_packet(&mut packet).is_ok() {
        packet.set_stream(index);
        packet
            .write_interleaved(&mut output)
            .map_err(|e| e.to_string())?;
    }
    output.write_trailer().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

        write_mp3(&path, &interleaved, sample_rate, 2).unwrap();

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
