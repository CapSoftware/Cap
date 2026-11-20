mod ask;
mod audio;
mod bar;
mod cap_ai;
mod commands;
#[cfg(debug_assertions)]
pub mod dev;
mod doodles;
pub(crate) mod export;
pub(crate) mod format;
mod home;
mod menu;
mod pane;
mod player;
mod sidebar;
mod start;
pub(crate) mod store;
pub(crate) mod style;
#[cfg(test)]
mod tests;
mod transcript;
mod upgrade;
mod when;
mod window;
pub use window::{TITLE, TRAFFIC_LIGHTS};
mod writer;

use gpui::{App, KeyBinding, actions};

actions!(
    cap_documents,
    [
        FocusSearch,
        ToggleSidebar,
        NewNote,
        NewMeetingNotes,
        GoHome,
        ShowMyNotes,
        ShowGeneratedNotes,
        ShowTranscript,
        ToggleRecording,
        WriteNotes,
        ToggleAsk,
        CloseDocuments,
        Dismiss,
        FindInTranscript,
        SelectionUp,
        SelectionDown,
        ExtendSelectionUp,
        ExtendSelectionDown,
        CopySelection,
        DeleteSelection,
        SearchNext,
        SearchPrevious,
    ]
);

pub const KEY_CONTEXT: &str = "DocumentsWindow";
pub const TRANSCRIPT_CONTEXT: &str = "DocumentsTranscript";
pub const SEARCH_CONTEXT: &str = "DocumentsSearch";

pub fn bind_keys(cx: &mut App) {
    let window = Some(KEY_CONTEXT);
    let transcript = Some(TRANSCRIPT_CONTEXT);
    let search = Some("DocumentsSearch > TextInput");
    cx.bind_keys([
        KeyBinding::new("secondary-f", FocusSearch, window),
        KeyBinding::new("secondary-k", FocusSearch, window),
        KeyBinding::new(
            "secondary-k",
            FocusSearch,
            Some("DocumentsWindow > NotesEditor"),
        ),
        KeyBinding::new("secondary-\\", ToggleSidebar, window),
        KeyBinding::new("secondary-n", NewNote, window),
        KeyBinding::new("secondary-[", GoHome, window),
        KeyBinding::new("secondary-1", ShowMyNotes, window),
        KeyBinding::new("secondary-2", ShowGeneratedNotes, window),
        KeyBinding::new("secondary-3", ShowTranscript, window),
        KeyBinding::new("secondary-shift-r", ToggleRecording, window),
        KeyBinding::new("secondary-enter", WriteNotes, window),
        KeyBinding::new("secondary-j", ToggleAsk, window),
        KeyBinding::new("secondary-w", CloseDocuments, window),
        KeyBinding::new("escape", Dismiss, window),
        KeyBinding::new("secondary-f", FindInTranscript, transcript),
        KeyBinding::new("up", SelectionUp, transcript),
        KeyBinding::new("down", SelectionDown, transcript),
        KeyBinding::new("shift-up", ExtendSelectionUp, transcript),
        KeyBinding::new("shift-down", ExtendSelectionDown, transcript),
        KeyBinding::new("secondary-c", CopySelection, transcript),
        KeyBinding::new("backspace", DeleteSelection, transcript),
        KeyBinding::new("delete", DeleteSelection, transcript),
        KeyBinding::new("down", SearchNext, search),
        KeyBinding::new("up", SearchPrevious, search),
    ]);
}

/// Open the notes window. With no note asked for it lands on the note being
/// taken right now when there is one, so every "open notes" entry point (tray,
/// hotkey, indicator, main window) leads to the same place.
pub fn open(doc_id: Option<String>, cx: &mut App) {
    let active = crate::meetings_ui::live::active(cx);
    let target = crate::meetings_ui::live::open_target(doc_id, active.as_ref());
    tracing::info!(doc = ?target, "opening the notes window");
    window::open(target, cx);
}

/// Make this the start button's one-click choice (the tray's picks count).
pub fn remember_start(choice: cap_meetings::settings::StartChoice, cx: &mut App) {
    start::remember(choice, cx);
}

/// "New note" from the tray, a hotkey or the main window.
pub fn new_note(cx: &mut App) {
    window::new_note(cx);
}

pub fn open_upgrade_window(cx: &mut App) {
    upgrade::open_window(cx);
}

/// Start taking notes and land in the note, already listening. Every
/// "start" entry point (the main window, setup's first run, the tray) should
/// go through here so they all end in the same place.
pub fn start_listening(source: crate::meetings::StartSource, cx: &mut App) {
    if !crate::meetings_ui::live::can_record(cx) {
        crate::meetings_ui::setup::open(cx);
        return;
    }
    match crate::meetings_ui::live::start(source, cx) {
        Ok(doc_id) => window::open(Some(doc_id), cx),
        Err(error) => tracing::warn!(%error, "meeting notes did not start"),
    }
}
