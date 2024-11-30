#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub record_mouse: bool,
    pub split: bool,
    pub pause_resume: bool,
    pub zoom: bool,
    pub custom_s3: bool,
}

pub const FLAGS: Flags = Flags {
    record_mouse: false, // cfg!(debug_assertions),
    split: false,        // cfg!(debug_assertions),
    pause_resume: cfg!(debug_assertions),
    zoom: false, // cfg!(debug_assertions),
    custom_s3: true,
};
