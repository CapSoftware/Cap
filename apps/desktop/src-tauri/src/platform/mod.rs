use serde::{Deserialize, Serialize};
use specta::Type;
#[cfg(target_os = "windows")]
pub mod win;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "linux")]
pub use linux::*;
use tracing::instrument;

#[derive(Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
#[repr(isize)]
pub enum HapticPattern {
    Alignment = 0,
    LevelChange = 1,
    #[default]
    Generic = 2,
}

#[derive(Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
#[repr(usize)]
pub enum HapticPerformanceTime {
    Default = 0,
    #[default]
    Now = 1,
    DrawCompleted = 2,
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub fn perform_haptic_feedback(
    _pattern: Option<HapticPattern>,
    _time: Option<HapticPerformanceTime>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2_app_kit::{
            NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
            NSHapticFeedbackPerformer,
        };

        NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(
            NSHapticFeedbackPattern(_pattern.unwrap_or_default() as isize),
            NSHapticFeedbackPerformanceTime(_time.unwrap_or_default() as usize),
        );
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    Err("Haptics are only supported on macOS.".into())
}

/// Check if system audio capture is supported on the current platform and OS version.
/// On macOS, system audio capture requires macOS 13.0 or later.
/// On Windows/Linux, this may have different requirements.
#[tauri::command]
#[specta::specta]
#[instrument]
pub fn is_system_audio_capture_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        scap_screencapturekit::is_system_audio_supported()
    }

    #[cfg(not(target_os = "macos"))]
    {
        // On Windows/Linux, we assume system audio capture is available
        // This can be refined later based on platform-specific requirements
        true
    }
}
