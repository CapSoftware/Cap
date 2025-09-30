use crate::sources::audio_mixer::AudioMixer;
use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{
    FutureExt, SinkExt, StreamExt,
    channel::{mpsc, oneshot},
    future::BoxFuture,
    lock::Mutex,
    stream::FuturesUnordered,
};
use std::{future, marker::PhantomData, path::PathBuf, sync::Arc, time::Duration};
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, DropGuard};
use tracing::*;

pub struct OnceSender<T>(Option<oneshot::Sender<T>>);

impl<T> OnceSender<T> {
    pub fn send(&mut self, v: T) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(v);
        }
    }
}

impl OutputPipeline {
    pub fn builder(path: PathBuf) -> OutputPipelineBuilder<NoVideo> {
        OutputPipelineBuilder::<NoVideo> {
            path,
            video: NoVideo,
            audio_sources: vec![],
            timestamps: Timestamps::now(),
        }
    }

    // pub fn stop(&mut self) {
    //     let _ = self.stop_tx.send(());
    // }
}

pub struct SetupCtx {
    tasks: TaskPool,
}

impl SetupCtx {
    pub fn tasks(&mut self) -> &mut TaskPool {
        &mut self.tasks
    }
}

pub type AudioSourceSetupFn = Box<
    dyn FnOnce(mpsc::Sender<AudioFrame>) -> BoxFuture<'static, anyhow::Result<AudioInfo>> + Send,
>;

pub struct OutputPipelineBuilder<TVideo> {
    path: PathBuf,
    video: TVideo,
    audio_sources: Vec<AudioSourceSetupFn>,
    timestamps: Timestamps,
}

pub struct NoVideo;
pub struct HasVideo<TVideo: VideoSource> {
    config: TVideo::Config,
}

impl<THasVideo> OutputPipelineBuilder<THasVideo> {
    pub fn with_audio_source<TAudio: AudioSource + 'static>(
        mut self,
        source: TAudio,
    ) -> OutputPipelineBuilder<THasVideo> {
        self.audio_sources
            .push(Box::new(|tx| source.setup(tx).boxed()));

        self
    }

    pub fn set_timestamps(&mut self, timestamps: Timestamps) {
        self.timestamps = timestamps;
    }

    pub fn with_timestamps(mut self, timestamps: Timestamps) -> Self {
        self.timestamps = timestamps;
        self
    }
}

impl OutputPipelineBuilder<NoVideo> {
    pub fn with_video<TVideo: VideoSource>(
        self,
        config: TVideo::Config,
    ) -> OutputPipelineBuilder<HasVideo<TVideo>> {
        OutputPipelineBuilder::<HasVideo<TVideo>> {
            video: HasVideo { config },
            path: self.path,
            audio_sources: self.audio_sources,
            timestamps: self.timestamps,
        }
    }
}

pub struct TaskPool(Vec<(&'static str, JoinHandle<anyhow::Result<()>>)>);

impl TaskPool {
    pub fn spawn<F>(&mut self, name: &'static str, future: F)
    where
        F: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        self.0.push((
            name,
            tokio::spawn(future.instrument(error_span!("", name)).in_current_span()),
        ));
    }
}

impl<TVideo: VideoSource> OutputPipelineBuilder<HasVideo<TVideo>> {
    pub async fn build<TMuxer: VideoMuxer<VideoFrame = TVideo::Frame> + AudioMuxer>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<OutputPipeline> {
        let Self {
            video,
            audio_sources,
            timestamps,
            path,
            ..
        } = self;

        let (tasks, stop_token, done_tx, done_rx) = setup_build();

        let mut setup_ctx = SetupCtx { tasks };
        let (video_source, video_rx) =
            setup_video_source::<TVideo>(video.config, &mut setup_ctx).await?;
        let SetupCtx { mut tasks } = setup_ctx;

        let video_info = video_source.video_info();
        let (first_tx, first_rx) = oneshot::channel();

        let muxer = Arc::new(Mutex::new(
            TMuxer::setup(
                muxer_config,
                path.clone(),
                Some(video_source.video_info()),
                Some(AudioMixer::INFO),
            )
            .await?,
        ));

        spawn_video_encoder(
            &mut tasks,
            video_source,
            video_rx,
            first_tx,
            stop_token.clone(),
            muxer.clone(),
            timestamps,
        );

        finish_build(
            tasks,
            audio_sources,
            stop_token.clone(),
            muxer,
            timestamps,
            done_tx,
            None,
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            video_info: Some(video_info),
            done_rx,
        })
    }
}

impl OutputPipelineBuilder<NoVideo> {
    pub async fn build<TMuxer: AudioMuxer>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<OutputPipeline> {
        let Self {
            audio_sources,
            timestamps,
            path,
            ..
        } = self;

        if audio_sources.is_empty() {
            return Err(anyhow!("Invariant: No audio sources"));
        }

        let (tasks, stop_token, done_tx, done_rx) = setup_build();

        let (first_tx, first_rx) = oneshot::channel();

        let muxer = Arc::new(Mutex::new(
            TMuxer::setup(muxer_config, path.clone(), None, Some(AudioMixer::INFO)).await?,
        ));

        finish_build(
            tasks,
            audio_sources,
            stop_token.clone(),
            muxer,
            timestamps,
            done_tx,
            Some(first_tx),
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            video_info: None,
            done_rx,
        })
    }
}

fn setup_build() -> (
    TaskPool,
    CancellationToken,
    oneshot::Sender<anyhow::Result<()>>,
    oneshot::Receiver<anyhow::Result<()>>,
) {
    let tasks = TaskPool(vec![]);

    let stop_token = CancellationToken::new();

    let (done_tx, done_rx) = oneshot::channel();

    (tasks, stop_token, done_tx, done_rx)
}

async fn finish_build(
    mut tasks: TaskPool,
    audio_sources: Vec<AudioSourceSetupFn>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<impl Muxer + AudioMuxer>>,
    timestamps: Timestamps,
    done_tx: oneshot::Sender<anyhow::Result<()>>,
    first_tx: Option<oneshot::Sender<Timestamp>>,
) -> anyhow::Result<()> {
    configure_audio(
        &mut tasks,
        audio_sources,
        stop_token.clone(),
        muxer.clone(),
        timestamps,
        first_tx,
    )
    .await
    .context("audio mixer setup")?;

    tokio::spawn(
        async move {
            let (task_names, task_handles): (Vec<_>, Vec<_>) = tasks.0.into_iter().unzip();

            let mut futures = FuturesUnordered::from_iter(
                task_handles
                    .into_iter()
                    .zip(task_names)
                    .map(|(f, n)| f.map(move |r| (r, n))),
            );

            while let Some((result, name)) = futures.next().await {
                match result {
                    Err(_) => {
                        return Err(anyhow::anyhow!("Task {name} failed unexpectedly"));
                    }
                    Ok(Err(e)) => {
                        return Err(anyhow::anyhow!("Task {name} failed: {e}"));
                    }
                    _ => {}
                }
            }

            Ok(())
        }
        .map(|r| done_tx.send(r)),
    );

    Ok(())
}

async fn setup_video_source<TVideo: VideoSource>(
    video_config: TVideo::Config,
    setup_ctx: &mut SetupCtx,
) -> anyhow::Result<(TVideo, mpsc::Receiver<TVideo::Frame>)> {
    let (video_tx, video_rx) = mpsc::channel(4);
    let video_source = TVideo::setup(video_config, video_tx, setup_ctx).await?;

    Ok((video_source, video_rx))
}

fn spawn_video_encoder<TMutex: VideoMuxer<VideoFrame = TVideo::Frame>, TVideo: VideoSource>(
    tasks: &mut TaskPool,
    mut video_source: TVideo,
    mut video_rx: mpsc::Receiver<TVideo::Frame>,
    first_tx: oneshot::Sender<Timestamp>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<TMutex>>,
    timestamps: Timestamps,
) {
    tasks.spawn("mux-video", async move {
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
                        .lock()
                        .await
                        .send_video_frame(frame, timestamp.duration_since(timestamps))
                        .map_err(|e| anyhow!("Error queueing video frame: {e}"))?;
                }

                Ok::<(), anyhow::Error>(())
            })
            .await;

        video_source.stop().await?;

        tracing::info!("Encoder done receiving frames");

        muxer.lock().await.finish()?;

        tracing::info!("Encoder finished");

        Ok(())
    });
}

async fn configure_audio<TMutex: AudioMuxer>(
    tasks: &mut TaskPool,
    audio_sources: Vec<AudioSourceSetupFn>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<TMutex>>,
    timestamps: Timestamps,
    mut first_tx: Option<oneshot::Sender<Timestamp>>,
) -> anyhow::Result<()> {
    if audio_sources.len() < 1 {
        return Ok(());
    }

    let mut audio_mixer = AudioMixer::builder();

    for audio_source_setup in audio_sources {
        let (tx, rx) = mpsc::channel(64);
        let info = (audio_source_setup)(tx).await?;

        audio_mixer.add_source(info, rx);
    }

    let (audio_tx, mut audio_rx) = mpsc::channel(64);
    let audio_mixer_handle = audio_mixer.spawn(audio_tx).await?;

    tasks.spawn(
        "audio-mixer-stop",
        stop_token.child_token().cancelled_owned().map(move |_| {
            audio_mixer_handle.stop();
            Ok(())
        }),
    );

    tasks.spawn("mux-audio", {
        let stop_token = stop_token.child_token();
        let muxer = muxer.clone();
        async move {
            stop_token
                .run_until_cancelled(async {
                    while let Some(frame) = audio_rx.next().await {
                        if let Some(first_tx) = first_tx.take() {
                            let _ = first_tx.send(frame.timestamp);
                        }

                        let timestamp = frame.timestamp.duration_since(timestamps);
                        if let Err(e) = muxer.lock().await.send_audio_frame(frame, timestamp) {
                            error!("Audio encoder: {e}");
                        }
                    }
                })
                .await;

            info!("Audio encoder sender finished");

            muxer.lock().await.finish()?;

            Ok(())
        }
    });

    Ok(())
}

pub struct OutputPipeline {
    path: PathBuf,
    pub first_timestamp_rx: oneshot::Receiver<Timestamp>,
    stop_token: Option<DropGuard>,
    video_info: Option<VideoInfo>,
    done_rx: oneshot::Receiver<anyhow::Result<()>>,
}

pub struct FinishedOutputPipeline {
    pub path: PathBuf,
    pub first_timestamp: Timestamp,
    pub video_info: Option<VideoInfo>,
}

impl OutputPipeline {
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub async fn stop(mut self) -> anyhow::Result<FinishedOutputPipeline> {
        drop(self.stop_token.take());

        let _ = self.done_rx.await??;

        Ok(FinishedOutputPipeline {
            path: self.path,
            first_timestamp: self.first_timestamp_rx.await?,
            video_info: self.video_info,
        })
    }

    pub fn video_info(&self) -> Option<VideoInfo> {
        self.video_info
    }
}

pub struct ChannelVideoSourceConfig<TVideoFrame> {
    info: VideoInfo,
    rx: mpsc::Receiver<TVideoFrame>,
}

impl<TVideoFrame> ChannelVideoSourceConfig<TVideoFrame> {
    pub fn new(info: VideoInfo, rx: mpsc::Receiver<TVideoFrame>) -> Self {
        Self { info, rx }
    }
}

pub struct ChannelVideoSource<TVideoFrame>(VideoInfo, PhantomData<TVideoFrame>);

impl<TVideoFrame: VideoFrame> VideoSource for ChannelVideoSource<TVideoFrame> {
    type Config = ChannelVideoSourceConfig<TVideoFrame>;
    type Frame = TVideoFrame;

    async fn setup(
        mut config: Self::Config,
        mut video_tx: mpsc::Sender<Self::Frame>,
        _: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        tokio::spawn(async move {
            while let Some(frame) = config.rx.next().await {
                let _ = video_tx.send(frame).await;
            }
        });

        Ok(Self(config.info, PhantomData))
    }

    fn video_info(&self) -> VideoInfo {
        self.0
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
    async fn setup(mut self, mut tx: mpsc::Sender<AudioFrame>) -> anyhow::Result<AudioInfo> {
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

pub trait AudioSource: Send {
    fn setup(
        self,
        tx: mpsc::Sender<AudioFrame>,
    ) -> impl Future<Output = anyhow::Result<AudioInfo>> + Send;

    async fn start(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
}

pub trait VideoFrame: Send + 'static {
    fn timestamp(&self) -> Timestamp;
}

pub trait Muxer: Send + 'static {
    type Config;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
    ) -> anyhow::Result<Self>
    where
        Self: Sized;

    fn finish(&mut self) -> anyhow::Result<()>;
}

pub trait AudioMuxer: Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()>;
}

pub trait VideoMuxer: Muxer {
    type VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()>;
}
