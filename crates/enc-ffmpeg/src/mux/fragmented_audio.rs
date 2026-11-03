use cap_media_info::AudioInfo;
use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use super::write_behind::{AUDIO_BUDGET_BYTES, MuxSink, MuxTarget};
use crate::audio::aac::{AACEncoder, AACEncoderError};

pub struct FragmentedAudioFile {
    encoder: AACEncoder,
    output: MuxSink<AudioOutput>,
    finished: bool,
    has_frames: bool,
}

struct AudioOutput(format::context::Output);

impl MuxTarget for AudioOutput {
    fn output(&self) -> &format::context::Output {
        &self.0
    }

    fn output_mut(&mut self) -> &mut format::context::Output {
        &mut self.0
    }
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Encoder: {0}")]
    Encoder(#[from] AACEncoderError),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
}

fn option_result(value: i32) -> Result<(), ffmpeg::Error> {
    if value < 0 {
        Err(ffmpeg::Error::from(value))
    } else {
        Ok(())
    }
}

fn configure_fragmentation(output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
    // Audio-only streams cannot trigger frag_keyframe. Fragment cuts and AVIO
    // flushes are separate requirements for exposing bytes before finalization.
    unsafe {
        let context = output.as_mut_ptr();
        option_result(ffmpeg::ffi::av_opt_set(
            (*context).priv_data,
            c"movflags".as_ptr(),
            c"frag_keyframe+empty_moov+default_base_moof+skip_trailer".as_ptr(),
            0,
        ))?;
        option_result(ffmpeg::ffi::av_opt_set_int(
            (*context).priv_data,
            c"frag_duration".as_ptr(),
            2_000_000,
            0,
        ))?;
        option_result(ffmpeg::ffi::av_opt_set_int(
            context.cast(),
            c"flush_packets".as_ptr(),
            1,
            0,
        ))
    }
}

impl FragmentedAudioFile {
    pub fn init(output_path: PathBuf, audio_config: AudioInfo) -> Result<Self, InitError> {
        Self::init_inner(output_path, audio_config, AACEncoder::init_for_recording)
    }

    #[doc(hidden)]
    pub fn init_with_encoder_preference(
        output_path: PathBuf,
        audio_config: AudioInfo,
        prefer_audiotoolbox: bool,
    ) -> Result<Self, InitError> {
        Self::init_inner(output_path, audio_config, |config, output| {
            AACEncoder::init_for_recording_with(prefer_audiotoolbox, config, output)
        })
    }

    fn init_inner(
        mut output_path: PathBuf,
        audio_config: AudioInfo,
        encoder_init: impl FnOnce(
            AudioInfo,
            &mut format::context::Output,
        ) -> Result<AACEncoder, AACEncoderError>,
    ) -> Result<Self, InitError> {
        output_path.set_extension("m4a");

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut output = format::output_as(&output_path, "mp4")?;

        configure_fragmentation(&mut output)?;

        let encoder = encoder_init(audio_config, &mut output)?;

        output.write_header()?;

        Ok(Self {
            encoder,
            output: MuxSink::Direct(AudioOutput(output)),
            finished: false,
            has_frames: false,
        })
    }

    /// Hands encoded packets to a dedicated writer thread so a stalled
    /// output volume no longer blocks the caller (an async runtime worker in
    /// the recording pipeline). Bytes on disk and their order are unchanged.
    pub fn enable_write_behind(&mut self) -> std::io::Result<()> {
        self.output.enable_write_behind("audio", AUDIO_BUDGET_BYTES)
    }

    pub fn encoder(&self) -> &AACEncoder {
        &self.encoder
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
    ) -> Result<(), ffmpeg::Error> {
        if self.finished && self.output.is_write_behind() {
            return Err(ffmpeg::Error::Exit);
        }
        self.has_frames = true;
        self.encoder
            .send_frame_to(frame, timestamp, &mut self.output)
    }

    pub fn is_write_behind(&self) -> bool {
        self.output.is_write_behind()
    }

    pub fn finish(&mut self) -> Result<Result<(), ffmpeg::Error>, FinishError> {
        self.finish_with_timestamp(Duration::ZERO)
    }

    pub fn finish_with_timestamp(
        &mut self,
        _: Duration,
    ) -> Result<Result<(), ffmpeg::Error>, FinishError> {
        if self.finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.finished = true;

        let has_frames = self.has_frames;
        let encoder = &mut self.encoder;
        let (flush_result, trailer_result) = self
            .output
            .finish(
                |output| {
                    if has_frames {
                        encoder.flush_to(output)
                    } else {
                        Ok(())
                    }
                },
                |output: &mut AudioOutput, flush_result| (flush_result, output.0.write_trailer()),
            )
            .map_err(|stalled| FinishError::WriteTrailerFailed(stalled.into()))?;
        finish_result(flush_result, trailer_result)
    }
}

fn finish_result(
    flush_result: Result<(), ffmpeg::Error>,
    trailer_result: Result<(), ffmpeg::Error>,
) -> Result<Result<(), ffmpeg::Error>, FinishError> {
    trailer_result.map_err(FinishError::WriteTrailerFailed)?;
    Ok(flush_result)
}

impl Drop for FragmentedAudioFile {
    fn drop(&mut self) {
        let _ = self.finish_with_timestamp(Duration::ZERO);
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    use ffmpeg::{ChannelLayout, format::Sample, format::sample::Type};
    use std::ffi::CStr;

    fn value(output: &mut format::context::Output, name: &CStr, private: bool) -> i64 {
        unsafe {
            let context = output.as_mut_ptr();
            let target = if private {
                (*context).priv_data
            } else {
                context.cast()
            };
            let mut result = 0;
            assert_eq!(
                ffmpeg::ffi::av_opt_get_int(target, name.as_ptr(), 0, &mut result),
                0
            );
            result
        }
    }

    fn queue_tone(output: &mut FragmentedAudioFile, blocks: i64) {
        for block in 0..blocks {
            let mut frame =
                ffmpeg::frame::Audio::new(Sample::F32(Type::Packed), 1024, ChannelLayout::MONO);
            frame.set_rate(48_000);
            for (index, value) in frame.data_mut(0)[..1024 * 4]
                .chunks_exact_mut(4)
                .enumerate()
            {
                let position = (block * 1024) as f32 + index as f32;
                let sample = 0.125 * (position * 880.0 * std::f32::consts::TAU / 48_000.0).sin();
                value.copy_from_slice(&sample.to_ne_bytes());
            }
            output
                .queue_frame(
                    frame,
                    Duration::from_secs_f64(block as f64 * 1024.0 / 48_000.0),
                )
                .unwrap();
        }
    }

    #[test]
    fn fragmented_audio_sets_both_publication_options() {
        let directory = tempfile::tempdir().unwrap();
        let mut output = format::output_as(&directory.path().join("options.m4a"), "mp4").unwrap();
        configure_fragmentation(&mut output).unwrap();
        assert_eq!(value(&mut output, c"frag_duration", true), 2_000_000);
        assert_eq!(value(&mut output, c"flush_packets", false), 1);
        assert_ne!(value(&mut output, c"movflags", true), 0);
    }

    #[test]
    fn fragmented_audio_rejects_unsupported_mux_options() {
        let directory = tempfile::tempdir().unwrap();
        let mut output = format::output_as(&directory.path().join("wrong.ogg"), "ogg").unwrap();
        assert!(configure_fragmentation(&mut output).is_err());
    }

    #[test]
    fn fragmented_audio_option_errors_are_not_ignored() {
        assert!(option_result(0).is_ok());
        assert!(option_result(-22).is_err());
        assert!(option_result(ffmpeg::ffi::AVERROR_OPTION_NOT_FOUND).is_err());
    }

    #[test]
    fn fragmented_audio_exposes_packets_before_finish() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("before-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        queue_tone(&mut output, 120);
        let mut input = format::input(&path).unwrap();
        assert!(input.packets().next().is_some());
        drop(input);
        output.finish().unwrap().unwrap();
    }

    #[test]
    fn write_behind_audio_matches_inline_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let inline_path = directory.path().join("inline.m4a");
        let mut inline = FragmentedAudioFile::init(inline_path.clone(), info).unwrap();
        queue_tone(&mut inline, 300);
        inline.finish().unwrap().unwrap();

        let behind_path = directory.path().join("behind.m4a");
        let mut behind = FragmentedAudioFile::init(behind_path.clone(), info).unwrap();
        behind.enable_write_behind().unwrap();
        queue_tone(&mut behind, 300);
        behind.output.drain();
        let mut input = format::input(&behind_path).unwrap();
        assert!(input.packets().next().is_some());
        drop(input);
        behind.finish().unwrap().unwrap();

        assert_eq!(
            std::fs::read(&inline_path).unwrap(),
            std::fs::read(&behind_path).unwrap()
        );
    }

    #[test]
    fn write_behind_audio_rejects_frames_after_finish() {
        let directory = tempfile::tempdir().unwrap();
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output =
            FragmentedAudioFile::init(directory.path().join("finished.m4a"), info).unwrap();
        output.enable_write_behind().unwrap();
        queue_tone(&mut output, 10);
        output.finish().unwrap().unwrap();
        let frame =
            ffmpeg::frame::Audio::new(Sample::F32(Type::Packed), 1024, ffmpeg::ChannelLayout::MONO);
        assert_eq!(
            output.queue_frame(frame, Duration::from_secs(1)),
            Err(ffmpeg::Error::Exit)
        );
    }

    #[test]
    fn short_fragmented_audio_remains_readable_after_finish() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("short.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        queue_tone(&mut output, 10);
        output.finish().unwrap().unwrap();
        let mut input = format::input(&path).unwrap();
        assert!(input.packets().next().is_some());
    }

    #[test]
    fn fragmented_audio_terminal_success_requires_both_stages() {
        assert!(matches!(finish_result(Ok(()), Ok(())), Ok(Ok(()))));
    }

    #[test]
    fn fragmented_audio_preserves_encoder_flush_failure() {
        assert!(matches!(
            finish_result(Err(ffmpeg::Error::InvalidData), Ok(())),
            Ok(Err(ffmpeg::Error::InvalidData))
        ));
    }

    #[test]
    fn fragmented_audio_reports_trailer_failure() {
        assert!(matches!(
            finish_result(Ok(()), Err(ffmpeg::Error::InvalidData)),
            Err(FinishError::WriteTrailerFailed(ffmpeg::Error::InvalidData))
        ));
    }

    #[test]
    fn fragmented_audio_reports_trailer_failure_after_failed_flush() {
        assert!(matches!(
            finish_result(Err(ffmpeg::Error::InvalidData), Err(ffmpeg::Error::Bug)),
            Err(FinishError::WriteTrailerFailed(ffmpeg::Error::Bug))
        ));
    }

    #[test]
    fn fragmented_audio_does_not_assume_reported_eof_is_benign() {
        assert!(matches!(
            finish_result(Err(ffmpeg::Error::Eof), Ok(())),
            Ok(Err(ffmpeg::Error::Eof))
        ));
        assert!(matches!(
            finish_result(Ok(()), Err(ffmpeg::Error::Eof)),
            Err(FinishError::WriteTrailerFailed(ffmpeg::Error::Eof))
        ));
    }

    #[test]
    fn fragmented_audio_empty_track_without_io_error_can_finish() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path, info).unwrap();
        output.finish().unwrap().unwrap();
    }

    fn set_output_error(output: &mut FragmentedAudioFile) {
        unsafe {
            let context = output.output.with_target(|output| output.0.as_mut_ptr());
            assert!(!(*context).pb.is_null());
            (*(*context).pb).error = ffmpeg::Error::Other {
                errno: ffmpeg::error::EIO,
            }
            .into();
        }
    }

    #[test]
    fn fragmented_audio_sticky_io_error_cannot_report_terminal_success() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("failed-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        queue_tone(&mut output, 120);
        let prefix = std::fs::read(&path).unwrap();
        assert!(!prefix.is_empty());
        set_output_error(&mut output);
        assert!(!matches!(output.finish(), Ok(Ok(()))));
        assert!(matches!(output.finish(), Err(FinishError::AlreadyFinished)));
        drop(output);
        assert!(std::fs::read(&path).unwrap().starts_with(&prefix));
    }

    #[test]
    fn fragmented_audio_empty_track_trailer_error_is_reported() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty-failed-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        set_output_error(&mut output);
        assert!(matches!(
            output.finish(),
            Err(FinishError::WriteTrailerFailed(_))
        ));
        drop(output);
        assert!(path.exists());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod recording_encoder_tests {
    use super::*;
    use ffmpeg::{
        Rescale,
        codec::context,
        format::{Sample, sample::Type},
    };
    use std::path::Path;

    const RATE: u32 = 48_000;
    const FRAME_SAMPLES: usize = 960;
    const CLICK_SAMPLES: usize = 1;
    const FFMPEG_AAC_PRIMING: usize = 1_024;

    fn timeline_with_clicks(total: usize, clicks: &[usize]) -> Vec<f32> {
        let mut timeline = vec![0.0_f32; total];
        for &click in clicks {
            for sample in timeline
                .iter_mut()
                .take((click + CLICK_SAMPLES).min(total))
                .skip(click)
            {
                *sample = 0.9;
            }
        }
        timeline
    }

    fn encode_recording(
        prefer_audiotoolbox: bool,
        channels: u16,
        timeline: &[f32],
        send_ranges: &[(usize, usize)],
    ) -> (Vec<f32>, i64, u64) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), RATE, channels);
        let mut file = FragmentedAudioFile::init_with_encoder_preference(
            path.clone(),
            info,
            prefer_audiotoolbox,
        )
        .unwrap();
        assert_eq!(
            file.encoder().codec_name().as_deref(),
            Some(if prefer_audiotoolbox { "aac_at" } else { "aac" }),
            "requested AudioToolbox={prefer_audiotoolbox}, but opened {:?}",
            file.encoder().codec_name()
        );

        for &(start, len) in send_ranges {
            let mut position = start;
            while position < start + len {
                let samples = FRAME_SAMPLES.min(start + len - position);
                let mut frame =
                    frame::Audio::new(Sample::F32(Type::Packed), samples, info.channel_layout());
                frame.set_rate(RATE);
                for (index, bytes) in frame.data_mut(0)
                    [..samples * usize::from(channels) * size_of::<f32>()]
                    .chunks_exact_mut(size_of::<f32>())
                    .enumerate()
                {
                    bytes.copy_from_slice(
                        &timeline[position + index / usize::from(channels)].to_le_bytes(),
                    );
                }
                file.queue_frame(
                    frame,
                    Duration::from_secs_f64(position as f64 / f64::from(RATE)),
                )
                .unwrap();
                position += samples;
            }
        }

        file.finish().unwrap().unwrap();
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let (samples, track_end) = decode_channel_zero(&path);
        (samples, track_end, bytes)
    }

    fn encode_recording_variable(
        prefer_audiotoolbox: bool,
        channels: u16,
        timeline: &[f32],
        frame_sizes: &[usize],
    ) -> (Vec<f32>, i64, u64) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), RATE, channels);
        let mut file = FragmentedAudioFile::init_with_encoder_preference(
            path.clone(),
            info,
            prefer_audiotoolbox,
        )
        .unwrap();
        assert_eq!(
            file.encoder().codec_name().as_deref(),
            Some(if prefer_audiotoolbox { "aac_at" } else { "aac" }),
            "requested AudioToolbox={prefer_audiotoolbox}, but opened {:?}",
            file.encoder().codec_name()
        );

        let mut position = 0;
        let mut frame_index = 0;
        while position < timeline.len() {
            let samples =
                frame_sizes[frame_index % frame_sizes.len()].min(timeline.len() - position);
            let mut frame =
                frame::Audio::new(Sample::F32(Type::Packed), samples, info.channel_layout());
            frame.set_rate(RATE);
            for (index, bytes) in frame.data_mut(0)
                [..samples * usize::from(channels) * size_of::<f32>()]
                .chunks_exact_mut(size_of::<f32>())
                .enumerate()
            {
                bytes.copy_from_slice(
                    &timeline[position + index / usize::from(channels)].to_le_bytes(),
                );
            }
            file.queue_frame(
                frame,
                Duration::from_nanos(position as u64 * 1_000_000_000 / u64::from(RATE)),
            )
            .unwrap();
            position += samples;
            frame_index += 1;
        }

        file.finish().unwrap().unwrap();
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let (samples, track_end) = decode_channel_zero(&path);
        (samples, track_end, bytes)
    }

    fn decode_channel_zero(path: &Path) -> (Vec<f32>, i64) {
        let mut input = format::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Audio).unwrap();
        let stream_index = stream.index();
        let time_base = stream.time_base();
        let mut decoder = context::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        let mut decoded = frame::Audio::empty();
        let mut samples = Vec::new();
        let mut track_end = i64::MIN;

        for (stream, packet) in input.packets() {
            if stream.index() != stream_index {
                continue;
            }
            if let Some(pts) = packet.pts() {
                track_end =
                    track_end.max((pts + packet.duration()).rescale(time_base, (1, 48_000)));
            }
            decoder.send_packet(&packet).unwrap();
            while decoder.receive_frame(&mut decoded).is_ok() {
                assert_eq!(decoded.format(), Sample::F32(Type::Planar));
                samples.extend_from_slice(decoded.plane::<f32>(0));
            }
        }
        decoder.send_eof().unwrap();
        while decoder.receive_frame(&mut decoded).is_ok() {
            assert_eq!(decoded.format(), Sample::F32(Type::Planar));
            samples.extend_from_slice(decoded.plane::<f32>(0));
        }
        (samples, track_end)
    }

    fn click_index(samples: &[f32]) -> usize {
        samples
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.abs().partial_cmp(&b.abs()).unwrap())
            .map(|(index, _)| index)
            .expect("no decoded samples")
    }

    fn click_positions(samples: &[f32]) -> Vec<usize> {
        let mut positions = Vec::new();
        let mut index = 0;
        while index < samples.len() {
            if samples[index].abs() > 0.2 {
                let window_end = (index + 512).min(samples.len());
                positions.push(index + click_index(&samples[index..window_end]));
                index = window_end;
            } else {
                index += 1;
            }
        }
        positions
    }

    #[test]
    fn recording_audio_click_decodes_at_the_same_sample_with_both_encoders() {
        for channels in [1u16, 2] {
            let timeline = timeline_with_clicks(96_000, &[24_000]);
            let ranges = [(0usize, 96_000usize)];

            let (ffmpeg_samples, _, _) = encode_recording(false, channels, &timeline, &ranges);
            let ffmpeg_click = click_index(&ffmpeg_samples);
            assert_eq!(
                ffmpeg_click,
                24_000 + FFMPEG_AAC_PRIMING,
                "FFmpeg aac decoded the click at {ffmpeg_click} for {channels}ch"
            );

            let (at_samples, _, _) = encode_recording(true, channels, &timeline, &ranges);
            let at_click = click_index(&at_samples);
            assert!(
                at_click.abs_diff(ffmpeg_click) <= 4,
                "AudioToolbox decoded the click at {at_click}, FFmpeg at {ffmpeg_click} ({channels}ch)"
            );
        }
    }

    #[test]
    fn recording_audio_silence_filled_gap_decodes_the_same_with_both_encoders() {
        let frame_sizes = [441, 960, 1000, 512, 4800];
        for channels in [1u16, 2] {
            let timeline = timeline_with_clicks(168_000, &[24_000, 120_000]);

            let (ffmpeg_samples, ffmpeg_end, _) =
                encode_recording_variable(false, channels, &timeline, &frame_sizes);
            let (at_samples, at_end, _) =
                encode_recording_variable(true, channels, &timeline, &frame_sizes);

            let ffmpeg_clicks = click_positions(&ffmpeg_samples);
            let at_clicks = click_positions(&at_samples);
            assert_eq!(ffmpeg_clicks.len(), 2, "FFmpeg clicks: {ffmpeg_clicks:?}");
            assert_eq!(at_clicks.len(), 2, "AudioToolbox clicks: {at_clicks:?}");
            for (index, (&ffmpeg_click, &at_click)) in
                ffmpeg_clicks.iter().zip(&at_clicks).enumerate()
            {
                let expected = [24_000usize, 120_000][index] + FFMPEG_AAC_PRIMING;
                assert_eq!(
                    ffmpeg_click, expected,
                    "FFmpeg aac decoded click {index} at {ffmpeg_click}, expected {expected} ({channels}ch)"
                );
                assert!(
                    at_click.abs_diff(ffmpeg_click) <= 4,
                    "click {index}: AudioToolbox {at_click} vs FFmpeg {ffmpeg_click} ({channels}ch)"
                );
            }
            assert!(
                at_samples.len().abs_diff(ffmpeg_samples.len()) <= 4,
                "decoded {} vs {} samples ({channels}ch)",
                at_samples.len(),
                ffmpeg_samples.len()
            );
            assert!(
                at_end.abs_diff(ffmpeg_end) <= 1,
                "track end {at_end} vs {ffmpeg_end} ({channels}ch)"
            );
        }
    }

    #[test]
    fn recording_audio_track_ends_where_the_ffmpeg_track_ends() {
        let timeline = vec![0.0_f32; 47_123];
        let ranges = [(0usize, 47_123usize)];

        let (_, ffmpeg_end, _) = encode_recording(false, 1, &timeline, &ranges);
        let (_, at_end, _) = encode_recording(true, 1, &timeline, &ranges);

        assert!(
            at_end.abs_diff(ffmpeg_end) <= 1,
            "track end {at_end} vs {ffmpeg_end}"
        );
    }

    #[test]
    fn recording_audio_uses_audiotoolbox_on_macos() {
        if std::env::var_os("CAP_RECORDING_FFMPEG_AAC").is_some_and(|v| !v.is_empty()) {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), RATE, 1);
        let file = FragmentedAudioFile::init(directory.path().join("audio.m4a"), info).unwrap();
        assert_eq!(file.encoder().codec_name().as_deref(), Some("aac_at"));
    }

    #[test]
    fn recording_audio_silence_stays_small() {
        let timeline = vec![0.0_f32; 480_000];
        let ranges = [(0usize, 480_000usize)];
        let (_, _, bytes) = encode_recording(true, 2, &timeline, &ranges);
        assert!(
            bytes < 64 * 1024,
            "10s of stereo silence took {bytes} bytes"
        );
    }
}
