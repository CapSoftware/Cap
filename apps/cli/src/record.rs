use cap_recording::{screen_capture::ScreenCaptureTarget, studio_recording};
use clap::Args;
use scap_targets::{DisplayId, WindowId};
use std::{env::current_dir, path::PathBuf, process};

use crate::config::{CliSettings, ResolvedSettings};
use tokio::io::AsyncBufReadExt;
use uuid::Uuid;

use crate::daemon::{
    client as daemon_client, protocol::DaemonResponse, server::RecordingDaemon,
    state::RecordingState,
};

#[derive(Args)]
pub struct RecordStart {
    #[command(flatten)]
    target: RecordTargets,
    #[arg(long)]
    camera: Option<String>,
    #[arg(long)]
    mic: Option<u32>,
    #[arg(long)]
    system_audio: bool,
    #[arg(long)]
    path: Option<PathBuf>,
    #[arg(long)]
    fps: Option<u32>,
    #[arg(long, conflicts_with = "no_auto_zoom")]
    auto_zoom: bool,
    #[arg(long, conflicts_with = "auto_zoom")]
    no_auto_zoom: bool,
    #[arg(long, conflicts_with = "no_capture_keys")]
    capture_keys: bool,
    #[arg(long, conflicts_with = "capture_keys")]
    no_capture_keys: bool,
    #[arg(long = "exclude")]
    exclude_windows: Vec<String>,
}

impl RecordStart {
    fn override_settings(&self) -> CliSettings {
        let auto_zoom = if self.auto_zoom {
            Some(true)
        } else if self.no_auto_zoom {
            Some(false)
        } else {
            None
        };

        let capture_keys = if self.capture_keys {
            Some(true)
        } else if self.no_capture_keys {
            Some(false)
        } else {
            None
        };

        CliSettings {
            auto_zoom_on_clicks: auto_zoom,
            capture_keyboard_events: capture_keys,
            max_fps: self.fps,
            excluded_windows: if self.exclude_windows.is_empty() {
                None
            } else {
                Some(self.exclude_windows.clone())
            },
        }
    }
}

impl RecordStart {
    pub async fn run(self) -> Result<(), String> {
        let overrides = self.override_settings();
        let settings = ResolvedSettings::resolve_with_tauri(&overrides);

        let target_info = match (self.target.screen, self.target.window) {
            (Some(id), _) => cap_recording::screen_capture::list_displays()
                .into_iter()
                .find(|s| s.0.id == id)
                .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                .ok_or(format!("Screen with id '{id}' not found")),
            (_, Some(id)) => cap_recording::screen_capture::list_windows()
                .into_iter()
                .find(|s| s.0.id == id)
                .map(|(s, _)| ScreenCaptureTarget::Window { id: s.id })
                .ok_or(format!("Window with id '{id}' not found")),
            _ => Err("No target specified".to_string()),
        }?;

        let id = Uuid::new_v4().to_string();
        let path = self
            .path
            .unwrap_or_else(|| current_dir().unwrap().join(format!("{id}.cap")));

        let handle = studio_recording::Actor::builder(path.clone(), target_info)
            .with_system_audio(self.system_audio)
            .with_custom_cursor(false)
            .with_max_fps(settings.max_fps)
            .with_keyboard_capture(settings.capture_keyboard_events)
            .build(
                #[cfg(target_os = "macos")]
                Some(cap_recording::SendableShareableContent::from(
                    cidre::sc::ShareableContent::current().await.unwrap(),
                )),
            )
            .await
            .map_err(|e| e.to_string())?;

        println!("Recording starting, press Enter to stop");

        tokio::io::BufReader::new(tokio::io::stdin())
            .read_line(&mut String::new())
            .await
            .unwrap();

        handle.stop().await.map_err(|e| e.to_string())?;

        Ok(())
    }
}

pub async fn start_daemon(args: RecordStart, json: bool) -> Result<(), String> {
    if let Some(existing) = RecordingState::load()? {
        if existing.is_process_alive() {
            return Err(
                "A recording is already in progress. Run \"cap record stop\" first.".to_string(),
            );
        }
        RecordingState::remove()?;
    }

    let target_info = match (args.target.screen, args.target.window) {
        (Some(id), _) => cap_recording::screen_capture::list_displays()
            .into_iter()
            .find(|s| s.0.id == id)
            .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
            .ok_or(format!("Screen with id '{id}' not found")),
        (_, Some(id)) => cap_recording::screen_capture::list_windows()
            .into_iter()
            .find(|s| s.0.id == id)
            .map(|(s, _)| ScreenCaptureTarget::Window { id: s.id })
            .ok_or(format!("Window with id '{id}' not found")),
        _ => Err("No target specified. Use --screen ID or --window ID.".to_string()),
    }?;

    let recording_id = Uuid::new_v4().to_string();
    let project_path = args
        .path
        .unwrap_or_else(|| current_dir().unwrap().join(format!("{recording_id}.cap")));

    let screen_label = match &target_info {
        ScreenCaptureTarget::Display { id } => Some(id.to_string()),
        ScreenCaptureTarget::Window { id } => Some(id.to_string()),
        _ => None,
    };

    let overrides = args.override_settings();
    let settings = ResolvedSettings::resolve_with_tauri(&overrides);

    let handle = studio_recording::Actor::builder(project_path.clone(), target_info)
        .with_system_audio(args.system_audio)
        .with_custom_cursor(false)
        .with_max_fps(settings.max_fps)
        .with_keyboard_capture(settings.capture_keyboard_events)
        .build(
            #[cfg(target_os = "macos")]
            Some(cap_recording::SendableShareableContent::from(
                cidre::sc::ShareableContent::current().await.unwrap(),
            )),
        )
        .await
        .map_err(|e| e.to_string())?;

    let state = RecordingState {
        pid: process::id(),
        recording_id: recording_id.clone(),
        project_path: project_path.clone(),
        started_at: chrono::Utc::now().to_rfc3339(),
        screen: screen_label,
    };
    state.save()?;

    if json {
        println!(
            "{}",
            serde_json::json!({
                "status": "recording",
                "recording_id": recording_id,
                "project_path": project_path.display().to_string(),
            })
        );
    } else {
        eprintln!("Recording started (id: {recording_id})");
        eprintln!("Project: {}", project_path.display());
        eprintln!("Stop with: cap record stop");
    }

    let daemon = RecordingDaemon::new(handle, state);
    daemon.run().await?;

    Ok(())
}

pub async fn stop_recording(json: bool) -> Result<(), String> {
    let state = RecordingState::load()?.ok_or("No active recording found.")?;

    if !state.is_process_alive() {
        RecordingState::remove()?;
        return Err("Recording process is no longer running. State cleaned up.".to_string());
    }

    let response = daemon_client::stop_recording().await?;

    match response {
        DaemonResponse::Ok {
            project_path,
            duration_secs,
        } => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "status": "stopped",
                        "project_path": project_path,
                        "duration_secs": duration_secs,
                    })
                );
            } else {
                if let Some(dur) = duration_secs {
                    let mins = dur as u64 / 60;
                    let secs = dur as u64 % 60;
                    eprintln!("Recording stopped (duration: {mins}m {secs}s)");
                } else {
                    eprintln!("Recording stopped.");
                }
                eprintln!("Project: {project_path}");
            }
        }
        DaemonResponse::Error { message } => {
            return Err(format!("Stop failed: {message}"));
        }
        DaemonResponse::Recording { .. } => {
            return Err("Unexpected response from daemon".to_string());
        }
    }

    Ok(())
}

pub async fn recording_status(json: bool) -> Result<(), String> {
    let state = RecordingState::load()?;

    let Some(state) = state else {
        if json {
            println!("{}", serde_json::json!({"status": "idle"}));
        } else {
            eprintln!("No active recording.");
        }
        return Ok(());
    };

    if !state.is_process_alive() {
        RecordingState::remove()?;
        if json {
            println!(
                "{}",
                serde_json::json!({"status": "idle", "note": "stale state cleaned up"})
            );
        } else {
            eprintln!("No active recording (cleaned up stale state).");
        }
        return Ok(());
    }

    match daemon_client::get_status().await {
        Ok(DaemonResponse::Recording {
            duration_secs,
            project_path,
            screen,
        }) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "status": "recording",
                        "duration_secs": duration_secs,
                        "project_path": project_path,
                        "screen": screen,
                    })
                );
            } else {
                let mins = duration_secs as u64 / 60;
                let secs = duration_secs as u64 % 60;
                eprintln!("Recording in progress ({mins}m {secs}s)");
                eprintln!("Project: {project_path}");
                if let Some(scr) = screen {
                    eprintln!("Screen: {scr}");
                }
            }
        }
        Ok(other) => {
            if json {
                println!("{}", serde_json::to_string(&other).unwrap());
            } else {
                eprintln!("Unexpected status: {other:?}");
            }
        }
        Err(e) => {
            return Err(format!("Failed to query daemon: {e}"));
        }
    }

    Ok(())
}

#[derive(Args)]
struct RecordTargets {
    #[arg(long, group = "target")]
    screen: Option<DisplayId>,
    #[arg(long, group = "target")]
    window: Option<WindowId>,
}
