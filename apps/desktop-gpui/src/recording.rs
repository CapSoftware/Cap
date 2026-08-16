//! Recording, through the same engine the Tauri app drives.
//!
//! The construction here mirrors `apps/desktop/src-tauri/src/recording.rs`
//! (`start_recording`): spawn the feed actors, lock the selected devices,
//! acquire ScreenCaptureKit shareable content, then hand everything to the
//! studio/instant actor builder from `cap-recording`. Everything in this module
//! runs on the tokio runtime (`gpui_tokio`), never on gpui's main thread --
//! kameo actors and the capture pipeline both assume tokio.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, anyhow};
use cap_recording::{
    feeds::{camera, camera::CameraFeed, microphone, microphone::MicrophoneFeed},
    instant_recording,
    sources::screen_capture::ScreenCaptureTarget,
    studio_recording,
};
use kameo::{Actor, actor::ActorRef};

pub use cap_recording::feeds::camera::DeviceOrModelID;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingMode {
    Studio,
    Instant,
}

/// Everything `start` needs, captured from UI state up front so the future is
/// `'static` and owns its inputs. `Clone` because the session keeps the last
/// config around for the bar's restart button.
#[derive(Clone)]
pub struct StartConfig {
    pub mode: RecordingMode,
    pub target: ScreenCaptureTarget,
    /// Microphone by name -- the identity `MicrophoneFeed` keys on.
    pub microphone: Option<String>,
    pub camera: Option<DeviceOrModelID>,
    pub system_audio: bool,
    /// Our own windows (the recording controls bar), excluded from capture the
    /// way the Tauri app excludes its bar.
    pub excluded_windows: Vec<scap_targets::WindowId>,
}

enum Handle {
    // Studio's handle is `Clone`; instant's is not, so it rides in an `Arc`.
    // Both give the owned handles pause/resume need for `'static` futures.
    Studio(studio_recording::ActorHandle),
    Instant(Arc<instant_recording::ActorHandle>),
}

/// A live recording. Stopping consumes it; dropping it without stopping leaves
/// the actors to wind down on their own when the refs go away.
pub struct ActiveRecording {
    handle: Handle,
    pub project_dir: PathBuf,
    // Held for the duration of the recording: dropping an ActorRef early would
    // stop the feed under the pipeline.
    _mic_feed: Option<ActorRef<MicrophoneFeed>>,
    _camera_feed: Option<ActorRef<CameraFeed>>,
    // The mic error channel must outlive the stream or error sends panic the
    // sender side into logs; we keep it and drain nothing.
    _mic_errors: Option<flume::Receiver<cpal::StreamError>>,
}

impl ActiveRecording {
    /// Stop and finalize. Returns the project directory.
    ///
    /// Finalization mirrors the CLI's `finalize_completed`: studio projects get
    /// `RecoveryManager::remux_if_needed` (fragmented segments -> playable
    /// mp4s), instant projects get their DASH segments muxed into
    /// `content/output.mp4` plus a `recording-meta.json`/`project-config.json`
    /// pair so the library and share flows recognize the project.
    /// An owned future pausing the recording; `'static` so the session can
    /// spawn it on tokio without borrowing itself.
    pub fn pause_handle(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> {
        match &self.handle {
            Handle::Studio(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.pause().await })
            }
            Handle::Instant(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.pause().await })
            }
        }
    }

    /// Owned resume future; see [`Self::pause_handle`].
    pub fn resume_handle(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> {
        match &self.handle {
            Handle::Studio(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.resume().await })
            }
            Handle::Instant(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.resume().await })
            }
        }
    }

    /// Cancel without finalizing and delete the project directory -- the
    /// delete and restart flows. Deleting a directory this app just created is
    /// app behavior, same as the Tauri delete button.
    pub async fn cancel_and_delete(self) -> anyhow::Result<()> {
        match &self.handle {
            Handle::Studio(handle) => handle.cancel().await?,
            Handle::Instant(handle) => handle.cancel().await?,
        }
        tokio::task::spawn_blocking({
            let dir = self.project_dir.clone();
            move || std::fs::remove_dir_all(&dir)
        })
        .await
        .context("delete task")?
        .with_context(|| format!("deleting {}", self.project_dir.display()))?;
        Ok(())
    }

    pub async fn stop(self) -> anyhow::Result<PathBuf> {
        match self.handle {
            Handle::Studio(handle) => {
                let completed = handle.stop().await?;
                let project_path = completed.project_path.clone();
                tokio::task::spawn_blocking(move || {
                    cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
                })
                .await
                .context("studio finalize task")?
                .context("studio finalize")?;
                Ok(completed.project_path)
            }
            Handle::Instant(handle) => {
                let completed = handle.stop().await?;
                let project_path = completed.project_path.clone();

                let display_dir = project_path.join("content/display");
                let audio_dir = project_path.join("content/audio");
                let output_path = project_path.join("content/output.mp4");
                tokio::task::spawn_blocking(move || {
                    cap_recording::recovery::RecoveryManager::finalize_instant_output(
                        &display_dir,
                        &audio_dir,
                        &output_path,
                    )
                })
                .await
                .context("instant finalize task")?
                .context("instant finalize")?;

                persist_instant_meta(&completed)?;
                Ok(completed.project_path)
            }
        }
    }
}

/// `persist_instant_recording_meta` from the CLI, verbatim in behavior: without
/// this pair of files the recording plays but no Cap surface lists it.
fn persist_instant_meta(
    completed: &instant_recording::CompletedRecording,
) -> anyhow::Result<()> {
    use cap_project::{
        InstantRecordingMeta, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    };

    let pretty_name = completed
        .project_path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Cap Recording")
        .to_string();
    let meta = match &completed.meta {
        InstantRecordingMeta::InProgress { .. } => InstantRecordingMeta::Failed {
            error: "instant recording stopped before completion".to_string(),
        },
        other => other.clone(),
    };

    RecordingMeta {
        platform: Some(Platform::default()),
        project_path: completed.project_path.clone(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Instant(meta),
        upload: None,
    }
    .save_for_project()
    .map_err(|e| anyhow!("saving instant recording meta: {e}"))?;

    ProjectConfiguration::default()
        .write(&completed.project_path)
        .map_err(|e| anyhow!("saving instant project config: {e}"))?;
    Ok(())
}

pub async fn start(config: StartConfig) -> anyhow::Result<ActiveRecording> {
    match start_attempt(config.clone()).await {
        Ok(active) => Ok(active),
        // The mic actor can die between our health checks and the recording
        // actor's own audio setup (flaky Bluetooth/Continuity devices, or
        // CoreAudio still tearing down a previous session). One retry without
        // the mic keeps the screen recording alive; the real fix is app-scoped
        // feeds with reconnect, which arrive with the camera preview window.
        Err(error) if config.microphone.is_some() && format!("{error:#}").contains("microphone") =>
        {
            tracing::warn!("start failed on the microphone path, retrying without: {error:#}");
            start_attempt(StartConfig {
                microphone: None,
                ..config
            })
            .await
        }
        Err(error) => Err(error),
    }
}

async fn start_attempt(config: StartConfig) -> anyhow::Result<ActiveRecording> {
    let project_dir = create_project_dir(&config.target)?;
    tracing::info!(dir = %project_dir.display(), "starting recording");

    // Feed actors are per-recording here, where the Tauri app keeps app-wide
    // ones (it needs them for previews and level meters between recordings).
    // Once the camera preview window exists this moves to app scope too.
    // A microphone that enumerates but fails to open (Bluetooth profile
    // switch, a Continuity iPhone that wandered off) must not kill the whole
    // recording -- degrade to no-mic, the way the Tauri app's app-scoped feed
    // surfaces "Not connected" and records on.
    let (mic_feed, mic_lock, mic_errors) = match &config.microphone {
        Some(label) => match setup_microphone(label).await {
            Ok((feed, lock, error_rx)) => (Some(feed), Some(lock), Some(error_rx)),
            Err(error) => {
                tracing::warn!("microphone '{label}' unavailable, recording without: {error:#}");
                (None, None, None)
            }
        },
        None => (None, None, None),
    };

    let (camera_feed, camera_lock) = match &config.camera {
        Some(id) => {
            let feed = CameraFeed::spawn(CameraFeed::default());
            let ready = feed
                .ask(camera::SetInput {
                    id: id.clone(),
                    settings: None,
                })
                .await
                .map_err(|e| anyhow!("camera setup: {e}"))?;
            ready.await.map_err(|e| anyhow!("camera init: {e}"))?;
            let lock = feed
                .ask(camera::Lock)
                .await
                .map_err(|e| anyhow!("camera lock: {e}"))?;
            (Some(feed), Some(Arc::new(lock)))
        }
        None => {
            if matches!(config.target, ScreenCaptureTarget::CameraOnly) {
                return Err(anyhow!(
                    "Camera-only recording requires a selected camera."
                ));
            }
            (None, None)
        }
    };

    // ScreenCaptureKit content, exactly as `read_recording_shareable_content`
    // does it: the current-process fallback covers the sandboxed case where the
    // full query returns no displays.
    #[cfg(target_os = "macos")]
    let shareable_content = match config.target {
        ScreenCaptureTarget::CameraOnly => None,
        _ => Some(read_shareable_content().await?),
    };

    let handle = match config.mode {
        RecordingMode::Studio => {
            let mut builder =
                studio_recording::Actor::builder(project_dir.clone(), config.target.clone())
                    .with_system_audio(config.system_audio)
                    .with_excluded_windows(config.excluded_windows.clone());
            if let Some(lock) = camera_lock.clone() {
                builder = builder.with_camera_feed(lock);
            }
            if let Some(lock) = mic_lock.clone() {
                builder = builder.with_mic_feed(lock);
            }
            Handle::Studio(
                builder
                    .build(
                        #[cfg(target_os = "macos")]
                        shareable_content,
                    )
                    .await
                    .context("studio recording actor")?,
            )
        }
        RecordingMode::Instant => {
            let mut builder =
                instant_recording::Actor::builder(project_dir.clone(), config.target.clone())
                    .with_system_audio(config.system_audio)
                    .with_excluded_windows(config.excluded_windows.clone());
            if let Some(lock) = camera_lock.clone() {
                builder = builder.with_camera_feed(lock);
            }
            if let Some(lock) = mic_lock.clone() {
                builder = builder.with_mic_feed(lock);
            }
            Handle::Instant(Arc::new(
                builder
                    .build(
                        #[cfg(target_os = "macos")]
                        shareable_content,
                    )
                    .await
                    .context("instant recording actor")?,
            ))
        }
    };

    Ok(ActiveRecording {
        handle,
        project_dir,
        _mic_feed: mic_feed,
        _camera_feed: camera_feed,
        _mic_errors: mic_errors,
    })
}

async fn setup_microphone(
    label: &str,
) -> anyhow::Result<(
    ActorRef<MicrophoneFeed>,
    Arc<cap_recording::feeds::microphone::MicrophoneFeedLock>,
    flume::Receiver<cpal::StreamError>,
)> {
    let (error_tx, error_rx) = flume::unbounded();
    let feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
    let ready = feed
        .ask(microphone::SetInput {
            label: label.to_string(),
            settings: None,
        })
        .await
        .map_err(|e| anyhow!("setup: {e}"))?;
    ready.await.map_err(|e| anyhow!("init: {e}"))?;
    let lock = feed
        .ask(microphone::Lock)
        .await
        .map_err(|e| anyhow!("lock: {e}"))?;
    Ok((feed, Arc::new(lock), error_rx))
}

#[cfg(target_os = "macos")]
async fn read_shareable_content() -> anyhow::Result<cap_recording::SendableShareableContent> {
    let content = cidre::sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!("ReadShareableContent: {e}"))?;
    if !content.displays().is_empty() {
        return Ok(content.into());
    }
    let process_content = cidre::sc::ShareableContent::current_process()
        .await
        .map_err(|e| anyhow!("ReadCurrentProcessShareableContent: {e}"))?;
    if !process_content.displays().is_empty() {
        return Ok(process_content.into());
    }
    Ok(content.into())
}

/// The recordings library root, resolved the way `GeneralSettingsStore::
/// recordings_dir` resolves it so both apps share one library: the custom
/// `recordingsPath` from the Tauri store if it is absolute and creatable,
/// otherwise `<app data>/recordings`. `CAP_GPUI_RECORDINGS_DIR` overrides both
/// (used by the automated end-to-end check so test recordings stay out of the
/// user's library).
pub fn recordings_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CAP_GPUI_RECORDINGS_DIR")
        && !dir.trim().is_empty()
    {
        return PathBuf::from(dir);
    }

    let app_data = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join("Library/Application Support/so.cap.desktop");

    let custom = std::fs::read(app_data.join("store"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|store| {
            store
                .get("general_settings")?
                .get("recordingsPath")?
                .as_str()
                .map(PathBuf::from)
        })
        .filter(|path| path.is_absolute());

    if let Some(path) = custom
        && std::fs::create_dir_all(&path).is_ok()
    {
        return path;
    }

    app_data.join("recordings")
}

/// `format_project_name` with the default template
/// (`{target_name} ({target_kind}) {date} {time}`), then the same `:` -> `.`
/// replacement and uniquing the Tauri app applies.
fn create_project_dir(target: &ScreenCaptureTarget) -> anyhow::Result<PathBuf> {
    let base = recordings_dir();
    std::fs::create_dir_all(&base)
        .with_context(|| format!("creating recordings dir {}", base.display()))?;

    let target_name = target.title().unwrap_or_else(|| "Unknown".into());
    let now = chrono::Local::now();
    let name = format!(
        "{} ({}) {} {}",
        target_name,
        target.kind_str(),
        now.format("%Y-%m-%d"),
        now.format("%I.%M %p"),
    );
    // Same normalization chain as the Tauri app: colons break Finder, slashes
    // break paths.
    let filename = format!("{}.cap", name.replace([':', '/'], "."));
    let filename = cap_utils::ensure_unique_filename(&filename, &base)
        .map_err(|e| anyhow!("unique filename: {e}"))?;

    Ok(base.join(filename))
}
