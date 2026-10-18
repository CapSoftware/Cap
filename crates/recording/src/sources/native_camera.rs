use crate::{
    feeds::camera::{self, CameraFeedLock, DropLog, NativeCameraIngress},
    output_pipeline::{
        HealthSender, NativeCameraFrame, PipelineHealthEvent, SetupCtx, VideoSource, emit_health,
    },
};
use anyhow::anyhow;
use cap_media_info::{Pixel, VideoInfo};
use futures::{FutureExt, channel::mpsc, future::BoxFuture};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const CAMERA_SENDER_ATTACH_TIMEOUT: Duration = Duration::from_millis(1500);

/// How long the recording may stop draining camera frames (a runtime stall)
/// before the ingress queue fills.
const INGRESS_TIME_BUDGET_SECS: usize = 2;
/// The camera feed's actor mailbox (kameo's default bounded mailbox). After a
/// stall the feed hands its whole backlog over in one burst, so the ingress
/// queue must take that many frames at once.
const CAMERA_FEED_MAILBOX_FRAMES: usize = 64;
/// Upper bound on the pixel data the ingress queue can keep alive. On macOS a
/// queued frame retains a capture pool surface (the pool grows per retained
/// buffer); on Windows it is a heap copy of the frame.
const INGRESS_BYTE_BUDGET: usize = 256 * 1024 * 1024;
/// The previous fixed capacity; never go below it.
const MIN_INGRESS_FRAMES: usize = 8;

fn frame_bytes(info: &VideoInfo) -> usize {
    let pixels = info.width as usize * info.height as usize;
    match info.pixel_format {
        Pixel::NV12 | Pixel::NV21 | Pixel::YUV420P | Pixel::YUVJ420P => pixels * 3 / 2,
        Pixel::UYVY422 | Pixel::YUYV422 | Pixel::YUV422P | Pixel::YUVJ422P | Pixel::NV16 => {
            pixels * 2
        }
        _ => pixels * 4,
    }
}

/// Frames the native ingress queue holds: the time budget at the camera's
/// frame rate (at least one full feed mailbox), capped by the byte budget.
pub(crate) fn native_ingress_capacity(info: &VideoInfo) -> usize {
    let by_time = (info.fps().max(1) as usize).saturating_mul(INGRESS_TIME_BUDGET_SECS);
    let by_bytes = INGRESS_BYTE_BUDGET / frame_bytes(info).max(1);
    by_time
        .max(CAMERA_FEED_MAILBOX_FRAMES)
        .min(by_bytes)
        .max(MIN_INGRESS_FRAMES)
}

pub struct NativeCamera {
    feed_lock: Arc<CameraFeedLock>,
    stop_tx: Option<oneshot::Sender<()>>,
    stopped: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct IngressSummary {
    pub received: u64,
    pub sent: u64,
    pub mailbox_full: u64,
    pub ingress_full: u64,
    pub forwarder_full: u64,
}

impl IngressSummary {
    fn lost(&self) -> u64 {
        self.mailbox_full + self.ingress_full + self.forwarder_full
    }
}

/// Reports every camera frame this recording loses: at the feed's mailbox
/// (shared by everything attached to the feed), at this recording's ingress
/// queue, and between this source and the encoder. The first loss at each
/// boundary is logged at warn and sent as a health event at once; later
/// losses at most every five seconds; the totals at the end.
pub(crate) struct IngressReporter {
    feed: Option<Arc<NativeCameraIngress>>,
    mailbox_start: u64,
    mailbox_seen: u64,
    ingress_dropped: Arc<AtomicU64>,
    ingress_seen: u64,
    health_tx: Option<HealthSender>,
    feed_log: DropLog,
    forwarder_log: DropLog,
    summary: IngressSummary,
}

impl IngressReporter {
    /// Create before attaching the ingress queue: mailbox losses while it
    /// attaches already affect this recording.
    pub(crate) fn new(
        feed: Option<Arc<NativeCameraIngress>>,
        ingress_dropped: Arc<AtomicU64>,
        health_tx: Option<HealthSender>,
    ) -> Self {
        let mailbox_start = feed.as_ref().map_or(0, |feed| feed.mailbox_full());
        Self {
            feed,
            mailbox_start,
            mailbox_seen: mailbox_start,
            ingress_seen: ingress_dropped.load(Ordering::Relaxed),
            ingress_dropped,
            health_tx,
            feed_log: DropLog::default(),
            forwarder_log: DropLog::default(),
            summary: IngressSummary::default(),
        }
    }

    fn received(&mut self) {
        self.summary.received += 1;
        self.poll_feed(Instant::now());
    }

    fn sent(&mut self) {
        self.summary.sent += 1;
    }

    fn poll_feed(&mut self, now: Instant) {
        let mailbox = self
            .feed
            .as_ref()
            .map_or(self.mailbox_seen, |feed| feed.mailbox_full());
        let ingress = self.ingress_dropped.load(Ordering::Relaxed);
        let new =
            mailbox.saturating_sub(self.mailbox_seen) + ingress.saturating_sub(self.ingress_seen);
        if new == 0 {
            return;
        }
        self.mailbox_seen = mailbox;
        self.ingress_seen = ingress;
        self.summary.mailbox_full = mailbox.saturating_sub(self.mailbox_start);
        self.summary.ingress_full = ingress;
        if let Some(dropped) = self.feed_log.record(new, now) {
            tracing::warn!(
                dropped,
                mailbox_full = self.summary.mailbox_full,
                ingress_full = self.summary.ingress_full,
                "Native camera frames lost before the recording received them"
            );
            self.emit("camera-ingress:feed");
        }
    }

    fn forwarder_full(&mut self, now: Instant) {
        self.summary.forwarder_full += 1;
        if let Some(dropped) = self.forwarder_log.record(1, now) {
            tracing::warn!(
                dropped,
                total = self.summary.forwarder_full,
                "Native camera encoder queue full, frames dropped"
            );
            self.emit("camera-ingress:encoder-queue");
        }
    }

    fn emit(&self, source: &str) {
        let Some(health_tx) = &self.health_tx else {
            return;
        };
        let lost = self.summary.lost();
        let offered = self.summary.received + self.summary.mailbox_full + self.summary.ingress_full;
        emit_health(
            health_tx,
            PipelineHealthEvent::FrameDropRateHigh {
                source: source.to_string(),
                rate_pct: 100.0 * lost as f64 / offered.max(1) as f64,
            },
        );
    }

    fn finish(mut self, elapsed: Duration) -> IngressSummary {
        self.poll_feed(Instant::now());
        let summary = self.summary;
        if summary.lost() > 0 {
            tracing::warn!(
                received = summary.received,
                sent = summary.sent,
                mailbox_full = summary.mailbox_full,
                ingress_full = summary.ingress_full,
                encoder_queue_full = summary.forwarder_full,
                ?elapsed,
                "Native camera source finished with lost frames"
            );
        } else {
            tracing::info!(
                "Native camera source finished: {} received, {} sent, 0 dropped in {:?}",
                summary.received,
                summary.sent,
                elapsed
            );
        }
        summary
    }
}

async fn forward_native_frames<T: Send + 'static>(
    rx: flume::Receiver<T>,
    video_tx: mpsc::Sender<T>,
    stop_rx: oneshot::Receiver<()>,
    stopped: Arc<AtomicBool>,
    required: bool,
    mut report: IngressReporter,
) -> anyhow::Result<IngressSummary> {
    tracing::debug!("Native camera source task started");
    let start = std::time::Instant::now();
    let mut video_tx = video_tx;
    let mut stop_rx = stop_rx.fuse();

    loop {
        if stopped.load(Ordering::Relaxed) {
            tracing::debug!("Native camera source: stop flag set, exiting");
            break;
        }

        tokio::select! {
            biased;
            _ = &mut stop_rx => {
                tracing::debug!("Native camera source: received stop signal");
                break;
            }
            result = rx.recv_async() => {
                match result {
                    Ok(frame) => {
                        report.received();
                        match video_tx.try_send(frame) {
                            Ok(()) => report.sent(),
                            Err(e) => {
                                if e.is_full() {
                                    report.forwarder_full(Instant::now());
                                } else if e.is_disconnected() {
                                    tracing::debug!(
                                        "Native camera source: pipeline closed after {:?}",
                                        report.summary
                                    );
                                    if required && !stopped.load(Ordering::Acquire) {
                                        return Err(anyhow!("Native camera encoder disconnected before Stop"));
                                    }
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::debug!(
                            "Native camera feed disconnected (rx closed) after {} frames in {:?}: {e}",
                            report.summary.received,
                            start.elapsed()
                        );
                        if required && !stopped.load(Ordering::Acquire) {
                            return Err(anyhow!("Native camera feed disconnected before Stop: {e}"));
                        }
                        break;
                    }
                }
            }
        }
    }

    drop(video_tx);

    Ok(report.finish(start.elapsed()))
}

impl VideoSource for NativeCamera {
    type Config = Arc<CameraFeedLock>;
    type Frame = NativeCameraFrame;

    async fn setup(
        feed_lock: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let capacity = native_ingress_capacity(feed_lock.video_info());
        tracing::debug!(capacity, "Native camera ingress queue");
        let (tx, rx) = flume::bounded(capacity);
        let ingress_dropped = Arc::new(AtomicU64::new(0));
        let report = IngressReporter::new(
            Some(feed_lock.native_ingress().clone()),
            ingress_dropped.clone(),
            Some(ctx.health_tx().clone()),
        );

        tokio::time::timeout(
            CAMERA_SENDER_ATTACH_TIMEOUT,
            feed_lock.ask(camera::AddCountedNativeSender(tx, ingress_dropped)),
        )
        .await
        .map_err(|_| anyhow!("Timed out adding native camera sender"))?
        .map_err(|e| anyhow!("Failed to add native camera sender: {e}"))?;

        let (stop_tx, stop_rx) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_clone = stopped.clone();

        let task =
            forward_native_frames(rx, video_tx, stop_rx, stopped_clone, cfg!(windows), report)
                .map(|result| result.map(drop));
        #[cfg(windows)]
        ctx.tasks().spawn("native-camera", task);
        #[cfg(not(windows))]
        drop(tokio::spawn(task));

        Ok(Self {
            feed_lock,
            stop_tx: Some(stop_tx),
            stopped,
        })
    }

    fn video_info(&self) -> VideoInfo {
        *self.feed_lock.video_info()
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            tracing::debug!("Native camera source: stopping");
            self.stopped.store(true, Ordering::SeqCst);
            if let Some(stop_tx) = self.stop_tx.take() {
                let _ = stop_tx.send(());
            }
            Ok(())
        }
        .boxed()
    }
}

#[cfg(test)]
mod forwarding_tests {
    use super::*;
    use futures::StreamExt;

    #[tokio::test]
    async fn required_native_camera_eof_is_not_success() {
        let (sender, receiver) = flume::bounded::<u8>(1);
        let (video, _frames) = mpsc::channel(1);
        let (_stop, stopped) = oneshot::channel();
        drop(sender);
        let result = forward_native_frames(
            receiver,
            video,
            stopped,
            Arc::new(AtomicBool::new(false)),
            true,
            IngressReporter::new(None, Default::default(), None),
        )
        .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("feed disconnected before Stop")
        );
    }

    #[tokio::test]
    async fn native_camera_stop_precedes_ready_eof() {
        let (sender, receiver) = flume::bounded::<u8>(1);
        let (video, mut frames) = mpsc::channel(1);
        let (stop, stopped) = oneshot::channel();
        stop.send(()).unwrap();
        drop(sender);
        forward_native_frames(
            receiver,
            video,
            stopped,
            Arc::new(AtomicBool::new(false)),
            true,
            IngressReporter::new(None, Default::default(), None),
        )
        .await
        .unwrap();
        assert!(frames.next().await.is_none());
    }

    #[tokio::test]
    async fn joined_native_camera_forwarder_has_closed_its_output() {
        let (sender, receiver) = flume::bounded(1);
        let (video, mut frames) = mpsc::channel(1);
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(forward_native_frames(
            receiver,
            video,
            stopped,
            Arc::new(AtomicBool::new(false)),
            true,
            IngressReporter::new(None, Default::default(), None),
        ));
        sender.send_async(17_u8).await.unwrap();
        assert_eq!(frames.next().await, Some(17));
        stop.send(()).unwrap();
        task.await.unwrap().unwrap();
        assert!(frames.next().await.is_none());
        assert!(sender.send_async(18).await.is_err());
    }

    #[tokio::test]
    async fn native_camera_encoder_disconnect_is_required_failure() {
        let (sender, receiver) = flume::bounded(1);
        let (video, frames) = mpsc::channel(1);
        let (_stop, stopped) = oneshot::channel();
        drop(frames);
        sender.send_async(17_u8).await.unwrap();
        let result = forward_native_frames(
            receiver,
            video,
            stopped,
            Arc::new(AtomicBool::new(false)),
            true,
            IngressReporter::new(None, Default::default(), None),
        )
        .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("encoder disconnected before Stop")
        );
    }

    #[tokio::test]
    async fn legacy_native_camera_eof_remains_success() {
        let (sender, receiver) = flume::bounded::<u8>(1);
        let (video, _frames) = mpsc::channel(1);
        let (_stop, stopped) = oneshot::channel();
        drop(sender);
        forward_native_frames(
            receiver,
            video,
            stopped,
            Arc::new(AtomicBool::new(false)),
            false,
            IngressReporter::new(None, Default::default(), None),
        )
        .await
        .unwrap();
    }

    fn info(format: cap_media_info::RawVideoFormat, w: u32, h: u32, fps: u32) -> VideoInfo {
        VideoInfo::from_raw(format, w, h, fps)
    }

    #[test]
    fn ingress_capacity_is_sized_by_time_and_bounded_by_bytes() {
        use cap_media_info::RawVideoFormat::{Bgra, Nv12, Uyvy};
        let cases = [
            (info(Nv12, 1280, 720, 30), 64),
            (info(Nv12, 1920, 1080, 30), 64),
            (info(Nv12, 1280, 720, 60), 120),
            (info(Nv12, 1920, 1080, 60), 86),
            (info(Uyvy, 1920, 1080, 30), 64),
            (info(Nv12, 3840, 2160, 30), 21),
            (info(Bgra, 3840, 2160, 30), MIN_INGRESS_FRAMES),
        ];
        for (info, expected) in cases {
            let capacity = native_ingress_capacity(&info);
            assert_eq!(
                capacity,
                expected,
                "{}x{}@{} {:?}",
                info.width,
                info.height,
                info.fps(),
                info.pixel_format
            );
            assert!(
                capacity == MIN_INGRESS_FRAMES
                    || capacity * frame_bytes(&info) <= INGRESS_BYTE_BUDGET
            );
        }
    }

    #[tokio::test]
    async fn encoder_queue_overflow_is_counted() {
        let (sender, receiver) = flume::bounded(16);
        let (video, frames) = mpsc::channel(1);
        let (_stop, stopped) = oneshot::channel();
        for frame in 0..10_u8 {
            sender.send_async(frame).await.unwrap();
        }
        drop(sender);
        let summary = forward_native_frames(
            receiver,
            video,
            stopped,
            Arc::new(AtomicBool::new(false)),
            false,
            IngressReporter::new(None, Default::default(), None),
        )
        .await
        .unwrap();
        // futures mpsc holds its buffer plus one slot per sender.
        assert_eq!(summary.received, 10);
        assert_eq!(summary.sent, 2);
        assert_eq!(summary.forwarder_full, 8);
        drop(frames);
    }

    #[tokio::test]
    async fn feed_losses_count_from_the_recording_start() {
        let ingress = Arc::new(NativeCameraIngress::default());
        ingress.record_mailbox_full();
        let ingress_dropped = Arc::new(AtomicU64::new(0));
        let report = IngressReporter::new(Some(ingress.clone()), ingress_dropped.clone(), None);
        ingress.record_mailbox_full();
        ingress.record_mailbox_full();
        ingress_dropped.fetch_add(3, Ordering::Relaxed);
        let (sender, receiver) = flume::bounded(4);
        let (video, mut frames) = mpsc::channel(4);
        let (_stop, stopped) = oneshot::channel();
        sender.send_async(1_u8).await.unwrap();
        drop(sender);
        let summary = forward_native_frames(
            receiver,
            video,
            stopped,
            Arc::new(AtomicBool::new(false)),
            false,
            report,
        )
        .await
        .unwrap();
        assert_eq!(summary.mailbox_full, 2);
        assert_eq!(summary.ingress_full, 3);
        assert_eq!(summary.sent, 1);
        assert_eq!(futures::StreamExt::next(&mut frames).await, Some(1));
    }
}
