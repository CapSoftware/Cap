#[cfg(target_os = "macos")]
use crate::SendableShareableContent;
use crate::{
    RecordingBaseInputs,
    capture_pipeline::{
        MakeCapturePipeline, ScreenCaptureMethod, Stop, target_to_display_and_crop,
    },
    feeds::microphone::MicrophoneFeedLock,
    output_pipeline::{self, OutputPipeline},
    resolution_limits::ensure_even,
    sources::screen_capture::{ScreenCaptureConfig, ScreenCaptureTarget},
};
use anyhow::Context as _;
use cap_media_info::VideoInfo;
use cap_project::InstantRecordingMeta;
use cap_timestamp::Timestamps;
use cap_utils::ensure_dir;
use kameo::{Actor as _, prelude::*};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tracing::*;

struct Pipeline {
    video: OutputPipeline,
    audio: Option<OutputPipeline>,
    video_info: VideoInfo,
    segments_dir: PathBuf,
    segment_rx:
        Option<std::sync::mpsc::Receiver<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>>,
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
    health_rx: Option<output_pipeline::HealthReceiver>,
    segment_rx: Option<
        std::sync::Mutex<
            Option<
                std::sync::mpsc::Receiver<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>,
            >,
        >,
    >,
}

impl ActorHandle {
    pub async fn stop(&self) -> anyhow::Result<CompletedRecording> {
        Ok(self.actor_ref.ask(Stop).await?)
    }

    pub fn done_fut(&self) -> output_pipeline::DoneFut {
        self.done_fut.clone()
    }

    pub fn take_health_rx(&mut self) -> Option<output_pipeline::HealthReceiver> {
        self.health_rx.take()
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

    pub async fn is_paused(&self) -> anyhow::Result<bool> {
        Ok(self.actor_ref.ask(IsPaused).await?)
    }

    pub fn take_segment_rx(
        &self,
    ) -> Option<std::sync::mpsc::Receiver<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>>
    {
        self.segment_rx
            .as_ref()
            .and_then(|m| m.lock().ok().and_then(|mut guard| guard.take()))
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
    total_pause_duration: std::time::Duration,
    pause_started_at: Option<f64>,
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
            if let Some(audio) = pipeline.audio {
                let (audio_res, video_res) = tokio::join!(audio.stop(), pipeline.video.stop());
                if let Err(e) = audio_res {
                    warn!("Audio pipeline stop failed: {e:#}");
                }
                video_res?;
            } else {
                pipeline.video.stop().await?;
            }
        }

        Ok(())
    }
}

impl Message<Stop> for Actor {
    type Reply = anyhow::Result<CompletedRecording>;

    async fn handle(&mut self, _: Stop, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        if matches!(self.state, ActorState::Stopped) {
            return Err(anyhow::anyhow!("Recording already stopped"));
        }

        if let Some(pause_start) = self.pause_started_at.take() {
            let pause_elapsed = current_time_f64() - pause_start;
            if pause_elapsed > 0.0 {
                self.total_pause_duration += std::time::Duration::from_secs_f64(pause_elapsed);
            }
        }

        let segments_dir =
            replace_with::replace_with_or_abort_and_return(&mut self.state, |state| {
                let result = match &state {
                    ActorState::Recording { pipeline, .. }
                    | ActorState::Paused { pipeline, .. } => pipeline.segments_dir.clone(),
                    ActorState::Stopped => self.recording_dir.join("content").join("display"),
                };
                (result, state)
            });

        self.stop().await?;

        let has_init = segments_dir.join("init.mp4").exists();
        let has_segments = has_init
            && match std::fs::read_dir(&segments_dir) {
                Ok(entries) => entries
                    .filter_map(Result::ok)
                    .any(|e| e.path().extension().is_some_and(|ext| ext == "m4s")),
                Err(e) => {
                    warn!(
                        path = %segments_dir.display(),
                        error = %e,
                        "Failed to read segments directory, treating as no segments"
                    );
                    false
                }
            };

        let has_output_mp4 = segments_dir.join("output.mp4").exists()
            && std::fs::metadata(segments_dir.join("output.mp4"))
                .map(|m| m.len() > 0)
                .unwrap_or(false);

        let health = if has_segments || has_output_mp4 {
            crate::RecordingHealth::Healthy
        } else if has_init {
            crate::RecordingHealth::Degraded {
                issues: vec!["Recording too short — no complete segments produced".to_string()],
            }
        } else {
            crate::RecordingHealth::Damaged {
                reason: "No video segments produced".to_string(),
            }
        };

        Ok(CompletedRecording {
            project_path: self.recording_dir.clone(),
            meta: InstantRecordingMeta::Complete {
                fps: self.video_info.fps(),
                sample_rate: None,
            },
            display_source: self.capture_target.clone(),
            health,
        })
    }
}

pub struct Pause;

impl Message<Pause> for Actor {
    type Reply = ();

    async fn handle(&mut self, _: Pause, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.pause_started_at = Some(current_time_f64());
        replace_with::replace_with_or_abort(&mut self.state, |state| {
            if let ActorState::Recording {
                pipeline,
                segment_start_time,
            } = state
            {
                pipeline.video.pause();
                if let Some(ref audio) = pipeline.audio {
                    audio.pause();
                }
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
        if let Some(pause_start) = self.pause_started_at.take() {
            let pause_elapsed = current_time_f64() - pause_start;
            if pause_elapsed > 0.0 {
                self.total_pause_duration += std::time::Duration::from_secs_f64(pause_elapsed);
            }
        }
        replace_with::replace_with_or_abort(&mut self.state, |state| {
            if let ActorState::Paused {
                pipeline,
                segment_start_time,
            } = state
            {
                pipeline.video.resume();
                if let Some(ref audio) = pipeline.audio {
                    audio.resume();
                }
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

pub struct IsPaused;

impl Message<IsPaused> for Actor {
    type Reply = bool;

    async fn handle(&mut self, _: IsPaused, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        matches!(self.state, ActorState::Paused { .. })
    }
}

#[derive(Debug)]
pub struct CompletedRecording {
    pub project_path: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: InstantRecordingMeta,
    pub health: crate::RecordingHealth,
}

async fn create_pipeline(
    content_dir: PathBuf,
    screen_capture: crate::sources::screen_capture::VideoSourceConfig,
    screen_info: cap_media_info::VideoInfo,
    mic_feed: Option<Arc<MicrophoneFeedLock>>,
    system_audio_source: Option<crate::sources::screen_capture::SystemAudioSourceConfig>,
    max_output_size: Option<u32>,
    start_time: Timestamps,
) -> anyhow::Result<Pipeline> {
    let output_resolution = max_output_size
        .map(|max_output_size| {
            clamp_size(
                (screen_info.width, screen_info.height),
                (
                    max_output_size,
                    (max_output_size as f64 / 16.0 * 9.0) as u32,
                ),
            )
        })
        .unwrap_or_else(|| {
            (
                ensure_even(screen_info.width),
                ensure_even(screen_info.height),
            )
        });

    let segments_dir = content_dir.join("display");

    let segment_channel = {
        let (tx, rx) =
            std::sync::mpsc::channel::<cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent>();
        Some((tx, rx))
    };

    let segment_tx_for_video = segment_channel.as_ref().map(|(tx, _)| tx.clone());

    let video = ScreenCaptureMethod::make_instant_segmented_video_pipeline(
        screen_capture,
        segments_dir.clone(),
        output_resolution,
        start_time,
        segment_tx_for_video,
    )
    .await?;

    let has_audio = mic_feed.is_some() || system_audio_source.is_some();
    let audio = if has_audio {
        let audio_dir = content_dir.join("audio");
        let mut builder =
            output_pipeline::OutputPipeline::builder(audio_dir.clone()).with_timestamps(start_time);

        if let Some(sys_audio) = system_audio_source {
            builder = builder
                .with_audio_source::<crate::sources::screen_capture::SystemAudioSource>(sys_audio);
        }

        if let Some(mic) = mic_feed {
            builder = builder.with_audio_source::<crate::sources::Microphone>(mic);
        }

        let segment_tx_for_audio = segment_channel.as_ref().map(|(tx, _)| tx.clone());

        let audio_pipeline = builder
            .build::<output_pipeline::DashSegmentedAudioMuxer>(
                output_pipeline::DashSegmentedAudioMuxerConfig {
                    shared_pause_state: None,
                    segment_tx: segment_tx_for_audio,
                    ..Default::default()
                },
            )
            .await
            .context("audio pipeline setup")?;

        Some(audio_pipeline)
    } else {
        None
    };

    let segment_rx = segment_channel.map(|(_, rx)| rx);

    Ok(Pipeline {
        video,
        audio,
        video_info: VideoInfo::from_raw_ffmpeg(
            screen_info.pixel_format,
            output_resolution.0,
            output_resolution.1,
            screen_info.fps(),
        ),
        segments_dir,
        segment_rx,
    })
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
    camera_feed: Option<Arc<crate::feeds::camera::CameraFeedLock>>,
    max_output_size: Option<u32>,
    #[cfg(target_os = "macos")]
    excluded_windows: Vec<scap_targets::WindowId>,
}

impl ActorBuilder {
    pub fn new(output: PathBuf, capture_target: ScreenCaptureTarget) -> Self {
        Self {
            output_path: output,
            capture_target,
            system_audio: false,
            mic_feed: None,
            camera_feed: None,
            max_output_size: None,
            #[cfg(target_os = "macos")]
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

    pub fn with_camera_feed(
        mut self,
        camera_feed: Arc<crate::feeds::camera::CameraFeedLock>,
    ) -> Self {
        self.camera_feed = Some(camera_feed);
        self
    }

    pub fn with_max_output_size(mut self, max_output_size: u32) -> Self {
        self.max_output_size = Some(max_output_size);
        self
    }

    #[cfg(target_os = "macos")]
    pub fn with_excluded_windows(mut self, excluded_windows: Vec<scap_targets::WindowId>) -> Self {
        self.excluded_windows = excluded_windows;
        self
    }

    pub async fn build(
        self,
        #[cfg(target_os = "macos")] shareable_content: Option<SendableShareableContent>,
    ) -> anyhow::Result<ActorHandle> {
        spawn_instant_recording_actor(
            self.output_path,
            RecordingBaseInputs {
                capture_target: self.capture_target,
                capture_system_audio: self.system_audio,
                mic_feed: self.mic_feed,
                camera_feed: self.camera_feed,
                #[cfg(target_os = "macos")]
                shareable_content,
                #[cfg(target_os = "macos")]
                excluded_windows: self.excluded_windows,
            },
            self.max_output_size,
        )
        .await
    }
}

#[tracing::instrument("instant_recording", skip_all)]
pub async fn spawn_instant_recording_actor(
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs,
    max_output_size: Option<u32>,
) -> anyhow::Result<ActorHandle> {
    ensure_dir(&recording_dir)?;

    let timestamps = Timestamps::now();

    trace!("creating recording actor");

    let content_dir = ensure_dir(&recording_dir.join("content"))?;

    #[cfg(windows)]
    cap_mediafoundation_utils::thread_init();

    let (mut pipeline, video_info) = match inputs.capture_target {
        ScreenCaptureTarget::CameraOnly => {
            let camera_feed = inputs.camera_feed.clone().ok_or_else(|| {
                anyhow::anyhow!(
                    "Camera-only recording requires a camera, but no camera is currently available. \
                    Please select a camera in the recording settings before starting. \
                    If you have already selected a camera, it may have been disconnected or \
                    failed to initialize. Try reconnecting your camera or selecting a different one."
                )
            })?;

            let output_path = content_dir.join("output.mp4");

            let mut builder = OutputPipeline::builder(output_path.clone())
                .with_video::<crate::sources::NativeCamera>(camera_feed.clone())
                .with_timestamps(timestamps);

            if let Some(mic_feed) = inputs.mic_feed.clone() {
                builder = builder.with_audio_source::<crate::sources::Microphone>(mic_feed);
            }

            #[cfg(target_os = "macos")]
            let cam_pipeline = builder
                .build::<output_pipeline::AVFoundationCameraMuxer>(
                    output_pipeline::AVFoundationCameraMuxerConfig::default(),
                )
                .await
                .context("camera-only pipeline setup")?;

            #[cfg(windows)]
            let cam_pipeline = builder
                .build::<output_pipeline::WindowsCameraMuxer>(
                    output_pipeline::WindowsCameraMuxerConfig {
                        encoder_preferences: crate::capture_pipeline::EncoderPreferences::default(),
                        ..Default::default()
                    },
                )
                .await
                .context("camera-only pipeline setup")?;

            let video_info = *camera_feed.video_info();
            (
                Pipeline {
                    video: cam_pipeline,
                    audio: None,
                    video_info,
                    segments_dir: content_dir.clone(),
                    segment_rx: None,
                },
                video_info,
            )
        }
        _ => {
            #[cfg(windows)]
            let d3d_device = crate::capture_pipeline::create_d3d_device()?;

            let (display, crop_bounds) = target_to_display_and_crop(&inputs.capture_target)
                .context("target_display_crop")?;

            let screen_source = ScreenCaptureConfig::<ScreenCaptureMethod>::init(
                display,
                crop_bounds,
                true,
                30,
                None,
                timestamps.system_time(),
                inputs.capture_system_audio,
                #[cfg(windows)]
                d3d_device,
                #[cfg(target_os = "macos")]
                inputs
                    .shareable_content
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("Missing shareable content"))?,
                #[cfg(target_os = "macos")]
                inputs.excluded_windows,
            )
            .await
            .context("screen capture init")?;

            debug!("screen capture: {screen_source:#?}");

            let screen_info = screen_source.info();
            let (screen_capture, system_audio_source) = screen_source.to_sources().await?;

            let pipeline = create_pipeline(
                content_dir.clone(),
                screen_capture,
                screen_info,
                inputs.mic_feed.clone(),
                system_audio_source,
                max_output_size,
                timestamps,
            )
            .await?;

            let video_info = pipeline.video_info;

            (pipeline, video_info)
        }
    };

    let segment_start_time = current_time_f64();

    trace!("spawning recording actor");

    let segment_rx = pipeline.segment_rx.take();
    let done_fut = pipeline.video.done_fut();
    let health_rx = pipeline.video.take_health_rx();
    let actor_ref = Actor::spawn(Actor {
        recording_dir,
        capture_target: inputs.capture_target.clone(),
        video_info,
        state: ActorState::Recording {
            pipeline,
            segment_start_time,
        },
        total_pause_duration: std::time::Duration::ZERO,
        pause_started_at: None,
    });

    let actor_handle = ActorHandle {
        actor_ref: actor_ref.clone(),
        capture_target: inputs.capture_target,
        done_fut: done_fut.clone(),
        health_rx,
        segment_rx: segment_rx.map(|rx| std::sync::Mutex::new(Some(rx))),
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

fn clamp_size(input: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    // 16/9-ish
    if input.0 >= input.1 && (input.0 as f64 / input.1 as f64) <= 16.0 / 9.0 {
        let width = ensure_even(max.0.min(input.0));

        let height_ratio = input.1 as f64 / input.0 as f64;
        let height = ensure_even((height_ratio * width as f64).round() as u32);

        (width, height)
    }
    // 9/16-ish
    else if input.0 <= input.1 && (input.0 as f64 / input.1 as f64) >= 9.0 / 16.0 {
        let height = ensure_even(max.0.min(input.1));

        let width_ratio = input.0 as f64 / input.1 as f64;
        let width = ensure_even((width_ratio * height as f64).round() as u32);

        (width, height)
    }
    // ultrawide
    else if input.0 >= input.1 && (input.0 as f64 / input.1 as f64) > 16.0 / 9.0 {
        let height = ensure_even(max.1.min(input.1));

        let width_ratio = input.0 as f64 / input.1 as f64;
        let width = ensure_even((width_ratio * height as f64).round() as u32);

        (width, height)
    }
    // ultratall
    else if input.0 < input.1 && (input.0 as f64 / input.1 as f64) <= 9.0 / 16.0 {
        // swapped since max_width/height assume horizontal
        let width = ensure_even(max.1.min(input.0));

        let height_ratio = input.1 as f64 / input.0 as f64;
        let height = ensure_even((height_ratio * width as f64).round() as u32);

        (width, height)
    } else {
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp_size_16_9_ish_landscape() {
        // Test 16:9 aspect ratio (boundary case)
        let result = clamp_size((1920, 1080), (1920, 1080));
        assert_eq!(result, (1920, 1080));

        // Test aspect ratio less than 16:9 (wider than tall, but not ultrawide)
        let result = clamp_size((1600, 1200), (1920, 1080)); // 4:3 ratio
        assert_eq!(result, (1600, 1200));

        // Test scaling down when input exceeds max width
        let result = clamp_size((2560, 1440), (1920, 1080)); // 16:9 ratio, needs scaling
        assert_eq!(result, (1920, 1080));
    }

    #[test]
    fn test_clamp_size_9_16_ish_portrait() {
        // Test 9:16 aspect ratio (boundary case)
        let result = clamp_size((1080, 1920), (1920, 1080));
        assert_eq!(result, (1080, 1920));

        // Test aspect ratio greater than 9:16 but still portrait
        let result = clamp_size((1200, 1600), (1920, 1080)); // 3:4 ratio
        assert_eq!(result, (1200, 1600));

        // Test square format (1:1 ratio) - should use portrait path when width <= height
        let result = clamp_size((1080, 1080), (1920, 1080));
        assert_eq!(result, (1080, 1080));
    }

    #[test]
    fn test_clamp_size_ultrawide() {
        // Test ultrawide aspect ratio (> 16:9)
        let result = clamp_size((2560, 1080), (1920, 1080)); // ~2.37:1 ratio
        assert_eq!(result, (2560, 1080));

        // Test very ultrawide
        let result = clamp_size((3440, 1440), (1920, 1080)); // ~2.39:1 ratio
        assert_eq!(result, (2580, 1080));

        // Test when height constraint is the limiting factor
        let result = clamp_size((3840, 1600), (1920, 1080)); // 2.4:1 ratio
        assert_eq!(result, (2592, 1080));

        // Test even number enforcement for height
        let result = clamp_size((2561, 1080), (1920, 1081)); // Odd max height
        assert_eq!(result, (2560, 1080)); // Height should be made even

        // Test even number enforcement for calculated width
        let result = clamp_size((2561, 1080), (1920, 1080)); // Results in odd width calculation
        assert_eq!(result, (2560, 1080)); // Width should be made even
    }

    #[test]
    fn test_clamp_size_ultratall() {
        // Test ultratall aspect ratio (< 9:16)
        let result = clamp_size((1080, 2560), (1920, 1920)); // ~9:21.3 ratio
        assert_eq!(result, (1080, 2560));

        // Test very ultratall that needs scaling
        let result = clamp_size((800, 3200), (1920, 2000)); // 1:4 ratio
        assert_eq!(result, (800, 3200));

        // Test when width constraint is the limiting factor (using max.1 as width limit)
        let result = clamp_size((500, 3000), (1920, 1000)); // Very tall, width limited by max.1
        assert_eq!(result, (500, 3000));

        // Test even number enforcement for width (using max.1)
        let result = clamp_size((500, 3000), (1920, 1001)); // Odd max.1 used as width
        assert_eq!(result, (500, 3000)); // Width should be made even

        // Test even number enforcement for calculated height
        let result = clamp_size((500, 3000), (1920, 1000)); // Results in odd height calculation
        assert_eq!(result, (500, 3000)); // Height should be made even
    }

    #[test]
    fn test_clamp_size_edge_cases() {
        // Test minimum sizes
        let result = clamp_size((2, 2), (1920, 1080));
        assert_eq!(result, (2, 2));

        // Test when input is smaller than max in all dimensions
        let result = clamp_size((800, 600), (1920, 1080));
        assert_eq!(result, (800, 600));

        // Test exact 16:9 boundary
        let sixteen_nine = 16.0 / 9.0;
        let width = 1920;
        let height = (width as f64 / sixteen_nine) as u32; // Should be exactly 1080
        let result = clamp_size((width, height), (1920, 1080));
        assert_eq!(result, (1920, 1080));

        // Test exact 9:16 boundary
        let nine_sixteen = 9.0 / 16.0;
        let height = 1920;
        let width = (height as f64 * nine_sixteen) as u32; // Should be exactly 1080
        let result = clamp_size((width, height), (1920, 1080));
        assert_eq!(result, (1080, 1920));
    }
}
