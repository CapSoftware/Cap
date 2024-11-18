use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use cap_media::{
    encoders::{H264Encoder, MP3Encoder, Output},
    feeds::{AudioInputFeed, CameraFeed},
    filters::VideoFilter,
    pipeline::{builder::PipelineBuilder, Pipeline, RealTimeClock},
    sources::{AudioInputSource, CameraSource, ScreenCaptureSource},
    MediaError,
};
use thiserror::Error;
use tokio::sync::{oneshot, Mutex};

use crate::RecordingOptions;

enum ActorState {
    Recording {
        pipeline: Pipeline<RealTimeClock<()>>,
        index: u32,
        segment_start_time: f64,
    },
    Paused {
        next_index: u32,
    },
    Stopped,
}

pub enum ActorControlMessage {
    Pause(oneshot::Sender<Result<(), RecordingError>>),
    Resume(oneshot::Sender<Result<(), RecordingError>>),
    Stop(oneshot::Sender<Result<(), RecordingError>>),
}

pub struct Actor {
    recording_dir: PathBuf,
    options: RecordingOptions,
    segments: Vec<(f64, f64)>,
}

pub struct ActorHandle {
    ctrl_tx: flume::Sender<ActorControlMessage>,
    pub options: RecordingOptions,
}

#[derive(Error, Debug)]
pub enum ActorError {
    #[error("Actor has stopped")]
    ActorStopped,

    #[error("Failed to send to actor")]
    SendFailed(#[from] flume::SendError<ActorControlMessage>),
}

#[derive(Error, Debug)]
pub enum RecordingError {
    #[error("Media error: {0}")]
    Media(#[from] MediaError),

    #[error("Actor error: {0}")]
    Actor(#[from] ActorError),
}

macro_rules! send_message {
    ($ctrl_tx:expr, $variant:path) => {{
        let (tx, rx) = oneshot::channel();
        $ctrl_tx.send($variant(tx)).map_err(ActorError::from)?;
        Ok(rx.await.map_err(|_| ActorError::ActorStopped)??)
    }};
}

impl ActorHandle {
    pub async fn stop(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Stop)
    }

    pub async fn pause(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Pause)
    }

    pub async fn resume(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, ActorControlMessage::Resume)
    }
}

pub async fn start_recording_actor(
    recording_dir: impl Into<PathBuf>,
    options: RecordingOptions,
    camera_feed: Option<Arc<Mutex<CameraFeed>>>,
    audio_input_feed: Option<AudioInputFeed>,
) -> Result<ActorHandle, RecordingError> {
    let recording_dir = recording_dir.into();

    let content_dir = ensure_dir(recording_dir.join("content"))?;

    let segments_dir = ensure_dir(content_dir.join("segments"))?;
    let cursors_dir = ensure_dir(content_dir.join("cursors"))?;

    let screen_source = create_screen_capture(&options);

    let index = 0;
    let pipeline = create_segment_pipeline(
        &segments_dir,
        index,
        screen_source.clone(),
        camera_feed.as_ref().map(|f| &**f),
        audio_input_feed.as_ref(),
    )
    .await?;

    let segment_start_time = current_time_f64();

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    tokio::spawn({
        let options = options.clone();
        async move {
            let mut actor = Actor {
                recording_dir,
                options,
                segments: Vec::new(),
            };

            let mut state = ActorState::Recording {
                pipeline,
                index,
                segment_start_time,
            };

            loop {
                state = match state {
                    ActorState::Recording {
                        mut pipeline,
                        index,
                        segment_start_time,
                    } => loop {
                        let Ok(msg) = ctrl_rx.recv_async().await else {
                            return;
                        };

                        if matches!(
                            &msg,
                            ActorControlMessage::Pause(_) | ActorControlMessage::Stop(_)
                        ) {
                            let segment_stop_time = current_time_f64();
                            actor.segments.push((segment_start_time, segment_stop_time));
                        }

                        break match msg {
                            ActorControlMessage::Pause(tx) => {
                                let res = pipeline.shutdown().await;
                                tx.send(res.map_err(Into::into)).ok();
                                ActorState::Paused {
                                    next_index: index + 1,
                                }
                            }
                            ActorControlMessage::Stop(tx) => {
                                tx.send(stop_recording(Some(pipeline)).await).ok();
                                return;
                            }
                            _ => continue,
                        };
                    },
                    ActorState::Paused { next_index } => loop {
                        let Ok(msg) = ctrl_rx.recv_async().await else {
                            return;
                        };

                        break match msg {
                            ActorControlMessage::Stop(tx) => {
                                tx.send(stop_recording(None).await).ok();
                                ActorState::Stopped
                            }
                            ActorControlMessage::Resume(tx) => {
                                let (state, res) = match create_segment_pipeline(
                                    &segments_dir,
                                    next_index,
                                    screen_source.clone(),
                                    camera_feed.as_ref().map(|f| &**f),
                                    audio_input_feed.as_ref(),
                                )
                                .await
                                {
                                    Ok(pipeline) => (
                                        ActorState::Recording {
                                            pipeline,
                                            index: next_index,
                                            segment_start_time: current_time_f64(),
                                        },
                                        Ok(()),
                                    ),
                                    Err(e) => (ActorState::Stopped, Err(e.into())),
                                };

                                tx.send(res).ok();

                                state
                            }
                            _ => continue,
                        };
                    },
                    ActorState::Stopped => return,
                };
            }
        }
    });

    Ok(ActorHandle { ctrl_tx, options })
}

async fn stop_recording(
    pipeline: Option<Pipeline<RealTimeClock<()>>>,
) -> Result<(), RecordingError> {
    if let Some(mut pipeline) = pipeline {
        pipeline.shutdown().await?;
    }

    Ok(())
}

fn create_screen_capture(
    recording_options: &RecordingOptions,
) -> ScreenCaptureSource<impl MakeCapturePipeline> {
    #[cfg(target_os = "macos")]
    {
        ScreenCaptureSource::<cap_media::sources::CMSampleBufferCapture>::init(
            dbg!(&recording_options.capture_target),
            None,
            None,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        ScreenCaptureSource::<AVFrameCapture>::init(
            dbg!(&recording_options.capture_target),
            None,
            None,
        )
    }
}

async fn create_segment_pipeline<TCaptureFormat: MakeCapturePipeline>(
    segments_dir: &PathBuf,
    index: u32,
    screen_source: ScreenCaptureSource<TCaptureFormat>,
    camera_feed: Option<&Mutex<CameraFeed>>,
    audio_input_feed: Option<&AudioInputFeed>,
) -> Result<Pipeline<RealTimeClock<()>>, MediaError> {
    let camera_feed = match camera_feed.as_ref() {
        Some(camera_feed) => Some(camera_feed.lock().await),
        None => None,
    };
    let camera_feed = camera_feed.as_ref().map(|f| &**f);

    let dir = ensure_dir(segments_dir.join(format!("segment-{index}")))?;

    let clock = RealTimeClock::<()>::new();
    let mut pipeline_builder = Pipeline::builder(clock);

    let display_output_path = dir.join("display.mp4");
    let mut audio_output_path = None;
    let mut camera_output_path = None;

    pipeline_builder = TCaptureFormat::make_capture_pipeline(
        pipeline_builder,
        screen_source,
        display_output_path,
    )?;

    if let Some(mic_source) = audio_input_feed.map(AudioInputSource::init) {
        let mic_config = mic_source.info();
        audio_output_path = Some(dir.join("audio-input.mp3"));

        // let mic_filter = AudioFilter::init("microphone", mic_config, "aresample=async=1:min_hard_comp=0.100000:first_pts=0")?;
        let mic_encoder = MP3Encoder::init(
            "microphone",
            mic_config,
            Output::File(audio_output_path.clone().unwrap()),
        )?;

        pipeline_builder = pipeline_builder
            .source("microphone_capture", mic_source)
            // .pipe("microphone_filter", mic_filter)
            .sink("microphone_encoder", mic_encoder);
    }

    if let Some(camera_source) = camera_feed.map(CameraSource::init) {
        let camera_config = camera_source.info();
        let output_config = camera_config.scaled(1920, 30);
        camera_output_path = Some(dir.join("camera.mp4"));

        let camera_filter = VideoFilter::init("camera", camera_config, output_config)?;
        let camera_encoder = H264Encoder::init(
            "camera",
            output_config,
            Output::File(camera_output_path.clone().unwrap()),
        )?;

        pipeline_builder = pipeline_builder
            .source("camera_capture", camera_source)
            .pipe("camera_filter", camera_filter)
            .sink("camera_encoder", camera_encoder);
    }

    let mut pipeline = pipeline_builder.build().await?;

    pipeline.play().await?;

    Ok(pipeline)
}

fn ensure_dir(path: PathBuf) -> Result<PathBuf, MediaError> {
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

type CapturePipelineBuilder = PipelineBuilder<RealTimeClock<()>>;

trait MakeCapturePipeline: 'static {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized;
}

impl MakeCapturePipeline for cap_media::sources::CMSampleBufferCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let screen_config = source.info();

        let output_config = screen_config.scaled(1920, 30);
        let screen_encoder = cap_media::encoders::H264AVAssetWriterEncoder::init(
            "screen",
            output_config,
            Output::File(output_path.into()),
        )?;

        Ok(builder
            .source("screen_capture", source)
            .sink("screen_capture_encoder", screen_encoder))
    }
}

impl MakeCapturePipeline for cap_media::sources::AVFrameCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        let screen_config = source.info();
        // let screen_bounds = screen_source.bounds;

        let output_config = screen_config.scaled(1920, 30);
        let screen_filter = VideoFilter::init("screen", screen_config, output_config)?;
        let screen_encoder =
            H264Encoder::init("screen", output_config, Output::File(output_path.into()))?;
        Ok(builder
            .source("screen_capture", source)
            .pipe("screen_capture_filter", screen_filter)
            .sink("screen_capture_encoder", screen_encoder))
    }
}

fn current_time_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
