use crate::sources::audio_mixer::AudioMixer;
use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{
    FutureExt, SinkExt, StreamExt,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Shared},
    lock::Mutex,
    stream::FuturesUnordered,
};
use std::{
    any::Any,
    future,
    marker::PhantomData,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{self, AtomicBool},
    },
    time::Duration,
};
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
}

pub struct SetupCtx {
    tasks: TaskPool,
}

impl SetupCtx {
    pub fn tasks(&mut self) -> &mut TaskPool {
        &mut self.tasks
    }
}

type AudioSourceSetupFn = Box<
    dyn FnOnce(
            mpsc::Sender<AudioFrame>,
            &mut SetupCtx,
        ) -> BoxFuture<'static, anyhow::Result<ErasedAudioSource>>
        + Send,
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
    pub fn with_audio_source<TAudio: AudioSource>(
        mut self,
        config: TAudio::Config,
    ) -> OutputPipelineBuilder<THasVideo> {
        self.audio_sources.push(Box::new(move |tx, ctx| {
            TAudio::setup(config, tx, ctx)
                .map(|v| v.map(ErasedAudioSource::new))
                .boxed()
        }));

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

        let (mut setup_ctx, stop_token, done_tx, done_rx, pause_flag) = setup_build();

        let (video_source, video_rx) =
            setup_video_source::<TVideo>(video.config, &mut setup_ctx).await?;

        let video_info = video_source.video_info();
        let (first_tx, first_rx) = oneshot::channel();

        let muxer = Arc::new(Mutex::new(
            TMuxer::setup(
                muxer_config,
                path.clone(),
                Some(video_source.video_info()),
                Some(AudioMixer::INFO),
                pause_flag.clone(),
            )
            .await?,
        ));

        spawn_video_encoder(
            &mut setup_ctx,
            video_source,
            video_rx,
            first_tx,
            stop_token.clone(),
            muxer.clone(),
            timestamps,
        );

        finish_build(
            setup_ctx,
            audio_sources,
            stop_token.clone(),
            muxer,
            timestamps,
            done_tx,
            None,
            &path,
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            video_info: Some(video_info),
            done_fut: done_rx,
            pause_flag,
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

        let (setup_ctx, stop_token, done_tx, done_rx, pause_flag) = setup_build();

        let (first_tx, first_rx) = oneshot::channel();

        let muxer = Arc::new(Mutex::new(
            TMuxer::setup(
                muxer_config,
                path.clone(),
                None,
                Some(AudioMixer::INFO),
                pause_flag.clone(),
            )
            .await?,
        ));

        finish_build(
            setup_ctx,
            audio_sources,
            stop_token.clone(),
            muxer,
            timestamps,
            done_tx,
            Some(first_tx),
            &path,
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            video_info: None,
            done_fut: done_rx,
            pause_flag,
        })
    }
}

fn setup_build() -> (
    SetupCtx,
    CancellationToken,
    oneshot::Sender<anyhow::Result<()>>,
    DoneFut,
    Arc<AtomicBool>,
) {
    let stop_token = CancellationToken::new();

    let (done_tx, done_rx) = oneshot::channel();

    (
        SetupCtx {
            tasks: TaskPool(vec![]),
        },
        stop_token,
        done_tx,
        done_rx
            .map(|v| {
                v.map_err(|s| anyhow::Error::from(s))
                    .and_then(|v| v)
                    .map_err(|e| PipelineDoneError(Arc::new(e)))
            })
            .boxed()
            .shared(),
        Arc::new(AtomicBool::new(false)),
    )
}

async fn finish_build(
    mut setup_ctx: SetupCtx,
    audio_sources: Vec<AudioSourceSetupFn>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<impl Muxer + AudioMuxer>>,
    timestamps: Timestamps,
    done_tx: oneshot::Sender<anyhow::Result<()>>,
    first_tx: Option<oneshot::Sender<Timestamp>>,
    path: &PathBuf,
) -> anyhow::Result<()> {
    configure_audio(
        &mut setup_ctx,
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
            let (task_names, task_handles): (Vec<_>, Vec<_>) =
                setup_ctx.tasks.0.into_iter().unzip();

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

    info!("Built pipeline for output {}", path.display());

    Ok(())
}

async fn setup_video_source<TVideo: VideoSource>(
    video_config: TVideo::Config,
    setup_ctx: &mut SetupCtx,
) -> anyhow::Result<(TVideo, mpsc::Receiver<TVideo::Frame>)> {
    let (video_tx, video_rx) = mpsc::channel(8);
    let video_source = TVideo::setup(video_config, video_tx, setup_ctx).await?;

    Ok((video_source, video_rx))
}

fn spawn_video_encoder<TMutex: VideoMuxer<VideoFrame = TVideo::Frame>, TVideo: VideoSource>(
    setup_ctx: &mut SetupCtx,
    mut video_source: TVideo,
    mut video_rx: mpsc::Receiver<TVideo::Frame>,
    first_tx: oneshot::Sender<Timestamp>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<TMutex>>,
    timestamps: Timestamps,
) {
    setup_ctx.tasks().spawn("mux-video", async move {
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
    setup_ctx: &mut SetupCtx,
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

    let mut erased_audio_sources = vec![];

    for audio_source_setup in audio_sources {
        let (tx, rx) = mpsc::channel(64);
        let source = (audio_source_setup)(tx, setup_ctx).await?;

        audio_mixer.add_source(source.audio_info, rx);
        erased_audio_sources.push(source);
    }

    let (audio_tx, mut audio_rx) = mpsc::channel(64);
    let audio_mixer_handle = audio_mixer.spawn(audio_tx).await?;

    setup_ctx.tasks().spawn(
        "audio-mixer-stop",
        stop_token.child_token().cancelled_owned().map(move |_| {
            audio_mixer_handle.stop();
            Ok(())
        }),
    );

    for source in &mut erased_audio_sources {
        (source.start_fn)(source.inner.as_mut()).await?;
    }

    setup_ctx.tasks().spawn("mux-audio", {
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

            for source in &mut erased_audio_sources {
                let _ = (source.stop_fn)(source.inner.as_mut()).await;
            }

            Ok(())
        }
    });

    Ok(())
}

pub type DoneFut = Shared<BoxFuture<'static, Result<(), PipelineDoneError>>>;

pub struct OutputPipeline {
    path: PathBuf,
    pub first_timestamp_rx: oneshot::Receiver<Timestamp>,
    stop_token: Option<DropGuard>,
    video_info: Option<VideoInfo>,
    done_fut: DoneFut,
    pause_flag: Arc<AtomicBool>,
}

pub struct FinishedOutputPipeline {
    pub path: PathBuf,
    pub first_timestamp: Timestamp,
    pub video_info: Option<VideoInfo>,
}

#[derive(Clone, Debug)]
pub struct PipelineDoneError(Arc<anyhow::Error>);

impl std::fmt::Display for PipelineDoneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PipelineDoneError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.as_ref().source()
    }
}

impl OutputPipeline {
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub async fn stop(mut self) -> anyhow::Result<FinishedOutputPipeline> {
        drop(self.stop_token.take());

        self.done_fut.await?;

        Ok(FinishedOutputPipeline {
            path: self.path,
            first_timestamp: self.first_timestamp_rx.await?,
            video_info: self.video_info,
        })
    }

    pub fn pause(&self) {
        self.pause_flag.store(true, atomic::Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.pause_flag.store(false, atomic::Ordering::Relaxed);
    }

    pub fn video_info(&self) -> Option<VideoInfo> {
        self.video_info
    }

    pub fn done_fut(&self) -> DoneFut {
        self.done_fut.clone()
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
}

pub struct ChannelAudioSourceConfig {
    info: AudioInfo,
    rx: mpsc::Receiver<AudioFrame>,
}

impl ChannelAudioSourceConfig {
    pub fn new(info: AudioInfo, rx: mpsc::Receiver<AudioFrame>) -> Self {
        Self { info, rx }
    }
}

impl AudioSource for ChannelAudioSource {
    type Config = ChannelAudioSourceConfig;

    fn setup(
        mut config: Self::Config,
        mut tx: mpsc::Sender<AudioFrame>,
        _: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static {
        tokio::spawn(async move {
            while let Some(frame) = config.rx.next().await {
                let _ = tx.send(frame).await;
            }
        });

        async move { Ok(ChannelAudioSource { info: config.info }) }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }
}

pub struct AudioFrame {
    pub inner: ::ffmpeg::frame::Audio,
    pub timestamp: Timestamp,
}

impl AudioFrame {
    pub fn new(inner: ::ffmpeg::frame::Audio, timestamp: Timestamp) -> Self {
        Self { inner, timestamp }
    }
}

pub trait VideoSource: Send + 'static {
    type Config;
    type Frame: VideoFrame;

    fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> impl std::future::Future<Output = anyhow::Result<Self>> + Send
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

struct ErasedAudioSource {
    inner: Box<dyn Any + Send>,
    audio_info: AudioInfo,
    start_fn: fn(&mut dyn Any) -> BoxFuture<'_, anyhow::Result<()>>,
    stop_fn: fn(&mut dyn Any) -> BoxFuture<'_, anyhow::Result<()>>,
}

impl ErasedAudioSource {
    pub fn new<TAudio: AudioSource>(source: TAudio) -> Self {
        Self {
            audio_info: source.audio_info(),
            start_fn: |raw| {
                raw.downcast_mut::<TAudio>()
                    .expect("Wrong type")
                    .start()
                    .boxed()
            },
            stop_fn: |raw| {
                raw.downcast_mut::<TAudio>()
                    .expect("Wrong type")
                    .stop()
                    .boxed()
            },
            inner: Box::new(source),
        }
    }
}

pub trait AudioSource: Send + 'static {
    type Config: Send;

    fn setup(
        config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + Send + 'static
    where
        Self: Sized;

    fn audio_info(&self) -> AudioInfo;

    fn start(&mut self) -> impl Future<Output = anyhow::Result<()>> + Send {
        async { Ok(()) }
    }

    fn stop(&mut self) -> impl Future<Output = anyhow::Result<()>> + Send {
        async { Ok(()) }
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
        pause_flag: Arc<AtomicBool>,
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
