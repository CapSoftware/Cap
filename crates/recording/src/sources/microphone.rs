use crate::{
    feeds::microphone::{self, MicrophoneFeedLock},
    output_pipeline::{AudioFrame, AudioSource},
};
use cap_media_info::AudioInfo;
use cpal::SampleFormat;
use futures::{SinkExt, channel::mpsc};
use kameo::error::SendError;
use std::{borrow::Cow, sync::Arc};
use thiserror::Error;

const MICROPHONE_TARGET_CHANNELS: u16 = 1;

pub struct Microphone {
    info: AudioInfo,
    _lock: Arc<MicrophoneFeedLock>,
}

#[derive(Debug, Error)]
pub enum MicrophoneSourceError {
    #[error("microphone actor not running")]
    ActorNotRunning,
    #[error("failed to add microphone sender: {0}")]
    AddSenderFailed(SendError<()>),
}

impl AudioSource for Microphone {
    type Config = Arc<MicrophoneFeedLock>;

    #[allow(clippy::manual_async_fn)]
    fn setup(
        feed_lock: Self::Config,
        mut audio_tx: mpsc::Sender<AudioFrame>,
        _: &mut crate::SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        async move {
            let source_info = feed_lock.audio_info();
            let audio_info = source_info.with_max_channels(MICROPHONE_TARGET_CHANNELS);
            let source_channels = source_info.channels;
            let target_channels = audio_info.channels;
            let (tx, rx) = flume::bounded(8);

            feed_lock
                .ask(microphone::AddSender(tx))
                .await
                .map_err(|err| match err {
                    SendError::ActorNotRunning(_) => MicrophoneSourceError::ActorNotRunning,
                    other => MicrophoneSourceError::AddSenderFailed(other.map_msg(|_| ())),
                })?;

            tokio::spawn(async move {
                while let Ok(frame) = rx.recv_async().await {
                    let packed = maybe_downmix_channels(
                        &frame.data,
                        frame.format,
                        source_channels,
                        target_channels,
                    );

                    let _ = audio_tx
                        .send(AudioFrame::new(
                            audio_info.wrap_frame(packed.as_ref()),
                            frame.timestamp,
                        ))
                        .await;
                }
            });

            Ok(Self {
                info: audio_info,
                _lock: feed_lock,
            })
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }
}

fn maybe_downmix_channels<'a>(
    data: &'a [u8],
    format: SampleFormat,
    source_channels: usize,
    target_channels: usize,
) -> Cow<'a, [u8]> {
    if target_channels == 0 || source_channels == 0 || target_channels >= source_channels {
        return Cow::Borrowed(data);
    }

    if target_channels == 1 {
        if let Some(samples) = downmix_to_mono(data, format, source_channels) {
            Cow::Owned(samples)
        } else {
            Cow::Borrowed(data)
        }
    } else {
        Cow::Borrowed(data)
    }
}

fn downmix_to_mono(data: &[u8], format: SampleFormat, source_channels: usize) -> Option<Vec<u8>> {
    let sample_size = sample_format_size(format)?;

    let frame_size = sample_size.checked_mul(source_channels)?;
    if frame_size == 0 || !data.len().is_multiple_of(frame_size) {
        return None;
    }

    let frame_count = data.len() / frame_size;
    let mut out = vec![0u8; frame_count * sample_size];

    for (frame_idx, frame) in data.chunks(frame_size).enumerate() {
        let mono = average_frame_sample(format, frame, sample_size, source_channels)?;
        let start = frame_idx * sample_size;
        write_sample_from_f64(format, mono, &mut out[start..start + sample_size]);
    }

    Some(out)
}

fn sample_format_size(format: SampleFormat) -> Option<usize> {
    Some(match format {
        SampleFormat::I8 | SampleFormat::U8 => 1,
        SampleFormat::I16 | SampleFormat::U16 => 2,
        SampleFormat::I32 | SampleFormat::U32 | SampleFormat::F32 => 4,
        SampleFormat::I64 | SampleFormat::U64 | SampleFormat::F64 => 8,
        _ => return None,
    })
}

fn average_frame_sample(
    format: SampleFormat,
    frame: &[u8],
    sample_size: usize,
    channels: usize,
) -> Option<f64> {
    let mut sum = 0.0;
    for ch in 0..channels {
        let start = ch * sample_size;
        let end = start + sample_size;
        sum += sample_to_f64(format, &frame[start..end])?;
    }

    Some(sum / channels as f64)
}

fn sample_to_f64(format: SampleFormat, bytes: &[u8]) -> Option<f64> {
    match format {
        SampleFormat::I8 => bytes.first().copied().map(|v| v as i8 as f64),
        SampleFormat::U8 => bytes.first().copied().map(|v| v as f64),
        SampleFormat::I16 => {
            let mut buf = [0u8; 2];
            buf.copy_from_slice(bytes);
            Some(i16::from_ne_bytes(buf) as f64)
        }
        SampleFormat::U16 => {
            let mut buf = [0u8; 2];
            buf.copy_from_slice(bytes);
            Some(u16::from_ne_bytes(buf) as f64)
        }
        SampleFormat::I32 => {
            let mut buf = [0u8; 4];
            buf.copy_from_slice(bytes);
            Some(i32::from_ne_bytes(buf) as f64)
        }
        SampleFormat::U32 => {
            let mut buf = [0u8; 4];
            buf.copy_from_slice(bytes);
            Some(u32::from_ne_bytes(buf) as f64)
        }
        SampleFormat::I64 => {
            let mut buf = [0u8; 8];
            buf.copy_from_slice(bytes);
            Some(i64::from_ne_bytes(buf) as f64)
        }
        SampleFormat::U64 => {
            let mut buf = [0u8; 8];
            buf.copy_from_slice(bytes);
            Some(u64::from_ne_bytes(buf) as f64)
        }
        SampleFormat::F32 => {
            let mut buf = [0u8; 4];
            buf.copy_from_slice(bytes);
            Some(f32::from_ne_bytes(buf) as f64)
        }
        SampleFormat::F64 => {
            let mut buf = [0u8; 8];
            buf.copy_from_slice(bytes);
            Some(f64::from_ne_bytes(buf))
        }
        _ => None,
    }
}

fn write_sample_from_f64(format: SampleFormat, value: f64, out: &mut [u8]) {
    match format {
        SampleFormat::I8 => {
            let sample = value.round().clamp(i8::MIN as f64, i8::MAX as f64) as i8;
            out[0] = sample as u8;
        }
        SampleFormat::U8 => {
            let sample = value.round().clamp(u8::MIN as f64, u8::MAX as f64) as u8;
            out[0] = sample;
        }
        SampleFormat::I16 => {
            let sample = value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::U16 => {
            let sample = value.round().clamp(u16::MIN as f64, u16::MAX as f64) as u16;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::I32 => {
            let sample = value.round().clamp(i32::MIN as f64, i32::MAX as f64) as i32;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::U32 => {
            let sample = value.round().clamp(u32::MIN as f64, u32::MAX as f64) as u32;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::I64 => {
            let sample = value.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::U64 => {
            let sample = value.round().clamp(u64::MIN as f64, u64::MAX as f64) as u64;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::F32 => {
            let sample = value as f32;
            out.copy_from_slice(&sample.to_ne_bytes());
        }
        SampleFormat::F64 => {
            out.copy_from_slice(&value.to_ne_bytes());
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmixes_stereo_f32_to_mono() {
        let frames = [(0.5f32, -0.25f32), (1.0f32, 1.0f32)];
        let mut data = Vec::new();

        for (left, right) in frames {
            data.extend_from_slice(&left.to_ne_bytes());
            data.extend_from_slice(&right.to_ne_bytes());
        }

        let downmixed = maybe_downmix_channels(&data, SampleFormat::F32, 2, 1);
        let owned = downmixed.into_owned();
        assert_eq!(owned.len(), frames.len() * std::mem::size_of::<f32>());

        let first = f32::from_ne_bytes(owned[0..4].try_into().unwrap());
        let second = f32::from_ne_bytes(owned[4..8].try_into().unwrap());

        assert!((first - 0.125).abs() < f32::EPSILON);
        assert!((second - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn leaves_mono_buffers_untouched() {
        let sample = 0.75f32;
        let data = sample.to_ne_bytes().to_vec();
        let result = maybe_downmix_channels(&data, SampleFormat::F32, 1, 1);
        assert!(matches!(result, Cow::Borrowed(_)));
    }
}
