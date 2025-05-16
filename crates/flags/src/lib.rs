#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub split: bool,
}

pub const FLAGS: Flags = Flags { split: true };
