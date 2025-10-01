use crate::{
    ActorError, RecordingBaseInputs, RecordingError,
    capture_pipeline::{MakeCapturePipeline, create_screen_capture},
    feeds::microphone::MicrophoneFeedLock,
    pipeline::RecordingPipeline,
    sources::{ScreenCaptureSource, ScreenCaptureTarget},
};
use cap_media::MediaError;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_project::InstantRecordingMeta;
use cap_timestamp::Timestamp;
use cap_utils::{ensure_dir, spawn_actor};
use flume::Receiver;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use tracing::{Instrument, debug, error, info, trace};

struct Pipeline {
    pub inner: RecordingPipeline,
    #[allow(unused)]
    pub output_path: PathBuf,
    pub pause_flag: Arc<AtomicBool>,
}

enum ActorState {
    Recording {
        pipeline: Pipeline,
        pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
        segment_start_time: f64,
    },
    Paused {
        pipeline: Pipeline,
        pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
        segment_start_time: f64,
    },
}

#[derive(Clone)]
pub struct ActorHandle {
    ctrl_tx: flume::Sender<ActorControlMessage>,
    pub capture_target: ScreenCaptureTarget,
    // pub bounds: Bounds,
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

impl ActorHandle {
    pub async fn stop(&self) -> Result<CompletedRecording, RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Stop)
    }

    pub async fn pause(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Pause)
    }

    pub async fn resume(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Resume)
    }

    pub async fn cancel(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Cancel)
    }
}

pub enum ActorControlMessage {
    Pause(oneshot::Sender<Result<(), RecordingError>>),
    Resume(oneshot::Sender<Result<(), RecordingError>>),
    Stop(oneshot::Sender<Result<CompletedRecording, RecordingError>>),
    Cancel(oneshot::Sender<Result<(), RecordingError>>),
}

impl std::fmt::Debug for ActorControlMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pause(_) => write!(f, "Pause"),
            Self::Resume(_) => write!(f, "Resume"),
            Self::Stop(_) => write!(f, "Stop"),
            Self::Cancel(_) => write!(f, "Cancel"),
        }
    }
}

pub struct Actor {
    recording_dir: PathBuf,
    capture_target: ScreenCaptureTarget,
    video_info: VideoInfo,
}

pub struct CompletedRecording {
    pub project_path: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: InstantRecordingMeta,
}

#[tracing::instrument(skip_all, name = "instant")]
async fn create_pipeline<TCaptureFormat: MakeCapturePipeline>(
    output_path: PathBuf,
    screen_source: (
        ScreenCaptureSource<TCaptureFormat>,
        flume::Receiver<(TCaptureFormat::VideoFormat, Timestamp)>,
    ),
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
    system_audio: Option<Receiver<(ffmpeg::frame::Audio, Timestamp)>>,
) -> Result<(Pipeline, oneshot::Receiver<Result<(), String>>), MediaError> {
    if let Some(mic_feed) = &mic_feed {
        debug!(
            "mic audio info: {:#?}",
            AudioInfo::from_stream_config(mic_feed.config())
        );
    };

    let pipeline_builder = RecordingPipeline::builder();

    let pause_flag = Arc::new(AtomicBool::new(false));
    let system_audio = system_audio.map(|v| (v, screen_source.0.audio_info()));
    let pipeline_builder = TCaptureFormat::make_instant_mode_pipeline(
        pipeline_builder,
        screen_source,
        mic_feed,
        system_audio,
        output_path.clone(),
        pause_flag.clone(),
    )
    .await?;

    let (mut pipeline, pipeline_done_rx) = pipeline_builder.build().await?;

    pipeline.play().await?;

    Ok((
        Pipeline {
            inner: pipeline,
            output_path,
            pause_flag,
        },
        pipeline_done_rx,
    ))
}

impl Actor {
    pub fn builder(output: PathBuf, capture_target: ScreenCaptureTarget) -> ActorBuilder {
        ActorBuilder::new(output, capture_target)
    }
}

pub struct ActorBuilder {
    output_path: PathBuf,
    capture_target: ScreenCaptureTarget,
    system_audio: bool,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
}

impl ActorBuilder {
    pub fn new(output: PathBuf, capture_target: ScreenCaptureTarget) -> Self {
        Self {
            output_path: output,
            capture_target,
            system_audio: false,
            mic_feed: None,
        }
    }

    pub fn with_system_audio(mut self, system_audio: bool) -> Self {
        self.system_audio = system_audio;
        self
    }

    pub fn with_mic_feed(mut self, mic_feed: Arc<MicrophoneFeedLock>) -> Self {
        self.mic_feed = Some(mic_feed);
        self
    }

    pub async fn build(
        self,
        #[cfg(target_os = "macos")] shareable_content: cidre::arc::R<cidre::sc::ShareableContent>,
    ) -> Result<(ActorHandle, oneshot::Receiver<Result<(), String>>), RecordingError> {
        spawn_instant_recording_actor(
            self.output_path,
            RecordingBaseInputs {
                capture_target: self.capture_target,
                capture_system_audio: self.system_audio,
                mic_feed: self.mic_feed,
                camera_feed: None,
                #[cfg(target_os = "macos")]
                shareable_content,
            },
        )
        .await
    }
}

pub async fn spawn_instant_recording_actor(
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs,
) -> Result<
    (
        ActorHandle,
        tokio::sync::oneshot::Receiver<Result<(), String>>,
    ),
    RecordingError,
> {
    ensure_dir(&recording_dir)?;

    let start_time = SystemTime::now();

    let (done_tx, done_rx) = oneshot::channel();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    let system_audio = if inputs.capture_system_audio {
        let (tx, rx) = flume::bounded(64);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };

    #[cfg(windows)]
    let d3d_device = crate::capture_pipeline::create_d3d_device()
        .map_err(|e| MediaError::Any(format!("CreateD3DDevice: {e}").into()))?;

    let (screen_source, screen_rx) = create_screen_capture(
        &inputs.capture_target,
        true,
        30,
        system_audio.0,
        start_time,
        #[cfg(windows)]
        d3d_device,
        inputs.shareable_content.retained(),
    )
    .await?;

    debug!("screen capture: {screen_source:#?}");

    let (pipeline, pipeline_done_rx) = create_pipeline(
        content_dir.join("output.mp4"),
        (screen_source.clone(), screen_rx.clone()),
        inputs.mic_feed.clone(),
        system_audio.1,
    )
    .await?;

    let segment_start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    trace!("spawning recording actor");

    spawn_actor({
        let inputs = inputs.clone();
        let video_info = screen_source.info();
        async move {
            let mut actor = Actor {
                recording_dir,
                capture_target: inputs.capture_target,
                video_info,
            };

            let mut state = ActorState::Recording {
                pipeline,
                pipeline_done_rx,
                segment_start_time,
            };

            let result = loop {
                match run_actor_iteration(state, &ctrl_rx, actor).await {
                    Ok(None) => break Ok(()),
                    Ok(Some((new_state, new_actor))) => {
                        state = new_state;
                        actor = new_actor;
                    }
                    Err(err) => break Err(err),
                }
            };

            info!("recording actor finished");

            let _ = done_tx.send(result.map_err(|v| v.to_string()));
        }
        .in_current_span()
    });

    Ok((
        ActorHandle {
            ctrl_tx,
            capture_target: inputs.capture_target,
            // bounds: *screen_source.get_bounds(),
        },
        done_rx,
    ))
}

#[derive(thiserror::Error, Debug)]
enum InstantRecordingActorError {
    #[error("Pipeline receiver dropped")]
    PipelineReceiverDropped,
    #[error("Control receiver dropped")]
    ControlReceiverDropped,
    #[error("{0}")]
    Other(String),
}

// Helper macro for sending responses
macro_rules! send_response {
    ($tx:expr, $res:expr) => {
        let _ = $tx.send($res);
    };
}

async fn run_actor_iteration(
    state: ActorState,
    ctrl_rx: &Receiver<ActorControlMessage>,
    actor: Actor,
) -> Result<Option<(ActorState, Actor)>, InstantRecordingActorError> {
    use ActorControlMessage as Msg;
    use ActorState as State;

    // Helper function to shutdown pipeline
    async fn shutdown(mut pipeline: Pipeline) -> Result<(), RecordingError> {
        pipeline.inner.shutdown().await?;
        Ok(())
    }

    // Log current state
    info!(
        "recording actor state: {:?}",
        match &state {
            State::Recording { .. } => "recording",
            State::Paused { .. } => "paused",
        }
    );

    // Receive event based on current state
    let event = match state {
        State::Recording {
            mut pipeline_done_rx,
            pipeline,
            segment_start_time,
        } => {
            tokio::select! {
                result = &mut pipeline_done_rx => {
                    return match result {
                        Ok(Ok(())) => Ok(None),
                        Ok(Err(e)) => Err(InstantRecordingActorError::Other(e)),
                        Err(_) => Err(InstantRecordingActorError::PipelineReceiverDropped),
                    }
                },
                msg = ctrl_rx.recv_async() => {
                    match msg {
                        Ok(msg) => {
                            info!("received control message: {msg:?}");
                            (msg, State::Recording { pipeline, pipeline_done_rx, segment_start_time })
                        },
                        Err(_) => return Err(InstantRecordingActorError::ControlReceiverDropped),
                    }
                }
            }
        }
        paused_state @ State::Paused { .. } => match ctrl_rx.recv_async().await {
            Ok(msg) => {
                info!("received control message: {msg:?}");
                (msg, paused_state)
            }
            Err(_) => return Err(InstantRecordingActorError::ControlReceiverDropped),
        },
    };

    let (event, state) = event;

    // Handle state transitions based on event and current state
    Ok(match (event, state) {
        // Pause from Recording
        (
            Msg::Pause(tx),
            State::Recording {
                pipeline,
                pipeline_done_rx,
                segment_start_time,
            },
        ) => {
            pipeline
                .pause_flag
                .store(true, std::sync::atomic::Ordering::SeqCst);
            send_response!(tx, Ok(()));
            Some((
                State::Paused {
                    pipeline,
                    pipeline_done_rx,
                    segment_start_time,
                },
                actor,
            ))
        }

        // Stop from any state
        (Msg::Stop(tx), state) => {
            let pipeline = match state {
                State::Recording { pipeline, .. } => pipeline,
                State::Paused { pipeline, .. } => pipeline,
            };

            let res = shutdown(pipeline).await;
            let res = match res {
                Ok(_) => Ok(stop_recording(actor).await),
                Err(e) => Err(e),
            };

            send_response!(tx, res);
            None
        }

        // Resume from Paused
        (
            Msg::Resume(tx),
            State::Paused {
                pipeline,
                pipeline_done_rx,
                segment_start_time,
            },
        ) => {
            pipeline
                .pause_flag
                .store(false, std::sync::atomic::Ordering::SeqCst);

            send_response!(tx, Ok(()));

            Some((
                State::Recording {
                    pipeline,
                    pipeline_done_rx,
                    segment_start_time,
                },
                actor,
            ))
        }

        // Cancel from any state
        (Msg::Cancel(tx), state) => {
            let pipeline = match state {
                State::Recording { pipeline, .. } => pipeline,
                State::Paused { pipeline, .. } => pipeline,
            };

            let res = shutdown(pipeline).await;
            send_response!(tx, res);
            None
        }

        // Invalid combinations - continue iteration
        (Msg::Pause(_), state @ State::Paused { .. }) => {
            // Already paused, ignore
            Some((state, actor))
        }
        (Msg::Resume(_), state @ State::Recording { .. }) => {
            // Already recording, ignore
            Some((state, actor))
        }
    })
}

async fn stop_recording(actor: Actor) -> CompletedRecording {
    use cap_project::*;

    CompletedRecording {
        project_path: actor.recording_dir.clone(),
        meta: InstantRecordingMeta {
            fps: actor.video_info.fps(),
            sample_rate: None,
        },
        display_source: actor.capture_target,
    }
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
