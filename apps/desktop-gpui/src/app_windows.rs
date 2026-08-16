//! Multi-window orchestration -- the `windows.rs` of the gpui app.
//!
//! The registry lives in a global; the recording flow is driven by observing
//! the [`RecordingSession`]: the caller opens the bar and hides the main
//! window *before* starting the engine (the bar's window number has to exist
//! to be excluded from capture, and the real app shows the bar in its
//! "Starting" state from t=0), and the observer closes the bar and reshows the
//! main window whenever the session comes back to rest.

use gpui::{
    App, AppContext as _, Bounds, Entity, Global, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, point, px, size,
};

use crate::{
    camera_window::{self, CameraWindow},
    controls_window::ControlsWindow,
    main_window::MainWindow,
    platform,
    recording::{RecordingMode, StartConfig},
    session::{Phase, RecordingSession},
};

/// Matches the Tauri `InProgressRecording` window and
/// `fake_window.rs` position math.
pub const CONTROLS_WIDTH: f32 = 320.;
pub const CONTROLS_HEIGHT: f32 = 150.;
const CONTROLS_BOTTOM_OFFSET: f64 = 120.;
const TARGET_CONTROLS_OFFSET_Y: f64 = 48.;

pub struct AppWindows {
    pub main: WindowHandle<MainWindow>,
    pub controls: Option<WindowHandle<ControlsWindow>>,
    pub camera: Option<WindowHandle<CameraWindow>>,
}

impl Global for AppWindows {}

/// Install the registry and wire the session observer that tears the bar down
/// when a recording ends (stop, delete, or a failed start).
pub fn init(main: WindowHandle<MainWindow>, session: Entity<RecordingSession>, cx: &mut App) {
    cx.set_global(AppWindows {
        main,
        controls: None,
        camera: None,
    });

    let mut last_phase = Phase::Idle;
    cx.observe(&session, move |session, cx| {
        let phase = session.read(cx).phase;
        if phase == Phase::Idle && last_phase != Phase::Idle {
            close_controls(&session, cx);
            let main = cx.global::<AppWindows>().main;
            main.update(cx, |_, window, _| platform::show_window(window))
                .ok();
        }
        last_phase = phase;
    })
    .detach();
}

/// The whole start flow: bar up (in its Starting state), main window hidden,
/// engine started with the bar excluded from capture.
pub fn begin_recording(config: StartConfig, cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle {
        return;
    }

    let mut excluded: Vec<scap_targets::WindowId> =
        open_controls(&config, session.clone(), cx).into_iter().collect();
    // The camera bubble is excluded from studio captures (the camera is its own
    // track, composited in the editor) but *included* in instant captures --
    // `filter_for_instant_mode` in the Tauri app strips the camera exclusion
    // there because instant has no compositing step.
    if config.mode == RecordingMode::Studio
        && let Some(number) = camera_window_number(cx)
        && let Ok(id) = number.to_string().parse()
    {
        excluded.push(id);
    }

    let bar_open = cx.global::<AppWindows>().controls.is_some();
    session.update(cx, |session, cx| {
        session.set_controls_open(bar_open, cx);
    });
    if bar_open {
        let main = cx.global::<AppWindows>().main;
        main.update(cx, |_, window, _| platform::hide_window(window))
            .ok();
    }

    let config = StartConfig {
        excluded_windows: excluded,
        ..config
    };
    session.update(cx, |session, cx| session.start(config, cx));
}

/// Open the camera preview bubble (idempotent). Placement mirrors the Tauri
/// default: bottom-right of the main window's display, 100px in from the
/// corner. Position is not persisted yet (deviation; the Tauri app remembers it
/// per monitor).
pub fn open_camera_window(cx: &mut App) {
    if cx.global::<AppWindows>().camera.is_some() {
        return;
    }

    let state = crate::store::load().camera_window.unwrap_or_default();
    let (width, height) = camera_window::window_size(&state, None);

    let display = scap_targets::Display::get_containing_cursor()
        .unwrap_or_else(scap_targets::Display::primary);
    let (x, y) = match display.raw_handle().logical_bounds() {
        Some(bounds) => (
            (bounds.position().x() + bounds.size().width() - width as f64 - 100.) as f32,
            (bounds.position().y() + bounds.size().height() - height as f64 - 100.) as f32,
        ),
        None => (100., 100.),
    };

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(x), px(y)),
                size: size(px(width), px(height)),
            })),
            titlebar: None,
            // Non-activating panel, same as the bar: the bubble is clickable
            // without stealing focus from what is being recorded.
            kind: WindowKind::PopUp,
            focus: false,
            show: true,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| CameraWindow::new(window, cx)),
    );

    match handle {
        Ok(handle) => {
            cx.global_mut::<AppWindows>().camera = Some(handle);
            handle
                .update(cx, |_, window, _| {
                    platform::apply_panel_behavior(
                        window,
                        platform::PanelBehavior {
                            // `set_level(max_level)` in windows.rs -- the same
                            // `CGWindowLevelForKey(10)` the bar uses.
                            level: platform::recording_controls_level(),
                            join_all_spaces: true,
                            // `.shadow(false)` in the Tauri builder; the shape
                            // container draws its own look.
                            shadow: false,
                        },
                    );
                    platform::show_window_without_focus(window);
                })
                .ok();
        }
        Err(error) => tracing::error!("camera window failed to open: {error:#}"),
    }
}

pub fn close_camera_window(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().camera.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

/// Hand a camera frame to the preview window. Returns false when no window is
/// open (the pump drops the frame and keeps draining).
pub fn deliver_camera_frame(frame: cap_recording::NativeCameraFrame, cx: &mut App) -> bool {
    let Some(handle) = cx.global::<AppWindows>().camera else {
        return false;
    };
    handle
        .update(cx, |view, window, cx| view.frame_arrived(frame, window, cx))
        .is_ok()
}

/// Repaint the bar between its own 250ms ticks -- the mic meter updates at
/// ~20Hz and the bar is never the active window.
pub fn refresh_controls_window(cx: &mut App) {
    if let Some(handle) = cx.global::<AppWindows>().controls {
        handle
            .update(cx, |_, window, cx| {
                cx.notify();
                window.refresh();
            })
            .ok();
    }
}

fn camera_window_number(cx: &mut App) -> Option<isize> {
    let handle = cx.global::<AppWindows>().camera?;
    handle
        .update(cx, |_, window, _| platform::window_number(window))
        .ok()
        .flatten()
}

/// Where the bar goes, from `fake_window.rs`: centered under a window target
/// (48px up from its bottom edge), bottom-center of the recorded display
/// otherwise (120px up).
fn controls_origin(config: &StartConfig) -> (f64, f64) {
    use cap_recording::sources::screen_capture::ScreenCaptureTarget;

    let width = CONTROLS_WIDTH as f64;
    let height = CONTROLS_HEIGHT as f64;

    if let ScreenCaptureTarget::Window { id } = &config.target
        && let Some(window) = scap_targets::Window::from_id(id)
        && let Some(bounds) = window.raw_handle().logical_bounds()
    {
        let x = bounds.position().x() + (bounds.size().width() - width) / 2.;
        let y = bounds.position().y() + bounds.size().height() - height - TARGET_CONTROLS_OFFSET_Y;
        return (x, y);
    }

    let display = match &config.target {
        ScreenCaptureTarget::Display { id } => scap_targets::Display::from_id(id),
        _ => scap_targets::Display::get_containing_cursor(),
    }
    .unwrap_or_else(scap_targets::Display::primary);

    match display.raw_handle().logical_bounds() {
        Some(bounds) => (
            bounds.position().x() + (bounds.size().width() - width) / 2.,
            bounds.position().y() + bounds.size().height() - height - CONTROLS_BOTTOM_OFFSET,
        ),
        None => (0., 0.),
    }
}

/// Open the bar. Returns the native window number for capture exclusion.
fn open_controls(
    config: &StartConfig,
    session: Entity<RecordingSession>,
    cx: &mut App,
) -> Option<scap_targets::WindowId> {
    let (x, y) = controls_origin(config);
    let has_microphone = config.microphone.is_some();

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(x as f32), px(y as f32)),
                size: size(px(CONTROLS_WIDTH), px(CONTROLS_HEIGHT)),
            })),
            // No titlebar at all: with one, the panel still draws standard
            // window buttons floating in the transparent top of the window.
            titlebar: None,
            // Non-activating panel: clickable without pulling focus from the
            // app being recorded -- the tauri_nspanel behavior.
            kind: WindowKind::PopUp,
            focus: false,
            show: true,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| ControlsWindow::new(session, has_microphone, window, cx)),
    );

    match handle {
        Ok(handle) => {
            cx.global_mut::<AppWindows>().controls = Some(handle);
            // Panel treatment AFTER open_window returns: inside the builder
            // closure the platform window is not finished and gpui's own
            // PopUp setup would override the level.
            let number = handle
                .update(cx, |_, window, _| {
                    platform::apply_panel_behavior(
                        window,
                        platform::PanelBehavior {
                            level: platform::recording_controls_level(),
                            join_all_spaces: true,
                            // `.shadow(false)` in the Tauri builder: the bar
                            // draws its own shadow-free card.
                            shadow: false,
                        },
                    );
                    // `order_front_regardless` in the Tauri flow: front without
                    // taking key status from the app being recorded.
                    platform::show_window_without_focus(window);
                    platform::window_number(window)
                })
                .ok()
                .flatten()?;
            number.to_string().parse().ok()
        }
        Err(error) => {
            tracing::error!("recording controls window failed to open: {error:#}");
            None
        }
    }
}

fn close_controls(session: &Entity<RecordingSession>, cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().controls.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    session.update(cx, |session, cx| session.set_controls_open(false, cx));
}
