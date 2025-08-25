use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use base64::prelude::*;
use std::io::{Read, Write};
use zip::write::FileOptions;
use zip::ZipWriter;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_cores: u32,
    pub memory_gb: f64,
    pub displays: Vec<DisplayInfo>,
    pub cameras: Vec<String>,
    pub microphones: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DisplayInfo {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingLog {
    pub id: String,
    pub timestamp: String,
    pub duration_seconds: Option<f64>,
    pub error: Option<String>,
    pub log_content: Option<String>,
    pub log_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LogsAndSystemInfo {
    pub system_info: SystemInfo,
    pub recent_logs: Vec<RecordingLog>,
    pub app_version: String,
}

pub async fn get_system_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    
    #[cfg(target_os = "macos")]
    let os_version = {
        use std::process::Command;
        Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "Unknown".to_string())
    };
    
    #[cfg(target_os = "windows")]
    let os_version = {
        use std::process::Command;
        Command::new("cmd")
            .args(&["/C", "ver"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "Unknown".to_string())
    };
    
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let os_version = "Unknown".to_string();

    let arch = std::env::consts::ARCH.to_string();
    let cpu_cores = num_cpus::get() as u32;
    
    let memory_gb = {
        use sysinfo::System;
        let sys = System::new_all();
        sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0)
    };
    
    let displays = get_display_info().await;
    let cameras = get_camera_list().await;
    let microphones = get_microphone_list().await;

    Ok(SystemInfo {
        os,
        os_version,
        arch,
        cpu_cores,
        memory_gb,
        displays,
        cameras,
        microphones,
    })
}

async fn get_display_info() -> Vec<DisplayInfo> {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::display::CGDisplay;
        CGDisplay::active_displays()
            .map(|displays| {
                displays
                    .into_iter()
                    .map(|display_id| {
                        let display = CGDisplay::new(display_id);
                        let bounds = display.bounds();
                        DisplayInfo {
                            width: bounds.size.width as u32,
                            height: bounds.size.height as u32,
                            scale_factor: 1.0,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        vec![DisplayInfo {
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
        }]
    }
}

async fn get_camera_list() -> Vec<String> {
    let cameras = crate::recording::list_cameras();
    cameras.into_iter().map(|c| c.display_name().to_string()).collect()
}

async fn get_microphone_list() -> Vec<String> {
    match crate::list_audio_devices().await {
        Ok(devices) => devices,
        Err(_) => vec!["Unable to query microphones".to_string()],
    }
}

pub async fn get_recent_recording_logs(app: &AppHandle, count: usize) -> Result<Vec<RecordingLog>, String> {
    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");
    
    if !recordings_dir.exists() {
        return Ok(vec![]);
    }

    let mut recordings: Vec<(PathBuf, std::time::SystemTime)> = vec![];
    
    if let Ok(entries) = fs::read_dir(&recordings_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        recordings.push((path, modified));
                    }
                }
            }
        }
    }
    
    recordings.sort_by(|a, b| b.1.cmp(&a.1));
    recordings.truncate(count);
    
    let mut logs = vec![];
    
    for (recording_path, _) in recordings {
        let recording_id = recording_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        
        let meta_path = recording_path.join("recording-meta.json");
        let log_path = recording_path.join("recording-logs.log");
        
        let mut log = RecordingLog {
            id: recording_id.clone(),
            timestamp: chrono::Local::now().to_rfc3339(),
            duration_seconds: None,
            error: None,
            log_content: None,
            log_file_path: None,
        };
        
        if meta_path.exists() {
            if let Ok(meta_content) = fs::read_to_string(&meta_path) {
                if let Ok(meta_json) = serde_json::from_str::<serde_json::Value>(&meta_content) {
                    if let Some(duration) = meta_json.get("duration").and_then(|d| d.as_f64()) {
                        log.duration_seconds = Some(duration);
                    }
                    if let Some(timestamp) = meta_json.get("timestamp").and_then(|t| t.as_str()) {
                        log.timestamp = timestamp.to_string();
                    }
                }
            }
        }
        
        if log_path.exists() {
            log.log_file_path = Some(log_path.to_string_lossy().to_string());
        }
        
        logs.push(log);
    }
    
    Ok(logs)
}

#[tauri::command]
#[specta::specta]
pub async fn get_logs_and_system_info(app: AppHandle) -> Result<LogsAndSystemInfo, String> {
    let system_info = get_system_info().await?;
    let recent_logs = get_recent_recording_logs(&app, 3).await?;
    let app_version = app.package_info().version.to_string();
    
    Ok(LogsAndSystemInfo {
        system_info,
        recent_logs,
        app_version,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LogFile {
    pub name: String,
    pub content: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_log_files(paths: Vec<String>) -> Result<Vec<LogFile>, String> {
    let mut log_files = vec![];
    
    for path_str in paths {
        let path = PathBuf::from(&path_str);
        if path.exists() {
            if let Ok(content) = fs::read(&path) {
                let base64_content = base64::prelude::BASE64_STANDARD.encode(&content);
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("recording.log")
                    .to_string();
                
                let parent_dir_name = path
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown");
                    
                let full_name = format!("{}/{}", parent_dir_name, file_name);
                
                log_files.push(LogFile {
                    name: full_name,
                    content: base64_content,
                });
            }
        }
    }
    
    Ok(log_files)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LastRecording {
    pub name: String,
    pub content: String,
    pub size_mb: f64,
}

#[tauri::command]
#[specta::specta]
pub async fn get_recording_zip(app: AppHandle, recording_path: Option<String>) -> Result<Option<LastRecording>, String> {
    let recording_path = if let Some(path) = recording_path {
        PathBuf::from(path)
    } else {
        // If no path provided, get the last recording
        let recordings_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("recordings");
        
        if !recordings_dir.exists() {
            return Ok(None);
        }

        // Find the most recent recording directory
        let mut recordings: Vec<(PathBuf, std::time::SystemTime)> = vec![];
        
        if let Ok(entries) = fs::read_dir(&recordings_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.extension().and_then(|s| s.to_str()) == Some("cap") {
                    if let Ok(metadata) = entry.metadata() {
                        if let Ok(modified) = metadata.modified() {
                            recordings.push((path, modified));
                        }
                    }
                }
            }
        }
        
        if recordings.is_empty() {
            return Ok(None);
        }
        
        // Sort by modification time, most recent first
        recordings.sort_by(|a, b| b.1.cmp(&a.1));
        recordings[0].0.clone()
    };
    
    if !recording_path.exists() {
        return Err(format!("Recording path does not exist: {:?}", recording_path));
    }
    
    // Create a zip file in memory
    let mut zip_buffer = Vec::new();
    {
        let mut zip = ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
        let options = FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o755);
        
        // Add all files from the recording directory to the zip
        add_dir_to_zip(&mut zip, &recording_path, "", &options)?;
        
        zip.finish().map_err(|e| format!("Failed to finish zip: {}", e))?;
    }
    
    let size_mb = zip_buffer.len() as f64 / (1024.0 * 1024.0);
    
    let recording_name = recording_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("recording")
        .to_string();
    
    Ok(Some(LastRecording {
        name: format!("{}.zip", recording_name),
        content: base64::prelude::BASE64_STANDARD.encode(&zip_buffer),
        size_mb,
    }))
}

#[tauri::command]
#[specta::specta]
pub async fn get_last_recording_zip(app: AppHandle) -> Result<Option<LastRecording>, String> {
    get_recording_zip(app, None).await
}

fn add_dir_to_zip<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    dir_path: &PathBuf,
    prefix: &str,
    options: &FileOptions,
) -> Result<(), String> {
    let entries = fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;
    
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;
        
        let zip_path = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", prefix, name)
        };
        
        if path.is_dir() {
            // Add directory to zip
            zip.add_directory(&zip_path, *options)
                .map_err(|e| format!("Failed to add directory to zip: {}", e))?;
            
            // Recursively add directory contents
            add_dir_to_zip(zip, &path, &zip_path, options)?;
        } else {
            // Add file to zip
            zip.start_file(&zip_path, *options)
                .map_err(|e| format!("Failed to start file in zip: {}", e))?;
            
            let mut file = fs::File::open(&path)
                .map_err(|e| format!("Failed to open file: {}", e))?;
            
            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)
                .map_err(|e| format!("Failed to read file: {}", e))?;
            
            zip.write_all(&buffer)
                .map_err(|e| format!("Failed to write file to zip: {}", e))?;
        }
    }
    
    Ok(())
}