use std::{
    fs::File,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
    time::{SystemTime, UNIX_EPOCH},
};

use cap_media::{
    data::VideoInfo,
    feeds::AudioInputFeed,
    pipeline::{Pipeline, RealTimeClock},
    platform::Bounds,
    sources::{AudioInputSource, AudioMixer, ScreenCaptureSource, ScreenCaptureTarget},
    MediaError,
};
use cap_project::InstantRecordingMeta;
use cap_utils::{ensure_dir, spawn_actor};
use ffmpeg::frame::Audio;
use flume::{Receiver, Sender};
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
    pub pause_flag: Arc<AtomicBool>,
}

enum InstantRecordingActorState {
    Recording {
        pipeline: InstantRecordingPipeline,
        pipeline_done_rx: oneshot::Receiver<()>,
        segment_start_time: f64,
    },
    Paused {
        pipeline: InstantRecordingPipeline,
        pipeline_done_rx: oneshot::Receiver<()>,
        segment_start_time: f64,
    },
    Stopped,
}

#[derive(Clone)]
pub struct InstantRecordingHandle {
    ctrl_tx: flume::Sender<InstantRecordingActorControlMessage>,
    pub options: RecordingOptions,
    pub bounds: Bounds,
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

    pub async fn cancel(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, InstantRecordingActorControlMessage::Cancel)
    }
}

pub enum InstantRecordingActorControlMessage {
    Pause(oneshot::Sender<Result<(), RecordingError>>),
    Resume(oneshot::Sender<Result<(), RecordingError>>),
    Stop(oneshot::Sender<Result<CompletedInstantRecording, RecordingError>>),
    Cancel(oneshot::Sender<Result<(), RecordingError>>),
}

impl std::fmt::Debug for InstantRecordingActorControlMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pause(_) => write!(f, "Pause"),
            Self::Resume(_) => write!(f, "Resume"),
            Self::Stop(_) => write!(f, "Stop"),
            Self::Cancel(_) => write!(f, "Cancel"),
        }
    }
}

pub struct InstantRecordingActor {
    id: String,
    recording_dir: PathBuf,
    capture_target: ScreenCaptureTarget,
    video_info: VideoInfo,
    audio_input_name: Option<String>,
}

pub struct CompletedInstantRecording {
    pub id: String,
    pub project_path: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: InstantRecordingMeta,
}

#[tracing::instrument(skip_all, name = "instant")]
async fn create_pipeline<TCaptureFormat: MakeCapturePipeline>(
    output_path: PathBuf,
    screen_source: (
        ScreenCaptureSource<TCaptureFormat>,
        flume::Receiver<(TCaptureFormat::VideoFormat, f64)>,
    ),
    audio_input_feed: Option<&AudioInputFeed>,
    system_audio: Option<Receiver<(ffmpeg::frame::Audio, f64)>>,
) -> Result<(InstantRecordingPipeline, oneshot::Receiver<()>), MediaError> {
    let clock = RealTimeClock::<()>::new();
    let pipeline_builder = Pipeline::builder(clock);

    let pause_flag = Arc::new(AtomicBool::new(false));
    let system_audio = system_audio.map(|v| (v, screen_source.0.audio_info()));
    let pipeline_builder = TCaptureFormat::make_instant_mode_pipeline(
        pipeline_builder,
        screen_source,
        audio_input_feed,
        system_audio,
        output_path.clone(),
        pause_flag.clone(),
    )
    .await?;

    let (mut pipeline, pipeline_done_rx) = pipeline_builder.build().await?;

    pipeline.play().await?;

    Ok((
        InstantRecordingPipeline {
            inner: pipeline,
            output_path,
            pause_flag,
        },
        pipeline_done_rx,
    ))
}

pub async fn spawn_instant_recording_actor(
    id: String,
    recording_dir: PathBuf,
    options: RecordingOptions,
    audio_input_feed: Option<&AudioInputFeed>,
) -> Result<(InstantRecordingHandle, tokio::sync::oneshot::Receiver<()>), RecordingError> {
    ensure_dir(&recording_dir)?;

    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    let system_audio = if options.capture_system_audio {
        let (tx, rx) = flume::bounded(64);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };

    let (screen_source, screen_rx) =
        create_screen_capture(&options.capture_target, true, true, 30, system_audio.0)?;

    debug!("screen capture: {screen_source:#?}");

    if let Some(audio_feed) = &audio_input_feed {
        debug!("mic audio info: {:#?}", audio_feed.audio_info())
    }

    let (pipeline, pipeline_done_rx) = create_pipeline(
        content_dir.join("output.mp4"),
        (screen_source.clone(), screen_rx.clone()),
        audio_input_feed,
        system_audio.1,
    )
    .await?;

    let segment_start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    trace!("spawning recording actor");

    spawn_actor({
        let options = options.clone();
        let video_info = screen_source.info();
        async move {
            let mut actor = InstantRecordingActor {
                id,
                recording_dir,
                capture_target: options.capture_target,
                video_info,
                audio_input_name: options.mic_name,
            };

            let mut state = InstantRecordingActorState::Recording {
                pipeline,
                pipeline_done_rx,
                segment_start_time,
            };

            'outer: loop {
                state = match state {
                    InstantRecordingActorState::Recording {
                        pipeline,
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
                            ) -> Result<(), RecordingError> {
                                pipeline.inner.shutdown().await?;
                                Ok(())
                            }

                            break match msg {
                                InstantRecordingActorControlMessage::Pause(tx) => {
                                    pipeline
                                        .pause_flag
                                        .store(true, std::sync::atomic::Ordering::SeqCst);
                                    let _ = tx.send(Ok(()));
                                    InstantRecordingActorState::Paused {
                                        pipeline,
                                        pipeline_done_rx,
                                        segment_start_time,
                                    }
                                }
                                InstantRecordingActorControlMessage::Stop(tx) => {
                                    let res =
                                        shutdown(pipeline, &mut actor, segment_start_time).await;
                                    let res = match res {
                                        Ok(_) => stop_recording(actor).await,
                                        Err(e) => Err(e),
                                    };

                                    tx.send(res).ok();

                                    break 'outer;
                                }
                                InstantRecordingActorControlMessage::Cancel(tx) => {
                                    let res =
                                        shutdown(pipeline, &mut actor, segment_start_time).await;

                                    tx.send(res).ok();
                                    return;
                                }
                                _ => continue,
                            };
                        }
                    }
                    InstantRecordingActorState::Paused {
                        pipeline,
                        pipeline_done_rx,
                        segment_start_time,
                    } => {
                        info!("recording actor paused");

                        async fn shutdown(
                            mut pipeline: InstantRecordingPipeline,
                        ) -> Result<(), RecordingError> {
                            pipeline.inner.shutdown().await?;
                            Ok(())
                        }

                        loop {
                            let Ok(msg) = ctrl_rx.recv_async().await else {
                                break 'outer;
                            };

                            break match msg {
                                InstantRecordingActorControlMessage::Stop(tx) => {
                                    let _ = shutdown(pipeline).await;
                                    let _ = tx.send(stop_recording(actor).await).ok();

                                    break 'outer;
                                }
                                InstantRecordingActorControlMessage::Resume(tx) => {
                                    pipeline
                                        .pause_flag
                                        .store(false, std::sync::atomic::Ordering::SeqCst);

                                    let _ = tx.send(Ok(()));

                                    InstantRecordingActorState::Recording {
                                        pipeline,
                                        pipeline_done_rx,
                                        segment_start_time,
                                    }
                                }
                                InstantRecordingActorControlMessage::Cancel(tx) => {
                                    let res = shutdown(pipeline).await;

                                    tx.send(res).ok();
                                    return;
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

    Ok((
        InstantRecordingHandle {
            ctrl_tx,
            options,
            bounds: screen_source.get_bounds().clone(),
        },
        done_rx,
    ))
}

async fn stop_recording(
    actor: InstantRecordingActor,
) -> Result<CompletedInstantRecording, RecordingError> {
    use cap_project::*;

    Ok(CompletedInstantRecording {
        id: actor.id,
        project_path: actor.recording_dir.clone(),
        meta: InstantRecordingMeta {
            fps: actor.video_info.fps(),
            sample_rate: None,
        },
        display_source: actor.capture_target,
    })
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
