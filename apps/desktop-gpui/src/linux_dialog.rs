//! Confirmations and alerts on Linux desktops without zenity.
//!
//! `rfd`'s portal backend shows every message dialog by running `zenity`, and
//! answers Cancel when it cannot. Most Arch, NixOS, Hyprland and Niri installs
//! have no zenity, so every confirmation (delete a recording, run the
//! diagnostic, discard a recording) silently said no and every alert (export
//! failed, sign in failed) never appeared.
//!
//! Without zenity, the dialog runs in a second copy of this binary started
//! with [`ARG`]: one small window showing the app's own prompt, whose answer is
//! the exit status. Callers keep the blocking, zenity-shaped API they already
//! use, and desktops that have zenity keep it.

use gpui::{
    App, AppContext as _, Bounds, Context, IntoElement, Render, Styled as _, Window, WindowBounds,
    WindowOptions, div, point, px, size,
};
use serde::{Deserialize, Serialize};

pub const ARG: &str = "--cap-linux-dialog";

const ACCEPTED: i32 = 0;
const DECLINED: i32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub title: String,
    pub message: String,
    pub accept: String,
    /// `None` for an alert with a single button.
    pub cancel: Option<String>,
}

pub fn zenity_available() -> bool {
    std::env::var_os("PATH").is_some_and(|path| zenity_on(&path))
}

fn zenity_on(path: &std::ffi::OsStr) -> bool {
    std::env::split_paths(path).any(|dir| {
        std::fs::metadata(dir.join("zenity"))
            .is_ok_and(|metadata| metadata.is_file() && is_executable(&metadata))
    })
}

fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    metadata.permissions().mode() & 0o111 != 0
}

/// Shows `request` in a dialog process and blocks until it is answered.
/// `None` when the process could not run, so the caller can fall back.
pub fn show(request: &Request) -> Option<bool> {
    let executable = std::env::current_exe().ok()?;
    let payload = serde_json::to_string(request).ok()?;
    let status = std::process::Command::new(executable)
        .arg(ARG)
        .arg(payload)
        .stdin(std::process::Stdio::null())
        .status()
        .map_err(|error| tracing::warn!(%error, "could not start the Cap dialog process"))
        .ok()?;
    match status.code() {
        Some(ACCEPTED) => Some(true),
        Some(DECLINED) => Some(false),
        _ => {
            tracing::warn!(%status, "the Cap dialog process ended without an answer");
            None
        }
    }
}

pub fn run_from_args() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(ARG) {
        return None;
    }
    let Some(request) = args
        .next()
        .and_then(|payload| serde_json::from_str::<Request>(&payload).ok())
    else {
        return Some(2);
    };
    let app = gpui_platform::application().with_assets(crate::assets::Assets);
    app.run(move |cx: &mut App| {
        if let Err(error) = crate::assets::Assets.load_fonts(cx) {
            eprintln!("Cap dialog: could not load fonts: {error:#}");
        }
        open(request, cx);
    });
    // The window was closed without an answer.
    Some(DECLINED)
}

const WIDTH: f32 = 460.;
const HEIGHT: f32 = 240.;

struct DialogWindow {
    theme: crate::theme::Theme,
}

impl Render for DialogWindow {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(self.theme.gray_1)
    }
}

fn open(request: Request, cx: &mut App) {
    let title = request.title.clone();
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(0.), px(0.)),
                size: size(px(WIDTH), px(HEIGHT)),
            })),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some(title.into()),
                ..Default::default()
            }),
            app_id: Some(crate::app_windows::app_id().into()),
            focus: true,
            show: true,
            is_resizable: false,
            is_minimizable: false,
            ..Default::default()
        },
        |window, cx| {
            cx.new(|cx| {
                crate::theme::bind_window(window, cx);
                DialogWindow {
                    theme: crate::theme::Theme::for_window(window, cx, false),
                }
            })
        },
    );
    let Ok(handle) = opened else {
        std::process::exit(2);
    };
    let _ = handle.update(cx, move |_, window, cx| {
        let answer: std::pin::Pin<Box<dyn std::future::Future<Output = bool>>> =
            match &request.cancel {
                Some(cancel) => Box::pin(crate::editor_modal::confirm_action(
                    &request.title,
                    &request.message,
                    &request.accept,
                    cancel,
                    window,
                    cx,
                )),
                None => Box::pin(crate::editor_modal::informational_alert(
                    &request.title,
                    &request.message,
                    window,
                    cx,
                )),
            };
        window
            .spawn(cx, async move |_| {
                let accepted = answer.await;
                std::process::exit(if accepted { ACCEPTED } else { DECLINED });
            })
            .detach();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_round_trip_through_the_command_line() {
        let request = Request {
            title: "Run diagnostic?".into(),
            message: "Cap will \"take over\" your screen\nfor a while.".into(),
            accept: "Run Diagnostic".into(),
            cancel: Some("Cancel".into()),
        };
        let payload = serde_json::to_string(&request).unwrap();
        assert_eq!(serde_json::from_str::<Request>(&payload).unwrap(), request);
    }

    #[test]
    fn zenity_lookup_follows_path_and_needs_an_executable() {
        let dir = tempfile::tempdir().unwrap();
        let zenity = dir.path().join("zenity");
        std::fs::write(&zenity, "#!/bin/sh\n").unwrap();
        let empty = tempfile::tempdir().unwrap();
        let path = std::env::join_paths([empty.path(), dir.path()]).unwrap();
        let found = |mode: u32| {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&zenity, std::fs::Permissions::from_mode(mode)).unwrap();
            zenity_on(&path)
        };
        assert!(found(0o755));
        assert!(!found(0o644));
        assert!(!zenity_on(empty.path().as_os_str()));
    }
}
