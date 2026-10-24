use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::SystemTime,
};

use cap_project::{RecordingMeta, RecordingMetaInner};
use serde::Serialize;

use crate::{OutputFormat, write_json};

// Production bundle identifier; matches tauri.prod.conf.json. Dev builds use `so.cap.desktop.dev`,
// which the user can reach with an explicit `--dir`.
const DESKTOP_BUNDLE_IDENTIFIER: &str = "so.cap.desktop";

fn library_dirs(app_data: &Path) -> Vec<PathBuf> {
    let store = std::fs::read(app_data.join("store"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let settings = store
        .as_ref()
        .and_then(|store| store.get("general_settings"));
    let mut dirs = Vec::new();

    if let Some(path) = settings
        .and_then(|settings| settings.get("recordingsPath"))
        .and_then(serde_json::Value::as_str)
    {
        dirs.push(PathBuf::from(path));
    }
    dirs.push(app_data.join("recordings"));
    if let Some(paths) = settings
        .and_then(|settings| settings.get("previousRecordingsPaths"))
        .and_then(serde_json::Value::as_array)
    {
        dirs.extend(
            paths
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(PathBuf::from),
        );
    }

    let mut seen = HashSet::new();
    dirs.retain(|path| {
        path.is_absolute()
            && path.is_dir()
            && seen.insert(path.canonicalize().unwrap_or_else(|_| path.clone()))
    });
    dirs
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingRow {
    path: PathBuf,
    name: String,
    recording_type: &'static str,
    output_path: PathBuf,
    output_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    sharing_link: Option<String>,
}

fn recording_type(meta: &RecordingMeta) -> &'static str {
    match meta.inner {
        RecordingMetaInner::Studio(_) => "studio",
        RecordingMetaInner::Instant(_) => "instant",
    }
}

fn collect_rows(
    dirs: &[PathBuf],
    fail_on_unreadable: bool,
    created_at: impl Fn(&Path) -> std::io::Result<SystemTime>,
) -> Result<Vec<RecordingRow>, String> {
    let mut entries: Vec<(PathBuf, SystemTime, RecordingMeta)> = Vec::new();
    for dir in dirs {
        if !dir.exists() {
            continue;
        }
        let contents = match std::fs::read_dir(dir) {
            Ok(contents) => contents,
            Err(_) if !fail_on_unreadable => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to read recordings directory {}: {error}",
                    dir.display()
                ));
            }
        };
        entries.extend(contents.filter_map(|entry| {
            let path = entry.ok()?.path();
            if !path.is_dir() || !path.file_name()?.to_str()?.ends_with(".cap") {
                return None;
            }
            let meta = RecordingMeta::load_for_project(&path).ok()?;
            let created = created_at(&path).unwrap_or(SystemTime::UNIX_EPOCH);
            Some((path, created, meta))
        }));
    }

    entries.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    Ok(entries
        .into_iter()
        .map(|(path, _, meta)| {
            let output_path = meta.output_path();
            RecordingRow {
                output_exists: output_path.exists(),
                recording_type: recording_type(&meta),
                name: meta.pretty_name,
                sharing_link: meta.sharing.map(|s| s.link),
                output_path,
                path,
            }
        })
        .collect())
}

pub fn list(dir: Option<PathBuf>, format: OutputFormat) -> Result<(), String> {
    let dirs = match &dir {
        Some(dir) => vec![dir.clone()],
        None => {
            let app_data = dirs::data_dir()
                .ok_or_else(|| "Could not determine the OS application-data directory".to_string())?
                .join(DESKTOP_BUNDLE_IDENTIFIER);
            library_dirs(&app_data)
        }
    };

    let rows = collect_rows(&dirs, dir.is_some(), |path| path.metadata()?.created())?;

    match format {
        OutputFormat::Json => write_json(&rows),
        OutputFormat::Text => {
            if rows.is_empty() {
                match dir {
                    Some(dir) => println!("No recordings found in {}", dir.display()),
                    None => println!("No recordings found in the desktop library"),
                }
                return Ok(());
            }
            for row in &rows {
                println!(
                    "{}  [{}]  {}",
                    row.name,
                    row.recording_type,
                    row.path.display()
                );
                if let Some(link) = &row.sharing_link {
                    println!("  link: {link}");
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_recording(path: &Path, name: &str) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(
            path.join("recording-meta.json"),
            serde_json::to_vec(&serde_json::json!({
                "pretty_name": name, "fps": 30, "sample_rate": null
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn discovers_current_default_and_previous_storage_once() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("desktop");
        let default = app_data.join("recordings");
        let current = root.path().join("current");
        let previous = root.path().join("previous");
        for dir in [&default, &current, &previous] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(
            app_data.join("store"),
            serde_json::to_vec(&serde_json::json!({
                "general_settings": {
                    "recordingsPath": current,
                    "previousRecordingsPaths": [previous, current, "relative", root.path().join("missing"), 42]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(library_dirs(&app_data), vec![current, default, previous]);
    }

    #[test]
    fn falls_back_to_default_storage_without_valid_settings() {
        let root = tempfile::tempdir().unwrap();
        let default = root.path().join("recordings");
        std::fs::create_dir(&default).unwrap();
        assert_eq!(library_dirs(root.path()), vec![default.clone()]);

        for store in [
            "invalid JSON",
            r#"{"general_settings":{"recordingsPath":false,"previousRecordingsPaths":"invalid"}}"#,
        ] {
            std::fs::write(root.path().join("store"), store).unwrap();
            assert_eq!(library_dirs(root.path()), vec![default.clone()]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn deduplicates_storage_reached_through_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let default = root.path().join("recordings");
        let alias = root.path().join("alias");
        std::fs::create_dir(&default).unwrap();
        std::os::unix::fs::symlink(&default, &alias).unwrap();
        std::fs::write(
            root.path().join("store"),
            serde_json::to_vec(&serde_json::json!({
                "general_settings": { "recordingsPath": alias }
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(library_dirs(root.path()), vec![alias]);
    }

    #[test]
    fn merges_recordings_from_multiple_libraries_newest_first() {
        let root = tempfile::tempdir().unwrap();
        let recordings = [
            (root.path().join("default/oldest.cap"), "Oldest", 10),
            (root.path().join("custom/older.cap"), "Older", 20),
            (root.path().join("default/newer.cap"), "Newer", 30),
            (root.path().join("custom/newest.cap"), "Newest", 40),
        ];
        for (path, name, _) in &recordings {
            write_recording(path, name);
        }

        let rows = collect_rows(
            &[root.path().join("default"), root.path().join("custom")],
            true,
            |path| {
                let (_, _, seconds) = recordings
                    .iter()
                    .find(|(recording_path, _, _)| recording_path == path)
                    .unwrap();
                Ok(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(*seconds))
            },
        )
        .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
            ["Newest", "Newer", "Older", "Oldest"]
        );
    }

    #[test]
    fn skips_unavailable_roots_only_when_discovering_the_library() {
        let root = tempfile::tempdir().unwrap();
        let available = root.path().join("available");
        let unavailable = root.path().join("unavailable");
        write_recording(&available.join("example.cap"), "Available");
        std::fs::write(&unavailable, "no longer a directory").unwrap();

        let rows = collect_rows(&[unavailable.clone(), available], false, |path| {
            path.metadata()?.created()
        })
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "Available");
        assert!(collect_rows(&[unavailable], true, |path| path.metadata()?.created()).is_err());
    }
}
