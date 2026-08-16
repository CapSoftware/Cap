//! Multi-window orchestration -- the `windows.rs` of the gpui app.
//!
//! The registry lives in a global; the recording flow is driven by observing
//! the [`RecordingSession`]: the caller opens the bar and hides the main
//! window *before* starting the engine (the bar's window number has to exist
//! to be excluded from capture, and the real app shows the bar in its
//! "Starting" state from t=0), and the observer closes the bar and reshows the
//! main window whenever the session comes back to rest.

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    App, AppContext as _, Bounds, Entity, Global, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, point, px, size,
};
use scap_targets::DisplayId;

use crate::{
    camera_window::{self, CameraWindow},
    controls_window::ControlsWindow,
    main_window::{MainWindow, Mode, TargetType},
    platform,
    recording::{RecordingMode, StartConfig},
    session::{Phase, RecordingSession},
    target_overlay::{AreaRect, HoveredWindow, OverlayWindow, TargetSelect},
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
    /// One target-select overlay per display, keyed by display so a mode
    /// switch can keep the ones it still wants.
    pub overlays: Vec<(DisplayId, WindowHandle<OverlayWindow>)>,
}

impl Global for AppWindows {}

/// Install the registry and wire the session observer that tears the bar down
/// when a recording ends (stop, delete, or a failed start).
pub fn init(main: WindowHandle<MainWindow>, session: Entity<RecordingSession>, cx: &mut App) {
    cx.set_global(AppWindows {
        main,
        controls: None,
        camera: None,
        overlays: Vec::new(),
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

/// What the main window is asking the overlays to show.
#[derive(Clone)]
pub struct OverlayRequest {
    pub mode: TargetType,
    pub recording_mode: Mode,
    /// Restrict the overlays to one display. The Tauri command takes the same
    /// two narrowing inputs (`focused_target`, `specific_display_id`): a
    /// display picked from the main window's dropdown, or the display the
    /// picked window lives on.
    pub display: Option<DisplayId>,
    /// A window picked in the main window: the overlay pins its highlight to
    /// that window instead of following the cursor, the way the Tauri poll
    /// substitutes `focused_target`'s window for `get_topmost_at_cursor`.
    pub pinned_window: Option<scap_targets::WindowId>,
}

/// Everything the overlay needs about a pinned window, resolved once when the
/// overlays open. Cheap enough for the main thread (one window-list walk); the
/// cursor probe does the same work on the background executor because it does
/// it every 80ms.
fn resolve_window(id: &scap_targets::WindowId) -> Option<HoveredWindow> {
    HoveredWindow::from_window(&scap_targets::Window::from_id(id)?)
}

/// Open (or re-target) the fullscreen overlays.
///
/// A mode change tears the old windows down first: the overlay carries
/// per-mode state -- an area selection above all -- and re-opening is both
/// cheaper to reason about and what the Tauri flow does (the webviews are
/// recreated with a new `targetMode` query parameter).
pub fn open_target_overlays(request: OverlayRequest, cx: &mut App) {
    let select = TargetSelect::global(cx);
    let mode_changed = select.read(cx).mode != Some(request.mode);
    if mode_changed {
        close_overlay_windows(cx);
    }

    let pinned = request.pinned_window.as_ref().and_then(resolve_window);
    let display = request
        .display
        .clone()
        .or_else(|| pinned.as_ref().map(|window| window.display_id.clone()));

    select.update(cx, |select, cx| {
        select.arm(Some(request.mode), request.recording_mode, pinned, cx)
    });

    let displays = match &display {
        Some(id) => scap_targets::Display::from_id(id)
            .map(|display| vec![display])
            .unwrap_or_default(),
        None => scap_targets::Display::list(),
    };
    let displays = if displays.is_empty() {
        vec![scap_targets::Display::primary()]
    } else {
        displays
    };
    let wanted: Vec<DisplayId> = displays.iter().map(|display| display.id()).collect();

    // Drop overlays for displays this request no longer covers.
    let stale: Vec<_> = cx
        .global::<AppWindows>()
        .overlays
        .iter()
        .filter(|(id, _)| !wanted.contains(id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        close_overlay(&id, cx);
    }

    let focus_display = scap_targets::Display::get_containing_cursor()
        .map(|display| display.id())
        .filter(|id| wanted.contains(id))
        .or_else(|| wanted.first().cloned());

    for display in displays {
        let id = display.id();
        if cx
            .global::<AppWindows>()
            .overlays
            .iter()
            .any(|(existing, _)| existing == &id)
        {
            continue;
        }
        open_overlay(&display, select.clone(), Some(&id) == focus_display.as_ref(), cx);
    }
}

/// Close the overlays and clear the main window's armed target -- Escape, the
/// overlay's own close button, or the main window toggling the mode off.
pub fn dismiss_target_overlays(cx: &mut App) {
    close_target_overlays(cx);
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _window, cx| view.clear_target(cx)).ok();
}

/// Close the overlays and disarm the cursor probe, leaving the main window's
/// selection alone.
pub fn close_target_overlays(cx: &mut App) {
    close_overlay_windows(cx);
    let select = TargetSelect::global(cx);
    select.update(cx, |select, cx| {
        let recording_mode = select.recording_mode;
        select.arm(None, recording_mode, None, cx);
    });
}

/// Repaint every overlay. The cursor probe runs while none of them is the
/// active window, and an inactive window only repaints when told to.
pub fn refresh_target_overlays(cx: &mut App) {
    let handles: Vec<_> = cx
        .global::<AppWindows>()
        .overlays
        .iter()
        .map(|(_, handle)| *handle)
        .collect();
    for handle in handles {
        handle
            .update(cx, |_, window, cx| {
                cx.notify();
                window.refresh();
            })
            .ok();
    }
}

/// The overlays' native window numbers, for capture exclusion.
fn overlay_window_ids(cx: &mut App) -> Vec<scap_targets::WindowId> {
    let handles: Vec<_> = cx
        .global::<AppWindows>()
        .overlays
        .iter()
        .map(|(_, handle)| *handle)
        .collect();
    handles
        .into_iter()
        .filter_map(|handle| {
            handle
                .update(cx, |_, window, _| platform::window_number(window))
                .ok()
                .flatten()
        })
        .filter_map(|number| number.to_string().parse().ok())
        .collect()
}

/// The overlay's Start button: overlays down, then the main window's start
/// path with the target the overlay resolved.
pub fn start_recording_from_overlay(target: ScreenCaptureTarget, cx: &mut App) {
    // Collected before the windows go away: the capture starts a beat after
    // this, and an overlay that has not finished closing must not end up in
    // the recording.
    let excluded = overlay_window_ids(cx);
    close_target_overlays(cx);

    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, window, cx| {
        view.start_recording_with_target(target, excluded, window, cx)
    })
    .ok();
}

/// Seed an area selection on the overlay for a display (harness path -- the
/// real one is a mouse drag, and unprivileged synthetic drags are dropped).
pub fn seed_area_selection(display: Option<DisplayId>, crop: AreaRect, cx: &mut App) -> bool {
    let Some(handle) = overlay_handle(display, cx) else {
        return false;
    };
    handle
        .update(cx, |view, _window, cx| view.set_crop(crop, cx))
        .is_ok()
}

/// Drive an overlay's Start button (harness path).
pub fn start_from_overlay(display: Option<DisplayId>, cx: &mut App) -> bool {
    let Some(handle) = overlay_handle(display, cx) else {
        return false;
    };
    handle
        .update(cx, |view, window, cx| view.start_recording(window, cx))
        .is_ok()
}

fn overlay_handle(
    display: Option<DisplayId>,
    cx: &App,
) -> Option<WindowHandle<OverlayWindow>> {
    let overlays = &cx.global::<AppWindows>().overlays;
    match display {
        Some(id) => overlays
            .iter()
            .find(|(existing, _)| existing == &id)
            .map(|(_, handle)| *handle),
        None => overlays.first().map(|(_, handle)| *handle),
    }
}

fn open_overlay(
    display: &scap_targets::Display,
    select: Entity<TargetSelect>,
    focus: bool,
    cx: &mut App,
) {
    let Some(bounds) = display.raw_handle().logical_bounds() else {
        tracing::error!("display has no logical bounds; overlay not opened");
        return;
    };
    let width = bounds.size().width();
    let height = bounds.size().height();

    let handle = cx.open_window(
        WindowOptions {
            // The origin is corrected right after opening -- gpui's own
            // window-origin math cannot express "cover this display" (see
            // `platform::set_window_frame_cg`). The size is honoured, and it is
            // the size the renderer is built for.
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(0.), px(0.)),
                size: size(px(width as f32), px(height as f32)),
            })),
            titlebar: None,
            // `NSWindowStyleMaskNonActivatingPanel` in windows.rs: the overlay
            // takes clicks without activating the app over the one being
            // recorded.
            kind: WindowKind::PopUp,
            focus: false,
            // Shown once it has been moved onto its display, so it never
            // paints a frame in the wrong place.
            show: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        {
            let display = *display;
            move |window, cx| cx.new(|cx| OverlayWindow::new(&display, select, window, cx))
        },
    );

    match handle {
        Ok(handle) => {
            cx.global_mut::<AppWindows>()
                .overlays
                .push((display.id(), handle));
            // Only *read* the native handle while the App is borrowed; the
            // AppKit calls that move, raise and show the panel synchronously
            // re-enter gpui's own window callbacks, so they run from a fresh
            // runloop turn where nothing is borrowed (see
            // `platform::place_overlay_panel`).
            let native = handle
                .update(cx, |_, window, _| platform::native_window(window))
                .ok()
                .flatten();
            let (x, y) = (bounds.position().x(), bounds.position().y());
            cx.spawn(async move |cx| {
                if let Some(native) = &native {
                    platform::place_overlay_panel(
                        native,
                        x,
                        y,
                        width,
                        height,
                        platform::target_overlay_level(),
                    );
                }
                handle
                    .update(cx, |view, window, cx| {
                        // Restart the macOS 26 display link now that the
                        // window is visible (the unit-3 finding).
                        platform::kick_display_link(window);
                        if focus {
                            // Escape is a key handler on the overlay here
                            // rather than the Tauri app's global shortcut, so
                            // one overlay has to hold focus for it to arrive.
                            let focus_handle = view.focus_handle();
                            window.focus(&focus_handle, cx);
                        }
                        window.refresh();
                    })
                    .ok();
            })
            .detach();
        }
        Err(error) => tracing::error!("target select overlay failed to open: {error:#}"),
    }
}

fn close_overlay(id: &DisplayId, cx: &mut App) {
    let overlays = &mut cx.global_mut::<AppWindows>().overlays;
    let Some(index) = overlays.iter().position(|(existing, _)| existing == id) else {
        return;
    };
    let (_, handle) = overlays.remove(index);
    handle
        .update(cx, |_, window, _| window.remove_window())
        .ok();
}

fn close_overlay_windows(cx: &mut App) {
    let overlays = std::mem::take(&mut cx.global_mut::<AppWindows>().overlays);
    for (_, handle) in overlays {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

/// The whole start flow: bar up (in its Starting state), main window hidden,
/// engine started with the bar excluded from capture.
pub fn begin_recording(config: StartConfig, cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle {
        return;
    }

    let mut excluded: Vec<scap_targets::WindowId> = config.excluded_windows.clone();
    excluded.extend(open_controls(&config, session.clone(), cx));
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
