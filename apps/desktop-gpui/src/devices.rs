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
    pub model_id: Option<cap_camera::ModelID>,
    pub label: String,
    /// Highest-resolution format the device advertises, shown as the row's
    /// subtitle. `None` when the device reports no formats.
    pub best_format: Option<CameraFormat>,
    pub formats: Vec<CameraFormat>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraFormat {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
}

impl CameraFormat {
    pub fn settings(self) -> cap_recording::feeds::camera::CameraDeviceSettings {
        cap_recording::feeds::camera::CameraDeviceSettings {
            width: Some(self.width),
            height: Some(self.height),
            frame_rate: Some(self.frame_rate),
        }
    }

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
    pub refresh_rate: f64,
}

impl DisplayOption {
    /// `formatRefreshRate`: `60 Hz`, or nothing when the display does not
    /// report one.
    pub fn describe_refresh_rate(&self) -> Option<String> {
        (self.refresh_rate > 0.).then(|| format!("{} Hz", self.refresh_rate.round() as u32))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowOption {
    pub id: WindowId,
    /// The window's own title.
    pub label: String,
    /// Owning application, shown as the secondary line.
    pub app: String,
    pub size: Option<(u32, u32)>,
    /// Display-relative logical origin. Nothing renders it -- it is here
    /// because `createWindowSignature` (`new-main/index.tsx:376-398`) joins
    /// `position.x`/`position.y` into the signature the thumbnail refresh
    /// compares, so a window that is dragged without being resized has to
    /// invalidate its thumbnail. See `target_thumbnails::window_signature`.
    pub position: Option<(f64, f64)>,
    pub refresh_rate: Option<f64>,
}

impl WindowOption {
    /// The card's third line. The Tauri card joins resolution and refresh rate
    /// with `@` when it has both and falls back to whichever it has:
    /// `1920×1080 @ 60 Hz`. Note the multiplication sign, not a letter x.
    pub fn describe_metadata(&self) -> Option<String> {
        let resolution = self
            .size
            .filter(|(width, height)| *width > 0 && *height > 0)
            .map(|(width, height)| format!("{width}×{height}"));
        let refresh = self
            .refresh_rate
            .filter(|rate| *rate > 0.)
            .map(|rate| format!("{} Hz", rate.round() as u32));

        match (resolution, refresh) {
            (Some(resolution), Some(refresh)) => Some(format!("{resolution} @ {refresh}")),
            (Some(only), None) | (None, Some(only)) => Some(only),
            (None, None) => None,
        }
    }
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

/// Just the capture targets.
///
/// The Tauri app keeps these on their own queries (`listScreens` /
/// `listWindows` in `utils/queries.ts:29-52`), separate from the device query,
/// precisely so the window list can be re-read every few seconds while a
/// picker is open without paying for another AVFoundation camera scan. The
/// split exists here for the same reason: `DeviceSnapshot::enumerate` is the
/// once-at-launch call, this is the one the picker's refresh loop runs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TargetSnapshot {
    pub displays: Vec<DisplayOption>,
    pub windows: Vec<WindowOption>,
}

impl TargetSnapshot {
    /// Blocking window-server queries, same rule as `DeviceSnapshot::enumerate`:
    /// background executor or a tokio worker, never `render`.
    pub fn enumerate() -> Self {
        Self {
            displays: list_displays(),
            windows: list_windows(),
        }
    }
}

fn list_cameras() -> Vec<CameraOption> {
    cap_camera::list_cameras()
        .map(|camera| {
            let mut formats = camera
                .formats()
                .unwrap_or_default()
                .into_iter()
                .map(|format| CameraFormat {
                    width: format.width(),
                    height: format.height(),
                    frame_rate: format.frame_rate(),
                })
                .collect::<Vec<_>>();
            let mut seen = std::collections::HashSet::new();
            formats.retain(|format| {
                seen.insert((
                    format.width,
                    format.height,
                    format.frame_rate.round() as u32,
                ))
            });
            formats.sort_by(|a, b| {
                (b.width * b.height)
                    .cmp(&(a.width * a.height))
                    .then(b.frame_rate.total_cmp(&a.frame_rate))
            });
            let best_format = formats.first().copied();

            CameraOption {
                device_id: camera.device_id().to_string(),
                model_id: camera.model_id().cloned(),
                label: camera.display_name().to_string(),
                best_format,
                formats,
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

pub fn microphone_formats(
    name: &str,
) -> Result<Vec<cap_recording::feeds::microphone::MicrophoneDeviceSettings>, String> {
    let devices = cap_recording::feeds::microphone::MicrophoneFeed::list();
    let (device, _) = devices
        .get(name)
        .ok_or_else(|| format!("Microphone '{name}' is no longer available"))?;
    let configs = device
        .supported_input_configs()
        .map_err(|error| format!("Could not read microphone formats: {error}"))?;
    let mut formats = std::collections::BTreeSet::new();
    for config in configs {
        if cap_media_info::ffmpeg_sample_format_for(config.sample_format()).is_none() {
            continue;
        }
        for sample_rate in [
            config.min_sample_rate().0,
            44_100,
            48_000,
            96_000,
            config.max_sample_rate().0,
        ] {
            if (config.min_sample_rate().0..=config.max_sample_rate().0).contains(&sample_rate) {
                formats.insert((sample_rate, config.channels()));
            }
        }
    }
    Ok(formats
        .into_iter()
        .rev()
        .map(
            |(sample_rate, channels)| cap_recording::feeds::microphone::MicrophoneDeviceSettings {
                sample_rate: Some(sample_rate),
                channels: Some(channels),
            },
        )
        .collect())
}

/// `Window::get_topmost_at_cursor`, minus this process's own windows: the
/// same level-≤5 filter and descending-level (stable, so front-to-back within
/// a level) pick, transcribed from `scap-targets/src/platform/macos.rs`, with
/// an owner-pid skip added. The overlay's hover highlight and the
/// window-screenshot hotkey fall *through* a cap window to whatever sits
/// beneath it -- the Tauri poll gets the same effect from
/// `should_skip_window` (`target_select_overlay.rs:186-196`).
#[cfg(target_os = "macos")]
pub fn topmost_foreign_window_at_cursor() -> Option<Window> {
    let own_pid = std::process::id() as i32;
    let mut candidates = Window::list_containing_cursor()
        .into_iter()
        .filter_map(|window| {
            let level = window.raw_handle().level()?;
            if level > 5 {
                return None;
            }
            if window.raw_handle().owner_pid() == Some(own_pid) {
                return None;
            }
            Some((window, level))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, level)| std::cmp::Reverse(*level));
    candidates.into_iter().next().map(|(window, _)| window)
}

#[cfg(not(target_os = "macos"))]
pub fn topmost_foreign_window_at_cursor() -> Option<Window> {
    Window::get_topmost_at_cursor()
}

pub fn list_displays() -> Vec<DisplayOption> {
    list_display_targets()
        .into_iter()
        .map(|(option, _)| option)
        .collect()
}

/// The same enumeration, keeping the `scap-targets` handle alongside each row.
///
/// `collect_displays_with_thumbnails` (`src-tauri/src/thumbnails/mod.rs:88-105`)
/// iterates `list_displays()`'s `(CaptureDisplay, Display)` pairs so the
/// capture and the row it fills come from one pass. Re-deriving the handle from
/// the id later would mean a second full `Display::list()` per target.
pub fn list_display_targets() -> Vec<(DisplayOption, Display)> {
    Display::list()
        .into_iter()
        .map(|display| {
            let id = display.id();
            let label = display.name().unwrap_or_else(|| format!("Display {}", id));
            (
                DisplayOption {
                    id,
                    label,
                    refresh_rate: display.refresh_rate(),
                },
                display,
            )
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
pub fn list_windows() -> Vec<WindowOption> {
    list_window_targets()
        .into_iter()
        .map(|(option, _)| option)
        .collect()
}

/// The same enumeration, keeping the `scap-targets` handle alongside each row —
/// the window twin of `list_display_targets`, for
/// `collect_windows_with_thumbnails` (`thumbnails/mod.rs:107-137`), which needs
/// the handle for both the ScreenCaptureKit filter and `Window::app_icon()`.
pub fn list_window_targets() -> Vec<(WindowOption, Window)> {
    Window::list()
        .into_iter()
        .filter_map(|window| {
            let label = window.name().filter(|name| !name.trim().is_empty())?;
            let app = window.owner_name()?;

            if app == "Window Server" {
                return None;
            }

            // Our own windows never belong in the picker: the recording flow
            // excludes them from the capture filter anyway
            // (`app_windows::begin_recording`), so offering one as a target
            // records a hole. Matched by owner pid rather than title or
            // bundle id -- the dev binary is unbundled, and most of our
            // windows carry no CG title at all. (The shared
            // `screen_capture::list_windows` has no such filter; the Tauri
            // main window only escapes it by being a level>0 panel.)
            #[cfg(target_os = "macos")]
            if window.raw_handle().owner_pid() == Some(std::process::id() as i32) {
                return None;
            }

            #[cfg(target_os = "macos")]
            if window.raw_handle().level() != Some(0) {
                return None;
            }

            Some((
                WindowOption {
                    id: window.id(),
                    label,
                    app,
                    size: window
                        .logical_size()
                        .map(|size| (size.width() as u32, size.height() as u32)),
                    position: window
                        .display_relative_logical_bounds()
                        .map(|bounds| (bounds.position().x(), bounds.position().y())),
                    refresh_rate: window.display().map(|display| display.refresh_rate()),
                },
                window,
            ))
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

    /// The thumbnail sweep enumerates through the `*_targets` pairs so it can
    /// keep the `scap-targets` handle, while the picker's cheap poll goes
    /// through the plain lists. If those two ever diverged the cards and their
    /// thumbnails would be describing different windows.
    #[test]
    fn paired_listings_agree_with_the_plain_ones() {
        let displays = list_displays();
        let paired: Vec<_> = list_display_targets()
            .into_iter()
            .map(|(option, _)| option)
            .collect();
        assert_eq!(displays.len(), paired.len());
        assert_eq!(
            displays
                .iter()
                .map(|d| d.id.to_string())
                .collect::<Vec<_>>(),
            paired.iter().map(|d| d.id.to_string()).collect::<Vec<_>>(),
        );

        // Window lists race real window-server state between the two calls, so
        // only the shape is assertable: both go through `list_window_targets`,
        // and every row must carry the position the refresh signature needs.
        let windows = list_window_targets();
        assert!(
            windows
                .iter()
                .all(|(option, handle)| option.id == handle.id()),
            "each row must be paired with its own handle"
        );
        assert!(
            windows.iter().any(|(option, _)| option.position.is_some()) || windows.is_empty(),
            "display-relative bounds should resolve for at least one window"
        );
    }

    #[test]
    fn target_snapshot_is_the_display_and_window_half_of_a_device_snapshot() {
        let targets = TargetSnapshot::enumerate();
        assert!(
            !targets.displays.is_empty(),
            "expected at least one display"
        );
    }
}
