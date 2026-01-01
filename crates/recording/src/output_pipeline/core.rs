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

const CONSECUTIVE_ANOMALY_ERROR_THRESHOLD: u64 = 30;
const LARGE_BACKWARD_JUMP_SECS: f64 = 1.0;
const LARGE_FORWARD_JUMP_SECS: f64 = 5.0;

struct AudioDriftTracker {
    baseline_offset_secs: Option<f64>,
}

impl AudioDriftTracker {
    fn new() -> Self {
        Self {
            baseline_offset_secs: None,
        }
    }

    fn calculate_timestamp(
        &mut self,
        samples_before_frame: u64,
        sample_rate: u32,
        wall_clock_secs: f64,
        total_input_duration_secs: f64,
    ) -> Duration {
        let sample_time_secs = samples_before_frame as f64 / sample_rate as f64;

        if wall_clock_secs < 2.0 || total_input_duration_secs < 2.0 {
            return Duration::from_secs_f64(sample_time_secs);
        }

        if self.baseline_offset_secs.is_none() {
            let offset = total_input_duration_secs - wall_clock_secs;
            debug!(
                wall_clock_secs,
                total_input_duration_secs,
                baseline_offset_secs = offset,
                "Capturing audio baseline offset after warmup"
            );
            self.baseline_offset_secs = Some(offset);
        }

        let baseline = self.baseline_offset_secs.unwrap_or(0.0);
        let adjusted_input_duration = total_input_duration_secs - baseline;
        let adjusted_sample_time_secs = (sample_time_secs - baseline).max(0.0);

        let drift_ratio = if adjusted_input_duration > 0.0 {
            wall_clock_secs / adjusted_input_duration
        } else {
            1.0
        };

        if !(0.95..=1.05).contains(&drift_ratio) {
            warn!(
                drift_ratio,
                wall_clock_secs,
                adjusted_input_duration,
                baseline,
                "Extreme audio clock drift detected after baseline correction, clamping"
            );
            let clamped_ratio = drift_ratio.clamp(0.95, 1.05);
            Duration::from_secs_f64(adjusted_sample_time_secs * clamped_ratio)
        } else {
            Duration::from_secs_f64(adjusted_sample_time_secs * drift_ratio)
        }
    }
}

struct VideoDriftTracker {
    baseline_offset_secs: Option<f64>,
}

impl VideoDriftTracker {
    fn new() -> Self {
        Self {
            baseline_offset_secs: None,
        }
    }

    fn calculate_timestamp(
        &mut self,
        camera_duration: Duration,
        wall_clock_elapsed: Duration,
    ) -> Duration {
        let camera_secs = camera_duration.as_secs_f64();
        let wall_clock_secs = wall_clock_elapsed.as_secs_f64();

        if wall_clock_secs < 2.0 || camera_secs < 2.0 {
            return camera_duration;
        }

        if self.baseline_offset_secs.is_none() {
            let offset = camera_secs - wall_clock_secs;
            debug!(
                wall_clock_secs,
                camera_secs,
                baseline_offset_secs = offset,
                "Capturing video baseline offset after warmup"
            );
            self.baseline_offset_secs = Some(offset);
        }

        let baseline = self.baseline_offset_secs.unwrap_or(0.0);
        let adjusted_camera_secs = (camera_secs - baseline).max(0.0);

        let drift_ratio = if adjusted_camera_secs > 0.0 {
            wall_clock_secs / adjusted_camera_secs
        } else {
            1.0
        };

        if !(0.95..=1.05).contains(&drift_ratio) {
            warn!(
                drift_ratio,
                wall_clock_secs,
                adjusted_camera_secs,
                baseline,
                "Extreme video clock drift detected after baseline correction, clamping"
            );
            let clamped_ratio = drift_ratio.clamp(0.95, 1.05);
            Duration::from_secs_f64(adjusted_camera_secs * clamped_ratio)
        } else {
            Duration::from_secs_f64(adjusted_camera_secs * drift_ratio)
        }
    }
}
const DEFAULT_VIDEO_SOURCE_CHANNEL_CAPACITY: usize = 128;

fn get_video_source_channel_capacity() -> usize {
    std::env::var("CAP_VIDEO_SOURCE_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_VIDEO_SOURCE_CHANNEL_CAPACITY)
}

pub struct TimestampAnomalyTracker {
    stream_name: &'static str,
    anomaly_count: u64,
    consecutive_anomalies: u64,
    total_backward_skew_secs: f64,
    max_backward_skew_secs: f64,
    total_forward_skew_secs: f64,
    max_forward_skew_secs: f64,
    last_valid_duration: Option<Duration>,
    accumulated_compensation: Duration,
    resync_count: u64,
}

impl TimestampAnomalyTracker {
    pub fn new(stream_name: &'static str) -> Self {
        Self {
            stream_name,
            anomaly_count: 0,
            consecutive_anomalies: 0,
            total_backward_skew_secs: 0.0,
            max_backward_skew_secs: 0.0,
            total_forward_skew_secs: 0.0,
            max_forward_skew_secs: 0.0,
            last_valid_duration: None,
            accumulated_compensation: Duration::ZERO,
            resync_count: 0,
        }
    }

    pub fn process_timestamp(
        &mut self,
        timestamp: Timestamp,
        timestamps: Timestamps,
    ) -> Result<Duration, TimestampAnomalyError> {
        let signed_secs = timestamp.signed_duration_since_secs(timestamps);

        if signed_secs < 0.0 {
            return self.handle_backward_timestamp(signed_secs);
        }

        let raw_duration = Duration::from_secs_f64(signed_secs);
        let adjusted = raw_duration.saturating_add(self.accumulated_compensation);

        if let Some(last) = self.last_valid_duration
            && let Some(forward_jump) = adjusted.checked_sub(last)
        {
            let jump_secs = forward_jump.as_secs_f64();
            if jump_secs > LARGE_FORWARD_JUMP_SECS {
                return self.handle_forward_jump(last, adjusted, jump_secs);
            }
        }

        self.consecutive_anomalies = 0;
        self.last_valid_duration = Some(adjusted);
        Ok(adjusted)
    }

    fn handle_backward_timestamp(
        &mut self,
        signed_secs: f64,
    ) -> Result<Duration, TimestampAnomalyError> {
        let skew_secs = signed_secs.abs();
        self.anomaly_count += 1;
        self.consecutive_anomalies += 1;
        self.total_backward_skew_secs += skew_secs;
        if skew_secs > self.max_backward_skew_secs {
            self.max_backward_skew_secs = skew_secs;
        }

        if self.consecutive_anomalies >= CONSECUTIVE_ANOMALY_ERROR_THRESHOLD {
            error!(
                stream = self.stream_name,
                consecutive = self.consecutive_anomalies,
                total_anomalies = self.anomaly_count,
                max_backward_skew_secs = self.max_backward_skew_secs,
                "Timestamp anomaly threshold exceeded - too many consecutive backward timestamps"
            );
            return Err(TimestampAnomalyError::TooManyConsecutiveAnomalies {
                count: self.consecutive_anomalies,
            });
        }

        if skew_secs >= LARGE_BACKWARD_JUMP_SECS {
            warn!(
                stream = self.stream_name,
                backward_secs = skew_secs,
                consecutive = self.consecutive_anomalies,
                total_anomalies = self.anomaly_count,
                "Large backward timestamp jump detected (clock skew?), compensating"
            );

            let compensation = Duration::from_secs_f64(skew_secs);
            self.accumulated_compensation =
                self.accumulated_compensation.saturating_add(compensation);
            self.resync_count += 1;

            let adjusted = self.last_valid_duration.unwrap_or(Duration::ZERO);

            return Ok(adjusted);
        }

        if self.consecutive_anomalies == 1 {
            debug!(
                stream = self.stream_name,
                backward_secs = skew_secs,
                "Minor backward timestamp detected, using last valid"
            );
        }

        Ok(self.last_valid_duration.unwrap_or(Duration::ZERO))
    }

    fn handle_forward_jump(
        &mut self,
        last: Duration,
        current: Duration,
        jump_secs: f64,
    ) -> Result<Duration, TimestampAnomalyError> {
        self.anomaly_count += 1;
        self.total_forward_skew_secs += jump_secs;
        if jump_secs > self.max_forward_skew_secs {
            self.max_forward_skew_secs = jump_secs;
        }

        warn!(
            stream = self.stream_name,
            forward_secs = jump_secs,
            last_valid_ms = last.as_millis(),
            current_ms = current.as_millis(),
            total_anomalies = self.anomaly_count,
            "Large forward timestamp jump detected (system sleep/wake?), clamping"
        );

        let expected_increment = Duration::from_millis(33);
        let clamped = last.saturating_add(expected_increment);
        self.last_valid_duration = Some(clamped);
        self.consecutive_anomalies = 0;

        Ok(clamped)
    }

    pub fn log_stats_if_notable(&self) {
        if self.anomaly_count == 0 {
            return;
        }

        info!(
            stream = self.stream_name,
            anomaly_count = self.anomaly_count,
            total_backward_skew_secs = format!("{:.3}", self.total_backward_skew_secs),
            max_backward_skew_secs = format!("{:.3}", self.max_backward_skew_secs),
            total_forward_skew_secs = format!("{:.3}", self.total_forward_skew_secs),
            max_forward_skew_secs = format!("{:.3}", self.max_forward_skew_secs),
            resync_count = self.resync_count,
            accumulated_compensation_ms = self.accumulated_compensation.as_millis(),
            "Timestamp anomaly statistics"
        );
    }

    pub fn anomaly_count(&self) -> u64 {
        self.anomaly_count
    }
}

#[derive(Debug, Clone)]
pub enum TimestampAnomalyError {
    TooManyConsecutiveAnomalies { count: u64 },
}

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
    let capacity = get_video_source_channel_capacity();
    let (video_tx, video_rx) = mpsc::channel(capacity);
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
        let mut anomaly_tracker = TimestampAnomalyTracker::new("video");
        let mut drift_tracker = VideoDriftTracker::new();

        let res = stop_token
            .run_until_cancelled(async {
                while let Some(frame) = video_rx.next().await {
                    frame_count += 1;

                    let timestamp = frame.timestamp();

                    if let Some(first_tx) = first_tx.take() {
                        let _ = first_tx.send(timestamp);
                    }

                    let raw_duration = match anomaly_tracker.process_timestamp(timestamp, timestamps) {
                        Ok(d) => d,
                        Err(TimestampAnomalyError::TooManyConsecutiveAnomalies { count }) => {
                            return Err(anyhow!(
                                "Video stream timestamp anomaly: {} consecutive anomalies exceeded threshold",
                                count
                            ));
                        }
                    };

                    let wall_clock_elapsed = timestamps.instant().elapsed();
                    let duration = drift_tracker.calculate_timestamp(raw_duration, wall_clock_elapsed);

                    if frame_count.is_multiple_of(300) {
                        let drift_ratio = if raw_duration.as_secs_f64() > 0.0 {
                            wall_clock_elapsed.as_secs_f64() / raw_duration.as_secs_f64()
                        } else {
                            1.0
                        };
                        debug!(
                            frame_count,
                            wall_clock_secs = wall_clock_elapsed.as_secs_f64(),
                            camera_secs = raw_duration.as_secs_f64(),
                            corrected_secs = duration.as_secs_f64(),
                            drift_ratio,
                            baseline_offset = drift_tracker.baseline_offset_secs,
                            "Video drift correction status"
                        );
                    }

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

                let raw_duration = match anomaly_tracker.process_timestamp(timestamp, timestamps) {
                    Ok(d) => d,
                    Err(_) => {
                        warn!("Timestamp anomaly during drain, skipping frame");
                        skipped += 1;
                        continue;
                    }
                };

                let wall_clock_elapsed = timestamps.instant().elapsed();
                let duration = drift_tracker.calculate_timestamp(raw_duration, wall_clock_elapsed);

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

        anomaly_tracker.log_stats_if_notable();
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
        let sample_rate = self.audio_info.sample_rate;

        setup_ctx.tasks().spawn("mux-audio", {
            let stop_token = stop_token.child_token();
            let muxer = muxer.clone();
            async move {
                let mut anomaly_tracker = TimestampAnomalyTracker::new("audio");
                let mut drift_tracker = AudioDriftTracker::new();
                let mut total_samples: u64 = 0;

                let res = stop_token
                    .run_until_cancelled(async {
                        while let Some(frame) = self.audio_rx.next().await {
                            if let Some(first_tx) = first_tx.take() {
                                let _ = first_tx.send(frame.timestamp);
                            }

                            let samples_before_frame = total_samples;
                            let frame_samples = frame.inner.samples() as u64;
                            total_samples += frame_samples;

                            let _ = anomaly_tracker.process_timestamp(frame.timestamp, timestamps);

                            let wall_clock_secs = timestamps.instant().elapsed().as_secs_f64();
                            let total_input_duration_secs =
                                total_samples as f64 / sample_rate as f64;

                            if wall_clock_secs >= 5.0 && (wall_clock_secs as u64).is_multiple_of(10)
                            {
                                let drift_ratio = if total_input_duration_secs > 0.0 {
                                    wall_clock_secs / total_input_duration_secs
                                } else {
                                    1.0
                                };
                                debug!(
                                    wall_clock_secs,
                                    total_input_duration_secs,
                                    drift_ratio,
                                    samples_before_frame,
                                    total_samples,
                                    baseline_offset = drift_tracker.baseline_offset_secs,
                                    "Audio drift correction status"
                                );
                            }

                            let timestamp = drift_tracker.calculate_timestamp(
                                samples_before_frame,
                                sample_rate,
                                wall_clock_secs,
                                total_input_duration_secs,
                            );

                            if let Err(e) = muxer.lock().await.send_audio_frame(frame, timestamp) {
                                error!("Audio encoder: {e}");
                            }
                        }
                        Ok::<(), anyhow::Error>(())
                    })
                    .await;

                anomaly_tracker.log_stats_if_notable();

                for source in &mut self.erased_audio_sources {
                    let _ = (source.stop_fn)(source.inner.as_mut()).await;
                }

                muxer.lock().await.stop();

                if let Some(Err(e)) = res {
                    return Err(e);
                }

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

#[cfg(test)]
mod tests {
    use super::*;

    mod audio_drift_tracker {
        use super::*;

        const SAMPLE_RATE: u32 = 48000;

        fn samples_for_duration(duration_secs: f64) -> u64 {
            (duration_secs * SAMPLE_RATE as f64) as u64
        }

        #[test]
        fn no_correction_during_warmup() {
            let mut tracker = AudioDriftTracker::new();
            let samples = samples_for_duration(10.0);
            let result = tracker.calculate_timestamp(samples, SAMPLE_RATE, 1.5, 1.5);
            let expected = Duration::from_secs_f64(10.0);
            assert!(
                (result.as_secs_f64() - expected.as_secs_f64()).abs() < 0.001,
                "During warmup: expected ~{:.3}s, got {:.3}s",
                expected.as_secs_f64(),
                result.as_secs_f64()
            );
            assert!(
                tracker.baseline_offset_secs.is_none(),
                "Baseline should not be set during warmup"
            );
        }

        #[test]
        fn captures_baseline_after_warmup() {
            let mut tracker = AudioDriftTracker::new();
            let buffer_delay = 0.05;
            let wall_clock = 2.0;
            let input_duration = 2.0 + buffer_delay;
            let samples = samples_for_duration(input_duration);

            tracker.calculate_timestamp(samples, SAMPLE_RATE, wall_clock, input_duration);

            assert!(tracker.baseline_offset_secs.is_some());
            let baseline = tracker.baseline_offset_secs.unwrap();
            assert!(
                (baseline - buffer_delay).abs() < 0.001,
                "Baseline should be ~{buffer_delay:.3}s, got {baseline:.3}s"
            );
        }

        #[test]
        fn baseline_removes_initial_buffer_offset() {
            let mut tracker = AudioDriftTracker::new();
            let buffer_delay = 0.05;

            let wall_clock_1 = 2.0;
            let input_duration_1 = 2.0 + buffer_delay;
            tracker.calculate_timestamp(
                samples_for_duration(input_duration_1),
                SAMPLE_RATE,
                wall_clock_1,
                input_duration_1,
            );

            let wall_clock_2 = 10.0;
            let input_duration_2 = 10.0 + buffer_delay;
            let samples_2 = samples_for_duration(input_duration_2);
            let result =
                tracker.calculate_timestamp(samples_2, SAMPLE_RATE, wall_clock_2, input_duration_2);

            let expected = Duration::from_secs_f64(wall_clock_2);
            assert!(
                (result.as_secs_f64() - expected.as_secs_f64()).abs() < 0.1,
                "With baseline correction: expected ~{:.3}s, got {:.3}s",
                expected.as_secs_f64(),
                result.as_secs_f64()
            );
        }

        #[test]
        fn corrects_drift_after_baseline() {
            let mut tracker = AudioDriftTracker::new();
            let buffer_delay = 0.05;
            let drift_factor = 1.005;

            let wall_clock_1 = 2.0;
            let input_duration_1 = 2.0 * drift_factor + buffer_delay;
            tracker.calculate_timestamp(
                samples_for_duration(input_duration_1),
                SAMPLE_RATE,
                wall_clock_1,
                input_duration_1,
            );

            let wall_clock_2 = 60.0;
            let input_duration_2 = 60.0 * drift_factor + buffer_delay;
            let samples_2 = samples_for_duration(input_duration_2);
            let result =
                tracker.calculate_timestamp(samples_2, SAMPLE_RATE, wall_clock_2, input_duration_2);

            let expected = Duration::from_secs_f64(wall_clock_2);
            assert!(
                (result.as_secs_f64() - expected.as_secs_f64()).abs() < 0.5,
                "With drift and baseline correction: expected ~{:.3}s, got {:.3}s",
                expected.as_secs_f64(),
                result.as_secs_f64()
            );
        }

        #[test]
        fn clamps_extreme_drift_after_baseline() {
            let mut tracker = AudioDriftTracker::new();

            tracker.calculate_timestamp(samples_for_duration(2.0), SAMPLE_RATE, 2.0, 2.0);

            let samples = samples_for_duration(100.0);
            let result = tracker.calculate_timestamp(samples, SAMPLE_RATE, 100.0, 120.0);
            let expected_ratio = 0.95;
            let sample_time = 100.0;
            let expected_secs = sample_time * expected_ratio;
            assert!(
                (result.as_secs_f64() - expected_secs).abs() < 0.1,
                "Expected ~{:.3}s (clamped to 0.95), got {:.3}s",
                expected_secs,
                result.as_secs_f64()
            );
        }

        #[test]
        fn final_timestamp_matches_wall_clock_with_buffer() {
            let mut tracker = AudioDriftTracker::new();
            let buffer_delay = 0.1;
            let drift_factor = 1.004;

            let wall_clock_1 = 2.0;
            let input_duration_1 = wall_clock_1 * drift_factor + buffer_delay;
            tracker.calculate_timestamp(
                samples_for_duration(input_duration_1),
                SAMPLE_RATE,
                wall_clock_1,
                input_duration_1,
            );

            let wall_clock_final = 60.0;
            let input_duration_final = wall_clock_final * drift_factor + buffer_delay;
            let total_samples = samples_for_duration(input_duration_final);
            let result = tracker.calculate_timestamp(
                total_samples,
                SAMPLE_RATE,
                wall_clock_final,
                input_duration_final,
            );

            let corrected_time = result.as_secs_f64();
            assert!(
                (corrected_time - wall_clock_final).abs() < 1.0,
                "Final timestamp should be close to wall clock. \
                 Wall clock: {wall_clock_final:.3}s, corrected: {corrected_time:.3}s, input_duration: {input_duration_final:.3}s"
            );
        }

        #[test]
        fn simulates_real_world_scenario() {
            let mut tracker = AudioDriftTracker::new();
            let initial_buffer = 0.05;
            let drift_rate = 0.004;

            let mut total_audio = initial_buffer;
            let mut wall_time = 0.0;
            let step = 0.5;

            while wall_time < 60.0 {
                wall_time += step;
                total_audio += step * (1.0 + drift_rate);

                let samples = samples_for_duration(total_audio);
                let result =
                    tracker.calculate_timestamp(samples, SAMPLE_RATE, wall_time, total_audio);

                if wall_time >= 2.0 {
                    let error = (result.as_secs_f64() - total_audio).abs();
                    assert!(
                        error < total_audio * 0.02,
                        "At wall_time={:.1}s: corrected {:.3}s should be close to audio {:.3}s",
                        wall_time,
                        result.as_secs_f64(),
                        total_audio
                    );
                }
            }

            let final_samples = samples_for_duration(total_audio);
            let final_result =
                tracker.calculate_timestamp(final_samples, SAMPLE_RATE, wall_time, total_audio);

            assert!(
                (final_result.as_secs_f64() - wall_time).abs() < 1.0,
                "Final timestamp {:.3}s should be close to wall clock {:.3}s",
                final_result.as_secs_f64(),
                wall_time
            );
        }

        #[test]
        fn preserves_baseline_across_multiple_calls() {
            let mut tracker = AudioDriftTracker::new();

            tracker.calculate_timestamp(samples_for_duration(2.1), SAMPLE_RATE, 2.0, 2.1);

            let first_baseline = tracker.baseline_offset_secs;

            tracker.calculate_timestamp(samples_for_duration(10.1), SAMPLE_RATE, 10.0, 10.1);

            assert_eq!(
                first_baseline, tracker.baseline_offset_secs,
                "Baseline should not change after initial capture"
            );
        }
    }

    mod video_drift_tracker {
        use super::*;

        fn dur(secs: f64) -> Duration {
            Duration::from_secs_f64(secs)
        }

        #[test]
        fn no_correction_during_warmup() {
            let mut tracker = VideoDriftTracker::new();
            let camera_duration = dur(1.5);
            let wall_clock = dur(1.5);
            let result = tracker.calculate_timestamp(camera_duration, wall_clock);
            assert_eq!(
                result, camera_duration,
                "During warmup: should return unmodified camera duration"
            );
            assert!(
                tracker.baseline_offset_secs.is_none(),
                "Baseline should not be set during warmup"
            );
        }

        #[test]
        fn captures_baseline_after_warmup() {
            let mut tracker = VideoDriftTracker::new();
            let buffer_delay = 0.05;
            let wall_clock = dur(2.0);
            let camera_duration = dur(2.0 + buffer_delay);

            tracker.calculate_timestamp(camera_duration, wall_clock);

            assert!(tracker.baseline_offset_secs.is_some());
            let baseline = tracker.baseline_offset_secs.unwrap();
            assert!(
                (baseline - buffer_delay).abs() < 0.001,
                "Baseline should be ~{buffer_delay:.3}s, got {baseline:.3}s"
            );
        }

        #[test]
        fn baseline_removes_initial_offset() {
            let mut tracker = VideoDriftTracker::new();
            let buffer_delay = 0.05;

            let wall_clock_1 = dur(2.0);
            let camera_1 = dur(2.0 + buffer_delay);
            tracker.calculate_timestamp(camera_1, wall_clock_1);

            let wall_clock_2 = dur(10.0);
            let camera_2 = dur(10.0 + buffer_delay);
            let result = tracker.calculate_timestamp(camera_2, wall_clock_2);

            let expected = wall_clock_2;
            assert!(
                (result.as_secs_f64() - expected.as_secs_f64()).abs() < 0.1,
                "With baseline correction: expected ~{:.3}s, got {:.3}s",
                expected.as_secs_f64(),
                result.as_secs_f64()
            );
        }

        #[test]
        fn corrects_drift_after_baseline() {
            let mut tracker = VideoDriftTracker::new();
            let buffer_delay = 0.05;
            let drift_factor = 1.005;

            let wall_clock_1 = dur(2.0);
            let camera_1 = dur(2.0 * drift_factor + buffer_delay);
            tracker.calculate_timestamp(camera_1, wall_clock_1);

            let wall_clock_2 = dur(60.0);
            let camera_2 = dur(60.0 * drift_factor + buffer_delay);
            let result = tracker.calculate_timestamp(camera_2, wall_clock_2);

            let expected = wall_clock_2;
            assert!(
                (result.as_secs_f64() - expected.as_secs_f64()).abs() < 0.5,
                "With drift and baseline correction: expected ~{:.3}s, got {:.3}s",
                expected.as_secs_f64(),
                result.as_secs_f64()
            );
        }

        #[test]
        fn clamps_extreme_drift() {
            let mut tracker = VideoDriftTracker::new();

            tracker.calculate_timestamp(dur(2.0), dur(2.0));

            let camera = dur(100.0);
            let wall_clock = dur(80.0);
            let result = tracker.calculate_timestamp(camera, wall_clock);
            let expected_ratio = 0.95;
            let expected_secs = 100.0 * expected_ratio;
            assert!(
                (result.as_secs_f64() - expected_secs).abs() < 0.1,
                "Expected ~{:.3}s (clamped to 0.95), got {:.3}s",
                expected_secs,
                result.as_secs_f64()
            );
        }

        #[test]
        fn simulates_real_world_camera_scenario() {
            let mut tracker = VideoDriftTracker::new();
            let initial_offset = 0.03;
            let drift_rate = 0.003;

            let mut camera_time = initial_offset;
            let mut wall_time = 0.0;
            let step = 0.5;

            while wall_time < 60.0 {
                wall_time += step;
                camera_time += step * (1.0 + drift_rate);

                let result = tracker.calculate_timestamp(dur(camera_time), dur(wall_time));

                if wall_time >= 2.0 {
                    let error = (result.as_secs_f64() - wall_time).abs();
                    assert!(
                        error < 0.5,
                        "At wall_time={:.1}s: corrected {:.3}s should be close to wall clock",
                        wall_time,
                        result.as_secs_f64()
                    );
                }
            }

            let final_result = tracker.calculate_timestamp(dur(camera_time), dur(wall_time));
            assert!(
                (final_result.as_secs_f64() - wall_time).abs() < 1.0,
                "Final timestamp {:.3}s should be close to wall clock {:.3}s",
                final_result.as_secs_f64(),
                wall_time
            );
        }

        #[test]
        fn preserves_baseline_across_multiple_calls() {
            let mut tracker = VideoDriftTracker::new();

            tracker.calculate_timestamp(dur(2.1), dur(2.0));
            let first_baseline = tracker.baseline_offset_secs;

            tracker.calculate_timestamp(dur(10.1), dur(10.0));

            assert_eq!(
                first_baseline, tracker.baseline_offset_secs,
                "Baseline should not change after initial capture"
            );
        }
    }
}
