use crate::sources::audio_mixer::AudioMixer;
use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{Timestamp, Timestamps};
use futures::{
    FutureExt, SinkExt, StreamExt, TryFutureExt,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Shared},
    lock::Mutex,
    stream::FuturesUnordered,
};
use std::{
    any::Any,
    future,
    marker::PhantomData,
    ops::Deref,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{self, AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, DropGuard};
use tracing::*;

struct SharedPauseStateInner {
    paused_at: Option<Duration>,
    offset: Duration,
}

#[derive(Clone)]
pub struct SharedPauseState {
    flag: Arc<AtomicBool>,
    inner: Arc<std::sync::Mutex<SharedPauseStateInner>>,
}

impl SharedPauseState {
    pub fn new(flag: Arc<AtomicBool>) -> Self {
        Self {
            flag,
            inner: Arc::new(std::sync::Mutex::new(SharedPauseStateInner {
                paused_at: None,
                offset: Duration::ZERO,
            })),
        }
    }

    pub fn adjust(&self, timestamp: Duration) -> anyhow::Result<Option<Duration>> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        if self.flag.load(Ordering::Acquire) {
            if inner.paused_at.is_none() {
                inner.paused_at = Some(timestamp);
            }
            return Ok(None);
        }

        if let Some(start) = inner.paused_at.take() {
            let delta = match timestamp.checked_sub(start) {
                Some(d) => d,
                None => {
                    warn!(
                        resume_at = ?start,
                        current = ?timestamp,
                        "Timestamp anomaly: frame timestamp went backward during unpause (clock skew?), treating as zero delta"
                    );
                    Duration::ZERO
                }
            };

            inner.offset = match inner.offset.checked_add(delta) {
                Some(o) => o,
                None => {
                    warn!(
                        offset = ?inner.offset,
                        delta = ?delta,
                        "Timestamp anomaly: pause offset overflow, clamping to MAX"
                    );
                    Duration::MAX
                }
            };
        }

        let adjusted = match timestamp.checked_sub(inner.offset) {
            Some(t) => t,
            None => {
                warn!(
                    timestamp = ?timestamp,
                    offset = ?inner.offset,
                    "Timestamp anomaly: adjusted timestamp underflow (clock skew?), using zero"
                );
                Duration::ZERO
            }
        };

        Ok(Some(adjusted))
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
    pub fn builder(path: PathBuf) -> OutputPipelineBuilder<NoVideo> {
        OutputPipelineBuilder::<NoVideo> {
            path,
            video: NoVideo,
            audio_sources: vec![],
            timestamps: Timestamps::now(),
        }
    }
}

#[derive(Default)]
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

#[derive(Default)]
pub struct TaskPool(Vec<(&'static str, JoinHandle<anyhow::Result<()>>)>);

impl TaskPool {
    pub fn spawn<F>(&mut self, name: &'static str, future: F)
    where
        F: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        self.0.push((
            name,
            tokio::spawn(
                async {
                    trace!("Task started");
                    let res = future.await;
                    match &res {
                        Ok(_) => info!("Task finished successfully"),
                        Err(err) => error!("Task failed: {:#}", err),
                    }
                    res
                }
                .instrument(error_span!("", task = name))
                .in_current_span(),
            ),
        ));
    }

    pub fn spawn_thread(
        &mut self,
        name: &'static str,
        cb: impl FnOnce() -> anyhow::Result<()> + Send + 'static,
    ) {
        let span = error_span!("", task = name);
        let (done_tx, done_rx) = oneshot::channel();
        std::thread::spawn(move || {
            let _guard = span.enter();
            trace!("Task started");
            let _ = done_tx.send(cb());
            info!("Task finished");
        });
        self.0.push((
            name,
            tokio::spawn(
                done_rx
                    .map_err(|_| anyhow!("Cancelled"))
                    .map(|v| v.and_then(|v| v)),
            ),
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

        let mut setup_ctx = SetupCtx::default();
        let build_ctx = BuildCtx::new();

        let (video_source, video_rx) =
            setup_video_source::<TVideo>(video.config, &mut setup_ctx).await?;

        let video_info = video_source.video_info();
        let (first_tx, first_rx) = oneshot::channel();

        let audio =
            setup_audio_sources(&mut setup_ctx, audio_sources, build_ctx.stop_token.clone())
                .await
                .context("setup_audio_sources")?;

        let muxer = setup_muxer::<TMuxer>(
            muxer_config,
            &path,
            Some(video_info),
            audio.as_ref().map(|v| v.audio_info),
            &build_ctx.pause_flag,
            &mut setup_ctx,
        )
        .await?;

        spawn_video_encoder(
            &mut setup_ctx,
            video_source,
            video_rx,
            first_tx,
            build_ctx.stop_token.clone(),
            muxer.clone(),
            timestamps,
        );

        finish_build(
            setup_ctx,
            audio,
            build_ctx.stop_token.clone(),
            muxer,
            timestamps,
            build_ctx.done_tx,
            None,
            &path,
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            video_info: Some(video_info),
            stop_token: Some(build_ctx.stop_token.clone().drop_guard()),
            done_fut: build_ctx.done_rx,
            pause_flag: build_ctx.pause_flag,
            cancel_token: build_ctx.stop_token,
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

        let mut setup_ctx = SetupCtx::default();
        let build_ctx = BuildCtx::new();

        let (first_tx, first_rx) = oneshot::channel();

        let audio =
            setup_audio_sources(&mut setup_ctx, audio_sources, build_ctx.stop_token.clone())
                .await
                .context("setup_audio_sources")?;

        let muxer = setup_muxer::<TMuxer>(
            muxer_config,
            &path,
            None,
            audio.as_ref().map(|v| v.audio_info),
            &build_ctx.pause_flag,
            &mut setup_ctx,
        )
        .await?;

        finish_build(
            setup_ctx,
            audio,
            build_ctx.stop_token.clone(),
            muxer,
            timestamps,
            build_ctx.done_tx,
            Some(first_tx),
            &path,
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(build_ctx.stop_token.clone().drop_guard()),
            video_info: None,
            done_fut: build_ctx.done_rx,
            pause_flag: build_ctx.pause_flag,
            cancel_token: build_ctx.stop_token,
        })
    }
}

struct BuildCtx {
    stop_token: CancellationToken,
    done_tx: oneshot::Sender<anyhow::Result<()>>,
    done_rx: DoneFut,
    pause_flag: Arc<AtomicBool>,
}

impl BuildCtx {
    pub fn new() -> Self {
        let stop_token = CancellationToken::new();

        let (done_tx, done_rx) = oneshot::channel();

        Self {
            stop_token,
            done_tx,
            done_rx: done_rx
                .map(|v| {
                    v.map_err(anyhow::Error::from)
                        .and_then(|v| v)
                        .map_err(|e| PipelineDoneError(Arc::new(e)))
                })
                .boxed()
                .shared(),
            pause_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish_build(
    mut setup_ctx: SetupCtx,
    audio: Option<PreparedAudioSources>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<impl AudioMuxer>>,
    timestamps: Timestamps,
    done_tx: oneshot::Sender<anyhow::Result<()>>,
    first_tx: Option<oneshot::Sender<Timestamp>>,
    path: &Path,
) -> anyhow::Result<()> {
    if let Some(audio) = audio {
        audio.configure(
            &mut setup_ctx,
            muxer.clone(),
            stop_token.clone(),
            timestamps,
            first_tx,
        );
    }

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
        .then(async move |res| {
            let muxer_res = muxer.lock().await.finish(timestamps.instant().elapsed());

            let _ = done_tx.send(match (res, muxer_res) {
                (Err(e), _) | (_, Err(e)) => Err(e),
                (_, Ok(muxer_streams_res)) => {
                    if let Err(e) = muxer_streams_res {
                        warn!("Muxer streams had failure: {e:#}");
                    }

                    Ok(())
                }
            });
        }),
    );

    info!("Built pipeline for output {}", path.display());

    Ok(())
}

async fn setup_video_source<TVideo: VideoSource>(
    video_config: TVideo::Config,
    setup_ctx: &mut SetupCtx,
) -> anyhow::Result<(TVideo, mpsc::Receiver<TVideo::Frame>)> {
    let (video_tx, video_rx) = mpsc::channel(128);
    let video_source = TVideo::setup(video_config, video_tx, setup_ctx).await?;

    Ok((video_source, video_rx))
}

async fn setup_muxer<TMuxer: Muxer>(
    muxer_config: TMuxer::Config,
    path: &Path,
    video_info: Option<VideoInfo>,
    audio_info: Option<AudioInfo>,
    pause_flag: &Arc<AtomicBool>,
    setup_ctx: &mut SetupCtx,
) -> Result<Arc<Mutex<TMuxer>>, anyhow::Error> {
    let muxer = Arc::new(Mutex::new(
        TMuxer::setup(
            muxer_config,
            path.to_path_buf(),
            video_info,
            audio_info,
            pause_flag.clone(),
            &mut setup_ctx.tasks,
        )
        .await?,
    ));

    Ok(muxer)
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
    setup_ctx.tasks().spawn("capture-video", {
        let stop_token = stop_token.clone();
        async move {
            video_source.start().await?;

            stop_token.cancelled().await;

            if let Err(e) = video_source.stop().await {
                error!("Video source stop failed: {e:#}");
            };

            Ok(())
        }
    });

    setup_ctx.tasks().spawn("mux-video", async move {
        use futures::StreamExt;

        let mut first_tx = Some(first_tx);
        let mut frame_count = 0u64;
        let res = stop_token
            .run_until_cancelled(async {
                while let Some(frame) = video_rx.next().await {
                    frame_count += 1;

                    let timestamp = frame.timestamp();

                    if let Some(first_tx) = first_tx.take() {
                        let _ = first_tx.send(timestamp);
                    }

                    let duration = timestamp
                        .checked_duration_since(timestamps)
                        .unwrap_or(Duration::ZERO);

                    muxer
                        .lock()
                        .await
                        .send_video_frame(frame, duration)
                        .map_err(|e| anyhow!("Error queueing video frame: {e}"))?;
                }

                info!("mux-video stream ended (rx closed)");
                Ok::<(), anyhow::Error>(())
            })
            .await;

        let was_cancelled = res.is_none();

        if was_cancelled {
            info!("mux-video cancelled, draining remaining frames from channel");
            let drain_start = std::time::Instant::now();
            let drain_timeout = Duration::from_secs(2);
            let max_drain_frames = 30u64;
            let mut drained = 0u64;
            let mut skipped = 0u64;

            let mut hit_limit = false;
            while let Some(frame) = video_rx.next().await {
                frame_count += 1;

                if drain_start.elapsed() > drain_timeout || drained >= max_drain_frames {
                    hit_limit = true;
                    break;
                }

                drained += 1;

                let timestamp = frame.timestamp();

                if let Some(first_tx) = first_tx.take() {
                    let _ = first_tx.send(timestamp);
                }

                let duration = timestamp
                    .checked_duration_since(timestamps)
                    .unwrap_or(Duration::ZERO);

                match muxer.lock().await.send_video_frame(frame, duration) {
                    Ok(()) => {}
                    Err(e) => {
                        warn!("Error processing drained frame: {e}");
                        skipped += 1;
                    }
                }
            }

            if drained > 0 || skipped > 0 || hit_limit {
                info!(
                    "mux-video drain complete: {} frames processed, {} errors (limit hit: {}) in {:?}",
                    drained,
                    skipped,
                    hit_limit,
                    drain_start.elapsed()
                );
            }
        }

        muxer.lock().await.stop();

        if let Some(Err(e)) = res {
            return Err(e);
        }

        if was_cancelled {
            info!(
                "mux-video finished after cancellation, total {} frames",
                frame_count
            );
        }

        Ok(())
    });
}

struct PreparedAudioSources {
    audio_info: AudioInfo,
    audio_rx: mpsc::Receiver<AudioFrame>,
    erased_audio_sources: Vec<ErasedAudioSource>,
}

impl PreparedAudioSources {
    pub fn configure<TMutex: AudioMuxer>(
        mut self,
        setup_ctx: &mut SetupCtx,
        muxer: Arc<Mutex<TMutex>>,
        stop_token: CancellationToken,
        timestamps: Timestamps,
        mut first_tx: Option<oneshot::Sender<Timestamp>>,
    ) {
        setup_ctx.tasks().spawn("mux-audio", {
            let stop_token = stop_token.child_token();
            let muxer = muxer.clone();
            async move {
                stop_token
                    .run_until_cancelled(async {
                        while let Some(frame) = self.audio_rx.next().await {
                            if let Some(first_tx) = first_tx.take() {
                                let _ = first_tx.send(frame.timestamp);
                            }

                            let timestamp = frame
                                .timestamp
                                .checked_duration_since(timestamps)
                                .unwrap_or(Duration::ZERO);
                            if let Err(e) = muxer.lock().await.send_audio_frame(frame, timestamp) {
                                error!("Audio encoder: {e}");
                            }
                        }
                    })
                    .await;

                for source in &mut self.erased_audio_sources {
                    let _ = (source.stop_fn)(source.inner.as_mut()).await;
                }

                muxer.lock().await.stop();

                Ok(())
            }
        });
    }
}

async fn setup_audio_sources(
    setup_ctx: &mut SetupCtx,
    mut audio_sources: Vec<AudioSourceSetupFn>,
    stop_token: CancellationToken,
) -> anyhow::Result<Option<PreparedAudioSources>> {
    if audio_sources.is_empty() {
        return Ok(None);
    }

    let mut erased_audio_sources = vec![];
    let (audio_tx, audio_rx) = mpsc::channel(64);

    let audio_info = if audio_sources.len() == 1 {
        let source = (audio_sources.swap_remove(0))(audio_tx, setup_ctx).await?;
        let info = source.audio_info;
        erased_audio_sources.push(source);
        info
    } else {
        let mut audio_mixer = AudioMixer::builder();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = oneshot::channel::<anyhow::Result<()>>();

        for audio_source_setup in audio_sources {
            let (tx, rx) = mpsc::channel(64);
            let source = (audio_source_setup)(tx, setup_ctx).await?;

            audio_mixer.add_source(source.audio_info, rx);
            erased_audio_sources.push(source);
        }

        setup_ctx.tasks().spawn_thread("audio-mixer", {
            let stop_flag = stop_flag.clone();
            move || {
                audio_mixer.run(audio_tx, ready_tx, stop_flag);
                Ok(())
            }
        });

        ready_rx
            .await
            .map_err(|_| anyhow::format_err!("Audio mixer crashed"))??;

        setup_ctx.tasks().spawn(
            "audio-mixer-stop",
            stop_token.child_token().cancelled_owned().map(move |_| {
                stop_flag.store(true, atomic::Ordering::Relaxed);
                Ok(())
            }),
        );

        AudioMixer::INFO
    };

    for source in &mut erased_audio_sources {
        (source.start_fn)(source.inner.as_mut()).await?;
    }

    Ok(Some(PreparedAudioSources {
        audio_info,
        audio_rx,
        erased_audio_sources,
    }))
}

pub type DoneFut = Shared<BoxFuture<'static, Result<(), PipelineDoneError>>>;

pub struct OutputPipeline {
    path: PathBuf,
    pub first_timestamp_rx: oneshot::Receiver<Timestamp>,
    video_info: Option<VideoInfo>,
    stop_token: Option<DropGuard>,
    done_fut: DoneFut,
    pause_flag: Arc<AtomicBool>,
    cancel_token: CancellationToken,
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
        self.pause_flag.store(true, atomic::Ordering::Release);
    }

    pub fn resume(&self) {
        self.pause_flag.store(false, atomic::Ordering::Release);
    }

    pub fn video_info(&self) -> Option<VideoInfo> {
        self.video_info
    }

    pub fn done_fut(&self) -> DoneFut {
        self.done_fut.clone()
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
    }

    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }
}

pub struct ChannelVideoSourceConfig<TVideoFrame> {
    info: VideoInfo,
    rx: flume::Receiver<TVideoFrame>,
}

impl<TVideoFrame> ChannelVideoSourceConfig<TVideoFrame> {
    pub fn new(info: VideoInfo, rx: flume::Receiver<TVideoFrame>) -> Self {
        Self { info, rx }
    }
}

pub struct ChannelVideoSource<TVideoFrame>(VideoInfo, PhantomData<TVideoFrame>);

impl<TVideoFrame: VideoFrame> VideoSource for ChannelVideoSource<TVideoFrame> {
    type Config = ChannelVideoSourceConfig<TVideoFrame>;
    type Frame = TVideoFrame;

    async fn setup(
        config: Self::Config,
        mut video_tx: mpsc::Sender<Self::Frame>,
        _: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        tokio::spawn(async move {
            while let Ok(frame) = config.rx.recv_async().await {
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

impl Deref for AudioFrame {
    type Target = ffmpeg::frame::Audio;

    fn deref(&self) -> &Self::Target {
        &self.inner
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

    fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        tasks: &mut TaskPool,
    ) -> impl Future<Output = anyhow::Result<Self>> + Send
    where
        Self: Sized;

    fn stop(&mut self) {}

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>>;
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
