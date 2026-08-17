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
    /// Our own windows (the recording controls bar; the camera bubble in studio
    /// mode), excluded from capture the way the Tauri app excludes them.
    pub excluded_windows: Vec<scap_targets::WindowId>,
    /// The app-scoped feed actors (running previews/meters). When present a
    /// recording locks these instead of spawning its own -- the Tauri model.
    pub camera_feed: Option<ActorRef<CameraFeed>>,
    pub mic_feed: Option<ActorRef<MicrophoneFeed>>,
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
    /// Recording-scoped mic mute (payload zeroing at the consumer seam; the
    /// stream cadence is unaffected). `None` when the recording has no mic.
    pub mic_mute: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    // Held for the duration of the recording: dropping an ActorRef early would
    // stop the feed under the pipeline. Only populated by the per-recording
    // fallback path; app-scoped feeds are owned by `Feeds`.
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

                // Everything `handle_recording_finish` does after the remux,
                // in its order: the first-frame JPEG the library's card is
                // drawn from, then the camera preview's blur toggle copied
                // into the project's configuration. Neither is fatal to a
                // recording that is already on disk, so both only warn.
                let project_path = completed.project_path.clone();
                tokio::task::spawn_blocking(move || {
                    if let Some(display_path) = studio_display_path(&project_path) {
                        write_bundle_thumbnail(&project_path, &display_path);
                    }
                    apply_camera_blur_to_project_config(&project_path, current_camera_blur());
                })
                .await
                .context("studio post-finalize task")?;

                Ok(completed.project_path)
            }
            Handle::Instant(handle) => {
                let completed = handle.stop().await?;
                let project_path = completed.project_path.clone();

                let display_dir = project_path.join("content/display");
                let audio_dir = project_path.join("content/audio");
                let output_path = project_path.join("content/output.mp4");
                let muxed = output_path.clone();
                tokio::task::spawn_blocking(move || {
                    cap_recording::recovery::RecoveryManager::finalize_instant_output(
                        &display_dir,
                        &audio_dir,
                        &muxed,
                    )
                })
                .await
                .context("instant finalize task")?
                .context("instant finalize")?;

                persist_instant_meta(&completed)?;

                // The Tauri app builds the instant thumbnail by concatenating
                // `content/display`'s init segment with the first media
                // segment (`create_screenshot_source_from_segments`); by this
                // point `finalize_instant_output` has already muxed the whole
                // thing into `content/output.mp4`, which is the same first
                // frame without the temporary file. The blur bridge is *not*
                // applied here: `project_config_from_recording` is the studio
                // arm of `handle_recording_finish` only.
                let project_path = completed.project_path.clone();
                tokio::task::spawn_blocking(move || {
                    write_bundle_thumbnail(&project_path, &output_path);
                })
                .await
                .context("instant thumbnail task")?;

                Ok(completed.project_path)
            }
        }
    }
}

/// The first segment's display track, which is what
/// `handle_recording_finish` hands `create_screenshot`
/// (`apps/desktop/src-tauri/src/recording.rs:3415-3429`).
///
/// Read back off disk rather than from the handle's `CompletedRecording`,
/// because the remux is what decides where that track lives: until
/// `remux_if_needed` runs, the meta points at the fragmented
/// `.../segment-0/display` *directory*, and afterwards at the muxed
/// `display.mp4` beside it. The Tauri app has the same ordering, and uses its
/// `updated_studio_meta` for the same reason.
fn studio_display_path(project_path: &std::path::Path) -> Option<PathBuf> {
    use cap_project::{RecordingMeta, StudioRecordingMeta};

    let meta = RecordingMeta::load_for_project(project_path).ok()?;
    let path = match meta.studio_meta()? {
        StudioRecordingMeta::SingleSegment { segment } => segment.display.path.to_path(project_path),
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .first()
            .map(|segment| segment.display.path.to_path(project_path))?,
    };
    path.is_file().then_some(path)
}

/// Write `<bundle>/screenshots/display.jpg` -- the file both apps' Recents
/// cards draw. `cap-recording` does not produce it, so without this a project
/// recorded here would show the icon fallback forever, including in the
/// shipping app.
fn write_bundle_thumbnail(project_dir: &std::path::Path, source_video: &std::path::Path) {
    let output = crate::library::bundle_thumbnail_path(project_dir);
    match crate::library::create_screenshot(source_video, &output, None) {
        Ok(()) => tracing::info!(path = %output.display(), "wrote recording thumbnail"),
        Err(error) => tracing::warn!(
            source = %source_video.display(),
            "could not write the recording thumbnail: {error}"
        ),
    }
}

/// The camera preview bubble's current blur mode.
///
/// `handle_recording_finish` reads the *live* preview state
/// (`camera_preview_manager.get_state()`), not a value captured at start, so a
/// toggle made mid-recording is the one that lands in the project. The bubble
/// here persists every cycle to `gpui-state.json`, so reading it back is the
/// same "whatever the toggle says now" semantics.
fn current_camera_blur() -> crate::store::BlurMode {
    crate::store::load()
        .camera_window
        .map(|state| state.background_blur)
        .unwrap_or_default()
}

/// `BackgroundBlurMode`'s JSON spelling
/// (`crates/project/src/configuration.rs:423-430`, `rename_all = "camelCase"`
/// over `Off | Light | Heavy`).
fn blur_mode_json(blur: crate::store::BlurMode) -> &'static str {
    match blur {
        crate::store::BlurMode::Off => "off",
        crate::store::BlurMode::Light => "light",
        crate::store::BlurMode::Heavy => "heavy",
    }
}

/// Copy the camera preview's blur toggle into the finished project's
/// configuration -- the bridge at
/// `apps/desktop/src-tauri/src/recording.rs:3889-3891`:
///
/// ```text
/// config.camera.background_blur = cap_project::BackgroundBlurConfig {
///     mode: camera_preview_state.background_blur,
/// };
/// ```
///
/// Blur is never baked into the recorded camera track by either app; the
/// editor re-runs the same segmentation pipeline over the raw file, driven by
/// this field. Copying it is what makes a project recorded with the bubble
/// blurred *open* blurred.
///
/// `cap-recording` writes `project-config.json` itself at the end of a studio
/// recording (`studio_recording.rs:1189-1207`) and its builder takes no config,
/// so the value is merged in afterwards -- a read-modify-write on the raw JSON
/// that replaces exactly `camera.backgroundBlur.mode` and leaves every other
/// key of a file this app models none of (`timeline`, `clips`, `background`,
/// the four `*Version` counters) untouched. This is `store::set_store_setting`'s
/// discipline applied to the other shared file, including its refusal: a config
/// that does not parse, or whose `camera` is not an object, is left alone
/// rather than replaced.
pub fn apply_camera_blur_to_project_config(
    project_dir: &std::path::Path,
    blur: crate::store::BlurMode,
) -> bool {
    use serde_json::{Map, Value};

    let path = project_dir.join("project-config.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(path = %path.display(), "no project config to bridge blur into: {error}");
            return false;
        }
    };
    let Ok(Value::Object(mut config)) = serde_json::from_slice::<Value>(&bytes) else {
        tracing::error!(
            path = %path.display(),
            "the project config did not parse as an object; refusing to write to it"
        );
        return false;
    };

    let camera = config
        .entry("camera")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(camera) = camera.as_object_mut() else {
        tracing::error!(path = %path.display(), "project config `camera` is not an object");
        return false;
    };
    let background_blur = camera
        .entry("backgroundBlur")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(background_blur) = background_blur.as_object_mut() else {
        tracing::error!(
            path = %path.display(),
            "project config `camera.backgroundBlur` is not an object"
        );
        return false;
    };
    background_blur.insert(
        "mode".to_string(),
        Value::String(blur_mode_json(blur).to_string()),
    );

    // Same shape `ProjectConfiguration::write` produces (serde_json pretty),
    // via a temp file so a crash mid-write cannot leave a project whose config
    // neither app can parse.
    let Ok(serialized) = serde_json::to_vec_pretty(&Value::Object(config)) else {
        return false;
    };
    let temp = path.with_extension("gpui-tmp");
    if let Err(error) = std::fs::write(&temp, serialized) {
        tracing::warn!("writing the project config: {error}");
        return false;
    }
    if let Err(error) = std::fs::rename(&temp, &path) {
        tracing::warn!("replacing the project config: {error}");
        let _ = std::fs::remove_file(&temp);
        return false;
    }
    tracing::info!(mode = blur_mode_json(blur), "bridged camera blur into the project config");
    true
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
                mic_feed: None,
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

    // The app-scoped feeds (running previews/meters, owned by `Feeds`) are
    // locked in place when available -- the Tauri model. The per-recording
    // spawn below is the fallback for a feed that died between selection and
    // start.
    // A microphone that enumerates but fails to open (Bluetooth profile
    // switch, a Continuity iPhone that wandered off) must not kill the whole
    // recording -- degrade to no-mic, the way the Tauri app's app-scoped feed
    // surfaces "Not connected" and records on.
    let (mic_feed, mic_lock, mic_errors) = match (&config.mic_feed, &config.microphone) {
        (Some(actor), Some(label)) => match actor.ask(microphone::Lock).await {
            Ok(lock) => (None, Some(Arc::new(lock)), None),
            Err(error) => {
                tracing::warn!("app mic feed lock failed ({error}), spawning one for '{label}'");
                match setup_microphone(label).await {
                    Ok((feed, lock, error_rx)) => (Some(feed), Some(lock), Some(error_rx)),
                    Err(error) => {
                        tracing::warn!(
                            "microphone '{label}' unavailable, recording without: {error:#}"
                        );
                        (None, None, None)
                    }
                }
            }
        },
        (None, Some(label)) => match setup_microphone(label).await {
            Ok((feed, lock, error_rx)) => (Some(feed), Some(lock), Some(error_rx)),
            Err(error) => {
                tracing::warn!("microphone '{label}' unavailable, recording without: {error:#}");
                (None, None, None)
            }
        },
        _ => (None, None, None),
    };

    let (camera_feed, camera_lock) = match &config.camera {
        Some(id) => {
            if let Some(actor) = &config.camera_feed {
                match actor.ask(camera::Lock).await {
                    Ok(lock) => (None, Some(Arc::new(lock))),
                    Err(error) => {
                        tracing::warn!("app camera feed lock failed ({error}), spawning one");
                        let (feed, lock) = setup_camera(id).await?;
                        (Some(feed), Some(Arc::new(lock)))
                    }
                }
            } else {
                let (feed, lock) = setup_camera(id).await?;
                (Some(feed), Some(Arc::new(lock)))
            }
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

    let mic_mute = mic_lock
        .as_ref()
        .map(|lock| lock.recording_muted_handle());

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
        mic_mute,
        _mic_feed: mic_feed,
        _camera_feed: camera_feed,
        _mic_errors: mic_errors,
    })
}

async fn setup_camera(
    id: &DeviceOrModelID,
) -> anyhow::Result<(
    ActorRef<CameraFeed>,
    cap_recording::feeds::camera::CameraFeedLock,
)> {
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
    Ok((feed, lock))
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

    let custom = crate::store::GeneralSettings::load()
        .recordings_path
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());

    if let Some(path) = custom
        && std::fs::create_dir_all(&path).is_ok()
    {
        return path;
    }

    crate::store::app_data_dir().join("recordings")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::BlurMode;
    use serde_json::Value;

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-gpui-config-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The bridge writes exactly `camera.backgroundBlur.mode` and nothing else
    /// -- the whole reason it is a raw-JSON merge and not a typed round trip.
    /// `ProjectConfiguration` here models a dozen sections this app has no
    /// types for, and serializing our idea of the file back over it would drop
    /// the user's timeline.
    #[test]
    fn bridging_blur_preserves_every_other_key() {
        let dir = temp_project("preserve");
        let original = serde_json::json!({
            "aspectRatio": null,
            "background": { "source": { "type": "wallpaper", "path": "sequoia/1" } },
            "camera": {
                "hide": false,
                "size": 30.0,
                "shape": "square",
                "backgroundBlur": { "mode": "off" }
            },
            "timeline": { "segments": [{ "recordingClip": 0, "start": 0.0, "end": 3.0 }] },
            "aFieldFromANewerBuild": 42
        });
        std::fs::write(
            dir.join("project-config.json"),
            serde_json::to_vec_pretty(&original).unwrap(),
        )
        .unwrap();

        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Light));

        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "light");
        assert_eq!(written["camera"]["size"], 30.0);
        assert_eq!(written["camera"]["shape"], "square");
        assert_eq!(written["background"], original["background"]);
        assert_eq!(written["timeline"], original["timeline"]);
        assert_eq!(written["aFieldFromANewerBuild"], 42);
        assert_eq!(
            written.as_object().unwrap().len(),
            original.as_object().unwrap().len(),
            "no keys added or dropped"
        );

        // Heavy overwrites Light in place, and Off is written just as
        // explicitly -- `project_config_from_recording` always assigns the
        // field, it does not skip the default.
        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Heavy));
        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "heavy");

        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Off));
        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "off");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A config written by a build that predates `backgroundBlur` (or one that
    /// never had a camera section at all) gets the key created rather than
    /// being skipped.
    #[test]
    fn bridging_blur_creates_the_missing_section() {
        let dir = temp_project("create");
        std::fs::write(dir.join("project-config.json"), br#"{"aspectRatio":null}"#).unwrap();

        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Heavy));

        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "heavy");
        assert!(written.get("aspectRatio").is_some());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The store rule, on the other shared file: a config that does not parse
    /// is never replaced. Overwriting it would delete the user's edit.
    #[test]
    fn a_corrupt_project_config_is_never_overwritten() {
        let dir = temp_project("corrupt");
        let path = dir.join("project-config.json");
        std::fs::write(&path, b"{ this is not json").unwrap();

        assert!(!apply_camera_blur_to_project_config(&dir, BlurMode::Light));
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");

        // And a project with no config at all is a no-op, not a fresh file:
        // the config is cap-recording's to write.
        let empty = temp_project("empty");
        assert!(!apply_camera_blur_to_project_config(&empty, BlurMode::Light));
        assert!(!empty.join("project-config.json").exists());

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    /// The spelling has to match `BackgroundBlurMode`'s serde exactly or the
    /// editor's `#[serde(default)]` would quietly swallow the value.
    #[test]
    fn blur_modes_use_the_project_crates_spelling() {
        for (mode, json) in [
            (BlurMode::Off, "off"),
            (BlurMode::Light, "light"),
            (BlurMode::Heavy, "heavy"),
        ] {
            assert_eq!(blur_mode_json(mode), json);
            let parsed: cap_project::BackgroundBlurMode =
                serde_json::from_value(Value::String(json.to_string()))
                    .expect("the project crate parses what we write");
            assert_eq!(
                serde_json::to_value(parsed).unwrap(),
                Value::String(json.to_string())
            );
        }
    }
}
