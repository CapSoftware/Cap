//! Recording, through the same engine the Tauri app drives.
//!
//! The construction here mirrors `apps/desktop/src-tauri/src/recording.rs`
//! (`start_recording`): spawn the feed actors, lock the selected devices,
//! acquire ScreenCaptureKit shareable content, then hand everything to the
//! studio/instant actor builder from `cap-recording`. Everything in this module
//! runs on the tokio runtime (`gpui_tokio`), never on gpui's main thread --
//! kameo actors and the capture pipeline both assume tokio.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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
    instant_upload: Option<crate::upload::InstantUpload>,
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
    pub fn instant_share_url(&self) -> Option<&str> {
        self.instant_upload
            .as_ref()
            .map(|upload| upload.video().link.as_str())
    }

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
        let remote_result = if let Some(upload) = self.instant_upload {
            upload.cancel().await
        } else {
            Ok(())
        };
        tokio::task::spawn_blocking({
            let dir = self.project_dir.clone();
            move || std::fs::remove_dir_all(&dir)
        })
        .await
        .context("delete task")?
        .with_context(|| format!("deleting {}", self.project_dir.display()))?;
        remote_result.map_err(anyhow::Error::msg)?;
        Ok(())
    }

    pub async fn stop(self, preserve_local: bool) -> anyhow::Result<PathBuf> {
        let mut instant_upload = self.instant_upload;
        match self.handle {
            Handle::Studio(handle) => {
                let completed = handle.stop().await?;
                let project_path = completed.project_path.clone();
                let needs_remux = matches!(
                    completed.meta.status(),
                    cap_project::StudioRecordingStatus::NeedsRemux
                );
                tokio::task::spawn_blocking(move || {
                    if needs_remux {
                        ensure_finalization_storage(&project_path)?;
                    }
                    cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
                        .map_err(anyhow::Error::from)
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
                let result = async {
                    let stopped = handle.stop().await;
                    let metadata_result = match instant_upload.as_ref() {
                        Some(upload) => {
                            mark_instant_recording_stopped(&self.project_dir, upload.metadata_lock())
                        }
                        None => Err(anyhow!("instant recording has no upload session")),
                    };
                    if let Err(error) = &metadata_result {
                        tracing::warn!(%error, "Could not mark the instant recording as stopped");
                    }
                    let completed = stopped?;
                    metadata_result?;
                    let project_path = completed.project_path.clone();
                    let upload = instant_upload
                        .as_mut()
                        .ok_or_else(|| anyhow!("instant recording has no upload session"))?;
                    let segmented = upload.is_segmented();

                    let display_dir = project_path.join("content/display");
                    let audio_dir = project_path.join("content/audio");
                    let output_path = project_path.join("content/output.mp4");
                    if display_dir.is_dir() {
                        let muxed = output_path.clone();
                        let project_path = project_path.clone();
                        tokio::task::spawn_blocking(move || {
                            ensure_finalization_storage(&project_path)?;
                            cap_recording::recovery::RecoveryManager::finalize_instant_output(
                                &display_dir,
                                &audio_dir,
                                &muxed,
                            )
                            .map_err(anyhow::Error::from)
                        })
                        .await
                        .context("instant finalize task")?
                        .context("instant finalize")?;
                    } else if !output_path.is_file() {
                        return Err(anyhow!("instant recording has no finalized output"));
                    }

                    persist_instant_meta(&completed, upload.video(), upload.metadata_lock())?;

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

                    if let Err(error) = upload.finish_segments().await {
                        persist_instant_upload_failure(
                            &completed.project_path,
                            &error,
                            upload.metadata_lock(),
                        )?;
                        return Err(anyhow!(error));
                    }

                    let upload_result = if segmented {
                        upload.finish_screenshot(&completed.project_path).await
                    } else {
                        crate::upload::upload_exported_video(
                            completed.project_path.clone(),
                            None,
                            |_| {},
                            Arc::new(std::sync::atomic::AtomicBool::new(false)),
                        )
                        .await
                        .and_then(|result| match result {
                            crate::upload::UploadResult::Success(_) => Ok(()),
                            crate::upload::UploadResult::NotAuthenticated => Err(
                                "Your session has expired. Please sign in again to upload this recording."
                                    .to_string(),
                            ),
                            crate::upload::UploadResult::UpgradeRequired => {
                                Err("Instant recording requires an upgraded plan.".to_string())
                            }
                        })
                    };
                    if let Err(error) = upload_result {
                        persist_instant_upload_failure(
                            &completed.project_path,
                            &error,
                            upload.metadata_lock(),
                        )?;
                        return Err(anyhow!(error));
                    }

                    persist_instant_upload_complete(&completed.project_path, upload.metadata_lock())?;

                    if !preserve_local
                        && crate::store::GeneralSettings::load().delete_instant_recordings_after_upload
                    {
                        let directory = completed.project_path.clone();
                        tokio::task::spawn_blocking(move || std::fs::remove_dir_all(directory))
                            .await
                            .context("instant upload cleanup task")?
                            .context("deleting uploaded instant recording")?;
                    }

                    Ok(completed.project_path)
                }
                .await;
                if result.is_err()
                    && let Some(upload) = instant_upload.as_mut()
                {
                    upload.abort_segments().await;
                }
                result
            }
        }
    }
}

fn with_instant_metadata_lock<T>(
    metadata_lock: &Mutex<()>,
    update: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let _guard = metadata_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    update()
}

fn save_instant_metadata(meta: &cap_project::RecordingMeta) -> anyhow::Result<()> {
    let contents = serde_json::to_vec_pretty(meta)?;
    write_instant_metadata(&meta.project_path, |file| file.write_all(&contents))
}

fn write_instant_metadata(
    project_path: &std::path::Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    let temporary = project_path.join(format!(
        ".recording-meta-{}.tmp",
        crate::store::new_uuid_v4()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, project_path.join("recording-meta.json"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.context("saving instant recording metadata")
}

fn mark_instant_recording_stopped(
    project_path: &std::path::Path,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        let mut meta = cap_project::RecordingMeta::load_for_project(project_path)
            .map_err(|error| anyhow!("loading recording metadata: {error}"))?;
        meta.inner = cap_project::RecordingMetaInner::Instant(
            cap_project::InstantRecordingMeta::InProgress { recording: false },
        );
        save_instant_metadata(&meta)?;
        Ok(())
    })
}

pub fn available_recording_storage() -> std::io::Result<cap_utils::disk_space::RecordingStorage> {
    Ok(cap_utils::disk_space::RecordingStorage {
        available_bytes: cap_utils::disk_space::free_bytes_for_path(&recordings_dir())?,
        recording_bytes: 0,
    })
}

pub(crate) fn ensure_finalization_storage(project_path: &std::path::Path) -> anyhow::Result<()> {
    let storage = cap_utils::disk_space::recording_storage(project_path)
        .context("checking storage before saving the recording")?;
    if !storage.can_finalize() {
        return Err(anyhow!(
            "Low storage. Your recording files are preserved at {}. Free up space, then recover the recording in Cap.",
            project_path.display()
        ));
    }
    Ok(())
}

pub fn recover_instant_recording(project_path: &std::path::Path) -> anyhow::Result<PathBuf> {
    use cap_project::{InstantRecordingMeta, RecordingMeta, RecordingMetaInner};

    let mut meta = RecordingMeta::load_for_project(project_path)
        .map_err(|error| anyhow!("loading recording metadata: {error}"))?;
    if !matches!(
        meta.inner,
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. })
    ) {
        return Err(anyhow!(
            "This instant recording is not waiting to be saved."
        ));
    }
    ensure_finalization_storage(project_path)?;
    let output = project_path.join("content/output.mp4");
    cap_recording::recovery::RecoveryManager::finalize_instant_output(
        &project_path.join("content/display"),
        &project_path.join("content/audio"),
        &output,
    )?;
    let input = ffmpeg::format::input(&output)?;
    let video = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| anyhow!("The recovered recording has no video track."))?;
    let fps = f64::from(video.avg_frame_rate());
    if !fps.is_finite() || fps <= 0.0 {
        return Err(anyhow!(
            "The recovered recording has an invalid frame rate."
        ));
    }
    let sample_rate = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .map(|audio| {
            ffmpeg::codec::context::Context::from_parameters(audio.parameters())
                .and_then(|context| context.decoder().audio())
                .map(|decoder| decoder.rate())
        })
        .transpose()?;
    meta.inner = RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
        fps: fps.round() as u32,
        sample_rate,
    });
    save_instant_metadata(&meta)?;
    write_bundle_thumbnail(project_path, &output);
    Ok(project_path.to_path_buf())
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
        StudioRecordingMeta::SingleSegment { segment } => {
            segment.display.path.to_path(project_path)
        }
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
    tracing::info!(
        mode = blur_mode_json(blur),
        "bridged camera blur into the project config"
    );
    true
}

/// `persist_instant_recording_meta` from the CLI, verbatim in behavior: without
/// this pair of files the recording plays but no Cap surface lists it.
fn persist_instant_meta(
    completed: &instant_recording::CompletedRecording,
    upload: &cap_project::VideoUploadInfo,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
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

        let previous_upload = RecordingMeta::load_for_project(&completed.project_path)
            .ok()
            .and_then(|meta| meta.upload);

        let meta = RecordingMeta {
            platform: Some(Platform::default()),
            project_path: completed.project_path.clone(),
            pretty_name,
            sharing: Some(cap_project::SharingMeta {
                id: upload.id.clone(),
                link: upload.link.clone(),
                content_hash: None,
            }),
            inner: RecordingMetaInner::Instant(meta),
            upload: previous_upload,
        };
        save_instant_metadata(&meta)?;

        ProjectConfiguration::default()
            .write(&completed.project_path)
            .map_err(|e| anyhow!("saving instant project config: {e}"))?;
        Ok(())
    })
}

pub(crate) fn persist_instant_upload_failure(
    project_path: &std::path::Path,
    error: &str,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        let mut meta =
            cap_project::RecordingMeta::load_for_project(project_path).map_err(|load_error| {
                anyhow!("loading failed instant recording metadata: {load_error}")
            })?;
        meta.upload = Some(cap_project::UploadMeta::Failed {
            error: error.to_string(),
        });
        save_instant_metadata(&meta)?;
        Ok(())
    })
}

fn persist_instant_upload_complete(
    project_path: &std::path::Path,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        let mut meta = cap_project::RecordingMeta::load_for_project(project_path)
            .map_err(|error| anyhow!("loading instant recording metadata: {error}"))?;
        meta.upload = Some(cap_project::UploadMeta::Complete);
        save_instant_metadata(&meta)?;
        Ok(())
    })
}

fn persist_in_progress_instant_meta(
    project_path: &std::path::Path,
    video: &cap_project::VideoUploadInfo,
    segmented: bool,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        let upload = if segmented {
            cap_project::UploadMeta::SegmentUpload {
                video_id: video.id.clone(),
                pre_created_video: video.clone(),
                recording_dir: project_path.to_path_buf(),
            }
        } else {
            cap_project::UploadMeta::MultipartUpload {
                video_id: video.id.clone(),
                file_path: project_path.join("content/output.mp4"),
                pre_created_video: video.clone(),
                recording_dir: project_path.to_path_buf(),
            }
        };
        let pretty_name = project_path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Cap Recording")
            .to_string();

        let meta = cap_project::RecordingMeta {
            platform: Some(cap_project::Platform::default()),
            project_path: project_path.to_path_buf(),
            pretty_name,
            sharing: None,
            inner: cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::InProgress { recording: true },
            ),
            upload: Some(upload),
        };
        save_instant_metadata(&meta)?;
        Ok(())
    })
}

pub async fn start(config: StartConfig) -> anyhow::Result<ActiveRecording> {
    match start_attempt(config.clone()).await {
        Ok(active) => Ok(active),
        // The mic actor can die between our health checks and the recording
        // actor's own audio setup (flaky Bluetooth/Continuity devices, or
        // CoreAudio still tearing down a previous session). One retry without
        // the mic keeps the screen recording alive; the real fix is app-scoped
        // feeds with reconnect, which arrive with the camera preview window.
        Err(error)
            if config.microphone.is_some() && format!("{error:#}").contains("microphone") =>
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
    if matches!(config.target, ScreenCaptureTarget::CameraOnly) && config.camera.is_none() {
        return Err(anyhow!("Camera-only recording requires a selected camera."));
    }
    if config.mode == RecordingMode::Instant && !crate::store::auth_snapshot().signed_in() {
        return Err(anyhow!("Please sign in to use instant recording"));
    }

    let project_dir = create_project_dir(&config.target, config.mode)?;
    let project_name = project_dir
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Cap Recording")
        .to_string();
    let organization_id = crate::store::store_section(crate::store::RECORDING_SETTINGS)
        .get("organizationId")
        .and_then(serde_json::Value::as_str)
        .filter(|organization| !organization.is_empty())
        .map(str::to_string);

    let pre_created_video = if config.mode == RecordingMode::Instant {
        Some(
            crate::upload::prepare_instant_upload(
                matches!(config.target, ScreenCaptureTarget::CameraOnly),
                project_name,
                organization_id,
            )
            .await
            .map_err(anyhow::Error::msg)?,
        )
    } else {
        None
    };

    let result = start_attempt_with_upload(config, project_dir, pre_created_video.clone()).await;
    if result.is_err()
        && let Some(video) = pre_created_video
        && let Err(error) = crate::upload::delete_instant_video(&video.id).await
    {
        tracing::error!(video_id = %video.id, "Failed to clean up instant recording: {error}");
        return Err(anyhow!("Failed to clean up instant recording: {error}"));
    }
    result
}

async fn start_attempt_with_upload(
    config: StartConfig,
    project_dir: PathBuf,
    pre_created_video: Option<cap_project::VideoUploadInfo>,
) -> anyhow::Result<ActiveRecording> {
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
                return Err(anyhow!("Camera-only recording requires a selected camera."));
            }
            (None, None)
        }
    };

    let mic_mute = mic_lock.as_ref().map(|lock| lock.recording_muted_handle());

    // ScreenCaptureKit content, exactly as `read_recording_shareable_content`
    // does it: the current-process fallback covers the sandboxed case where the
    // full query returns no displays.
    #[cfg(target_os = "macos")]
    let shareable_content = match config.target {
        ScreenCaptureTarget::CameraOnly => None,
        _ => Some(read_shareable_content().await?),
    };

    // `desktop_recording_defaults` (`src-tauri/src/recording.rs:1102-1116`):
    // the user's persisted settings, applied through the same shared
    // `RecordingDefaults` seam so both apps build recordings identically.
    let settings = crate::store::GeneralSettings::load();
    let defaults = cap_recording::RecordingDefaults {
        custom_cursor_capture: settings.custom_cursor_capture,
        capture_keyboard_events: settings.capture_keyboard_events,
        crash_recovery_recording: settings.crash_recovery_recording,
        max_fps: settings.max_fps,
        studio_recording_quality: settings.studio_recording_quality.into(),
        out_of_process_muxer: settings.out_of_process_muxer,
        instant_mode_max_resolution: cap_recording::DEFAULT_INSTANT_MODE_MAX_RESOLUTION,
    };
    // The instant output cap is plan-gated at start time, not at settings
    // time (`recording.rs:1634-1639`): free stays at the free cap even if a
    // stale store value says otherwise.
    let instant_max_resolution = if crate::store::auth_snapshot().is_upgraded() {
        settings.instant_mode_max_resolution
    } else {
        cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
    };

    #[cfg(target_os = "macos")]
    let excluded_windows = {
        let mut excluded = config.excluded_windows.clone();
        let mut rules = settings.excluded_windows.clone();
        if config.mode == RecordingMode::Instant {
            // `filter_for_instant_mode`: instant has no compositing step,
            // so the camera bubble stays in the picture there.
            rules.retain(|rule| rule.window_title.as_deref() != Some("Cap Camera"));
        }
        for id in resolve_excluded_window_ids(&rules) {
            if !excluded.contains(&id) {
                excluded.push(id);
            }
        }
        excluded
    };
    let mut instant_upload = None;
    let handle = match config.mode {
        RecordingMode::Studio => {
            let mut builder = defaults.apply_to_studio_builder(
                studio_recording::Actor::builder(project_dir.clone(), config.target.clone())
                    .with_system_audio(config.system_audio),
                camera_lock.is_some(),
                None,
            );
            #[cfg(target_os = "macos")]
            {
                builder = builder.with_excluded_windows(excluded_windows.clone());
            }
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
                    .with_max_output_size(instant_max_resolution);
            #[cfg(target_os = "macos")]
            {
                builder = builder.with_excluded_windows(excluded_windows.clone());
            }
            if let Some(lock) = camera_lock.clone() {
                builder = builder.with_camera_feed(lock);
            }
            if let Some(lock) = mic_lock.clone() {
                builder = builder.with_mic_feed(lock);
            }
            let handle = Arc::new(
                builder
                    .build(
                        #[cfg(target_os = "macos")]
                        shareable_content,
                    )
                    .await
                    .context("instant recording actor")?,
            );
            let video = pre_created_video
                .ok_or_else(|| anyhow!("instant recording has no reserved upload"))?;
            let segment_rx = handle.take_segment_rx();
            let metadata_lock = Arc::new(Mutex::new(()));
            persist_in_progress_instant_meta(
                &project_dir,
                &video,
                segment_rx.is_some(),
                &metadata_lock,
            )?;
            instant_upload = Some(
                crate::upload::start_instant_upload(
                    video,
                    project_dir.clone(),
                    segment_rx,
                    metadata_lock,
                )
                .map_err(anyhow::Error::msg)?,
            );
            Handle::Instant(handle)
        }
    };

    Ok(ActiveRecording {
        handle,
        project_dir,
        instant_upload,
        mic_mute,
        _mic_feed: mic_feed,
        _camera_feed: camera_feed,
        _mic_errors: mic_errors,
    })
}

/// `window_exclusion::resolve_window_ids`: every on-screen window matching a
/// configured exclusion rule, by id. Our own windows are excluded by window
/// number in `begin_recording` before this runs; this resolves the
/// user-configured (or default) rules -- other apps, other Cap installs.
#[cfg(target_os = "macos")]
fn resolve_excluded_window_ids(
    exclusions: &[crate::store::WindowExclusion],
) -> Vec<scap_targets::WindowId> {
    if exclusions.is_empty() {
        return Vec::new();
    }

    scap_targets::Window::list()
        .into_iter()
        .filter_map(|window| {
            let owner_name = window.owner_name();
            let window_title = window.name();
            let bundle_identifier = window.raw_handle().bundle_identifier();
            let matches = exclusions.iter().any(|entry| {
                entry.matches(
                    bundle_identifier.as_deref(),
                    owner_name.as_deref(),
                    window_title.as_deref(),
                )
            });
            if !matches {
                return None;
            }
            let window_id = window.id();
            tracing::info!(
                %window_id,
                ?owner_name,
                ?window_title,
                ?bundle_identifier,
                "excluding window from capture"
            );
            Some(window_id)
        })
        .collect()
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

/// `delete_recording_directory` (`src-tauri/src/lib.rs:4006-4051`), for the
/// clip the editor-append flow just copied out of: reject `..` components,
/// require the path to live inside the recordings library (canonically, so a
/// symlink cannot escape it), then `remove_dir_all`. The Tauri command accepts
/// every known storage folder; this app resolves exactly one
/// ([`recordings_dir`]), so that one is the whole allow-list.
pub fn delete_recording_directory(path: &std::path::Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid path".to_string());
    }

    let recordings = recordings_dir();
    if !path.starts_with(&recordings) {
        return Err("Path is not inside the recordings directory".to_string());
    }

    if path.exists() {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Failed to resolve recording path: {e}"))?;
        let inside = recordings
            .canonicalize()
            .map(|dir| canonical.starts_with(&dir))
            .unwrap_or(false);
        if !inside {
            return Err("Path is not inside the recordings directory".to_string());
        }
        std::fs::remove_dir_all(&canonical)
            .map_err(|e| format!("Failed to delete recording: {e}"))?;
    }

    Ok(())
}

/// `format_project_name` with the default template
/// (`{target_name} ({target_kind}) {date} {time}`), then the same `:` -> `.`
/// replacement and uniquing the Tauri app applies.
fn create_project_dir(
    target: &ScreenCaptureTarget,
    recording_mode: RecordingMode,
) -> anyhow::Result<PathBuf> {
    let base = recordings_dir();
    std::fs::create_dir_all(&base)
        .with_context(|| format!("creating recordings dir {}", base.display()))?;

    match cap_utils::disk_space::free_bytes_for_path(&base) {
        Ok(bytes) if bytes <= cap_utils::disk_space::RECORDING_DISK_RESERVE_BYTES => {
            return Err(anyhow!(
                "Low storage: only {:.2} GB is available. Free up at least {} MB before recording.",
                bytes as f64 / 1_073_741_824.0,
                cap_utils::disk_space::RECORDING_DISK_RESERVE_BYTES / (1024 * 1024)
            ));
        }
        Ok(bytes) if bytes <= cap_utils::disk_space::RECORDING_DISK_WARN_BYTES => {
            tracing::warn!(
                bytes_remaining = bytes,
                "Starting recording with low disk space"
            );
        }
        Ok(_) => {}
        Err(error) => return Err(anyhow!("Could not check recording storage: {error}")),
    }

    let target_name = target.title().unwrap_or_else(|| "Unknown".into());
    let now = chrono::Local::now();
    let settings = crate::store::GeneralSettings::load();
    let name = format_recording_project_name(
        settings.default_project_name_template.as_deref(),
        &target_name,
        target.kind_str(),
        recording_mode,
        now,
    );
    // Same normalization chain as the Tauri app: colons break Finder, slashes
    // break paths.
    let filename = format!("{}.cap", name.replace([':', '/'], "."));
    let filename = cap_utils::ensure_unique_filename(&filename, &base)
        .map_err(|e| anyhow!("unique filename: {e}"))?;

    Ok(base.join(filename))
}

fn format_recording_project_name(
    template: Option<&str>,
    target_name: &str,
    target_kind: &str,
    mode: RecordingMode,
    datetime: chrono::DateTime<chrono::Local>,
) -> String {
    let target_name = if target_name.chars().count() > 180 {
        format!("{}...", target_name.chars().take(180).collect::<String>())
    } else {
        target_name.to_string()
    };
    let (recording_mode, mode) = match mode {
        RecordingMode::Studio => ("Studio", "studio"),
        RecordingMode::Instant => ("Instant", "instant"),
    };
    let formatted = template
        .unwrap_or(crate::store::DEFAULT_PROJECT_NAME_TEMPLATE)
        .replace("{recording_mode}", recording_mode)
        .replace("{mode}", mode)
        .replace("{target_kind}", target_kind)
        .replace("{target_name}", &target_name);
    let formatted = replace_datetime_template_token(&formatted, "date", "%Y-%m-%d", datetime);
    let formatted = replace_datetime_template_token(&formatted, "time", "%I:%M %p", datetime);
    replace_datetime_template_token(&formatted, "moment", "%Y-%m-%d %H:%M", datetime)
}

fn replace_datetime_template_token(
    input: &str,
    name: &str,
    default_format: &str,
    datetime: chrono::DateTime<chrono::Local>,
) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    let prefix = format!("{{{name}");

    while let Some(start) = remaining.find(&prefix) {
        output.push_str(&remaining[..start]);
        let candidate = &remaining[start..];
        let Some(end) = candidate.find('}') else {
            output.push_str(candidate);
            return output;
        };
        let token = &candidate[1..end];
        if token == name {
            output.push_str(&datetime.format(default_format).to_string());
        } else if let Some(custom_format) = token.strip_prefix(&format!("{name}:")) {
            let format = cap_utils::moment_format_to_chrono(custom_format);
            output.push_str(&datetime.format(&format).to_string());
        } else {
            output.push_str(&candidate[..=end]);
        }
        remaining = &candidate[end + 1..];
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::BlurMode;
    use chrono::TimeZone as _;
    use serde_json::Value;
    use std::sync::{Arc, Barrier};

    #[test]
    fn recording_project_names_honor_mode_target_and_custom_datetime_formats() {
        let timestamp = chrono::Local
            .with_ymd_and_hms(2026, 8, 25, 14, 7, 9)
            .single()
            .unwrap();

        assert_eq!(
            format_recording_project_name(
                Some(
                    "{recording_mode}-{mode}-{target_kind}-{target_name}-{date:DD/MM/YYYY}-{time:HH.mm}-{moment:YYYYMMDD_HHmmss}"
                ),
                "Example Window",
                "Window",
                RecordingMode::Instant,
                timestamp,
            ),
            "Instant-instant-Window-Example Window-25/08/2026-14.07-20260825_140709"
        );
    }

    #[test]
    fn recording_project_names_preserve_unknown_tokens_and_limit_target_length() {
        let timestamp = chrono::Local
            .with_ymd_and_hms(2026, 8, 25, 9, 15, 0)
            .single()
            .unwrap();
        let target = "x".repeat(200);

        assert_eq!(
            format_recording_project_name(
                Some("{mode}-{target_name}-{unknown}"),
                &target,
                "Display",
                RecordingMode::Studio,
                timestamp,
            ),
            format!("studio-{}...-{{unknown}}", "x".repeat(180))
        );
    }

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

    #[test]
    fn stopped_instant_metadata_preserves_recovery_and_upload_state() {
        let dir = temp_project("instant-stopped");
        std::fs::write(
            dir.join("recording-meta.json"),
            r#"{"pretty_name":"Storage test","sharing":null,"recording":true,"upload":{"state":"Failed","error":"offline"}}"#,
        )
        .unwrap();
        mark_instant_recording_stopped(&dir, &std::sync::Mutex::new(())).unwrap();
        let meta = cap_project::RecordingMeta::load_for_project(&dir).unwrap();
        assert!(matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::InProgress { recording: false }
            )
        ));
        assert!(matches!(
            meta.upload,
            Some(cap_project::UploadMeta::Failed { error }) if error == "offline"
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_instant_metadata_write_preserves_the_previous_recording_state() {
        let dir = temp_project("instant-metadata-write-failure");
        let original = br#"{"pretty_name":"Storage test","sharing":null,"recording":true}"#;
        let path = dir.join("recording-meta.json");
        std::fs::write(&path, original).unwrap();

        let result = write_instant_metadata(&dir, |file| {
            std::io::Write::write_all(file, b"{partial")?;
            Err(std::io::Error::other("simulated disk full"))
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_instant_metadata_updates_stay_valid_and_recoverable() {
        for finalized in [false, true] {
            let dir = temp_project("instant-metadata-race");
            let initial = serde_json::json!({
                "pretty_name": "Race test",
                "sharing": null,
                "recording": true,
                "upload": { "state": "Failed", "error": "old" },
            });
            std::fs::write(
                dir.join("recording-meta.json"),
                serde_json::to_vec(&initial).unwrap(),
            )
            .unwrap();

            let metadata_lock = Arc::new(std::sync::Mutex::new(()));
            let barrier = Arc::new(Barrier::new(2));
            let stopped_dir = dir.clone();
            let stopped_lock = metadata_lock.clone();
            let stopped_barrier = barrier.clone();
            let failed_dir = dir.clone();
            let failed_lock = metadata_lock.clone();
            let failed_barrier = barrier.clone();
            std::thread::scope(|scope| {
                let stopped = scope.spawn(move || {
                    stopped_barrier.wait();
                    if finalized {
                        let completed = instant_recording::CompletedRecording {
                            project_path: stopped_dir,
                            display_source: ScreenCaptureTarget::CameraOnly,
                            meta: cap_project::InstantRecordingMeta::Complete {
                                fps: 30,
                                sample_rate: Some(48_000),
                            },
                            health: cap_recording::RecordingHealth::Healthy,
                        };
                        let video = cap_project::VideoUploadInfo {
                            id: "test".into(),
                            link: "https://example.invalid/s/test".into(),
                            config: cap_project::S3UploadMeta { id: "test".into() },
                        };
                        persist_instant_meta(&completed, &video, &stopped_lock)
                    } else {
                        mark_instant_recording_stopped(&stopped_dir, &stopped_lock)
                    }
                });
                let failed = scope.spawn(move || {
                    failed_barrier.wait();
                    persist_instant_upload_failure(&failed_dir, "offline", &failed_lock)
                });
                stopped.join().unwrap().unwrap();
                failed.join().unwrap().unwrap();
            });

            let meta = cap_project::RecordingMeta::load_for_project(&dir).unwrap();
            assert!(matches!(
                (finalized, meta.inner),
                (
                    false,
                    cap_project::RecordingMetaInner::Instant(
                        cap_project::InstantRecordingMeta::InProgress { recording: false },
                    )
                ) | (
                    true,
                    cap_project::RecordingMetaInner::Instant(
                        cap_project::InstantRecordingMeta::Complete {
                            fps: 30,
                            sample_rate: Some(48_000)
                        },
                    )
                )
            ));
            assert!(matches!(
                meta.upload,
                Some(cap_project::UploadMeta::Failed { error }) if error == "offline"
            ));
            std::fs::remove_dir_all(dir).unwrap();
        }
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
        assert!(!apply_camera_blur_to_project_config(
            &empty,
            BlurMode::Light
        ));
        assert!(!empty.join("project-config.json").exists());

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    /// The delete guard refuses anything that could reach outside the
    /// recordings library -- `..` components before any IO at all, and a path
    /// that is not under the library root. (The happy path is exercised by
    /// the editor-append flow; it depends on the user's configured library
    /// location, which a unit test must not touch.)
    #[test]
    fn recording_delete_guards_the_library_root() {
        assert!(delete_recording_directory(std::path::Path::new("/tmp/../etc")).is_err());
        assert!(
            delete_recording_directory(std::path::Path::new(
                "/System/definitely-not-the-cap-library.cap"
            ))
            .is_err()
        );
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
