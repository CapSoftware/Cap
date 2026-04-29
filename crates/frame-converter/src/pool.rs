use crate::{ConversionConfig, ConvertError, FrameConverter, VideoFramePool, create_converter};
use ffmpeg::frame;
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

        let mut workers = Vec::with_capacity(config.worker_count);
        let factory = Arc::new(factory);

        for worker_id in 0..config.worker_count {
            let factory = Arc::clone(&factory);
            let input_rx = input_rx.clone();
            let output_tx = output_tx.clone();
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
    shutdown: Arc<AtomicBool>,
    stats: Arc<PoolStats>,
    drop_strategy: DropStrategy,
    frame_pool: Option<Arc<VideoFramePool>>,
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

                        match ctx.output_tx.try_send(ConvertedFrame {
                            frame: converted,
                            sequence,
                            submit_time,
                            conversion_duration,
                        }) {
                            Ok(()) => {}
                            Err(flume::TrySendError::Full(dropped_frame)) => {
                                match ctx.drop_strategy {
                                    DropStrategy::DropOldest | DropStrategy::DropNewest => {
                                        ctx.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                                if let Some(ref pool) = ctx.frame_pool {
                                    pool.put(dropped_frame.frame);
                                }
                            }
                            Err(flume::TrySendError::Disconnected(dropped_frame)) => {
                                if let Some(ref pool) = ctx.frame_pool {
                                    pool.put(dropped_frame.frame);
                                }
                                break;
                            }
                        }
                    }
                    Err(e) => {
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
