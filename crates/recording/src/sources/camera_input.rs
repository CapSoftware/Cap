use crate::{
    feeds::camera::{self, CameraFeedLock, MjpegFullResHold},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::NativeCameraFrame,
};
use anyhow::{anyhow, bail};
use cap_media_info::VideoInfo;
use futures::{FutureExt, future::BoxFuture};
use std::{
    sync::{Arc, Mutex, atomic::AtomicU64},
    time::Duration,
};

const CAMERA_SENDER_TIMEOUT: Duration = Duration::from_millis(1500);

/// The camera a camera track records. A Studio camera switch moves the
/// track's queue from the old camera's feed to the new one instead of ending
/// the segment, so the screen and microphone keep recording through it.
pub struct CameraTrackInput<T> {
    state: Arc<Mutex<InputState<T>>>,
}

impl<T> Clone for CameraTrackInput<T> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
        }
    }
}

struct InputState<T> {
    lock: Option<Arc<CameraFeedLock>>,
    track: Option<TrackQueue<T>>,
    full_res: Option<MjpegFullResHold>,
    hold_full_res: bool,
}

struct TrackQueue<T> {
    /// Weak so the track still sees its feed go away.
    sender: flume::WeakSender<T>,
    dropped: Option<Arc<AtomicU64>>,
    /// Keeps the queue open while no camera is attached.
    bridge: Option<flume::Sender<T>>,
    /// Hands the track a queue sized for the camera it switched to.
    next: flume::Sender<flume::Receiver<T>>,
}

pub(crate) struct TrackReceiver<T> {
    rx: flume::Receiver<T>,
    next: flume::Receiver<flume::Receiver<T>>,
}

impl<T> TrackReceiver<T> {
    #[cfg(test)]
    pub(crate) fn fixed(rx: flume::Receiver<T>) -> Self {
        Self {
            rx,
            next: flume::bounded(1).1,
        }
    }

    pub(crate) async fn recv(&mut self) -> Result<T, flume::RecvError> {
        loop {
            tokio::select! {
                biased;
                Ok(rx) = self.next.recv_async() => self.rx = rx,
                frame = self.rx.recv_async() => match frame {
                    Ok(frame) => return Ok(frame),
                    // `attach` queues the replacement before it lets the old
                    // queue close, so a switch that closed it between the two
                    // polls has its replacement waiting here.
                    Err(closed) => match self.next.try_recv() {
                        Ok(rx) => self.rx = rx,
                        Err(_) => return Err(closed),
                    },
                },
            }
        }
    }
}

pub trait CameraTrackFrame: Send + Sized + 'static {
    fn queue_capacity(info: &VideoInfo) -> usize;

    fn add_sender(
        lock: &CameraFeedLock,
        sender: flume::Sender<Self>,
        dropped: Option<Arc<AtomicU64>>,
    ) -> BoxFuture<'static, anyhow::Result<()>>;

    fn remove_sender(
        lock: &CameraFeedLock,
        sender: flume::Sender<Self>,
    ) -> BoxFuture<'static, anyhow::Result<()>>;
}

impl CameraTrackFrame for NativeCameraFrame {
    fn queue_capacity(info: &VideoInfo) -> usize {
        super::native_ingress_capacity(info)
    }

    fn add_sender(
        lock: &CameraFeedLock,
        sender: flume::Sender<Self>,
        dropped: Option<Arc<AtomicU64>>,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        let actor = (**lock).clone();
        async move {
            match dropped {
                Some(dropped) => actor
                    .ask(camera::AddCountedNativeSender(sender, dropped))
                    .await
                    .map_err(|error| anyhow!("{error}")),
                None => actor
                    .ask(camera::AddNativeSender(sender))
                    .await
                    .map_err(|error| anyhow!("{error}")),
            }
        }
        .boxed()
    }

    fn remove_sender(
        lock: &CameraFeedLock,
        sender: flume::Sender<Self>,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        let actor = (**lock).clone();
        async move {
            actor
                .ask(camera::RemoveNativeSender(sender))
                .await
                .map_err(|error| anyhow!("{error}"))
        }
        .boxed()
    }
}

impl CameraTrackFrame for FFmpegVideoFrame {
    fn queue_capacity(_: &VideoInfo) -> usize {
        256
    }

    fn add_sender(
        lock: &CameraFeedLock,
        sender: flume::Sender<Self>,
        _dropped: Option<Arc<AtomicU64>>,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        let actor = (**lock).clone();
        async move {
            actor
                .ask(camera::AddSender(sender))
                .await
                .map_err(|error| anyhow!("{error}"))
        }
        .boxed()
    }

    fn remove_sender(
        lock: &CameraFeedLock,
        sender: flume::Sender<Self>,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        let actor = (**lock).clone();
        async move {
            actor
                .ask(camera::RemoveSender(sender))
                .await
                .map_err(|error| anyhow!("{error}"))
        }
        .boxed()
    }
}

impl<T: CameraTrackFrame> CameraTrackInput<T> {
    pub fn new(lock: Arc<CameraFeedLock>) -> Self {
        Self {
            state: Arc::new(Mutex::new(InputState {
                lock: Some(lock),
                track: None,
                full_res: None,
                hold_full_res: false,
            })),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, InputState<T>> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn lock(&self) -> Option<Arc<CameraFeedLock>> {
        self.state().lock.clone()
    }

    pub(crate) async fn connect(
        &self,
        dropped: Option<Arc<AtomicU64>>,
        hold_full_res: bool,
    ) -> anyhow::Result<TrackReceiver<T>> {
        let lock = self
            .lock()
            .ok_or_else(|| anyhow!("The camera track has no camera"))?;
        let (sender, rx) = flume::bounded(T::queue_capacity(lock.video_info()));
        tokio::time::timeout(
            CAMERA_SENDER_TIMEOUT,
            T::add_sender(&lock, sender.clone(), dropped.clone()),
        )
        .await
        .map_err(|_| anyhow!("Timed out adding the camera sender"))??;
        let (next, next_rx) = flume::bounded(1);
        let mut state = self.state();
        state.track = Some(TrackQueue {
            sender: sender.downgrade(),
            dropped,
            bridge: None,
            next,
        });
        state.hold_full_res = hold_full_res;
        if hold_full_res {
            state.full_res = Some(lock.hold_full_resolution());
        }
        Ok(TrackReceiver { rx, next: next_rx })
    }

    pub fn is_released(&self) -> bool {
        self.state()
            .track
            .as_ref()
            .is_some_and(|track| track.bridge.is_some())
    }

    /// Takes the track off its camera and gives the camera's lock up so the
    /// feed can open another device. The track stays open, without frames,
    /// until `attach`.
    pub async fn release(&self) -> anyhow::Result<()> {
        let (lock, bridge) = {
            let mut state = self.state();
            let Some(track) = state.track.as_mut() else {
                bail!("The camera track is not recording");
            };
            if track.bridge.is_some() {
                bail!("The camera track is already released");
            }
            let Some(bridge) = track.sender.upgrade() else {
                bail!("The camera track has ended");
            };
            track.bridge = Some(bridge.clone());
            state.full_res = None;
            (state.lock.take(), bridge)
        };
        if let Some(lock) = lock {
            match tokio::time::timeout(CAMERA_SENDER_TIMEOUT, T::remove_sender(&lock, bridge)).await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!("Removing the camera track from its feed failed: {error:#}")
                }
                Err(_) => tracing::warn!("Timed out removing the camera track from its feed"),
            }
        }
        Ok(())
    }

    /// Feeds the released track from `lock`'s camera, through a new queue
    /// sized for that camera's frames. The track keeps the size and pixel
    /// format it started with; the encoder scales the new camera's frames to
    /// it.
    pub async fn attach(&self, lock: Arc<CameraFeedLock>) -> anyhow::Result<()> {
        let (dropped, next) = {
            let state = self.state();
            let Some(track) = state.track.as_ref().filter(|track| track.bridge.is_some()) else {
                bail!("The camera track is not released");
            };
            (track.dropped.clone(), track.next.clone())
        };
        let (sender, rx) = flume::bounded(T::queue_capacity(lock.video_info()));
        tokio::time::timeout(
            CAMERA_SENDER_TIMEOUT,
            T::add_sender(&lock, sender.clone(), dropped),
        )
        .await
        .map_err(|_| anyhow!("Timed out adding the camera sender"))??;
        if !matches!(
            tokio::time::timeout(CAMERA_SENDER_TIMEOUT, next.send_async(rx)).await,
            Ok(Ok(()))
        ) {
            T::remove_sender(&lock, sender).await.ok();
            bail!("The camera track stopped taking frames");
        }
        let mut state = self.state();
        if state.hold_full_res {
            state.full_res = Some(lock.hold_full_resolution());
        }
        state.lock = Some(lock);
        if let Some(track) = state.track.as_mut() {
            track.sender = sender.downgrade();
            track.bridge = None;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::camera::synthetic::SyntheticCamera;
    use cap_media_info::{RawVideoFormat, VideoInfo};
    use cap_timestamp::Timestamp;

    fn frame(width: u32, height: u32) -> FFmpegVideoFrame {
        FFmpegVideoFrame {
            inner: ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height),
            timestamp: Timestamp::Instant(std::time::Instant::now()),
        }
    }

    async fn next(rx: &mut TrackReceiver<FFmpegVideoFrame>) -> Option<(u32, u32)> {
        tokio::time::timeout(Duration::from_millis(500), rx.recv())
            .await
            .ok()?
            .ok()
            .map(|frame| (frame.inner.width(), frame.inner.height()))
    }

    /// A switch moves one open track from the first camera to the second:
    /// nothing reaches it in between, the first camera can be opened by
    /// someone else, and the track never sees its queue close.
    #[tokio::test]
    async fn a_released_track_moves_to_another_camera_without_closing() {
        let first = SyntheticCamera::spawn(
            "first",
            VideoInfo::from_raw(RawVideoFormat::Nv12, 64, 36, 30),
        );
        let second = SyntheticCamera::spawn(
            "second",
            VideoInfo::from_raw(RawVideoFormat::Bgra, 96, 54, 60),
        );
        let input =
            CameraTrackInput::<FFmpegVideoFrame>::new(Arc::new(first.lock().await.unwrap()));
        let mut rx = input.connect(None, true).await.unwrap();

        first.push(frame(64, 36)).await;
        assert_eq!(next(&mut rx).await, Some((64, 36)));

        input.release().await.unwrap();
        assert!(input.is_released());
        assert!(input.lock().is_none());
        first.push(frame(64, 36)).await;
        assert_eq!(next(&mut rx).await, None);
        drop(first.lock().await.expect("the released camera is unlocked"));

        input
            .attach(Arc::new(second.lock().await.unwrap()))
            .await
            .unwrap();
        assert!(!input.is_released());
        second.push(frame(96, 54)).await;
        assert_eq!(next(&mut rx).await, Some((96, 54)));
        first.push(frame(64, 36)).await;
        assert_eq!(next(&mut rx).await, None);

        drop(input);
        second.remove_input().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(500), rx.recv())
                .await
                .is_ok_and(|result| result.is_err()),
            "the track sees its feed close once no switch holds it open"
        );
    }

    #[tokio::test]
    async fn only_a_released_track_takes_another_camera() {
        let first = SyntheticCamera::spawn(
            "first",
            VideoInfo::from_raw(RawVideoFormat::Nv12, 64, 36, 30),
        );
        let second = SyntheticCamera::spawn(
            "second",
            VideoInfo::from_raw(RawVideoFormat::Nv12, 64, 36, 30),
        );
        let input =
            CameraTrackInput::<FFmpegVideoFrame>::new(Arc::new(first.lock().await.unwrap()));
        assert!(input.release().await.is_err());
        let _rx = input.connect(None, false).await.unwrap();
        assert!(
            input
                .attach(Arc::new(second.lock().await.unwrap()))
                .await
                .is_err()
        );
        input.release().await.unwrap();
        assert!(input.release().await.is_err());
    }
}
