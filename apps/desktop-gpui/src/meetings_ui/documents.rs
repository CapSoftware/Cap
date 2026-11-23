mod ask;
mod audio;
mod bar;
mod cap_ai;
#[cfg(test)]
mod collapse_tests;
mod commands;
#[cfg(debug_assertions)]
pub mod dev;
mod doodles;
pub(crate) mod export;
pub(crate) mod format;
mod glass;
mod home;
mod menu;
mod pane;
pub(crate) use pane::{PREVIEW_KEY, summary_preview};
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

use gpui::{App, KeyBinding, SharedString, actions};

/// The note the documents window has open, which cleanup leaves alone.
pub fn open_doc_ids(cx: &App) -> Vec<String> {
    cx.try_global::<crate::meetings_ui::MeetingWindows>()
        .and_then(|windows| windows.documents)
        .and_then(|handle| handle.downcast::<window::DocumentsWindow>())
        .and_then(|handle| {
            handle
                .read(cx)
                .ok()
                .and_then(|root| root.store.read(cx).open.clone())
        })
        .into_iter()
        .collect()
}

/// Runs `job` on the documents writer, after every save already queued, so
/// it never races an edit's write.
pub async fn after_queued_saves<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    writer::run(job).await
}

/// Queues `job` on the documents writer, after every save already queued,
/// without waiting for it.
pub fn queue_after_saves(job: impl FnOnce() + Send + 'static) {
    writer::submit(job);
}

#[cfg(test)]
pub(crate) use writer::{
    flush_blocking as flush_writer, hold as hold_writer, release as release_writer,
};

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

/// Open the notes window on a meeting just started, cursor in its notes, so
/// what the person types first is kept wherever they started it from.
pub fn open_to_type(doc_id: String, cx: &mut App) {
    tracing::info!(doc = doc_id, "opening the notes window to type");
    window::open_to_type(doc_id, cx);
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
        Ok(doc_id) => window::open_to_type(doc_id, cx),
        Err(error) => start_failed(error, cx),
    }
}

/// A start that failed outside the notes window (the main window, the tray,
/// a hotkey): the window opens and says so, so it never looks as if notes
/// were being taken.
pub fn start_failed(error: crate::meetings::MeetingError, cx: &mut App) {
    use crate::meetings::MeetingError;
    tracing::warn!(%error, "meeting notes did not start");
    let message = match error {
        MeetingError::Disabled => return crate::meetings_ui::setup::open(cx),
        MeetingError::NotFound => crate::i18n::tr::documents::bar::error_not_found(),
        _ => crate::i18n::tr::documents::bar::error_start(),
    };
    window::open_with_message(message, cx);
}

/// Why a start failed, in the person's words, when Cap can tell: a full
/// disk, a notes folder Cap cannot write to (or one that became a file), or
/// no audio to record. `None` for anything else.
pub fn start_failure_reason(error: &crate::meetings::MeetingError) -> Option<String> {
    use crate::i18n::tr;
    use crate::meetings::MeetingError;
    match error {
        MeetingError::Library(detail) => match os_error(detail)? {
            OsFailure::DiskFull => Some(tr::documents::audio::not_ready_message().to_string()),
            OsFailure::Folder => Some(tr::documents::bar::error_folder().to_string()),
        },
        MeetingError::NoAudioSource(detail) if detail != crate::meetings::STILL_STARTING => {
            Some(tr::documents::bar::error_audio().to_string())
        }
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OsFailure {
    DiskFull,
    Folder,
}

/// The operating system's error code in an I/O error's text ("... (os
/// error 28)"), which stays the same whatever language the system speaks.
fn os_error(detail: &str) -> Option<OsFailure> {
    let code: i32 = detail
        .rsplit_once("(os error ")?
        .1
        .split(')')
        .next()?
        .trim()
        .parse()
        .ok()?;
    #[cfg(windows)]
    let (disk, folder): (&[i32], &[i32]) = (
        // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL, ERROR_DISK_QUOTA_EXCEEDED
        &[39, 112, 1295],
        // ACCESS_DENIED, PATH_NOT_FOUND, WRITE_PROTECT, ALREADY_EXISTS,
        // DIRECTORY (not a folder)
        &[3, 5, 19, 183, 267],
    );
    #[cfg(target_os = "macos")]
    let (disk, folder): (&[i32], &[i32]) = (
        // ENOSPC, EDQUOT
        &[28, 69],
        // EPERM, EACCES, EEXIST, ENOTDIR, EISDIR, EROFS
        &[1, 13, 17, 20, 21, 30],
    );
    #[cfg(not(any(windows, target_os = "macos")))]
    let (disk, folder): (&[i32], &[i32]) = (
        // ENOSPC, EDQUOT
        &[28, 122],
        // EPERM, EACCES, EEXIST, ENOTDIR, EISDIR, EROFS
        &[1, 13, 17, 20, 21, 30],
    );
    if disk.contains(&code) {
        Some(OsFailure::DiskFull)
    } else if folder.contains(&code) {
        Some(OsFailure::Folder)
    } else {
        None
    }
}

/// Tags the notification for a failed automatic start, so a click on it is
/// told apart from any other.
#[cfg(target_os = "macos")]
const START_FAILED_TAG: &str = "cap-notes-start-failed";

/// A recording Cap started by itself (a detected call, a scheduled meeting)
/// could not start, and no window was there to say so. A system notification
/// says "Recording couldn't start." and why when Cap can tell; clicking it
/// opens the notes window with the same message. When Cap's notifications
/// are off, macOS does not allow them, or the system cannot show one, the
/// window opens with the message instead.
pub fn auto_start_failed(error: crate::meetings::MeetingError, cx: &mut App) {
    use crate::meetings::MeetingError;
    tracing::warn!(%error, "an automatic meeting start failed");
    let title: SharedString = match error {
        MeetingError::Disabled | MeetingError::PromptGone => return,
        MeetingError::NotFound => crate::i18n::tr::documents::bar::error_not_found().into(),
        _ => crate::i18n::tr::documents::bar::error_start().into(),
    };
    let body: SharedString = start_failure_reason(&error).unwrap_or_default().into();
    if !crate::notifications::enabled() {
        window::open_with_message(title, cx);
        return;
    }
    notify_start_failure(title, body, cx);
}

#[cfg(target_os = "macos")]
fn notify_start_failure(title: SharedString, body: SharedString, cx: &mut App) {
    let permission = crate::notifications::request_permission();
    cx.spawn(async move |cx| {
        let allowed = permission.recv_async().await.unwrap_or(false);
        cx.update(|cx| {
            if !allowed {
                tracing::info!("notifications are not allowed; opening the notes window");
                window::open_with_message(title, cx);
                return;
            }
            let message = title.clone();
            cx.on_system_notification_response(move |response, cx| {
                if response.tag.as_ref() == START_FAILED_TAG {
                    window::open_with_message(message.clone(), cx);
                }
            });
            cx.show_system_notification(gpui::SystemNotification {
                tag: START_FAILED_TAG.into(),
                title,
                body,
                actions: Vec::new(),
            });
        });
    })
    .detach();
}

#[cfg(not(target_os = "macos"))]
fn notify_start_failure(title: SharedString, body: SharedString, cx: &mut App) {
    use crate::notifications::Outcome;
    let (tx, rx) = flume::bounded(1);
    let open = crate::i18n::tr::documents::bar::show().to_string();
    let (shown_title, shown_body) = (title.to_string(), body.to_string());
    let spawned = std::thread::Builder::new()
        .name("notes-start-failed".into())
        .spawn(move || {
            tx.send(crate::notifications::show_and_wait(
                &shown_title,
                &shown_body,
                &open,
            ))
            .ok();
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not show the notification; opening the notes window");
        window::open_with_message(title, cx);
        return;
    }
    cx.spawn(async move |cx| {
        let outcome = rx.recv_async().await.unwrap_or(Outcome::NotShown);
        tracing::info!(?outcome, "start failure notification");
        if outcome != Outcome::Closed {
            cx.update(|cx| window::open_with_message(title, cx));
        }
    })
    .detach();
}
