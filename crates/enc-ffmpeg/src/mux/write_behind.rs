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
//! Finishing drains the queue while storage keeps making progress, bounded
//! by [`DRAIN_NO_PROGRESS_LIMIT`] without a completed write and
//! [`DRAIN_TOTAL_LIMIT`] overall. Past the total limit the unwritten tail is
//! discarded and the output is finalized normally ([`DrainOutcome::Truncated`]).
//! When no write completes for the no-progress limit, finishing returns
//! [`DrainOutcome::Stuck`] without the trailer or final manifest, leaving the
//! files in the state recovery expects from an interrupted recording. As with
//! an encoder blocked in an inline write, the queued packets still reach disk
//! once storage recovers. Dropping a writer that was never finished discards
//! its queue instead and touches nothing after its current call returns.

use crate::base::PacketSink;
use ffmpeg::{Packet, Rational, format};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
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
// unjoined pipeline stop gives up after 10 s; draining for at most 4 s keeps
// the trailer and manifest inside that window.
pub(crate) const DRAIN_NO_PROGRESS_LIMIT: Duration = Duration::from_secs(4);
pub(crate) const DRAIN_TOTAL_LIMIT: Duration = Duration::from_secs(4);
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrainOutcome {
    Complete,
    Truncated { packets: usize, bytes: usize },
    Stuck,
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
        match WriteBehind::spawn(label, target, budget, DrainLimits::DEFAULT) {
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

    /// Marks the following packets as the end-of-stream flush: they bypass
    /// the budget and their write errors are reported by [`Self::close`],
    /// as an inline flush would report them.
    pub fn begin_finish(&mut self) {
        if let Self::Behind(writer) = self {
            writer.begin_finish();
        }
    }

    /// Drains the queued packets within the drain limits. An `Err` is the
    /// first write error among the end-of-stream packets.
    pub fn close(&mut self) -> Result<DrainOutcome, ffmpeg::Error> {
        match self {
            Self::Behind(writer) => writer.close(),
            Self::Direct(_) | Self::Detached => Ok(DrainOutcome::Complete),
        }
    }

    /// Runs the encoder's end-of-stream `flush` into this sink and drains
    /// the writer. `Err` means storage stalled: the output was abandoned and
    /// must not be finalized.
    pub fn finish_flush(
        &mut self,
        flush: impl FnOnce(&mut Self) -> Result<(), ffmpeg::Error>,
    ) -> Result<Result<(), ffmpeg::Error>, StorageStalled> {
        self.begin_finish();
        let flush_result = flush(self);
        match self.close() {
            Ok(DrainOutcome::Stuck) => Err(StorageStalled),
            Ok(DrainOutcome::Complete | DrainOutcome::Truncated { .. }) => Ok(flush_result),
            Err(error) => Ok(flush_result.and(Err(error))),
        }
    }

    #[cfg(test)]
    pub fn drain(&self) {
        if let Self::Behind(writer) = self {
            writer.drain();
        }
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
struct DrainLimits {
    no_progress: Duration,
    total: Duration,
}

impl DrainLimits {
    const DEFAULT: Self = Self {
        no_progress: DRAIN_NO_PROGRESS_LIMIT,
        total: DRAIN_TOTAL_LIMIT,
    };
}

struct Queue {
    packets: VecDeque<(Packet, bool)>,
    bytes: usize,
    in_flight: bool,
    closed: bool,
    finishing: bool,
    exited: bool,
    completed_writes: u64,
    write_errors: u64,
    final_error: Option<ffmpeg::Error>,
}

struct Shared<M> {
    queue: Mutex<Queue>,
    changed: Condvar,
    abandoned: AtomicBool,
    target: Mutex<M>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl<M> Shared<M> {
    fn wait<'a>(&self, queue: MutexGuard<'a, Queue>, timeout: Duration) -> MutexGuard<'a, Queue> {
        self.changed
            .wait_timeout(queue, timeout)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0
    }

    fn abandon(&self, queue: &mut Queue) -> (usize, usize) {
        self.abandoned.store(true, Ordering::Release);
        let packets = queue.packets.len();
        let bytes = queue
            .packets
            .drain(..)
            .map(|(packet, _)| packet.size())
            .sum::<usize>();
        queue.bytes -= bytes;
        self.changed.notify_all();
        (packets, bytes)
    }
}

pub(crate) struct WriteBehind<M: MuxTarget> {
    shared: Arc<Shared<M>>,
    time_bases: Vec<Rational>,
    budget: usize,
    label: &'static str,
    limits: DrainLimits,
    thread: Option<JoinHandle<()>>,
}

impl<M: MuxTarget> WriteBehind<M> {
    fn spawn(
        label: &'static str,
        target: M,
        budget: usize,
        limits: DrainLimits,
    ) -> Result<Self, (M, std::io::Error)> {
        let time_bases = target
            .output()
            .streams()
            .map(|stream| stream.time_base())
            .collect();
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                packets: VecDeque::new(),
                bytes: 0,
                in_flight: false,
                closed: false,
                finishing: false,
                exited: false,
                completed_writes: 0,
                write_errors: 0,
                final_error: None,
            }),
            changed: Condvar::new(),
            abandoned: AtomicBool::new(false),
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
        let final_packet = queue.finishing;
        queue.packets.push_back((packet, final_packet));
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
        while (!queue.packets.is_empty() || queue.in_flight) && !queue.exited {
            queue = self.shared.wait(queue, WAIT_POLL);
        }
    }

    fn close(&mut self) -> Result<DrainOutcome, ffmpeg::Error> {
        let Some(thread) = self.thread.take() else {
            return Ok(DrainOutcome::Complete);
        };
        let started = Instant::now();
        let mut last_progress = started;
        let mut queue = lock(&self.shared.queue);
        queue.closed = true;
        self.shared.changed.notify_all();
        let mut seen_writes = queue.completed_writes;
        let mut truncated = None;
        while !queue.exited {
            if queue.completed_writes != seen_writes {
                seen_writes = queue.completed_writes;
                last_progress = Instant::now();
            }
            if last_progress.elapsed() >= self.limits.no_progress {
                tracing::error!(
                    writer = self.label,
                    stalled_ms = last_progress.elapsed().as_millis() as u64,
                    queued_packets = queue.packets.len(),
                    queued_bytes = queue.bytes,
                    "Output storage made no progress while finishing; leaving the recording for recovery and writing the buffer once storage recovers"
                );
                return Ok(DrainOutcome::Stuck);
            }
            if truncated.is_none() && started.elapsed() >= self.limits.total {
                let (packets, bytes) = self.shared.abandon(&mut queue);
                tracing::warn!(
                    writer = self.label,
                    discarded_packets = packets,
                    discarded_bytes = bytes,
                    "Output storage too slow to drain the write-behind buffer; finishing without its tail"
                );
                truncated = Some(DrainOutcome::Truncated { packets, bytes });
            }
            queue = self.shared.wait(queue, WAIT_POLL);
        }
        let final_error = queue.final_error.take();
        drop(queue);
        let panicked = thread.join().is_err();
        match final_error {
            Some(error) => Err(error),
            None if panicked => Err(ffmpeg::Error::Bug),
            None => Ok(truncated.unwrap_or(DrainOutcome::Complete)),
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
                if let Some(next) = queue.packets.pop_front() {
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
        let Some((packet, final_packet)) = next else {
            return;
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
            queue.bytes -= size;
            queue.in_flight = false;
            queue.completed_writes += 1;
            if let Some(Err(error)) = &result {
                queue.write_errors += 1;
                if final_packet && queue.final_error.is_none() {
                    queue.final_error = Some(*error);
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

    fn behind(target: NutTarget, budget: usize, limits: DrainLimits) -> MuxSink<NutTarget> {
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

        assert_eq!(sink.close(), Ok(DrainOutcome::Complete));
        sink.with_target(|target| target.output.write_trailer().unwrap());
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
        assert_eq!(sink.close(), Ok(DrainOutcome::Complete));
    }

    #[test]
    fn oversized_packet_is_accepted_into_an_empty_queue() {
        let directory = tempfile::tempdir().unwrap();
        let mut sink = MuxSink::Direct(nut_target(&directory.path().join("out.nut")));
        sink.enable_write_behind("test", 1024).unwrap();
        sink.write_packet(packet(0, 4096)).unwrap();
        assert_eq!(sink.close(), Ok(DrainOutcome::Complete));
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
        sink.begin_finish();
        sink.write_packet(packet(3072, 64)).unwrap();

        assert_eq!(sink.close(), Ok(DrainOutcome::Complete));
        sink.with_target(|target| target.output.write_trailer().unwrap());
        assert_eq!(written_pts(&path), vec![0, 2048, 3072]);
    }

    #[test]
    fn end_of_stream_write_errors_are_reported_like_an_inline_flush() {
        let directory = tempfile::tempdir().unwrap();
        let mut sink = MuxSink::Direct(nut_target(&directory.path().join("out.nut")));
        sink.enable_write_behind("test", 1 << 20).unwrap();
        sink.write_packet(packet(0, 64)).unwrap();
        sink.begin_finish();
        sink.write_packet(invalid_packet(1024)).unwrap();
        assert!(sink.close().is_err());
    }

    #[test]
    fn finish_returns_on_stuck_storage_and_keeps_the_buffer_for_when_it_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.nut");
        let packets = 8usize;
        let packet_size = 64 * 1024;
        {
            let target = nut_target(&path);
            let limits = DrainLimits {
                no_progress: Duration::from_millis(200),
                total: Duration::from_secs(30),
            };
            let mut sink = behind(target, 1 << 20, limits);
            let shared = shared(&sink);
            let stalled = lock(&shared.target);
            for pts in 0..packets {
                sink.write_packet(packet(pts as i64 * 1024, packet_size))
                    .unwrap();
            }
            let started = Instant::now();
            assert_eq!(sink.close(), Ok(DrainOutcome::Stuck));
            assert!(started.elapsed() < Duration::from_secs(2));
            drop(sink);
            drop(stalled);
            let deadline = Instant::now() + Duration::from_secs(2);
            while Arc::strong_count(&shared) > 1 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(Arc::strong_count(&shared), 1);
        }
        assert!(
            std::fs::metadata(&path).unwrap().len()
                >= header_only_len(directory.path()) + (packets * packet_size) as u64
        );
    }

    #[test]
    fn slow_storage_drains_within_the_total_limit_then_finishes_without_the_tail() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.nut");
        let mut target = nut_target(&path);
        target.write_delay = Duration::from_millis(60);
        let limits = DrainLimits {
            no_progress: Duration::from_secs(2),
            total: Duration::from_millis(300),
        };
        let mut sink = behind(target, 1 << 20, limits);
        for pts in 0..40 {
            sink.write_packet(packet(pts * 1024, 64)).unwrap();
        }
        let started = Instant::now();
        let outcome = sink.close().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        let DrainOutcome::Truncated { packets, .. } = outcome else {
            panic!("expected a truncated drain, got {outcome:?}");
        };
        assert!(packets > 0);
        sink.with_target(|target| {
            target.write_delay = Duration::ZERO;
            target.output.write_trailer().unwrap();
        });
        let pts = written_pts(&path);
        assert_eq!(pts.len() + packets, 40);
        assert_eq!(
            pts,
            (0..pts.len() as i64)
                .map(|pts| pts * 1024)
                .collect::<Vec<_>>()
        );
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
        let mut sink = behind(target, 1 << 20, DrainLimits::DEFAULT);
        sink.write_packet(packet(0, 64)).unwrap();
        let shared = shared(&sink);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !lock(&shared.queue).exited && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(sink.write_packet(packet(1024, 64)), Err(ffmpeg::Error::Bug));
        assert_eq!(sink.close(), Err(ffmpeg::Error::Bug));
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
