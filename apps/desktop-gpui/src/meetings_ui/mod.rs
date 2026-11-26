pub mod cap_ai;
pub mod documents;
pub mod doodles;
pub mod live;
pub mod main_row;
pub mod settings;
pub mod setup;

use gpui::{AnyWindowHandle, App, Global};

#[derive(Default)]
pub struct MeetingWindows {
    pub documents: Option<AnyWindowHandle>,
    pub setup: Option<AnyWindowHandle>,
    pub indicator: Option<AnyWindowHandle>,
    pub prompts: Vec<AnyWindowHandle>,
}

impl Global for MeetingWindows {}

impl MeetingWindows {
    pub fn get(cx: &mut App) -> &mut Self {
        cx.default_global::<Self>()
    }

    pub fn dock_windows(cx: &App) -> Vec<AnyWindowHandle> {
        cx.try_global::<Self>()
            .map(|windows| {
                windows
                    .documents
                    .iter()
                    .chain(&windows.setup)
                    .copied()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn panel_windows(cx: &App) -> Vec<AnyWindowHandle> {
        cx.try_global::<Self>()
            .map(|windows| {
                windows
                    .indicator
                    .iter()
                    .chain(&windows.prompts)
                    .copied()
                    .collect()
            })
            .unwrap_or_default()
    }
}

pub fn init(cx: &mut App) {
    live::init(cx);
    cap_ai::init(cx);
}
