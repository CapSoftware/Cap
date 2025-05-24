#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub transcription: bool,
}

pub const FLAGS: Flags = Flags {
    transcription: cfg!(debug_assertions),
};
