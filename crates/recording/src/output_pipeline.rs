use crate::sources::audio_mixer::AudioMixer;
use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{
    FutureExt, SinkExt, StreamExt,
    channel::{mpsc, oneshot},
    future::BoxFuture,
    lock::Mutex,
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
    pub fn builder(path: PathBuf) -> OutputPipelineBuilder<NoVideo, NoAudio> {
        OutputPipelineBuilder::<NoVideo, NoAudio> {
            path,
            video: NoVideo,
            audio_sources: vec![],
            error_sources: vec![],
            timestamps: Timestamps::now(),
            phantom: PhantomData,
        }
    }

    // pub fn stop(&mut self) {
    //     let _ = self.stop_tx.send(());
    // }
}

pub struct SetupCtx {
    audio_sources: Vec<AudioSourceSetupFn>,
    error_sources: Vec<(mpsc::Receiver<anyhow::Error>, &'static str)>,
}

impl SetupCtx {
    pub fn add_audio_source<TAudio: AudioSource + 'static>(&mut self, source: TAudio) {
        self.audio_sources
            .push(Box::new(|tx| source.setup(tx).boxed()));
    }

    pub fn add_error_source(&mut self, name: &'static str) -> mpsc::Sender<anyhow::Error> {
        let (tx, rx) = mpsc::channel(1);
        self.error_sources.push((rx, name));
        tx
    }
}

pub type AudioSourceSetupFn = Box<
    dyn FnOnce(mpsc::Sender<AudioFrame>) -> BoxFuture<'static, anyhow::Result<AudioInfo>> + Send,
>;

pub struct OutputPipelineBuilder<TVideo, TAudio> {
    path: PathBuf,
    video: TVideo,
    audio_sources: Vec<AudioSourceSetupFn>,
    error_sources: Vec<(mpsc::Receiver<anyhow::Error>, &'static str)>,
    timestamps: Timestamps,
    phantom: PhantomData<TAudio>,
}

pub struct NoVideo;
pub struct HasVideo<TVideo: VideoSource> {
    config: TVideo::Config,
}

pub struct NoAudio;
pub struct HasAudio;

impl<THasVideo, THasAudio> OutputPipelineBuilder<THasVideo, THasAudio> {
    pub fn with_audio_source<TAudio: AudioSource + 'static>(
        mut self,
        source: TAudio,
    ) -> OutputPipelineBuilder<THasVideo, HasAudio> {
        self.audio_sources
            .push(Box::new(|tx| source.setup(tx).boxed()));

        OutputPipelineBuilder {
            path: self.path,
            video: self.video,
            audio_sources: self.audio_sources,
            error_sources: self.error_sources,
            timestamps: self.timestamps,
            phantom: PhantomData,
        }
    }

    pub fn add_error_source(&mut self, name: &'static str) -> mpsc::Sender<anyhow::Error> {
        let (tx, rx) = mpsc::channel(1);
        self.error_sources.push((rx, name));
        tx
    }

    pub fn set_timestamps(&mut self, timestamps: Timestamps) {
        self.timestamps = timestamps;
    }

    pub fn with_timestamps(mut self, timestamps: Timestamps) -> Self {
        self.timestamps = timestamps;
        self
    }
}

async fn setup_video_source<TVideo: VideoSource>(
    video_config: TVideo::Config,
) -> anyhow::Result<(TVideo, mpsc::Receiver<TVideo::Frame>)> {
    let (video_tx, video_rx) = mpsc::channel(4);
    let video_source = TVideo::setup(
        video_config,
        video_tx,
        &mut SetupCtx {
            error_sources: vec![],
            audio_sources: vec![],
        },
    )
    .await?;

    Ok((video_source, video_rx))
}

fn spawn_video_encoder<TMutex: VideoMuxer<VideoFrame = TVideo::Frame>, TVideo: VideoSource>(
    tasks: &mut Vec<(JoinHandle<anyhow::Result<()>>, &'static str)>,
    mut video_source: TVideo,
    mut video_rx: mpsc::Receiver<TVideo::Frame>,
    first_tx: oneshot::Sender<Timestamp>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<TMutex>>,
    timestamps: Timestamps,
) {
    tasks.push((
        tokio::spawn({
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
            }
            .in_current_span()
        }),
        "mux-video",
    ));
}

async fn configure_audio<TMutex: AudioMuxer>(
    tasks: &mut Vec<(JoinHandle<anyhow::Result<()>>, &'static str)>,
    audio_sources: Vec<AudioSourceSetupFn>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<TMutex>>,
    timestamps: Timestamps,
) -> anyhow::Result<()> {
    let mut audio_mixer = AudioMixer::builder();

    for audio_source_setup in audio_sources {
        let (tx, rx) = mpsc::channel(64);
        let info = (audio_source_setup)(tx).await?;

        audio_mixer.add_source(info, rx);
    }

    let (audio_tx, mut audio_rx) = mpsc::channel(64);
    let audio_mixer_handle = audio_mixer.spawn(audio_tx).await?;

    tasks.push((
        tokio::spawn(stop_token.child_token().cancelled_owned().map(move |_| {
            audio_mixer_handle.stop();
            Ok(())
        })),
        "audio-mixer-stop",
    ));

    tasks.push((
        tokio::spawn({
            let stop_token = stop_token.child_token();
            let muxer = muxer.clone();
            async move {
                stop_token
                    .run_until_cancelled(async {
                        while let Some(frame) = audio_rx.next().await {
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
        }),
        "mux-audio",
    ));

    Ok(())
}

impl<THasAudio> OutputPipelineBuilder<NoVideo, THasAudio> {
    pub fn with_video<TVideo: VideoSource>(
        self,
        config: TVideo::Config,
    ) -> OutputPipelineBuilder<HasVideo<TVideo>, THasAudio> {
        OutputPipelineBuilder::<HasVideo<TVideo>, THasAudio> {
            video: HasVideo { config },
            path: self.path,
            audio_sources: self.audio_sources,
            error_sources: self.error_sources,
            timestamps: self.timestamps,
            phantom: PhantomData,
        }
    }
}

impl<TVideo: VideoSource> OutputPipelineBuilder<HasVideo<TVideo>, HasAudio> {
    pub async fn build<TMuxer: VideoMuxer<VideoFrame = TVideo::Frame> + AudioMuxer>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<OutputPipeline> {
        let Self {
            video,
            error_sources,
            audio_sources,
            timestamps,
            path,
            ..
        } = self;

        let setup_ctx = SetupCtx {
            error_sources,
            audio_sources,
        };

        let stop_token = CancellationToken::new();

        let mut tasks = vec![];

        let (video_source, video_rx) = setup_video_source::<TVideo>(video.config).await?;
        let video_info = video_source.video_info();
        let (first_tx, first_rx) = oneshot::channel();

        if setup_ctx.audio_sources.is_empty() {
            return Err(anyhow!("Invariant: No audio sources"));
        }

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

        configure_audio(
            &mut tasks,
            setup_ctx.audio_sources,
            stop_token.clone(),
            muxer.clone(),
            timestamps,
        )
        .await
        .context("audio mixer setup")?;

        let (task_futures, task_names): (Vec<_>, Vec<_>) = tasks.into_iter().unzip();

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            task_names,
            tasks: task_futures,
            video_info: Some(video_info),
        })
    }
}

impl<TVideo: VideoSource> OutputPipelineBuilder<HasVideo<TVideo>, NoAudio> {
    pub async fn build<TMuxer: VideoMuxer<VideoFrame = TVideo::Frame> + AudioMuxer>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<OutputPipeline> {
        let Self {
            video,
            error_sources,
            audio_sources,
            timestamps,
            path,
            ..
        } = self;

        let setup_ctx = SetupCtx {
            error_sources,
            audio_sources,
        };

        let stop_token = CancellationToken::new();

        let mut tasks = vec![];

        let (video_source, video_rx) = setup_video_source::<TVideo>(video.config).await?;
        let video_info = video_source.video_info();
        let (first_tx, first_rx) = oneshot::channel();

        let muxer = Arc::new(Mutex::new(
            TMuxer::setup(
                muxer_config,
                path.clone(),
                Some(video_source.video_info()),
                None,
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

        let SetupCtx { error_sources, .. } = setup_ctx;

        let (task_futures, task_names): (Vec<_>, Vec<_>) = tasks.into_iter().unzip();

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            task_names,
            tasks: task_futures,
            video_info: Some(video_info),
        })
    }
}

impl OutputPipelineBuilder<NoVideo, HasAudio> {
    pub async fn build<TMuxer: AudioMuxer>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<OutputPipeline> {
        let Self {
            error_sources,
            audio_sources,
            timestamps,
            path,
            ..
        } = self;

        let mut setup_ctx = SetupCtx {
            error_sources,
            audio_sources,
        };

        let stop_token = CancellationToken::new();

        let mut tasks = vec![];

        if setup_ctx.audio_sources.is_empty() {
            return Err(anyhow!("Invariant: No audio sources"));
        }

        let (first_tx, first_rx) = oneshot::channel();

        let muxer = Arc::new(Mutex::new(
            TMuxer::setup(muxer_config, path.clone(), None, Some(AudioMixer::INFO)).await?,
        ));

        let SetupCtx {
            error_sources,
            audio_sources,
        } = setup_ctx;

        configure_audio(
            &mut tasks,
            audio_sources,
            stop_token.clone(),
            muxer.clone(),
            timestamps,
        )
        .await
        .context("audio mixer setup")?;

        let (task_futures, task_names): (Vec<_>, Vec<_>) = tasks.into_iter().unzip();

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(stop_token.drop_guard()),
            task_names,
            tasks: task_futures,
            video_info: None,
        })
    }
}

pub struct OutputPipeline {
    path: PathBuf,
    pub first_timestamp_rx: oneshot::Receiver<Timestamp>,
    stop_token: Option<DropGuard>,
    task_names: Vec<&'static str>,
    tasks: Vec<JoinHandle<anyhow::Result<()>>>,
    video_info: Option<VideoInfo>,
}

impl OutputPipeline {
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub async fn stop(&mut self) {
        drop(self.stop_token.take());

        futures::future::join_all(&mut self.tasks).await;
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

    fn start(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    fn stop(&mut self) -> anyhow::Result<()> {
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
