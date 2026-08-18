//! The dev loop's stand-in for HMR.
//!
//! A gpui binary cannot hot-reload Rust, so `dev.sh` rebuilds and relaunches
//! on save. What makes the relaunch *feel* like the Solid dev server is this
//! module: while `CAP_GPUI_DEV_RESTORE` names a state file, the app snapshots
//! its window layout twice a second -- which windows are open, the settings
//! page, each editor's project, sidebar tab and scroll, every frame in raw
//! AppKit coordinates -- and the next launch reopens all of it in place,
//! through the same entry points the real clicks take. The file doubles as
//! the swap protocol: `dev.sh` will not kill the app while it says
//! `"recording":true`, so a rebuild never truncates a capture.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{App, Window};
use serde::{Deserialize, Serialize};

use crate::app_windows::{self, AppWindows};
use crate::platform;
use crate::session::{Phase, RecordingSession};
use crate::settings_window;

type Frame = (f64, f64, f64, f64);

#[derive(Serialize, Deserialize, PartialEq, Clone, Default)]
struct DevState {
    recording: bool,
    main: MainState,
    settings: Option<SettingsState>,
    editors: Vec<EditorState>,
    teleprompter: bool,
}

#[derive(Serialize, Deserialize, PartialEq, Clone)]
struct MainState {
    expanded: bool,
    visible: bool,
    frame: Option<Frame>,
}

impl Default for MainState {
    fn default() -> Self {
        Self {
            expanded: false,
            visible: true,
            frame: None,
        }
    }
}

#[derive(Serialize, Deserialize, PartialEq, Clone)]
struct SettingsState {
    page: String,
    frame: Option<Frame>,
}

#[derive(Serialize, Deserialize, PartialEq, Clone)]
struct EditorState {
    path: PathBuf,
    tab: String,
    scroll: f32,
    frame: Option<Frame>,
}

pub fn enabled() -> bool {
    state_path().is_some()
}

fn state_path() -> Option<PathBuf> {
    std::env::var("CAP_GPUI_DEV_RESTORE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

pub fn init(cx: &mut App) {
    let Some(path) = state_path() else {
        return;
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<DevState>(&raw) {
            Ok(state) => restore(state, cx),
            Err(error) => {
                tracing::warn!(%error, "dev-restore state unreadable; starting fresh");
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(%error, "dev-restore state unreadable; starting fresh"),
    }
    spawn_poller(path, cx);
}

fn restore(state: DevState, cx: &mut App) {
    tracing::info!(
        expanded = state.main.expanded,
        settings = state.settings.as_ref().map(|s| s.page.as_str()),
        editors = state.editors.len(),
        teleprompter = state.teleprompter,
        "dev-restore: reopening the previous session"
    );

    let main = cx.global::<AppWindows>().main;
    if state.main.expanded {
        main.update(cx, |view, window, cx| view.ensure_expanded(window, cx))
            .ok();
    }
    if let Some(settings) = &state.settings {
        let page = settings_window::Page::from_slug(&settings.page)
            .unwrap_or(settings_window::Page::General);
        app_windows::open_settings(page, cx);
    }
    for editor in &state.editors {
        if editor.path.is_dir() {
            app_windows::open_editor(editor.path.clone(), cx);
        } else {
            tracing::warn!(path = %editor.path.display(), "dev-restore: bundle is gone");
        }
    }
    if state.teleprompter {
        app_windows::open_teleprompter(cx);
    }
    let anything_else = state.settings.is_some() || !state.editors.is_empty() || state.teleprompter;
    if state.main.visible && !state.editors.is_empty() {
        // `open_editor` hid it; the previous session had both up.
        app_windows::show_main_window(cx);
    } else if !state.main.visible && anything_else {
        // Honored only while another window carries the session -- a snapshot
        // taken mid-picker or mid-recording must not restore to nothing.
        app_windows::hide_main_window(cx);
    }

    cx.spawn(async move |cx| {
        // Let the centred first frames and the expand animation land before
        // the frames are re-asserted.
        cx.background_executor()
            .timer(Duration::from_millis(600))
            .await;

        let (main, settings, teleprompter, editors) = cx.update(|cx| {
            let windows = cx.global::<AppWindows>();
            (
                windows.main,
                windows.settings,
                windows.teleprompter,
                windows.editors.clone(),
            )
        });

        let mut placements: Vec<(platform::NativeWindow, Option<Frame>, bool)> = Vec::new();
        let mut collect =
            |native: Option<platform::NativeWindow>, frame: Option<Frame>, order_front: bool| {
                if let Some(native) = native {
                    placements.push((native, frame, order_front));
                }
            };
        cx.update(|cx| {
            collect(
                main.update(cx, |_, window, _| platform::native_window(window))
                    .ok()
                    .flatten(),
                state.main.frame,
                state.main.visible,
            );
            if let (Some(handle), Some(saved)) = (settings, &state.settings) {
                collect(
                    handle
                        .update(cx, |_, window, _| platform::native_window(window))
                        .ok()
                        .flatten(),
                    saved.frame,
                    true,
                );
            }
            if let Some(handle) = teleprompter
                && state.teleprompter
            {
                collect(
                    handle
                        .update(cx, |_, window, _| platform::native_window(window))
                        .ok()
                        .flatten(),
                    None,
                    true,
                );
            }
            for (path, handle) in &editors {
                let saved = state.editors.iter().find(|editor| &editor.path == path);
                collect(
                    handle
                        .update(cx, |_, window, _| platform::native_window(window))
                        .ok()
                        .flatten(),
                    saved.and_then(|editor| editor.frame),
                    true,
                );
            }
        });
        // Outside any gpui borrow: `setFrame:` and ordering re-enter gpui's
        // window callbacks (the `place_overlay_panel` rule).
        for (native, frame, order_front) in &placements {
            if let Some((x, y, width, height)) = frame {
                platform::set_window_frame(native, *x, *y, *width, *height);
            }
            if *order_front {
                platform::order_front_native(native);
            }
        }

        if state
            .editors
            .iter()
            .all(|editor| editor.tab.eq_ignore_ascii_case("background") && editor.scroll == 0.)
        {
            return;
        }
        // A loaded project replaces `EditorWindow::sidebar` wholesale
        // (`apply_loaded_project`), wiping any earlier tab select -- so this
        // waits out the load the same way `drive_auto_sidebar` does.
        cx.background_executor()
            .timer(Duration::from_millis(600))
            .await;
        cx.update(|cx| {
            let editors = cx.global::<AppWindows>().editors.clone();
            for (path, handle) in editors {
                let Some(saved) = state.editors.iter().find(|editor| editor.path == path) else {
                    continue;
                };
                handle
                    .update(cx, |view, window, cx| {
                        view.auto_select_sidebar_tab(
                            &saved.tab,
                            (saved.scroll > 0.).then_some(saved.scroll),
                            window,
                            cx,
                        );
                    })
                    .ok();
            }
        });
    })
    .detach();
}

fn spawn_poller(path: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let mut last: Option<String> = None;
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(500))
                .await;
            let state = cx.update(snapshot);
            let Ok(json) = serde_json::to_string(&state) else {
                continue;
            };
            if last.as_deref() == Some(json.as_str()) {
                continue;
            }
            let target = path.clone();
            let payload = json.clone();
            let written = cx
                .background_executor()
                .spawn(async move { write_atomic(&target, &payload) })
                .await;
            if written {
                last = Some(json);
            }
        }
    })
    .detach();
}

fn snapshot(cx: &mut App) -> DevState {
    let session = RecordingSession::global(cx);
    let recording = session.read(cx).phase != Phase::Idle;

    let (main, settings, teleprompter, editors) = {
        let windows = cx.global::<AppWindows>();
        (
            windows.main,
            windows.settings,
            windows.teleprompter,
            windows.editors.clone(),
        )
    };

    let main = main
        .update(cx, |view, window, _| MainState {
            expanded: view.is_expanded(),
            visible: platform::window_is_visible(window),
            frame: capture_frame(window),
        })
        .unwrap_or_default();

    let settings = settings.and_then(|handle| {
        handle
            .update(cx, |view, window, _| SettingsState {
                page: view.page.slug().to_string(),
                frame: capture_frame(window),
            })
            .ok()
    });

    let editors = editors
        .into_iter()
        .filter_map(|(path, handle)| {
            handle
                .update(cx, |view, window, _| EditorState {
                    path,
                    tab: view.sidebar.tab.label().to_string(),
                    scroll: (-f32::from(view.sidebar.scroll.offset().y)).max(0.),
                    frame: capture_frame(window),
                })
                .ok()
        })
        .collect();

    let teleprompter = teleprompter.is_some();

    DevState {
        recording,
        main,
        settings,
        editors,
        teleprompter,
    }
}

fn capture_frame(window: &Window) -> Option<Frame> {
    let native = platform::native_window(window)?;
    let (x, y, width, height) = platform::window_frame(&native);
    (width > 0. && height > 0.).then_some((x, y, width, height))
}

fn write_atomic(path: &Path, contents: &str) -> bool {
    let tmp = path.with_extension("json.tmp");
    let result = std::fs::write(&tmp, contents).and_then(|()| std::fs::rename(&tmp, path));
    if let Err(error) = &result {
        tracing::debug!(%error, "dev-restore state write failed");
    }
    result.is_ok()
}
