use crate::output_pipeline::{AudioFrame, AudioSource, SetupCtx};
use cap_media_info::{AudioInfo, Sample, Type};
use cap_timestamp::{Timestamp, Timestamps};
use futures::channel::mpsc;
use std::{
    f32::consts::PI,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

use super::{AudioGenerator, AudioTestConfig};

pub struct SyntheticAudioSource {
    info: AudioInfo,
    stop_flag: Arc<AtomicBool>,
}

pub struct SyntheticAudioSourceConfig {
    pub audio_config: AudioTestConfig,
    pub duration: Duration,
    pub timestamps: Timestamps,
    pub cancel_token: CancellationToken,
}

impl AudioSource for SyntheticAudioSource {
    type Config = SyntheticAudioSourceConfig;

    fn setup(
        config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl std::future::Future<Output = anyhow::Result<Self>> + Send + 'static {
        let audio_config = config.audio_config;
        let info = AudioInfo::new_raw(
            audio_config.sample_format,
            audio_config.sample_rate,
            audio_config.channels,
        );

        let stop_flag = Arc::new(AtomicBool::new(false));
        let cancel_token = config.cancel_token;

        let buffer_size = 1024usize;
        let sample_duration =
            Duration::from_secs_f64(buffer_size as f64 / f64::from(audio_config.sample_rate));
        let total_samples =
            (config.duration.as_secs_f64() * f64::from(audio_config.sample_rate)) as u64;

        ctx.tasks().spawn("synthetic-audio-generator", {
            let stop_flag = stop_flag.clone();
            let cancel_token = cancel_token.clone();
            let timestamps = config.timestamps;
            let generator = audio_config.generator;
            let sample_rate = audio_config.sample_rate;
            let channels = audio_config.channels as usize;
            let sample_format = audio_config.sample_format;
            let mut tx = tx;

            async move {
                let mut sample_offset = 0u64;
                let start_instant = timestamps.instant();

                loop {
                    if stop_flag.load(Ordering::Relaxed) || cancel_token.is_cancelled() {
                        break;
                    }

                    if sample_offset >= total_samples {
                        break;
                    }

                    let samples_to_generate =
                        buffer_size.min((total_samples - sample_offset) as usize);

                    let audio_data = generate_audio_samples(
                        &generator,
                        sample_rate,
                        channels,
                        sample_offset,
                        samples_to_generate,
                    );

                    let frame = create_audio_frame(
                        &audio_data,
                        sample_format,
                        sample_rate,
                        channels,
                        samples_to_generate,
                    );

                    let elapsed =
                        Duration::from_secs_f64(sample_offset as f64 / f64::from(sample_rate));
                    let timestamp = Timestamp::Instant(start_instant + elapsed);

                    let audio_frame = AudioFrame::new(frame, timestamp);

                    if tx.try_send(audio_frame).is_err() {
                        if stop_flag.load(Ordering::Relaxed) || cancel_token.is_cancelled() {
                            break;
                        }
                        tracing::warn!(
                            "Audio frame channel full, samples {} dropped",
                            sample_offset
                        );
                    }

                    sample_offset += samples_to_generate as u64;

                    let target_time = start_instant
                        + sample_duration * (sample_offset / buffer_size as u64) as u32;
                    let now = std::time::Instant::now();
                    if target_time > now {
                        tokio::time::sleep(target_time - now).await;
                    }
                }

                tracing::info!(
                    "Synthetic audio generator finished after {} samples",
                    sample_offset
                );
                Ok(())
            }
        });

        async move { Ok(SyntheticAudioSource { info, stop_flag }) }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }

    fn stop(&mut self) -> impl std::future::Future<Output = anyhow::Result<()>> + Send {
        self.stop_flag.store(true, Ordering::Relaxed);
        async { Ok(()) }
    }
}

fn generate_audio_samples(
    generator: &AudioGenerator,
    sample_rate: u32,
    channels: usize,
    sample_offset: u64,
    sample_count: usize,
) -> Vec<f32> {
    let mut samples = Vec::with_capacity(sample_count * channels);

    match generator {
        AudioGenerator::SineWave { frequency } => {
            let angular_freq = 2.0 * PI * frequency / sample_rate as f32;

            for i in 0..sample_count {
                let t = (sample_offset + i as u64) as f32;
                let value = (angular_freq * t).sin() * 0.5;

                for _ in 0..channels {
                    samples.push(value);
                }
            }
        }
        AudioGenerator::Chirp {
            start_freq,
            end_freq,
        } => {
            let total_duration = 5.0;
            let freq_range = end_freq - start_freq;

            for i in 0..sample_count {
                let t = (sample_offset + i as u64) as f32 / sample_rate as f32;
                let current_freq = start_freq + (freq_range * (t / total_duration).min(1.0));
                let angular_freq = 2.0 * PI * current_freq;
                let value = (angular_freq * t).sin() * 0.5;

                for _ in 0..channels {
                    samples.push(value);
                }
            }
        }
        AudioGenerator::WhiteNoise => {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};

            for i in 0..sample_count {
                let mut hasher = DefaultHasher::new();
                (sample_offset + i as u64).hash(&mut hasher);
                let hash = hasher.finish();

                let value = ((hash as f32 / u64::MAX as f32) * 2.0 - 1.0) * 0.3;

                for _ in 0..channels {
                    samples.push(value);
                }
            }
        }
        AudioGenerator::Silence => {
            samples.resize(sample_count * channels, 0.0);
        }
        AudioGenerator::TimestampBeeps { beep_interval_ms } => {
            let beep_interval_samples =
                (sample_rate as f32 * *beep_interval_ms as f32 / 1000.0) as u64;
            let beep_duration_samples = (sample_rate as f32 * 0.05) as u64;
            let beep_freq = 1000.0;
            let angular_freq = 2.0 * PI * beep_freq / sample_rate as f32;

            for i in 0..sample_count {
                let global_sample = sample_offset + i as u64;
                let position_in_interval = global_sample % beep_interval_samples;

                let value = if position_in_interval < beep_duration_samples {
                    (angular_freq * global_sample as f32).sin() * 0.7
                } else {
                    0.0
                };

                for _ in 0..channels {
                    samples.push(value);
                }
            }
        }
        AudioGenerator::Square { frequency } => {
            let period_samples = sample_rate as f32 / frequency;

            for i in 0..sample_count {
                let t = (sample_offset + i as u64) as f32;
                let position_in_period = t % period_samples;
                let value = if position_in_period < period_samples / 2.0 {
                    0.5
                } else {
                    -0.5
                };

                for _ in 0..channels {
                    samples.push(value);
                }
            }
        }
    }

    samples
}

fn create_audio_frame(
    samples: &[f32],
    sample_format: Sample,
    sample_rate: u32,
    channels: usize,
    sample_count: usize,
) -> ffmpeg::frame::Audio {
    let channel_layout = match channels {
        1 => ffmpeg::util::channel_layout::ChannelLayout::MONO,
        2 => ffmpeg::util::channel_layout::ChannelLayout::STEREO,
        6 => ffmpeg::util::channel_layout::ChannelLayout::_5POINT1,
        _ => ffmpeg::util::channel_layout::ChannelLayout::default(channels as i32),
    };

    let mut frame = ffmpeg::frame::Audio::new(sample_format, sample_count, channel_layout);
    frame.set_rate(sample_rate);

    match sample_format {
        Sample::F32(Type::Planar) => {
            for ch in 0..channels {
                let plane_data = frame.data_mut(ch);
                let plane_samples: &mut [f32] = unsafe {
                    std::slice::from_raw_parts_mut(
                        plane_data.as_mut_ptr() as *mut f32,
                        sample_count,
                    )
                };

                for (i, sample) in plane_samples.iter_mut().enumerate() {
                    *sample = samples[i * channels + ch];
                }
            }
        }
        Sample::F32(Type::Packed) => {
            let plane_data = frame.data_mut(0);
            let plane_samples: &mut [f32] = unsafe {
                std::slice::from_raw_parts_mut(
                    plane_data.as_mut_ptr() as *mut f32,
                    sample_count * channels,
                )
            };
            plane_samples.copy_from_slice(samples);
        }
        Sample::I16(Type::Planar) => {
            for ch in 0..channels {
                let plane_data = frame.data_mut(ch);
                let plane_samples: &mut [i16] = unsafe {
                    std::slice::from_raw_parts_mut(
                        plane_data.as_mut_ptr() as *mut i16,
                        sample_count,
                    )
                };

                for (i, sample) in plane_samples.iter_mut().enumerate() {
                    let f = samples[i * channels + ch];
                    *sample = (f * 32767.0).clamp(-32768.0, 32767.0) as i16;
                }
            }
        }
        Sample::I16(Type::Packed) => {
            let plane_data = frame.data_mut(0);
            let plane_samples: &mut [i16] = unsafe {
                std::slice::from_raw_parts_mut(
                    plane_data.as_mut_ptr() as *mut i16,
                    sample_count * channels,
                )
            };

            for (i, sample) in plane_samples.iter_mut().enumerate() {
                let f = samples[i];
                *sample = (f * 32767.0).clamp(-32768.0, 32767.0) as i16;
            }
        }
        _ => {
            let plane_data = frame.data_mut(0);
            let plane_samples: &mut [f32] = unsafe {
                std::slice::from_raw_parts_mut(
                    plane_data.as_mut_ptr() as *mut f32,
                    sample_count.min(plane_data.len() / 4),
                )
            };
            let copy_len = plane_samples.len().min(samples.len());
            plane_samples[..copy_len].copy_from_slice(&samples[..copy_len]);
        }
    }

    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sine_wave_generation() {
        let samples = generate_audio_samples(
            &AudioGenerator::SineWave { frequency: 440.0 },
            48000,
            2,
            0,
            1024,
        );

        assert_eq!(samples.len(), 1024 * 2);

        for &sample in &samples {
            assert!(sample >= -1.0 && sample <= 1.0);
        }
    }

    #[test]
    fn test_silence_generation() {
        let samples = generate_audio_samples(&AudioGenerator::Silence, 48000, 2, 0, 1024);

        assert_eq!(samples.len(), 1024 * 2);

        for &sample in &samples {
            assert_eq!(sample, 0.0);
        }
    }

    #[test]
    fn test_timestamp_beeps() {
        let samples = generate_audio_samples(
            &AudioGenerator::TimestampBeeps {
                beep_interval_ms: 1000,
            },
            48000,
            1,
            0,
            48000,
        );

        assert_eq!(samples.len(), 48000);

        let first_beep_samples = &samples[0..2400];
        let has_audio = first_beep_samples.iter().any(|&s| s.abs() > 0.1);
        assert!(has_audio, "Should have audio in first beep period");

        let silence_samples = &samples[4800..48000];
        let mostly_silent =
            silence_samples.iter().filter(|&&s| s.abs() > 0.1).count() < silence_samples.len() / 10;
        assert!(mostly_silent, "Should be mostly silent after beep");
    }

    #[test]
    fn test_audio_info_creation() {
        let config = AudioTestConfig::broadcast_stereo();
        let info = AudioInfo::new_raw(config.sample_format, config.sample_rate, config.channels);

        assert_eq!(info.sample_rate, 48000);
        assert_eq!(info.channels, 2);
    }
}
