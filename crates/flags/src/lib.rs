#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub record_mouse: bool,
    pub split: bool,
    pub pause_resume: bool,
    pub zoom: bool,
}

pub const FLAGS: Flags = Flags {
    record_mouse: cfg!(debug_assertions),
    split: false,
    pause_resume: false,
    zoom: true,
};
