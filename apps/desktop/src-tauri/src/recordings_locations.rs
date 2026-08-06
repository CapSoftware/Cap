use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Wry};
use tauri_specta::Event;
use tracing::{info, warn};

use crate::{
    ArcLock, RecordingState, editor_window::EditorInstances, general_settings::GeneralSettingsStore,
};

/// Staging directory (inside the destination) used for cross-volume moves.
/// Projects are copied here first, then renamed into place, so a partially
/// copied project can never appear in the recordings list: the staging dir
/// itself has no recording-meta.json and every scanner skips it.
const MIGRATION_STAGING_DIR: &str = ".migrating-tmp";

/// How many previously used custom folders we remember so their recordings
/// stay visible after switching away from them.
const MAX_PREVIOUS_PATHS: usize = 20;

pub fn default_recordings_dir(app: &AppHandle<Wry>) -> PathBuf {
    app.path().app_data_dir().unwrap().join("recordings")
}

/// Every directory that may contain recordings: the active directory first,
/// then the default location and any previously used custom folders.
/// Deduplicated by canonical path; directories that don't exist are skipped.
pub fn known_recordings_dirs(app: &AppHandle<Wry>) -> Vec<PathBuf> {
    let mut dirs = vec![
        GeneralSettingsStore::recordings_dir(app),
        default_recordings_dir(app),
    ];

    if let Ok(Some(settings)) = GeneralSettingsStore::get(app) {
        dirs.extend(
            settings
                .previous_recordings_paths
                .iter()
                .map(PathBuf::from)
                .filter(|p| p.is_absolute()),
        );
    }

    dedupe_existing_dirs(dirs)
}

fn dedupe_existing_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        // Canonicalize so the same folder reached via different spellings
        // (trailing components, symlinks, Windows case differences) is only
        // scanned once; otherwise every recording would be listed twice.
        let key = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if seen.insert(key) {
            out.push(dir);
        }
    }
    out
}

/// Records the folder we're switching away from so its recordings remain
/// visible. `new_path` is removed from history since it's current again.
pub fn remember_previous_recordings_path(
    settings: &mut GeneralSettingsStore,
    previous: Option<String>,
    new_path: Option<&str>,
) {
    if let Some(new_path) = new_path {
        settings.previous_recordings_paths.retain(|p| p != new_path);
    }

    if let Some(previous) = previous
        && new_path != Some(previous.as_str())
        && !settings.previous_recordings_paths.contains(&previous)
    {
        settings.previous_recordings_paths.push(previous);
        let len = settings.previous_recordings_paths.len();
        if len > MAX_PREVIOUS_PATHS {
            settings
                .previous_recordings_paths
                .drain(..len - MAX_PREVIOUS_PATHS);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct RecordingsMigrationProgress {
    pub total: u32,
    pub done: u32,
    pub current: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingsMigrationFailure {
    pub name: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingsMigrationSummary {
    pub moved: u32,
    pub skipped_in_use: u32,
    pub failed: Vec<RecordingsMigrationFailure>,
}

/// Project directories that live in a known location other than the current
/// recordings directory.
fn migratable_projects(app: &AppHandle<Wry>) -> Vec<PathBuf> {
    let current = GeneralSettingsStore::recordings_dir(app);
    let current_key = current.canonicalize().unwrap_or(current);

    let mut projects = Vec::new();
    for dir in known_recordings_dirs(app) {
        if dir.canonicalize().unwrap_or_else(|_| dir.clone()) == current_key {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || path.extension().and_then(|e| e.to_str()) != Some("cap") {
                continue;
            }
            // Never try to move a folder into itself if the user nested the
            // new location inside an old project dir. Compare canonicalized
            // paths on both sides (canonicalize is not prefix-stable on
            // Windows, where it adds `\\?\`).
            let path_key = path.canonicalize().unwrap_or_else(|_| path.clone());
            if current_key.starts_with(&path_key) {
                continue;
            }
            projects.push(path);
        }
    }
    projects
}

#[tauri::command]
#[specta::specta]
pub async fn count_recordings_to_migrate(app: AppHandle) -> Result<u32, String> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || migratable_projects(&app).len() as u32)
        .await
        .map_err(|e| format!("Migration scan failed: {e}"))
}

static MIGRATION_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Releases the migration lock on every exit path, including `?` returns.
struct MigrationLockGuard;

impl Drop for MigrationLockGuard {
    fn drop(&mut self) {
        MIGRATION_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn migrate_recordings_to_current_dir(
    app: AppHandle,
) -> Result<RecordingsMigrationSummary, String> {
    // Two concurrent migrations would race on the shared staging dir and
    // report projects the other run already moved as failures.
    if MIGRATION_IN_PROGRESS
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return Err("A recordings migration is already in progress".to_string());
    }
    let _lock = MigrationLockGuard;

    let dest = GeneralSettingsStore::recordings_dir(&app);

    // Leftover staging from an interrupted previous run: the copies in there
    // are incomplete by definition (their source was kept), so remove them.
    let stale_staging = dest.join(MIGRATION_STAGING_DIR);
    if stale_staging.exists()
        && let Err(e) = std::fs::remove_dir_all(&stale_staging)
    {
        warn!("Failed to clean stale migration staging dir: {e}");
    }

    let projects = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || migratable_projects(&app))
            .await
            .map_err(|e| format!("Migration scan failed: {e}"))?
    };

    let total = projects.len() as u32;
    let mut summary = RecordingsMigrationSummary {
        moved: 0,
        skipped_in_use: 0,
        failed: Vec::new(),
    };

    for (i, project) in projects.into_iter().enumerate() {
        let name = project
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| project.display().to_string());

        RecordingsMigrationProgress {
            total,
            done: i as u32,
            current: Some(name.clone()),
        }
        .emit(&app)
        .ok();

        // Re-resolved for every project: an editor can open (or a recording
        // stop) while earlier projects are still being copied.
        let in_use = in_use_project_dirs(&app).await;

        if project_is_in_use(&project, &in_use) {
            info!(?project, "Migration: skipping in-use recording");
            summary.skipped_in_use += 1;
            continue;
        }

        let dest = dest.clone();
        let src = project.clone();
        let result = tokio::task::spawn_blocking(move || move_project_dir(&src, &dest))
            .await
            .map_err(|e| format!("Move task failed: {e}"))
            .and_then(|r| r);

        match result {
            Ok(new_path) => {
                info!(from = ?project, to = ?new_path, "Migration: moved recording");
                summary.moved += 1;
            }
            Err(error) => {
                warn!(?project, %error, "Migration: failed to move recording; kept in place");
                summary
                    .failed
                    .push(RecordingsMigrationFailure { name, error });
            }
        }
    }

    RecordingsMigrationProgress {
        total,
        done: total,
        current: None,
    }
    .emit(&app)
    .ok();

    Ok(summary)
}

async fn in_use_project_dirs(app: &AppHandle<Wry>) -> HashSet<PathBuf> {
    let mut in_use = HashSet::new();

    let state = app.state::<ArcLock<crate::App>>();
    {
        let state = state.read().await;
        if let RecordingState::Active(recording) = &state.recording_state {
            let dir = &recording.common().recording_dir;
            in_use.insert(dir.canonicalize().unwrap_or_else(|_| dir.clone()));
        }
    }

    for path in EditorInstances::open_project_paths(app).await {
        in_use.insert(path.canonicalize().unwrap_or(path));
    }

    in_use
}

fn project_is_in_use(project: &Path, in_use: &HashSet<PathBuf>) -> bool {
    let key = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    if in_use.contains(&key) {
        return true;
    }

    // Belt and braces: a recording that is mid-write has InProgress status in
    // its meta even if we failed to resolve it from app state.
    match cap_project::RecordingMeta::load_for_project(project) {
        Ok(meta) => match &meta.inner {
            cap_project::RecordingMetaInner::Studio(studio) => {
                if let cap_project::StudioRecordingMeta::MultipleSegments { inner, .. } =
                    studio.as_ref()
                {
                    matches!(
                        inner.status,
                        Some(cap_project::StudioRecordingStatus::InProgress)
                    )
                } else {
                    false
                }
            }
            cap_project::RecordingMetaInner::Instant(instant) => {
                matches!(
                    instant,
                    cap_project::InstantRecordingMeta::InProgress { .. }
                )
            }
        },
        // Unreadable meta is not proof of activity; old or partially written
        // projects still deserve to be moved rather than stranded.
        Err(_) => false,
    }
}

/// Moves one project directory into `dest_dir`, keeping the name unique.
/// Tries a plain rename first; on failure (typically a cross-volume move)
/// falls back to copy + verify + delete, staged so the destination never
/// exposes a partially copied project. The source is only removed after the
/// copy has been verified.
pub fn move_project_dir(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid project directory name".to_string())?;

    // A destination inside the source would make the recursive copy descend
    // into its own output and never terminate. Refuse outright.
    let src_key = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let dest_key = dest_dir
        .canonicalize()
        .unwrap_or_else(|_| dest_dir.to_path_buf());
    if dest_key.starts_with(&src_key) {
        return Err("Destination folder is inside this recording".to_string());
    }

    let unique = cap_utils::ensure_unique_filename(name, dest_dir)?;
    let target = dest_dir.join(&unique);

    match std::fs::rename(src, &target) {
        Ok(()) => Ok(target),
        Err(rename_err) => copy_verify_delete(src, dest_dir, &unique).map_err(|copy_err| {
            format!("rename failed ({rename_err}); copy fallback failed: {copy_err}")
        }),
    }
}

fn copy_verify_delete(src: &Path, dest_dir: &Path, unique: &str) -> Result<PathBuf, String> {
    let staging_root = dest_dir.join(MIGRATION_STAGING_DIR);
    let staging = staging_root.join(unique);

    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| format!("Failed to clear staging dir: {e}"))?;
    }
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| format!("Failed to create staging dir: {e}"))?;

    let cleanup = |err: String| -> String {
        let _ = std::fs::remove_dir_all(&staging);
        err
    };

    copy_dir_recursive(src, &staging).map_err(cleanup)?;

    let src_stats = dir_stats(src).map_err(cleanup)?;
    let staged_stats = dir_stats(&staging).map_err(cleanup)?;
    if src_stats != staged_stats {
        return Err(cleanup(format!(
            "verification failed: source has {} files / {} bytes, copy has {} files / {} bytes",
            src_stats.0, src_stats.1, staged_stats.0, staged_stats.1
        )));
    }

    let target = dest_dir.join(unique);
    std::fs::rename(&staging, &target)
        .map_err(|e| cleanup(format!("Failed to finalize copied project: {e}")))?;

    let _ = std::fs::remove_dir_all(&staging_root);

    // The copy is verified and in place; a failure to delete the source only
    // leaves a duplicate behind, which is safe. Don't fail the migration.
    if let Err(e) = std::fs::remove_dir_all(src) {
        warn!(
            ?src,
            "Migration: copied project but failed to remove the original: {e}"
        );
    }

    Ok(target)
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Failed to create {dest:?}: {e}"))?;

    for entry in std::fs::read_dir(src).map_err(|e| format!("Failed to read {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read entry in {src:?}: {e}"))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to stat {from:?}: {e}"))?;

        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("Failed to copy {from:?}: {e}"))?;
        }
    }

    Ok(())
}

/// (file count, total bytes), following the same traversal as
/// `copy_dir_recursive` so the two are comparable.
fn dir_stats(dir: &Path) -> Result<(u64, u64), String> {
    let mut files = 0u64;
    let mut bytes = 0u64;

    for entry in std::fs::read_dir(dir).map_err(|e| format!("Failed to read {dir:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read entry in {dir:?}: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to stat {:?}: {e}", entry.path()))?;

        if file_type.is_dir() {
            let (f, b) = dir_stats(&entry.path())?;
            files += f;
            bytes += b;
        } else {
            files += 1;
            bytes += entry
                .metadata()
                .map_err(|e| format!("Failed to stat {:?}: {e}", entry.path()))?
                .len();
        }
    }

    Ok((files, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_project(parent: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = parent.join(name);
        std::fs::create_dir_all(dir.join("content")).unwrap();
        for (rel, contents) in files {
            std::fs::write(dir.join(rel), contents).unwrap();
        }
        dir
    }

    #[test]
    fn move_project_same_volume() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("old");
        let dest_dir = tmp.path().join("new");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();

        let project = make_project(
            &src_dir,
            "Test.cap",
            &[
                ("recording-meta.json", "{}"),
                ("content/display.mp4", "vid"),
            ],
        );

        let moved = move_project_dir(&project, &dest_dir).unwrap();

        assert_eq!(moved, dest_dir.join("Test.cap"));
        assert!(!project.exists());
        assert_eq!(
            std::fs::read_to_string(moved.join("content/display.mp4")).unwrap(),
            "vid"
        );
    }

    #[test]
    fn move_project_renames_on_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("old");
        let dest_dir = tmp.path().join("new");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();

        make_project(
            &dest_dir,
            "Test.cap",
            &[("recording-meta.json", "existing")],
        );
        let project = make_project(&src_dir, "Test.cap", &[("recording-meta.json", "incoming")]);

        let moved = move_project_dir(&project, &dest_dir).unwrap();

        assert_ne!(moved, dest_dir.join("Test.cap"));
        assert!(moved.starts_with(&dest_dir));
        assert!(!project.exists());
        assert_eq!(
            std::fs::read_to_string(dest_dir.join("Test.cap/recording-meta.json")).unwrap(),
            "existing"
        );
        assert_eq!(
            std::fs::read_to_string(moved.join("recording-meta.json")).unwrap(),
            "incoming"
        );
    }

    #[test]
    fn copy_fallback_moves_and_removes_source() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("old");
        let dest_dir = tmp.path().join("new");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();

        let project = make_project(
            &src_dir,
            "Test.cap",
            &[
                ("recording-meta.json", "{}"),
                ("content/display.mp4", "0123456789"),
            ],
        );

        let moved = copy_verify_delete(&project, &dest_dir, "Test.cap").unwrap();

        assert_eq!(moved, dest_dir.join("Test.cap"));
        assert!(!project.exists());
        assert!(!dest_dir.join(MIGRATION_STAGING_DIR).exists());
        assert_eq!(
            std::fs::read_to_string(moved.join("content/display.mp4")).unwrap(),
            "0123456789"
        );
    }

    #[test]
    fn copy_fallback_cleans_stale_staging_of_same_project() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("old");
        let dest_dir = tmp.path().join("new");
        std::fs::create_dir_all(&src_dir).unwrap();

        // A leftover partial copy from an interrupted run must not corrupt
        // the fresh copy or trip verification.
        let stale = dest_dir.join(MIGRATION_STAGING_DIR).join("Test.cap");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("recording-meta.json"), "stale partial").unwrap();

        let project = make_project(&src_dir, "Test.cap", &[("recording-meta.json", "fresh")]);

        let moved = copy_verify_delete(&project, &dest_dir, "Test.cap").unwrap();

        assert_eq!(
            std::fs::read_to_string(moved.join("recording-meta.json")).unwrap(),
            "fresh"
        );
        assert!(!project.exists());
    }

    #[test]
    fn move_refuses_destination_inside_source() {
        let tmp = tempfile::tempdir().unwrap();
        let project = make_project(tmp.path(), "Test.cap", &[("recording-meta.json", "{}")]);
        let nested_dest = project.join("content/new-storage");
        std::fs::create_dir_all(&nested_dest).unwrap();

        let result = move_project_dir(&project, &nested_dest);

        assert!(result.is_err());
        assert!(project.exists());
        assert_eq!(
            std::fs::read_to_string(project.join("recording-meta.json")).unwrap(),
            "{}"
        );
    }

    #[test]
    fn dir_stats_detects_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let a = make_project(tmp.path(), "a.cap", &[("recording-meta.json", "same")]);
        let b = make_project(
            tmp.path(),
            "b.cap",
            &[("recording-meta.json", "different!")],
        );
        let c = make_project(tmp.path(), "c.cap", &[("recording-meta.json", "same")]);

        assert_ne!(dir_stats(&a).unwrap(), dir_stats(&b).unwrap());
        assert_eq!(dir_stats(&a).unwrap(), dir_stats(&c).unwrap());
    }

    #[test]
    fn dedupe_existing_dirs_skips_missing_and_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let deduped = dedupe_existing_dirs(vec![
            a.clone(),
            b.clone(),
            a.clone(),
            tmp.path().join("missing"),
        ]);

        assert_eq!(deduped, vec![a, b]);
    }

    #[test]
    fn remember_previous_path_dedupes_and_caps() {
        let mut settings = GeneralSettingsStore::default();

        remember_previous_recordings_path(&mut settings, Some("/old".into()), Some("/new"));
        assert_eq!(settings.previous_recordings_paths, vec!["/old"]);

        // Switching again to the same target doesn't duplicate history.
        remember_previous_recordings_path(&mut settings, Some("/old".into()), Some("/new"));
        assert_eq!(settings.previous_recordings_paths, vec!["/old"]);

        // Switching back to a remembered folder removes it from history.
        remember_previous_recordings_path(&mut settings, Some("/new".into()), Some("/old"));
        assert_eq!(settings.previous_recordings_paths, vec!["/new"]);

        // Re-picking the current folder records nothing and keeps history.
        remember_previous_recordings_path(&mut settings, Some("/old".into()), Some("/old"));
        assert_eq!(settings.previous_recordings_paths, vec!["/new"]);

        for i in 0..(MAX_PREVIOUS_PATHS + 5) {
            remember_previous_recordings_path(&mut settings, Some(format!("/dir{i}")), None);
        }
        assert_eq!(settings.previous_recordings_paths.len(), MAX_PREVIOUS_PATHS);
        assert!(
            settings
                .previous_recordings_paths
                .contains(&format!("/dir{}", MAX_PREVIOUS_PATHS + 4))
        );
    }
}
