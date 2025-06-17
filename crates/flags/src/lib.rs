#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub captions: bool,
    pub new_recording_flow: bool,
}

pub const FLAGS: Flags = Flags {
    captions: false, // cfg!(debug_assertions),
    new_recording_flow: cfg!(debug_assertions),
};
