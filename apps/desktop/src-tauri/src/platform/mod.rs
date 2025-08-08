use serde::{Deserialize, Serialize};
use specta::Type;
#[cfg(target_os = "windows")]
pub mod win;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use macos::*;

#[derive(Debug, Serialize, Deserialize, Type, Default)]
#[repr(isize)]
pub enum HapticPattern {
    Alignment = 0,
    LevelChange = 1,
    #[default]
    Generic = 2,
}

#[derive(Debug, Serialize, Deserialize, Type, Default)]
#[repr(usize)]
pub enum HapticPerformanceTime {
    Default = 0,
    #[default]
    Now = 1,
    DrawCompleted = 2,
}

#[tauri::command]
#[specta::specta]
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
