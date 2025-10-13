use crate::{
    RecordingBaseInputs,
    capture_pipeline::{MakeCapturePipeline, ScreenCaptureMethod, Stop, create_screen_capture},
    feeds::microphone::MicrophoneFeedLock,
    output_pipeline::{self, OutputPipeline},
    sources::screen_capture::{ScreenCaptureConfig, ScreenCaptureTarget},
};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_project::InstantRecordingMeta;
use cap_utils::ensure_dir;
use kameo::{Actor as _, prelude::*};
use scap_targets::WindowId;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tracing::*;

struct Pipeline {
    output: OutputPipeline,
}

enum ActorState {
    Recording {
        pipeline: Pipeline,
        // pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
        segment_start_time: f64,
    },
    Paused {
        pipeline: Pipeline,
        // pipeline_done_rx: oneshot::Receiver<Result<(), String>>,
        segment_start_time: f64,
    },
    Stopped,
}

pub struct ActorHandle {
    actor_ref: kameo::actor::ActorRef<Actor>,
    pub capture_target: ScreenCaptureTarget,
    done_fut: output_pipeline::DoneFut,
}

impl ActorHandle {
    pub async fn stop(&self) -> anyhow::Result<CompletedRecording> {
        Ok(self.actor_ref.ask(Stop).await?)
    }

    pub fn done_fut(&self) -> output_pipeline::DoneFut {
        self.done_fut.clone()
    }

    pub async fn pause(&self) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(Pause).await?)
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(Resume).await?)
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        Ok(self.actor_ref.ask(Cancel).await?)
    }
}

impl Drop for ActorHandle {
    fn drop(&mut self) {
        let actor_ref = self.actor_ref.clone();
        tokio::spawn(async move {
            let _ = actor_ref.tell(Stop).await;
        });
    }
}

#[derive(kameo::Actor)]
pub struct Actor {
    recording_dir: PathBuf,
    capture_target: ScreenCaptureTarget,
    video_info: VideoInfo,
    state: ActorState,
}

impl Actor {
    async fn stop(&mut self) -> anyhow::Result<()> {
        let pipeline = replace_with::replace_with_or_abort_and_return(&mut self.state, |state| {
            (
                match state {
                    ActorState::Recording { pipeline, .. } => Some(pipeline),
                    ActorState::Paused { pipeline, .. } => Some(pipeline),
                    _ => None,
                },
                ActorState::Stopped,
            )
        });

        if let Some(pipeline) = pipeline {
            pipeline.output.stop().await?;
        }

        Ok(())
    }
}

impl Message<Stop> for Actor {
    type Reply = anyhow::Result<CompletedRecording>;

    async fn handle(&mut self, _: Stop, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.stop().await?;

        Ok(CompletedRecording {
            project_path: self.recording_dir.clone(),
            meta: InstantRecordingMeta::Complete {
                fps: self.video_info.fps(),
                sample_rate: None,
            },
            display_source: self.capture_target.clone(),
        })
    }
}

pub struct Pause;

impl Message<Pause> for Actor {
    type Reply = ();

    async fn handle(&mut self, _: Pause, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        replace_with::replace_with_or_abort(&mut self.state, |state| {
            if let ActorState::Recording {
                pipeline,
                segment_start_time,
            } = state
            {
                pipeline.output.pause();
                return ActorState::Paused {
                    pipeline,
                    segment_start_time,
                };
            }

            state
        });
    }
}

pub struct Resume;

impl Message<Resume> for Actor {
    type Reply = ();

    async fn handle(&mut self, _: Resume, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        replace_with::replace_with_or_abort(&mut self.state, |state| {
            if let ActorState::Paused {
                pipeline,
                segment_start_time,
            } = state
            {
                pipeline.output.resume();
                return ActorState::Recording {
                    pipeline,
                    segment_start_time,
                };
            }

            state
        });
    }
}

pub struct Cancel;

impl Message<Cancel> for Actor {
    type Reply = anyhow::Result<()>;

    async fn handle(&mut self, _: Cancel, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        let _ = self.stop().await;

        Ok(())
    }
}

#[derive(Debug)]
pub struct CompletedRecording {
    pub project_path: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: InstantRecordingMeta,
}

async fn create_pipeline(
    output_path: PathBuf,
    screen_source: ScreenCaptureConfig<ScreenCaptureMethod>,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
) -> anyhow::Result<Pipeline> {
    if let Some(mic_feed) = &mic_feed {
        debug!(
            "mic audio info: {:#?}",
            AudioInfo::from_stream_config(mic_feed.config())
        );
    };

    let (screen_capture, system_audio) = screen_source.to_sources().await?;

    let output = ScreenCaptureMethod::make_instant_mode_pipeline(
        screen_capture,
        system_audio,
        mic_feed,
        output_path.clone(),
    )
    .await?;

    Ok(Pipeline { output })
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
    excluded_windows: Vec<WindowId>,
}

impl ActorBuilder {
    pub fn new(output: PathBuf, capture_target: ScreenCaptureTarget) -> Self {
        Self {
            output_path: output,
            capture_target,
            system_audio: false,
            mic_feed: None,
            excluded_windows: Vec::new(),
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

    pub fn with_excluded_windows(mut self, excluded_windows: Vec<WindowId>) -> Self {
        self.excluded_windows = excluded_windows;
        self
    }

    pub async fn build(
        self,
        #[cfg(target_os = "macos")] shareable_content: cidre::arc::R<cidre::sc::ShareableContent>,
    ) -> anyhow::Result<ActorHandle> {
        spawn_instant_recording_actor(
            self.output_path,
            RecordingBaseInputs {
                capture_target: self.capture_target,
                capture_system_audio: self.system_audio,
                mic_feed: self.mic_feed,
                camera_feed: None,
                #[cfg(target_os = "macos")]
                shareable_content,
                excluded_windows: self.excluded_windows,
            },
        )
        .await
    }
}

#[tracing::instrument("instant_recording", skip_all)]
pub async fn spawn_instant_recording_actor(
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs,
) -> anyhow::Result<ActorHandle> {
    ensure_dir(&recording_dir)?;

    let start_time = SystemTime::now();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    #[cfg(windows)]
    cap_mediafoundation_utils::thread_init();

    #[cfg(windows)]
    let d3d_device = crate::capture_pipeline::create_d3d_device()?;

    let screen_source = create_screen_capture(
        &inputs.capture_target,
        true,
        30,
        start_time,
        inputs.capture_system_audio,
        #[cfg(windows)]
        d3d_device,
        #[cfg(target_os = "macos")]
        inputs.shareable_content.retained(),
        &inputs.excluded_windows,
    )
    .await?;

    debug!("screen capture: {screen_source:#?}");

    let pipeline = create_pipeline(
        content_dir.join("output.mp4"),
        screen_source.clone(),
        inputs.mic_feed.clone(),
    )
    .await?;

    let segment_start_time = current_time_f64();

    trace!("spawning recording actor");

    let done_fut = pipeline.output.done_fut();
    let actor_ref = Actor::spawn(Actor {
        recording_dir,
        capture_target: inputs.capture_target.clone(),
        video_info: screen_source.info(),
        state: ActorState::Recording {
            pipeline,
            // pipeline_done_rx,
            segment_start_time,
        },
    });

    let actor_handle = ActorHandle {
        actor_ref: actor_ref.clone(),
        capture_target: inputs.capture_target,
        done_fut: done_fut.clone(),
    };

    tokio::spawn(async move {
        let _ = done_fut.await;
        let _ = actor_ref.ask(Stop).await;
    });

    Ok(actor_handle)
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
