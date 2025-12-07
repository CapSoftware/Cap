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
use tokio::sync::oneshot;

pub struct NativeCamera {
    feed_lock: Arc<CameraFeedLock>,
    stop_tx: Option<oneshot::Sender<()>>,
    stopped: Arc<AtomicBool>,
}

impl VideoSource for NativeCamera {
    type Config = Arc<CameraFeedLock>;
    type Frame = NativeCameraFrame;

    async fn setup(
        feed_lock: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        _: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (tx, rx) = flume::bounded(256);

        feed_lock
            .ask(camera::AddNativeSender(tx))
            .await
            .map_err(|e| anyhow!("Failed to add native camera sender: {e}"))?;

        let (stop_tx, stop_rx) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_clone = stopped.clone();

        tokio::spawn(async move {
            tracing::debug!("Native camera source task started");
            let mut frame_count: u64 = 0;
            let mut sent_count: u64 = 0;
            let mut dropped_count: u64 = 0;
            let start = std::time::Instant::now();
            let mut video_tx = video_tx;
            let mut stop_rx = stop_rx.fuse();

            loop {
                if stopped_clone.load(Ordering::Relaxed) {
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
        });

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
