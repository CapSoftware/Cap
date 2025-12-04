use crate::{
    TaskPool,
    output_pipeline::{AudioFrame, AudioMuxer, Muxer, VideoMuxer},
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::{aac::AACEncoder, h264::*};
use cap_frame_converter::{
    AsyncConverterPool, ConversionConfig, ConvertError, ConverterPoolConfig, DropStrategy,
};
use cap_media_info::{AudioInfo, VideoInfo};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tracing::{debug, info, trace, warn};

use super::FFmpegVideoFrame;

pub struct AsyncCameraMp4Muxer {
    output: ffmpeg::format::context::Output,
    video_encoder: Option<H264Encoder>,
    audio_encoder: Option<AACEncoder>,
    converter_pool: Option<AsyncConverterPool>,
    frame_sequence: AtomicU64,
    use_preconverted: bool,
    last_pts: Option<i64>,
    frames_submitted: u64,
    frames_encoded: u64,
}

pub struct AsyncCameraMuxerConfig {
    pub worker_count: usize,
    pub input_capacity: usize,
    pub output_capacity: usize,
}

impl Default for AsyncCameraMuxerConfig {
    fn default() -> Self {
        Self {
            worker_count: 4,
            input_capacity: 120,
            output_capacity: 90,
        }
    }
}

impl Muxer for AsyncCameraMp4Muxer {
    type Config = AsyncCameraMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let mut output = ffmpeg::format::output(&output_path)?;

        let (video_encoder, converter_pool, use_preconverted) =
            if let Some(video_config) = video_config {
                let encoder = H264Encoder::builder(video_config)
                    .with_external_conversion()
                    .build(&mut output)
                    .context("video encoder")?;

                let requirements = encoder.conversion_requirements();

                let pool = if requirements.needs_conversion {
                    let conversion_config = ConversionConfig::new(
                        requirements.input_format,
                        requirements.input_width,
                        requirements.input_height,
                        requirements.output_format,
                        requirements.output_width,
                        requirements.output_height,
                    );

                    let pool_config = ConverterPoolConfig {
                        worker_count: config.worker_count,
                        input_capacity: config.input_capacity,
                        output_capacity: config.output_capacity,
                        drop_strategy: DropStrategy::DropOldest,
                    };

                    let pool = AsyncConverterPool::from_config(conversion_config, pool_config)
                        .map_err(|e| anyhow!("Failed to create converter pool: {e}"))?;

                    info!(
                        "Created async converter pool with {} workers for camera encoding",
                        config.worker_count
                    );

                    Some(pool)
                } else {
                    debug!("No conversion needed for camera encoding");
                    None
                };

                (Some(encoder), pool, requirements.needs_conversion)
            } else {
                (None, None, false)
            };

        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()
            .context("audio encoder")?;

        output.write_header()?;

        Ok(Self {
            output,
            video_encoder,
            audio_encoder,
            converter_pool,
            frame_sequence: AtomicU64::new(0),
            use_preconverted,
            last_pts: None,
            frames_submitted: 0,
            frames_encoded: 0,
        })
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut pool) = self.converter_pool.take() {
            let initial_stats = pool.stats();
            info!(
                "Converter pool finishing: {} received, {} converted, {} dropped so far (muxer: submitted={}, encoded={})",
                initial_stats.frames_received,
                initial_stats.frames_converted,
                initial_stats.frames_dropped,
                self.frames_submitted,
                self.frames_encoded
            );

            let mut frames_encoded_in_drain = 0u64;
            let drain_timeout = Duration::from_secs(5);

            if let Some(encoder) = &mut self.video_encoder {
                let encoder_ref = encoder;
                let output_ref = &mut self.output;
                let last_pts = &mut self.last_pts;

                pool.drain_with_timeout(
                    |converted| {
                        let pts = converted.frame.pts().unwrap_or(0);
                        if last_pts.is_none_or(|last| pts > last) {
                            let timestamp = Duration::from_micros(pts as u64);
                            if let Err(e) = encoder_ref.queue_preconverted_frame(
                                converted.frame,
                                timestamp,
                                output_ref,
                            ) {
                                warn!("Failed to encode drained frame: {e}");
                            } else {
                                frames_encoded_in_drain += 1;
                            }
                            *last_pts = Some(pts);
                        }
                    },
                    drain_timeout,
                );
            } else {
                pool.drain_with_timeout(|_| {}, drain_timeout);
            }

            info!(
                "Converter pool drain complete: {} frames encoded during drain",
                frames_encoded_in_drain
            );
        }

        let video_result = self
            .video_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        let audio_result = self
            .audio_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        self.output.write_trailer().context("write_trailer")?;

        if video_result.is_ok() && audio_result.is_ok() {
            return Ok(Ok(()));
        }

        Ok(Err(anyhow!(
            "Video: {video_result:#?}, Audio: {audio_result:#?}"
        )))
    }
}

impl VideoMuxer for AsyncCameraMp4Muxer {
    type VideoFrame = FFmpegVideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let Some(encoder) = self.video_encoder.as_mut() else {
            return Ok(());
        };

        if let Some(pool) = &self.converter_pool {
            let sequence = self.frame_sequence.fetch_add(1, Ordering::Relaxed);

            let mut input_frame = frame.inner;
            input_frame.set_pts(Some(timestamp.as_micros() as i64));

            match pool.submit(input_frame, sequence) {
                Ok(()) => {
                    self.frames_submitted += 1;
                }
                Err(ConvertError::PoolShutdown) => {
                    debug!("Converter pool shutting down, frame will not be encoded");
                    return Ok(());
                }
                Err(e) => {
                    return Err(anyhow!("Failed to submit frame to converter: {e}"));
                }
            }

            let mut encoded_this_call = 0u64;
            while let Some(converted) = pool.try_recv() {
                let pts = converted.frame.pts().unwrap_or(0);
                if self.last_pts.is_none_or(|last| pts > last) {
                    let frame_timestamp = Duration::from_micros(pts as u64);
                    encoder.queue_preconverted_frame(
                        converted.frame,
                        frame_timestamp,
                        &mut self.output,
                    )?;
                    self.last_pts = Some(pts);
                    encoded_this_call += 1;
                    self.frames_encoded += 1;
                }
            }

            let backlog = self.frames_submitted.saturating_sub(self.frames_encoded);
            if encoded_this_call == 0
                && backlog > 10
                && let Some(converted) = pool.recv_timeout(Duration::from_millis(5))
            {
                let pts = converted.frame.pts().unwrap_or(0);
                if self.last_pts.is_none_or(|last| pts > last) {
                    let frame_timestamp = Duration::from_micros(pts as u64);
                    encoder.queue_preconverted_frame(
                        converted.frame,
                        frame_timestamp,
                        &mut self.output,
                    )?;
                    self.last_pts = Some(pts);
                    self.frames_encoded += 1;
                }
            }

            if self.frames_submitted % 60 == 0 {
                trace!(
                    "Camera encoder progress: submitted={}, encoded={}, backlog={}",
                    self.frames_submitted, self.frames_encoded, backlog
                );
            }
        } else if self.use_preconverted {
            encoder.queue_preconverted_frame(frame.inner, timestamp, &mut self.output)?;
        } else {
            encoder.queue_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}

impl AudioMuxer for AsyncCameraMp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(audio_encoder) = self.audio_encoder.as_mut() {
            audio_encoder.send_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}
