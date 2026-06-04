use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};

use cap_project::{RecordingMeta, RecordingMetaInner};
use serde::Serialize;

use crate::{OutputFormat, write_json};

// Production bundle identifier; matches tauri.prod.conf.json. Dev builds use `so.cap.desktop.dev`,
// which the user can reach with an explicit `--dir`.
const DESKTOP_BUNDLE_IDENTIFIER: &str = "so.cap.desktop";

fn default_library_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .ok_or_else(|| "Could not determine the OS application-data directory".to_string())
        .map(|dir| dir.join(DESKTOP_BUNDLE_IDENTIFIER).join("recordings"))
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

fn collect_rows(dir: &Path) -> Result<Vec<RecordingRow>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<(PathBuf, SystemTime, RecordingMeta)> = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read recordings directory: {e}"))?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if !path.is_dir() || !path.file_name()?.to_str()?.ends_with(".cap") {
                return None;
            }
            let meta = RecordingMeta::load_for_project(&path).ok()?;
            let created = path
                .metadata()
                .and_then(|m| m.created())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            Some((path, created, meta))
        })
        .collect();

    entries.sort_by(|a, b| b.1.cmp(&a.1));

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
    let dir = match dir {
        Some(dir) => dir,
        None => default_library_dir()?,
    };

    let rows = collect_rows(&dir)?;

    match format {
        OutputFormat::Json => write_json(&rows),
        OutputFormat::Text => {
            if rows.is_empty() {
                println!("No recordings found in {}", dir.display());
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
