//! Real device enumeration for the capture-target and device pickers.
//!
//! Everything here goes through the same crates the recorder uses
//! (`cap-camera`, `scap-targets`, and the Cap `cpal` fork) so the identities the
//! UI hands back — camera `device_id`, microphone name, `DisplayId`, `WindowId`
//! — are byte-identical to what `cap-recording` expects to be given. Nothing is
//! re-derived or prettified into a new identity space.

use cpal::traits::{DeviceTrait, HostTrait};
use scap_targets::{Display, DisplayId, Window, WindowId};

/// A camera, identified the way `cap-recording` identifies one.
#[derive(Debug, Clone, PartialEq)]
pub struct CameraOption {
    pub device_id: String,
    pub label: String,
}

/// A microphone. cpal has no stable id, so the name *is* the identity — which is
/// also exactly what `MicrophoneFeed::list()` keys its map on.
#[derive(Debug, Clone, PartialEq)]
pub struct MicrophoneOption {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisplayOption {
    pub id: DisplayId,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowOption {
    pub id: WindowId,
    /// The window's own title.
    pub label: String,
    /// Owning application, shown as the secondary line.
    pub app: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeviceSnapshot {
    pub cameras: Vec<CameraOption>,
    pub microphones: Vec<MicrophoneOption>,
    pub displays: Vec<DisplayOption>,
    pub windows: Vec<WindowOption>,
}

impl DeviceSnapshot {
    /// Enumerate everything. This blocks — AVFoundation camera discovery and the
    /// window-server queries are both slow enough to drop frames — so callers
    /// should run it on the background executor, never inside `render`.
    pub fn enumerate() -> Self {
        Self {
            cameras: list_cameras(),
            microphones: list_microphones(),
            displays: list_displays(),
            windows: list_windows(),
        }
    }
}

fn list_cameras() -> Vec<CameraOption> {
    cap_camera::list_cameras()
        .map(|camera| CameraOption {
            device_id: camera.device_id().to_string(),
            label: camera.display_name().to_string(),
        })
        .collect()
}

/// Mirrors `MicrophoneFeed::list_with_settings`: the default input device is
/// inserted first so it heads the list, then every other input device is
/// appended, deduped by name.
fn list_microphones() -> Vec<MicrophoneOption> {
    let host = cpal::default_host();
    let mut names: Vec<String> = Vec::new();

    if let Some(name) = host
        .default_input_device()
        .and_then(|device| device.name().ok())
    {
        names.push(name);
    }

    match host.input_devices() {
        Ok(devices) => {
            for name in devices.filter_map(|device| device.name().ok()) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
        Err(error) => {
            tracing::error!("could not access audio input devices: {error}");
        }
    }

    names
        .into_iter()
        .map(|name| MicrophoneOption { name })
        .collect()
}

fn list_displays() -> Vec<DisplayOption> {
    Display::list()
        .into_iter()
        .map(|display| {
            let id = display.id();
            let label = display
                .name()
                .unwrap_or_else(|| format!("Display {}", &id));
            DisplayOption { id, label }
        })
        .collect()
}

/// Mirrors the picker path of `cap_recording::sources::screen_capture::list_windows`
/// (i.e. `include_accessory_panels: false`), which collapses to: a non-empty
/// title, not owned by the Window Server, and at window level 0.
///
/// The level check is what actually matters. A raw `Window::list()` on macOS is
/// dominated by menu-bar extras and status items — Control Centre alone
/// contributes a dozen `Item-0` windows at level 25 — so without it the picker
/// is unusable. This is deliberately duplicated rather than imported:
/// `cap-recording` drags in ffmpeg and the whole encode stack, which this app
/// has no other reason to build.
fn list_windows() -> Vec<WindowOption> {
    Window::list()
        .into_iter()
        .filter_map(|window| {
            let label = window.name().filter(|name| !name.trim().is_empty())?;
            let app = window.owner_name()?;

            if app == "Window Server" {
                return None;
            }

            #[cfg(target_os = "macos")]
            if window.raw_handle().level() != Some(0) {
                return None;
            }

            Some(WindowOption {
                id: window.id(),
                label,
                app,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test for the real enumeration path. Displays are the only thing we
    /// can assert on unconditionally — a machine running this test has at least
    /// one screen, but it may genuinely have no camera and no microphone, and on
    /// a fresh machine the TCC prompt for camera access has not been answered
    /// yet. The rest is printed for eyeballing with `--nocapture`.
    #[test]
    fn enumerates_real_devices() {
        let snapshot = DeviceSnapshot::enumerate();

        println!("cameras ({}):", snapshot.cameras.len());
        for camera in &snapshot.cameras {
            println!("  {} [{}]", camera.label, camera.device_id);
        }
        println!("microphones ({}):", snapshot.microphones.len());
        for mic in &snapshot.microphones {
            println!("  {}", mic.name);
        }
        println!("displays ({}):", snapshot.displays.len());
        for display in &snapshot.displays {
            println!("  {} [{}]", display.label, display.id);
        }
        println!("windows ({}):", snapshot.windows.len());
        for window in snapshot.windows.iter().take(10) {
            println!("  {} — {} [{}]", window.app, window.label, window.id);
        }

        assert!(
            !snapshot.displays.is_empty(),
            "expected at least one display"
        );
        assert!(
            snapshot.windows.iter().all(|w| !w.label.trim().is_empty()),
            "untitled windows should have been filtered out"
        );
    }
}
