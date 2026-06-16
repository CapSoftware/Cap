use crate::{StudioQuality, studio_recording};

pub const FREE_INSTANT_MODE_MAX_RESOLUTION: u32 = 1280;
pub const PRO_INSTANT_MODE_MAX_RESOLUTION: u32 = 1920;
pub const DEFAULT_INSTANT_MODE_MAX_RESOLUTION: u32 = PRO_INSTANT_MODE_MAX_RESOLUTION;
pub const DEFAULT_STUDIO_MAX_FPS: u32 = 60;
pub const CAMERA_ACTIVE_STUDIO_MAX_FPS: u32 = 30;
pub const DEFAULT_INSTANT_MODE_FPS: u32 = 30;
pub const DEFAULT_CUSTOM_CURSOR_CAPTURE: bool = true;
pub const DEFAULT_CAPTURE_KEYBOARD_EVENTS: bool = true;
pub const DEFAULT_CRASH_RECOVERY_RECORDING: bool = true;
pub const DEFAULT_OUT_OF_PROCESS_MUXER: bool = false;

const COMPATIBILITY_MEMORY_THRESHOLD_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// The studio/instant recording defaults shared by the desktop app and the `cap` CLI, so both
/// surfaces build recordings identically (fragmentation, fps cap, cursor capture, quality) instead
/// of each maintaining its own copy. The desktop overlays the user's persisted settings on top.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordingDefaults {
    pub custom_cursor_capture: bool,
    pub capture_keyboard_events: bool,
    pub crash_recovery_recording: bool,
    pub max_fps: u32,
    pub studio_recording_quality: StudioQuality,
    pub out_of_process_muxer: bool,
    pub instant_mode_max_resolution: u32,
}

impl Default for RecordingDefaults {
    fn default() -> Self {
        Self {
            custom_cursor_capture: DEFAULT_CUSTOM_CURSOR_CAPTURE,
            capture_keyboard_events: DEFAULT_CAPTURE_KEYBOARD_EVENTS,
            crash_recovery_recording: DEFAULT_CRASH_RECOVERY_RECORDING,
            max_fps: DEFAULT_STUDIO_MAX_FPS,
            studio_recording_quality: default_studio_recording_quality(),
            out_of_process_muxer: DEFAULT_OUT_OF_PROCESS_MUXER,
            instant_mode_max_resolution: DEFAULT_INSTANT_MODE_MAX_RESOLUTION,
        }
    }
}

impl RecordingDefaults {
    pub fn studio_max_fps(self, camera_active: bool, override_fps: Option<u32>) -> u32 {
        let max_fps = override_fps.unwrap_or(self.max_fps);
        if camera_active {
            max_fps.min(CAMERA_ACTIVE_STUDIO_MAX_FPS)
        } else {
            max_fps
        }
    }

    pub fn apply_to_studio_builder(
        self,
        builder: studio_recording::ActorBuilder,
        camera_active: bool,
        override_fps: Option<u32>,
    ) -> studio_recording::ActorBuilder {
        builder
            .with_custom_cursor(self.custom_cursor_capture)
            .with_keyboard_capture(self.capture_keyboard_events)
            .with_fragmented(self.crash_recovery_recording)
            .with_out_of_process_muxer(self.out_of_process_muxer)
            .with_max_fps(self.studio_max_fps(camera_active, override_fps))
            .with_quality(self.studio_recording_quality)
    }
}

fn detect_total_memory_bytes() -> Option<u64> {
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing()
            .with_memory(sysinfo::MemoryRefreshKind::nothing().with_ram()),
    );
    Some(system.total_memory()).filter(|m| *m > 0)
}

pub fn default_studio_recording_quality() -> StudioQuality {
    match detect_total_memory_bytes() {
        Some(memory) if memory < COMPATIBILITY_MEMORY_THRESHOLD_BYTES => {
            StudioQuality::Compatibility
        }
        _ => StudioQuality::Balanced,
    }
}
