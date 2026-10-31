use anyhow::anyhow;
use cap_enc_ffmpeg::{h264::ConversionRequirements, segmented_stream::SegmentedVideoEncoder};
use cap_frame_converter::{
    AsyncConverterPool, ConversionConfig, ConvertError, ConvertedFrame, ConverterPoolConfig,
    DropStrategy, SequenceReorderBuffer,
};
use std::{
    sync::{
        Arc, Mutex,
        mpsc::{Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};
use tracing::*;

const DEFAULT_CONVERTER_WORKERS: usize = 2;
const CONVERTER_INPUT_CAPACITY: usize = 120;
const CONVERTER_OUTPUT_CAPACITY: usize = 90;
const REORDER_MAX_PENDING: usize = 16;
const REORDER_GAP_TIMEOUT: Duration = Duration::from_millis(250);
const CONVERTED_POLL_INTERVAL: Duration = Duration::from_millis(10);
const POOL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const SLOW_ENCODE_THRESHOLD_MS: u128 = 5;

pub(super) type StagedFrame = (ffmpeg::frame::Video, Duration);

pub(super) fn run_win_m4s_encode_thread(
    staging_rx: Receiver<StagedFrame>,
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    requirements: &ConversionRequirements,
    use_converter_pool: bool,
) -> anyhow::Result<()> {
    let mut converter_pool = if use_converter_pool {
        Some(create_converter_pool(requirements)?)
    } else {
        None
    };
    let mut sink = EncodeSink::new(encoder);
    let mut next_sequence = 0u64;

    loop {
        match staging_rx.recv_timeout(CONVERTED_POLL_INTERVAL) {
            Ok((mut frame, timestamp)) => {
                let Some(pool) = &converter_pool else {
                    sink.encode_raw(frame, timestamp)?;
                    continue;
                };
                frame.set_pts(Some(timestamp.as_micros() as i64));
                let sequence = next_sequence;
                next_sequence += 1;
                match pool.submit(frame, sequence) {
                    Ok(()) => {}
                    Err(ConvertError::PoolShutdown) => break,
                    Err(error) => warn!("Failed to submit frame to converter pool: {error}"),
                }
                sink.drain_pool(pool)?;
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(pool) = &converter_pool {
                    sink.drain_pool(pool)?;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    if let Some(mut pool) = converter_pool.take() {
        let mut drain_error = None;
        pool.drain_with_timeout(
            |converted| {
                if drain_error.is_none()
                    && let Err(error) = sink.ingest(converted)
                {
                    drain_error = Some(error);
                }
            },
            POOL_DRAIN_TIMEOUT,
        );
        if let Some(error) = drain_error {
            return Err(error);
        }
    }

    sink.finish()
}

fn create_converter_pool(
    requirements: &ConversionRequirements,
) -> anyhow::Result<AsyncConverterPool> {
    let worker_count = std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().clamp(2, 4))
        .unwrap_or(DEFAULT_CONVERTER_WORKERS);

    let conversion_config = ConversionConfig::new(
        requirements.input_format,
        requirements.input_width,
        requirements.input_height,
        requirements.output_format,
        requirements.output_width,
        requirements.output_height,
    );
    let pool_config = ConverterPoolConfig {
        worker_count,
        input_capacity: CONVERTER_INPUT_CAPACITY,
        output_capacity: CONVERTER_OUTPUT_CAPACITY,
        drop_strategy: DropStrategy::DropOldest,
        ..Default::default()
    };

    let pool = AsyncConverterPool::from_config(conversion_config, pool_config)
        .map_err(|error| anyhow!("Failed to create Windows M4S converter pool: {error}"))?;

    debug!(
        worker_count = worker_count,
        input = %format!(
            "{:?} {}x{}",
            requirements.input_format, requirements.input_width, requirements.input_height
        ),
        output = %format!(
            "{:?} {}x{}",
            requirements.output_format, requirements.output_width, requirements.output_height
        ),
        "Windows M4S encoder using async converter pool"
    );

    Ok(pool)
}

struct EncodeSink {
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    reorder: SequenceReorderBuffer<ConvertedFrame>,
    slow_encode_count: u32,
    total_frames: u64,
}

impl EncodeSink {
    fn new(encoder: Arc<Mutex<SegmentedVideoEncoder>>) -> Self {
        Self {
            encoder,
            reorder: SequenceReorderBuffer::new(REORDER_MAX_PENDING, REORDER_GAP_TIMEOUT),
            slow_encode_count: 0,
            total_frames: 0,
        }
    }

    fn ingest(&mut self, converted: ConvertedFrame) -> anyhow::Result<()> {
        self.reorder.push(converted.sequence, converted);
        self.encode_ready()
    }

    fn drain_pool(&mut self, pool: &AsyncConverterPool) -> anyhow::Result<()> {
        while let Some(converted) = pool.try_recv() {
            self.reorder.push(converted.sequence, converted);
        }
        self.encode_ready()
    }

    fn encode_ready(&mut self) -> anyhow::Result<()> {
        while let Some(converted) = self.reorder.pop_ready(Instant::now()) {
            self.encode_converted(converted)?;
        }
        Ok(())
    }

    fn encode_converted(&mut self, converted: ConvertedFrame) -> anyhow::Result<()> {
        let timestamp = Duration::from_micros(converted.frame.pts().unwrap_or(0).max(0) as u64);
        self.encode_with(|encoder| encoder.queue_preconverted_frame(converted.frame, timestamp))
    }

    fn encode_raw(
        &mut self,
        frame: ffmpeg::frame::Video,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        self.encode_with(|encoder| encoder.queue_frame(frame, timestamp))
    }

    fn encode_with<E: std::fmt::Display>(
        &mut self,
        queue: impl FnOnce(&mut SegmentedVideoEncoder) -> Result<(), E>,
    ) -> anyhow::Result<()> {
        let encode_start = Instant::now();
        {
            let mut encoder = self.encoder.lock().map_err(|_| {
                anyhow!("Encoder mutex poisoned - all subsequent frames would be lost")
            })?;
            if let Err(error) = queue(&mut encoder) {
                warn!("Failed to encode frame: {error}");
            }
        }
        if encode_start.elapsed().as_millis() > SLOW_ENCODE_THRESHOLD_MS {
            self.slow_encode_count += 1;
        }
        self.total_frames += 1;
        Ok(())
    }

    fn finish(mut self) -> anyhow::Result<()> {
        while let Some(converted) = self.reorder.pop_next_available() {
            self.encode_converted(converted)?;
        }

        if self.reorder.skipped() > 0 || self.reorder.discarded() > 0 {
            warn!(
                skipped = self.reorder.skipped(),
                discarded = self.reorder.discarded(),
                "Windows M4S converter pool lost frames before encode"
            );
        }

        if self.total_frames > 0 {
            debug!(
                total_frames = self.total_frames,
                slow_encodes = self.slow_encode_count,
                slow_encode_pct = format!(
                    "{:.1}%",
                    100.0 * self.slow_encode_count as f64 / self.total_frames as f64
                ),
                "Windows M4S encode timing summary"
            );
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_enc_ffmpeg::{EncodedPacketStats, segmented_stream::SegmentedVideoEncoderConfig};
    use cap_media_info::{Pixel, VideoInfo};
    use std::sync::mpsc::sync_channel;

    const FRAME_COUNT: u64 = 60;

    fn bgra_frame(shade: u8) -> ffmpeg::frame::Video {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 320, 240);
        frame.data_mut(0).fill(shade);
        frame
    }

    #[test]
    fn converter_pool_keeps_encoding_after_the_first_frame() {
        ffmpeg::init().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mut encoder = SegmentedVideoEncoder::init_with_timed_fragments(
            temp.path().to_path_buf(),
            VideoInfo {
                pixel_format: Pixel::BGRA,
                width: 320,
                height: 240,
                time_base: ffmpeg::Rational(1, 1_000_000),
                frame_rate: ffmpeg::Rational(30, 1),
            },
            SegmentedVideoEncoderConfig {
                output_size: Some((160, 120)),
                prefer_external_conversion: true,
                ..Default::default()
            },
            false,
        )
        .unwrap();
        let requirements = encoder.conversion_requirements();
        assert!(requirements.needs_conversion);
        let stats = Arc::new(EncodedPacketStats::default());
        encoder
            .current_encoder_mut()
            .unwrap()
            .set_packet_stats(stats.clone());
        let encoder = Arc::new(Mutex::new(encoder));

        let (staging_tx, staging_rx) = sync_channel::<StagedFrame>(8);
        let encode_encoder = encoder.clone();
        let handle = std::thread::spawn(move || {
            run_win_m4s_encode_thread(staging_rx, encode_encoder, &requirements, true)
        });
        for index in 0..FRAME_COUNT {
            staging_tx
                .send((
                    bgra_frame((index * 4) as u8),
                    Duration::from_micros(index * 33_333),
                ))
                .unwrap();
        }
        drop(staging_tx);
        handle.join().unwrap().unwrap();
        encoder.lock().unwrap().finish().unwrap();

        let encoded = stats.snapshot().len() as u64;
        assert!(
            encoded >= FRAME_COUNT - FRAME_COUNT / 10,
            "only {encoded} of {FRAME_COUNT} frames reached the encoder"
        );
    }
}
