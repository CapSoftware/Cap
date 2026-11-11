use crate::{ConversionConfig, ConvertError, FrameConverter, VideoFramePool, create_converter};
use ffmpeg::frame;
use parking_lot::Mutex;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tracing::{debug, info, warn};

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
    output_rx: flume::Receiver<ConvertedFrame>,
    workers: Vec<JoinHandle<()>>,
    shutdown: Arc<AtomicBool>,
    stats: Arc<PoolStats>,
    frame_pool: Option<Arc<VideoFramePool>>,
}

struct PoolStats {
    frames_received: AtomicU64,
    frames_converted: AtomicU64,
    frames_dropped: AtomicU64,
}

impl Default for PoolStats {
    fn default() -> Self {
        Self {
            frames_received: AtomicU64::new(0),
            frames_converted: AtomicU64::new(0),
            frames_dropped: AtomicU64::new(0),
        }
    }
}

impl AsyncConverterPool {
    pub fn new(converter: Arc<dyn FrameConverter>, config: ConverterPoolConfig) -> Self {
        let converter_name = converter.name().to_string();
        Self::new_with_factory(
            move |_| Ok(Arc::clone(&converter)),
            &converter_name,
            config,
            None,
        )
        .expect("Factory using pre-created converter should not fail")
    }

    pub fn from_config(
        conversion_config: ConversionConfig,
        pool_config: ConverterPoolConfig,
    ) -> Result<Self, ConvertError> {
        let first_converter = create_converter(conversion_config.clone())?;
        let converter_name = first_converter.name().to_string();

        let frame_pool = if pool_config.frame_pool_capacity > 0 {
            Some(VideoFramePool::new(
                pool_config.frame_pool_capacity,
                conversion_config.output_format,
                conversion_config.output_width,
                conversion_config.output_height,
            ))
        } else {
            None
        };

        Self::new_with_factory(
            move |worker_id| {
                if worker_id == 0 {
                    Ok(Arc::clone(&first_converter))
                } else {
                    create_converter(conversion_config.clone())
                }
            },
            &converter_name,
            pool_config,
            frame_pool,
        )
    }

    fn new_with_factory<F>(
        factory: F,
        converter_name: &str,
        config: ConverterPoolConfig,
        frame_pool: Option<Arc<VideoFramePool>>,
    ) -> Result<Self, ConvertError>
    where
        F: Fn(usize) -> Result<Arc<dyn FrameConverter>, ConvertError> + Send + Sync + 'static,
    {
        let (input_tx, input_rx) = flume::bounded(config.input_capacity);
        let (output_tx, output_rx) = flume::bounded(config.output_capacity);
        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(PoolStats::default());
        let output_order = Arc::new(Mutex::new(None));

        let mut workers = Vec::with_capacity(config.worker_count);
        let factory = Arc::new(factory);

        for worker_id in 0..config.worker_count {
            let factory = Arc::clone(&factory);
            let input_rx = input_rx.clone();
            let output_tx = output_tx.clone();
            let output_rx = output_rx.clone();
            let output_order = Arc::clone(&output_order);
            let shutdown = Arc::clone(&shutdown);
            let stats = Arc::clone(&stats);
            let drop_strategy = config.drop_strategy;
            let frame_pool = frame_pool.clone();

            let handle = thread::Builder::new()
                .name(format!("converter-worker-{worker_id}"))
                .spawn(move || {
                    let converter = match factory(worker_id) {
                        Ok(c) => c,
                        Err(e) => {
                            warn!("Worker {} failed to create converter: {}", worker_id, e);
                            return;
                        }
                    };
                    worker_loop(WorkerContext {
                        worker_id,
                        converter,
                        input_rx,
                        output_tx,
                        output_rx,
                        output_order,
                        shutdown,
                        stats,
                        drop_strategy,
                        frame_pool,
                    });
                })
                .expect("Failed to spawn converter worker thread");

            workers.push(handle);
        }

        info!(
            "AsyncConverterPool started with {} workers using {} converter{}",
            config.worker_count,
            converter_name,
            if frame_pool.is_some() {
                " with frame pooling"
            } else {
                ""
            }
        );

        Ok(Self {
            input_tx: Some(input_tx),
            output_rx,
            workers,
            shutdown,
            stats,
            frame_pool: frame_pool.clone(),
        })
    }

    pub fn submit(&self, frame: frame::Video, sequence: u64) -> Result<(), ConvertError> {
        let Some(input_tx) = &self.input_tx else {
            return Err(ConvertError::PoolShutdown);
        };

        self.stats.frames_received.fetch_add(1, Ordering::Relaxed);
        let submit_time = Instant::now();

        match input_tx.try_send(InputFrame {
            frame,
            sequence,
            submit_time,
        }) {
            Ok(()) => Ok(()),
            Err(flume::TrySendError::Full(_)) => {
                self.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                let dropped = self.stats.frames_dropped.load(Ordering::Relaxed);
                if dropped.is_multiple_of(30) {
                    warn!(
                        "Converter pool input full, dropped {} frames so far",
                        dropped
                    );
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

    pub fn drain_with_timeout(
        &mut self,
        mut frame_handler: impl FnMut(ConvertedFrame),
        timeout: Duration,
    ) -> usize {
        self.input_tx.take();

        let deadline = std::time::Instant::now() + timeout;
        let mut drained = 0;

        while std::time::Instant::now() < deadline {
            match self.output_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => {
                    frame_handler(frame);
                    drained += 1;
                }
                Err(flume::RecvTimeoutError::Timeout) => {
                    let stats = self.stats();
                    let pending = stats
                        .frames_received
                        .saturating_sub(stats.frames_converted + stats.frames_dropped);
                    if pending == 0 {
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
    converter: Arc<dyn FrameConverter>,
    input_rx: flume::Receiver<InputFrame>,
    output_tx: flume::Sender<ConvertedFrame>,
    output_rx: flume::Receiver<ConvertedFrame>,
    output_order: Arc<Mutex<Option<u64>>>,
    shutdown: Arc<AtomicBool>,
    stats: Arc<PoolStats>,
    drop_strategy: DropStrategy,
    frame_pool: Option<Arc<VideoFramePool>>,
}

struct FullOutputOutcome {
    evicted: Option<ConvertedFrame>,
    rejected: Option<ConvertedFrame>,
}

fn try_send_frame(
    output_tx: &flume::Sender<ConvertedFrame>,
    frame: ConvertedFrame,
) -> Option<ConvertedFrame> {
    match output_tx.try_send(frame) {
        Ok(()) => None,
        Err(flume::TrySendError::Full(frame) | flume::TrySendError::Disconnected(frame)) => {
            Some(frame)
        }
    }
}

fn handle_full_output(
    output_tx: &flume::Sender<ConvertedFrame>,
    output_rx: &flume::Receiver<ConvertedFrame>,
    drop_strategy: DropStrategy,
    frame: ConvertedFrame,
) -> FullOutputOutcome {
    if matches!(drop_strategy, DropStrategy::DropNewest) {
        return FullOutputOutcome {
            evicted: None,
            rejected: Some(frame),
        };
    }

    match output_rx.try_recv() {
        // Callers hold `output_order`, so queued frames are in sequence order
        // and the head is always the oldest.
        Ok(queued) => FullOutputOutcome {
            evicted: Some(queued),
            rejected: try_send_frame(output_tx, frame),
        },
        // The consumer drained the queue between the failed send and this
        // receive, so the frame fits after all; retry rather than drop it.
        Err(flume::TryRecvError::Empty) => FullOutputOutcome {
            evicted: None,
            rejected: try_send_frame(output_tx, frame),
        },
        Err(flume::TryRecvError::Disconnected) => FullOutputOutcome {
            evicted: None,
            rejected: Some(frame),
        },
    }
}

fn worker_loop(ctx: WorkerContext) {
    debug!(
        "Converter worker {} started{}",
        ctx.worker_id,
        if ctx.frame_pool.is_some() {
            " with frame pooling"
        } else {
            ""
        }
    );
    let mut local_converted = 0u64;
    let mut local_errors = 0u64;

    while !ctx.shutdown.load(Ordering::Relaxed) {
        match ctx.input_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(input) => {
                let sequence = input.sequence;
                let submit_time = input.submit_time;
                let convert_start = Instant::now();

                let result = if let Some(ref pool) = ctx.frame_pool {
                    let mut output = pool.get();
                    match ctx.converter.convert_into(input.frame, &mut output) {
                        Ok(()) => Ok(output),
                        Err(e) => {
                            pool.put(output);
                            Err(e)
                        }
                    }
                } else {
                    ctx.converter.convert(input.frame)
                };

                match result {
                    Ok(converted) => {
                        let conversion_duration = convert_start.elapsed();
                        local_converted += 1;
                        ctx.stats.frames_converted.fetch_add(1, Ordering::Relaxed);

                        let converted = ConvertedFrame {
                            frame: converted,
                            sequence,
                            submit_time,
                            conversion_duration,
                        };

                        let mut newest_queued = match ctx.drop_strategy {
                            DropStrategy::DropOldest => Some(ctx.output_order.lock()),
                            DropStrategy::DropNewest => None,
                        };

                        // Workers can finish out of submission order. A frame
                        // older than one already queued would only be skipped
                        // by the FIFO consumer, so drop it before it displaces
                        // a newer frame or rotates the queue.
                        let stale = match newest_queued.as_deref() {
                            Some(Some(newest)) => sequence < *newest,
                            _ => false,
                        };
                        if stale {
                            drop(newest_queued);
                            ctx.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                            if let Some(ref pool) = ctx.frame_pool {
                                pool.put(converted.frame);
                            }
                            continue;
                        }

                        let delivered = match ctx.output_tx.try_send(converted) {
                            Ok(()) => true,
                            Err(flume::TrySendError::Full(rejected_frame)) => {
                                let outcome = handle_full_output(
                                    &ctx.output_tx,
                                    &ctx.output_rx,
                                    ctx.drop_strategy,
                                    rejected_frame,
                                );
                                let delivered = outcome.rejected.is_none();
                                for frame in
                                    [outcome.evicted, outcome.rejected].into_iter().flatten()
                                {
                                    ctx.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                                    if let Some(ref pool) = ctx.frame_pool {
                                        pool.put(frame.frame);
                                    }
                                }
                                delivered
                            }
                            Err(flume::TrySendError::Disconnected(dropped_frame)) => {
                                if let Some(ref pool) = ctx.frame_pool {
                                    pool.put(dropped_frame.frame);
                                }
                                break;
                            }
                        };

                        if delivered && let Some(newest) = newest_queued.as_mut() {
                            **newest = Some(sequence);
                        }
                    }
                    Err(e) => {
                        // Count conversion errors as dropped so they are
                        // subtracted from drain_with_timeout's pending count
                        // instead of looking like they are still in flight.
                        ctx.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                        local_errors += 1;
                        if local_errors % 10 == 1 {
                            warn!(
                                "Worker {}: conversion error (#{} total): {}",
                                ctx.worker_id, local_errors, e
                            );
                        }
                    }
                }
            }
            Err(flume::RecvTimeoutError::Timeout) => {
                continue;
            }
            Err(flume::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }

    debug!(
        "Converter worker {} finished: {} converted, {} errors",
        ctx.worker_id, local_converted, local_errors
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
    use crate::ConverterBackend;
    use ffmpeg::format::Pixel;

    struct SlowConverter(Duration);

    impl FrameConverter for SlowConverter {
        fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
            thread::sleep(self.0);
            Ok(input)
        }

        fn name(&self) -> &'static str {
            "slow-test"
        }

        fn backend(&self) -> ConverterBackend {
            ConverterBackend::Passthrough
        }
    }

    struct PtsDelayConverter;

    impl FrameConverter for PtsDelayConverter {
        fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
            if input.pts() == Some(0) {
                thread::sleep(Duration::from_millis(300));
            }
            Ok(input)
        }

        fn name(&self) -> &'static str {
            "pts-delay-test"
        }

        fn backend(&self) -> ConverterBackend {
            ConverterBackend::Passthrough
        }
    }

    struct ErrorConverter;

    impl FrameConverter for ErrorConverter {
        fn convert(&self, _: frame::Video) -> Result<frame::Video, ConvertError> {
            Err(ConvertError::ConversionFailed("test".to_string()))
        }

        fn name(&self) -> &'static str {
            "error-test"
        }

        fn backend(&self) -> ConverterBackend {
            ConverterBackend::Passthrough
        }
    }

    fn test_frame() -> frame::Video {
        frame::Video::new(Pixel::RGB8, 4, 4)
    }

    fn wait_for_converted(pool: &AsyncConverterPool, converted: u64, dropped: u64) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let stats = pool.stats();
            if stats.frames_converted >= converted && stats.frames_dropped >= dropped {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("pool never reached converted={converted} dropped={dropped}");
    }

    fn drained_sequences(drop_strategy: DropStrategy, expected_dropped: u64) -> (Vec<u64>, u64) {
        let config = ConverterPoolConfig {
            worker_count: 1,
            input_capacity: 16,
            output_capacity: 2,
            drop_strategy,
            frame_pool_capacity: 0,
        };
        let mut pool =
            AsyncConverterPool::new(Arc::new(SlowConverter(Duration::from_millis(20))), config);
        for sequence in 0..4u64 {
            pool.submit(test_frame(), sequence).unwrap();
        }
        wait_for_converted(&pool, 4 - expected_dropped, expected_dropped);

        let sequences = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&sequences);
        let drained = pool.drain_with_timeout(
            move |frame| sink.lock().unwrap().push(frame.sequence),
            Duration::from_secs(5),
        );
        let sequences = Arc::try_unwrap(sequences).unwrap().into_inner().unwrap();
        assert_eq!(drained, sequences.len());
        (sequences, pool.stats().frames_dropped)
    }

    fn converted_frame(sequence: u64) -> ConvertedFrame {
        ConvertedFrame {
            frame: test_frame(),
            sequence,
            submit_time: Instant::now(),
            conversion_duration: Duration::ZERO,
        }
    }

    fn rejected_by_full_queue(
        output_tx: &flume::Sender<ConvertedFrame>,
        frame: ConvertedFrame,
    ) -> ConvertedFrame {
        match output_tx.try_send(frame) {
            Err(flume::TrySendError::Full(frame)) => frame,
            _ => panic!("expected the output queue to be full"),
        }
    }

    #[test]
    fn drop_oldest_evicts_the_queued_head_before_retrying() {
        let (output_tx, output_rx) = flume::bounded(1);
        output_tx.send(converted_frame(1)).unwrap();
        let rejected = rejected_by_full_queue(&output_tx, converted_frame(2));

        let outcome =
            handle_full_output(&output_tx, &output_rx, DropStrategy::DropOldest, rejected);

        assert_eq!(outcome.evicted.unwrap().sequence, 1);
        assert!(outcome.rejected.is_none());
        assert_eq!(output_rx.recv().unwrap().sequence, 2);
    }

    #[test]
    fn drop_oldest_drops_a_late_frame_instead_of_reordering_the_queue() {
        let config = ConverterPoolConfig {
            worker_count: 2,
            input_capacity: 8,
            output_capacity: 8,
            drop_strategy: DropStrategy::DropOldest,
            frame_pool_capacity: 0,
        };
        let mut pool = AsyncConverterPool::new(Arc::new(PtsDelayConverter), config);

        let mut delayed = test_frame();
        delayed.set_pts(Some(0));
        pool.submit(delayed, 0).unwrap();
        for sequence in 1..3u64 {
            let mut frame = test_frame();
            frame.set_pts(Some(sequence as i64));
            pool.submit(frame, sequence).unwrap();
        }

        wait_for_converted(&pool, 3, 1);
        let sequences = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&sequences);
        pool.drain_with_timeout(
            move |frame| sink.lock().unwrap().push(frame.sequence),
            Duration::from_secs(5),
        );

        assert_eq!(*sequences.lock().unwrap(), vec![1, 2]);
        assert_eq!(pool.stats().frames_dropped, 1);
    }

    #[test]
    fn drop_oldest_retries_the_send_when_the_consumer_drained_the_queue() {
        let (output_tx, output_rx) = flume::bounded(1);
        output_tx.send(converted_frame(1)).unwrap();
        let rejected = rejected_by_full_queue(&output_tx, converted_frame(2));
        assert_eq!(output_rx.recv().unwrap().sequence, 1);

        let outcome =
            handle_full_output(&output_tx, &output_rx, DropStrategy::DropOldest, rejected);

        assert!(outcome.evicted.is_none());
        assert!(outcome.rejected.is_none());
        assert_eq!(output_rx.recv().unwrap().sequence, 2);
    }

    #[test]
    fn drop_oldest_evicts_the_queued_head_to_keep_the_freshest_frames() {
        let (sequences, dropped) = drained_sequences(DropStrategy::DropOldest, 2);
        assert_eq!(sequences, vec![2, 3]);
        assert_eq!(dropped, 2);
    }

    #[test]
    fn drop_newest_keeps_the_stale_queued_frames() {
        let (sequences, dropped) = drained_sequences(DropStrategy::DropNewest, 2);
        assert_eq!(sequences, vec![0, 1]);
        assert_eq!(dropped, 2);
    }

    #[test]
    fn conversion_errors_are_counted_as_dropped() {
        let config = ConverterPoolConfig {
            worker_count: 1,
            input_capacity: 8,
            output_capacity: 8,
            drop_strategy: DropStrategy::DropOldest,
            frame_pool_capacity: 0,
        };
        let mut pool = AsyncConverterPool::new(Arc::new(ErrorConverter), config);
        for sequence in 0..3u64 {
            pool.submit(test_frame(), sequence).unwrap();
        }

        let drained = pool.drain_with_timeout(|_| {}, Duration::from_secs(5));

        assert_eq!(drained, 0);
        let stats = pool.stats();
        assert_eq!(stats.frames_received, 3);
        assert_eq!(stats.frames_converted, 0);
        assert_eq!(stats.frames_dropped, 3);
    }
}
