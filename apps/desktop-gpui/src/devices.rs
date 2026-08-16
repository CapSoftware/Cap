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
    /// Highest-resolution format the device advertises, shown as the row's
    /// subtitle. `None` when the device reports no formats.
    pub best_format: Option<CameraFormat>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraFormat {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
}

impl CameraFormat {
    /// Matches the web UI: `1920×1080 @ 30fps`.
    pub fn describe(&self) -> String {
        format!(
            "{}×{} @ {}fps",
            self.width,
            self.height,
            self.frame_rate.round() as u32
        )
    }
}

/// A microphone. cpal has no stable id, so the name *is* the identity — which is
/// also exactly what `MicrophoneFeed::list()` keys its map on.
#[derive(Debug, Clone, PartialEq)]
pub struct MicrophoneOption {
    pub name: String,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
}

impl MicrophoneOption {
    /// Matches the web UI: `48kHz Stereo`.
    pub fn describe(&self) -> Option<String> {
        let sample_rate = self.sample_rate?;
        let khz = sample_rate as f32 / 1000.;
        let layout = match self.channels {
            Some(1) => "Mono".to_string(),
            Some(2) => "Stereo".to_string(),
            Some(n) => format!("{n}ch"),
            None => return Some(format!("{khz}kHz")),
        };
        Some(format!("{khz}kHz {layout}"))
    }
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
        .map(|camera| {
            // Highest resolution first, then highest frame rate at that
            // resolution -- the same ordering the web UI's `bestFormat` uses.
            let best_format = camera.formats().and_then(|formats| {
                formats
                    .into_iter()
                    .max_by(|a, b| {
                        (a.width() * a.height())
                            .cmp(&(b.width() * b.height()))
                            .then(a.frame_rate().total_cmp(&b.frame_rate()))
                    })
                    .map(|format| CameraFormat {
                        width: format.width(),
                        height: format.height(),
                        frame_rate: format.frame_rate(),
                    })
            });

            CameraOption {
                device_id: camera.device_id().to_string(),
                label: camera.display_name().to_string(),
                best_format,
            }
        })
        .collect()
}

/// Mirrors `MicrophoneFeed::list_with_settings`: the default input device is
/// inserted first so it heads the list, then every other input device is
/// appended, deduped by name.
fn list_microphones() -> Vec<MicrophoneOption> {
    let host = cpal::default_host();
    let mut mics: Vec<MicrophoneOption> = Vec::new();

    let mut push = |device: cpal::Device| {
        let Ok(name) = device.name() else { return };
        if mics.iter().any(|mic| mic.name == name) {
            return;
        }

        // `default_input_config` is the config the device would actually be
        // opened with, which is what the row should describe.
        let config = device.default_input_config().ok();
        mics.push(MicrophoneOption {
            name,
            sample_rate: config.as_ref().map(|config| config.sample_rate().0),
            channels: config.as_ref().map(|config| config.channels()),
        });
    };

    if let Some(device) = host.default_input_device() {
        push(device);
    }

    match host.input_devices() {
        Ok(devices) => {
            for device in devices {
                push(device);
            }
        }
        Err(error) => {
            tracing::error!("could not access audio input devices: {error}");
        }
    }

    mics
}

fn list_displays() -> Vec<DisplayOption> {
    Display::list()
        .into_iter()
        .map(|display| {
            let id = display.id();
            let label = display.name().unwrap_or_else(|| format!("Display {}", id));
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
            println!(
                "  {} [{}] {}",
                camera.label,
                camera.device_id,
                camera
                    .best_format
                    .map(|format| format.describe())
                    .unwrap_or_else(|| "<no formats>".into())
            );
        }
        println!("microphones ({}):", snapshot.microphones.len());
        for mic in &snapshot.microphones {
            println!(
                "  {} {}",
                mic.name,
                mic.describe().unwrap_or_else(|| "<no config>".into())
            );
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
