use serde::Serialize;
use specta::Type;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PreparingEditorPhase {
    #[default]
    Preparing,
    Handoff,
    Unavailable,
    Ready,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreparingEditorProgress {
    pub total_duration: Option<f64>,
    pub playable_until: f64,
    pub preview_available: bool,
    pub phase: PreparingEditorPhase,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreparingPlaybackState {
    pub playhead_seconds: f64,
    pub playing: bool,
    pub buffering: bool,
}
