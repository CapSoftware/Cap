//! Write-behind muxing: encoders hand finished packets to a dedicated writer
//! thread that owns the `AVFormatContext`, so a stalled output volume (slow
//! SD card, external or network drive) blocks only that thread instead of
//! the encoder or the async runtime driving it.
//!
//! Packets are written in exactly the order they were produced, so the
//! on-disk bytes are identical to writing inline. Memory is bounded by a byte
//! budget; once it is full the producer blocks until the writer catches up,
//! which is the inline behaviour.
//!
//! Finishing is one bounded operation: the writer drains the queue, then
//! runs the finalization (trailer, final manifest) itself. When storage is
//! still accepting writes after [`FINISH_DRAIN_LIMIT`], the packets still
//! queued are discarded so finalization can start. If finalization has not
//! completed within [`FINISH_LIMIT`], finishing
//! returns [`StorageStalled`]: finalization is cancelled, the files keep the
//! state recovery expects from an interrupted recording, and the packets
//! still queued reach disk once storage recovers, as they would from an
//! encoder blocked in an inline write. Dropping a writer that was never
//! finished discards its queue and touches nothing after its current call.

use crate::base::PacketSink;
use ffmpeg::{Packet, Rational, format};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

const VIDEO_BUFFER_WINDOW_SECS: u64 = 40;
const MIN_VIDEO_BUDGET_BYTES: usize = 32 * 1024 * 1024;
const MAX_VIDEO_BUDGET_BYTES: usize = 512 * 1024 * 1024;
const VIDEO_BUDGET_MEMORY_DIVISOR: u64 = 32;
pub(crate) const AUDIO_BUDGET_BYTES: usize = 16 * 1024 * 1024;
const STALL_LOG_THRESHOLD: Duration = Duration::from_secs(1);
const WRITE_ERROR_LOG_INTERVAL: u64 = 100;
// Muxers join their encoder thread for up to 5 s before finishing, and an
// unjoined pipeline stop gives up after 10 s; finishing within 4 s keeps the
// whole stop inside that window.
pub(crate) const FINISH_DRAIN_LIMIT: Duration = Duration::from_secs(3);
pub(crate) const FINISH_LIMIT: Duration = Duration::from_secs(4);
const STORAGE_MOVING_WINDOW: Duration = Duration::from_secs(1);
const DROP_JOIN_LIMIT: Duration = Duration::from_millis(250);
const WAIT_POLL: Duration = Duration::from_millis(50);

pub(crate) fn video_budget_bytes(bits_per_second: u64) -> usize {
    video_budget_for(bits_per_second, total_memory_bytes())
}

fn video_budget_for(bits_per_second: u64, total_memory: Option<u64>) -> usize {
    let ceiling = total_memory
        .map(|memory| usize::try_from(memory / VIDEO_BUDGET_MEMORY_DIVISOR).unwrap_or(usize::MAX))
        .unwrap_or(MAX_VIDEO_BUDGET_BYTES)
        .clamp(MIN_VIDEO_BUDGET_BYTES, MAX_VIDEO_BUDGET_BYTES);
    let bytes = (bits_per_second / 8).saturating_mul(VIDEO_BUFFER_WINDOW_SECS);
    usize::try_from(bytes)
        .unwrap_or(usize::MAX)
        .clamp(MIN_VIDEO_BUDGET_BYTES, ceiling)
}

fn total_memory_bytes() -> Option<u64> {
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::new().with_memory(sysinfo::MemoryRefreshKind::new().with_ram()),
    );
    Some(system.total_memory()).filter(|memory| *memory > 0)
}

pub(crate) trait MuxTarget: Send + 'static {
    fn output(&self) -> &format::context::Output;

    fn output_mut(&mut self) -> &mut format::context::Output;

    fn writer_started(&mut self) {}

    fn packet_written(&mut self) {}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StorageStalled;

impl From<StorageStalled> for std::io::Error {
    fn from(_: StorageStalled) -> Self {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "output storage stalled while finishing; recording left for recovery",
        )
    }
}

impl From<StorageStalled> for ffmpeg::Error {
    fn from(_: StorageStalled) -> Self {
        ffmpeg::Error::Other {
            errno: ffmpeg::error::EIO,
        }
    }
}

pub(crate) enum MuxSink<M: MuxTarget> {
    Direct(M),
    Behind(WriteBehind<M>),
    Detached,
}

impl<M: MuxTarget> MuxSink<M> {
    pub fn enable_write_behind(
        &mut self,
        label: &'static str,
        budget: usize,
    ) -> std::io::Result<()> {
        if !matches!(self, Self::Direct(_)) {
            return Ok(());
        }
        let Self::Direct(target) = std::mem::replace(self, Self::Detached) else {
            unreachable!("checked above");
        };
        match WriteBehind::spawn(label, target, budget, FinishLimits::DEFAULT) {
            Ok(writer) => {
                *self = Self::Behind(writer);
                Ok(())
            }
            Err((target, error)) => {
                *self = Self::Direct(target);
                Err(error)
            }
        }
    }

    pub fn is_write_behind(&self) -> bool {
        matches!(self, Self::Behind(_))
    }

    pub fn with_target<R>(&mut self, f: impl FnOnce(&mut M) -> R) -> R {
        match self {
            Self::Direct(target) => f(target),
            Self::Behind(writer) => f(&mut writer.target()),
            Self::Detached => unreachable!("mux sink detached"),
        }
    }

    pub fn with_target_ref<R>(&self, f: impl FnOnce(&M) -> R) -> R {
        match self {
            Self::Direct(target) => f(target),
            Self::Behind(writer) => f(&writer.target()),
            Self::Detached => unreachable!("mux sink detached"),
        }
    }

    pub fn frame_queued(&mut self) {
        if let Self::Direct(target) = self {
            target.packet_written();
        }
    }

    /// Runs the encoder's end-of-stream `flush` into this sink, then
    /// `finalize` with the flush result, which also carries write errors of
    /// the end-of-stream packets as an inline flush would. With write-behind
    /// both run within [`FINISH_LIMIT`]; `Err` means storage stalled and the
    /// output was left unfinalized.
    pub fn finish<R: Send + 'static>(
        &mut self,
        flush: impl FnOnce(&mut Self) -> Result<(), ffmpeg::Error>,
        finalize: impl FnOnce(&mut M, Result<(), ffmpeg::Error>) -> R + Send + 'static,
    ) -> Result<R, StorageStalled> {
        if let Self::Behind(writer) = self {
            writer.begin_finish();
        }
        let flush_result = flush(self);
        match self {
            Self::Direct(target) => Ok(finalize(target, flush_result)),
            Self::Behind(writer) => writer.finish(flush_result, finalize),
            Self::Detached => unreachable!("mux sink detached"),
        }
    }

    #[cfg(test)]
    pub fn drain(&self) {
        if let Self::Behind(writer) = self {
            writer.drain();
        }
    }

    #[cfg(test)]
    pub fn stall_storage_for(&self, duration: Duration) -> std::thread::JoinHandle<()> {
        let Self::Behind(writer) = self else {
            panic!("write-behind not enabled");
        };
        let shared = writer.shared.clone();
        let (held_tx, held_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let _held = lock(&shared.target);
            held_tx.send(()).unwrap();
            std::thread::sleep(duration);
        });
        held_rx.recv().unwrap();
        handle
    }
}

impl<M: MuxTarget> PacketSink for MuxSink<M> {
    fn stream_time_base(&self, stream_index: usize) -> Rational {
        match self {
            Self::Direct(target) => target.output().stream_time_base(stream_index),
            Self::Behind(writer) => writer.time_bases[stream_index],
            Self::Detached => unreachable!("mux sink detached"),
        }
    }

    fn write_packet(&mut self, packet: Packet) -> Result<(), ffmpeg::Error> {
        match self {
            Self::Direct(target) => packet.write_interleaved(target.output_mut()),
            Self::Behind(writer) => writer.write_packet(packet),
            Self::Detached => unreachable!("mux sink detached"),
        }
    }
}

#[derive(Clone, Copy)]
struct FinishLimits {
    drain: Duration,
    total: Duration,
}

impl FinishLimits {
    const DEFAULT: Self = Self {
        drain: FINISH_DRAIN_LIMIT,
        total: FINISH_LIMIT,
    };
}

type Finalizer<M> = Box<dyn FnOnce(&mut M, Result<(), ffmpeg::Error>) + Send>;

enum Job<M> {
    Packet { packet: Packet, end_of_stream: bool },
    Finalize(Finalizer<M>),
}

struct Queue<M> {
    jobs: VecDeque<Job<M>>,
    bytes: usize,
    in_flight: bool,
    closed: bool,
    finishing: bool,
    exited: bool,
    last_write_completed: Option<Instant>,
    write_errors: u64,
    end_of_stream_error: Option<ffmpeg::Error>,
}

struct Shared<M> {
    queue: Mutex<Queue<M>>,
    changed: Condvar,
    abandoned: AtomicBool,
    finalize_cancelled: AtomicBool,
    target: Mutex<M>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl<M> Shared<M> {
    fn wait<'a>(
        &self,
        queue: MutexGuard<'a, Queue<M>>,
        timeout: Duration,
    ) -> MutexGuard<'a, Queue<M>> {
        self.changed
            .wait_timeout(queue, timeout)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0
    }

    fn discard_packets(&self, queue: &mut Queue<M>) -> (usize, usize) {
        let mut packets = 0;
        let mut bytes = 0;
        queue.jobs.retain(|job| match job {
            Job::Packet { packet, .. } => {
                packets += 1;
                bytes += packet.size();
                false
            }
            Job::Finalize(_) => true,
        });
        queue.bytes -= bytes;
        self.changed.notify_all();
        (packets, bytes)
    }

    fn abandon(&self, queue: &mut Queue<M>) {
        self.abandoned.store(true, Ordering::Release);
        self.finalize_cancelled.store(true, Ordering::Release);
        queue.jobs.clear();
        queue.bytes = 0;
        self.changed.notify_all();
    }
}

pub(crate) struct WriteBehind<M: MuxTarget> {
    shared: Arc<Shared<M>>,
    time_bases: Vec<Rational>,
    budget: usize,
    label: &'static str,
    limits: FinishLimits,
    thread: Option<JoinHandle<()>>,
}

impl<M: MuxTarget> WriteBehind<M> {
    fn spawn(
        label: &'static str,
        target: M,
        budget: usize,
        limits: FinishLimits,
    ) -> Result<Self, (M, std::io::Error)> {
        let time_bases = target
            .output()
            .streams()
            .map(|stream| stream.time_base())
            .collect();
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                jobs: VecDeque::new(),
                bytes: 0,
                in_flight: false,
                closed: false,
                finishing: false,
                exited: false,
                last_write_completed: None,
                write_errors: 0,
                end_of_stream_error: None,
            }),
            changed: Condvar::new(),
            abandoned: AtomicBool::new(false),
            finalize_cancelled: AtomicBool::new(false),
            target: Mutex::new(target),
        });
        let spawned = std::thread::Builder::new()
            .name(format!("mux-writer-{label}"))
            .spawn({
                let shared = shared.clone();
                move || run_writer(&shared, label)
            });
        let thread = match spawned {
            Ok(thread) => thread,
            Err(error) => {
                let target = Arc::try_unwrap(shared)
                    .ok()
                    .expect("writer thread never started")
                    .target
                    .into_inner()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                return Err((target, error));
            }
        };
        Ok(Self {
            shared,
            time_bases,
            budget,
            label,
            limits,
            thread: Some(thread),
        })
    }

    fn target(&self) -> MutexGuard<'_, M> {
        lock(&self.shared.target)
    }

    fn begin_finish(&mut self) {
        lock(&self.shared.queue).finishing = true;
    }

    fn write_packet(&mut self, packet: Packet) -> Result<(), ffmpeg::Error> {
        let size = packet.size();
        let mut queue = lock(&self.shared.queue);
        let mut blocked_since = None;
        loop {
            if queue.exited {
                return Err(ffmpeg::Error::Bug);
            }
            if queue.finishing || queue.bytes == 0 || queue.bytes + size <= self.budget {
                break;
            }
            if blocked_since.is_none() {
                blocked_since = Some(Instant::now());
                tracing::warn!(
                    writer = self.label,
                    queued_bytes = queue.bytes,
                    budget_bytes = self.budget,
                    "Output write-behind budget exhausted; encoder now waits for storage"
                );
            }
            queue = self.shared.wait(queue, WAIT_POLL);
        }
        queue.bytes += size;
        let end_of_stream = queue.finishing;
        queue.jobs.push_back(Job::Packet {
            packet,
            end_of_stream,
        });
        drop(queue);
        self.shared.changed.notify_all();

        if let Some(since) = blocked_since {
            tracing::warn!(
                writer = self.label,
                waited_ms = since.elapsed().as_millis() as u64,
                "Output write-behind budget recovered"
            );
        }

        Ok(())
    }

    #[cfg(test)]
    fn drain(&self) {
        let mut queue = lock(&self.shared.queue);
        while (!queue.jobs.is_empty() || queue.in_flight) && !queue.exited {
            queue = self.shared.wait(queue, WAIT_POLL);
        }
    }

    fn finish<R: Send + 'static>(
        &mut self,
        flush_result: Result<(), ffmpeg::Error>,
        finalize: impl FnOnce(&mut M, Result<(), ffmpeg::Error>) -> R + Send + 'static,
    ) -> Result<R, StorageStalled> {
        let Some(thread) = self.thread.take() else {
            return Err(StorageStalled);
        };
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        {
            let mut queue = lock(&self.shared.queue);
            queue
                .jobs
                .push_back(Job::Finalize(Box::new(move |target, end_of_stream| {
                    let _ = result_tx.send(finalize(target, flush_result.and(end_of_stream)));
                })));
            queue.closed = true;
        }
        self.shared.changed.notify_all();

        let started = Instant::now();
        let mut truncated = false;
        loop {
            match result_rx.recv_timeout(WAIT_POLL) {
                Ok(result) => {
                    let _ = thread.join();
                    return Ok(result);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = thread.join();
                    tracing::error!(writer = self.label, "Output writer exited before finishing");
                    return Err(StorageStalled);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let storage_moving = lock(&self.shared.queue)
                .last_write_completed
                .is_some_and(|completed| completed.elapsed() < STORAGE_MOVING_WINDOW);
            if !truncated && storage_moving && started.elapsed() >= self.limits.drain {
                truncated = true;
                let (packets, bytes) = self.shared.discard_packets(&mut lock(&self.shared.queue));
                if packets > 0 {
                    tracing::warn!(
                        writer = self.label,
                        discarded_packets = packets,
                        discarded_bytes = bytes,
                        "Output storage too slow to drain the write-behind buffer; finishing without its tail"
                    );
                }
            }
            if started.elapsed() >= self.limits.total {
                self.shared
                    .finalize_cancelled
                    .store(true, Ordering::Release);
                let queue = lock(&self.shared.queue);
                tracing::error!(
                    writer = self.label,
                    queued_bytes = queue.bytes,
                    "Output storage stalled while finishing; leaving the recording for recovery and writing the buffer once storage recovers"
                );
                return Err(StorageStalled);
            }
        }
    }
}

impl<M: MuxTarget> Drop for WriteBehind<M> {
    fn drop(&mut self) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        let mut queue = lock(&self.shared.queue);
        queue.closed = true;
        self.shared.abandon(&mut queue);
        let deadline = Instant::now() + DROP_JOIN_LIMIT;
        while !queue.exited && Instant::now() < deadline {
            queue = self.shared.wait(queue, WAIT_POLL.min(DROP_JOIN_LIMIT));
        }
        let exited = queue.exited;
        drop(queue);
        if exited {
            let _ = thread.join();
        }
    }
}

struct WriterExit<'a, M>(&'a Shared<M>);

impl<M> Drop for WriterExit<'_, M> {
    fn drop(&mut self) {
        let mut queue = lock(&self.0.queue);
        queue.exited = true;
        queue.in_flight = false;
        drop(queue);
        self.0.changed.notify_all();
    }
}

fn run_writer<M: MuxTarget>(shared: &Shared<M>, label: &'static str) {
    let _exit = WriterExit(shared);
    {
        let mut target = lock(&shared.target);
        if !shared.abandoned.load(Ordering::Acquire) {
            target.writer_started();
        }
    }
    loop {
        let next = {
            let mut queue = lock(&shared.queue);
            loop {
                if shared.abandoned.load(Ordering::Acquire) {
                    break None;
                }
                if let Some(next) = queue.jobs.pop_front() {
                    queue.in_flight = true;
                    break Some(next);
                }
                if queue.closed {
                    break None;
                }
                queue = shared
                    .changed
                    .wait(queue)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        let Some(job) = next else {
            return;
        };

        let (packet, end_of_stream) = match job {
            Job::Packet {
                packet,
                end_of_stream,
            } => (packet, end_of_stream),
            Job::Finalize(finalize) => {
                let end_of_stream_error = lock(&shared.queue).end_of_stream_error.take();
                let mut target = lock(&shared.target);
                if !shared.finalize_cancelled.load(Ordering::Acquire) {
                    finalize(&mut target, end_of_stream_error.map_or(Ok(()), Err));
                }
                drop(target);
                lock(&shared.queue).in_flight = false;
                shared.changed.notify_all();
                continue;
            }
        };

        let size = packet.size();
        let started = Instant::now();
        let result = {
            let mut target = lock(&shared.target);
            if shared.abandoned.load(Ordering::Acquire) {
                None
            } else {
                let result = packet.write_interleaved(target.output_mut());
                if !shared.abandoned.load(Ordering::Acquire) {
                    target.packet_written();
                }
                Some(result)
            }
        };
        let elapsed = started.elapsed();

        let (backlog, error_count) = {
            let mut queue = lock(&shared.queue);
            queue.bytes = queue.bytes.saturating_sub(size);
            queue.in_flight = false;
            queue.last_write_completed = Some(Instant::now());
            if let Some(Err(error)) = &result {
                queue.write_errors += 1;
                if end_of_stream && queue.end_of_stream_error.is_none() {
                    queue.end_of_stream_error = Some(*error);
                }
            }
            (queue.bytes, queue.write_errors)
        };
        shared.changed.notify_all();

        if let Some(Err(error)) = result
            && (error_count == 1 || error_count.is_multiple_of(WRITE_ERROR_LOG_INTERVAL))
        {
            tracing::warn!(
                writer = label,
                %error,
                failed_writes = error_count,
                "Failed to write output packet"
            );
        }

        if elapsed >= STALL_LOG_THRESHOLD {
            tracing::warn!(
                writer = label,
                stalled_ms = elapsed.as_millis() as u64,
                backlog_bytes = backlog,
                "Output storage write stalled; capture continued into the write-behind buffer"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NutTarget {
        output: format::context::Output,
        write_delay: Duration,
        panic_on_write: bool,
    }

    impl MuxTarget for NutTarget {
        fn output(&self) -> &format::context::Output {
            &self.output
        }

        fn output_mut(&mut self) -> &mut format::context::Output {
            assert!(!self.panic_on_write, "simulated writer failure");
            std::thread::sleep(self.write_delay);
            &mut self.output
        }
    }

    fn nut_target(path: &std::path::Path) -> NutTarget {
        ffmpeg::init().unwrap();
        let mut output = format::output_as(path, "nut").unwrap();
        let codec = ffmpeg::encoder::find(ffmpeg::codec::Id::PCM_S16LE).unwrap();
        let mut stream = output.add_stream(codec).unwrap();
        stream.set_time_base(Rational::new(1, 48_000));
        unsafe {
            let parameters = (*stream.as_mut_ptr()).codecpar;
            (*parameters).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_AUDIO;
            (*parameters).codec_id = ffmpeg::ffi::AVCodecID::AV_CODEC_ID_PCM_S16LE;
            (*parameters).sample_rate = 48_000;
            ffmpeg::ffi::av_channel_layout_default(&mut (*parameters).ch_layout, 1);
        }
        output.write_header().unwrap();
        NutTarget {
            output,
            write_delay: Duration::ZERO,
            panic_on_write: false,
        }
    }

    fn packet(pts: i64, size: usize) -> Packet {
        let mut packet = Packet::copy(&vec![0u8; size]);
        packet.set_stream(0);
        packet.set_pts(Some(pts));
        packet.set_dts(Some(pts));
        packet.set_duration(1024);
        packet
    }

    fn invalid_packet(pts: i64) -> Packet {
        let mut packet = packet(pts, 16);
        packet.set_stream(7);
        packet
    }

    fn behind(target: NutTarget, budget: usize, limits: FinishLimits) -> MuxSink<NutTarget> {
        MuxSink::Behind(
            WriteBehind::spawn("test", target, budget, limits)
                .ok()
                .unwrap(),
        )
    }

    fn shared(sink: &MuxSink<NutTarget>) -> Arc<Shared<NutTarget>> {
        match sink {
            MuxSink::Behind(writer) => writer.shared.clone(),
            _ => panic!("write-behind not enabled"),
        }
    }

    fn header_only_len(directory: &std::path::Path) -> u64 {
        let path = directory.join("header-only.nut");
        drop(nut_target(&path));
        std::fs::metadata(path).unwrap().len()
    }

    fn finish_with_trailer(sink: &mut MuxSink<NutTarget>) -> Result<(), ffmpeg::Error> {
        sink.finish(
            |_| Ok(()),
            |target, result| {
                target.output.write_trailer().unwrap();
                result
            },
        )
        .unwrap()
    }

    fn written_pts(path: &std::path::Path) -> Vec<i64> {
        let mut input = format::input(path).unwrap();
        input
            .packets()
            .filter_map(|(_, packet)| packet.pts())
            .collect()
    }

    #[test]
    fn producer_runs_ahead_of_a_stalled_writer_and_order_is_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.nut");
        let mut sink = MuxSink::Direct(nut_target(&path));
        sink.enable_write_behind("test", 1 << 20).unwrap();
        assert!(sink.is_write_behind());

        let shared = shared(&sink);
        let stalled = lock(&shared.target);
        let started = Instant::now();
        for pts in 0..64 {
            sink.write_packet(packet(pts * 1024, 2048)).unwrap();
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(stalled);

        finish_with_trailer(&mut sink).unwrap();
        assert_eq!(
            written_pts(&path),
            (0..64).map(|pts| pts * 1024).collect::<Vec<_>>()
        );
    }

    #[test]
    fn exhausted_budget_falls_back_to_waiting_for_storage() {
        let directory = tempfile::tempdir().unwrap();
        let mut sink = MuxSink::Direct(nut_target(&directory.path().join("out.nut")));
        sink.enable_write_behind("test", 8 * 1024).unwrap();
        let shared = shared(&sink);

        let stalled = lock(&shared.target);
        for pts in 0..4 {
            sink.write_packet(packet(pts * 1024, 2048)).unwrap();
        }
        let producer = std::thread::spawn(move || {
            let started = Instant::now();
            sink.write_packet(packet(4 * 1024, 2048)).unwrap();
            (sink, started.elapsed())
        });
        std::thread::sleep(Duration::from_millis(300));
        drop(stalled);
        let (mut sink, waited) = producer.join().unwrap();
        assert!(waited >= Duration::from_millis(250));
        finish_with_trailer(&mut sink).unwrap();
    }

    #[test]
    fn oversized_packet_is_accepted_into_an_empty_queue() {
        let directory = tempfile::tempdir().unwrap();
        let mut sink = MuxSink::Direct(nut_target(&directory.path().join("out.nut")));
        sink.enable_write_behind("test", 1024).unwrap();
        sink.write_packet(packet(0, 4096)).unwrap();
        finish_with_trailer(&mut sink).unwrap();
    }

    #[test]
    fn earlier_write_errors_never_abort_the_end_of_stream_flush() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.nut");
        let mut sink = MuxSink::Direct(nut_target(&path));
        sink.enable_write_behind("test", 1 << 20).unwrap();

        sink.write_packet(packet(0, 64)).unwrap();
        sink.write_packet(invalid_packet(1024)).unwrap();
        sink.drain();
        sink.write_packet(packet(2048, 64)).unwrap();
        let result = sink
            .finish(
                |sink| sink.write_packet(packet(3072, 64)),
                |target, result| {
                    target.output.write_trailer().unwrap();
                    result
                },
            )
            .unwrap();

        assert_eq!(result, Ok(()));
        assert_eq!(written_pts(&path), vec![0, 2048, 3072]);
    }

    #[test]
    fn end_of_stream_write_errors_are_reported_like_an_inline_flush() {
        let directory = tempfile::tempdir().unwrap();
        let mut sink = MuxSink::Direct(nut_target(&directory.path().join("out.nut")));
        sink.enable_write_behind("test", 1 << 20).unwrap();
        sink.write_packet(packet(0, 64)).unwrap();
        let result = sink
            .finish(
                |sink| sink.write_packet(invalid_packet(1024)),
                |_, result| result,
            )
            .unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn stalled_finish_returns_in_time_and_keeps_the_buffer_for_when_storage_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.nut");
        let packets = 8usize;
        let packet_size = 64 * 1024;
        let finalized = Arc::new(AtomicBool::new(false));
        {
            let limits = FinishLimits {
                drain: Duration::from_millis(100),
                total: Duration::from_millis(300),
            };
            let mut sink = behind(nut_target(&path), 1 << 20, limits);
            let shared = shared(&sink);
            let stalled = lock(&shared.target);
            for pts in 0..packets {
                sink.write_packet(packet(pts as i64 * 1024, packet_size))
                    .unwrap();
            }
            let started = Instant::now();
            let finalized_flag = finalized.clone();
            let result = sink.finish(
                |_| Ok(()),
                move |_, _| finalized_flag.store(true, Ordering::Release),
            );
            assert_eq!(result, Err(StorageStalled));
            assert!(started.elapsed() < Duration::from_secs(1));
            drop(sink);
            drop(stalled);
            let deadline = Instant::now() + Duration::from_secs(2);
            while Arc::strong_count(&shared) > 1 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(Arc::strong_count(&shared), 1);
        }
        assert!(!finalized.load(Ordering::Acquire));
        assert!(
            std::fs::metadata(&path).unwrap().len()
                >= header_only_len(directory.path()) + (packets * packet_size) as u64
        );
    }

    #[test]
    fn slow_storage_finishes_without_the_tail_within_the_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.nut");
        let mut target = nut_target(&path);
        target.write_delay = Duration::from_millis(60);
        let limits = FinishLimits {
            drain: Duration::from_millis(300),
            total: Duration::from_secs(2),
        };
        let mut sink = behind(target, 1 << 20, limits);
        for pts in 0..40 {
            sink.write_packet(packet(pts * 1024, 64)).unwrap();
        }
        let started = Instant::now();
        let result = sink
            .finish(
                |_| Ok(()),
                |target, result| {
                    target.write_delay = Duration::ZERO;
                    target.output.write_trailer().unwrap();
                    result
                },
            )
            .unwrap();
        assert_eq!(result, Ok(()));
        assert!(started.elapsed() < Duration::from_secs(2));
        let pts = written_pts(&path);
        assert!(!pts.is_empty() && pts.len() < 40);
        assert_eq!(
            pts,
            (0..pts.len() as i64)
                .map(|pts| pts * 1024)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn slow_finalization_counts_against_the_finish_limit() {
        let directory = tempfile::tempdir().unwrap();
        let limits = FinishLimits {
            drain: Duration::from_millis(100),
            total: Duration::from_millis(300),
        };
        let mut sink = behind(
            nut_target(&directory.path().join("out.nut")),
            1 << 20,
            limits,
        );
        sink.write_packet(packet(0, 64)).unwrap();
        let started = Instant::now();
        let result = sink.finish(
            |_| Ok(()),
            |_, _| std::thread::sleep(Duration::from_secs(1)),
        );
        assert_eq!(result, Err(StorageStalled));
        assert!(started.elapsed() < Duration::from_millis(900));
    }

    #[test]
    fn dropping_without_finish_stops_the_writer_promptly() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.nut");
        let shared;
        {
            let mut sink = MuxSink::Direct(nut_target(&path));
            sink.enable_write_behind("test", 1 << 20).unwrap();
            shared = self::shared(&sink);
            let stalled = lock(&shared.target);
            for pts in 0..16 {
                sink.write_packet(packet(pts * 1024, 64 * 1024)).unwrap();
            }
            let dropping = std::thread::spawn(move || {
                let started = Instant::now();
                drop(sink);
                started.elapsed()
            });
            std::thread::sleep(Duration::from_millis(50));
            let drop_time = dropping.join().unwrap();
            assert!(drop_time < Duration::from_millis(600));
            drop(stalled);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Arc::strong_count(&shared) > 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(Arc::strong_count(&shared), 1);
        drop(shared);
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            header_only_len(directory.path())
        );
    }

    #[test]
    fn idle_writer_drop_joins_the_thread() {
        let directory = tempfile::tempdir().unwrap();
        let mut sink = MuxSink::Direct(nut_target(&directory.path().join("out.nut")));
        sink.enable_write_behind("test", 1 << 20).unwrap();
        let shared = shared(&sink);
        drop(sink);
        assert_eq!(Arc::strong_count(&shared), 1);
    }

    #[test]
    fn writer_panic_is_reported_on_the_next_enqueue() {
        let directory = tempfile::tempdir().unwrap();
        let mut target = nut_target(&directory.path().join("out.nut"));
        target.panic_on_write = true;
        let mut sink = behind(target, 1 << 20, FinishLimits::DEFAULT);
        sink.write_packet(packet(0, 64)).unwrap();
        let shared = shared(&sink);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !lock(&shared.queue).exited && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(sink.write_packet(packet(1024, 64)), Err(ffmpeg::Error::Bug));
        assert_eq!(
            sink.finish(|_| Ok(()), |_, result| result),
            Err(StorageStalled)
        );
    }

    #[test]
    fn video_budget_scales_with_bitrate_and_machine_memory() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(video_budget_for(0, Some(16 * GIB)), MIN_VIDEO_BUDGET_BYTES);
        assert_eq!(video_budget_for(20_000_000, Some(16 * GIB)), 100_000_000);
        assert_eq!(
            video_budget_for(u64::MAX, Some(16 * GIB)),
            MAX_VIDEO_BUDGET_BYTES
        );
        assert_eq!(video_budget_for(u64::MAX, Some(8 * GIB)), 256 * 1024 * 1024);
        assert_eq!(
            video_budget_for(u64::MAX, Some(GIB)),
            MIN_VIDEO_BUDGET_BYTES
        );
        assert_eq!(video_budget_for(u64::MAX, None), MAX_VIDEO_BUDGET_BYTES);
    }
}
