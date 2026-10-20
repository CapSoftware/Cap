use anyhow::{Context, Result};
use cpal::StreamError;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tracing::{info, warn};

pub struct RecordedArtifacts {
    #[allow(dead_code)]
    pub project_path: PathBuf,
    pub display_outputs: Vec<PathBuf>,
    #[allow(dead_code)]
    pub held_temp_dir: Option<TempDir>,
}

pub struct StudioRecordingOptions {
    pub display_id: Option<String>,
    pub target_fps: u32,
    pub duration: Duration,
    pub include_mic: bool,
    pub include_camera: bool,
    pub include_system_audio: bool,
    pub fragmented: bool,
}

impl Default for StudioRecordingOptions {
    fn default() -> Self {
        Self {
            display_id: None,
            target_fps: 30,
            duration: Duration::from_secs(10),
            include_mic: true,
            include_camera: false,
            include_system_audio: true,
            fragmented: true,
        }
    }
}

pub async fn record_studio_for_duration(opts: StudioRecordingOptions) -> Result<RecordedArtifacts> {
    let temp_dir = TempDir::new()?;
    let project_path = temp_dir.path().to_path_buf();
    let completed_path = record_studio_at_path(opts, project_path).await?;

    let display_outputs = materialize_display_outputs(&completed_path)?;

    Ok(RecordedArtifacts {
        project_path: completed_path,
        display_outputs,
        held_temp_dir: Some(temp_dir),
    })
}

pub async fn record_studio_at_path(
    mut opts: StudioRecordingOptions,
    project_path: PathBuf,
) -> Result<PathBuf> {
    use cap_recording::{
        CameraFeed, MicrophoneFeed, feeds::camera, screen_capture::ScreenCaptureTarget,
        studio_recording,
    };
    use kameo::Actor as _;
    use scap_targets::Display;

    let display = if let Some(ref id) = opts.display_id {
        use std::str::FromStr;
        scap_targets::DisplayId::from_str(id)
            .ok()
            .and_then(|id| Display::from_id(&id))
            .unwrap_or_else(Display::primary)
    } else {
        Display::primary()
    };

    #[cfg(target_os = "macos")]
    let shareable_content = cidre::sc::ShareableContent::current()
        .await
        .context("Failed to get shareable content - check screen recording permissions")
        .map(cap_recording::SendableShareableContent::from)?;

    let (error_tx, _error_rx) = flume::bounded::<StreamError>(16);

    let mic_lock = if opts.include_mic {
        if let Some((label, _, _)) = MicrophoneFeed::default_device() {
            let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx.clone()));
            mic_feed
                .ask(cap_recording::feeds::microphone::SetInput {
                    label,
                    settings: None,
                })
                .await?
                .await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            Some(Arc::new(
                mic_feed.ask(cap_recording::feeds::microphone::Lock).await?,
            ))
        } else {
            warn!("No microphone device found");
            None
        }
    } else {
        None
    };

    opts.include_mic = mic_lock.is_some();

    let camera_lock = if opts.include_camera {
        if let Some(camera_info) = cap_camera::list_cameras().next() {
            info!("Using camera '{}'", camera_info.display_name());
            let camera_feed = CameraFeed::spawn(CameraFeed::default());
            camera_feed
                .ask(camera::SetInput {
                    settings: None,
                    id: camera::DeviceOrModelID::from_info(&camera_info),
                })
                .await?
                .await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            Some(Arc::new(camera_feed.ask(camera::Lock).await?))
        } else {
            warn!("No camera device found");
            None
        }
    } else {
        None
    };

    opts.include_camera = camera_lock.is_some();

    let mut builder = studio_recording::Actor::builder(
        project_path.clone(),
        ScreenCaptureTarget::Display { id: display.id() },
    )
    .with_max_fps(opts.target_fps)
    .with_fragmented(opts.fragmented);

    if opts.include_system_audio {
        builder = builder.with_system_audio(true);
    }

    if let Some(mic) = mic_lock {
        builder = builder.with_mic_feed(mic);
    }

    if let Some(camera) = camera_lock {
        builder = builder.with_camera_feed(camera);
    }

    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            Some(shareable_content),
        )
        .await
        .context("Failed to start recording")?;

    info!(
        "Recording for {}s at {}fps -> {}",
        opts.duration.as_secs(),
        opts.target_fps,
        project_path.display()
    );

    tokio::time::sleep(opts.duration).await;

    let completed = handle.stop().await.context("Failed to stop recording")?;
    Ok(completed.project_path)
}

pub fn materialize_display_outputs(project_path: &Path) -> Result<Vec<PathBuf>> {
    use cap_recording::recovery::RecoveryManager;

    if let Some(incomplete) = RecoveryManager::inspect_recording(project_path) {
        match RecoveryManager::recover(&incomplete) {
            Ok(_) => {}
            Err(err) => {
                warn!(
                    "Recovery attempt on recorded project returned: {}. \
                     Continuing with any existing display.mp4 files.",
                    err
                );
            }
        }
    }

    let mut outputs = Vec::new();
    let content_dir = project_path.join("content");
    let segments_dir = content_dir.join("segments");
    if segments_dir.is_dir() {
        let mut entries: Vec<_> = std::fs::read_dir(&segments_dir)?
            .filter_map(|r| r.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        entries.sort();
        for entry in entries {
            let candidate = entry.join("display.mp4");
            if candidate.exists() {
                outputs.push(candidate);
            }
        }
    }
    let legacy = content_dir.join("display.mp4");
    if legacy.exists() {
        outputs.push(legacy);
    }

    Ok(outputs)
}

pub struct InstantArtifacts {
    pub output_path: PathBuf,
    #[allow(dead_code)]
    pub held_temp_dir: Option<TempDir>,
}

/// Records a camera-only **instant-mode** recording (the same `instant_recording`
/// actor the desktop app uses) for `duration`, returning the muxed `output.mp4`.
/// Camera-only is used because a camera is a continuous source, so the video
/// frame-gap probe is reliable — the point is to exercise the instant-mode
/// `mux-video`/timestamp path, which is shared with studio mode.
pub async fn record_instant_camera_for_duration(
    target_fps: u32,
    duration: Duration,
    include_mic: bool,
) -> Result<InstantArtifacts> {
    use cap_recording::{
        CameraFeed, MicrophoneFeed, feeds::camera, instant_recording,
        screen_capture::ScreenCaptureTarget,
    };
    use kameo::Actor as _;

    let temp_dir = TempDir::new()?;
    let project_path = temp_dir.path().to_path_buf();

    let camera_info = cap_camera::list_cameras()
        .next()
        .context("instant-mode camera test requires a camera, but none was found")?;
    info!(
        "Using camera '{}' (instant mode)",
        camera_info.display_name()
    );

    let camera_feed = CameraFeed::spawn(CameraFeed::default());
    camera_feed
        .ask(camera::SetInput {
            settings: None,
            id: camera::DeviceOrModelID::from_info(&camera_info),
        })
        .await?
        .await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let camera_lock = Arc::new(camera_feed.ask(camera::Lock).await?);

    let (error_tx, _error_rx) = flume::bounded::<StreamError>(16);
    let mic_lock = if include_mic {
        if let Some((label, _, _)) = MicrophoneFeed::default_device() {
            let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx.clone()));
            mic_feed
                .ask(cap_recording::feeds::microphone::SetInput {
                    label,
                    settings: None,
                })
                .await?
                .await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            Some(Arc::new(
                mic_feed.ask(cap_recording::feeds::microphone::Lock).await?,
            ))
        } else {
            warn!("No microphone device found");
            None
        }
    } else {
        None
    };

    let mut builder =
        instant_recording::Actor::builder(project_path.clone(), ScreenCaptureTarget::CameraOnly)
            .with_max_fps(target_fps)
            .with_camera_feed(camera_lock);

    if let Some(mic) = mic_lock {
        builder = builder.with_mic_feed(mic);
    }

    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            None,
        )
        .await
        .context("Failed to start instant recording")?;

    info!(
        "Instant-mode recording for {}s at {}fps -> {}",
        duration.as_secs(),
        target_fps,
        project_path.display()
    );

    tokio::time::sleep(duration).await;

    handle
        .stop()
        .await
        .context("Failed to stop instant recording")?;

    let output_path = project_path.join("content").join("output.mp4");
    if !output_path.exists() {
        anyhow::bail!(
            "instant recording produced no output.mp4 at {}",
            output_path.display()
        );
    }

    Ok(InstantArtifacts {
        output_path,
        held_temp_dir: Some(temp_dir),
    })
}

pub fn materialize_camera_outputs(project_path: &Path) -> Vec<PathBuf> {
    let mut outputs = Vec::new();
    let segments_dir = project_path.join("content").join("segments");
    if let Ok(entries) = std::fs::read_dir(&segments_dir) {
        let mut dirs: Vec<_> = entries
            .filter_map(|r| r.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            let candidate = dir.join("camera.mp4");
            if candidate.exists() {
                outputs.push(candidate);
            }
        }
    }
    outputs
}
