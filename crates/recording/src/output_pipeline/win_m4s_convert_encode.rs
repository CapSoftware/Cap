use super::core::{PipelineHealthEvent, SharedHealthSender};
use anyhow::anyhow;
use cap_enc_ffmpeg::{
    h264::ConversionRequirements,
    segmented_stream::{QueueFrameError, SegmentedVideoEncoder},
};
use cap_frame_converter::{
    AsyncConverterPool, ConversionConfig, ConvertError, ConvertedFrame, ConverterPoolConfig,
    DropStrategy, SequenceReorderBuffer,
};
use std::{
    cell::Cell,
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

fn new_reorder_buffer() -> SequenceReorderBuffer<ConvertedFrame> {
    SequenceReorderBuffer::new(REORDER_MAX_PENDING, REORDER_GAP_TIMEOUT)
}

pub(super) type StagedFrame = (ffmpeg::frame::Video, Duration);

/// Logs the first encode failures, then every 300th: a warning per frame from
/// a dead encoder pushed its first error out of the size-capped log upload.
pub(super) fn report_encode_result(
    encoder: &mut SegmentedVideoEncoder,
    result: Result<(), QueueFrameError>,
    failures: &Cell<u64>,
    health_tx: &SharedHealthSender,
    track: &'static str,
) -> bool {
    if let Err(error) = result {
        let count = failures.get() + 1;
        failures.set(count);
        if count <= 3 || count.is_multiple_of(300) {
            warn!(track, failures = count, "Failed to encode frame: {error}");
        }
    }
    if let Some(fallback) = encoder.take_encoder_fallback() {
        warn!(
            track,
            failed_encoder = %fallback.failed_encoder,
            error = %fallback.error,
            replacement = %fallback.replacement,
            "Video encoder replaced mid-recording"
        );
        health_tx.emit(PipelineHealthEvent::EncoderRebuilt {
            backend: fallback.replacement,
            attempt: 1,
        });
        return true;
    }
    false
}

pub(super) fn run_win_m4s_encode_thread(
    staging_rx: Receiver<StagedFrame>,
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    requirements: ConversionRequirements,
    prefer_external_conversion: bool,
    health_tx: SharedHealthSender,
) -> anyhow::Result<()> {
    let mut converter_pool = converter_pool_for(&requirements, prefer_external_conversion)?;
    let mut sink = EncodeSink::new(encoder, requirements, health_tx);
    let mut next_sequence = 0u64;

    loop {
        match staging_rx.recv_timeout(CONVERTED_POLL_INTERVAL) {
            Ok((mut frame, timestamp)) => {
                if let Some(pool) = &converter_pool {
                    frame.set_pts(Some(timestamp.as_micros() as i64));
                    let sequence = next_sequence;
                    next_sequence += 1;
                    match pool.submit(frame, sequence) {
                        Ok(()) => {}
                        Err(ConvertError::PoolShutdown) => break,
                        Err(error) => warn!("Failed to submit frame to converter pool: {error}"),
                    }
                    sink.drain_pool(pool)?;
                } else {
                    sink.encode_raw(frame, timestamp)?;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(pool) = &converter_pool {
                    sink.drain_pool(pool)?;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if let Some(requirements) = sink.take_changed_requirements() {
            warn!(
                output = %format!(
                    "{:?} {}x{}",
                    requirements.output_format, requirements.output_width, requirements.output_height
                ),
                "Windows M4S encoder input changed after encoder fallback; rebuilding conversion"
            );
            drop(converter_pool.take());
            sink.reset_reorder();
            next_sequence = 0;
            converter_pool = converter_pool_for(&requirements, prefer_external_conversion)?;
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

fn converter_pool_for(
    requirements: &ConversionRequirements,
    prefer_external_conversion: bool,
) -> anyhow::Result<Option<AsyncConverterPool>> {
    if prefer_external_conversion && requirements.needs_conversion {
        create_converter_pool(requirements).map(Some)
    } else {
        Ok(None)
    }
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
    requirements: ConversionRequirements,
    changed_requirements: Option<ConversionRequirements>,
    health_tx: SharedHealthSender,
    encode_failures: Cell<u64>,
    stale_frames: u64,
    slow_encode_count: u32,
    total_frames: u64,
}

impl EncodeSink {
    fn new(
        encoder: Arc<Mutex<SegmentedVideoEncoder>>,
        requirements: ConversionRequirements,
        health_tx: SharedHealthSender,
    ) -> Self {
        Self {
            encoder,
            reorder: new_reorder_buffer(),
            requirements,
            changed_requirements: None,
            health_tx,
            encode_failures: Cell::new(0),
            stale_frames: 0,
            slow_encode_count: 0,
            total_frames: 0,
        }
    }

    fn take_changed_requirements(&mut self) -> Option<ConversionRequirements> {
        self.changed_requirements.take()
    }

    fn reset_reorder(&mut self) {
        let mut stale = std::mem::replace(&mut self.reorder, new_reorder_buffer());
        while stale.pop_next_available().is_some() {
            self.stale_frames += 1;
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
        if self.changed_requirements.is_some() {
            self.stale_frames += 1;
            return Ok(());
        }
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

    fn encode_with(
        &mut self,
        queue: impl FnOnce(&mut SegmentedVideoEncoder) -> Result<(), QueueFrameError>,
    ) -> anyhow::Result<()> {
        let encode_start = Instant::now();
        {
            let mut encoder = self.encoder.lock().map_err(|_| {
                anyhow!("Encoder mutex poisoned - all subsequent frames would be lost")
            })?;
            let result = queue(&mut encoder);
            if report_encode_result(
                &mut encoder,
                result,
                &self.encode_failures,
                &self.health_tx,
                "screen",
            ) {
                let requirements = encoder.conversion_requirements();
                if requirements != self.requirements {
                    self.requirements = requirements;
                    self.changed_requirements = Some(requirements);
                }
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

        if self.reorder.skipped() > 0 || self.reorder.discarded() > 0 || self.stale_frames > 0 {
            warn!(
                skipped = self.reorder.skipped(),
                discarded = self.reorder.discarded(),
                stale = self.stale_frames,
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
            run_win_m4s_encode_thread(
                staging_rx,
                encode_encoder,
                requirements,
                true,
                SharedHealthSender::new(),
            )
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
