//! What a launch shows when it cannot become a working Cap.
//!
//! A release build on Windows has no console, so before this module every
//! early exit (an unresponsive running copy, a failed instance lock, a panic
//! while gpui starts, a main window that would not open) ended the process
//! with nothing on screen and, for the earliest ones, nothing in the log.

use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};

use crate::i18n::tr;

static MAIN_THREAD: OnceLock<std::thread::ThreadId> = OnceLock::new();
static FINISHED: AtomicBool = AtomicBool::new(false);
static FAILURE_SHOWN: AtomicBool = AtomicBool::new(false);

/// Call first thing in `main`, after logging starts.
pub fn begin() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        pid = std::process::id(),
        executable = %std::env::current_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        "Cap starting"
    );
}

/// The main window is open; from here a panic is the crash reporter's job.
pub fn finished() {
    FINISHED.store(true, Ordering::Release);
}

fn on_main_thread() -> bool {
    MAIN_THREAD
        .get()
        .is_some_and(|main| *main == std::thread::current().id())
}

/// Called by the panic hook. Only a main-thread panic before the main window
/// opens ends the launch, and only the main thread may show a dialog on macOS.
pub fn report_panic(message: &str, location: &str) {
    if FINISHED.load(Ordering::Acquire) || !on_main_thread() {
        return;
    }
    show_failure(&format!("{message} ({location})"));
}

/// Shows why Cap could not start, then exits.
pub fn fail(error: impl std::fmt::Display) -> ! {
    let error = error.to_string();
    tracing::error!(%error, "Cap could not start");
    crate::crash_capture::record_startup_failure(&error);
    show_failure(&error);
    std::process::exit(1);
}

fn show_failure(error: &str) {
    if FAILURE_SHOWN.swap(true, Ordering::AcqRel) {
        return;
    }
    load_language();
    let folder = crate::diagnostics::logs_dir();
    show_error(
        tr::dialog::startup::failed_title(),
        &tr::dialog::startup::failed(error, folder.display()),
    );
}

/// Asks whether to end a running copy that did not answer the reopen request.
pub fn confirm_quit_unresponsive() -> bool {
    load_language();
    prepare_dialog();
    crate::platform::confirm_dialog(
        tr::dialog::startup::unresponsive_title(),
        tr::dialog::startup::unresponsive(),
        tr::dialog::startup::quit_and_reopen(),
        tr::common::cancel(),
        true,
    )
}

fn load_language() {
    crate::i18n::init(crate::store::GeneralSettings::load().ui_language.as_deref());
}

#[cfg(target_os = "windows")]
fn show_error(title: &str, message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW,
    };

    let wide = |text: &str| {
        text.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let (title, message) = (wide(title), wide(message));
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_error(title: &str, message: &str) {
    if !on_main_thread() {
        return;
    }
    prepare_dialog();
    crate::platform::alert_dialog(title, message);
}

/// `NSAlert` does nothing until `NSApp` exists, and a startup failure can come
/// before gpui creates it.
#[cfg(target_os = "macos")]
fn prepare_dialog() {
    if on_main_thread() {
        crate::platform::activate_app();
    }
}

#[cfg(not(target_os = "macos"))]
fn prepare_dialog() {}
