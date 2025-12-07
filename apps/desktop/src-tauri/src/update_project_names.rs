use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use cap_project::RecordingMeta;
use futures::StreamExt;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use tokio::{fs, sync::Mutex};

use crate::recordings_path;

const STORE_KEY: &str = "uuid_projects_migrated";

pub fn migrate_if_needed(app: &AppHandle) -> Result<(), String> {
    let store = app
        .store("store")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    if store
        .get(STORE_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Ok(());
    }

    let app_handle = app.clone();
    tokio::spawn(async move {
        if let Err(err) = migrate(&app_handle).await {
            tracing::error!("Updating project names failed: {err}");
        }

        if let Ok(store) = app_handle.store("store") {
            store.set(STORE_KEY, true);
            if let Err(e) = store.save() {
                tracing::error!("Failed to save store after migration: {}", e);
            }
        }
    });

    Ok(())
}

use std::time::Instant;

/// Performs a one-time migration of all UUID-named projects to pretty name-based naming.
pub async fn migrate(app: &AppHandle) -> Result<(), String> {
    let recordings_dir = recordings_path(app);
    if !fs::try_exists(&recordings_dir)
        .await
        .map_err(|e| format!("Failed to check recordings directory: {}", e))?
    {
        return Ok(());
    }

    let uuid_projects = collect_uuid_projects(&recordings_dir).await?;
    if uuid_projects.is_empty() {
        tracing::debug!("No UUID-named projects found to migrate");
        return Ok(());
    }

    tracing::info!(
        "Found {} UUID-named projects to migrate",
        uuid_projects.len()
    );

    let total_found = uuid_projects.len();
    let concurrency_limit = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 16)
        .min(total_found);
    tracing::debug!("Using concurrency limit of {}", concurrency_limit);

    let wall_start = Instant::now();
    let in_flight_bases = Arc::new(Mutex::new(HashSet::new()));

    // (project_name, result, duration)
    let migration_results = futures::stream::iter(uuid_projects)
        .map(|project_path| {
            let in_flight = in_flight_bases.clone();
            async move {
                let project_name = project_path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| project_path.display().to_string());

                let start = Instant::now();
                let res = migrate_single_project(project_path, in_flight).await;
                let dur = start.elapsed();

                (project_name, res, dur)
            }
        })
        .buffer_unordered(concurrency_limit)
        .collect::<Vec<_>>()
        .await;

    let wall_elapsed = wall_start.elapsed();

    let mut migrated = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    let mut total_ms: u128 = 0;
    let mut per_project: Vec<(String, std::time::Duration)> =
        Vec::with_capacity(migration_results.len());

    for (name, result, dur) in migration_results.into_iter() {
        match result {
            Ok(ProjectMigrationResult::Migrated) => migrated += 1,
            Ok(ProjectMigrationResult::Skipped) => skipped += 1,
            Err(_) => failed += 1,
        }
        total_ms += dur.as_millis();
        per_project.push((name, dur));
    }

    let avg_ms = if total_found > 0 {
        (total_ms as f64) / (total_found as f64)
    } else {
        0.0
    };

    // Sort by duration descending to pick slowest
    per_project.sort_by(|a, b| b.1.cmp(&a.1));

    tracing::info!(
        total_found = total_found,
        migrated = migrated,
        skipped = skipped,
        failed = failed,
        wall_ms = wall_elapsed.as_millis(),
        avg_per_project_ms = ?avg_ms,
        "Migration complete"
    );

    // Log top slowest N (choose 5 or less)
    let top_n = 5.min(per_project.len());
    if top_n > 0 {
        tracing::info!("Top {} slowest project migrations:", top_n);
        for (name, dur) in per_project.into_iter().take(top_n) {
            tracing::info!(project = %name, ms = dur.as_millis());
        }
    }

    Ok(())
}

async fn collect_uuid_projects(recordings_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut uuid_projects = Vec::new();
    let mut entries = fs::read_dir(recordings_dir)
        .await
        .map_err(|e| format!("Failed to read recordings directory: {}", e))?;

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read directory entry: {}", e))?
    {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };

        if filename.ends_with(".cap") && fast_is_project_filename_uuid(filename) {
            uuid_projects.push(path);
        }
    }

    Ok(uuid_projects)
}

#[derive(Debug)]
enum ProjectMigrationResult {
    Migrated,
    Skipped,
}

async fn migrate_single_project(
    path: PathBuf,
    in_flight_basis: Arc<Mutex<HashSet<String>>>,
) -> Result<ProjectMigrationResult, String> {
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");

    let meta = match RecordingMeta::load_for_project(&path) {
        Ok(meta) => meta,
        Err(e) => {
            tracing::warn!("Failed to load metadata for {}: {}", filename, e);
            return Err(format!("Failed to load metadata: {}", e));
        }
    };

    // Lock on the base sanitized name to prevent concurrent migrations with same target
    let base_name = sanitize_filename::sanitize(meta.pretty_name.replace(":", "."));
    {
        let mut in_flight = in_flight_basis.lock().await;
        let mut wait_count = 0;
        while !in_flight.insert(base_name.clone()) {
            wait_count += 1;
            if wait_count == 1 {
                tracing::debug!(
                    "Project {} waiting for concurrent migration of base name \"{}\"",
                    filename,
                    base_name
                );
            }
            drop(in_flight);
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            in_flight = in_flight_basis.lock().await;
        }
        if wait_count > 0 {
            tracing::debug!(
                "Project {} acquired lock for \"{}\" after {} waits",
                filename,
                base_name,
                wait_count
            );
        }
    }

    let result = migrate_project_filename_async(&path, &meta).await;

    in_flight_basis.lock().await.remove(&base_name);

    match result {
        Ok(new_path) => {
            if new_path != path {
                let new_name = new_path.file_name().unwrap().to_string_lossy();
                tracing::info!("Updated name: \"{}\" -> \"{}\"", filename, new_name);
                Ok(ProjectMigrationResult::Migrated)
            } else {
                Ok(ProjectMigrationResult::Skipped)
            }
        }
        Err(e) => {
            tracing::error!("Failed to migrate {}: {}", filename, e);
            Err(e)
        }
    }
}

/// Migrates a project filename from UUID to sanitized pretty name
async fn migrate_project_filename_async(
    project_path: &Path,
    meta: &RecordingMeta,
) -> Result<PathBuf, String> {
    let sanitized = sanitize_filename::sanitize(meta.pretty_name.replace(":", "."));

    let filename = if sanitized.ends_with(".cap") {
        sanitized
    } else {
        format!("{}.cap", sanitized)
    };

    let parent_dir = project_path
        .parent()
        .ok_or("Project path has no parent directory")?;

    let unique_filename = cap_utils::ensure_unique_filename(&filename, parent_dir)
        .map_err(|e| format!("Failed to ensure unique filename: {}", e))?;

    let final_path = parent_dir.join(&unique_filename);

    fs::rename(project_path, &final_path)
        .await
        .map_err(|e| format!("Failed to rename project directory: {}", e))?;

    Ok(final_path)
}

pub fn fast_is_project_filename_uuid(filename: &str) -> bool {
    if filename.len() != 40 || !filename.ends_with(".cap") {
        return false;
    }

    let uuid_part = &filename[..36];

    if uuid_part.as_bytes()[8] != b'-'
        || uuid_part.as_bytes()[13] != b'-'
        || uuid_part.as_bytes()[18] != b'-'
        || uuid_part.as_bytes()[23] != b'-'
    {
        return false;
    }

    uuid_part.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_project_filename_uuid() {
        // Valid UUID
        assert!(fast_is_project_filename_uuid(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890.cap"
        ));
        assert!(fast_is_project_filename_uuid(
            "00000000-0000-0000-0000-000000000000.cap"
        ));

        // Invalid cases
        assert!(!fast_is_project_filename_uuid("my-project-name.cap"));
        assert!(!fast_is_project_filename_uuid(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        ));
        assert!(!fast_is_project_filename_uuid(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890.txt"
        ));
        assert!(!fast_is_project_filename_uuid(
            "g1b2c3d4-e5f6-7890-abcd-ef1234567890.cap"
        ));
    }
}
