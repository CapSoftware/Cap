use crate::sources::audio_mixer::AudioMixer;
use anyhow::anyhow;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{
    FutureExt, SinkExt, StreamExt,
    channel::{mpsc, oneshot},
    future::BoxFuture,
};
use kameo::prelude::*;
use std::{
    future,
    path::{Path, PathBuf},
    pin::pin,
    time::Duration,
};
use tokio::{sync::broadcast, task::JoinHandle};
use tokio_util::sync::{CancellationToken, DropGuard};
use tracing::*;

pub struct OutputPipeline {
    pub path: PathBuf,
    pub first_timestamp_rx: mpsc::Receiver<Timestamp>,
    pub stop_tx: broadcast::Sender<()>,
    pub done_rx: oneshot::Receiver<anyhow::Result<()>>,
}

pub struct OutputPipelineInternal {
    first_tx: mpsc::Sender<Timestamp>,
    stop_rx: broadcast::Receiver<()>,
    error_tx: mpsc::Sender<anyhow::Error>,
}

pub struct OutputPipelineStopRx(broadcast::Receiver<()>);

pub struct OutputPipelineFrameHandler(mpsc::Sender<Timestamp>);

impl OutputPipelineFrameHandler {
    pub fn handle_frame(&mut self, timestamp: Timestamp) {
        let _ = self.0.try_send(timestamp);
    }
}

impl OutputPipelineStopRx {
    pub async fn race<T>(&mut self, other: impl Future<Output = T>) -> Option<T> {
        use futures::future::Either;
        match futures::future::select(pin!(self.0.recv()), pin!(other)).await {
            Either::Left(_) => None,
            Either::Right((result, _)) => Some(result),
        }
    }

    pub fn wait(self) -> impl Future<Output = Result<(), broadcast::error::RecvError>> {
        let mut stop_rx = self.0.resubscribe();
        async move { stop_rx.recv().await }
    }
}

impl Clone for OutputPipelineInternal {
    fn clone(&self) -> Self {
        Self {
            first_tx: self.first_tx.clone(),
            stop_rx: self.stop_rx.resubscribe(),
            error_tx: self.error_tx.clone(),
        }
    }
}

impl OutputPipelineInternal {
    pub fn to_frame_handler(&self) -> OutputPipelineFrameHandler {
        OutputPipelineFrameHandler(self.first_tx.clone())
    }

    pub fn to_error_tx(&self) -> mpsc::Sender<anyhow::Error> {
        self.error_tx.clone()
    }

    pub fn to_stop_rx(&self) -> OutputPipelineStopRx {
        OutputPipelineStopRx(self.stop_rx.resubscribe())
    }
}

pub struct OnceSender<T>(Option<oneshot::Sender<T>>);

impl<T> OnceSender<T> {
    pub fn send(&mut self, v: T) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(v);
        }
    }
}

impl OutputPipeline {
    pub fn new(path: PathBuf) -> (Self, OutputPipelineInternal) {
        let (first_tx, first_rx) = mpsc::channel(1);
        let (error_tx, mut error_rx) = mpsc::channel(1);
        let (stop_tx, stop_rx) = broadcast::channel(1);
        let (done_tx, done_rx) = oneshot::channel();

        tokio::spawn(async move {
            let err = error_rx.next().await;

            done_tx.send(err.map_or_else(|| Ok(()), |v| Err(v)))
        });

        (
            Self {
                path,
                first_timestamp_rx: first_rx,
                stop_tx,
                done_rx,
            },
            OutputPipelineInternal {
                first_tx,
                stop_rx,
                error_tx,
            },
        )
    }

    pub fn builder<TVideo: VideoSource>(
        path: PathBuf,
        video_config: TVideo::Config,
    ) -> OutputPipelineBuilder<TVideo> {
        OutputPipelineBuilder {
            path,
            video_config,
            audio_sources: vec![],
            error_sources: vec![],
            timestamps: Timestamps::now(),
        }
    }

    pub fn stop(&mut self) {
        let _ = self.stop_tx.send(());
    }
}

pub struct SetupCtx {
    audio_sources: Vec<AudioSourceSetupFn>,
    error_sources: Vec<(mpsc::Receiver<anyhow::Error>, &'static str)>,
}

impl SetupCtx {
    pub fn add_audio_source<TAudio: AudioSource + 'static>(&mut self, source: TAudio) {
        self.audio_sources.push(Box::new(|tx| source.setup(tx)));
    }

    pub fn add_error_source(&mut self, name: &'static str) -> mpsc::Sender<anyhow::Error> {
        let (tx, rx) = mpsc::channel(1);
        self.error_sources.push((rx, name));
        tx
    }
}

pub type AudioSourceSetupFn =
    Box<dyn FnOnce(mpsc::Sender<AudioFrame>) -> anyhow::Result<AudioInfo> + Send>;

pub trait VideoSource: Send + 'static {
    type Config;
    type Frame: VideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized;

    fn video_info(&self) -> VideoInfo;

    fn start(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        future::ready(Ok(())).boxed()
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        future::ready(Ok(())).boxed()
    }
}

pub struct OutputPipelineBuilder<TVideo: VideoSource> {
    path: PathBuf,
    video_config: TVideo::Config,
    audio_sources: Vec<AudioSourceSetupFn>,
    error_sources: Vec<(mpsc::Receiver<anyhow::Error>, &'static str)>,
    timestamps: Timestamps,
}

impl<TVideo: VideoSource> OutputPipelineBuilder<TVideo> {
    pub fn add_audio_source<TAudio: AudioSource + 'static>(&mut self, source: TAudio) {
        self.audio_sources.push(Box::new(|tx| source.setup(tx)));
    }

    pub fn add_error_source(&mut self, name: &'static str) -> mpsc::Sender<anyhow::Error> {
        let (tx, rx) = mpsc::channel(1);
        self.error_sources.push((rx, name));
        tx
    }

    pub fn set_timestamps(&mut self, timestamps: Timestamps) {
        self.timestamps = timestamps;
    }

    pub async fn build<TMuxer: Muxer<VideoFrame = TVideo::Frame>>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<NewOutputPipeline> {
        let Self {
            video_config,
            error_sources,
            audio_sources,
            timestamps,
            path,
        } = self;

        let mut setup_ctx = SetupCtx {
            error_sources,
            audio_sources,
        };

        let stop_token = CancellationToken::new();

        let mut tasks = vec![];

        let (video_tx, mut video_rx) = mpsc::channel(4);
        let mut video_source = TVideo::setup(video_config, video_tx, &mut setup_ctx).await?;

        let has_audio_sources = !setup_ctx.audio_sources.is_empty();
        let (first_tx, first_rx) = oneshot::channel();

        let muxer = TMuxer::setup(
            muxer_config,
            path.clone(),
            video_source.video_info(),
            has_audio_sources.then_some(AudioMixer::INFO),
        )
        .await?;

        tasks.push((
            tokio::spawn({
                let mut muxer = muxer.clone();
                let mut error_tx = setup_ctx.add_error_source("encoder");
                let stop_token = stop_token.child_token();

                async move {
                    use futures::StreamExt;

                    let mut first_tx = Some(first_tx);

                    video_source.start().await?;

                    tracing::trace!("Encoder starting");

                    stop_token
                        .run_until_cancelled(async {
                            while let Some(frame) = video_rx.next().await {
                                let timestamp = frame.timestamp();

                                if let Some(first_tx) = first_tx.take() {
                                    let _ = first_tx.send(timestamp);
                                }

                                muxer
                                    .send_video_frame(frame, timestamp.duration_since(timestamps))
                                    .map_err(|e| anyhow!("Error queueing video frame: {e}"))?;
                            }

                            Ok::<(), anyhow::Error>(())
                        })
                        .await;

                    video_source.stop().await?;

                    tracing::info!("Encoder done receiving frames");

                    muxer.finish()?;

                    tracing::info!("Encoder finished");

                    Ok(())
                }
                .then(async move |ret| {
                    if let Err(e) = ret {
                        let _ = error_tx.send(e).await;
                    }
                })
                .in_current_span()
            }),
            "mux-video",
        ));

        let SetupCtx {
            error_sources,
            audio_sources,
        } = setup_ctx;

        if has_audio_sources {
            let mut audio_mixer = AudioMixer::builder();

            for audio_source_setup in audio_sources {
                let (tx, rx) = mpsc::channel(64);
                let info = (audio_source_setup)(tx)?;

                audio_mixer.add_source(info, rx);
            }

            let (audio_tx, mut audio_rx) = mpsc::channel(64);
            let audio_mixer_handle = audio_mixer.spawn(audio_tx).await?;

            tasks.push((
                tokio::spawn(stop_token.child_token().cancelled_owned().map(move |_| {
                    audio_mixer_handle.stop();
                })),
                "audio-mixer-stop",
            ));

            let mut muxer = muxer.clone();
            tasks.push((
                tokio::spawn(async move {
                    while let Some(frame) = audio_rx.next().await {
                        if let Err(e) = muxer.send_audio_frame(
                            frame.inner,
                            frame.timestamp.duration_since(timestamps),
                        ) {
                            error!("Audio encoder: {e}");
                        }
                    }

                    info!("Audio encoder sender finished");
                }),
                "mux-audio",
            ));
        }

        let (task_futures, task_names): (Vec<_>, Vec<_>) = tasks.into_iter().unzip();

        Ok(NewOutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            task_names,
            tasks: task_futures,
        })
    }
}

pub struct NewOutputPipeline {
    path: PathBuf,
    pub first_timestamp_rx: oneshot::Receiver<Timestamp>,
    stop_token: Option<DropGuard>,
    task_names: Vec<&'static str>,
    tasks: Vec<JoinHandle<()>>,
}

impl NewOutputPipeline {
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub async fn stop(&mut self) {
        drop(self.stop_token.take());

        futures::future::join_all(&mut self.tasks).await;
    }
}

pub trait AudioSource: Send {
    fn setup(self, tx: mpsc::Sender<AudioFrame>) -> anyhow::Result<AudioInfo>;

    fn start(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    fn stop(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
}

pub struct ChannelAudioSource {
    info: AudioInfo,
    rx: mpsc::Receiver<AudioFrame>,
}

impl ChannelAudioSource {
    pub fn new(info: AudioInfo, rx: mpsc::Receiver<AudioFrame>) -> Self {
        Self { info, rx }
    }
}

impl AudioSource for ChannelAudioSource {
    fn setup(mut self, mut tx: mpsc::Sender<AudioFrame>) -> anyhow::Result<AudioInfo> {
        tokio::spawn(async move {
            while let Some(frame) = self.rx.next().await {
                let _ = tx.send(frame).await;
            }
        });

        Ok(self.info)
    }
}

pub struct AudioFrame {
    pub inner: ffmpeg::frame::Audio,
    pub timestamp: Timestamp,
}

impl AudioFrame {
    pub fn new(inner: ffmpeg::frame::Audio, timestamp: Timestamp) -> Self {
        Self { inner, timestamp }
    }
}

pub trait VideoFrame: Send + 'static {
    fn timestamp(&self) -> Timestamp;
}

pub trait Muxer: Clone + Send + 'static {
    type VideoFrame;
    type Config;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: VideoInfo,
        audio_config: Option<AudioInfo>,
    ) -> anyhow::Result<Self>
    where
        Self: Sized;

    fn send_audio_frame(
        &mut self,
        frame: ffmpeg::frame::Audio,
        timestamp: Duration,
    ) -> anyhow::Result<()>;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()>;

    fn finish(&mut self) -> anyhow::Result<()>;
}
