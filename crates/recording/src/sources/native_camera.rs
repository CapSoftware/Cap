use crate::{
    feeds::camera::{self, CameraFeedLock},
    output_pipeline::{NativeCameraFrame, SetupCtx, VideoSource},
};
use anyhow::anyhow;
use cap_media_info::VideoInfo;
use futures::{FutureExt, channel::mpsc, future::BoxFuture};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::oneshot;

const CAMERA_SENDER_ATTACH_TIMEOUT: Duration = Duration::from_millis(1500);

pub struct NativeCamera {
    feed_lock: Arc<CameraFeedLock>,
    stop_tx: Option<oneshot::Sender<()>>,
    stopped: Arc<AtomicBool>,
}

async fn forward_native_frames<T: Send + 'static>(
    rx: flume::Receiver<T>,
    video_tx: mpsc::Sender<T>,
    stop_rx: oneshot::Receiver<()>,
    stopped: Arc<AtomicBool>,
    required: bool,
) -> anyhow::Result<()> {
    tracing::debug!("Native camera source task started");
    let mut frame_count: u64 = 0;
    let mut sent_count: u64 = 0;
    let mut dropped_count: u64 = 0;
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
                        frame_count += 1;
                        match video_tx.try_send(frame) {
                            Ok(()) => {
                                sent_count += 1;
                                if sent_count.is_multiple_of(30) {
                                    tracing::debug!(
                                        "Native camera source: sent {} frames, dropped {} in {:?}",
                                        sent_count,
                                        dropped_count,
                                        start.elapsed()
                                    );
                                }
                            }
                            Err(e) => {
                                if e.is_full() {
                                    dropped_count += 1;
                                    if dropped_count.is_multiple_of(30) {
                                        tracing::warn!(
                                            "Native camera source: encoder can't keep up, dropped {} frames so far",
                                            dropped_count
                                        );
                                    }
                                } else if e.is_disconnected() {
                                    tracing::debug!(
                                        "Native camera source: pipeline closed after {} sent, {} dropped",
                                        sent_count,
                                        dropped_count
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
                            frame_count,
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

    tracing::info!(
        "Native camera source finished: {} received, {} sent, {} dropped in {:?}",
        frame_count,
        sent_count,
        dropped_count,
        start.elapsed()
    );
    Ok(())
}

impl VideoSource for NativeCamera {
    type Config = Arc<CameraFeedLock>;
    type Frame = NativeCameraFrame;

    async fn setup(
        feed_lock: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        _ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (tx, rx) = flume::bounded(8);

        tokio::time::timeout(
            CAMERA_SENDER_ATTACH_TIMEOUT,
            feed_lock.ask(camera::AddNativeSender(tx)),
        )
        .await
        .map_err(|_| anyhow!("Timed out adding native camera sender"))?
        .map_err(|e| anyhow!("Failed to add native camera sender: {e}"))?;

        let (stop_tx, stop_rx) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_clone = stopped.clone();

        let task = forward_native_frames(rx, video_tx, stop_rx, stopped_clone, cfg!(windows));
        #[cfg(windows)]
        _ctx.tasks().spawn("native-camera", task);
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
        )
        .await
        .unwrap();
    }
}
