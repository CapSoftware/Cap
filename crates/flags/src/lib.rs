#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub record_mouse_state: bool,
    pub split: bool,
}

pub const FLAGS: Flags = Flags {
    record_mouse_state: false,
    split: false,
};
