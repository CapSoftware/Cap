#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub record_mouse_state: bool,
    pub system_audio_recording: bool,
    pub split: bool,
}

pub const FLAGS: Flags = Flags {
    record_mouse_state: cfg!(debug_assertions),
    system_audio_recording: cfg!(debug_assertions),
    split: false,
};
