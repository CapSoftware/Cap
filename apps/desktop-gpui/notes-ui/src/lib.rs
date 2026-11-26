mod actions;
mod commands;
mod editor;
mod element;
mod field;
mod glyphs;
mod heights;
mod input;
mod layout;
mod menu;
mod mouse;
mod outline;
mod reveal;
#[doc(hidden)]
pub mod script;
mod store;
mod stream;
mod text;
mod theme;
mod view;
mod writing;

#[cfg(test)]
mod tests;

pub use actions::{FIELD_CONTEXT, KEY_CONTEXT};
pub use editor::{DebugStats, NotesEditor, NotesEvent, RevealHost, SourceMark};
pub use menu::SlashItem;
pub use store::FrameStats;
pub use theme::{NotesLabels, NotesTheme};

pub fn bind_keys(cx: &mut gpui::App) {
    cx.bind_keys(actions::bindings());
}
