use std::{
    fs::File,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use cap_media::{
    feeds::AudioInputFeed,
    pipeline::{Pipeline, RealTimeClock},
    sources::{AudioInputSource, ScreenCaptureSource, ScreenCaptureTarget},
    MediaError,
};
use cap_project::InstantRecordingMeta;
use cap_utils::spawn_actor;
use tokio::sync::oneshot;
use tracing::{debug, error, info, instrument::WithSubscriber, trace, Instrument};
use tracing_subscriber::{layer::SubscriberExt, Layer};

use crate::{
    capture_pipeline::{create_screen_capture, MakeCapturePipeline},
    ActorError, RecordingError, RecordingOptions,
};

struct InstantRecordingPipeline {
    pub inner: Pipeline<RealTimeClock<()>>,
    pub output_path: PathBuf,
}

enum InstantRecordingActorState {
    Recording {
        pipeline: InstantRecordingPipeline,
        pipeline_done_rx: oneshot::Receiver<()>,
        segment_start_time: f64,
    },
    Paused,
    Stopped,
}

#[derive(Clone)]
pub struct InstantRecordingHandle {
    ctrl_tx: flume::Sender<InstantRecordingActorControlMessage>,
    pub options: RecordingOptions,
}

macro_rules! send_message {
    ($ctrl_tx:expr, $variant:path) => {{
        let (tx, rx) = oneshot::channel();
        $ctrl_tx
            .send($variant(tx))
            .map_err(|_| flume::SendError(()))
            .map_err(ActorError::from)?;
        rx.await.map_err(|_| ActorError::ActorStopped)?
    }};
}

impl InstantRecordingHandle {
    pub async fn stop(&self) -> Result<CompletedInstantRecording, RecordingError> {
        send_message!(self.ctrl_tx, InstantRecordingActorControlMessage::Stop)
    }

    pub async fn pause(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, InstantRecordingActorControlMessage::Pause)
    }

    pub async fn resume(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, InstantRecordingActorControlMessage::Resume)
    }
}

pub enum InstantRecordingActorControlMessage {
    Pause(oneshot::Sender<Result<(), RecordingError>>),
    Resume(oneshot::Sender<Result<(), RecordingError>>),
    Stop(oneshot::Sender<Result<CompletedInstantRecording, RecordingError>>),
}

impl std::fmt::Debug for InstantRecordingActorControlMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pause(_) => write!(f, "Pause"),
            Self::Resume(_) => write!(f, "Resume"),
            Self::Stop(_) => write!(f, "Stop"),
        }
    }
}

pub struct InstantRecordingActor {
    id: String,
    recording_dir: PathBuf,
    capture_target: ScreenCaptureTarget,
    audio_input_name: Option<String>,
}

pub struct CompletedInstantRecording {
    pub id: String,
    pub project_path: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: InstantRecordingMeta,
}

#[tracing::instrument(skip_all, name = "standalone")]
async fn create_pipeline<TCaptureFormat: MakeCapturePipeline>(
    output_path: PathBuf,
    screen_source: ScreenCaptureSource<TCaptureFormat>,
    audio_input_feed: Option<&AudioInputFeed>,
) -> Result<(InstantRecordingPipeline, oneshot::Receiver<()>), MediaError> {
    let clock = RealTimeClock::<()>::new();
    let pipeline_builder = Pipeline::builder(clock);

    let pipeline_builder = TCaptureFormat::make_instant_mode_pipeline(
        pipeline_builder,
        screen_source,
        audio_input_feed.map(AudioInputSource::init),
        output_path.clone(),
    )?;

    let (mut pipeline, pipeline_done_rx) = pipeline_builder.build().await?;

    pipeline.play().await?;

    Ok((
        InstantRecordingPipeline {
            inner: pipeline,
            output_path,
        },
        pipeline_done_rx,
    ))
}

pub async fn spawn_instant_recording_actor(
    id: String,
    recording_dir: PathBuf,
    options: RecordingOptions,
    audio_input_feed: Option<AudioInputFeed>,
) -> Result<(InstantRecordingHandle, tokio::sync::oneshot::Receiver<()>), RecordingError> {
    ensure_dir(&recording_dir)?;
    let logfile = File::create(recording_dir.join("recording-logs.log"))?;

    let collector = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(false)
                .with_writer(logfile)
                .with_filter(
                    tracing_subscriber::filter::EnvFilter::builder()
                        .with_default_directive(tracing::level_filters::LevelFilter::TRACE.into())
                        .from_env_lossy(),
                ),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(false)
                .with_filter(
                    tracing_subscriber::filter::EnvFilter::builder()
                        .with_default_directive(tracing::level_filters::LevelFilter::TRACE.into())
                        .from_env_lossy(),
                ),
        );

    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

    async {
        async {
            let run = async || {
                trace!("creating recording actor");

                let content_dir = ensure_dir(&recording_dir.join("content"))?;

                let screen_source = create_screen_capture(&options.capture_target, true, true, 30)?;

                debug!("screen capture: {screen_source:#?}");

                if let Some(audio_feed) = &audio_input_feed {
                    debug!("mic audio info: {:#?}", audio_feed.audio_info())
                }

                let (pipeline, pipeline_done_rx) = create_pipeline(
                    content_dir.join("output.mp4"),
                    screen_source.clone(),
                    audio_input_feed.as_ref(),
                )
                .await?;

                let segment_start_time = current_time_f64();

                let (ctrl_tx, ctrl_rx) = flume::bounded(1);

                trace!("spawning recording actor");

                spawn_actor({
                    let options = options.clone();
                    async move {
                        let mut actor = InstantRecordingActor {
                            id,
                            recording_dir,
                            capture_target: options.capture_target,
                            audio_input_name: options.audio_input_name,
                        };

                        let mut state = InstantRecordingActorState::Recording {
                            pipeline,
                            pipeline_done_rx,
                            segment_start_time,
                        };

                        'outer: loop {
                            state = match state {
                                InstantRecordingActorState::Recording {
                                    mut pipeline,
                                    mut pipeline_done_rx,
                                    segment_start_time,
                                } => {
                                    info!("recording actor recording");
                                    loop {
                                        let msg = tokio::select! {
                                            _ = &mut pipeline_done_rx => {
                                                break 'outer;
                                            }
                                            msg = ctrl_rx.recv_async() => {
                                                let Ok(msg) = msg else {
                                                    break 'outer;
                                                };

                                                info!("received control message: {msg:?}");

                                                msg
                                            }
                                        };

                                        async fn shutdown(
                                            mut pipeline: InstantRecordingPipeline,
                                            actor: &mut InstantRecordingActor,
                                            segment_start_time: f64,
                                        ) -> Result<(), RecordingError>
                                        {
                                            pipeline.inner.shutdown().await?;
                                            Ok(())
                                        }

                                        break match msg {
                                            InstantRecordingActorControlMessage::Pause(tx) => {
                                                InstantRecordingActorState::Recording {
                                                    pipeline,
                                                    pipeline_done_rx,
                                                    segment_start_time,
                                                }
                                                // let res = shutdown(
                                                //     pipeline,
                                                //     &mut actor,
                                                //     segment_start_time,
                                                // )
                                                // .await;

                                                // tx.send(res.map_err(Into::into)).ok();
                                                // InstantRecordingActorState::Paused
                                            }
                                            InstantRecordingActorControlMessage::Stop(tx) => {
                                                let res = shutdown(
                                                    pipeline,
                                                    &mut actor,
                                                    segment_start_time,
                                                )
                                                .await;
                                                let res = match res {
                                                    Ok(_) => stop_recording(actor).await,
                                                    Err(e) => Err(e),
                                                };

                                                tx.send(res).ok();

                                                break 'outer;
                                            }
                                            _ => continue,
                                        };
                                    }
                                }
                                InstantRecordingActorState::Paused => {
                                    info!("recording actor paused");
                                    loop {
                                        let Ok(msg) = ctrl_rx.recv_async().await else {
                                            break 'outer;
                                        };

                                        break match msg {
                                            InstantRecordingActorControlMessage::Stop(tx) => {
                                                tx.send(stop_recording(actor).await).ok();
                                                break 'outer;
                                            }
                                            InstantRecordingActorControlMessage::Resume(tx) => {
                                                // let (state, res) = match create_pipeline(
                                                //     &segments_dir,
                                                //     &cursors_dir,
                                                //     next_index,
                                                //     screen_source.clone(),
                                                //     camera_feed.as_deref(),
                                                //     audio_input_feed.as_ref(),
                                                //     cursors,
                                                //     next_cursor_id,
                                                // )
                                                // .await
                                                // {
                                                //     Ok((pipeline, pipeline_done_rx)) => (
                                                //         InstantRecordingActorState::Recording {
                                                //             pipeline,
                                                //             pipeline_done_rx,
                                                //             index: next_index,
                                                //             segment_start_time: current_time_f64(),
                                                //         },
                                                //         Ok(()),
                                                //     ),
                                                //     Err(e) => (
                                                //         InstantRecordingActorState::Stopped,
                                                //         Err(e.into()),
                                                //     ),
                                                // };

                                                // tx.send(res).ok();

                                                state
                                            }
                                            _ => continue,
                                        };
                                    }
                                }
                                InstantRecordingActorState::Stopped => {
                                    info!("recording actor paused");
                                    break;
                                }
                            };
                        }

                        info!("recording actor finished");

                        done_tx.send(()).ok();
                    }
                    .in_current_span()
                });

                Ok(InstantRecordingHandle { ctrl_tx, options })
            };

            match run().await {
                Ok(a) => Ok(a),
                Err(e) => {
                    error!("Failed to start recording actor: {}", e);
                    Err(e)
                }
            }
        }
        .instrument(tracing::info_span!("recording"))
        .await
    }
    .with_subscriber(collector)
    .await
    .map(|a| (a, done_rx))
}

async fn stop_recording(
    actor: InstantRecordingActor,
) -> Result<CompletedInstantRecording, RecordingError> {
    use cap_project::*;

    Ok(CompletedInstantRecording {
        id: actor.id,
        project_path: actor.recording_dir.clone(),
        meta: InstantRecordingMeta {
            fps: actor.capture_target.recording_fps(),
            sample_rate: None,
        },
        display_source: actor.capture_target,
    })
}

fn ensure_dir(path: &PathBuf) -> Result<PathBuf, MediaError> {
    std::fs::create_dir_all(&path)?;
    Ok(path.clone())
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
