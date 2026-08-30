//! Instant-mode leg of the A/V sync self-test.
//!
//! Instant recordings mux display and system audio into a single
//! `content/output.mp4` through a different encoder/muxer path than studio
//! recordings, so a machine can pass the studio leg and still ship broken
//! instant links. This mirrors what `cap record --mode instant` does (see
//! `record.rs`): the same builder defaults, the same finalize, the same meta
//! write, so the leg exercises the shipped path rather than a private one.

use std::path::{Path, PathBuf};

use cap_project::{
    InstantRecordingMeta, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
};
use cap_recording::{
    RecordingDefaults, instant_recording, recovery::RecoveryManager,
    screen_capture::ScreenCaptureTarget,
};

/// The muxed output an instant recording produces, holding both tracks on one
/// container timeline.
pub fn output_path(project_path: &Path) -> PathBuf {
    project_path.join("content/output.mp4")
}

/// System audio only: the pattern's beeps are the signal, and a mic or camera
/// would change the pipeline shape under test.
pub async fn start_recording(
    path: &Path,
    fps: Option<u32>,
) -> Result<instant_recording::ActorHandle, String> {
    let display = scap_targets::Display::primary();
    let target = ScreenCaptureTarget::Display { id: display.id() };

    let mut builder = instant_recording::Actor::builder(path.to_path_buf(), target)
        .with_system_audio(true)
        .with_max_output_size(RecordingDefaults::default().instant_mode_max_resolution);
    if let Some(fps) = fps {
        builder = builder.with_max_fps(fps);
    }

    #[cfg(target_os = "macos")]
    let shareable_content = cidre::sc::ShareableContent::current()
        .await
        .map_err(|e| {
            format!(
                "screen recording permission unavailable: {e}. \
                 Grant Cap screen recording access in System Settings and retry."
            )
        })
        .map(cap_recording::SendableShareableContent::from)?;

    builder
        .build(
            #[cfg(target_os = "macos")]
            Some(shareable_content),
        )
        .await
        .map_err(|e| format!("failed to start instant recording: {e}"))
}

/// Mirrors `record.rs`'s instant finalize: mux the fragments into
/// `content/output.mp4`, then persist the meta so the `.cap` is a real
/// recording rather than a directory of fragments.
pub async fn finalize(
    recording: &instant_recording::CompletedRecording,
) -> Result<PathBuf, String> {
    let project_path = recording.project_path.clone();
    let output = output_path(&project_path);
    let audio_dir = project_path.join("content/audio");

    let already_muxed = std::fs::metadata(&output)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
        && !audio_dir.exists();

    if !already_muxed {
        let display_dir = project_path.join("content/display");
        let output = output.clone();
        tokio::task::spawn_blocking(move || {
            RecoveryManager::finalize_instant_output(&display_dir, &audio_dir, &output)
        })
        .await
        .map_err(|e| format!("instant finalize task join error: {e}"))?
        .map_err(|e| format!("failed to finalize instant recording: {e}"))?;
    }

    persist_meta(recording)?;

    Ok(output)
}

fn persist_meta(recording: &instant_recording::CompletedRecording) -> Result<(), String> {
    let pretty_name = recording
        .project_path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Cap Recording")
        .to_string();
    let meta = match &recording.meta {
        InstantRecordingMeta::InProgress { .. } => InstantRecordingMeta::Failed {
            error: "instant recording stopped before completion".to_string(),
        },
        other => other.clone(),
    };

    RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording.project_path.clone(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Instant(meta),
        upload: None,
    }
    .save_for_project()
    .map_err(|e| format!("failed to save instant recording meta: {e}"))?;

    ProjectConfiguration::default()
        .write(&recording.project_path)
        .map_err(|e| format!("failed to save instant project config: {e}"))
}
