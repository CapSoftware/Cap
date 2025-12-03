use crate::{ConversionConfig, ConvertError, FrameConverter, create_converter};
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
}

impl Default for ConverterPoolConfig {
    fn default() -> Self {
        Self {
            worker_count: 2,
            input_capacity: 8,
            output_capacity: 8,
            drop_strategy: DropStrategy::DropOldest,
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
        Self::new_with_factory(move |_| Ok(Arc::clone(&converter)), &converter_name, config)
            .expect("Factory using pre-created converter should not fail")
    }

    pub fn from_config(
        conversion_config: ConversionConfig,
        pool_config: ConverterPoolConfig,
    ) -> Result<Self, ConvertError> {
        let first_converter = create_converter(conversion_config.clone())?;
        let converter_name = first_converter.name().to_string();

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
        )
    }

    fn new_with_factory<F>(
        factory: F,
        converter_name: &str,
        config: ConverterPoolConfig,
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

            let handle = thread::Builder::new()
                .name(format!("converter-worker-{}", worker_id))
                .spawn(move || {
                    let converter = match factory(worker_id) {
                        Ok(c) => c,
                        Err(e) => {
                            warn!("Worker {} failed to create converter: {}", worker_id, e);
                            return;
                        }
                    };
                    worker_loop(
                        worker_id,
                        converter,
                        input_rx,
                        output_tx,
                        shutdown,
                        stats,
                        drop_strategy,
                    );
                })
                .expect("Failed to spawn converter worker thread");

            workers.push(handle);
        }

        info!(
            "AsyncConverterPool started with {} workers using {} converter",
            config.worker_count, converter_name
        );

        Ok(Self {
            input_tx: Some(input_tx),
            output_rx,
            workers,
            shutdown,
            stats,
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
                if dropped % 30 == 0 {
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

fn worker_loop(
    worker_id: usize,
    converter: Arc<dyn FrameConverter>,
    input_rx: flume::Receiver<InputFrame>,
    output_tx: flume::Sender<ConvertedFrame>,
    shutdown: Arc<AtomicBool>,
    stats: Arc<PoolStats>,
    drop_strategy: DropStrategy,
) {
    debug!("Converter worker {} started", worker_id);
    let mut local_converted = 0u64;
    let mut local_errors = 0u64;

    while !shutdown.load(Ordering::Relaxed) {
        match input_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(input) => {
                let sequence = input.sequence;
                let submit_time = input.submit_time;
                let convert_start = Instant::now();
                match converter.convert(input.frame) {
                    Ok(converted) => {
                        let conversion_duration = convert_start.elapsed();
                        local_converted += 1;
                        stats.frames_converted.fetch_add(1, Ordering::Relaxed);

                        match output_tx.try_send(ConvertedFrame {
                            frame: converted,
                            sequence,
                            submit_time,
                            conversion_duration,
                        }) {
                            Ok(()) => {}
                            Err(flume::TrySendError::Full(_frame)) => match drop_strategy {
                                DropStrategy::DropOldest | DropStrategy::DropNewest => {
                                    stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
                                }
                            },
                            Err(flume::TrySendError::Disconnected(_)) => {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        local_errors += 1;
                        if local_errors % 10 == 1 {
                            warn!(
                                "Worker {}: conversion error (#{} total): {}",
                                worker_id, local_errors, e
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
        worker_id, local_converted, local_errors
    );
}

impl Drop for AsyncConverterPool {
    fn drop(&mut self) {
        self.do_shutdown();
    }
}
