use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
    frame::Audio as FFAudio,
    software::resampling,
};
use std::path::Path;

use crate::cast_bytes_to_f32_slice;

// F32 Packed 48kHz audio
pub struct AudioData {
    samples: Vec<f32>,
    channels: u16,
}

impl AudioData {
    pub const SAMPLE_FORMAT: avformat::Sample =
        avformat::Sample::F32(avformat::sample::Type::Packed);
    pub const SAMPLE_RATE: u32 = 48_000;

    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, String> {
        fn inner(path: &Path) -> Result<AudioData, String> {
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
            decoder.set_packet_time_base(input_stream.time_base());

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

            let mut decoded_frame = ffmpeg::frame::Audio::empty();
            let mut samples: Vec<f32> = vec![];

            for (stream, packet) in input_ctx.packets() {
                if stream.index() != index {
                    continue;
                }

                decoder
                    .send_packet(&packet)
                    .map_err(|e| format!("Send Packet / {e}"))?;

                while decoder.receive_frame(&mut decoded_frame).is_ok() {
                    run_resampler(&mut resampler, &decoded_frame, &mut samples)?;
                }
            }

            decoder.send_eof().map_err(|e| format!("Send EOF / {e}"))?;

            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                run_resampler(&mut resampler, &decoded_frame, &mut samples)?;
            }

            flush_resampler(&mut resampler, &mut samples)?;

            Ok(AudioData {
                samples,
                channels: target_channels,
            })
        }

        inner(path.as_ref())
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

    #[cfg(test)]
    pub(crate) fn from_raw_f32(samples: Vec<f32>, channels: u16) -> Self {
        Self { samples, channels }
    }
}

fn target_channels_for_source(channels: u16) -> u16 {
    if channels <= 1 { 1 } else { 2 }
}

fn run_resampler(
    resampler: &mut resampling::Context,
    decoded_frame: &FFAudio,
    samples: &mut Vec<f32>,
) -> Result<(), String> {
    let target = *resampler.output();
    let capacity = resample_capacity(resampler, decoded_frame.samples());
    let mut resampled_frame = FFAudio::new(target.format, capacity, target.channel_layout);

    resampler
        .run(decoded_frame, &mut resampled_frame)
        .map_err(|e| format!("Run Resampler / {e}"))?;

    append_resampled_frame(samples, &resampled_frame)
}

fn flush_resampler(
    resampler: &mut resampling::Context,
    samples: &mut Vec<f32>,
) -> Result<(), String> {
    for _ in 0..64 {
        let Some(delay) = resampler.delay() else {
            break;
        };
        let target = *resampler.output();
        let capacity = delay
            .output
            .max(1)
            .saturating_add(16)
            .min(i64::from(i32::MAX)) as usize;
        let mut resampled_frame = FFAudio::new(target.format, capacity, target.channel_layout);
        let remaining = resampler
            .flush(&mut resampled_frame)
            .map_err(|e| format!("Flush Resampler / {e}"))?;

        let output_samples = resampled_frame.samples();
        append_resampled_frame(samples, &resampled_frame)?;

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
}
