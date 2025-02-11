#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub record_mouse: bool,
    pub split: bool,
    pub timeline_zooming: bool,
}

pub const FLAGS: Flags = Flags {
    record_mouse: true,
    split: cfg!(debug_assertions),
    timeline_zooming: cfg!(debug_assertions),
};
