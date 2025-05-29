#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub captions: bool,
}

pub const FLAGS: Flags = Flags {
    captions: false, // cfg!(debug_assertions),
};
