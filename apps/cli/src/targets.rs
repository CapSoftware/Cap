use scap_targets::{DisplayId, WindowId};
use serde::Serialize;

use crate::{OutputFormat, write_json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenTarget {
    pub index: usize,
    pub id: DisplayId,
    pub name: String,
    pub fps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_rate: Option<f64>,
    pub primary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical_size: Option<Size>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_size: Option<Size>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTarget {
    pub index: usize,
    pub id: WindowId,
    pub name: String,
    pub owner_name: String,
    pub fps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraTarget {
    pub index: usize,
    pub device_id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicTarget {
    pub index: usize,
    /// Device name; this is the value `cap record --mic <name>` expects.
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllTargets {
    pub screens: Vec<ScreenTarget>,
    pub windows: Vec<WindowTarget>,
    pub cameras: Vec<CameraTarget>,
    pub mics: Vec<MicTarget>,
}

pub fn screens() -> Vec<ScreenTarget> {
    let primary_id = scap_targets::Display::primary().id();

    cap_recording::screen_capture::list_displays()
        .into_iter()
        .enumerate()
        .map(|(index, (screen, handle))| ScreenTarget {
            index,
            primary: screen.id == primary_id,
            id: screen.id,
            name: screen.name,
            fps: screen.refresh_rate,
            refresh_rate: Some(handle.refresh_rate()).filter(|v| v.is_finite() && *v > 0.0),
            physical_size: handle.physical_size().map(|s| Size {
                width: s.width(),
                height: s.height(),
            }),
            logical_size: handle.logical_size().map(|s| Size {
                width: s.width(),
                height: s.height(),
            }),
        })
        .collect()
}

pub fn windows() -> Vec<WindowTarget> {
    cap_recording::screen_capture::list_windows()
        .into_iter()
        .enumerate()
        .map(|(index, (window, _))| {
            let position = window.bounds.position();
            let size = window.bounds.size();
            WindowTarget {
                index,
                id: window.id,
                name: window.name,
                owner_name: window.owner_name,
                fps: window.refresh_rate,
                bundle_identifier: window.bundle_identifier,
                bounds: Some(Bounds {
                    x: position.x(),
                    y: position.y(),
                    width: size.width(),
                    height: size.height(),
                }),
            }
        })
        .collect()
}

pub fn cameras() -> Vec<CameraTarget> {
    cap_camera::list_cameras()
        .enumerate()
        .map(|(index, camera)| CameraTarget {
            index,
            device_id: camera.device_id().to_string(),
            display_name: camera.display_name().to_string(),
            model_id: camera.model_id().map(ToString::to_string),
        })
        .collect()
}

pub fn mics() -> Vec<MicTarget> {
    cap_recording::MicrophoneFeed::list_names()
        .into_iter()
        .enumerate()
        .map(|(index, name)| MicTarget { index, name })
        .collect()
}

pub fn all() -> AllTargets {
    AllTargets {
        screens: screens(),
        windows: windows(),
        cameras: cameras(),
        mics: mics(),
    }
}

pub fn print_all(format: OutputFormat) -> Result<(), String> {
    let targets = all();
    match format {
        OutputFormat::Text => {
            print_screen_table(&targets.screens);
            print_window_table(&targets.windows);
            print_camera_table(&targets.cameras);
            print_mic_table(&targets.mics);
            Ok(())
        }
        OutputFormat::Json => write_json(&targets),
    }
}

pub fn print_screens(format: OutputFormat) -> Result<(), String> {
    let screens = screens();
    match format {
        OutputFormat::Text => {
            print_screen_table(&screens);
            Ok(())
        }
        OutputFormat::Json => write_json(&screens),
    }
}

pub fn print_windows(format: OutputFormat) -> Result<(), String> {
    let windows = windows();
    match format {
        OutputFormat::Text => {
            print_window_table(&windows);
            Ok(())
        }
        OutputFormat::Json => write_json(&windows),
    }
}

pub fn print_cameras(format: OutputFormat) -> Result<(), String> {
    let cameras = cameras();
    match format {
        OutputFormat::Text => {
            print_camera_table(&cameras);
            Ok(())
        }
        OutputFormat::Json => write_json(&cameras),
    }
}

pub fn print_mics(format: OutputFormat) -> Result<(), String> {
    let mics = mics();
    match format {
        OutputFormat::Text => {
            print_mic_table(&mics);
            Ok(())
        }
        OutputFormat::Json => write_json(&mics),
    }
}

fn print_screen_table(screens: &[ScreenTarget]) {
    for screen in screens {
        let primary = if screen.primary { " (primary)" } else { "" };
        println!(
            "screen {}:{}\n  id: {}\n  name: {}\n  fps: {}",
            screen.index, primary, screen.id, screen.name, screen.fps
        );
        if let Some(size) = &screen.physical_size {
            println!("  size: {}x{}", size.width as u64, size.height as u64);
        }
    }
}

fn print_window_table(windows: &[WindowTarget]) {
    for window in windows {
        println!(
            "window {}:\n  id: {}\n  name: {}\n  owner: {}\n  fps: {}",
            window.index, window.id, window.name, window.owner_name, window.fps
        );
        if let Some(bundle) = &window.bundle_identifier {
            println!("  bundle: {bundle}");
        }
        if let Some(bounds) = &window.bounds {
            println!(
                "  bounds: {}x{} at ({}, {})",
                bounds.width as i64, bounds.height as i64, bounds.x as i64, bounds.y as i64
            );
        }
    }
}

fn print_camera_table(cameras: &[CameraTarget]) {
    for camera in cameras {
        println!(
            "camera {}:\n  device_id: {}\n  name: {}",
            camera.index, camera.device_id, camera.display_name
        );
        if let Some(model_id) = &camera.model_id {
            println!("  model_id: {model_id}");
        }
    }
}

fn print_mic_table(mics: &[MicTarget]) {
    for mic in mics {
        println!("mic {}:\n  name: {}", mic.index, mic.name);
    }
}
