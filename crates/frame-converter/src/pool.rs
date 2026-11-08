use crate::{ConversionConfig, ConvertError, FrameConverter, VideoFramePool, create_converter};
use ffmpeg::{format::Pixel, frame};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tracing::{debug, info, warn};

const CONVERTER_POOL_BYTE_BUDGET: usize = 64 * 1024 * 1024;

pub(crate) fn estimate_frame_bytes(format: Pixel, width: u32, height: u32) -> usize {
    let pixels = (width as usize).saturating_mul(height as usize);
    let (num, den) = match format {
        Pixel::NV12 | Pixel::YUV420P | Pixel::YUVJ420P => (3, 2),
        Pixel::YUYV422 | Pixel::UYVY422 | Pixel::YUV422P => (2, 1),
        Pixel::RGB24 | Pixel::BGR24 => (3, 1),
        _ => (4, 1),
    };
    pixels
        .saturating_mul(num)
        .checked_div(den)
        .unwrap_or(0)
        .max(1)
}

pub struct ConvertedFrame {
    pub frame: frame::Video,
    pub sequence: u64,
    pub submit_time: Instant,
    pub conversion_duration: Duration,
}

pub struct InputFrame {
    pub frame: frame::Video,
    pub sequence: u64,
    pub submit_time: Instant,
}

#[derive(Clone, Debug)]
pub struct ConverterPoolConfig {
    pub worker_count: usize,
    pub input_capacity: usize,
    pub output_capacity: usize,
    pub drop_strategy: DropStrategy,
    pub frame_pool_capacity: usize,
}

impl Default for ConverterPoolConfig {
    fn default() -> Self {
        Self {
            worker_count: 2,
            input_capacity: 8,
            output_capacity: 8,
            drop_strategy: DropStrategy::DropOldest,
            frame_pool_capacity: 16,
        }
    }
}

impl ConverterPoolConfig {
    pub fn bounded_for_conversion(&self, conversion: &ConversionConfig) -> Self {
        let in_bytes = estimate_frame_bytes(
            conversion.input_format,
            conversion.input_width,
            conversion.input_height,
        );
        let out_bytes = estimate_frame_bytes(
            conversion.output_format,
            conversion.output_width,
            conversion.output_height,
        );
        let worker_frame_bytes = in_bytes.saturating_add(out_bytes);
        let hard_max_workers = CONVERTER_POOL_BYTE_BUDGET / worker_frame_bytes;
        let min_workers = usize::from(hard_max_workers > 0);
        let max_workers = (CONVERTER_POOL_BYTE_BUDGET / 2 / worker_frame_bytes).max(min_workers);
        let worker_count = self.worker_count.clamp(min_workers, max_workers);

        let remaining_after_workers = CONVERTER_POOL_BYTE_BUDGET
            .saturating_sub(worker_count.saturating_mul(worker_frame_bytes));
        let input_headroom = remaining_after_workers.saturating_sub(out_bytes);
        let min_input = usize::from(input_headroom >= in_bytes);
        let max_input = (input_headroom / 2 / in_bytes).max(min_input);
        let input_capacity = self.input_capacity.clamp(min_input, max_input);

        let remaining_for_output = remaining_after_workers
            .saturating_sub(input_capacity.saturating_mul(in_bytes));
        let max_out_slots = remaining_for_output / out_bytes;
        let min_output = usize::from(max_out_slots > 0);
        let max_output = (max_out_slots / 2).max(min_output);
        let output_capacity = self.output_capacity.clamp(min_output, max_output);
        let max_pool = max_out_slots.saturating_sub(output_capacity);

        Self {
            worker_count,
            input_capacity,
            output_capacity,
            drop_strategy: self.drop_strategy,
            frame_pool_capacity: self.frame_pool_capacity.min(max_pool),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum DropStrategy {
    DropOldest,
    DropNewest,
}

pub struct ConverterPoolStats {
    pub frames_received: u64,
    pub frames_converted: u64,
    pub frames_dropped: u64,
    pub current_queue_depth: usize,
}

pub struct AsyncConverterPool {
    input_tx: Option<flume::Sender<InputFrame>>,
    input_rx: flume::Receiver<InputFrame>,
    output_rx: flume::Receiver<ConvertedFrame>,
    workers: Vec<JoinHandle<()>>,
    shutdown: Arc<AtomicBool>,
    stats: Arc<PoolStats>,
    drop_strategy: DropStrategy,
    frame_pool: Option<Arc<VideoFramePool>>,
}

#[derive(Default)]
struct PoolStats {
    frames_received: AtomicU64,
    frames_converted: AtomicU64,
    frames_dropped: AtomicU64,
}

struct PoolBuildSpec<F> {
    factory: F,
    converter_name: String,
    config: ConverterPoolConfig,
    frame_pool: Option<Arc<VideoFramePool>>,
}

impl AsyncConverterPool {
    pub fn new(converter: Arc<dyn FrameConverter>, config: ConverterPoolConfig) -> Self {
        let converter_name = converter.name().to_string();
        Self::new_with_spec(PoolBuildSpec {
            factory: move |_| Ok(Arc::clone(&converter)),
            converter_name,
            config,
            frame_pool: None,
        })
        .expect("Factory using pre-created converter should not fail")
    }

    pub fn from_config(
        conversion_config: ConversionConfig,
        pool_config: ConverterPoolConfig,
    ) -> Result<Self, ConvertError> {
        let bounded_config = pool_config.bounded_for_conversion(&conversion_config);
        let first_converter = create_converter(conversion_config.clone())?;
        let converter_name = first_converter.name().to_string();

        let frame_pool = if bounded_config.frame_pool_capacity > 0 {
            Some(VideoFramePool::new(
                bounded_config.frame_pool_capacity,
                conversion_config.output_format,
                conversion_config.output_width,
                conversion_config.output_height,
            ))
        } else {
            None
        };

        Self::new_with_spec(PoolBuildSpec {
            factory: move |worker_id| {
                if worker_id == 0 {
                    Ok(Arc::clone(&first_converter))
                } else {
                    create_converter(conversion_config.clone())
                }
            },
            converter_name,
            config: bounded_config,
            frame_pool,
        })
    }

    fn new_with_spec<F>(spec: PoolBuildSpec<F>) -> Result<Self, ConvertError>
    where
        F: Fn(usize) -> Result<Arc<dyn FrameConverter>, ConvertError> + Send + Sync + 'static,
    {
        let (input_tx, input_rx) = flume::bounded(spec.config.input_capacity);
        let (output_tx, output_rx) = flume::bounded(spec.config.output_capacity);
        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(PoolStats::default());

        let mut workers = Vec::with_capacity(spec.config.worker_count);
        let factory = Arc::new(spec.factory);

        for worker_id in 0..spec.config.worker_count {
            let factory = Arc::clone(&factory);
            let worker_ctx = WorkerContext {
                worker_id,
                input_rx: input_rx.clone(),
                output_tx: output_tx.clone(),
                shutdown: Arc::clone(&shutdown),
                stats: Arc::clone(&stats),
                drop_strategy: spec.config.drop_strategy,
                frame_pool: spec.frame_pool.clone(),
            };

            let handle = thread::Builder::new()
                .name(format!("converter-worker-{worker_id}"))
                .spawn(move || match factory(worker_id) {
                    Ok(converter) => worker_loop(worker_ctx, converter),
                    Err(e) => warn!("Worker {worker_id} failed to create converter: {e}"),
                })
                .expect("Failed to spawn converter worker thread");

            workers.push(handle);
        }

        let pooling_suffix = if spec.frame_pool.is_some() {
            " with frame pooling"
        } else {
            ""
        };
        info!(
            "AsyncConverterPool started with {} workers using {} converter{}",
            spec.config.worker_count, spec.converter_name, pooling_suffix
        );

        Ok(Self {
            input_tx: Some(input_tx),
            input_rx,
            output_rx,
            workers,
            shutdown,
            stats,
            drop_strategy: spec.config.drop_strategy,
            frame_pool: spec.frame_pool,
        })
    }

    fn record_input_drop(&self) {
        let dropped = self.stats.frames_dropped.fetch_add(1, Ordering::Relaxed) + 1;
        if dropped.is_multiple_of(30) {
            warn!("Converter pool input full, dropped {dropped} frames so far");
        }
    }

    pub fn submit(&self, frame: frame::Video, sequence: u64) -> Result<(), ConvertError> {
        let Some(input_tx) = &self.input_tx else {
            return Err(ConvertError::PoolShutdown);
        };

        self.stats.frames_received.fetch_add(1, Ordering::Relaxed);
        let candidate = InputFrame {
            frame,
            sequence,
            submit_time: Instant::now(),
        };

        match input_tx.try_send(candidate) {
            Ok(()) => Ok(()),
            Err(flume::TrySendError::Full(rejected)) => {
                if matches!(self.drop_strategy, DropStrategy::DropOldest) {
                    if self.input_rx.try_recv().is_ok() {
                        self.record_input_drop();
                    }
                    if input_tx.try_send(rejected).is_err() {
                        self.record_input_drop();
                    }
                } else {
                    self.record_input_drop();
                }
                Ok(())
            }
            Err(flume::TrySendError::Disconnected(_)) => Err(ConvertError::PoolShutdown),
        }
    }

    pub fn try_recv(&self) -> Option<ConvertedFrame> {
        self.output_rx.try_recv().ok()
    }

    pub fn recv(&self) -> Result<ConvertedFrame, ConvertError> {
        self.output_rx
            .recv()
            .map_err(|_| ConvertError::PoolShutdown)
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Option<ConvertedFrame> {
        self.output_rx.recv_timeout(timeout).ok()
    }

    pub fn output_receiver(&self) -> flume::Receiver<ConvertedFrame> {
        self.output_rx.clone()
    }

    pub fn stats(&self) -> ConverterPoolStats {
        ConverterPoolStats {
            frames_received: self.stats.frames_received.load(Ordering::Relaxed),
            frames_converted: self.stats.frames_converted.load(Ordering::Relaxed),
            frames_dropped: self.stats.frames_dropped.load(Ordering::Relaxed),
            current_queue_depth: self.input_tx.as_ref().map(|tx| tx.len()).unwrap_or(0),
        }
    }

    pub fn return_frame(&self, frame: frame::Video) {
        if let Some(pool) = &self.frame_pool {
            pool.put(frame);
        }
    }

    pub fn frame_pool(&self) -> Option<&Arc<VideoFramePool>> {
        self.frame_pool.as_ref()
    }

    fn pending_frame_count(&self) -> u64 {
        let stats = self.stats();
        stats
            .frames_received
            .saturating_sub(stats.frames_converted + stats.frames_dropped)
    }

    pub fn drain_with_timeout(
        &mut self,
        mut frame_handler: impl FnMut(ConvertedFrame),
        timeout: Duration,
    ) -> usize {
        self.input_tx.take();

        let deadline = Instant::now() + timeout;
        let mut drained = 0;

        while Instant::now() < deadline {
            match self.output_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => {
                    frame_handler(frame);
                    drained += 1;
                }
                Err(flume::RecvTimeoutError::Timeout) => {
                    if self.pending_frame_count() == 0 {
                        break;
                    }
                }
                Err(flume::RecvTimeoutError::Disconnected) => break,
            }
        }

        self.shutdown.store(true, Ordering::SeqCst);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }

        while let Ok(frame) = self.output_rx.try_recv() {
            frame_handler(frame);
            drained += 1;
        }

        let stats = self.stats();
        info!(
            "Converter pool drained: {} frames collected, {} received, {} converted, {} dropped",
            drained, stats.frames_received, stats.frames_converted, stats.frames_dropped
        );

        drained
    }

    fn do_shutdown(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.input_tx.take();

        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }

        let stats = self.stats();
        info!(
            "Converter pool shutdown: {} received, {} converted, {} dropped",
            stats.frames_received, stats.frames_converted, stats.frames_dropped
        );
    }
}

struct WorkerContext {
    worker_id: usize,
    input_rx: flume::Receiver<InputFrame>,
    output_tx: flume::Sender<ConvertedFrame>,
    shutdown: Arc<AtomicBool>,
    stats: Arc<PoolStats>,
    drop_strategy: DropStrategy,
    frame_pool: Option<Arc<VideoFramePool>>,
}

impl WorkerContext {
    fn convert_input(
        &self,
        converter: &dyn FrameConverter,
        input_frame: frame::Video,
    ) -> Result<frame::Video, ConvertError> {
        let Some(ref pool) = self.frame_pool else {
            return converter.convert(input_frame);
        };

        let mut output = pool.get();
        match converter.convert_into(input_frame, &mut output) {
            Ok(()) => Ok(output),
            Err(e) => {
                pool.put(output);
                Err(e)
            }
        }
    }

    fn recycle_frame(&self, frame: frame::Video) {
        if let Some(ref pool) = self.frame_pool {
            pool.put(frame);
        }
    }

    fn deliver_converted(&self, converted_frame: ConvertedFrame) -> bool {
        match self.output_tx.try_send(converted_frame) {
            Ok(()) => true,
            Err(flume::TrySendError::Full(dropped_frame)) => {
                match self.drop_strategy {
                    DropStrategy::DropOldest | DropStrategy::DropNewest => {
                        self.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                self.recycle_frame(dropped_frame.frame);
                true
            }
            Err(flume::TrySendError::Disconnected(dropped_frame)) => {
                self.recycle_frame(dropped_frame.frame);
                false
            }
        }
    }

    fn process_one(
        &self,
        converter: &dyn FrameConverter,
        input: InputFrame,
        counters: &mut (u64, u64),
    ) -> bool {
        let convert_start = Instant::now();
        match self.convert_input(converter, input.frame) {
            Ok(converted) => {
                counters.0 += 1;
                self.stats.frames_converted.fetch_add(1, Ordering::Relaxed);
                self.deliver_converted(ConvertedFrame {
                    frame: converted,
                    sequence: input.sequence,
                    submit_time: input.submit_time,
                    conversion_duration: convert_start.elapsed(),
                })
            }
            Err(e) => {
                counters.1 += 1;
                if counters.1 % 10 == 1 {
                    warn!(
                        "Worker {}: conversion error (#{} total): {}",
                        self.worker_id, counters.1, e
                    );
                }
                true
            }
        }
    }
}

fn worker_loop(ctx: WorkerContext, converter: Arc<dyn FrameConverter>) {
    let pooling_label = if ctx.frame_pool.is_some() {
        " with frame pooling"
    } else {
        ""
    };
    debug!("Converter worker {} started{}", ctx.worker_id, pooling_label);
    let mut counters = (0u64, 0u64);

    while !ctx.shutdown.load(Ordering::Relaxed) {
        match ctx.input_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(input) => {
                if !ctx.process_one(converter.as_ref(), input, &mut counters) {
                    break;
                }
            }
            Err(flume::RecvTimeoutError::Timeout) => continue,
            Err(flume::RecvTimeoutError::Disconnected) => break,
        }
    }

    debug!(
        "Converter worker {} finished: {} converted, {} errors",
        ctx.worker_id, counters.0, counters.1
    );
}

impl Drop for AsyncConverterPool {
    fn drop(&mut self) {
        self.do_shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_high_res_converter_pool_queues_within_memory_budget() {
        let conversion = ConversionConfig::new(Pixel::BGRA, 3840, 2160, Pixel::NV12, 3840, 2160);
        let requested = ConverterPoolConfig {
            worker_count: 4,
            input_capacity: 120,
            output_capacity: 90,
            drop_strategy: DropStrategy::DropOldest,
            frame_pool_capacity: 16,
        };
        let bounded = requested.bounded_for_conversion(&conversion);
        let in_bytes = estimate_frame_bytes(Pixel::BGRA, 3840, 2160);
        let out_bytes = estimate_frame_bytes(Pixel::NV12, 3840, 2160);
        let retained_bytes = (bounded.input_capacity + bounded.worker_count) * in_bytes
            + (bounded.output_capacity + bounded.frame_pool_capacity + bounded.worker_count)
                * out_bytes;
        assert!(retained_bytes <= CONVERTER_POOL_BYTE_BUDGET);
    }
}
