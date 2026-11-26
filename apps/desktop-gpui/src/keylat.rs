//! Opt-in keystroke latency probe. With `CAP_GPUI_KEYLAT=<file>` set, every key
//! the OS delivers is stamped with the event's own time (NSEvent.timestamp) and
//! paired with the end of the next paint of the window it went to; one line per
//! key is appended to the file: `<ms from event to paint> <key> <window>`, and
//! one line per frame: `F <ms from the root's render to the end of paint>
//! <uptime s at the end>`, for frame times while typing or animating.
//! Nothing runs without the variable: the observer is never installed and the
//! paint hook returns at once. Release builds ignore the variable, since the
//! file records every key typed; perf builds enable debug assertions.

use std::{cell::RefCell, io::Write, sync::OnceLock};

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, Window, canvas, div, px};

fn target() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        if !cfg!(debug_assertions) {
            return None;
        }
        std::env::var("CAP_GPUI_KEYLAT")
            .ok()
            .filter(|p| !p.is_empty())
    })
    .as_deref()
}

thread_local! {
    static PENDING: RefCell<Vec<(f64, String, u64)>> = const { RefCell::new(Vec::new()) };
    static FRAME_START: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
}

/// Called first thing in a probed window root's render: the frame starts.
pub fn frame_started() {
    if target().is_some() {
        FRAME_START.with(|f| f.set(Some(now())));
    }
}

#[cfg(target_os = "macos")]
fn event_time() -> Option<f64> {
    use objc2::{class, msg_send, runtime::AnyObject};
    // SAFETY: plain AppKit getters on the main thread (key events and paint
    // both run there); a null current event is checked before use.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() {
            return None;
        }
        let event: *mut AnyObject = msg_send![app, currentEvent];
        if event.is_null() {
            return None;
        }
        let ts: f64 = msg_send![event, timestamp];
        Some(ts)
    }
}

#[cfg(target_os = "macos")]
fn now() -> f64 {
    use objc2::{class, msg_send, runtime::AnyObject};
    // SAFETY: NSProcessInfo.systemUptime, the clock NSEvent.timestamp uses.
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        msg_send![info, systemUptime]
    }
}

#[cfg(not(target_os = "macos"))]
fn event_time() -> Option<f64> {
    None
}

/// Seconds on a monotonic clock, so frame times work off macOS too (key
/// latency needs the OS event time, which only macOS hands over here).
#[cfg(not(target_os = "macos"))]
fn now() -> f64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
}

pub fn install(cx: &mut App) {
    if target().is_none() {
        return;
    }
    #[cfg(debug_assertions)]
    start_typist(cx);
    cx.observe_keystrokes(|event, window, _| {
        let Some(at) = event_time() else {
            return;
        };
        let id = window.window_handle().window_id().as_u64();
        let key = event.keystroke.key.clone();
        PENDING.with(|p| p.borrow_mut().push((at, key, id)));
    })
    .detach();
}

/// The last child of a window's root: its paint marks the end of the frame.
pub fn probe() -> Option<AnyElement> {
    target()?;
    Some(
        div()
            .absolute()
            .size(px(1.))
            .child(canvas(|_, _, _| {}, |_, _, window, _| painted(window)).size(px(1.)))
            .into_any_element(),
    )
}

fn painted(window: &mut Window) {
    let Some(path) = target() else {
        return;
    };
    let id = window.window_handle().window_id().as_u64();
    let done: Vec<(f64, String, u64)> = PENDING.with(|p| {
        let mut p = p.borrow_mut();
        let (mine, rest): (Vec<_>, Vec<_>) = p.drain(..).partition(|(_, _, w)| *w == id);
        *p = rest;
        mine
    });
    let end = now();
    let started = FRAME_START.with(|f| f.take());
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    if let Some(started) = started {
        let _ = writeln!(file, "F {:.3} {:.4}", (end - started) * 1000., end);
    }
    for (at, key, window) in done {
        let _ = writeln!(file, "{:.3} {} {}", (end - at) * 1000., key, window);
    }
}

/// Dev builds: `CAP_GPUI_KEYLAT_TYPE=<ms>|<text>` types the text into the notes
/// window's focused field from inside the app, one key every `ms`, each key
/// stamped when it is dispatched. For machines where the OS cannot bring the
/// window forward (a system dialog in front); a `D` line marks the end. With
/// `CAP_GPUI_KEYLAT_WINDOW=settings` it opens Settings on Recordings, tabs to
/// the first text field and types there instead.
#[cfg(debug_assertions)]
fn start_typist(cx: &mut App) {
    let Some(spec) = std::env::var("CAP_GPUI_KEYLAT_TYPE")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let Some((ms, text)) = spec.split_once('|') else {
        return;
    };
    let every = std::time::Duration::from_millis(ms.parse().unwrap_or(80));
    let text = text.to_string();
    let settings = std::env::var("CAP_GPUI_KEYLAT_WINDOW").is_ok_and(|w| w == "settings");
    cx.spawn(async move |cx| {
        if settings {
            cx.update(|cx| {
                crate::app_windows::open_settings(crate::settings_window::Page::Recordings, cx)
            });
        }
        cx.background_executor()
            .timer(std::time::Duration::from_secs(4))
            .await;
        let typed_into = move |cx: &mut App| -> Option<gpui::AnyWindowHandle> {
            if settings {
                cx.global::<crate::app_windows::AppWindows>()
                    .settings
                    .map(Into::into)
            } else {
                crate::meetings_ui::MeetingWindows::get(cx)
                    .documents
                    .map(Into::into)
            }
        };
        if settings {
            cx.update(|cx| {
                let handle = typed_into(cx)?;
                handle
                    .update(cx, |_, window, cx| {
                        for _ in 0..80 {
                            if crate::ui::text_input_has_focus(window, cx) {
                                break;
                            }
                            window.focus_next(cx);
                        }
                    })
                    .ok()
            });
            cx.background_executor()
                .timer(std::time::Duration::from_millis(500))
                .await;
        }
        for ch in text.chars() {
            let key = if ch == ' ' {
                "space".to_string()
            } else {
                ch.to_string()
            };
            cx.update(|cx| {
                let Some(handle) = typed_into(cx) else {
                    return;
                };
                handle
                    .update(cx, |_, window, cx| {
                        let id = window.window_handle().window_id().as_u64();
                        PENDING.with(|p| p.borrow_mut().push((now(), key.clone(), id)));
                        if let Ok(stroke) = gpui::Keystroke::parse(&key) {
                            window.dispatch_keystroke(stroke, cx);
                        }
                    })
                    .ok();
            });
            cx.background_executor().timer(every).await;
        }
        cx.background_executor()
            .timer(std::time::Duration::from_millis(500))
            .await;
        if let Some(path) = target()
            && let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(path)
        {
            let _ = writeln!(file, "D");
        }
    })
    .detach();
}
