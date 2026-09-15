use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
    frame::Audio as FFAudio,
    software::resampling,
};
use std::{ops::Range, path::Path};

use crate::cast_bytes_to_f32_slice;

// F32 Packed 48kHz audio
pub struct AudioData {
    samples: Vec<f32>,
    channels: u16,
    source_start_sample: usize,
    covered_source_end_sample: usize,
}

impl AudioData {
    pub const SAMPLE_FORMAT: avformat::Sample =
        avformat::Sample::F32(avformat::sample::Type::Packed);
    pub const SAMPLE_RATE: u32 = 48_000;

    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, String> {
        Self::decode(path.as_ref(), None, true)
    }

    pub fn from_file_range(
        path: impl AsRef<Path>,
        source_start_sample: usize,
        source_end_sample: usize,
    ) -> Result<Self, String> {
        Self::decode(
            path.as_ref(),
            Some(source_start_sample..source_end_sample.max(source_start_sample)),
            true,
        )
    }

    fn decode(path: &Path, range: Option<Range<usize>>, allow_seek: bool) -> Result<Self, String> {
        let mut input_ctx =
            ffmpeg::format::input(&path).map_err(|e| format!("Input Open / {e}"))?;
        let input_stream = input_ctx
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or_else(|| "No Stream".to_string())?;

        let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters())
            .map_err(|e| format!("AudioData Parameters / {e}"))?;
        let mut decoder = decoder_ctx
            .decoder()
            .audio()
            .map_err(|e| format!("Set Parameters / {e}"))?;

        let source_channels = decoder.channels().max(1);
        if decoder.channel_layout().is_empty() {
            decoder.set_channel_layout(ChannelLayout::default(source_channels as i32));
        }
        let stream_time_base = input_stream.time_base();
        decoder.set_packet_time_base(stream_time_base);

        let target_channels = target_channels_for_source(source_channels);
        let target_channel_layout = ChannelLayout::default(target_channels as i32);
        let mut options = ffmpeg::Dictionary::new();
        options.set("filter_size", "128");
        options.set("cutoff", "0.97");

        let mut resampler = resampling::Context::get_with(
            decoder.format(),
            decoder.channel_layout(),
            decoder.rate(),
            AudioData::SAMPLE_FORMAT,
            target_channel_layout,
            AudioData::SAMPLE_RATE,
            options,
        )
        .map_err(|e| format!("Resampler / {e}"))?;

        let index = input_stream.index();
        let stream_start_time = input_stream.start_time();
        let stream_start_time = if stream_start_time == i64::MIN {
            0
        } else {
            stream_start_time
        };
        let stream_time_base = f64::from(stream_time_base);
        let source_start_sample = range.as_ref().map_or(0, |window| window.start);
        let covered_source_end_sample = range.as_ref().map_or(usize::MAX, |window| window.end);
        let mut sought = false;

        if allow_seek && source_start_sample > AudioData::SAMPLE_RATE as usize * 2 {
            let seek_sample =
                source_start_sample.saturating_sub(AudioData::SAMPLE_RATE as usize * 2);
            let seek_seconds = seek_sample as f64 / AudioData::SAMPLE_RATE as f64
                + stream_start_time as f64 * stream_time_base;
            let seek_timestamp = (seek_seconds * 1_000_000.0).round() as i64;
            sought = input_ctx.seek(seek_timestamp, ..seek_timestamp).is_ok();
        }

        let mut decoded_frame = ffmpeg::frame::Audio::empty();
        let mut resampler_output = ResamplerOutput::new();
        let mut samples = Vec::new();
        let mut resampled_samples = Vec::new();
        let mut next_source_sample = if sought { None } else { Some(0usize) };
        let mut complete = source_start_sample == covered_source_end_sample;

        'packets: for (stream, packet) in input_ctx.packets() {
            if complete {
                break;
            }
            if stream.index() != index {
                continue;
            }

            decoder
                .send_packet(&packet)
                .map_err(|e| format!("Send Packet / {e}"))?;

            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                if range.is_none() {
                    run_resampler(
                        &mut resampler,
                        &decoded_frame,
                        &mut resampler_output,
                        &mut samples,
                    )?;
                    continue;
                }

                if next_source_sample.is_none() {
                    let Some(timestamp) = decoded_frame.timestamp().or_else(|| decoded_frame.pts())
                    else {
                        return Self::decode(path, range, false);
                    };
                    let position = ((timestamp.saturating_sub(stream_start_time)) as f64
                        * stream_time_base
                        * AudioData::SAMPLE_RATE as f64)
                        .round()
                        .max(0.0) as usize;
                    if position > source_start_sample {
                        return Self::decode(path, range, false);
                    }
                    next_source_sample = Some(position);
                }

                resampled_samples.clear();
                run_resampler(
                    &mut resampler,
                    &decoded_frame,
                    &mut resampler_output,
                    &mut resampled_samples,
                )?;
                complete = append_sample_window(
                    &mut samples,
                    &resampled_samples,
                    &mut next_source_sample,
                    target_channels,
                    source_start_sample,
                    covered_source_end_sample,
                );
                if complete {
                    break 'packets;
                }
            }
        }

        if !complete {
            decoder.send_eof().map_err(|e| format!("Send EOF / {e}"))?;

            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                if range.is_none() {
                    run_resampler(
                        &mut resampler,
                        &decoded_frame,
                        &mut resampler_output,
                        &mut samples,
                    )?;
                    continue;
                }

                resampled_samples.clear();
                run_resampler(
                    &mut resampler,
                    &decoded_frame,
                    &mut resampler_output,
                    &mut resampled_samples,
                )?;
                complete = append_sample_window(
                    &mut samples,
                    &resampled_samples,
                    &mut next_source_sample,
                    target_channels,
                    source_start_sample,
                    covered_source_end_sample,
                );
                if complete {
                    break;
                }
            }

            if !complete {
                if range.is_some() {
                    resampled_samples.clear();
                    flush_resampler(
                        &mut resampler,
                        &mut resampler_output,
                        &mut resampled_samples,
                    )?;
                    append_sample_window(
                        &mut samples,
                        &resampled_samples,
                        &mut next_source_sample,
                        target_channels,
                        source_start_sample,
                        covered_source_end_sample,
                    );
                } else {
                    flush_resampler(&mut resampler, &mut resampler_output, &mut samples)?;
                }
            }
        }

        Ok(AudioData {
            samples,
            channels: target_channels,
            source_start_sample,
            covered_source_end_sample,
        })
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn samples(&self) -> &[f32] {
        self.samples.as_slice()
    }

    pub fn sample_count(&self) -> usize {
        self.samples.len() / self.channels as usize
    }

    pub fn source_start_sample(&self) -> usize {
        self.source_start_sample
    }

    pub fn covers_source_range(
        &self,
        source_start_sample: usize,
        source_end_sample: usize,
    ) -> bool {
        source_start_sample >= self.source_start_sample
            && source_end_sample <= self.covered_source_end_sample
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn from_raw_f32(samples: Vec<f32>, channels: u16) -> Self {
        Self {
            samples,
            channels,
            source_start_sample: 0,
            covered_source_end_sample: usize::MAX,
        }
    }
}

fn append_sample_window(
    samples: &mut Vec<f32>,
    resampled: &[f32],
    next_source_sample: &mut Option<usize>,
    channels: u16,
    source_start_sample: usize,
    covered_source_end_sample: usize,
) -> bool {
    let channels = channels as usize;
    let frame_start = next_source_sample.unwrap_or(0);
    let frame_end = frame_start.saturating_add(resampled.len() / channels);
    let overlap_start = frame_start.max(source_start_sample);
    let overlap_end = frame_end.min(covered_source_end_sample);

    if overlap_start < overlap_end {
        let start = (overlap_start - frame_start) * channels;
        let end = (overlap_end - frame_start) * channels;
        samples.extend_from_slice(&resampled[start..end]);
    }

    *next_source_sample = Some(frame_end);
    frame_end >= covered_source_end_sample
}

fn target_channels_for_source(channels: u16) -> u16 {
    if channels <= 1 { 1 } else { 2 }
}

pub(crate) struct ResamplerOutput {
    frame: FFAudio,
    capacity: usize,
}

impl ResamplerOutput {
    pub(crate) fn new() -> Self {
        Self {
            frame: FFAudio::empty(),
            capacity: 0,
        }
    }

    pub(crate) fn prepare(
        &mut self,
        resampler: &resampling::Context,
        capacity: usize,
    ) -> &mut FFAudio {
        if capacity > self.capacity {
            let target = resampler.output();
            self.frame = FFAudio::new(target.format, capacity, target.channel_layout);
            self.capacity = capacity;
        }
        self.frame.set_samples(capacity);
        &mut self.frame
    }

    pub(crate) fn run(
        &mut self,
        resampler: &mut resampling::Context,
        decoded_frame: &FFAudio,
    ) -> Result<(), String> {
        let capacity = resample_capacity(resampler, decoded_frame.samples());
        let frame = self.prepare(resampler, capacity);
        resampler
            .run(decoded_frame, frame)
            .map_err(|error| format!("Run Resampler / {error}"))
            .map(|_| ())
    }

    pub(crate) fn samples(&self) -> Result<&[f32], String> {
        if self.frame.samples() == 0 {
            return Ok(&[]);
        }
        let byte_len = self
            .frame
            .samples()
            .saturating_mul(self.frame.channels() as usize)
            .saturating_mul(std::mem::size_of::<f32>());
        self.frame
            .data(0)
            .get(..byte_len)
            .map(|bytes| unsafe { cast_bytes_to_f32_slice(bytes) })
            .ok_or_else(|| "Resampled frame data shorter than expected".to_string())
    }
}

fn run_resampler(
    resampler: &mut resampling::Context,
    decoded_frame: &FFAudio,
    output: &mut ResamplerOutput,
    samples: &mut Vec<f32>,
) -> Result<(), String> {
    output.run(resampler, decoded_frame)?;
    samples.extend(output.samples()?);
    Ok(())
}

fn flush_resampler(
    resampler: &mut resampling::Context,
    output: &mut ResamplerOutput,
    samples: &mut Vec<f32>,
) -> Result<(), String> {
    for _ in 0..64 {
        let Some(delay) = resampler.delay() else {
            break;
        };
        let capacity = delay
            .output
            .max(1)
            .saturating_add(16)
            .min(i64::from(i32::MAX)) as usize;
        let resampled_frame = output.prepare(resampler, capacity);
        let remaining = resampler
            .flush(resampled_frame)
            .map_err(|e| format!("Flush Resampler / {e}"))?;

        let output_samples = resampled_frame.samples();
        append_resampled_frame(samples, resampled_frame)?;

        if remaining.is_none() || output_samples == 0 {
            break;
        }
    }

    Ok(())
}

fn resample_capacity(resampler: &resampling::Context, input_samples: usize) -> usize {
    let src_rate = resampler.input().rate.max(1) as u64;
    let dst_rate = resampler.output().rate.max(1) as u64;
    let pending_output_samples = resampler
        .delay()
        .map(|d| d.output.max(0) as u64)
        .unwrap_or(0);
    let resampled_from_input = (input_samples as u64)
        .saturating_mul(dst_rate)
        .div_ceil(src_rate);

    pending_output_samples
        .saturating_add(resampled_from_input)
        .saturating_add(16)
        .min(i32::MAX as u64) as usize
}

fn append_resampled_frame(samples: &mut Vec<f32>, frame: &FFAudio) -> Result<(), String> {
    if frame.samples() == 0 {
        return Ok(());
    }

    let byte_len = frame
        .samples()
        .saturating_mul(frame.channels() as usize)
        .saturating_mul(std::mem::size_of::<f32>());
    let data = frame
        .data(0)
        .get(..byte_len)
        .ok_or_else(|| "Resampled frame data shorter than expected".to_string())?;

    samples.extend(unsafe { cast_bytes_to_f32_slice(data) });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn reused_resampler_output_matches_fresh_buffers_for_variable_frames() {
        for source_rate in [16_000, 44_100, 48_000, 96_000] {
            for channels in [1, 2, 6] {
                let source_format = avformat::Sample::F32(avformat::sample::Type::Planar);
                let source_layout = ChannelLayout::default(channels);
                let output_layout =
                    ChannelLayout::default(i32::from(target_channels_for_source(channels as u16)));
                let create_resampler = || {
                    let mut options = ffmpeg::Dictionary::new();
                    options.set("filter_size", "128");
                    options.set("cutoff", "0.97");
                    resampling::Context::get_with(
                        source_format,
                        source_layout,
                        source_rate,
                        AudioData::SAMPLE_FORMAT,
                        output_layout,
                        AudioData::SAMPLE_RATE,
                        options,
                    )
                    .unwrap()
                };
                let mut reference_resampler = create_resampler();
                let mut candidate_resampler = create_resampler();
                let mut reference = Vec::new();
                let mut candidate = Vec::new();
                let mut output = ResamplerOutput::new();
                for (index, count) in [1, 511, 1024, 2048, 37, 960, 3].into_iter().enumerate() {
                    let mut input = FFAudio::new(source_format, count, source_layout);
                    input.set_rate(source_rate);
                    for channel in 0..channels as usize {
                        for (sample_index, sample) in
                            input.plane_mut::<f32>(channel).iter_mut().enumerate()
                        {
                            *sample = ((sample_index * 13 + index * 71 + channel * 3) % 101) as f32
                                / 101.0
                                - 0.5;
                        }
                    }
                    let capacity = resample_capacity(&reference_resampler, count);
                    let mut frame = FFAudio::new(AudioData::SAMPLE_FORMAT, capacity, output_layout);
                    reference_resampler.run(&input, &mut frame).unwrap();
                    append_resampled_frame(&mut reference, &frame).unwrap();
                    run_resampler(
                        &mut candidate_resampler,
                        &input,
                        &mut output,
                        &mut candidate,
                    )
                    .unwrap();
                }
                for _ in 0..64 {
                    let Some(delay) = reference_resampler.delay() else {
                        break;
                    };
                    let mut frame = FFAudio::new(
                        AudioData::SAMPLE_FORMAT,
                        delay.output.max(1).saturating_add(16) as usize,
                        output_layout,
                    );
                    let remaining = reference_resampler.flush(&mut frame).unwrap();
                    append_resampled_frame(&mut reference, &frame).unwrap();
                    if remaining.is_none() || frame.samples() == 0 {
                        break;
                    }
                }
                flush_resampler(&mut candidate_resampler, &mut output, &mut candidate).unwrap();
                assert_eq!(candidate.len(), reference.len());
                assert!(
                    candidate
                        .iter()
                        .zip(&reference)
                        .all(|(actual, expected)| actual.to_bits() == expected.to_bits()),
                    "Resampler samples differ at {source_rate} Hz with {channels} channels"
                );
            }
        }
    }

    /// Writes an s16le PCM WAV where channel `c` of every frame carries the constant
    /// `amplitudes[c]` (DC). DC survives both resampling and downmix unchanged, so the
    /// decoded output's energy is a deterministic function of which channels actually
    /// contributed — letting a test distinguish a real mixdown from silence or
    /// channel truncation.
    fn write_pcm_wav(path: &Path, sample_rate: u32, frames: usize, amplitudes: &[i16]) {
        let channels = amplitudes.len() as u16;
        let bits_per_sample = 16u16;
        let bytes_per_sample = usize::from(bits_per_sample / 8);
        let bytes_per_frame = usize::from(channels) * bytes_per_sample;
        let data_size = frames * bytes_per_frame;
        let mut bytes = Vec::with_capacity(44 + data_size);

        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * bytes_per_frame as u32).to_le_bytes());
        bytes.extend_from_slice(&(bytes_per_frame as u16).to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_size as u32).to_le_bytes());

        for _ in 0..frames {
            for &amp in amplitudes {
                bytes.extend_from_slice(&amp.to_le_bytes());
            }
        }

        std::fs::write(path, bytes).unwrap();
    }

    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum_sq: f64 = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
        (sum_sq / samples.len() as f64).sqrt() as f32
    }

    #[test]
    fn from_file_normalizes_microphone_rates_and_channels() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let loud = 8_000i16;

        // (name, sample_rate, per-channel amplitudes, expected output channels)
        let cases: [(&str, u32, Vec<i16>, u16); 5] = [
            ("mono_16000.wav", 16_000, vec![loud], 1),
            ("stereo_44100.wav", 44_100, vec![loud, -loud], 2),
            ("mono_96000.wav", 96_000, vec![loud], 1),
            ("quad_48000.wav", 48_000, vec![loud, loud, loud, loud], 2),
            ("sixteen_48000.wav", 48_000, vec![loud; 16], 2),
        ];

        for (name, sample_rate, amplitudes, expected_channels) in cases {
            let frames = (sample_rate / 4) as usize;
            let path = dir.path().join(name);
            write_pcm_wav(&path, sample_rate, frames, &amplitudes);

            let data = AudioData::from_file(&path).unwrap();
            let expected_samples = (frames as f64 * AudioData::SAMPLE_RATE as f64
                / sample_rate as f64)
                .round() as usize;
            let sample_delta = data.sample_count().abs_diff(expected_samples);

            assert_eq!(data.channels(), expected_channels, "{name}");
            assert!(
                sample_delta <= 64,
                "{name}: got {} samples, expected {expected_samples}",
                data.sample_count()
            );
            // A correct decode/downmix carries real energy, not collapsed silence.
            assert!(rms(data.samples()) > 0.01, "{name}: output is silent");
        }
    }

    #[test]
    fn from_file_downmix_preserves_non_front_channel_energy() {
        // Energy lives ONLY on the centre/rear channels (indices >= 2). A correct
        // surround→stereo downmix folds them into L/R so the output stays audible; a
        // regression that truncated to the first two channels (or kept only L/R) would
        // collapse to silence. This is the guard for that.
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();

        // 4.0 layout (FL, FR, FC, BC): signal on FC + BC only.
        let amplitudes = vec![0i16, 0, 8_000, 8_000];
        let frames = 12_000usize;
        let path = dir.path().join("quad_rear_only.wav");
        write_pcm_wav(&path, 48_000, frames, &amplitudes);

        let data = AudioData::from_file(&path).unwrap();

        assert_eq!(data.channels(), 2);
        assert!(
            rms(data.samples()) > 0.01,
            "centre/rear-only surround downmix collapsed to silence (channel truncation?)"
        );
    }

    #[test]
    fn from_file_range_seeks_to_requested_stereo_samples() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stereo_steps.wav");
        let frames = AudioData::SAMPLE_RATE as usize * 8;
        write_pcm_wav(&path, AudioData::SAMPLE_RATE, frames, &[0, 0]);

        let mut bytes = std::fs::read(&path).unwrap();
        for (index, frame) in bytes[44..].chunks_exact_mut(4).enumerate() {
            let sample = ((index / AudioData::SAMPLE_RATE as usize + 1) * 2_000) as i16;
            frame[..2].copy_from_slice(&sample.to_le_bytes());
            frame[2..].copy_from_slice(&(-sample).to_le_bytes());
        }
        std::fs::write(&path, bytes).unwrap();

        let full = AudioData::from_file(&path).unwrap();
        let start = AudioData::SAMPLE_RATE as usize * 5 + 137;
        let end = start + AudioData::SAMPLE_RATE as usize * 2 + 219;
        let range = AudioData::from_file_range(&path, start, end).unwrap();

        assert_eq!(range.channels(), 2);
        assert_eq!(range.source_start_sample(), start);
        assert_eq!(range.sample_count(), end - start);
        assert_eq!(range.samples(), &full.samples()[start * 2..end * 2]);
        assert!(range.covers_source_range(start, end));
        assert!(!range.covers_source_range(start.saturating_sub(1), end));
        assert!(!range.covers_source_range(start, end.saturating_add(1)));
    }

    #[test]
    fn from_file_range_resamples_and_clamps_at_end_of_file() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();

        for (sample_rate, channels) in [(16_000u32, 1usize), (44_100, 2), (96_000, 1)] {
            let path = dir
                .path()
                .join(format!("range_{sample_rate}_{channels}.wav"));
            write_pcm_wav(
                &path,
                sample_rate,
                sample_rate as usize * 6,
                &vec![7_000; channels],
            );

            let start = AudioData::SAMPLE_RATE as usize * 4 + 333;
            let end = AudioData::SAMPLE_RATE as usize * 8;
            let full = AudioData::from_file(&path).unwrap();
            let range = AudioData::from_file_range(&path, start, end).unwrap();

            assert_eq!(range.channels(), channels as u16);
            assert_eq!(range.source_start_sample(), start);
            assert!(range.sample_count().abs_diff(full.sample_count() - start) <= 4);
            assert!(range.covers_source_range(start, end));
            assert!(rms(range.samples()) > 0.01);
        }
    }

    #[test]
    fn from_file_range_supports_empty_windows() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty_range.wav");
        write_pcm_wav(&path, AudioData::SAMPLE_RATE, 4_800, &[2_000]);

        let data = AudioData::from_file_range(&path, 1_000, 1_000).unwrap();

        assert_eq!(data.channels(), 1);
        assert_eq!(data.source_start_sample(), 1_000);
        assert_eq!(data.sample_count(), 0);
        assert!(data.covers_source_range(1_000, 1_000));
    }
}
