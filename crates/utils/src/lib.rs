use std::{fs, future::Future, path::PathBuf, time::SystemTime};

use directories::{BaseDirs, ProjectDirs};
use tracing::Instrument;

#[cfg(windows)]
pub fn get_last_win32_error_formatted() -> String {
    format_error_message(unsafe { windows::Win32::Foundation::GetLastError().0 })
}

#[cfg(windows)]
pub fn format_error_message(error_code: u32) -> String {
    use windows::{
        Win32::System::Diagnostics::Debug::{FORMAT_MESSAGE_FROM_SYSTEM, FormatMessageW},
        core::PWSTR,
    };

    let mut buffer = vec![0u16; 1024];
    match unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_FROM_SYSTEM,
            None,
            error_code,
            0,
            PWSTR(buffer.as_mut_ptr()),
            buffer.len() as u32,
            None,
        )
    } {
        0 => format!("Unknown error: {}", error_code),
        len => String::from_utf16_lossy(&buffer[..len as usize])
            .trim()
            .to_string(),
    }
}

/// Wrapper around tokio::spawn that inherits the current tracing subscriber and span.
pub fn spawn_actor<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    use tracing::instrument::WithSubscriber;
    tokio::spawn(future.with_current_subscriber().in_current_span())
}

pub fn ensure_dir(path: &PathBuf) -> Result<PathBuf, std::io::Error> {
    std::fs::create_dir_all(path)?;
    Ok(path.clone())
}

pub fn get_recordings_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    for app_name in ["Cap - Development", "Cap"] {
        if let Some(proj_dirs) = ProjectDirs::from("so", "cap", app_name) {
            candidates.push(proj_dirs.data_dir().join("recordings"));
        }
    }

    if let Some(base_dirs) = BaseDirs::new() {
        let data_dir = base_dirs.data_dir();
        for identifier in ["so.cap.desktop.dev", "so.cap.desktop"] {
            candidates.push(data_dir.join(identifier).join("recordings"));
        }
    }

    candidates.into_iter().find(|dir| dir.exists())
}

pub fn list_recordings() -> Vec<PathBuf> {
    let Some(recordings_dir) = get_recordings_dir() else {
        return Vec::new();
    };

    let Ok(entries) = fs::read_dir(&recordings_dir) else {
        return Vec::new();
    };

    let mut recordings: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();

            if !path.is_dir() {
                return None;
            }

            if !path.join("project-config.json").exists()
                || !path.join("recording-meta.json").exists()
            {
                return None;
            }

            let created = path
                .metadata()
                .and_then(|m| m.created())
                .unwrap_or(SystemTime::UNIX_EPOCH);

            Some((created, path))
        })
        .collect();

    recordings.sort_by(|a, b| b.0.cmp(&a.0));

    recordings.into_iter().map(|(_, path)| path).collect()
}
