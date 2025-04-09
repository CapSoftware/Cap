#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub system_audio_recording: bool,
    pub split: bool,
}

pub const FLAGS: Flags = Flags {
    system_audio_recording: cfg!(debug_assertions),
    split: false,
};
