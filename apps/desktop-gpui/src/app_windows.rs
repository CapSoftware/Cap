//! Multi-window orchestration -- the `windows.rs` of the gpui app.
//!
//! The registry lives in a global; the recording flow is driven by observing
//! the [`RecordingSession`]: the caller opens the bar and hides the main
//! window *before* starting the engine (the bar's window number has to exist
//! to be excluded from capture, and the real app shows the bar in its
//! "Starting" state from t=0), and the observer closes the bar and reshows the
//! main window whenever the session comes back to rest.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    App, AppContext as _, Bounds, Entity, Global, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, point, px, size,
};
use scap_targets::DisplayId;

use crate::{
    camera_window::{self, CameraWindow},
    controls_window::ControlsWindow,
    editor_timeline,
    editor_window::{self, EditorWindow},
    main_window::{MainWindow, Mode, TargetType},
    mode_select_window::{self, ModeSelectWindow},
    onboarding_window::{self, OnboardingWindow},
    platform,
    recording::{RecordingMode, StartConfig},
    screenshot_editor::{self, ScreenshotEditorWindow},
    session::{Phase, RecordingSession},
    settings_window::{self, Page, SettingsWindow},
    target_overlay::{AreaRect, HoveredWindow, OverlayWindow, TargetSelect},
    teleprompter_window::{self, TeleprompterWindow},
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
    pub settings: Option<WindowHandle<SettingsWindow>>,
    pub onboarding: Option<WindowHandle<OnboardingWindow>>,
    pub mode_select: Option<WindowHandle<ModeSelectWindow>>,
    pub teleprompter: Option<WindowHandle<TeleprompterWindow>>,
    /// One target-select overlay per display, keyed by display so a mode
    /// switch can keep the ones it still wants.
    pub overlays: Vec<(DisplayId, WindowHandle<OverlayWindow>)>,
    /// One editor per `.cap` path, reused on re-open -- the gpui spelling of
    /// `EditorWindowIds { ids: Arc<Mutex<Vec<(PathBuf, u32)>>> }`
    /// (`windows.rs:3656-3659`). The Tauri app keys its label off an
    /// incrementing id; the path is the identity in both.
    pub editors: Vec<(PathBuf, WindowHandle<EditorWindow>)>,
    deleting_editors: HashSet<PathBuf>,
    /// One screenshot editor per `.cap` bundle -- the gpui spelling of
    /// `ScreenshotEditorWindowIds`, keyed by the bundle directory.
    pub screenshot_editors: Vec<(PathBuf, WindowHandle<ScreenshotEditorWindow>)>,
    /// `hasHiddenMainWindowForPicker` (`new-main/index.tsx:2016-2059`): the
    /// main window hides while the target picker is up, and comes back only on
    /// a dismissal that reveals ("cancelled" -- Escape, the overlay's close
    /// button, the tile toggled off). A recording start hands the foreground
    /// to the bar instead. Set even when the window was already hidden (the
    /// tray path): the Tauri effect does the same, which is why cancelling a
    /// tray-opened picker reveals the main window.
    pub main_hidden_for_picker: bool,
    /// `hiddenForPicker` in the editor's record modal
    /// (`ClipsSidebar.tsx:311-341, 413-426`): the editor window that hid
    /// itself for an editor-owned target picker ("Record a new clip"). A
    /// cancelled dismissal reveals *that* editor -- never the main window --
    /// and clears the session's editor recording target; a recording start
    /// clears the flag without revealing, because the editor stays hidden
    /// until the finish path hands it the foreground.
    pub editor_hidden_for_picker: Option<PathBuf>,
    /// Where the camera bubble sat before a window picker parked it inside the
    /// highlighted window -- see [`CameraPark`].
    pub camera_park: CameraPark,
    #[cfg(target_os = "linux")]
    clean_capture: Option<CleanCaptureUi>,
    #[cfg(target_os = "linux")]
    clean_capture_generation: u64,
}

#[cfg(target_os = "linux")]
struct CleanCaptureUi {
    generation: u64,
    config: Option<StartConfig>,
    gate: CleanCaptureGate,
    camera: Option<WindowHandle<CameraWindow>>,
    camera_was_visible: bool,
    main_was_visible: bool,
    requested_inputs: CleanCaptureInputs,
    preview_was_rendering: Option<bool>,
    wayland: bool,
    retained_windows: Vec<(gpui::AnyWindowHandle, bool)>,
    restoring: bool,
    restoration_error: Option<String>,
}

#[cfg(target_os = "linux")]
impl CleanCaptureUi {
    fn begin_restore(&mut self) -> bool {
        self.config = None;
        if self.restoring {
            return false;
        }
        self.restoring = true;
        true
    }

    fn prepare_restore_retry(&mut self, phase: Phase, instant_cleanup_safe: bool) -> bool {
        if phase != Phase::Idle
            || !instant_cleanup_safe
            || !self.wayland
            || self.restoration_error.is_none()
        {
            return false;
        }
        self.config = None;
        self.restoration_error = None;
        self.restoring = false;
        true
    }

    fn take_start_config(&mut self, generation: u64) -> Option<StartConfig> {
        if self.generation != generation
            || !self.gate.started
            || self.restoring
            || self.restoration_error.is_some()
        {
            return None;
        }
        self.config.take()
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum CleanCaptureReopenAction {
    Continue,
    RetryRestore,
    WaitForRestore,
}

#[cfg(target_os = "linux")]
fn clean_capture_reopen_action(
    lease: Option<&mut CleanCaptureUi>,
    phase: Phase,
    instant_cleanup_safe: bool,
) -> CleanCaptureReopenAction {
    let Some(lease) = lease else {
        return CleanCaptureReopenAction::Continue;
    };
    if lease.prepare_restore_retry(phase, instant_cleanup_safe) {
        CleanCaptureReopenAction::RetryRestore
    } else if lease.wayland && lease.restoring {
        CleanCaptureReopenAction::WaitForRestore
    } else {
        CleanCaptureReopenAction::Continue
    }
}

#[cfg(target_os = "linux")]
#[derive(PartialEq)]
struct CleanCaptureInputs {
    camera: Option<crate::recording::DeviceOrModelID>,
    microphone: Option<String>,
}

#[cfg(target_os = "linux")]
impl CleanCaptureInputs {
    fn current(cx: &App) -> Self {
        let feeds = crate::feeds::Feeds::global(cx);
        let feeds = feeds.read(cx);
        Self {
            camera: feeds.camera.as_ref().map(|camera| camera.id.clone()),
            microphone: feeds.microphone.clone(),
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct CleanCaptureGate {
    pressed: bool,
    started: bool,
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum CleanCaptureAction {
    Start,
    Stop,
}

#[cfg(target_os = "linux")]
impl CleanCaptureGate {
    fn shortcut(&mut self, state: global_hotkey::HotKeyState) -> Option<CleanCaptureAction> {
        if state == global_hotkey::HotKeyState::Pressed {
            self.pressed = true;
            return None;
        }
        if !std::mem::take(&mut self.pressed) {
            return None;
        }
        if self.started {
            Some(CleanCaptureAction::Stop)
        } else {
            self.started = true;
            Some(CleanCaptureAction::Start)
        }
    }
}

#[derive(Default)]
pub struct CameraPark {
    original: Option<CameraSnapshot>,
    mode: Option<TargetType>,
    last_window: Option<scap_targets::WindowId>,
    last_area: Option<AreaRect>,
    area_target: Option<(DisplayId, AreaRect)>,
    released: bool,
    epoch: u64,
    generation: u64,
    pending: Option<CameraPlacement>,
}

#[derive(Clone, Copy)]
struct CameraSnapshot {
    handle: WindowHandle<CameraWindow>,
    bounds: AreaRect,
    picker_size: Option<(f32, f32)>,
}

#[derive(Clone, Copy)]
enum CameraSizeOverride {
    Preserve,
    Set(Option<(f32, f32)>),
}

#[derive(Clone, Copy)]
struct CameraPlacement {
    camera: WindowHandle<CameraWindow>,
    bounds: AreaRect,
    size_override: CameraSizeOverride,
}

impl CameraPark {
    fn invalidate_pending(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
    }

    fn reset_selection(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.original = None;
        self.mode = None;
        self.last_window = None;
        self.last_area = None;
        self.area_target = None;
        self.released = false;
    }
}

impl Global for AppWindows {}

fn remove_popup_window_chrome(native: Option<platform::NativeWindow>, cx: &mut App) {
    let Some(native) = native else {
        return;
    };

    cx.spawn(async move |_| platform::remove_popup_window_chrome(&native))
        .detach();
}

pub(crate) fn export_in_flight(cx: &App) -> bool {
    if !cx.has_global::<AppWindows>() {
        return false;
    }

    let windows = cx.global::<AppWindows>();
    windows.editors.iter().any(|(_, handle)| {
        handle
            .read(cx)
            .ok()
            .and_then(|editor| editor.export.as_ref())
            .is_some_and(|export| export.phase.is_busy())
    }) || windows.screenshot_editors.iter().any(|(_, handle)| {
        handle
            .read(cx)
            .is_ok_and(ScreenshotEditorWindow::export_in_flight)
    })
}

pub(crate) fn flush_pending_editor_saves(cx: &mut App) {
    if !cx.has_global::<AppWindows>() {
        return;
    }

    let windows = cx.global::<AppWindows>();
    let editors: Vec<_> = windows.editors.iter().map(|(_, handle)| *handle).collect();
    let screenshot_editors: Vec<_> = windows
        .screenshot_editors
        .iter()
        .map(|(_, handle)| *handle)
        .collect();

    for handle in editors {
        if let Ok(pending) = handle.update(cx, |editor, _, _| editor.pending_save()) {
            pending.borrow_mut().flush();
        }
    }

    for handle in screenshot_editors {
        if let Ok(pending) = handle.update(cx, |editor, _, _| editor.pending_save()) {
            pending.borrow_mut().flush();
        }
    }
}

/// Install the registry and wire the session observer that tears the bar down
/// when a recording ends (stop, delete, or a failed start).
pub fn init(main: WindowHandle<MainWindow>, session: Entity<RecordingSession>, cx: &mut App) {
    cx.set_global(AppWindows {
        main,
        controls: None,
        camera: None,
        settings: None,
        onboarding: None,
        mode_select: None,
        teleprompter: None,
        overlays: Vec::new(),
        editors: Vec::new(),
        deleting_editors: HashSet::new(),
        screenshot_editors: Vec::new(),
        main_hidden_for_picker: false,
        editor_hidden_for_picker: None,
        camera_park: CameraPark::default(),
        #[cfg(target_os = "linux")]
        clean_capture: None,
        #[cfg(target_os = "linux")]
        clean_capture_generation: 0,
    });

    // The global-Escape drain: the Carbon hotkey (registered only while the
    // target picker is up -- `open_target_overlays`) posts here, and the
    // dismissal runs with a clean borrow. One task for the life of the
    // process, the tray-channel shape.
    let escape = platform::escape_hotkey_events();
    cx.spawn(async move |cx| {
        while escape.recv_async().await.is_ok() {
            cx.update(|cx| {
                if TargetSelect::global(cx).read(cx).mode.is_some() {
                    dismiss_target_overlays(cx);
                }
            });
        }
    })
    .detach();

    let mut last_phase = Phase::Idle;
    cx.observe(&session, move |session, cx| {
        let phase = session.read(cx).phase;
        let recording = matches!(phase, Phase::Recording { .. });
        if recording != matches!(last_phase, Phase::Recording { .. }) {
            // `RecordingStarted` / `RecordingStopped` in `create_tray`: the
            // status item becomes a stop button while a capture runs.
            crate::tray::set_recording(recording, cx);
        }
        if phase == Phase::Idle && last_phase != Phase::Idle {
            #[cfg(target_os = "linux")]
            if !session.read(cx).instant_cleanup_safe() {
                return;
            }
            close_controls(&session, cx);
            close_target_overlays(cx);
            #[cfg(target_os = "linux")]
            if !restore_clean_capture_ui(cx) {
                return;
            }
            let finished_studio = session.update(cx, |session, _| session.finished_studio.take());
            // The in-editor re-record target is consumed first, before
            // `postStudioRecordingBehaviour` is even consulted -- the order
            // `apply_post_studio_editor_behaviour` checks them
            // (`src-tauri/src/recording.rs:3268-3287`). `take` on every path,
            // clean or not: the fallback at `recording.rs:3225-3237` does the
            // same so a cancelled or failed recording still restores the
            // editor and cannot leak its target into the next session.
            let main = cx.global::<AppWindows>().main;
            main.update(cx, |view, _, _| {
                view.cancel_deep_link_start();
            })
            .ok();
            let editor_target =
                session.update(cx, |session, _| session.take_editor_recording_target());
            if let Some(editor_path) = editor_target {
                editor_recording_finished(editor_path, finished_studio, cx);
            } else {
                // `postStudioRecordingBehaviour` (`openEditor` is the
                // default): a cleanly-stopped studio recording goes straight
                // to the editor, main window staying hidden --
                // `editor_closed` brings it back once the last editor goes
                // away. Every other path (instant, failures, `showOverlay`
                // until an overlay exists) reshows the main window as before.
                let editor_project = finished_studio.filter(|_| {
                    crate::store::GeneralSettings::load().post_studio_recording_behaviour
                        == crate::store::PostStudioBehaviour::OpenEditor
                });
                match editor_project {
                    Some(project_dir) => open_editor(project_dir, cx),
                    None => show_main_window(cx),
                }
            }
            // `NewStudioRecordingAdded` -> `add_new_item_to_cache` +
            // `refresh_tray_menu`. The reshow is where the main window's own
            // Recents is rescanned, so the tray's Previous rides the same seam.
            crate::tray::refresh_previous(cx);
            // `apply_content_protection(app, false)` in `clear_recording_state`
            // (`lib.rs:896-912`) when the recording ends: an always-excluded
            // window is invisible on capture-based displays, so the protection
            // only holds while a capture is running. This is the one seam every
            // ending passes through -- a clean stop, the bar's delete, and a
            // start that failed all land on `Phase::Idle`. (A *restart* does
            // not: it goes `Recording -> Starting -> Idle -> Starting` inside a
            // single entity update, so the observer never sees `Idle` and the
            // protection carries into the new recording -- which is the Tauri
            // net effect too, where `restart_recording` clears it and the
            // immediately-following `start_recording` puts it straight back.)
            restore_content_protection(cx);
        }
        last_phase = phase;
    })
    .detach();

    // The `cap-desktop://action` executor (see `crate::deeplink`): started
    // here because the actions dispatch into this registry, which now exists.
    // The Tauri app orders it the same way -- `DeepLinkActionExecutor::new` in
    // `setup`, before `on_open_url` is wired (`lib.rs:5449`).
    crate::deeplink::init(cx);
}

/// `createThemeListener` + `commands.setTheme`: persist is already done; this
/// forces native appearance on every open window and invalidates so each
/// `sync_appearance` rebuilds the palette.
pub fn broadcast_theme(cx: &mut App) {
    if !cx.has_global::<AppWindows>() {
        return;
    }
    let windows = cx.global::<AppWindows>();
    let main = windows.main;
    let settings = windows.settings;
    let onboarding = windows.onboarding;
    let mode_select = windows.mode_select;
    let teleprompter = windows.teleprompter;
    let controls = windows.controls;
    let camera = windows.camera;
    let overlays: Vec<_> = windows.overlays.iter().map(|(_, handle)| *handle).collect();
    let editors: Vec<_> = windows.editors.iter().map(|(_, handle)| *handle).collect();
    let screenshot_editors: Vec<_> = windows
        .screenshot_editors
        .iter()
        .map(|(_, handle)| *handle)
        .collect();

    let refresh = |window: &mut gpui::Window, cx: &mut gpui::App| {
        crate::theme::apply_native(window, cx);
    };

    let _ = main.update(cx, |_, window, cx| {
        refresh(window, cx);
        cx.notify();
    });
    if let Some(handle) = settings {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = onboarding {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = mode_select {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = teleprompter {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = controls {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = camera {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    for handle in overlays {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    for handle in editors {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    for handle in screenshot_editors {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
}

/// `makeKeyAndOrderFront:` re-enters gpui's window callbacks, so it runs from
/// a task, never inside the borrow that decided to call it (the
/// `place_overlay_panel` rule).
///
/// Public because the tray's "Open Main Window" is exactly this
/// (`ShowCapWindow::Main { init_target_mode: None }`).
pub fn show_main_window(cx: &mut App) {
    #[cfg(target_os = "linux")]
    {
        let session = RecordingSession::global(cx);
        let phase = session.read(cx).phase;
        let instant_cleanup_safe = session.read(cx).instant_cleanup_safe();
        match clean_capture_reopen_action(
            cx.global_mut::<AppWindows>().clean_capture.as_mut(),
            phase,
            instant_cleanup_safe,
        ) {
            CleanCaptureReopenAction::RetryRestore => {
                begin_retained_capture_restore(cx);
                return;
            }
            CleanCaptureReopenAction::WaitForRestore => return,
            CleanCaptureReopenAction::Continue => {}
        }
    }
    #[cfg(target_os = "linux")]
    if clean_capture_active(cx) && RecordingSession::global(cx).read(cx).phase != Phase::Idle {
        RecordingSession::global(cx).update(cx, |session, cx| {
            session.show_clean_capture_controls(cx);
        });
        return;
    }
    show_main_window_after_capture_pause(cx);
}

pub(crate) fn show_main_window_after_capture_pause(cx: &mut App) {
    #[cfg(target_os = "linux")]
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle
        && !RecordingSession::global(cx).read(cx).instant_cleanup_safe()
    {
        RecordingSession::global(cx).update(cx, |session, cx| session.stop(cx));
        return;
    }
    #[cfg(target_os = "linux")]
    if clean_capture_active(cx) {
        let session = RecordingSession::global(cx);
        if !session.read(cx).clean_capture_controls_safe() {
            session.update(cx, |session, cx| session.show_clean_capture_controls(cx));
            return;
        }
    }
    if crate::store::should_show_onboarding() {
        open_onboarding(cx);
        return;
    }
    let resume_inputs = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
    if resume_inputs {
        crate::feeds::Feeds::global(cx).update(cx, |feeds, cx| feeds.resume_camera_preview(cx));
    }
    let reset_target = RecordingSession::global(cx).read(cx).phase == Phase::Idle
        && cx.global::<AppWindows>().editor_hidden_for_picker.is_none();
    if reset_target {
        let picker_open = {
            let windows = cx.global::<AppWindows>();
            windows.main_hidden_for_picker || !windows.overlays.is_empty()
        };
        if picker_open {
            close_target_overlays(cx);
        }
        cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    }
    let main = cx.global::<AppWindows>().main;
    let native = main
        .update(cx, |view, window, cx| {
            if resume_inputs {
                view.resume_device_restore(cx);
            }
            if reset_target {
                view.show_recorder(cx);
                view.clear_target(cx);
            }
            // Every path back to the main window is a path a new capture may
            // have arrived on -- a finished recording most of all. The Tauri
            // app gets this from `invalidateRecentMedia` plus the query's
            // focus gate; here the reshow *is* the trigger, so a recording
            // made a moment ago is in the list without a restart.
            view.refresh_recents(window, cx);
            #[cfg(target_os = "linux")]
            if window.retained_visibility().is_some() {
                match window.set_retained_visibility(true) {
                    Ok(receipt) => observe_visibility(receipt, true, cx),
                    Err(error) => tracing::warn!(%error, "could not restore the main window"),
                }
            } else if let Err(error) = platform::set_x11_window_visible(window, true) {
                tracing::warn!(%error, "could not show the X11 main window");
            }
            platform::native_window(window)
        })
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            // The recording flow leaves foreign titlebar buttons on the
            // hidden window (see `restore_borderless_style`); strip them
            // before the window is visible again.
            platform::restore_borderless_style(native);
            platform::show_native(native);
        }
        // The unit-3 macOS 26 display-link repair, and the reason a window
        // hidden before its FIRST paint reshows as nothing at all: AppKit
        // reports it visible (alpha 1, on the active Space) but it has no
        // backing surface and the frozen link never delivers one. Kick it and
        // ask for a frame, the `open_settings` recipe.
        cx.update(|cx| {
            main.update(cx, |_, window, cx| {
                platform::kick_display_link(window);
                cx.notify();
                window.refresh();
            })
            .ok();
        });
        // `ShowCapWindow::show` ends with `sync_macos_dock_visibility` for
        // every window that `activates_dock()`, and Main is one. Scheduled
        // *after* the window is on screen, or the policy would be computed
        // from a still-hidden window. An Accessory app also has no menu bar,
        // so the sync's `cx.activate(true)` is what brings both back.
        cx.update(crate::menus::schedule_dock_sync);
    })
    .detach();
}

/// Re-assert the main window's borderless style mask after an operation that
/// can provoke the macOS 26 mutation (`platform::restore_borderless_style`:
/// AppKit adds `NSMiniaturizableWindowMask` on its own, materializing native
/// buttons over the hand-drawn lights). The reveal path heals in
/// [`show_main_window`], but two flows can re-trigger the mutation while the
/// window is already visible or after that heal ran: the content-protection
/// sharing-type flips around a recording, and the in-process ScreenCaptureKit
/// screenshot sweeps behind the target-picker thumbnails. Idempotent (a read
/// plus a conditional write), so calling it on every such seam is free.
///
/// Deferred, then spawned: callers include the main window's own entity
/// updates, and both the handle probe and the AppKit write must run outside
/// that lease.
pub fn heal_main_window_style(cx: &mut App) {
    if !cx.has_global::<AppWindows>() {
        return;
    }
    let main = cx.global::<AppWindows>().main;
    cx.defer(move |cx| {
        let native = main
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::restore_borderless_style(native);
            }
        })
        .detach();
    });
}

/// `getCurrentWindow().hide()` -- same rule, same reason.
pub fn hide_main_window(cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    let native = main
        .update(cx, |_, window, cx| {
            #[cfg(not(target_os = "linux"))]
            let _ = cx;
            #[cfg(target_os = "linux")]
            if window.retained_visibility().is_some() {
                match window.set_retained_visibility(false) {
                    Ok(receipt) => observe_visibility(receipt, false, cx),
                    Err(error) => tracing::warn!(%error, "could not hide the main window"),
                }
            } else if let Err(error) = platform::set_x11_window_visible(window, false) {
                tracing::warn!(%error, "could not hide the X11 main window");
            }
            platform::native_window(window)
        })
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            platform::hide_native(native);
            tracing::info!("main window hidden");
        }
        cx.update(crate::menus::schedule_dock_sync);
    })
    .detach();
}

fn hide_main_and_park_camera_preview(cx: &mut App) {
    hide_main_window(cx);

    if !camera_preview_can_be_parked(RecordingSession::global(cx).read(cx).phase) {
        return;
    }

    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _, _| {
        view.suspend_device_restore();
    })
    .ok();
    close_camera_window(cx);
    crate::feeds::Feeds::global(cx).update(cx, |feeds, cx| feeds.park_camera_preview(cx));
}

fn camera_preview_can_be_parked(phase: Phase) -> bool {
    matches!(phase, Phase::Idle)
}

pub fn request_close_main(cx: &mut App) {
    #[cfg(target_os = "linux")]
    if clean_capture_pending(cx) {
        cancel_clean_capture(cx);
        return;
    }
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle
        && RecordingSession::global(cx)
            .read(cx)
            .editor_recording_target()
            .is_some()
    {
        abort_editor_recording_flow(cx);
        return;
    }
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        let main = cx.global::<AppWindows>().main;
        main.update(cx, |view, _, _| {
            view.cancel_deep_link_start();
            view.suspend_device_restore();
        })
        .ok();
    }
    hide_main_window(cx);

    // `state.is_recording_active_or_pending()`: everything but Idle.
    if RecordingSession::global(cx).read(cx).phase != Phase::Idle {
        return;
    }

    close_camera_window(cx);
    close_target_overlays(cx);
    // Closing the main window explicitly is not a picker dismissal; a stale
    // flag here would reveal the window the user just closed.
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    crate::feeds::Feeds::global(cx).update(cx, |feeds, cx| feeds.release_inputs(cx));
}

/// `RunEvent::Reopen` (`lib.rs:6089-6133`) -- the dock icon clicked while the
/// app runs: focus an editor or the settings window when one is open,
/// otherwise show the main window. (The onboarding arm has no counterpart
/// here, and mode-select is deliberately absent from the focus list over
/// there too.) Registered on the `Application` builder in `main`, with a
/// global guard: the callback can in principle fire before `init` has run.
pub fn handle_dock_reopen(cx: &mut App) {
    if !cx.has_global::<AppWindows>() {
        return;
    }
    let live = cx
        .windows()
        .into_iter()
        .map(|handle| handle.window_id())
        .collect::<HashSet<_>>();
    {
        let windows = cx.global_mut::<AppWindows>();
        windows
            .editors
            .retain(|(_, handle)| live.contains(&handle.window_id()));
        windows
            .screenshot_editors
            .retain(|(_, handle)| live.contains(&handle.window_id()));
        windows.settings = windows
            .settings
            .filter(|handle| live.contains(&handle.window_id()));
    }
    let windows = cx.global::<AppWindows>();
    if crate::store::should_show_onboarding() {
        if windows.onboarding.is_some() {
            open_onboarding(cx);
            cx.activate(true);
            return;
        }
        open_onboarding(cx);
        cx.activate(true);
        return;
    }
    let candidates = windows
        .editors
        .iter()
        .map(|(_, handle)| gpui::AnyWindowHandle::from(*handle))
        .chain(
            windows
                .screenshot_editors
                .iter()
                .map(|(_, handle)| (*handle).into()),
        )
        .chain(windows.settings.map(Into::into))
        .collect::<Vec<_>>();
    let focus = first_registered_reopen_target(candidates, &live);
    tracing::info!(focus_existing = focus.is_some(), "dock reopen");
    match focus {
        Some(handle) => {
            cx.defer(move |cx| {
                if !cx
                    .windows()
                    .iter()
                    .any(|current| current.window_id() == handle.window_id())
                {
                    handle_dock_reopen(cx);
                    return;
                }
                let native = match handle.update(cx, |_, window, _| platform::native_window(window))
                {
                    Ok(native) => native,
                    Err(error) => {
                        tracing::warn!(%error, "could not focus the registered editor window");
                        return;
                    }
                };
                cx.spawn(async move |_| {
                    if let Some(native) = &native {
                        platform::show_native(native);
                    }
                })
                .detach();
            });
        }
        None => show_main_window(cx),
    }
    cx.activate(true);
}

fn first_registered_reopen_target(
    candidates: impl IntoIterator<Item = gpui::AnyWindowHandle>,
    live: &HashSet<gpui::WindowId>,
) -> Option<gpui::AnyWindowHandle> {
    candidates
        .into_iter()
        .find(|candidate| live.contains(&candidate.window_id()))
}

pub fn open_quality_settings(mode: Mode, cx: &mut App) {
    if mode == Mode::Screenshot {
        return;
    }
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    open_settings(Page::General, cx);
    if let Some(handle) = cx.global::<AppWindows>().settings {
        handle
            .update(cx, |view, window, cx| {
                view.show_quality_settings(mode, window, cx);
            })
            .ok();
    }
}

/// Open the settings window on a page, and hide the main window.
///
/// The header gear in `new-main/index.tsx` is
/// `await commands.showWindow({ Settings: { page: "general" } });
/// getCurrentWindow().hide();` -- both halves, in that order. Must be reached
/// through `cx.defer` from anything inside an entity update: opening a window
/// paints it synchronously and would double-lease the caller.
pub fn open_settings(page: Page, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    if let Some(handle) = cx.global::<AppWindows>().settings {
        // `ShowCapWindow::show` reuses a live window: show, focus, and let
        // the page argument re-target it.
        let native = handle
            .update(cx, |view, window, cx| {
                view.set_page(page, window, cx);
                platform::native_window(window)
            })
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_and_park_camera_preview(cx);
        return;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(settings_window::SETTINGS_WIDTH),
            px(settings_window::SETTINGS_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // A real titlebar this time, transparent with the buttons moved
            // to (22, 22): `CapWindowId::Settings::traffic_lights_position` is
            // `Some(Some(...))`, which is what keeps the native lights and
            // repositions them. (The main window returns `None` there and
            // hand-draws its own.)
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Settings".into()),
                appears_transparent: true,
                traffic_light_position: Some(settings_window::TRAFFIC_LIGHTS),
            }),
            // A normal window, not a panel: the Tauri Settings window is an
            // ordinary window that activates the dock icon
            // (`activates_dock()`), with no level or Spaces treatment.
            // `WindowKind::Floating` would hide it whenever the app
            // deactivates.
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `.resizable(true).maximized(false)`, and `min_inner_size`.
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(settings_window::SETTINGS_MIN_WIDTH),
                px(settings_window::SETTINGS_MIN_HEIGHT),
            )),
            // `builder.transparent(true)` on macOS -- the panes paint, the
            // material shows through the gap.
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| SettingsWindow::new(page, window, cx)),
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("settings window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>().settings = Some(handle);

    // Read the native handle inside the update; act on it outside.
    let native = handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            view.start_enumeration(window, cx);
            // Whatever the page it opened on has to fetch -- the Recordings
            // page's library scan. Started here rather than in
            // `SettingsWindow::new` for the `start_enumeration` reason: a task
            // spawned inside the builder closure never schedules a frame.
            view.page_shown(window, cx);
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                "settings window opened"
            );
            platform::native_window(window)
        })
        .ok()
        .flatten();

    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            let kind = platform::install_window_material(
                native,
                settings_window::SETTINGS_MATERIAL_RADIUS,
            );
            match kind {
                Some(kind) => tracing::info!(
                    ?kind,
                    radius = settings_window::SETTINGS_MATERIAL_RADIUS,
                    "installed settings window material"
                ),
                None => tracing::info!("no native window material available for settings"),
            }
            cx.update(|cx| {
                // The main window's install normally gets here first and both
                // windows resolve the same kind; this only fills the global in
                // if the settings window won the race.
                if platform::active_material(cx).is_none() {
                    cx.set_global(platform::WindowMaterial(kind));
                }
            });
        }
        handle
            .update(cx, |_, window, cx| {
                // The unit-3 macOS 26 display-link repair, once the window is
                // actually on screen.
                platform::kick_display_link(window);
                cx.notify();
                window.refresh();
            })
            .ok();
    })
    .detach();

    hide_main_and_park_camera_preview(cx);
}

/// Close the settings window from our side (Cmd-W). The close button goes
/// through `on_window_should_close` -> [`settings_closed`] instead.
pub fn close_settings(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().settings.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    restore_after_settings(cx);
}

/// The settings window is going away on its own. `CapWindowId::Settings`'s
/// `Destroyed` arm calls `restore_main_and_target_select_windows`, so the main
/// window comes back -- otherwise closing settings from the gear flow would
/// leave the app with no visible window at all.
pub fn settings_closed(cx: &mut App) {
    tracing::info!("settings window closed");
    cx.global_mut::<AppWindows>().settings.take();
    restore_after_settings(cx);
}

pub fn open_onboarding(cx: &mut App) {
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    if let Some(handle) = cx.global::<AppWindows>().onboarding {
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return;
    }

    let cursor_display = scap_targets::Display::get_containing_cursor()
        .and_then(|display| display.raw_handle().logical_bounds());
    let display = cursor_display
        .and_then(|bounds| {
            let center = point(
                px((bounds.position().x() + bounds.size().width() / 2.) as f32),
                px((bounds.position().y() + bounds.size().height() / 2.) as f32),
            );
            cx.displays()
                .into_iter()
                .find(|display| display.bounds().contains(&center))
        })
        .or_else(|| cx.primary_display());
    let bounds = match display {
        Some(display) => {
            let available = display.visible_bounds();
            let width = (f32::from(display.bounds().size.width) * 0.58)
                .clamp(onboarding_window::ONBOARDING_WIDTH, 1080.)
                .min((f32::from(available.size.width) - 32.).max(1.));
            let height = (width * 0.72)
                .clamp(onboarding_window::ONBOARDING_HEIGHT, 780.)
                .min((f32::from(available.size.height) - 32.).max(1.));
            Bounds {
                origin: available.center() - point(px(width / 2.), px(height / 2.)),
                size: size(px(width), px(height)),
            }
        }
        None => Bounds::centered(
            None,
            size(
                px(onboarding_window::ONBOARDING_WIDTH),
                px(onboarding_window::ONBOARDING_HEIGHT),
            ),
            cx,
        ),
    };

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: None,
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            is_resizable: false,
            is_minimizable: true,
            window_min_size: Some(bounds.size),
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| {
            window.set_window_title("Welcome to Cap");
            cx.new(|cx| OnboardingWindow::new(window, cx))
        },
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("onboarding window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>().onboarding = Some(handle);
    let native = handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            view.focus_root(window, cx);
            platform::native_window(window)
        })
        .ok()
        .flatten();
    cx.spawn(async move |_| {
        if let Some(native) = &native {
            let _ = platform::install_window_material(native, 16.);
            platform::show_native(native);
        }
    })
    .detach();
    hide_main_window(cx);
    crate::tray::refresh_menu(cx);
}

pub fn onboarding_finished(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().onboarding.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    crate::tray::refresh_menu(cx);
    show_main_window(cx);
}

pub fn close_onboarding(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().onboarding.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    onboarding_closed(cx);
}

pub fn onboarding_closed(cx: &mut App) {
    cx.global_mut::<AppWindows>().onboarding.take();
    crate::tray::refresh_menu(cx);
    if !crate::store::should_show_onboarding() {
        show_main_window(cx);
    }
}

pub fn onboarding_is_open(cx: &App) -> bool {
    cx.has_global::<AppWindows>() && cx.global::<AppWindows>().onboarding.is_some()
}

fn restore_after_settings(cx: &mut App) {
    // Not while recording: the main window is deliberately hidden then, and
    // the session observer brings it back when the recording ends.
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        show_main_window(cx);
        return;
    }
    // `sync_macos_dock_visibility` still has to run: a dock-activating window
    // just went away and nothing else scheduled the sync.
    crate::menus::schedule_dock_sync(cx);
}

// -- Mode select ------------------------------------------------------------

/// Open the 580x340 mode picker, and hide the main window.
///
/// `ShowCapWindow::ModeSelect` hides Main first (`windows.rs:2083-2085`) and
/// its `Destroyed` arm brings it back, exactly like Settings. Returns false if
/// the window could not be opened, which is the main window's cue to fall back
/// to its in-body mode-info panel.
///
/// Must be reached through `cx.defer` from inside an entity update: opening a
/// window paints it synchronously and would double-lease the caller.
pub fn open_mode_select(cx: &mut App) -> bool {
    if RecordingSession::global(cx)
        .read(cx)
        .editor_recording_target()
        .is_some()
    {
        return false;
    }
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return false;
    }
    let main = cx.global::<AppWindows>().main;
    let mode = main
        .update(cx, |view, _window, cx| view.effective_mode(cx))
        .unwrap_or(Mode::Instant);

    if let Some(handle) = cx.global::<AppWindows>().mode_select {
        // A live window is reused, re-reading the mode the way a re-shown
        // webview re-reads the options store.
        let native = handle
            .update(cx, |view, window, cx| {
                view.set_mode(mode, cx);
                platform::native_window(window)
            })
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return true;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(mode_select_window::MODE_SELECT_WIDTH),
            px(mode_select_window::MODE_SELECT_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // `traffic_lights_position` has no ModeSelect arm, so it takes the
            // `_ => Some(None)` catch-all: the native buttons stay where AppKit
            // puts them and only the title is hidden (`hidden_title(true)` +
            // `TitleBarStyle::Overlay`).
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Mode Selection".into()),
                appears_transparent: true,
                traffic_light_position: mode_select_window::TRAFFIC_LIGHTS,
            }),
            // An ordinary window that activates the dock icon
            // (`activates_dock()` lists ModeSelect); no level or Spaces
            // treatment, and no always-on-top (that is Upgrade's).
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `.resizable(false).maximized(false).maximizable(false)`, with
            // `min_inner_size == inner_size`.
            is_resizable: false,
            is_minimizable: true,
            // Not in `is_transparent()`'s list: this window is opaque and
            // paints its own `bg-gray-1`, with no native material behind it
            // (`applyMacOSWindowMaterial` runs in the `(window-chrome)` layout,
            // which this route is not part of).
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| ModeSelectWindow::new(mode, window, cx)),
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("mode select window failed to open: {error:#}");
            return false;
        }
    };

    cx.global_mut::<AppWindows>().mode_select = Some(handle);
    handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                "mode select window opened"
            );
        })
        .ok();

    hide_main_window(cx);
    true
}

/// The mode select window is going away: same `Destroyed` arm as Upgrade,
/// which calls `restore_main_and_target_select_windows`.
pub fn mode_select_closed(cx: &mut App) {
    cx.global_mut::<AppWindows>().mode_select.take();
    restore_after_settings(cx);
}

/// Click a mode card in the open mode select window (harness path for
/// `CAP_GPUI_AUTO_MODE_SELECT=<mode>`; synthetic clicks are dropped).
pub fn choose_mode_in_mode_select(mode: Mode, cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().mode_select else {
        return;
    };
    handle
        .update(cx, |view, window, cx| {
            view.choose(mode, cx);
            window.refresh();
        })
        .ok();
}

/// `handleModeChange`: the recording option, then `setRecordingMode`. Every
/// mode affordance -- the main window's pill, its info panel, and the mode
/// select window -- lands here.
pub fn set_recording_mode(mode: Mode, cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _window, cx| view.set_mode(mode, cx))
        .ok();
    // Open overlays label their start button with the mode.
    refresh_target_overlays(cx);
}

// -- Teleprompter -----------------------------------------------------------

/// Open (or re-show) the teleprompter -- `openTeleprompter()` in
/// `utils/teleprompter.ts`, which reuses a live window with
/// `unminimize()`/`show()`/`setFocus()` and otherwise builds a new one.
pub fn open_teleprompter(cx: &mut App) {
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    if let Some(handle) = cx.global::<AppWindows>().teleprompter {
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        return;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(teleprompter_window::TELEPROMPTER_WIDTH),
            px(teleprompter_window::TELEPROMPTER_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // `decorations: true`, `titleBarStyle: "overlay"`, `hiddenTitle:
            // true`, `trafficLightPosition: (14, 14)` -- the real AppKit
            // buttons, moved, as on the settings window.
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Teleprompter".into()),
                appears_transparent: true,
                traffic_light_position: Some(teleprompter_window::TRAFFIC_LIGHTS),
            }),
            #[cfg(target_os = "macos")]
            kind: WindowKind::Floating,
            #[cfg(not(target_os = "macos"))]
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `resizable: true`, `minWidth: 420, minHeight: 220`.
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(teleprompter_window::TELEPROMPTER_MIN_WIDTH),
                px(teleprompter_window::TELEPROMPTER_MIN_HEIGHT),
            )),
            // `transparent: true`, `shadow: true`: the shell paints a tint and
            // the material shows through.
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| TeleprompterWindow::new(window, cx)),
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("teleprompter window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>().teleprompter = Some(handle);

    // `commands.refreshWindowContentProtection()` on open
    // (`src/utils/teleprompter.ts:26,38,64`): a window that appears *after* the
    // capture started missed `begin_recording`'s pass, and its id can no longer
    // join the content filter -- the sharing type is the only lever left.
    if RecordingSession::global(cx).read(cx).phase != Phase::Idle {
        set_teleprompter_content_protection(true, cx);
    }

    let opened = handle
        .update(cx, |view, window, cx| {
            // `commands.setTeleprompterWindowLevel(true)` -- level 101, and the
            // `visibleOnAllWorkspaces` half.
            platform::apply_panel_behavior(
                window,
                platform::PanelBehavior {
                    level: platform::teleprompter_level(),
                    join_all_spaces: true,
                    // `shadow: true` in the window options.
                    shadow: true,
                },
            );
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                level = platform::teleprompter_level(),
                "teleprompter window opened"
            );
            (platform::native_window(window), view.window_alpha())
        })
        .ok();

    let Some((native, alpha)) = opened else {
        return;
    };

    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            // `applyMacOSWindowMaterial("teleprompter")`: radius 22 on glass.
            let kind = platform::install_window_material(
                native,
                teleprompter_window::TELEPROMPTER_MATERIAL_RADIUS,
            );
            match kind {
                Some(kind) => tracing::info!(
                    ?kind,
                    radius = teleprompter_window::TELEPROMPTER_MATERIAL_RADIUS,
                    "installed teleprompter window material"
                ),
                None => tracing::info!("no native window material available for the teleprompter"),
            }
            // The opacity effect's first run.
            let applied = platform::set_window_alpha(native, alpha);
            tracing::info!(requested = alpha, applied, "teleprompter window alpha");
            cx.update(|cx| {
                if platform::active_material(cx).is_none() {
                    cx.set_global(platform::WindowMaterial(kind));
                }
            });
        }
        handle
            .update(cx, |_, window, cx| {
                platform::kick_display_link(window);
                cx.notify();
                window.refresh();
            })
            .ok();
    })
    .detach();
}

/// Type into the open teleprompter (harness path for
/// `CAP_GPUI_AUTO_TELEPROMPTER=<script>`; synthetic key events are dropped
/// without Accessibility, and this drives the same `edit_script` the key
/// handler does, debounced write included).
pub fn type_into_teleprompter(text: String, cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().teleprompter else {
        return;
    };
    handle
        .update(cx, |view, window, cx| {
            view.type_script(&text, window, cx);
            window.refresh();
        })
        .ok();
}

/// Drive the teleprompter's play button (harness path for
/// `CAP_GPUI_AUTO_PLAY=1`). Only meaningful once the window has painted --
/// the scrollable height does not exist before that.
pub fn play_teleprompter(cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().teleprompter else {
        return;
    };
    handle
        .update(cx, |view, window, cx| {
            view.toggle_playback(window, cx);
            tracing::info!(playing = view.is_playing(), "teleprompter playback toggled");
            window.refresh();
        })
        .ok();
}

/// The teleprompter closed itself. Nothing to restore: unlike ModeSelect and
/// Settings this window never hid the main one.
pub fn teleprompter_closed(cx: &mut App) {
    cx.global_mut::<AppWindows>().teleprompter.take();
}

/// `apply_content_protection`: `setSharingType: None` while a capture is
/// running, back to `ReadOnly` when it stops. `window_capture_excluded` returns
/// true for the teleprompter's title unconditionally, so this window needs no
/// settings lookup -- but the gating on an active recording is theirs, and the
/// reason is in the comment above `capture_exclusion_hides_ui`: a permanently
/// excluded window is invisible on capture-based displays.
fn set_teleprompter_content_protection(hidden: bool, cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().teleprompter else {
        return;
    };
    let native = handle
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten();
    cx.spawn(async move |_| {
        if let Some(native) = &native {
            let sharing = platform::set_window_capture_hidden(native, hidden);
            tracing::info!(hidden, sharing, "teleprompter content protection");
        }
    })
    .detach();
}

/// The teleprompter's native window number, for capture exclusion.
fn teleprompter_window_number(cx: &mut App) -> Option<isize> {
    let handle = cx.global::<AppWindows>().teleprompter?;
    handle
        .update(cx, |_, window, _| platform::window_number(window))
        .ok()
        .flatten()
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

fn pinned_window_resolution_matches(
    requested: Option<&scap_targets::WindowId>,
    resolved: Option<&scap_targets::WindowId>,
) -> bool {
    requested.is_none_or(|requested| resolved.is_some_and(|resolved| requested == resolved))
}

pub(crate) fn reject_unavailable_window(cx: &mut App) {
    dismiss_target_overlays(cx);
    RecordingSession::global(cx).update(cx, |session, cx| {
        session.error = Some("The selected window is no longer available. Select it again.".into());
        cx.notify();
    });
}

/// Open (or re-target) the fullscreen overlays.
///
/// A mode change tears the old windows down first: the overlay carries
/// per-mode state -- an area selection above all -- and re-opening is both
/// cheaper to reason about and what the Tauri flow does (the webviews are
/// recreated with a new `targetMode` query parameter).
pub fn open_target_overlays(request: OverlayRequest, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    if !open_overlays_core(request, cx) {
        reject_unavailable_window(cx);
        return;
    }

    // `pickerActive && !hasHidden && !recording` -> `getCurrentWindow().hide()`
    // (`new-main/index.tsx:2024-2028`): the picker owns the screen; the main
    // window would otherwise float above the overlays at level 100.
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        cx.global_mut::<AppWindows>().main_hidden_for_picker = true;
        hide_main_window(cx);
    }
}

/// The editor's record modal opening the same picker
/// (`openTargetMode` / `selectDisplayTarget` / `selectWindowTarget`,
/// `ClipsSidebar.tsx:447-501`): identical overlays, but the window that hides
/// for them is the *editor* -- `hideEditorForPicker` -- and the dismissal
/// bookkeeping runs against [`AppWindows::editor_hidden_for_picker`] instead
/// of the main window's flag, so cancelling reveals the editor and starting
/// hands the foreground to the bar.
///
/// Must be reached through `cx.defer` from anything inside an entity update,
/// same as [`open_target_overlays`].
pub fn open_editor_target_overlays(editor_path: PathBuf, request: OverlayRequest, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    // A live recording keeps its own picker semantics; the modal's actions
    // are guarded on Idle already, so this is the belt-and-braces the Tauri
    // backend has in `set_pending_recording`.
    if RecordingSession::global(cx).read(cx).phase != Phase::Idle {
        return;
    }

    if !open_overlays_core(request, cx) {
        reject_unavailable_window(cx);
        return;
    }

    let key = editor_key(&editor_path);
    if cx.global::<AppWindows>().editor_hidden_for_picker.as_ref() != Some(&key) {
        cx.global_mut::<AppWindows>().editor_hidden_for_picker = Some(key.clone());
        hide_editor_window(&key, cx);
    }
    hide_main_window(cx);
}

pub fn open_editor_recording_main(editor_path: PathBuf, cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle
        || session.read(cx).editor_recording_target().as_ref() != Some(&editor_path)
    {
        return;
    }
    let key = editor_key(&editor_path);
    if editor_window_handle(&key, cx).is_none() {
        abort_editor_recording_flow(cx);
        return;
    }
    close_target_overlays(cx);
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    cx.global_mut::<AppWindows>().editor_hidden_for_picker = Some(key.clone());
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _, cx| {
        view.cancel_deep_link_start();
        view.show_recorder(cx);
        view.clear_target(cx);
        cx.notify();
    })
    .ok();
    hide_editor_window(&key, cx);
    show_main_window(cx);
}

fn open_overlays_core(request: OverlayRequest, cx: &mut App) -> bool {
    let pinned = request.pinned_window.as_ref().and_then(resolve_window);
    if request.mode == TargetType::Window
        && !pinned_window_resolution_matches(
            request.pinned_window.as_ref(),
            pinned.as_ref().map(|window| &window.id),
        )
    {
        tracing::warn!(window = ?request.pinned_window, "selected window could not be resolved");
        return false;
    }

    let select = TargetSelect::global(cx);
    let mode_changed = select.read(cx).mode != Some(request.mode);
    if mode_changed {
        close_overlay_windows(cx);
    }

    let display = request
        .display
        .clone()
        .or_else(|| pinned.as_ref().map(|window| window.display_id.clone()));

    select.update(cx, |select, cx| {
        select.arm(Some(request.mode), request.recording_mode, pinned, cx)
    });
    sync_camera_presentation(cx);

    if request.mode == TargetType::Window
        || (request.mode == TargetType::Area && request.recording_mode != Mode::Screenshot)
    {
        arm_camera_park(request.mode, cx);
    }

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
        open_overlay(
            &display,
            select.clone(),
            Some(&id) == focus_display.as_ref(),
            cx,
        );
    }

    // `global_shortcut.register("Escape")` while the overlays are up
    // (`target_select_overlay.rs:595-617`): with the main window hidden below
    // and the overlays non-activating, a plain key handler has nothing to be
    // delivered to.
    platform::register_escape_hotkey();
    true
}

/// Close the overlays and clear the main window's armed target -- Escape, the
/// overlay's own close button, or the main window toggling the mode off.
///
/// A "cancelled" dismissal in the Tauri vocabulary, which is the kind that
/// reveals the main window again (`dismissalReveals`,
/// `new-main/index.tsx:2047-2058`).
pub fn dismiss_target_overlays(cx: &mut App) {
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle
        && RecordingSession::global(cx)
            .read(cx)
            .editor_recording_target()
            .is_some()
    {
        abort_editor_recording_flow(cx);
        return;
    }
    close_target_overlays(cx);
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _window, cx| {
        view.cancel_deep_link_start();
        view.clear_target(cx);
    })
    .ok();

    // An editor-owned picker cancelled: clear the editor recording target and
    // reveal that editor with focus, record modal closed -- the non-
    // "editorRecording" branch of the `targetMode == null && hiddenForPicker`
    // effect (`ClipsSidebar.tsx:413-426`). The main window stays wherever it
    // was; the editor owns the foreground again.
    if let Some(editor_path) = cx
        .global_mut::<AppWindows>()
        .editor_hidden_for_picker
        .take()
    {
        RecordingSession::global(cx)
            .update(cx, |session, _| session.set_editor_recording_target(None));
        tracing::info!(path = %editor_path.display(), "editor picker dismissed");
        if let Some(handle) = editor_window_handle(&editor_path, cx) {
            handle
                .update(cx, |view, _window, cx| view.editor_picker_dismissed(cx))
                .ok();
            reveal_editor_window(&editor_path, cx);
            return;
        }
        // The editor went away under the picker; reveal the main window so
        // the app is not left with no visible window at all.
        show_main_window(cx);
        return;
    }

    let hidden = std::mem::take(&mut cx.global_mut::<AppWindows>().main_hidden_for_picker);
    let idle = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
    tracing::info!(hidden, idle, "picker dismissed");
    if hidden && idle {
        show_main_window(cx);
    }
}

/// Close the overlays and disarm the cursor probe, leaving the main window's
/// selection alone.
pub fn close_target_overlays(cx: &mut App) {
    close_overlay_windows(cx);
    disarm_target_selection(cx);
}

fn disarm_target_selection(cx: &mut App) {
    let select = TargetSelect::global(cx);
    select.update(cx, |select, cx| {
        let recording_mode = select.recording_mode;
        select.arm(None, recording_mode, None, cx);
    });
    sync_camera_presentation(cx);
}

fn area_overlay_matches(
    target: &ScreenCaptureTarget,
    candidate: &ScreenCaptureTarget,
    capture_excluded: bool,
) -> bool {
    let (
        ScreenCaptureTarget::Area { screen, bounds },
        ScreenCaptureTarget::Area {
            screen: candidate_screen,
            bounds: candidate_bounds,
        },
    ) = (target, candidate)
    else {
        return false;
    };
    capture_excluded
        && screen == candidate_screen
        && bounds.position() == candidate_bounds.position()
        && bounds.size() == candidate_bounds.size()
}

fn area_overlay_for_recording(
    target: &ScreenCaptureTarget,
    cx: &mut App,
) -> Option<WindowHandle<OverlayWindow>> {
    let ScreenCaptureTarget::Area { screen, .. } = target else {
        return None;
    };
    let handle = overlay_handle(Some(screen.clone()), cx)?;
    handle
        .update(cx, |view, window, cx| {
            let candidate = view.target(cx)?;
            #[cfg(target_os = "macos")]
            let capture_excluded = platform::window_is_visible(window)
                && platform::window_number(window).is_some_and(|number| number > 0);
            #[cfg(not(target_os = "macos"))]
            let capture_excluded = {
                let _ = window;
                false
            };
            area_overlay_matches(target, &candidate, capture_excluded).then_some(handle)
        })
        .ok()
        .flatten()
}

fn close_other_overlays(retained: WindowHandle<OverlayWindow>, cx: &mut App) {
    let closing: Vec<_> = cx
        .global::<AppWindows>()
        .overlays
        .iter()
        .filter(|(_, handle)| *handle != retained)
        .map(|(display, _)| display.clone())
        .collect();
    for display in closing {
        close_overlay(&display, cx);
    }
}

fn retain_recording_area(
    target: &ScreenCaptureTarget,
    cx: &mut App,
) -> Option<WindowHandle<OverlayWindow>> {
    let Some(handle) = area_overlay_for_recording(target, cx) else {
        close_target_overlays(cx);
        return None;
    };
    let committed = handle
        .update(cx, |view, _, cx| {
            view.is_recording_area() || view.commit_area_for_recording(cx)
        })
        .unwrap_or(false);
    if !committed {
        close_target_overlays(cx);
        return None;
    }
    release_camera_park(cx);
    close_other_overlays(handle, cx);
    platform::unregister_escape_hotkey();
    disarm_target_selection(cx);
    Some(handle)
}

fn make_recording_area_passive(handle: WindowHandle<OverlayWindow>, cx: &mut App) {
    cx.spawn(async move |cx| {
        let native = cx.update(|cx| {
            if RecordingSession::global(cx).read(cx).phase == Phase::Idle
                || !cx
                    .global::<AppWindows>()
                    .overlays
                    .iter()
                    .any(|(_, current)| *current == handle)
            {
                return None;
            }
            Some(
                handle
                    .update(cx, |view, window, _| {
                        view.is_recording_area()
                            .then(|| platform::native_window(window))
                            .flatten()
                    })
                    .ok()
                    .flatten(),
            )
        });
        let Some(native) = native else {
            return;
        };
        if !native.is_some_and(|native| platform::set_window_click_through(&native, true)) {
            tracing::warn!("recording area click-through failed; removing the outline");
            cx.update(|cx| {
                let display = cx
                    .global::<AppWindows>()
                    .overlays
                    .iter()
                    .find(|(_, current)| *current == handle)
                    .map(|(display, _)| display.clone());
                if let Some(display) = display {
                    close_overlay(&display, cx);
                }
            });
        }
    })
    .detach();
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

pub fn start_recording_from_overlay(target: ScreenCaptureTarget, cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    if RecordingSession::global(cx).read(cx).phase != Phase::Idle
        || main
            .update(cx, |view, _, _| view.is_preparing_recording())
            .unwrap_or(true)
    {
        return;
    }
    // Collected before the windows go away: the capture starts a beat after
    // this, and an overlay that has not finished closing must not end up in
    // the recording.
    let excluded = overlay_window_ids(cx);
    let retained_area =
        cfg!(target_os = "macos") && matches!(&target, ScreenCaptureTarget::Area { .. });
    if retained_area {
        let handle = area_overlay_for_recording(&target, cx).filter(|handle| {
            handle
                .update(cx, |view, _, cx| view.commit_area_for_recording(cx))
                .unwrap_or(false)
        });
        let Some(handle) = handle else {
            dismiss_target_overlays(cx);
            RecordingSession::global(cx).update(cx, |session, cx| {
                session.error = Some(
                    "The selected area changed or is no longer available. Select it again.".into(),
                );
                cx.notify();
            });
            return;
        };
        close_other_overlays(handle, cx);
    } else {
        release_camera_park(cx);
        close_target_overlays(cx);
        cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
        cx.global_mut::<AppWindows>().editor_hidden_for_picker = None;
    }

    let preparing = main
        .update(cx, |view, window, cx| {
            view.start_recording_with_target(target, excluded, window, cx);
            view.is_preparing_recording()
        })
        .unwrap_or(false);
    if retained_area && !preparing && RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        dismiss_target_overlays(cx);
    }
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

fn overlay_handle(display: Option<DisplayId>, cx: &App) -> Option<WindowHandle<OverlayWindow>> {
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
                if !cx.update(|cx| {
                    cx.global::<AppWindows>()
                        .overlays
                        .iter()
                        .any(|(_, current)| *current == handle)
                }) {
                    return;
                }
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
                            #[cfg(any(target_os = "linux", target_os = "windows"))]
                            window.activate_window();
                        }
                        window.refresh();
                    })
                    .ok();
                if let Some(camera) = cx.update(visible_camera_frame)
                    && let Err(error) = camera.raise()
                {
                    tracing::warn!(%error, "could not raise the camera above the target picker");
                }
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
    // The Tauri unregister lives next to the close for the same reason: a
    // global Escape may only be swallowed while a picker is actually up.
    platform::unregister_escape_hotkey();
    // The window-variant overlay's `onCleanup`: the camera bubble goes back
    // where the picker found it, unless the pick was committed first.
    revert_camera_park(cx);
    let overlays = std::mem::take(&mut cx.global_mut::<AppWindows>().overlays);
    for (_, handle) in overlays {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

// -- Our own windows, for capture exclusion and content protection ----------
//
// Window recording on macOS is *display* capture cropped to the target
// window's bounds, with `excluded_windows` removed from the `SCContentFilter`:
// anything overlapping the recorded window is in the frame unless it is
// excluded by id or content-protected. The Tauri app keeps Cap's own windows
// out with two mechanisms, ported below -- ids into the filter
// (`window_exclusion::append_matching_webview_window_ids`) and
// `NSWindowSharingType.None` on the windows themselves
// (`windows::apply_content_protection`).

/// `CapWindowId::title()` (`src-tauri/src/windows.rs:1030-1046`) for the
/// windows this app owns.
///
/// The exclusion rules the user edits in Settings match on *window titles*, and
/// gpui windows are created with `titlebar: None` and never get an `NSWindow`
/// title at all -- so a `CGWindowList` walk (`resolve_excluded_window_ids`)
/// cannot see one of our windows by name, and the rules could never match them.
/// The Tauri app has the same gap and closes it the same way: it never asks the
/// window list about its own windows, it asks `CapWindowId::title()` and takes
/// the `NSWindow.windowNumber()` directly (`window_exclusion.rs:120-193`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnWindow {
    Main,
    Settings,
    Controls,
    Camera,
    ModeSelect,
    Teleprompter,
    TargetSelect,
    Editor,
    ScreenshotEditor,
    Onboarding,
}

impl OwnWindow {
    /// Every kind [`own_windows`] can produce. `CapWindowId`'s other variants
    /// (`WindowCaptureOccluder`, `CaptureArea`, `RecordingsOverlay`, `Upgrade`,
    /// `Debug`) have no counterpart in this app; their default rules are still
    /// honoured for *other* processes by `resolve_excluded_window_ids`.
    pub const ALL: [Self; 10] = [
        Self::Main,
        Self::Settings,
        Self::Controls,
        Self::Camera,
        Self::ModeSelect,
        Self::Teleprompter,
        Self::TargetSelect,
        Self::Editor,
        Self::ScreenshotEditor,
        Self::Onboarding,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Self::Main => "Cap",
            Self::Settings => "Cap Settings",
            Self::Controls => "Cap Recording Controls",
            Self::Camera => "Cap Camera",
            Self::ModeSelect => "Cap Mode Selection",
            Self::Teleprompter => "Cap Teleprompter",
            Self::TargetSelect => "Cap Target Select",
            Self::Editor => "Cap Editor",
            Self::ScreenshotEditor => "Cap Screenshot Editor",
            Self::Onboarding => "Welcome to Cap",
        }
    }
}

/// The rule list a recording matches our own windows against
/// (`src-tauri/src/recording.rs:1879-1904`): the configured -- or default --
/// exclusions, minus the camera rule in Instant mode (`filter_for_instant_mode`,
/// `window_exclusion.rs:104-111`: instant has no compositing step, so the
/// bubble belongs in the picture), plus a teleprompter rule that is always
/// present whatever the settings say.
fn own_window_exclusion_rules(
    configured: Vec<crate::store::WindowExclusion>,
    mode: RecordingMode,
) -> Vec<crate::store::WindowExclusion> {
    let mut rules = configured;
    if mode == RecordingMode::Instant {
        rules.retain(|rule| rule.window_title.as_deref() != Some(OwnWindow::Camera.title()));
    }
    let teleprompter = crate::store::WindowExclusion {
        bundle_identifier: None,
        owner_name: None,
        window_title: Some(OwnWindow::Teleprompter.title().to_string()),
    };
    if !rules.contains(&teleprompter) {
        rules.push(teleprompter);
    }
    rules
}

/// `matches_window_title` (`window_exclusion.rs:175-181`): `WindowExclusion::
/// matches` with only a title to offer, so a bundle-id rule or an owner-name
/// rule cannot match one of our windows -- exactly the Tauri behaviour, since
/// it feeds the same `None, None, Some(title)`.
fn matches_own_title(rules: &[crate::store::WindowExclusion], title: &str) -> bool {
    rules
        .iter()
        .any(|rule| rule.matches(None, None, Some(title)))
}

/// Which of our own windows a rule list covers.
fn excluded_own_windows(rules: &[crate::store::WindowExclusion]) -> Vec<OwnWindow> {
    OwnWindow::ALL
        .into_iter()
        .filter(|kind| matches_own_title(rules, kind.title()))
        .collect()
}

/// `apply_content_protection` (`windows.rs:3382-3407`): the same set, minus the
/// camera window, which that loop skips outright (`:3393-3398`) because its
/// protection is mode-driven from the start path instead
/// (`recording.rs:1617-1624`).
fn content_protection_targets(rules: &[crate::store::WindowExclusion]) -> Vec<OwnWindow> {
    excluded_own_windows(rules)
        .into_iter()
        .filter(|kind| *kind != OwnWindow::Camera)
        .collect()
}

/// `window.set_content_protected(matches!(inputs.mode, RecordingMode::Studio))`
/// on the camera window at `recording.rs:1617-1624` -- the one window whose
/// protection is decided by the mode and not by the rules.
fn camera_content_protected(mode: RecordingMode) -> bool {
    mode == RecordingMode::Studio
}

/// One of our windows, with everything the two mechanisms need: the canonical
/// title's kind, the `CGWindowID` to exclude, whether it is on screen, and a
/// retained `NSWindow` for the sharing-type flip.
struct OwnWindowHandle {
    kind: OwnWindow,
    number: Option<isize>,
    visible: bool,
    native: Option<platform::NativeWindow>,
}

fn probe_own_window<V: 'static + gpui::Render>(
    kind: OwnWindow,
    handle: WindowHandle<V>,
    cx: &mut App,
) -> Option<OwnWindowHandle> {
    handle
        .update(cx, |_, window, _| OwnWindowHandle {
            kind,
            number: platform::window_number(window),
            visible: platform::window_is_visible(window),
            native: platform::native_window(window),
        })
        .ok()
}

/// Every window this app owns -- `app.webview_windows()` in both Tauri
/// mechanisms.
///
/// The destructure is deliberate: a new `AppWindows` field stops compiling here
/// until it is either walked or explicitly skipped, which is what keeps the
/// canonical-title table exhaustive as windows are added.
fn own_windows(cx: &mut App) -> Vec<OwnWindowHandle> {
    let AppWindows {
        main,
        controls,
        camera,
        settings,
        onboarding,
        mode_select,
        teleprompter,
        overlays,
        editors,
        deleting_editors: _,
        screenshot_editors,
        main_hidden_for_picker: _,
        editor_hidden_for_picker: _,
        camera_park: _,
        #[cfg(target_os = "linux")]
            clean_capture: _,
        #[cfg(target_os = "linux")]
            clean_capture_generation: _,
    } = cx.global::<AppWindows>();
    let main = *main;
    let controls = *controls;
    let camera = *camera;
    let settings = *settings;
    let onboarding = *onboarding;
    let mode_select = *mode_select;
    let teleprompter = *teleprompter;
    let overlays: Vec<_> = overlays.iter().map(|(_, handle)| *handle).collect();
    let editors: Vec<_> = editors.iter().map(|(_, handle)| *handle).collect();
    let screenshot_editors: Vec<_> = screenshot_editors
        .iter()
        .map(|(_, handle)| *handle)
        .collect();

    let mut windows = Vec::new();
    windows.extend(probe_own_window(OwnWindow::Main, main, cx));
    windows.extend(controls.and_then(|handle| probe_own_window(OwnWindow::Controls, handle, cx)));
    windows.extend(camera.and_then(|handle| probe_own_window(OwnWindow::Camera, handle, cx)));
    windows.extend(settings.and_then(|handle| probe_own_window(OwnWindow::Settings, handle, cx)));
    windows
        .extend(onboarding.and_then(|handle| probe_own_window(OwnWindow::Onboarding, handle, cx)));
    windows
        .extend(mode_select.and_then(|handle| probe_own_window(OwnWindow::ModeSelect, handle, cx)));
    windows.extend(
        teleprompter.and_then(|handle| probe_own_window(OwnWindow::Teleprompter, handle, cx)),
    );
    for handle in overlays {
        windows.extend(probe_own_window(OwnWindow::TargetSelect, handle, cx));
    }
    for handle in editors {
        windows.extend(probe_own_window(OwnWindow::Editor, handle, cx));
    }
    for handle in screenshot_editors {
        windows.extend(probe_own_window(OwnWindow::ScreenshotEditor, handle, cx));
    }
    windows
}

/// `append_matching_webview_window_ids` (`window_exclusion.rs:120-193`), step
/// for step: our own windows whose canonical title a rule covers, by native
/// window number, the ones `CGWindowList` cannot see skipped (an id the capture
/// filter would not recognise anyway) and duplicates dropped.
fn append_own_excluded_window_ids(
    excluded: &mut Vec<scap_targets::WindowId>,
    windows: &[OwnWindowHandle],
    rules: &[crate::store::WindowExclusion],
) {
    for window in windows {
        let title = window.kind.title();
        if !matches_own_title(rules, title) {
            continue;
        }
        let Some(number) = window.number else {
            tracing::warn!(title, "excluded Cap window has no native window id");
            continue;
        };
        let Ok(id) = number.to_string().parse::<scap_targets::WindowId>() else {
            tracing::warn!(title, number, "excluded Cap window has no usable window id");
            continue;
        };
        // `Window::from_id(&native_id).is_none()` (`:144-166`): a window that is
        // not in the window list has nothing for the content filter to exclude.
        // Loud when the window believes it is on screen, quiet when it is
        // merely hidden -- the same two log levels.
        if scap_targets::Window::from_id(&id).is_none() {
            if window.visible {
                tracing::warn!(
                    title,
                    number,
                    "excluded Cap window is not visible to CGWindowList"
                );
            } else {
                tracing::debug!(title, number, "skipping a hidden excluded Cap window");
            }
            continue;
        }
        if excluded.contains(&id) {
            tracing::debug!(title, number, "excluded Cap window id already resolved");
            continue;
        }
        tracing::info!(title, number, "excluding a Cap window from the capture");
        excluded.push(id);
    }
}

/// `set_content_protected(..)` on a batch of our windows.
///
/// AppKit mutations re-enter gpui's own window callbacks, so the sharing-type
/// flips run from a spawned task on the retained handles -- the
/// [`platform::place_overlay_panel`] rule that
/// [`set_teleprompter_content_protection`] already follows.
fn apply_content_protection(
    windows: Vec<OwnWindowHandle>,
    hidden_for: impl Fn(OwnWindow) -> bool,
    cx: &mut App,
) {
    let work: Vec<_> = windows
        .into_iter()
        .filter_map(|window| {
            let hidden = hidden_for(window.kind);
            Some((window.kind, window.native?, hidden))
        })
        .collect();
    if work.is_empty() {
        return;
    }
    cx.spawn(async move |_| {
        for (kind, native, hidden) in &work {
            let sharing = platform::set_window_capture_hidden(native, *hidden);
            tracing::info!(?kind, hidden, sharing, "content protection");
        }
        // The sharing-type flips are one of the operations that provoke the
        // macOS 26 style-mask mutation on the main window (native buttons
        // materialize over the hand-drawn lights), and on the recording-end
        // path they race `show_main_window`'s own heal -- so heal again after
        // the flips, in the same task, where the ordering is certain.
        if let Some((_, native, _)) = work.iter().find(|(kind, _, _)| *kind == OwnWindow::Main) {
            platform::restore_borderless_style(native);
        }
    })
    .detach();
}

/// `apply_content_protection(&app, false)` in `clear_recording_state`
/// (`src-tauri/src/lib.rs:896-912`): every window back to
/// `NSWindowSharingType.ReadOnly` when the recording ends, the camera included
/// (that loop only ever *clears* the camera, `windows.rs:3393-3398`).
///
/// A permanently protected window is invisible on capture-based displays, which
/// is why the protection is scoped to a live recording in the first place.
/// Idempotent: a second call re-writes the same sharing type, so the overlap
/// with [`set_teleprompter_content_protection`] and
/// [`set_editor_content_protection`] is harmless.
pub fn restore_content_protection(cx: &mut App) {
    let windows = own_windows(cx);
    apply_content_protection(windows, |_| false, cx);
}

#[cfg(target_os = "linux")]
fn clean_capture_supported(
    mode: RecordingMode,
    target: &ScreenCaptureTarget,
    camera_requested: bool,
    wayland: bool,
) -> bool {
    matches!(
        target,
        ScreenCaptureTarget::Display { .. } | ScreenCaptureTarget::Area { .. }
    ) || (!wayland
        && mode == RecordingMode::Instant
        && camera_requested
        && matches!(target, ScreenCaptureTarget::Window { .. }))
}

#[cfg(target_os = "linux")]
fn linux_capture_bounds(
    target: &ScreenCaptureTarget,
) -> anyhow::Result<camera_window::LinuxCameraPhysicalRect> {
    let (display, crop) = cap_recording::target_to_display_and_crop(target)?;
    let position = display
        .raw_handle()
        .physical_position()
        .ok_or_else(|| anyhow::anyhow!("Capture display position is unavailable"))?;
    if matches!(target, ScreenCaptureTarget::Window { .. }) {
        let crop = crop.ok_or_else(|| anyhow::anyhow!("Capture window bounds are unavailable"))?;
        return linux_window_capture_bounds(
            position.x() + crop.position().x(),
            position.y() + crop.position().y(),
            crop.size().width(),
            crop.size().height(),
        );
    }
    let size = display
        .physical_size()
        .ok_or_else(|| anyhow::anyhow!("Capture display size is unavailable"))?;
    let (x, y, width, height) = cap_recording::sources::screen_capture::x11_capture_rect(
        position.x(),
        position.y(),
        size.width(),
        size.height(),
        crop.map(|crop| {
            (
                crop.position().x(),
                crop.position().y(),
                crop.size().width(),
                crop.size().height(),
            )
        }),
    )?;
    Ok(camera_window::LinuxCameraPhysicalRect {
        x,
        y,
        width,
        height,
    })
}

#[cfg(target_os = "linux")]
fn linux_window_capture_bounds(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> anyhow::Result<camera_window::LinuxCameraPhysicalRect> {
    anyhow::ensure!(
        [x, y, width, height]
            .iter()
            .all(|value| value.is_finite() && value.fract() == 0.0)
            && x >= f64::from(i32::MIN)
            && x <= f64::from(i32::MAX)
            && y >= f64::from(i32::MIN)
            && y <= f64::from(i32::MAX)
            && width >= 2.0
            && width <= f64::from(i32::MAX)
            && height >= 2.0
            && height <= f64::from(i32::MAX),
        "Capture window has invalid physical bounds"
    );
    Ok(camera_window::LinuxCameraPhysicalRect {
        x: x as i32,
        y: y as i32,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(target_os = "linux")]
fn linux_camera_presentation(
    snapshot: camera_window::LinuxCameraRecordingSnapshot,
    capture: camera_window::LinuxCameraPhysicalRect,
) -> anyhow::Result<cap_recording::instant_recording::LinuxCameraPresentation> {
    use crate::store::{BlurMode, CameraShape};
    use cap_recording::instant_recording::{
        LinuxCameraEffect, LinuxCameraPresentation, LinuxCameraRect, LinuxCameraShape,
    };

    let rect = snapshot.content_rect;
    let x = i64::from(rect.x) - i64::from(capture.x);
    let y = i64::from(rect.y) - i64::from(capture.y);
    anyhow::ensure!(
        x >= 0
            && y >= 0
            && x + i64::from(rect.width) <= i64::from(capture.width)
            && y + i64::from(rect.height) <= i64::from(capture.height),
        "Move the whole camera preview inside the capture area before starting Instant recording"
    );
    let radius = snapshot.corner_radius_pixels.round();
    anyhow::ensure!(
        radius.is_finite() && radius >= 0.0 && f64::from(radius) <= f64::from(u32::MAX),
        "Camera preview has an invalid corner radius"
    );
    let shape = match snapshot.state.shape {
        CameraShape::Round if rect.width == rect.height => LinuxCameraShape::Round,
        CameraShape::Round if rect.width.abs_diff(rect.height) <= 1 => {
            LinuxCameraShape::RoundedRectangle {
                radius_pixels: rect.width.min(rect.height) / 2,
            }
        }
        CameraShape::Round => anyhow::bail!("Round camera preview has invalid physical bounds"),
        CameraShape::Square | CameraShape::Full => LinuxCameraShape::RoundedRectangle {
            radius_pixels: (radius as u32).min(rect.width.min(rect.height) / 2),
        },
    };
    let mut presentation = LinuxCameraPresentation {
        rect: LinuxCameraRect {
            x: u32::try_from(x)?,
            y: u32::try_from(y)?,
            width: rect.width,
            height: rect.height,
        },
        shape,
        mirrored: snapshot.state.mirrored,
        effect: LinuxCameraEffect::None,
    };
    presentation.validate(capture.width, capture.height)?;
    if snapshot.state.background_blur != BlurMode::Off {
        presentation.effect = LinuxCameraEffect::BackgroundBlur;
    }
    Ok(presentation)
}

#[cfg(target_os = "linux")]
pub(crate) fn refresh_linux_instant_camera(
    config: &mut StartConfig,
    cx: &mut App,
) -> anyhow::Result<()> {
    use crate::{feeds::Feeds, recording::LinuxInstantCameraRequest, store::BlurMode};
    use cap_recording::instant_recording::{LinuxCameraBlur, LinuxCameraProcessing};

    config.linux_instant_camera = None;
    if config.mode != RecordingMode::Instant
        || config.camera.is_none()
        || matches!(config.target, ScreenCaptureTarget::CameraOnly)
    {
        return Ok(());
    }
    anyhow::ensure!(
        !cap_recording::screenshot::uses_wayland_portal(),
        "Instant camera overlays require an X11 desktop on Linux"
    );
    let camera = cx.global::<AppWindows>().camera.ok_or_else(|| {
        anyhow::anyhow!("Open the selected camera preview before Instant recording")
    })?;
    let snapshot = camera.update(cx, |camera, window, _| camera.recording_snapshot(window))??;
    let capture = linux_capture_bounds(&config.target)?;
    let presentation = linux_camera_presentation(snapshot, capture)?;
    let processing = Feeds::global(cx)
        .read(cx)
        .camera_processing_factory()
        .ok_or_else(|| anyhow::anyhow!("Wait for the selected camera preview before recording"))?;
    config.linux_instant_camera = Some(LinuxInstantCameraRequest {
        presentation,
        reference_size: (capture.width, capture.height),
        effects: LinuxCameraProcessing {
            mirrored: snapshot.state.mirrored,
            blur: match snapshot.state.background_blur {
                BlurMode::Off => LinuxCameraBlur::Off,
                BlurMode::Light => LinuxCameraBlur::Light,
                BlurMode::Heavy => LinuxCameraBlur::Heavy,
            },
        },
        processing,
    });
    Ok(())
}

pub(crate) fn clean_capture_camera_message(cx: &App) -> &'static str {
    #[cfg(target_os = "linux")]
    if cx
        .try_global::<AppWindows>()
        .and_then(|windows| windows.clean_capture.as_ref())
        .and_then(|lease| lease.config.as_ref())
        .is_some_and(|config| config.mode == RecordingMode::Instant)
    {
        return "Cap will hide its preview and controls. Any selected camera will appear at its preview position with the selected shape and effects. Keep the whole preview inside the capture area. Opening Cap will stop this Instant recording before showing its controls.";
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cx;
    "Cap will hide its camera preview and recording controls. Any selected camera will keep recording as a separate editable track."
}

pub fn clean_capture_owned(cx: &App) -> bool {
    #[cfg(target_os = "linux")]
    {
        cx.try_global::<AppWindows>()
            .is_some_and(|windows| windows.clean_capture.is_some())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cx;
        false
    }
}

pub fn clean_capture_pending(cx: &App) -> bool {
    #[cfg(target_os = "linux")]
    {
        cx.try_global::<AppWindows>()
            .and_then(|windows| windows.clean_capture.as_ref())
            .is_some_and(|lease| !lease.gate.started && !lease.restoring)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cx;
        false
    }
}

#[cfg(target_os = "linux")]
pub fn clean_capture_active(cx: &App) -> bool {
    cx.try_global::<AppWindows>()
        .and_then(|windows| windows.clean_capture.as_ref())
        .is_some_and(|lease| lease.gate.started)
}

pub fn clean_capture_shortcut_message(cx: &App) -> String {
    #[cfg(target_os = "linux")]
    {
        crate::hotkeys::clean_capture_stop_message(cx)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cx;
        String::new()
    }
}

#[cfg(target_os = "linux")]
pub fn notify_clean_capture_preflight(cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    let _ = main.update(cx, |_, _, cx| cx.notify());
}

#[cfg(target_os = "linux")]
fn clean_capture_generation_matches(generation: u64, cx: &App) -> bool {
    cx.try_global::<AppWindows>()
        .and_then(|windows| windows.clean_capture.as_ref())
        .is_some_and(|lease| lease.generation == generation)
}

#[cfg(target_os = "linux")]
pub fn handle_owned_clean_capture_shortcut(
    generation: u64,
    state: global_hotkey::HotKeyState,
    cx: &mut App,
) {
    if clean_capture_generation_matches(generation, cx) {
        handle_clean_capture_shortcut(state, cx);
    }
}

#[cfg(target_os = "linux")]
pub fn clean_capture_stop_unavailable(generation: u64, error: String, cx: &mut App) {
    if !clean_capture_generation_matches(generation, cx) {
        return;
    }
    if cx
        .global::<AppWindows>()
        .clean_capture
        .as_ref()
        .is_some_and(|lease| lease.restoring)
    {
        return;
    }
    let session = RecordingSession::global(cx);
    if session.read(cx).phase == Phase::Idle {
        cancel_clean_capture(cx);
        report_clean_capture_error(anyhow::Error::msg(error), cx);
    } else {
        session.update(cx, |session, cx| {
            session.error = Some(error);
            session.stop(cx);
        });
    }
}

#[cfg(target_os = "linux")]
fn defer_window_until_capture_safe(cx: &mut App) -> bool {
    if !cx
        .try_global::<AppWindows>()
        .and_then(|windows| windows.clean_capture.as_ref())
        .is_some_and(|lease| lease.wayland && lease.gate.started)
    {
        return false;
    }
    let session = RecordingSession::global(cx);
    if session.read(cx).clean_capture_controls_safe() {
        return false;
    }
    session.update(cx, |session, cx| session.show_clean_capture_controls(cx));
    true
}

#[cfg(target_os = "linux")]
fn x11_window_visible(window: &gpui::Window) -> anyhow::Result<bool> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use x11rb::protocol::xproto::{ConnectionExt, MapState};
    let id = match HasWindowHandle::window_handle(window)?.as_raw() {
        RawWindowHandle::Xlib(handle) => u32::try_from(handle.window)?,
        RawWindowHandle::Xcb(handle) => handle.window.get(),
        _ => anyhow::bail!("Clean Studio capture requires an X11 window."),
    };
    let (connection, _) = x11rb::connect(None)?;
    Ok(connection.get_window_attributes(id)?.reply()?.map_state == MapState::VIEWABLE)
}

#[cfg(target_os = "linux")]
fn prepare_clean_capture(config: StartConfig, cx: &mut App) -> anyhow::Result<()> {
    if cx.global::<AppWindows>().controls.is_some() {
        anyhow::bail!("Close the previous recording controls before starting a clean capture.");
    }
    let main = cx.global::<AppWindows>().main;
    let wayland = cap_recording::screenshot::uses_wayland_portal();
    let main_was_visible = main.update(cx, |_, window, _| {
        if wayland {
            window.retained_visibility().ok_or_else(|| {
                anyhow::anyhow!(
                    "The window backend cannot retain and acknowledge capture visibility"
                )
            })
        } else {
            x11_window_visible(window)
        }
    })??;
    let requested_inputs = CleanCaptureInputs::current(cx);
    let generation = cx
        .global::<AppWindows>()
        .clean_capture_generation
        .wrapping_add(1);
    crate::hotkeys::reserve_clean_capture_stop(generation, wayland, cx)?;
    let windows = cx.global_mut::<AppWindows>();
    windows.clean_capture_generation = generation;
    windows.clean_capture = Some(CleanCaptureUi {
        generation: windows.clean_capture_generation,
        config: Some(config),
        gate: CleanCaptureGate::default(),
        camera: None,
        camera_was_visible: false,
        main_was_visible,
        requested_inputs,
        preview_was_rendering: None,
        wayland,
        restoring: false,
        restoration_error: None,
        retained_windows: if wayland {
            vec![(main.into(), main_was_visible)]
        } else {
            Vec::new()
        },
    });
    close_target_overlays(cx);
    let shown = main.update(cx, |_, window, cx| {
        if wayland {
            observe_visibility(window.set_retained_visibility(true)?, true, cx);
        } else {
            platform::set_x11_window_visible(window, true)?;
        }
        window.activate_window();
        cx.notify();
        Ok::<_, anyhow::Error>(())
    });
    if let Err(error) = shown.and_then(|result| result) {
        restore_clean_capture_ui(cx);
        return Err(error);
    }
    Ok(())
}

pub fn cancel_clean_capture(cx: &mut App) {
    #[cfg(target_os = "linux")]
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle
        && RecordingSession::global(cx).read(cx).instant_cleanup_safe()
    {
        restore_clean_capture_ui(cx);
        abort_editor_recording_flow(cx);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cx;
}

#[cfg(target_os = "linux")]
fn report_clean_capture_error(error: anyhow::Error, cx: &mut App) {
    tracing::error!(%error, "clean capture preflight failed");
    RecordingSession::global(cx).update(cx, |session, cx| {
        session.error = Some(error.to_string());
        cx.notify();
    });
    show_main_window_after_capture_pause(cx);
    abort_editor_recording_flow(cx);
}

#[cfg(target_os = "linux")]
pub type CleanVisibility = futures_util::future::BoxFuture<'static, anyhow::Result<()>>;

#[cfg(target_os = "linux")]
fn observe_visibility<F, E>(receipt: F, visible: bool, cx: &mut App)
where
    F: std::future::Future<Output = Result<anyhow::Result<(u64, bool)>, E>> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let task = gpui_tokio::Tokio::spawn(cx, async move {
        let (_, acknowledged) =
            tokio::time::timeout(std::time::Duration::from_secs(3), receipt).await???;
        anyhow::ensure!(
            acknowledged == visible,
            "Unexpected retained visibility acknowledgement"
        );
        Ok::<_, anyhow::Error>(())
    });
    cx.spawn(async move |_| {
        if let Err(error) = task
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result.map_err(|error| error.to_string()))
        {
            tracing::error!(%error, "Could not restore retained window visibility");
        }
    })
    .detach();
}

#[cfg(target_os = "linux")]
pub fn hide_clean_capture_main(cx: &mut App) -> anyhow::Result<CleanVisibility> {
    if cx
        .global::<AppWindows>()
        .clean_capture
        .as_ref()
        .is_some_and(|lease| lease.wayland)
    {
        return hide_retained_capture_windows(cx);
    }
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |_, window, _| {
        platform::set_x11_window_visible(window, false)
    })??;
    Ok(Box::pin(async { Ok(()) }))
}

#[cfg(target_os = "linux")]
fn hide_retained_capture_windows(cx: &mut App) -> anyhow::Result<CleanVisibility> {
    let handles = cx.windows();
    let mut visible = Vec::new();
    for handle in handles {
        let was_visible = handle
            .update(cx, |_, window, _| window.retained_visibility())?
            .ok_or_else(|| {
                anyhow::anyhow!("A Cap window cannot acknowledge clean capture visibility")
            })?;
        visible.push((handle, was_visible));
    }
    let lease = cx
        .global_mut::<AppWindows>()
        .clean_capture
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("The capture visibility lease ended"))?;
    for &(handle, was_visible) in &visible {
        if !lease
            .retained_windows
            .iter()
            .any(|(saved, _)| *saved == handle)
        {
            lease.retained_windows.push((handle, was_visible));
        }
    }
    let mut receipts = Vec::new();
    for (handle, _) in visible {
        receipts.push(handle.update(cx, |_, window, _| window.set_retained_visibility(false))??);
    }
    Ok(Box::pin(async move {
        tokio::time::timeout(std::time::Duration::from_secs(3), async move {
            for receipt in receipts {
                let (_, visible) = receipt.await??;
                anyhow::ensure!(
                    !visible,
                    "The compositor did not acknowledge hiding a Cap window"
                );
            }
            Ok::<_, anyhow::Error>(())
        })
        .await?
    }))
}

#[cfg(target_os = "linux")]
fn hide_clean_capture_ui(cx: &mut App) -> anyhow::Result<CleanVisibility> {
    let wayland = cx
        .global::<AppWindows>()
        .clean_capture
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Clean capture is no longer waiting to start"))?
        .wayland;
    let camera = cx.global::<AppWindows>().camera;
    let camera_was_visible = if wayland {
        false
    } else {
        match camera {
            Some(camera) => camera.update(cx, |_, window, _| x11_window_visible(window))??,
            None => false,
        }
    };
    let preview_was_rendering = crate::feeds::Feeds::global(cx)
        .read(cx)
        .set_camera_preview_rendering(false);
    if let Some(lease) = cx.global_mut::<AppWindows>().clean_capture.as_mut() {
        lease.camera = camera;
        lease.camera_was_visible = camera_was_visible;
        let _ = lease
            .preview_was_rendering
            .get_or_insert(preview_was_rendering);
    }
    if let Some(camera) = camera.filter(|_| camera_was_visible) {
        camera.update(cx, |_, window, _| {
            platform::set_x11_window_visible(window, false)
        })??;
    }
    hide_clean_capture_main(cx)
}

#[cfg(target_os = "linux")]
async fn acknowledge_restored_windows<F, E>(
    receipts: Vec<(bool, F)>,
    mut errors: Vec<String>,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<anyhow::Result<(u64, bool)>, E>>,
    E: std::fmt::Display,
{
    for (expected, receipt) in receipts {
        match receipt.await {
            Ok(Ok((_, visible))) if visible == expected => {}
            Ok(Ok(_)) => errors.push("A restored window acknowledged the wrong visibility".into()),
            Ok(Err(error)) => errors.push(error.to_string()),
            Err(error) => errors.push(error.to_string()),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(target_os = "linux")]
fn begin_retained_capture_restore(cx: &mut App) {
    let Some(lease) = cx.global_mut::<AppWindows>().clean_capture.as_mut() else {
        return;
    };
    if !lease.begin_restore() {
        return;
    }
    let generation = lease.generation;
    let windows = lease.retained_windows.clone();
    let rendering = lease.preview_was_rendering;
    if let Some(rendering) = rendering {
        crate::feeds::Feeds::global(cx)
            .read(cx)
            .set_camera_preview_rendering(rendering);
    }
    let mut receipts = Vec::new();
    let mut errors = Vec::new();
    for (handle, visible) in windows {
        match handle
            .update(cx, |_, window, _| {
                let receipt = window.set_retained_visibility(visible)?;
                window.refresh();
                Ok::<_, anyhow::Error>(receipt)
            })
            .and_then(|result| result)
        {
            Ok(receipt) => receipts.push((visible, receipt)),
            Err(error) => errors.push(error.to_string()),
        }
    }
    let visibility = gpui_tokio::Tokio::spawn(cx, async move {
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            acknowledge_restored_windows(receipts, errors),
        )
        .await
        .map_err(|_| {
            "Window restoration has not been acknowledged; its lease remains owned".to_string()
        })?
    });
    cx.spawn(async move |cx| {
        let visibility = visibility.await.map_err(|error| error.to_string()).and_then(|result| result);
        let result = match visibility {
            Ok(()) => {
                let cleanup = cx.update(|cx| {
                    if !clean_capture_generation_matches(generation, cx) { return None; }
                    let cleanup = crate::hotkeys::begin_wayland_stop_cleanup(cx);
                    Some(gpui_tokio::Tokio::spawn(cx, cleanup))
                });
                match cleanup {
                    Some(cleanup) => cleanup.await.map_err(|error| error.to_string()).and_then(|result| result),
                    None => return,
                }
            }
            Err(error) => Err(error),
        };
        cx.update(|cx| {
            if !clean_capture_generation_matches(generation, cx) { return; }
            match result {
                Ok(()) => {
                    crate::hotkeys::complete_clean_capture_stop(generation, cx);
                    let _restored = cx.global_mut::<AppWindows>().clean_capture.take();
                    update_camera_presentation(true, cx);
                    RecordingSession::global(cx).update(cx, |_, cx| cx.notify());
                }
                Err(error) => {
                    if let Some(lease) = cx.global_mut::<AppWindows>().clean_capture.as_mut() {
                        lease.restoration_error = Some(error.clone());
                    }
                    tracing::error!(%error, "Recording UI restoration or Stop cleanup is unconfirmed");
                    RecordingSession::global(cx).update(cx, |session, cx| {
                        session.error = Some(format!("Recording cleanup is incomplete: {error}. A new recording is blocked."));
                        cx.notify();
                    });
                }
            }
        });
    }).detach();
}

#[cfg(target_os = "linux")]
fn restore_clean_capture_ui(cx: &mut App) -> bool {
    if !RecordingSession::global(cx).read(cx).instant_cleanup_safe() {
        return false;
    }
    if cx
        .global::<AppWindows>()
        .clean_capture
        .as_ref()
        .is_some_and(|lease| lease.wayland)
    {
        begin_retained_capture_restore(cx);
        return false;
    }
    let Some(lease) = cx.global_mut::<AppWindows>().clean_capture.take() else {
        return true;
    };
    crate::hotkeys::release_clean_capture_stop(cx);
    if let Some(rendering) = lease.preview_was_rendering {
        // Camera selection does not reset the shared render flag owned by this lease.
        crate::feeds::Feeds::global(cx)
            .read(cx)
            .set_camera_preview_rendering(rendering);
    }
    if lease.camera_was_visible
        && let Some(camera) = lease.camera
        && cx.global::<AppWindows>().camera == Some(camera)
    {
        let result = camera.update(cx, |_, window, cx| {
            platform::set_x11_window_visible(window, true)?;
            cx.notify();
            Ok::<_, anyhow::Error>(())
        });
        if let Err(error) = result.and_then(|result| result) {
            tracing::warn!(%error, "could not restore the camera preview");
        }
    }
    let main = cx.global::<AppWindows>().main;
    let result = main.update(cx, |_, window, cx| {
        platform::set_x11_window_visible(window, lease.main_was_visible)?;
        cx.notify();
        Ok::<_, anyhow::Error>(())
    });
    if let Err(error) = result.and_then(|result| result) {
        tracing::warn!(%error, "could not restore the main window");
    }
    update_camera_presentation(true, cx);
    true
}

#[cfg(target_os = "linux")]
pub fn handle_clean_capture_shortcut(state: global_hotkey::HotKeyState, cx: &mut App) {
    let Some(lease) = cx.global_mut::<AppWindows>().clean_capture.as_mut() else {
        return;
    };
    if lease.restoring {
        return;
    }
    let Some(action) = lease.gate.shortcut(state) else {
        return;
    };
    if action == CleanCaptureAction::Stop {
        if RecordingSession::global(cx).read(cx).phase == Phase::Idle {
            cancel_clean_capture(cx);
        } else {
            RecordingSession::global(cx).update(cx, |session, cx| session.stop(cx));
        }
        return;
    }
    let generation = lease.generation;
    let Some(mut config) = lease.config.take() else {
        return;
    };
    let current_inputs = CleanCaptureInputs::current(cx);
    if cx
        .global::<AppWindows>()
        .clean_capture
        .as_ref()
        .is_none_or(|lease| lease.requested_inputs != current_inputs)
    {
        restore_clean_capture_ui(cx);
        report_clean_capture_error(
            anyhow::anyhow!(
                "Selected devices changed. Start again to confirm the new recording inputs."
            ),
            cx,
        );
        return;
    }
    if let Err(error) = refresh_linux_instant_camera(&mut config, cx) {
        restore_clean_capture_ui(cx);
        report_clean_capture_error(error, cx);
        return;
    }
    if let Some(lease) = cx.global_mut::<AppWindows>().clean_capture.as_mut() {
        lease.config = Some(config);
    }
    let visibility = match hide_clean_capture_ui(cx) {
        Ok(visibility) => visibility,
        Err(error) => {
            restore_clean_capture_ui(cx);
            report_clean_capture_error(error, cx);
            return;
        }
    };
    let visibility = gpui_tokio::Tokio::spawn(cx, visibility);
    cx.spawn(async move |cx| {
        let result = visibility.await.map_err(anyhow::Error::from).and_then(|result| result);
        if let Err(error) = result {
            cx.update(|cx| {
                if clean_capture_generation_matches(generation, cx) {
                    restore_clean_capture_ui(cx);
                    report_clean_capture_error(error, cx);
                }
            });
            return;
        }
        cx.background_executor()
            .timer(std::time::Duration::from_millis(150))
            .await;
        cx.update(|cx| {
            let current_inputs = CleanCaptureInputs::current(cx);
            if cx
                .global::<AppWindows>()
                .clean_capture
                .as_ref()
                .is_some_and(|lease| {
                    lease.generation == generation && lease.requested_inputs != current_inputs
                })
            {
                restore_clean_capture_ui(cx);
                report_clean_capture_error(
                    anyhow::anyhow!("Selected devices changed before recording started. Start again to confirm the inputs."),
                    cx,
                );
                return;
            }
            let config = cx
                .global_mut::<AppWindows>()
                .clean_capture
                .as_mut()
                .and_then(|lease| lease.take_start_config(generation));
            if let Some(config) = config {
                begin_recording_after_preflight(config, cx);
            }
        });
    })
    .detach();
}

/// The whole start flow: bar up (in its Starting state), main window hidden,
/// engine started with the bar excluded from capture.
pub fn begin_recording(mut config: StartConfig, cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle {
        return;
    }
    if session.read(cx).editor_recording_target().is_some() {
        config.mode = RecordingMode::Studio;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(lease) = cx.global::<AppWindows>().clean_capture.as_ref() {
            if let Some(error) = lease.restoration_error.clone() {
                session.update(cx, |session, cx| {
                    session.error = Some(format!(
                        "Recording cleanup is incomplete: {error}. A new recording is blocked."
                    ));
                    cx.notify();
                });
            }
            return;
        }
        let wayland = cap_recording::screenshot::uses_wayland_portal();
        if clean_capture_supported(
            config.mode,
            &config.target,
            config.camera.is_some(),
            wayland,
        ) {
            if let Err(error) = prepare_clean_capture(config, cx) {
                report_clean_capture_error(error, cx);
            }
            return;
        }
        if let Err(error) = refresh_linux_instant_camera(&mut config, cx) {
            report_clean_capture_error(error, cx);
            return;
        }
    }
    begin_recording_after_preflight(config, cx);
}

fn begin_recording_after_preflight(config: StartConfig, cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle {
        return;
    }

    // `start_recording`'s first act (`src-tauri/src/recording.rs:1492-1494`):
    // an armed editor recording target forces Studio, whatever mode the main
    // window is in -- the finished capture has to append as an editable clip.
    let mut config = config;
    let editor_target = session.read(cx).editor_recording_target();
    if editor_target.is_some() {
        config.mode = RecordingMode::Studio;
    }
    // `recording.rs:1775-1780`: the target editor gets content protection for
    // the recording's duration (it is hidden-for-picker already, but a dock
    // click can bring it back mid-capture, and a protected window stays out of
    // the frame when it does). The Tauri arm also `minimize()`s it; here the
    // picker's hide already took it off screen, and the finish path's reveal
    // is the same un-hiding either way.
    if let Some(editor_path) = &editor_target {
        set_editor_content_protection(editor_path, true, cx);
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
    // `recording.rs:1897-1904` adds a `teleprompter_exclusion` to every active
    // recording, in both modes -- the script is for the presenter, never for
    // the audience. The window number is the exclusion; the content protection
    // below is the second half, for captures that are not ours.
    if let Some(number) = teleprompter_window_number(cx)
        && let Ok(id) = number.to_string().parse()
    {
        tracing::info!(number, "excluding the teleprompter window from the capture");
        excluded.push(id);
    }
    set_teleprompter_content_protection(true, cx);

    for id in overlay_window_ids(cx) {
        if !excluded.contains(&id) {
            excluded.push(id);
        }
    }
    let recording_area = retain_recording_area(&config.target, cx);
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    cx.global_mut::<AppWindows>().editor_hidden_for_picker = None;

    // The user-configurable half. `resolve_excluded_window_ids` (in
    // `recording::start`) walks `CGWindowList` for *other* processes' windows;
    // our own carry no native title for it to match, so they are resolved from
    // the canonical-title table here -- `append_matching_webview_window_ids`
    // (`recording.rs:1905-1910`). The hard number-gates above are the same
    // defaults spelled out twice on purpose: they hold even if the user has
    // emptied the rule list.
    let rules = own_window_exclusion_rules(
        crate::store::GeneralSettings::load().excluded_windows,
        config.mode,
    );
    let own = own_windows(cx);
    append_own_excluded_window_ids(&mut excluded, &own, &rules);
    // `crate::windows::apply_content_protection(&app, true)` at
    // `recording.rs:1773`, camera at `:1617-1624`. The second half of the same
    // job: an excluded id keeps a window out of *our* capture, the sharing type
    // keeps it out of everyone else's.
    let camera_hidden = camera_content_protected(config.mode);
    let protected = content_protection_targets(&rules);
    apply_content_protection(
        own,
        move |kind| match kind {
            OwnWindow::Camera => camera_hidden,
            OwnWindow::TargetSelect => true,
            kind => protected.contains(&kind),
        },
        cx,
    );

    let bar_open = cx.global::<AppWindows>().controls.is_some();
    session.update(cx, |session, cx| {
        session.set_controls_open(bar_open, cx);
    });
    // `general_settings.main_window_recording_start_behaviour.perform(&window)`
    // at `recording.rs:1766-1771`, whose default (`Close`) is `window.hide()`
    // on macOS: the main window goes away at every recording start, whatever
    // else happened. Gating this on the bar having opened left the window in
    // the frame on any start that never got a bar.
    hide_main_window(cx);

    let config = StartConfig {
        excluded_windows: excluded,
        ..config
    };
    session.update(cx, |session, cx| session.start(config, cx));
    if let Some(handle) = recording_area {
        if session.read(cx).phase == Phase::Idle {
            close_target_overlays(cx);
        } else {
            make_recording_area_passive(handle, cx);
        }
    }
}

/// Open the camera preview bubble (idempotent). Placement is the Tauri
/// decision (`windows.rs:2278-2345`): the persisted position from the shared
/// store's `cameraWindowPosition` keys when it is still on the preferred
/// monitor -- the main window's, falling back to the cursor's, like
/// `CursorMonitorInfo::from_window(main)` over there -- else the default
/// bottom-right slot (see `camera_window::opening_position`).
pub fn open_camera_window(cx: &mut App) {
    #[cfg(target_os = "linux")]
    if clean_capture_active(cx) {
        return;
    }
    if cx.global::<AppWindows>().camera.is_some() {
        return;
    }

    let state = crate::store::load().camera_window.unwrap_or_default();
    let (width, height) = camera_window::window_size(&state, None);

    let main = cx.global::<AppWindows>().main;
    let display = main
        .update(cx, |_, window, _| window.bounds())
        .ok()
        .and_then(|bounds| {
            camera_window::display_for_point(
                f64::from(f32::from(bounds.origin.x + bounds.size.width / 2.)),
                f64::from(f32::from(bounds.origin.y + bounds.size.height / 2.)),
            )
        })
        .or_else(scap_targets::Display::get_containing_cursor)
        .unwrap_or_else(scap_targets::Display::primary);
    let (x, y) = camera_window::opening_position(&display);

    let inline = camera_preview_is_inline(cx);
    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(x), px(y)),
                size: size(px(width), px(height)),
            })),
            #[cfg(not(target_os = "linux"))]
            titlebar: None,
            #[cfg(target_os = "linux")]
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Camera".into()),
                ..Default::default()
            }),
            #[cfg(target_os = "linux")]
            app_id: Some("Cap".into()),
            #[cfg(target_os = "linux")]
            window_decorations: Some(gpui::WindowDecorations::Client),
            // Non-activating panel, same as the bar: the bubble is clickable
            // without stealing focus from what is being recorded.
            #[cfg(not(target_os = "linux"))]
            kind: WindowKind::PopUp,
            #[cfg(target_os = "linux")]
            kind: if cap_recording::screenshot::uses_wayland_portal() {
                WindowKind::Floating
            } else {
                WindowKind::PopUp
            },
            focus: false,
            show: !inline,
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
            let native = handle
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
                    if !inline {
                        platform::show_window_without_focus(window);
                    }
                    platform::native_window(window)
                })
                .ok()
                .flatten();
            remove_popup_window_chrome(native, cx);
            sync_camera_presentation(cx);
            sync_opened_camera_with_picker(cx);
            refresh_target_overlays(cx);
        }
        Err(error) => tracing::error!("camera window failed to open: {error:#}"),
    }
}

pub fn close_camera_window(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().camera.take() {
        #[cfg(not(target_os = "macos"))]
        if let Some(previous) = handle
            .update(cx, |view, _, cx| view.preview_image(cx))
            .ok()
            .flatten()
        {
            evict_overlay_camera_image(previous, cx);
        }
        let park = &mut cx.global_mut::<AppWindows>().camera_park;
        park.invalidate_pending();
        park.original = None;
        park.last_window = None;
        park.last_area = None;
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        refresh_target_overlays(cx);
    }
}

fn camera_preview_is_inline(cx: &App) -> bool {
    TargetSelect::global(cx).read(cx).mode == Some(TargetType::CameraOnly)
}

pub fn camera_preview_entity(cx: &mut App) -> Option<Entity<CameraWindow>> {
    cx.global::<AppWindows>()
        .camera?
        .update(cx, |_, _, cx| cx.entity())
        .ok()
}

fn sync_camera_presentation(cx: &mut App) {
    update_camera_presentation(false, cx);
}

fn update_camera_presentation(force: bool, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if cx.global::<AppWindows>().clean_capture.is_some() {
        return;
    }
    let Some(handle) = cx.global::<AppWindows>().camera else {
        return;
    };
    let inline = camera_preview_is_inline(cx);
    let changed = handle
        .update(cx, |view, window, cx| {
            let changed = view.is_inline() != inline;
            view.set_inline(inline, window, cx);
            changed
        })
        .unwrap_or(false);
    if !changed && !force {
        return;
    }
    cx.spawn(async move |cx| {
        #[cfg(not(target_os = "linux"))]
        let native = cx.update(|cx| {
            if cx.global::<AppWindows>().camera != Some(handle)
                || camera_preview_is_inline(cx) != inline
            {
                return None;
            }
            handle
                .update(cx, |_, window, _| {
                    #[cfg(target_os = "windows")]
                    if !inline {
                        platform::show_window_without_focus(window);
                        return None;
                    }
                    platform::native_window(window)
                })
                .ok()
                .flatten()
        });
        #[cfg(not(target_os = "linux"))]
        if let Some(native) = native {
            if inline {
                platform::hide_native(&native);
            } else {
                platform::order_front_native(&native);
            }
        }
        #[cfg(target_os = "linux")]
        cx.update(|cx| {
            if cx.global::<AppWindows>().camera != Some(handle)
                || camera_preview_is_inline(cx) != inline
                || cx.global::<AppWindows>().clean_capture.is_some()
            {
                return;
            }
            let result = handle.update(cx, |_, window, _| {
                if cap_recording::screenshot::uses_wayland_portal() {
                    window.set_retained_visibility(!inline).map(|_| ())
                } else {
                    platform::set_x11_window_visible(window, !inline)
                }
            });
            if let Err(error) = result.and_then(|result| result) {
                tracing::warn!(%error, "could not update camera picker visibility");
            }
        });
    })
    .detach();
}

const CAMERA_PARK_PADDING: f32 = 16.;

struct CameraFrame {
    native: CameraNativeFrame,
    snapshot: CameraSnapshot,
    visible: bool,
}

enum CameraNativeFrame {
    #[cfg(target_os = "macos")]
    Mac {
        native: platform::NativeWindow,
        frame: (f64, f64, f64, f64),
    },
    #[cfg(target_os = "windows")]
    Windows(platform::NativeWindow),
    #[cfg(target_os = "linux")]
    X11 { window_id: u32, scale: f64 },
}

#[cfg(target_os = "macos")]
fn camera_native_frame(window: &gpui::Window) -> Option<(CameraNativeFrame, AreaRect)> {
    let native = platform::native_window(window)?;
    let frame = platform::window_frame(&native);
    let origin = window.bounds().origin;
    Some((
        CameraNativeFrame::Mac { native, frame },
        AreaRect {
            x: f32::from(origin.x),
            y: f32::from(origin.y),
            width: frame.2 as f32,
            height: frame.3 as f32,
        },
    ))
}

#[cfg(target_os = "windows")]
fn camera_native_frame(window: &gpui::Window) -> Option<(CameraNativeFrame, AreaRect)> {
    let native = platform::native_window(window)?;
    let (x, y, width, height) = platform::window_logical_frame(&native);
    Some((
        CameraNativeFrame::Windows(native),
        AreaRect {
            x: x as f32,
            y: y as f32,
            width: width as f32,
            height: height as f32,
        },
    ))
}

#[cfg(target_os = "linux")]
fn camera_native_frame(window: &gpui::Window) -> Option<(CameraNativeFrame, AreaRect)> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let window_id = match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xlib(handle) => u32::try_from(handle.window).ok()?,
        RawWindowHandle::Xcb(handle) => handle.window.get(),
        _ => return None,
    };
    let bounds = window.bounds();
    Some((
        CameraNativeFrame::X11 {
            window_id,
            scale: f64::from(window.scale_factor()),
        },
        AreaRect {
            x: f32::from(bounds.origin.x),
            y: f32::from(bounds.origin.y),
            width: f32::from(bounds.size.width),
            height: f32::from(bounds.size.height),
        },
    ))
}

fn camera_frame(cx: &mut App) -> Option<CameraFrame> {
    let handle = cx.global::<AppWindows>().camera?;
    handle
        .update(cx, |view, window, _| {
            let (native, bounds) = camera_native_frame(window)?;
            Some(CameraFrame {
                native,
                visible: platform::window_is_visible(window),
                snapshot: CameraSnapshot {
                    handle,
                    bounds,
                    picker_size: view.picker_size(),
                },
            })
        })
        .ok()
        .flatten()
        .filter(|camera| camera.snapshot.bounds.width > 0. && camera.snapshot.bounds.height > 0.)
}

fn visible_camera_frame(cx: &mut App) -> Option<CameraFrame> {
    if camera_preview_is_inline(cx) {
        return None;
    }
    #[cfg(target_os = "linux")]
    if clean_capture_active(cx) {
        return None;
    }
    camera_frame(cx).filter(|camera| camera.visible)
}

fn camera_snapshot(cx: &mut App) -> Option<CameraSnapshot> {
    let mut snapshot = camera_frame(cx)?.snapshot;
    if let Some(pending) = cx.global::<AppWindows>().camera_park.pending
        && pending.camera == snapshot.handle
    {
        snapshot.bounds = pending.bounds;
        if let CameraSizeOverride::Set(picker_size) = pending.size_override {
            snapshot.picker_size = picker_size;
        }
    }
    Some(snapshot)
}

impl CameraFrame {
    fn raise(&self) -> anyhow::Result<()> {
        match &self.native {
            #[cfg(target_os = "macos")]
            CameraNativeFrame::Mac { native, .. } => platform::order_front_native(native),
            #[cfg(target_os = "windows")]
            CameraNativeFrame::Windows(native) => platform::order_front_native(native),
            #[cfg(target_os = "linux")]
            CameraNativeFrame::X11 { window_id, .. } => {
                use x11rb::connection::Connection as _;
                use x11rb::protocol::xproto::{
                    ConfigureWindowAux, ConnectionExt as _, MapState, StackMode,
                };

                let (connection, _) = x11rb::connect(None)?;
                if connection
                    .get_window_attributes(*window_id)?
                    .reply()?
                    .map_state
                    == MapState::VIEWABLE
                {
                    connection
                        .configure_window(
                            *window_id,
                            &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
                        )?
                        .check()?;
                    connection.flush()?;
                }
            }
        }
        Ok(())
    }

    fn apply(self, bounds: AreaRect) -> anyhow::Result<()> {
        match self.native {
            #[cfg(target_os = "macos")]
            CameraNativeFrame::Mac { native, frame } => {
                let dx = f64::from(bounds.x - self.snapshot.bounds.x);
                let dy = f64::from(bounds.y - self.snapshot.bounds.y);
                platform::set_window_frame(
                    &native,
                    frame.0 + dx,
                    frame.1 + frame.3 - dy - f64::from(bounds.height),
                    f64::from(bounds.width),
                    f64::from(bounds.height),
                );
                if self.visible {
                    platform::order_front_native(&native);
                }
            }
            #[cfg(target_os = "windows")]
            CameraNativeFrame::Windows(native) => {
                platform::set_window_logical_frame(
                    &native,
                    f64::from(bounds.x),
                    f64::from(bounds.y),
                    f64::from(bounds.width),
                    f64::from(bounds.height),
                );
                if self.visible {
                    platform::order_front_native(&native);
                }
            }
            #[cfg(target_os = "linux")]
            CameraNativeFrame::X11 { window_id, scale } => {
                use x11rb::connection::Connection as _;
                use x11rb::protocol::xproto::{
                    ConfigureWindowAux, ConnectionExt as _, MapState, StackMode,
                };

                let (connection, _) = x11rb::connect(None)?;
                let mut changes = ConfigureWindowAux::new()
                    .x((f64::from(bounds.x) * scale).round() as i32)
                    .y((f64::from(bounds.y) * scale).round() as i32)
                    .width((f64::from(bounds.width) * scale).round().max(1.) as u32)
                    .height((f64::from(bounds.height) * scale).round().max(1.) as u32);
                if connection
                    .get_window_attributes(window_id)?
                    .reply()?
                    .map_state
                    == MapState::VIEWABLE
                {
                    changes = changes.stack_mode(StackMode::ABOVE);
                }
                connection.configure_window(window_id, &changes)?.check()?;
                connection.flush()?;
            }
        }
        Ok(())
    }
}

fn queue_camera_placement(placement: CameraPlacement, cx: &mut App) {
    let park = &mut cx.global_mut::<AppWindows>().camera_park;
    park.invalidate_pending();
    park.pending = Some(placement);
    let generation = park.generation;
    cx.spawn(async move |cx| {
        let camera = cx.update(|cx| {
            let windows = cx.global::<AppWindows>();
            if windows.camera_park.generation != generation
                || windows.camera != Some(placement.camera)
            {
                return None;
            }
            let Some(frame) = camera_frame(cx) else {
                let park = &mut cx.global_mut::<AppWindows>().camera_park;
                park.invalidate_pending();
                park.last_window = None;
                park.last_area = None;
                return None;
            };
            placement
                .camera
                .update(cx, |view, window, cx| {
                    view.invalidate_pending_resize();
                    if let CameraSizeOverride::Set(picker_size) = placement.size_override {
                        view.set_picker_size(picker_size, window, cx);
                    }
                })
                .ok()?;
            cx.global_mut::<AppWindows>().camera_park.pending = None;
            Some(frame)
        });
        // Native setters re-enter GPUI; no App or camera entity borrow may survive this call.
        if let Some(camera) = camera
            && let Err(error) = camera.apply(placement.bounds)
        {
            tracing::warn!(%error, "could not move the camera preview into the capture target");
            cx.update(|cx| {
                let park = &mut cx.global_mut::<AppWindows>().camera_park;
                if park.generation == generation {
                    park.last_window = None;
                    park.last_area = None;
                }
            });
        }
    })
    .detach();
}

fn arm_camera_park(mode: TargetType, cx: &mut App) {
    if cx.global::<AppWindows>().camera_park.mode == Some(mode) {
        return;
    }
    let original = (mode == TargetType::Window)
        .then(|| camera_snapshot(cx))
        .flatten();
    let park = &mut cx.global_mut::<AppWindows>().camera_park;
    let pending = park.pending;
    park.invalidate_pending();
    park.reset_selection();
    park.mode = Some(mode);
    park.original = original;
    if let Some(pending) = pending {
        queue_camera_placement(pending, cx);
    }
}

fn sync_opened_camera_with_picker(cx: &mut App) {
    let select = TargetSelect::global(cx);
    match select.read(cx).mode {
        Some(TargetType::Window) => {
            let target = select.read(cx).active_window().cloned();
            sync_camera_park(target, cx);
        }
        Some(TargetType::Area) => {
            if let Some((display, crop)) = cx.global::<AppWindows>().camera_park.area_target.clone()
            {
                sync_camera_area(display, Some(crop), cx);
            }
        }
        _ => {}
    }
}

pub fn camera_picker_epoch(cx: &App) -> u64 {
    cx.global::<AppWindows>().camera_park.epoch
}

pub fn sync_camera_park(active: Option<HoveredWindow>, cx: &mut App) {
    if !cx.has_global::<AppWindows>()
        || TargetSelect::global(cx).read(cx).mode != Some(TargetType::Window)
    {
        return;
    }
    let Some(target) = active else {
        cx.global_mut::<AppWindows>().camera_park.last_window = None;
        return;
    };
    let park = &cx.global::<AppWindows>().camera_park;
    if park.released || park.last_window.as_ref() == Some(&target.id) {
        return;
    }
    if park_camera_in_window(&target, cx) {
        cx.global_mut::<AppWindows>().camera_park.last_window = Some(target.id);
    }
}

fn camera_park_position(
    display_origin: (f32, f32),
    window: AreaRect,
    camera: (f32, f32),
) -> Option<(f32, f32)> {
    let (camera_width, camera_height) = camera;
    if camera_width + CAMERA_PARK_PADDING * 2. > window.width
        || camera_height + CAMERA_PARK_PADDING * 2. > window.height
    {
        return None;
    }
    let absolute_x = window.x + display_origin.0;
    let absolute_y = window.y + display_origin.1;
    Some((
        (absolute_x + window.width - camera_width - CAMERA_PARK_PADDING + 0.5).floor(),
        (absolute_y + window.height - camera_height - CAMERA_PARK_PADDING + 0.5).floor(),
    ))
}

fn park_camera_in_window(target: &HoveredWindow, cx: &mut App) -> bool {
    let Some(display) = scap_targets::Display::from_id(&target.display_id) else {
        return false;
    };
    let Some(display_bounds) = display.raw_handle().logical_bounds() else {
        return false;
    };
    let Some(camera) = camera_snapshot(cx) else {
        return false;
    };

    let display_origin = (
        display_bounds.position().x() as f32,
        display_bounds.position().y() as f32,
    );
    let Some((x, y)) = camera_park_position(
        display_origin,
        target.bounds,
        (camera.bounds.width, camera.bounds.height),
    ) else {
        return false;
    };

    let park = &mut cx.global_mut::<AppWindows>().camera_park;
    if park
        .original
        .is_none_or(|original| original.handle != camera.handle)
    {
        park.original = Some(camera);
    }
    queue_camera_placement(
        CameraPlacement {
            camera: camera.handle,
            bounds: AreaRect {
                x,
                y,
                ..camera.bounds
            },
            size_override: CameraSizeOverride::Preserve,
        },
        cx,
    );
    true
}

fn camera_area_bounds(
    display_origin: (f32, f32),
    crop: AreaRect,
    original_size: (f32, f32),
) -> Option<AreaRect> {
    let (original_width, original_height) = original_size;
    let toolbar = camera_window::CAMERA_TOOLBAR_HEIGHT;
    let content_height = (original_height - toolbar).max(0.);
    let content_max = original_width.max(content_height);
    let target_max = 100_f32.max(content_max.min(crop.width.min(crop.height) * 0.5 - toolbar));
    let scale = if content_max > 0. {
        target_max / content_max
    } else {
        1.
    };
    let width = (original_width * scale).round();
    let height = (content_height * scale).round() + toolbar;
    if crop.width <= width + CAMERA_PARK_PADDING * 2.
        || crop.height <= height + CAMERA_PARK_PADDING * 2.
    {
        return None;
    }
    Some(AreaRect {
        x: (crop.x + crop.width - width - CAMERA_PARK_PADDING).round() + display_origin.0,
        y: (crop.y + crop.height - height - CAMERA_PARK_PADDING).round() + display_origin.1,
        width,
        height,
    })
}

fn camera_area_bounds_changed(previous: AreaRect, next: AreaRect) -> bool {
    (previous.x - next.x).abs() > 1.
        || (previous.y - next.y).abs() > 1.
        || (previous.width - next.width).abs() > 1.
        || (previous.height - next.height).abs() > 1.
}

pub fn sync_camera_area(display_id: DisplayId, crop: Option<AreaRect>, cx: &mut App) {
    if !cx.has_global::<AppWindows>()
        || !cx
            .global::<AppWindows>()
            .overlays
            .iter()
            .any(|(display, _)| *display == display_id)
    {
        return;
    }
    let select = TargetSelect::global(cx);
    if select.read(cx).mode != Some(TargetType::Area)
        || select.read(cx).recording_mode == Mode::Screenshot
        || cx.global::<AppWindows>().camera_park.released
    {
        return;
    }
    let Some(crop) = crop else {
        if cx
            .global::<AppWindows>()
            .camera_park
            .area_target
            .as_ref()
            .is_none_or(|(display, _)| *display == display_id)
        {
            revert_camera_park(cx);
            arm_camera_park(TargetType::Area, cx);
        }
        return;
    };
    cx.global_mut::<AppWindows>().camera_park.area_target = Some((display_id.clone(), crop));
    let Some(display) = scap_targets::Display::from_id(&display_id) else {
        return;
    };
    let Some(display_bounds) = display.raw_handle().logical_bounds() else {
        return;
    };
    let Some(camera) = camera_snapshot(cx) else {
        return;
    };
    let park = &mut cx.global_mut::<AppWindows>().camera_park;
    let original = match park.original {
        Some(original) if original.handle == camera.handle => original,
        _ => {
            park.original = Some(camera);
            camera
        }
    };
    let Some(bounds) = camera_area_bounds(
        (
            display_bounds.position().x() as f32,
            display_bounds.position().y() as f32,
        ),
        crop,
        (original.bounds.width, original.bounds.height),
    ) else {
        return;
    };
    if park
        .last_area
        .is_some_and(|last| !camera_area_bounds_changed(last, bounds))
    {
        return;
    }
    park.last_area = Some(bounds);
    queue_camera_placement(
        CameraPlacement {
            camera: camera.handle,
            bounds,
            size_override: CameraSizeOverride::Set(Some((bounds.width, bounds.height))),
        },
        cx,
    );
}

pub fn release_camera_park(cx: &mut App) {
    if !cx.has_global::<AppWindows>() {
        return;
    }
    let park = &mut cx.global_mut::<AppWindows>().camera_park;
    park.original = None;
    park.released = true;
}

fn revert_camera_park(cx: &mut App) {
    let park = &mut cx.global_mut::<AppWindows>().camera_park;
    let original = park.original;
    let mode = park.mode;
    if !park.released {
        park.invalidate_pending();
    }
    park.reset_selection();
    let Some(original) = original else {
        return;
    };
    let Some(camera) = camera_snapshot(cx).filter(|camera| camera.handle == original.handle) else {
        return;
    };
    let (bounds, size_override) = if mode == Some(TargetType::Area) {
        (
            original.bounds,
            CameraSizeOverride::Set(original.picker_size),
        )
    } else {
        (
            AreaRect {
                x: original.bounds.x,
                y: original.bounds.y,
                ..camera.bounds
            },
            CameraSizeOverride::Preserve,
        )
    };
    queue_camera_placement(
        CameraPlacement {
            camera: original.handle,
            bounds,
            size_override,
        },
        cx,
    );
}

/// Hand a camera frame to the preview window. Returns false when no window is
/// open (the pump drops the frame and keeps draining).
pub fn deliver_camera_frame(
    #[cfg(target_os = "macos")] frame: cap_recording::NativeCameraFrame,
    #[cfg(not(target_os = "macos"))] frame: crate::camera_window::CameraPreviewFrame,
    cx: &mut App,
) -> bool {
    let Some(handle) = cx.global::<AppWindows>().camera else {
        return false;
    };
    #[cfg(not(target_os = "macos"))]
    let previous = camera_preview_is_inline(cx)
        .then(|| {
            handle
                .update(cx, |view, _, cx| view.preview_image(cx))
                .ok()
                .flatten()
        })
        .flatten();
    let delivered = handle
        .update(cx, |view, window, cx| view.frame_arrived(frame, window, cx))
        .is_ok();
    #[cfg(not(target_os = "macos"))]
    if let Some(previous) = previous {
        evict_overlay_camera_image(previous, cx);
    }
    delivered
}

#[cfg(not(target_os = "macos"))]
fn evict_overlay_camera_image(image: Arc<gpui::RenderImage>, cx: &mut App) {
    let overlays = cx.global::<AppWindows>().overlays.clone();
    for (_, overlay) in overlays {
        overlay
            .update(cx, |_, window, _| {
                let _ = window.drop_image(image.clone());
            })
            .ok();
    }
}

// -- Editor -----------------------------------------------------------------

/// The canonical form of a `.cap` path, so the same bundle reached by two
/// spellings is one window. `EditorWindowIds` compares `PathBuf`s directly;
/// canonicalising is strictly the safer version of the same rule.
fn editor_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Open (or focus) the editor for a `.cap` bundle.
///
/// `ShowCapWindow::Editor` looks the path up in `EditorWindowIds` and reuses
/// the window it finds (`windows.rs:1164-1181`), so opening the same project
/// twice focuses the first one. It also calls `hide_recording_windows(app,
/// false)` first (`windows.rs:1930`), which hides Main among others, and
/// `openRecording` in the frontend hides the main window again explicitly
/// (`new-main/index.tsx:2925`) -- so the main window going away is both halves
/// of the shipping behaviour, not an invention here.
///
/// Must be reached through `cx.defer` from anything inside an entity update:
/// opening a window paints it synchronously and would double-lease the caller.
pub fn open_editor(project_path: PathBuf, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    let key = editor_key(&project_path);
    if cx.global::<AppWindows>().deleting_editors.contains(&key) {
        tracing::info!(path = %key.display(), "recording deletion is still settling; editor remains closed");
        return;
    }

    if cx
        .global::<AppWindows>()
        .editors
        .iter()
        .any(|(path, _)| path == &key)
    {
        tracing::info!(
            path = %key.display(),
            "editor already open for this project; focusing it"
        );
        hide_main_and_park_camera_preview(cx);
        reveal_editor_window(&key, cx);
        return;
    }

    // `cursor_monitor.center_position(1275.0, 800.0)` in the Tauri arm; gpui
    // centres on the active display, which is the same one in every
    // single-pointer case.
    let bounds = Bounds::centered(
        None,
        size(
            px(editor_window::EDITOR_WIDTH),
            px(editor_window::EDITOR_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // Native traffic lights, inset to (20, 32):
            // `CapWindowId::Editor::traffic_lights_position` is
            // `Some(Some(LogicalPosition::new(20.0, 32.0)))`, and the header's
            // left group reserves an `h-full w-16` spacer for them.
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Editor".into()),
                appears_transparent: true,
                traffic_light_position: editor_window::TRAFFIC_LIGHTS,
            }),
            // An ordinary window that activates the dock icon
            // (`activates_dock()` lists Editor); no level or Spaces treatment.
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `.maximizable(true)` with `min_inner_size == inner_size`.
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(editor_window::EDITOR_WIDTH),
                px(editor_window::EDITOR_HEIGHT),
            )),
            // Opaque, and no native material: `is_transparent()`
            // (`windows.rs:1069-1082`) does not list Editor, and
            // `applyMacOSWindowMaterial` runs only in the `(window-chrome)`
            // layout -- `/editor` is a sibling route, not one of its children.
            ..Default::default()
        },
        {
            let key = key.clone();
            move |window, cx| cx.new(|cx| EditorWindow::new(key, window, cx))
        },
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("editor window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>()
        .editors
        .push((key.clone(), handle));

    handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            #[cfg(target_os = "windows")]
            platform::maximize_if_larger_than_work_area(window, cx);
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                path = %key.display(),
                "editor window opened"
            );
        })
        .ok();

    hide_main_and_park_camera_preview(cx);
    reveal_editor_window(&key, cx);
    load_editor_project(key, handle, cx);
}

/// Build the `EditorInstance` and get frame 0 on screen.
///
/// Everything expensive is off the UI thread: the pre-flight validation runs
/// on gpui's background executor, and the instance -- decoders, renderer,
/// preview renderer, all of which are tokio-spawned -- is constructed on the
/// `gpui_tokio` runtime. `EditorInstance::new` on the main thread would block
/// it for however long the first segment takes to open.
fn load_editor_project(path: PathBuf, handle: WindowHandle<EditorWindow>, cx: &mut App) {
    cx.spawn(async move |cx| {
        let preflight_path = path.clone();
        let summary = cx
            .background_executor()
            .spawn(async move { editor_window::preflight(&preflight_path) })
            .await;

        let summary = match summary {
            Ok(summary) => summary,
            Err(message) => {
                handle
                    .update(cx, |view, window, cx| view.set_error(message, window, cx))
                    .ok();
                return;
            }
        };
        tracing::info!(
            path = %path.display(),
            clips = summary.timeline.clips.len(),
            duration = format!("{:.3}", summary.duration),
            camera = summary.has_camera,
            cursor = summary.has_cursor_data,
            "editor project validated"
        );
        log_timeline_model(&summary.timeline);
        let recordings = summary.recordings.clone();
        if handle
            .update(cx, |view, window, cx| view.set_summary(summary, window, cx))
            .is_err()
        {
            return;
        }

        // The frame seam. Bounded and try_send-only: the renderer is already
        // latest-wins (`editor.rs:242-312`), so a full queue means the UI is
        // behind and the newest frame is the one that matters.
        let (frame_tx, frame_rx) = flume::bounded(4);
        let stats = Arc::new(editor_window::PumpStats::default());
        // The playhead seam. `on_state_change` is called from the
        // `cap-playback` OS thread and from tokio workers, so it may only
        // store and poke; the drain below is what touches the entity.
        let (playhead, playhead_rx) = editor_window::PlayheadSignal::new();
        let instance_path = path.clone();
        let task = cx.update(|cx| {
            let frame_stats = stats.clone();
            let playhead = playhead.clone();
            gpui_tokio::Tokio::spawn(cx, async move {
                // `EditorInstance::new`: the real constructor, exactly as the
                // Tauri app calls it (`lib.rs:6592`) -- except under
                // `CAP_GPUI_MUTE_AUDIO=1`, which swaps in the headless audio
                // output (the integration test's constructor) so playback
                // stays silent: verification probes must be able to run while
                // the user is on a call, and the editor otherwise plays the
                // recording's audio through the default output the moment
                // Play is pressed (the stream prewarms at load,
                // `editor_instance.rs:305`). The video pump is identical on
                // both paths.
                //
                // `shared_device: None`: gpui on macOS is Metal-direct and
                // exposes no wgpu device to share, so cap-rendering owns its
                // own. Two GPU contexts in-process is the shape the Tauri app
                // already has.
                let state_cb = editor_window::make_state_callback(playhead);
                let frame_cb = editor_window::make_frame_callback(frame_tx, frame_stats);
                #[cfg(target_os = "macos")]
                let frame_format = cap_editor::EditorFrameFormat::BgraSurface;
                #[cfg(not(target_os = "macos"))]
                let frame_format = cap_editor::EditorFrameFormat::Rgba;
                let audio_output = if std::env::var("CAP_GPUI_MUTE_AUDIO").is_ok_and(|v| v == "1") {
                    std::sync::Arc::new(cap_editor::AudioOutput::new_headless(Box::new(
                        |_samples, _at| {},
                    )))
                } else {
                    std::sync::Arc::new(cap_editor::AudioOutput::new())
                };
                cap_editor::EditorInstance::new_with_preloaded_recordings(
                    instance_path,
                    state_cb,
                    frame_cb,
                    None,
                    frame_format,
                    audio_output,
                    recordings,
                )
                .await
            })
        });

        let instance = match task.await {
            Ok(Ok(instance)) => instance,
            Ok(Err(error)) => {
                handle
                    .update(cx, |view, window, cx| view.set_error(error, window, cx))
                    .ok();
                return;
            }
            Err(join_error) => {
                handle
                    .update(cx, |view, window, cx| {
                        view.set_error(
                            format!("Opening this recording failed: {join_error}"),
                            window,
                            cx,
                        )
                    })
                    .ok();
                return;
            }
        };

        tracing::info!(path = %path.display(), "editor instance ready");
        if handle
            .update(cx, |view, _window, _cx| view.set_instance(instance.clone()))
            .is_err()
        {
            instance.dispose().await;
            return;
        }

        // The pump: convert on the background executor (un-padding plus the
        // BGRA swap is a few megabytes per frame), deliver on the main one.
        cx.spawn({
            let stats = stats.clone();
            async move |cx| {
                while let Ok((output, layout)) = frame_rx.recv_async().await {
                    let (frame, number) = match output {
                        cap_editor::EditorFrameOutput::Rgba(rgba) => {
                            let stats = stats.clone();
                            let number = rgba.frame_number;
                            let image = cx
                                .background_executor()
                                .spawn(
                                    async move { editor_window::frame_image_timed(&rgba, &stats) },
                                )
                                .await;
                            let Some(image) = image else {
                                tracing::warn!(
                                    "a rendered frame could not be converted for display"
                                );
                                continue;
                            };
                            (editor_window::EditorPreviewFrame::Image(image), number)
                        }
                        cap_editor::EditorFrameOutput::Nv12(frame) => {
                            tracing::warn!(
                                number = frame.frame_number,
                                "buffer-backed NV12 preview is unsupported"
                            );
                            continue;
                        }
                        #[cfg(target_os = "macos")]
                        cap_editor::EditorFrameOutput::Surface(surface) => {
                            let number = surface.frame_number;
                            (editor_window::surface_preview_frame(surface), number)
                        }
                    };
                    if handle
                        .update(cx, |view, window, cx| {
                            view.frame_arrived(
                                editor_window::EditorFrame {
                                    frame,
                                    layout,
                                    number,
                                },
                                window,
                                cx,
                            )
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            }
        })
        .detach();

        // The playhead drain. The signal is latest-wins, so this reads the
        // atomic rather than a queue: at 60Hz a backlog would only ever
        // describe the past.
        cx.spawn(async move |cx| {
            while playhead_rx.recv_async().await.is_ok() {
                let frame = playhead.position();
                if handle
                    .update(cx, |view, window, cx| {
                        view.playhead_changed(frame, window, cx)
                    })
                    .is_err()
                {
                    return;
                }
            }
        })
        .detach();

        // The transport driver: one task, applying the window's desired
        // transport state to the instance. Everything it calls locks
        // `instance.state`, so none of it may run on the UI thread.
        let (transport, driver, engine_stopped_rx) = editor_window::transport();
        let driver_instance = instance.clone();
        cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                editor_window::run_transport(driver_instance, driver).await;
            })
            .detach();
        });

        // The engine-stop drain: the driver's message that the engine died on
        // its own (end of timeline under a live seek, warmup abort, error),
        // delivered on the main thread like every other foreign-thread seam.
        cx.spawn(async move |cx| {
            while engine_stopped_rx.recv_async().await.is_ok() {
                if handle
                    .update(cx, |view, window, cx| view.engine_stopped(window, cx))
                    .is_err()
                {
                    return;
                }
            }
        })
        .detach();

        // `totalDuration()` (`context.ts:1374-1380`). Read off the instance
        // rather than the pre-flight, because `EditorInstance::new`
        // synthesises a timeline for a raw bundle -- and `timeline.duration()`
        // is exactly what the playback engine stops at
        // (`playback.rs:560-570`).
        //
        // The whole track model comes from the same read: the config the
        // instance actually loaded is the one being rendered, holds, clip
        // offsets and all. E4 hands the window the config itself rather than
        // the derived model, because it is what every edit mutates and what
        // the debounced save writes back.
        let (total, config) = {
            let config = instance.project_config.1.borrow().clone();
            let total = config
                .timeline
                .as_ref()
                .map_or(0.0, |timeline| timeline.duration());
            (total, config)
        };
        {
            let has_camera = instance
                .recordings
                .segments
                .iter()
                .any(|segment| segment.camera.is_some());
            let multiple_clips = instance.recordings.segments.len() > 1;
            log_timeline_model(&editor_timeline::TimelineModel::build(
                &config,
                has_camera,
                multiple_clips,
            ));
        }
        if handle
            .update(cx, |view, window, cx| view.set_project(config, window, cx))
            .is_err()
        {
            return;
        }
        load_editor_waveforms(instance.clone(), handle, cx);

        if handle
            .update(cx, |view, window, cx| {
                view.set_transport(transport, stats, total, window, cx)
            })
            .is_err()
        {
            return;
        }

        // The initial kick, exactly as `lib.rs:6617-6618` does it after
        // creating an instance. Without this the canvas stays black: `seek_to`
        // and `set_playhead_position` render nothing.
        editor_window::request_frame(
            &instance,
            0,
            editor_window::preview_resolution(
                crate::store::GeneralSettings::load().editor_preview_quality,
            ),
        );

        drive_auto_sidebar(handle, cx).await;
        drive_auto_playback(path, handle, cx).await;
        drive_auto_export(handle, cx).await;
    })
    .detach();
}

async fn drive_auto_export(handle: WindowHandle<EditorWindow>, cx: &mut gpui::AsyncApp) {
    let Some(path) = std::env::var_os("CAP_GPUI_AUTO_EXPORT").map(PathBuf::from) else {
        return;
    };

    cx.background_executor()
        .timer(std::time::Duration::from_millis(300))
        .await;
    let _ = handle.update(cx, |view, window, cx| {
        view.open_export(window, cx);
        if let Some(export) = view.export.as_mut() {
            export.destination = crate::editor_export::ExportDestination::File;
            export.format = if path.extension().is_some_and(|extension| extension == "gif") {
                crate::editor_export::ExportFormatKind::Gif
            } else {
                crate::editor_export::ExportFormatKind::Mp4
            };
            if export.format == crate::editor_export::ExportFormatKind::Gif {
                if export.resolution == crate::editor_export::ExportResolution::P4k {
                    export.resolution = crate::editor_export::ExportResolution::P1080;
                }
                if export.fps > 30 {
                    export.fps = 30;
                }
            }
        }
        tracing::info!(path = %path.display(), "auto editor export requested");
        view.start_export(window, cx);
    });
}

/// One line per timeline load naming every row and its segment count. The
/// track set is derived from the project's own content, so this is how a
/// fixture is checked to have actually deserialised rather than falling back
/// to the default config.
fn log_timeline_model(model: &editor_timeline::TimelineModel) {
    tracing::info!(
        rows = model.rows.len(),
        track_height = model.track_height(),
        total = format!("{:.3}", model.total_duration),
        clip = model.clips.len(),
        zoom = model.zoom.len(),
        scene = model.scene.len(),
        three_d = model.three_d.len(),
        text = model.text.len(),
        mask = model.mask.len(),
        audio = model.audio.len(),
        caption = model.caption.len(),
        keyboard = model.keyboard.len(),
        "editor timeline model"
    );
}

/// The clip track's waveforms (`get_mic_waveforms` / `get_system_audio_waveforms`,
/// `apps/desktop/src-tauri/src/lib.rs:4392-4434`).
///
/// Deliberately fire-and-forget, exactly as the frontend's own
/// `commands.getMicWaveforms().then(setMicWaveforms)` is
/// (`ED/context.ts:1526-1539`): the decode runs in the background after the
/// editor opens and may resolve well after the first frame, so nothing waits on
/// it and a failed track simply renders as an empty waveform. `AudioLoader::get`
/// awaits a tokio watch channel, so it runs on the tokio runtime; the peak
/// extraction itself is a per-sample loop over a whole track, which goes to the
/// background executor rather than the UI thread.
fn load_editor_waveforms(
    instance: Arc<cap_editor::EditorInstance>,
    handle: WindowHandle<EditorWindow>,
    cx: &mut gpui::AsyncApp,
) {
    cx.spawn(async move |cx| {
        let task = cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                let mut mic = Vec::with_capacity(instance.segment_medias.len());
                let mut system = Vec::with_capacity(instance.segment_medias.len());
                for segment in instance.segment_medias.iter() {
                    for (loader, out) in [
                        (&segment.audio, &mut mic),
                        (&segment.system_audio, &mut system),
                    ] {
                        match loader.get().await {
                            Ok(Some(audio)) => {
                                out.push((audio.samples().to_vec(), audio.channels()))
                            }
                            // A failed track is an empty waveform; playback and
                            // export surface the actual error.
                            _ => out.push((Vec::new(), 1)),
                        }
                    }
                }
                (mic, system)
            })
        });
        let Ok((mic, system)) = task.await else {
            return;
        };
        let peaks = cx
            .background_executor()
            .spawn(async move {
                let extract = |tracks: Vec<(Vec<f32>, u16)>| {
                    tracks
                        .into_iter()
                        .map(|(samples, channels)| {
                            Arc::new(editor_timeline::waveform_peaks(&samples, channels))
                        })
                        .collect::<Vec<_>>()
                };
                (extract(mic), extract(system))
            })
            .await;
        let _ = handle.update(cx, |view, window, cx| {
            tracing::info!(
                mic = peaks.0.iter().filter(|peaks| !peaks.is_empty()).count(),
                system = peaks.1.iter().filter(|peaks| !peaks.is_empty()).count(),
                "editor waveforms ready"
            );
            view.set_waveforms(peaks.0, peaks.1, window, cx)
        });
    })
    .detach();
}

/// `CAP_GPUI_AUTO_SIDEBAR=<tab>[:<scroll>]` selects a config-sidebar tab and
/// optionally scrolls its body, and `CAP_GPUI_AUTO_SELECT=<track>:<i>[,<i>]`
/// selects timeline segments so their panel opens.
///
/// They exist for the same reason as every other `CAP_GPUI_AUTO_*` hook, plus
/// one specific to this pane: **a synthetic wheel does not scroll the sidebar's
/// body.** A `CGEvent` scroll delivered over the sidebar reaches the app (the
/// timeline's own wheel handler logs one when the pointer is over the strip)
/// but moves nothing when it lands on the scroll body, so a tab taller than
/// 470px cannot be photographed below the fold without this.
async fn drive_auto_sidebar(handle: WindowHandle<EditorWindow>, cx: &mut gpui::AsyncApp) {
    let tab = std::env::var("CAP_GPUI_AUTO_SIDEBAR").ok();
    let select = std::env::var("CAP_GPUI_AUTO_SELECT").ok();
    let canvas = std::env::var("CAP_GPUI_AUTO_CANVAS").ok();
    let crop = std::env::var("CAP_GPUI_AUTO_CROP").ok();
    if tab.is_none() && select.is_none() && canvas.is_none() && crop.is_none() {
        return;
    }
    cx.background_executor()
        .timer(std::time::Duration::from_millis(1200))
        .await;

    if let Some(spec) = tab {
        let (name, scroll) = match spec.split_once(':') {
            Some((name, scroll)) => (name.to_string(), scroll.parse::<f32>().ok()),
            None => (spec, None),
        };
        handle
            .update(cx, |view, window, cx| {
                view.auto_select_sidebar_tab(&name, scroll, window, cx)
            })
            .ok();
    }

    if let Some(spec) = select {
        handle
            .update(cx, |view, _window, cx| view.auto_select_segments(&spec, cx))
            .ok();
    }

    // `CAP_GPUI_AUTO_CANVAS=1`: select the on-canvas display box, which a
    // click on it does. Before the crop hook, because opening the crop dialog
    // hides the overlay.
    if std::env::var("CAP_GPUI_AUTO_CANVAS").is_ok_and(|value| value == "1") {
        handle
            .update(cx, |view, window, cx| view.auto_canvas_select(window, cx))
            .ok();
    }

    // `CAP_GPUI_AUTO_CROP=1[:16x9][:nosnap]`: open the crop dialog through the
    // toolbar's own handler.
    if let Ok(spec) = std::env::var("CAP_GPUI_AUTO_CROP")
        && !spec.is_empty()
    {
        handle
            .update(cx, |view, window, cx| view.auto_crop(&spec, window, cx))
            .ok();
    }
}

/// `CAP_GPUI_AUTO_PLAYBACK=<seconds>` presses play once the project is up and
/// pauses N seconds later; `CAP_GPUI_AUTO_PLAYBACK_TORTURE=<cycles>` runs
/// play/pause/seek cycles instead. Both exist for the same reason as every
/// other `CAP_GPUI_AUTO_*` hook: unprivileged synthetic clicks are dropped, so
/// a verification run needs a way to press the button.
async fn drive_auto_playback(
    project_path: PathBuf,
    handle: WindowHandle<EditorWindow>,
    cx: &mut gpui::AsyncApp,
) {
    let play_secs = std::env::var("CAP_GPUI_AUTO_PLAYBACK")
        .ok()
        .and_then(|value| value.parse::<f64>().ok());
    let torture = std::env::var("CAP_GPUI_AUTO_PLAYBACK_TORTURE")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    // `CAP_GPUI_AUTO_SEEK=0.6`: a paused seek to 60% along the timeline, the
    // way a click on the ruler there does it.
    let seek = std::env::var("CAP_GPUI_AUTO_SEEK")
        .ok()
        .and_then(|value| value.parse::<f64>().ok());
    // `CAP_GPUI_AUTO_SCRUB_PLAYING=<n>`: a synthetic ruler drag during
    // playback -- n seeks at 33ms intervals sweeping 20% to 70% of the
    // timeline. This is the live-seek path's perf gate: every seek lands on a
    // RUNNING engine through `seek_to_time`, exactly as a real drag does.
    let scrub_playing = std::env::var("CAP_GPUI_AUTO_SCRUB_PLAYING")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    if play_secs.is_none() && torture.is_none() && seek.is_none() && scrub_playing.is_none() {
        return;
    }

    let sleep = |cx: &gpui::AsyncApp, millis: u64| {
        cx.background_executor()
            .timer(std::time::Duration::from_millis(millis))
    };
    // Let the first frame land and the decoders warm before the stopwatch
    // starts, the way a human would.
    sleep(cx, 1500).await;

    if let Some(cycles) = torture {
        tracing::info!(cycles, "auto playback torture: start");
        for cycle in 0..cycles {
            if handle
                .update(cx, |view, window, cx| view.toggle_play(window, cx))
                .is_err()
            {
                return;
            }
            sleep(cx, 320).await;
            if handle
                .update(cx, |view, window, cx| view.toggle_play(window, cx))
                .is_err()
            {
                return;
            }
            sleep(cx, 80).await;
            // A deterministic walk over the timeline rather than a random one,
            // so a failure is reproducible.
            let fraction = (cycle % 7) as f64 / 7.0;
            if handle
                .update(cx, |view, window, cx| {
                    view.seek_fraction(fraction, window, cx)
                })
                .is_err()
            {
                return;
            }
            sleep(cx, 120).await;
            tracing::info!(cycle = cycle + 1, "auto playback torture: cycle done");
        }
        tracing::info!(cycles, "auto playback torture: complete");
    }

    if let Some(fraction) = seek {
        handle
            .update(cx, |view, window, cx| {
                view.seek_fraction(fraction, window, cx)
            })
            .ok();
        tracing::info!(fraction, "auto seek");
    }

    if let Some(n) = scrub_playing {
        if handle
            .update(cx, |view, window, cx| view.toggle_play(window, cx))
            .is_err()
        {
            return;
        }
        sleep(cx, 800).await;
        tracing::info!(n, "auto scrub-while-playing: start");
        for i in 0..n {
            let fraction = 0.2 + 0.5 * (i as f64 / n.max(1) as f64);
            if handle
                .update(cx, |view, window, cx| {
                    view.seek_fraction(fraction, window, cx)
                })
                .is_err()
            {
                return;
            }
            sleep(cx, 33).await;
        }
        tracing::info!("auto scrub-while-playing: drag done");
        sleep(cx, 2000).await;
        handle
            .update(cx, |view, _window, cx| view.stop_for_measurement(cx))
            .ok();
    }

    // `CAP_GPUI_AUTO_EDITOR_CLOSE=<secs>`: close the editor that many seconds
    // into playback, through `performClose:` -- the traffic light's own path,
    // so the window's `on_window_should_close` handler and `editor_closed`
    // both run. Proof that a playing editor tears down cleanly.
    // Once only: the reopened editor runs the same code with the same
    // environment, and a second close would be an infinite loop rather than a
    // test.
    static CLOSE_SCENARIO_DONE: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    let close_after = std::env::var("CAP_GPUI_AUTO_EDITOR_CLOSE")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|_| !CLOSE_SCENARIO_DONE.swap(true, std::sync::atomic::Ordering::SeqCst));

    if let Some(secs) = play_secs {
        cx.update(|cx| cx.activate(true));
        if handle
            .update(cx, |_, window, _| window.activate_window())
            .is_err()
        {
            return;
        }
        sleep(cx, 200).await;
        if handle
            .update(cx, |view, window, cx| {
                tracing::info!(active = window.is_window_active(), "auto playback focus");
                view.toggle_play(window, cx)
            })
            .is_err()
        {
            return;
        }
        tracing::info!(secs, "auto playback: playing");
        if let Some(close_after) = close_after {
            sleep(cx, (close_after * 1000.0) as u64).await;
            let native = handle
                .update(cx, |_, window, _| platform::native_window(window))
                .ok()
                .flatten();
            tracing::info!(
                close_after,
                "auto playback: closing the editor mid-playback"
            );
            if let Some(native) = &native {
                platform::close_native(native);
            }
            // ...and open it again, to prove the teardown left nothing
            // behind. The second window takes the ordinary path: its own
            // instance, its own pump, its own transport.
            sleep(cx, 2000).await;
            tracing::info!("auto playback: reopening the editor");
            cx.update(|cx| open_editor(project_path, cx));
            return;
        }
        sleep(cx, (secs * 1000.0) as u64).await;
        handle
            .update(cx, |view, _window, cx| view.stop_for_measurement(cx))
            .ok();
    }
}

/// Whether closing an editor window should bring the main window back.
///
/// `restore_main_windows_if_no_editors` (`lib.rs:6242-6262`), transcribed:
/// the main window is reshown only once the last editor of either kind is
/// gone **and no Settings window exists** -- the Tauri arm is
/// `if CapWindowId::Settings.get(app).is_none() { main.show() }`. Closing an
/// editor opened from the Settings recordings page therefore leaves Settings
/// as the frontmost surface (AppKit hands it key status as the editor goes
/// away) rather than revealing main over it. The idle gate is this port's
/// own: during a recording the main window is deliberately hidden and the
/// session observer restores it when the recording ends.
fn reveal_main_after_editor_close(editors_left: usize, settings_open: bool, idle: bool) -> bool {
    editors_left == 0 && !settings_open && idle
}

/// An editor window is going away. `CapWindowId::Editor`'s `Destroyed` arm
/// drops it from `EditorWindowIds`, disposes the instance, and calls
/// `restore_main_windows_if_no_editors` (`lib.rs:5777-5792`) -- so the main
/// window comes back only once the last editor has closed, and never over an
/// open Settings window ([`reveal_main_after_editor_close`]).
pub fn editor_closed(project_path: &Path, window_id: gpui::WindowId, cx: &mut App) {
    let key = editor_key(project_path);
    let Some(handle) =
        take_editor_window(&mut cx.global_mut::<AppWindows>().editors, &key, window_id)
    else {
        return;
    };

    // `onCleanup(() => { clearTimeout(saveTimer); flushProjectConfig() })`
    // (`ED/context.ts:1246-1252`): a `.cap` closed inside the 250ms save
    // debounce still gets its last edit written.
    if let Ok(pending) = handle.update(cx, |view, _window, _cx| view.pending_save()) {
        pending.borrow_mut().flush();
    }
    let instance = handle
        .update(cx, |view, _window, _cx| view.take_instance())
        .ok()
        .flatten();
    if let Some(instance) = instance {
        gpui_tokio::Tokio::spawn(cx, async move { instance.dispose().await }).detach();
    }

    restore_after_editor_close(&key, cx);
}

fn take_editor_window(
    editors: &mut Vec<(PathBuf, WindowHandle<EditorWindow>)>,
    key: &Path,
    window_id: gpui::WindowId,
) -> Option<WindowHandle<EditorWindow>> {
    let index = editors
        .iter()
        .position(|(path, handle)| path == key && handle.window_id() == window_id)?;
    Some(editors.remove(index).1)
}

fn restore_after_editor_close(key: &Path, cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase == Phase::Idle
        && session
            .read(cx)
            .editor_recording_target()
            .is_some_and(|path| editor_key(&path) == key)
    {
        if clean_capture_owned(cx) {
            cancel_clean_capture(cx);
        } else {
            abort_editor_recording_flow(cx);
        }
    }

    let windows = cx.global::<AppWindows>();
    let editors_left = windows.editors.len() + windows.screenshot_editors.len();
    let settings_open = windows.settings.is_some();
    tracing::info!(
        path = %key.display(),
        editors_left,
        settings_open,
        "editor window closed"
    );
    let idle = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
    if reveal_main_after_editor_close(editors_left, settings_open, idle) {
        show_main_window(cx);
    } else {
        // A dock-activating window closed; the policy has to be recomputed
        // even when the main window is not the thing coming back.
        crate::menus::schedule_dock_sync(cx);
    }
}

fn editor_deletion_allowed(
    project_path: &Path,
    handle: WindowHandle<EditorWindow>,
    cx: &App,
) -> Result<(), String> {
    if !crate::library::known_recordings_dirs().iter().any(|root| {
        root.canonicalize()
            .is_ok_and(|root| project_path != root && project_path.starts_with(root))
    }) {
        return Err(
            "This recording is outside the recordings library. Its files were not changed.".into(),
        );
    }
    let windows = cx.global::<AppWindows>();
    if windows.deleting_editors.contains(project_path) {
        return Err("This recording is already being deleted.".into());
    }
    if !windows
        .editors
        .iter()
        .any(|(path, current)| path == project_path && *current == handle)
    {
        return Err(
            "The editor changed while deletion was being confirmed. The recording was not deleted."
                .into(),
        );
    }
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle
        || session.read(cx).editor_recording_target().is_some()
        || clean_capture_owned(cx)
    {
        return Err("Finish or cancel the recording before deleting this project.".into());
    }
    let editor = handle
        .read(cx)
        .map_err(|_| "The editor has already closed. The recording was not deleted.")?;
    if let Some(reason) = editor.deletion_blocked_reason() {
        return Err(reason.into());
    }
    Ok(())
}

pub(crate) fn request_editor_deletion(
    project_path: PathBuf,
    handle: WindowHandle<EditorWindow>,
    cx: &mut App,
) {
    let key = editor_key(&project_path);
    cx.spawn(async move |cx| {
        if let Err(error) = cx.update(|cx| editor_deletion_allowed(&key, handle, cx)) {
            platform::alert_dialog("Recording retained", &error);
            return;
        }
        if !platform::confirm_dialog("Cap", "Are you sure you want to delete this recording?", "Yes", "No", false) {
            return;
        }
        let prepared = cx.update(|cx| {
            editor_deletion_allowed(&key, handle, cx)?;
            let ownership = cap_recording::upload_resume::UploadLock::acquire(&key)
                .map_err(|error| format!("This recording is still in use. Finish or cancel its upload and try again: {error}"))?;
            let windows = cx.global_mut::<AppWindows>();
            windows.deleting_editors.insert(key.clone());
            windows.editors.retain(|(_, current)| *current != handle);
            let result = handle.update(cx, |view, window, cx| {
                let instance = view.prepare_for_deletion(cx)?;
                window.remove_window();
                Ok::<_, String>(instance)
            });
            match result {
                Ok(Ok(instance)) => {
                    restore_after_editor_close(&key, cx);
                    Ok((instance, ownership))
                }
                Ok(Err(error)) => {
                    let windows = cx.global_mut::<AppWindows>();
                    windows.deleting_editors.remove(&key);
                    windows.editors.push((key.clone(), handle));
                    Err(error)
                }
                Err(error) => {
                    cx.global_mut::<AppWindows>().deleting_editors.remove(&key);
                    Err(format!("Could not close the editor: {error}"))
                }
            }
        });
        let (instance, ownership) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                platform::alert_dialog("Recording retained", &error);
                return;
            }
        };
        let deleting = key.clone();
        let task = cx.update(|cx| gpui_tokio::Tokio::spawn(cx, async move {
            delete_after_editor_cleanup(
                async move {
                    if let Some(instance) = instance {
                        for segment in instance.segment_medias.iter() {
                            for audio in [&segment.audio, &segment.system_audio] {
                                if let Err(error) = audio.get().await {
                                    tracing::debug!(%error, "audio reader settled with an error before deletion");
                                }
                            }
                        }
                        instance.dispose().await;
                    }
                    drop(ownership);
                    Ok(())
                },
                crate::upload::queue::delete_recording(deleting),
            ).await
        }));
        let notice = cx.background_executor().timer(std::time::Duration::from_secs(10));
        futures_util::pin_mut!(task, notice);
        let result = match futures_util::future::select(&mut task, &mut notice).await {
            futures_util::future::Either::Left((result, _)) => result,
            futures_util::future::Either::Right(_) => {
                platform::alert_dialog("Deletion is still finishing", "Cap is waiting for recording cleanup to finish before completing this deletion.");
                task.await
            }
        }.unwrap_or_else(|error| Err(format!("Recording deletion failed: {error}")));
        cx.update(|cx| {
            cx.global_mut::<AppWindows>().deleting_editors.remove(&key);
            refresh_library_after_delete(cx);
        });
        if let Err(error) = result {
            tracing::error!(path = %key.display(), %error, "recording deletion failed");
            platform::alert_dialog("Could not delete recording", &error);
        }
    }).detach();
}

async fn delete_after_editor_cleanup(
    cleanup: impl Future<Output = Result<(), String>>,
    delete: impl Future<Output = Result<(), String>>,
) -> Result<(), String> {
    cleanup.await?;
    delete.await
}

/// `addExistingRecordingToEditor` ends with `EditorInstances::remove(window)`
/// and the sidebar reloads the webview (`ClipsSidebar.tsx:513-517`,
/// `import.rs:1892`): the same bundle, re-read from disk. The native
/// spelling: tear this editor window down -- discarding its pending config
/// write, which is older than what the import just wrote -- and open a fresh
/// one on the same path. The registry entry goes first so `open_editor` does
/// not just refocus the dying window, and the main window never flashes in
/// between.
pub fn reload_editor(project_path: &Path, cx: &mut App) {
    let key = editor_key(project_path);
    if cx.global::<AppWindows>().deleting_editors.contains(&key) {
        return;
    }
    let handle = {
        let editors = &mut cx.global_mut::<AppWindows>().editors;
        let index = editors.iter().position(|(path, _)| path == &key);
        index.map(|index| editors.remove(index).1)
    };

    if let Some(handle) = handle {
        if let Ok(pending) = handle.update(cx, |view, _window, _cx| view.pending_save()) {
            pending.borrow_mut().discard();
        }
        let instance = handle
            .update(cx, |view, _window, _cx| view.take_instance())
            .ok()
            .flatten();
        if let Some(instance) = instance {
            gpui_tokio::Tokio::spawn(cx, async move { instance.dispose().await }).detach();
        }
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }

    tracing::info!(path = %key.display(), "reloading editor after import");
    open_editor(key, cx);
}

/// `editor_window_for_path` (`src-tauri/src/windows.rs:3699-3706`): the live
/// editor window for a `.cap` bundle, by the same path identity the registry
/// keys on.
fn editor_window_handle(project_path: &Path, cx: &App) -> Option<WindowHandle<EditorWindow>> {
    let key = editor_key(project_path);
    cx.global::<AppWindows>()
        .editors
        .iter()
        .find(|(path, _)| path == &key)
        .map(|(_, handle)| *handle)
}

/// `hideEditorForPicker` (`ClipsSidebar.tsx:337-341`) --
/// `getCurrentWindow().hide()` on the editor, with the same detached-task rule
/// every other native show/hide in this file follows.
fn hide_editor_window(project_path: &Path, cx: &mut App) {
    let Some(handle) = editor_window_handle(project_path, cx) else {
        return;
    };
    let native = handle
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            platform::hide_native(native);
            tracing::info!("editor window hidden for picker");
        }
        cx.update(crate::menus::schedule_dock_sync);
    })
    .detach();
}

/// The `unminimize()/show()/set_focus()` triple both Tauri finish paths run on
/// the target editor (`src-tauri/src/recording.rs:3231-3237, 3268-3274`) --
/// `makeKeyAndOrderFront:` covers all three here, plus the display-link kick
/// every reshow in this app needs.
fn reveal_editor_window(project_path: &Path, cx: &mut App) {
    let Some(handle) = editor_window_handle(project_path, cx) else {
        return;
    };
    let native = handle
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            platform::show_native(native);
        }
        cx.update(|cx| {
            cx.activate(true);
            handle
                .update(cx, |_, window, cx| {
                    window.activate_window();
                    platform::kick_display_link(window);
                    cx.notify();
                    window.refresh();
                })
                .ok();
            crate::menus::schedule_dock_sync(cx);
        });
    })
    .detach();
}

/// `editor_window.set_content_protected(...)` around a recording
/// (`src-tauri/src/recording.rs:1775-1780`), released with the same
/// end-of-recording timing as [`set_teleprompter_content_protection`] and for
/// the same reason: a permanently excluded window is invisible on
/// capture-based displays.
fn set_editor_content_protection(project_path: &Path, hidden: bool, cx: &mut App) {
    let Some(handle) = editor_window_handle(project_path, cx) else {
        return;
    };
    let native = handle
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten();
    cx.spawn(async move |_| {
        if let Some(native) = &native {
            let sharing = platform::set_window_capture_hidden(native, hidden);
            tracing::info!(hidden, sharing, "editor content protection");
        }
    })
    .detach();
}

/// A recording that carried an editor target came to rest --
/// `apply_post_studio_editor_behaviour`'s editor arm plus the cancelled/failed
/// fallback (`src-tauri/src/recording.rs:3225-3287`), fused because the gpui
/// session observer is the one place both outcomes land.
///
/// * Clean studio stop (`recording` is `Some`): reveal the target editor and
///   hand it the finished bundle -- the native spelling of the
///   `EditorRecordingAdded` event whose editor-side listener runs
///   `addExistingRecordingToEditor` + `deleteRecordingDirectory` + reload
///   (`Editor.tsx:312-335`).
/// * Cancelled, deleted or failed (`None`): just reveal the editor, exactly
///   what the stop-cleanup fallback does.
/// * Editor window already closed: the Tauri event fires into a torn-down
///   webview and the capture stays in the library as its own project; same
///   here, except the main window is reshown (rescanning Recents on the way,
///   so the orphaned capture is visible) rather than left suppressed -- over
///   there the window merely stays minimized, here it was hidden outright and
///   leaving it hidden would leave the app with no window at all.
fn editor_recording_finished(editor_path: PathBuf, recording: Option<PathBuf>, cx: &mut App) {
    cx.global_mut::<AppWindows>().editor_hidden_for_picker = None;
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _, cx| {
        view.cancel_deep_link_start();
        view.clear_target(cx);
        cx.notify();
    })
    .ok();
    set_editor_content_protection(&editor_path, false, cx);

    let Some(handle) = editor_window_handle(&editor_path, cx) else {
        tracing::warn!(
            editor = %editor_path.display(),
            recording = ?recording.as_ref().map(|path| path.display().to_string()),
            "editor recording finished but its editor window is gone; \
             the capture stays in the library"
        );
        show_main_window(cx);
        return;
    };

    reveal_editor_window(&editor_path, cx);

    if let Some(recording_dir) = recording {
        handle
            .update(cx, |view, window, cx| {
                view.append_recorded_clip(recording_dir, window, cx)
            })
            .ok();
    }
}

/// An editor-flow start that never reached the session (the pre-flight bails
/// in `start_recording_with_target`): put everything back the way a cancelled
/// picker would -- target cleared, editor revealed. Without this the editor
/// would stay hidden forever, since no phase transition is coming.
pub fn abort_editor_recording_flow(cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle || session.read(cx).editor_recording_target().is_none()
    {
        return;
    }
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _, _| view.cancel_deep_link_start())
        .ok();
    let Some(editor_path) = session.update(cx, |session, cx| {
        let target = session.take_editor_recording_target();
        cx.notify();
        target
    }) else {
        return;
    };
    close_target_overlays(cx);
    cx.global_mut::<AppWindows>().editor_hidden_for_picker = None;
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _, cx| {
        view.cancel_deep_link_start();
        view.clear_target(cx);
        cx.notify();
    })
    .ok();
    hide_main_window(cx);
    tracing::info!(path = %editor_path.display(), "editor recording flow aborted before start");
    if let Some(handle) = editor_window_handle(&editor_path, cx) {
        hide_main_and_park_camera_preview(cx);
        handle
            .update(cx, |view, _, cx| view.editor_picker_dismissed(cx))
            .ok();
        reveal_editor_window(&editor_path, cx);
    } else {
        show_main_window(cx);
    }
}

/// The tray's Record Display / Record Window / Record Area.
///
/// `crate::open_target_picker(&app, RecordingTargetMode::*)` over there, which
/// sets the target mode on the main window and opens the overlays; here the
/// main window owns that state, so it is the same `arm_overlay` the tiles call.
pub fn arm_target_mode(kind: crate::main_window::TargetType, cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _window, cx| view.arm_overlay(kind, cx))
        .ok();
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
    #[cfg(target_os = "linux")]
    if clean_capture_active(cx) {
        return None;
    }
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
            let (number, native) = handle
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
                    (
                        platform::window_number(window),
                        platform::native_window(window),
                    )
                })
                .ok()?;
            remove_popup_window_chrome(native, cx);
            let number = number?;
            number.to_string().parse().ok()
        }
        Err(error) => {
            tracing::error!("recording controls window failed to open: {error:#}");
            None
        }
    }
}

/// Hide the pickers before a screenshot grab, the way `take_screenshot` hides
/// TargetSelectOverlay / CaptureArea / ModeSelect (`recording.rs:2876-2895`):
/// an overlay still on screen would be in the shot. Returns whether anything
/// was up -- the caller's cue to wait the same 150ms the Tauri command waits.
pub fn prepare_for_screenshot_capture(cx: &mut App) -> bool {
    if cx.global::<AppWindows>().overlays.is_empty() {
        return false;
    }
    // The screenshot branch of `onRecordingStart` nulls the saved camera bounds
    // just like the recording branch does, so a parked bubble stays parked.
    release_camera_park(cx);
    close_target_overlays(cx);
    true
}

/// A screenshot finished (`Some` PNG path) or failed (`None`): refresh every
/// surface that lists screenshots -- the `NewScreenshotAdded` listeners in
/// the Tauri app -- and open the screenshot editor on the new bundle, the
/// `automationShouldOpenScreenshotEditor` default. A failure reveals the main
/// window if the picker had hidden it, since nothing else will.
pub fn screenshot_finished(captured: Option<PathBuf>, cx: &mut App) {
    let Some(png) = captured else {
        let hidden = std::mem::take(&mut cx.global_mut::<AppWindows>().main_hidden_for_picker);
        if hidden && RecordingSession::global(cx).read(cx).phase == Phase::Idle {
            show_main_window(cx);
        }
        return;
    };

    crate::tray::refresh_previous(cx);
    if let Some(settings) = cx.global::<AppWindows>().settings {
        settings
            .update(cx, |view, window, cx| view.refresh_screenshots(window, cx))
            .ok();
    }
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, window, cx| view.refresh_recents(window, cx))
        .ok();

    // The editor owns the foreground now, the way a stopped studio recording
    // hands off to the video editor; `screenshot_editor_closed` brings the
    // main window back.
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    open_screenshot_editor(png, cx);
}

/// Open (or focus) the screenshot editor for a bundle -- the
/// `ShowCapWindow::ScreenshotEditor` arm: 1240x800, min 800x600, centered,
/// reused per path. Accepts the PNG or the `.cap` directory.
///
/// Must be reached through `cx.defer` from anything inside an entity update:
/// opening a window paints it synchronously and would double-lease the caller.
pub fn open_screenshot_editor(path: PathBuf, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if defer_window_until_capture_safe(cx) {
        return;
    }
    let Some(bundle) = screenshot_editor::resolve_bundle(&path) else {
        tracing::error!(path = %path.display(), "not a screenshot bundle; not opening the editor");
        return;
    };
    let key = editor_key(&bundle);

    if let Some(handle) = cx
        .global::<AppWindows>()
        .screenshot_editors
        .iter()
        .find(|(existing, _)| existing == &key)
        .map(|(_, handle)| *handle)
    {
        tracing::info!(
            path = %key.display(),
            "screenshot editor already open for this bundle; focusing it"
        );
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(screenshot_editor::SCREENSHOT_EDITOR_WIDTH),
            px(screenshot_editor::SCREENSHOT_EDITOR_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Screenshot Editor".into()),
                appears_transparent: true,
                traffic_light_position: None,
            }),
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(screenshot_editor::SCREENSHOT_EDITOR_MIN_WIDTH),
                px(screenshot_editor::SCREENSHOT_EDITOR_MIN_HEIGHT),
            )),
            ..Default::default()
        },
        {
            let key = key.clone();
            move |window, cx| cx.new(|cx| ScreenshotEditorWindow::new(key, window, cx))
        },
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("screenshot editor window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>()
        .screenshot_editors
        .push((key.clone(), handle));
    handle
        .update(cx, |_, window, _| {
            platform::kick_display_link(window);
            tracing::info!(
                number = platform::window_number(window),
                path = %key.display(),
                "screenshot editor window opened"
            );
        })
        .ok();

    hide_main_window(cx);
    screenshot_editor::load_screenshot_project(key, handle, cx);
}

/// The screenshot editor's Delete finished: drop the window (its pending
/// write is for a bundle that no longer exists), refresh every surface that
/// lists screenshots, and run the ordinary closed bookkeeping.
pub fn close_screenshot_editor_after_delete(bundle: &Path, cx: &mut App) {
    let key = editor_key(bundle);
    let handle = cx
        .global::<AppWindows>()
        .screenshot_editors
        .iter()
        .find(|(path, _)| path == &key)
        .map(|(_, handle)| *handle);
    if let Some(handle) = handle {
        if let Ok(pending) = handle.update(cx, |view, _window, _cx| view.pending_save()) {
            pending.borrow_mut().discard();
        }
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    screenshot_editor_closed(&key, cx);
    refresh_screenshot_surfaces(cx);
}

/// Every surface that lists screenshots: the tray's Previous, the settings
/// Screenshots page, and the main window's Recents.
pub fn refresh_screenshot_surfaces(cx: &mut App) {
    crate::tray::refresh_previous(cx);
    if let Some(settings) = cx.global::<AppWindows>().settings {
        settings
            .update(cx, |view, window, cx| view.refresh_screenshots(window, cx))
            .ok();
    }
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, window, cx| view.refresh_recents(window, cx))
        .ok();
}

/// A screenshot editor window is going away: flush its pending config write
/// and bring the main window back once the last editor of either kind closes
/// -- the same `Destroyed` arm `editor_closed` mirrors.
pub fn screenshot_editor_closed(bundle: &Path, cx: &mut App) {
    let key = editor_key(bundle);
    let handle = {
        let editors = &mut cx.global_mut::<AppWindows>().screenshot_editors;
        let index = editors.iter().position(|(path, _)| path == &key);
        index.map(|index| editors.remove(index).1)
    };

    if let Some(handle) = handle
        && let Ok(pending) = handle.update(cx, |view, _window, _cx| view.pending_save())
    {
        pending.borrow_mut().flush();
    }

    let windows = cx.global::<AppWindows>();
    let editors_left = windows.editors.len() + windows.screenshot_editors.len();
    let settings_open = windows.settings.is_some();
    tracing::info!(
        path = %key.display(),
        editors_left,
        settings_open,
        "screenshot editor window closed"
    );
    let idle = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
    if reveal_main_after_editor_close(editors_left, settings_open, idle) {
        show_main_window(cx);
    } else {
        crate::menus::schedule_dock_sync(cx);
    }
}

pub fn refresh_library_after_delete(cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    let settings = cx.global::<AppWindows>().settings;
    main.update(cx, |view, window, cx| view.refresh_recents(window, cx))
        .ok();
    if let Some(settings) = settings {
        settings
            .update(cx, |view, window, cx| view.refresh_recordings(window, cx))
            .ok();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{DEFAULT_EXCLUDED_WINDOW_TITLES, WindowExclusion, default_excluded_windows};

    fn area_target(display: &str, x: f64, y: f64, width: f64, height: f64) -> ScreenCaptureTarget {
        ScreenCaptureTarget::Area {
            screen: display.parse().unwrap(),
            bounds: scap_targets::bounds::LogicalBounds::new(
                scap_targets::bounds::LogicalPosition::new(x, y),
                scap_targets::bounds::LogicalSize::new(width, height),
            ),
        }
    }

    #[test]
    fn recording_outline_rejects_a_crop_changed_during_start_preflight() {
        let admitted = area_target("1", -120., 80., 640., 480.);
        let same = area_target("1", -120., 80., 640., 480.);
        assert!(area_overlay_matches(&admitted, &same, true));
        for changed in [
            area_target("1", -119., 80., 640., 480.),
            area_target("1", -120., 81., 640., 480.),
            area_target("1", -120., 80., 641., 480.),
            area_target("1", -120., 80., 640., 481.),
            area_target("2", -120., 80., 640., 480.),
        ] {
            assert!(!area_overlay_matches(&admitted, &changed, true));
        }
    }

    #[test]
    fn recording_outline_requires_an_area_and_confirmed_capture_exclusion() {
        let area = area_target("1", 0., 0., 640., 480.);
        assert!(!area_overlay_matches(&area, &area, false));
        for other in [
            ScreenCaptureTarget::Display {
                id: "1".parse().unwrap(),
            },
            ScreenCaptureTarget::Window {
                id: "1".parse().unwrap(),
            },
            ScreenCaptureTarget::CameraOnly,
        ] {
            assert!(!area_overlay_matches(&area, &other, true));
            assert!(!area_overlay_matches(&other, &area, true));
        }
    }

    #[test]
    fn dock_reopen_uses_registered_windows_and_falls_back_after_delete() {
        let editor = WindowHandle::<EditorWindow>::new(1_u64.into());
        let screenshot = WindowHandle::<ScreenshotEditorWindow>::new(2_u64.into());
        let settings = WindowHandle::<SettingsWindow>::new(3_u64.into());
        let candidates = [editor.into(), screenshot.into(), settings.into()];
        let mut live = HashSet::from([editor.window_id(), settings.window_id()]);
        assert_eq!(
            first_registered_reopen_target(candidates, &live),
            Some(editor.into())
        );
        live.remove(&editor.window_id());
        assert_eq!(
            first_registered_reopen_target(candidates, &live),
            Some(settings.into())
        );
        live.clear();
        assert_eq!(first_registered_reopen_target(candidates, &live), None);
    }

    #[test]
    fn old_editor_close_preserves_a_reopened_window_for_the_same_project() {
        let path = PathBuf::from("recording.cap");
        let old = WindowHandle::<EditorWindow>::new(1_u64.into());
        let current = WindowHandle::<EditorWindow>::new(2_u64.into());
        let other = WindowHandle::<EditorWindow>::new(3_u64.into());
        let mut editors = vec![(path.clone(), current), (PathBuf::from("other.cap"), other)];
        assert_eq!(
            take_editor_window(&mut editors, &path, old.window_id()),
            None
        );
        assert_eq!(editors.len(), 2);
        assert_eq!(
            take_editor_window(&mut editors, &path, current.window_id()),
            Some(current)
        );
        assert_eq!(editors, vec![(PathBuf::from("other.cap"), other)]);
    }

    struct DeleteFixture(PathBuf);

    impl DeleteFixture {
        fn new() -> Self {
            let directory = std::env::temp_dir()
                .join(format!("cap-editor-delete-{}", crate::store::new_uuid_v4()));
            std::fs::create_dir(&directory).unwrap();
            std::fs::write(directory.join("source.mp4"), b"retained recording bytes").unwrap();
            Self(directory)
        }
    }

    impl Drop for DeleteFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn recording_files_are_not_deleted_before_editor_cleanup_finishes() {
        let fixture = DeleteFixture::new();
        let source = fixture.0.join("source.mp4");
        let (complete, completed) = tokio::sync::oneshot::channel();
        let deletion = delete_after_editor_cleanup(
            async { completed.await.map_err(|error| error.to_string()) },
            async { std::fs::remove_file(&source).map_err(|error| error.to_string()) },
        );
        tokio::pin!(deletion);
        tokio::select! {
            biased;
            _ = &mut deletion => panic!("deletion ran before cleanup completed"),
            _ = tokio::task::yield_now() => {}
        }
        assert_eq!(std::fs::read(&source).unwrap(), b"retained recording bytes");
        complete.send(()).unwrap();
        deletion.await.unwrap();
        assert!(!source.exists());
    }

    #[tokio::test]
    async fn failed_editor_cleanup_leaves_original_recording_bytes_untouched() {
        let fixture = DeleteFixture::new();
        let source = fixture.0.join("source.mp4");
        let result = delete_after_editor_cleanup(async { Err("cleanup failed".into()) }, async {
            std::fs::remove_file(&source).map_err(|error| error.to_string())
        })
        .await;
        assert_eq!(result, Err("cleanup failed".into()));
        assert_eq!(std::fs::read(source).unwrap(), b"retained recording bytes");
    }

    #[cfg(target_os = "linux")]
    fn pending_clean_capture(mode: RecordingMode, wayland: bool) -> CleanCaptureUi {
        CleanCaptureUi {
            generation: 7,
            config: Some(StartConfig {
                mode,
                target: ScreenCaptureTarget::Display {
                    id: "1".parse().unwrap(),
                },
                microphone: None,
                camera: None,
                device_settings: crate::store::RecordingDeviceSettings::default(),
                input_readiness: crate::feeds::InputReadiness::default(),
                system_audio: false,
                excluded_windows: Vec::new(),
                camera_feed: None,
                mic_feed: None,
                linux_instant_camera: None,
            }),
            gate: CleanCaptureGate::default(),
            camera: None,
            camera_was_visible: false,
            main_was_visible: true,
            requested_inputs: CleanCaptureInputs {
                camera: None,
                microphone: None,
            },
            preview_was_rendering: Some(true),
            wayland,
            retained_windows: Vec::new(),
            restoring: false,
            restoration_error: None,
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_delayed_start_consumes_only_the_started_generation() {
        use global_hotkey::HotKeyState::{Pressed, Released};
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            for wayland in [false, true] {
                let mut lease = pending_clean_capture(mode, wayland);
                let generation = lease.generation;
                assert!(lease.take_start_config(generation).is_none());
                assert_eq!(lease.gate.shortcut(Pressed), None);
                assert!(lease.take_start_config(generation).is_none());
                assert_eq!(
                    lease.gate.shortcut(Released),
                    Some(CleanCaptureAction::Start)
                );
                assert!(lease.take_start_config(generation + 1).is_none());
                assert!(lease.config.is_some());
                assert!(lease.take_start_config(generation).is_some());
                assert!(lease.take_start_config(generation).is_none());
                assert_eq!(lease.gate.shortcut(Pressed), None);
                assert_eq!(
                    lease.gate.shortcut(Released),
                    Some(CleanCaptureAction::Stop)
                );
                assert!(lease.gate.started);
                if wayland {
                    assert!(lease.begin_restore());
                    assert!(lease.config.is_none());
                    assert!(lease.gate.started);
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_stop_cancels_delayed_start_before_restore_finishes() {
        use global_hotkey::HotKeyState::{Pressed, Released};
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            let mut lease = pending_clean_capture(mode, true);
            let generation = lease.generation;
            assert_eq!(lease.gate.shortcut(Pressed), None);
            assert_eq!(
                lease.gate.shortcut(Released),
                Some(CleanCaptureAction::Start)
            );
            assert_eq!(lease.gate.shortcut(Pressed), None);
            assert_eq!(
                lease.gate.shortcut(Released),
                Some(CleanCaptureAction::Stop)
            );
            assert!(lease.begin_restore());
            assert!(lease.config.is_none());
            assert!(lease.restoring);
            assert!(lease.gate.started);
            assert!(lease.take_start_config(generation).is_none());
            assert!(!lease.begin_restore());
            assert!(lease.take_start_config(generation).is_none());
            lease.restoration_error = Some("Stop cleanup is unconfirmed".into());
            assert!(lease.take_start_config(generation).is_none());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_delayed_start_rejects_restoring_and_failed_leases() {
        for (restoring, restoration_error) in [
            (true, None),
            (false, Some("Window restoration failed")),
            (true, Some("Stop cleanup failed")),
        ] {
            let mut lease = pending_clean_capture(RecordingMode::Studio, true);
            lease.gate.started = true;
            lease.restoring = restoring;
            lease.restoration_error = restoration_error.map(str::to_string);
            assert!(lease.take_start_config(lease.generation).is_none());
            assert!(lease.config.is_some());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_restoration_invalidates_preflight_config() {
        for started in [false, true] {
            let mut lease = pending_clean_capture(RecordingMode::Studio, true);
            lease.gate.started = started;
            assert!(lease.begin_restore());
            assert!(lease.config.is_none());
            assert_eq!(lease.gate.started, started);
            assert!(lease.take_start_config(lease.generation).is_none());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_restore_retry_requires_safe_idle_wayland_failure() {
        for phase in [
            Phase::Idle,
            Phase::Starting,
            Phase::Recording { paused: false },
            Phase::Recording { paused: true },
            Phase::Stopping,
        ] {
            for cleanup_safe in [false, true] {
                for (wayland, failed) in
                    [(false, false), (false, true), (true, false), (true, true)]
                {
                    let mut lease = pending_clean_capture(RecordingMode::Studio, wayland);
                    lease.gate.started = true;
                    lease.restoring = true;
                    lease.restoration_error = failed.then(|| "Window restoration failed".into());
                    let permitted = phase == Phase::Idle && cleanup_safe && wayland && failed;
                    assert_eq!(lease.prepare_restore_retry(phase, cleanup_safe), permitted);
                    if permitted {
                        assert!(lease.config.is_none());
                        assert!(lease.restoration_error.is_none());
                        assert!(!lease.restoring);
                        assert!(lease.take_start_config(7).is_none());
                        assert!(lease.begin_restore());
                    } else {
                        assert!(lease.config.is_some());
                        assert_eq!(lease.restoration_error.is_some(), failed);
                        assert!(lease.restoring);
                    }
                    assert_eq!(lease.generation, 7);
                    assert!(lease.gate.started);
                    assert!(lease.take_start_config(7).is_none());
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_restore_retry_allows_one_attempt_per_failure() {
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            for started in [false, true] {
                let mut lease = pending_clean_capture(mode, true);
                lease.gate.started = started;
                assert!(lease.begin_restore());
                for error in ["Window restoration failed", "Stop cleanup failed"] {
                    lease.restoration_error = Some(error.into());
                    assert!(!lease.begin_restore());
                    assert!(lease.prepare_restore_retry(Phase::Idle, true));
                    assert!(lease.begin_restore());
                    assert!(!lease.prepare_restore_retry(Phase::Idle, true));
                    assert!(!lease.begin_restore());
                    assert!(lease.config.is_none());
                    assert!(lease.restoration_error.is_none());
                    assert!(lease.restoring);
                    assert_eq!(lease.generation, 7);
                    assert_eq!(lease.gate.started, started);
                    assert_eq!(lease.preview_was_rendering, Some(true));
                    assert!(lease.main_was_visible);
                    assert!(lease.take_start_config(7).is_none());
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_reopen_waits_for_owned_wayland_restoration() {
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            for started in [false, true] {
                let mut lease = pending_clean_capture(mode, true);
                lease.gate.started = started;
                assert!(lease.begin_restore());
                for _ in 0..2 {
                    assert_eq!(
                        clean_capture_reopen_action(Some(&mut lease), Phase::Idle, true),
                        CleanCaptureReopenAction::WaitForRestore
                    );
                    assert!(lease.restoring);
                    assert!(lease.restoration_error.is_none());
                    assert!(lease.config.is_none());
                    assert_eq!(lease.gate.started, started);
                    assert_eq!(lease.generation, 7);
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_reopen_retries_failure_then_waits_until_cleanup() {
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            for started in [false, true] {
                let mut lease = pending_clean_capture(mode, true);
                lease.gate.started = started;
                assert!(lease.begin_restore());
                for error in ["Window restoration failed", "Stop cleanup failed"] {
                    lease.restoration_error = Some(error.into());
                    assert_eq!(
                        clean_capture_reopen_action(Some(&mut lease), Phase::Idle, true),
                        CleanCaptureReopenAction::RetryRestore
                    );
                    assert!(lease.take_start_config(7).is_none());
                    assert!(lease.begin_restore());
                    assert_eq!(
                        clean_capture_reopen_action(Some(&mut lease), Phase::Idle, true),
                        CleanCaptureReopenAction::WaitForRestore
                    );
                    assert!(lease.restoring);
                    assert!(lease.restoration_error.is_none());
                    assert_eq!(lease.gate.started, started);
                    assert_eq!(lease.generation, 7);
                }
                assert_eq!(
                    clean_capture_reopen_action(None, Phase::Idle, true),
                    CleanCaptureReopenAction::Continue
                );
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_reopen_preserves_other_paths_and_rejects_unsafe_retry() {
        use CleanCaptureReopenAction::{Continue, WaitForRestore};
        for (phase, cleanup_safe, wayland, restoring, failed, expected) in [
            (Phase::Idle, true, false, false, false, Continue),
            (Phase::Idle, true, false, true, true, Continue),
            (Phase::Idle, true, true, false, false, Continue),
            (Phase::Idle, false, true, true, true, WaitForRestore),
            (Phase::Starting, true, true, true, true, WaitForRestore),
            (
                Phase::Recording { paused: false },
                true,
                true,
                true,
                true,
                WaitForRestore,
            ),
            (
                Phase::Recording { paused: true },
                true,
                true,
                true,
                true,
                WaitForRestore,
            ),
            (Phase::Stopping, true, true, true, true, WaitForRestore),
        ] {
            let mut lease = pending_clean_capture(RecordingMode::Studio, wayland);
            lease.restoring = restoring;
            lease.restoration_error = failed.then(|| "Window restoration failed".into());
            assert_eq!(
                clean_capture_reopen_action(Some(&mut lease), phase, cleanup_safe),
                expected
            );
            assert!(lease.config.is_some());
            assert_eq!(lease.restoring, restoring);
            assert_eq!(lease.restoration_error.is_some(), failed);
            assert_eq!(lease.generation, 7);
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn restoration_waits_for_the_last_owned_window() {
        let (send, receive) = flume::bounded::<anyhow::Result<(u64, bool)>>(1);
        let receipt = async move { receive.recv_async().await };
        let mut restored = Box::pin(acknowledge_restored_windows(
            vec![(true, receipt)],
            Vec::new(),
        ));
        assert!(futures_util::poll!(&mut restored).is_pending());
        send.send(Ok((1, true))).unwrap();
        restored.await.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn restoration_keeps_errors_and_checks_every_window() {
        let receipts = vec![
            (true, std::future::ready(Ok::<_, String>(Ok((1, false))))),
            (
                true,
                std::future::ready(Err::<anyhow::Result<(u64, bool)>, _>(
                    "window closed".to_string(),
                )),
            ),
        ];
        let error = acknowledge_restored_windows(receipts, vec!["missing window".into()])
            .await
            .unwrap_err();
        assert!(error.contains("wrong visibility"));
        assert!(error.contains("window closed"));
        assert!(error.contains("missing window"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_requires_delivered_press_and_release() {
        use global_hotkey::HotKeyState::{Pressed, Released};
        let mut gate = CleanCaptureGate::default();
        assert_eq!(gate.shortcut(Released), None);
        assert_eq!(gate.shortcut(Pressed), None);
        assert!(!gate.started);
        assert_eq!(gate.shortcut(Pressed), None);
        assert_eq!(gate.shortcut(Released), Some(CleanCaptureAction::Start));
        assert!(gate.started);
        assert_eq!(gate.shortcut(Released), None);
        assert_eq!(gate.shortcut(Pressed), None);
        assert_eq!(gate.shortcut(Released), Some(CleanCaptureAction::Stop));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_restart_keeps_stop_and_new_lease_requires_proof() {
        use global_hotkey::HotKeyState::{Pressed, Released};
        let mut gate = CleanCaptureGate {
            pressed: false,
            started: true,
        };
        assert_eq!(gate.shortcut(Pressed), None);
        assert_eq!(gate.shortcut(Released), Some(CleanCaptureAction::Stop));
        let mut new_gate = CleanCaptureGate::default();
        assert_eq!(new_gate.shortcut(Released), None);
        assert!(!new_gate.started);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn monitor_capture_uses_acknowledged_visibility_on_x11_and_wayland() {
        let display = ScreenCaptureTarget::Display {
            id: "1".parse().unwrap(),
        };
        let area = ScreenCaptureTarget::Area {
            screen: "1".parse().unwrap(),
            bounds: scap_targets::bounds::LogicalBounds::new(
                scap_targets::bounds::LogicalPosition::new(0.0, 0.0),
                scap_targets::bounds::LogicalSize::new(100.0, 100.0),
            ),
        };
        let window = ScreenCaptureTarget::Window {
            id: "1".parse().unwrap(),
        };
        for mode in [RecordingMode::Studio, RecordingMode::Instant] {
            for camera_requested in [false, true] {
                for target in [&display, &area] {
                    assert!(clean_capture_supported(
                        mode,
                        target,
                        camera_requested,
                        true
                    ));
                    assert!(clean_capture_supported(
                        mode,
                        target,
                        camera_requested,
                        false
                    ));
                }
            }
        }
        for target in [&window, &ScreenCaptureTarget::CameraOnly] {
            assert!(!clean_capture_supported(
                RecordingMode::Studio,
                target,
                true,
                true
            ));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn clean_capture_covers_screen_overlays_but_not_camera_only() {
        let display = ScreenCaptureTarget::Display {
            id: "1".parse().unwrap(),
        };
        assert!(clean_capture_supported(
            RecordingMode::Studio,
            &display,
            false,
            false
        ));
        assert!(clean_capture_supported(
            RecordingMode::Studio,
            &display,
            false,
            true
        ));
        assert!(clean_capture_supported(
            RecordingMode::Instant,
            &display,
            false,
            false
        ));
        assert!(!clean_capture_supported(
            RecordingMode::Studio,
            &ScreenCaptureTarget::CameraOnly,
            true,
            false
        ));
        assert!(!clean_capture_supported(
            RecordingMode::Studio,
            &ScreenCaptureTarget::Window {
                id: "1".parse().unwrap()
            },
            true,
            false
        ));
        let window = ScreenCaptureTarget::Window {
            id: "1".parse().unwrap(),
        };
        assert!(clean_capture_supported(
            RecordingMode::Instant,
            &window,
            true,
            false
        ));
        assert!(!clean_capture_supported(
            RecordingMode::Instant,
            &window,
            false,
            false
        ));
        assert!(!clean_capture_supported(
            RecordingMode::Instant,
            &window,
            true,
            true
        ));
        assert!(!clean_capture_supported(
            RecordingMode::Instant,
            &ScreenCaptureTarget::CameraOnly,
            true,
            false
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn instant_camera_maps_physical_origins_without_monitor_scale_guessing() {
        use camera_window::{LinuxCameraPhysicalRect, LinuxCameraRecordingSnapshot};
        let capture = LinuxCameraPhysicalRect {
            x: -1920,
            y: -1200,
            width: 1920,
            height: 1080,
        };
        let snapshot = LinuxCameraRecordingSnapshot {
            content_rect: LinuxCameraPhysicalRect {
                x: -1860,
                y: -1100,
                width: 230,
                height: 230,
            },
            state: crate::store::CameraWindowState::default(),
            corner_radius_pixels: 115.0,
        };
        let presentation = linux_camera_presentation(snapshot, capture).unwrap();
        assert_eq!(presentation.rect.x, 60);
        assert_eq!(presentation.rect.y, 100);
        assert_eq!(presentation.rect.width, 230);
        assert_eq!(presentation.rect.height, 230);
        assert_eq!(
            presentation.shape,
            cap_recording::instant_recording::LinuxCameraShape::Round
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn instant_camera_keeps_live_full_shape_mirror_and_effect_request() {
        use crate::store::{BlurMode, CameraShape, CameraWindowState};
        use camera_window::{LinuxCameraPhysicalRect, LinuxCameraRecordingSnapshot};
        use cap_recording::instant_recording::{LinuxCameraEffect, LinuxCameraShape};
        let capture = LinuxCameraPhysicalRect {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        };
        let snapshot = LinuxCameraRecordingSnapshot {
            content_rect: LinuxCameraPhysicalRect {
                x: 160,
                y: 80,
                width: 600,
                height: 300,
            },
            state: CameraWindowState {
                shape: CameraShape::Full,
                mirrored: true,
                background_blur: BlurMode::Heavy,
                ..CameraWindowState::default()
            },
            corner_radius_pixels: 36.0,
        };
        let presentation = linux_camera_presentation(snapshot, capture).unwrap();
        assert!(presentation.mirrored);
        assert_eq!(presentation.effect, LinuxCameraEffect::BackgroundBlur);
        assert_eq!(presentation.rect.width, 600);
        assert_eq!(presentation.rect.height, 300);
        assert_eq!(
            presentation.shape,
            LinuxCameraShape::RoundedRectangle { radius_pixels: 36 }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn instant_camera_does_not_crop_or_omit_an_outside_preview() {
        use camera_window::{LinuxCameraPhysicalRect, LinuxCameraRecordingSnapshot};
        let capture = LinuxCameraPhysicalRect {
            x: 100,
            y: 100,
            width: 1000,
            height: 600,
        };
        for (x, y) in [(99, 100), (100, 99), (871, 100), (100, 471)] {
            let snapshot = LinuxCameraRecordingSnapshot {
                content_rect: LinuxCameraPhysicalRect {
                    x,
                    y,
                    width: 230,
                    height: 230,
                },
                state: crate::store::CameraWindowState::default(),
                corner_radius_pixels: 115.0,
            };
            let error = linux_camera_presentation(snapshot, capture).unwrap_err();
            assert!(error.to_string().contains("Move the whole camera preview"));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn instant_camera_preserves_one_pixel_rounding_without_square_crop() {
        use camera_window::{LinuxCameraPhysicalRect, LinuxCameraRecordingSnapshot};
        let capture = LinuxCameraPhysicalRect {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        };
        let mut snapshot = LinuxCameraRecordingSnapshot {
            content_rect: LinuxCameraPhysicalRect {
                x: 200,
                y: 100,
                width: 307,
                height: 306,
            },
            state: crate::store::CameraWindowState::default(),
            corner_radius_pixels: 153.3333,
        };
        let presentation = linux_camera_presentation(snapshot, capture).unwrap();
        assert_eq!(presentation.rect.width, 307);
        assert_eq!(presentation.rect.height, 306);
        assert_eq!(
            presentation.shape,
            cap_recording::instant_recording::LinuxCameraShape::RoundedRectangle {
                radius_pixels: 153
            }
        );
        snapshot.content_rect.width = 308;
        assert!(linux_camera_presentation(snapshot, capture).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn instant_camera_reference_keeps_odd_window_dimensions_and_rejects_invalid_bounds() {
        let bounds = linux_window_capture_bounds(-40.0, 31.0, 1281.0, 721.0).unwrap();
        assert_eq!((bounds.x, bounds.y), (-40, 31));
        assert_eq!((bounds.width, bounds.height), (1281, 721));
        for value in [
            f64::NAN,
            f64::INFINITY,
            0.0,
            1.0,
            400.5,
            f64::from(u32::MAX),
        ] {
            assert!(linux_window_capture_bounds(0.0, 0.0, value, 720.0).is_err());
        }
        assert!(linux_window_capture_bounds(-0.5, 0.0, 1280.0, 720.0).is_err());
        assert!(linux_window_capture_bounds(0.0, f64::INFINITY, 1280.0, 720.0).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn instant_camera_area_reference_uses_shared_capture_edge_rounding() {
        let capture = cap_recording::sources::screen_capture::x11_capture_rect(
            -1920.0,
            0.0,
            1920.0,
            1080.0,
            Some((10.25, 20.5, 800.25, 600.25)),
        )
        .unwrap();
        assert_eq!(capture, (-1910, 20, 800, 600));
    }

    /// `restore_main_windows_if_no_editors` (`lib.rs:6242-6262`): the main
    /// window comes back only when the closing editor was the last one of
    /// either kind *and* no Settings window exists. Settings -> Recordings ->
    /// open studio editor -> close must land back on Settings, not main.
    #[test]
    fn main_window_never_returns_over_an_open_settings_window() {
        // The reported flow: last editor closes while Settings is open.
        assert!(!reveal_main_after_editor_close(0, true, true));
        // No Settings: the last editor closing reveals main.
        assert!(reveal_main_after_editor_close(0, false, true));
        // Other editors still open keep main hidden either way.
        assert!(!reveal_main_after_editor_close(1, false, true));
        assert!(!reveal_main_after_editor_close(1, true, true));
        // Mid-recording the session observer owns the reveal, not this path.
        assert!(!reveal_main_after_editor_close(0, false, false));
    }

    #[test]
    fn active_or_pending_recordings_never_park_the_camera_preview() {
        assert!(camera_preview_can_be_parked(Phase::Idle));
        assert!(!camera_preview_can_be_parked(Phase::Starting));
        assert!(!camera_preview_can_be_parked(Phase::Recording {
            paused: false,
        }));
        assert!(!camera_preview_can_be_parked(Phase::Recording {
            paused: true,
        }));
        assert!(!camera_preview_can_be_parked(Phase::Stopping));
    }

    #[test]
    fn pinned_window_never_falls_back_to_another_target() {
        let selected = "41".parse::<scap_targets::WindowId>().unwrap();
        let other = "42".parse::<scap_targets::WindowId>().unwrap();

        assert!(pinned_window_resolution_matches(None, None));
        assert!(pinned_window_resolution_matches(None, Some(&other)));
        assert!(pinned_window_resolution_matches(
            Some(&selected),
            Some(&selected)
        ));
        assert!(!pinned_window_resolution_matches(Some(&selected), None));
        assert!(!pinned_window_resolution_matches(
            Some(&selected),
            Some(&other)
        ));
    }

    fn title_rule(title: &str) -> WindowExclusion {
        WindowExclusion {
            window_title: Some(title.to_string()),
            ..Default::default()
        }
    }

    /// The canonical titles are `CapWindowId::title()`
    /// (`src-tauri/src/windows.rs:1030-1046`), verbatim. Getting one wrong is
    /// silent: the rule simply never matches and the window lands in the
    /// recording.
    ///
    /// The table's *coverage* of every `AppWindows` handle is enforced by the
    /// compiler instead -- [`own_windows`] destructures the struct, so a new
    /// window field does not compile until it is walked or explicitly skipped.
    #[test]
    fn own_window_titles_match_cap_window_id() {
        let expected = [
            (OwnWindow::Main, "Cap"),
            (OwnWindow::Settings, "Cap Settings"),
            (OwnWindow::Controls, "Cap Recording Controls"),
            (OwnWindow::Camera, "Cap Camera"),
            (OwnWindow::ModeSelect, "Cap Mode Selection"),
            (OwnWindow::Teleprompter, "Cap Teleprompter"),
            (OwnWindow::TargetSelect, "Cap Target Select"),
            (OwnWindow::Editor, "Cap Editor"),
            (OwnWindow::ScreenshotEditor, "Cap Screenshot Editor"),
            (OwnWindow::Onboarding, "Welcome to Cap"),
        ];
        assert_eq!(OwnWindow::ALL.len(), expected.len());
        for (kind, title) in expected {
            assert_eq!(kind.title(), title, "{kind:?}");
            assert!(OwnWindow::ALL.contains(&kind), "{kind:?} missing from ALL");
        }
    }

    /// How the table lines up with `DEFAULT_EXCLUDED_WINDOW_TITLES`
    /// (`general_settings.rs:104-114`): the defaults name three windows this
    /// app does not have, and four of ours are deliberately not in the defaults
    /// -- "Cap Target Select" carries a comment over there explaining why it
    /// must not be added (a Windows ghost-overlay bug), and the editors and
    /// onboarding are simply not excluded by default.
    #[test]
    fn default_exclusion_titles_line_up_with_the_table() {
        let ours: Vec<&str> = OwnWindow::ALL.iter().map(|kind| kind.title()).collect();

        let shared: Vec<&&str> = DEFAULT_EXCLUDED_WINDOW_TITLES
            .iter()
            .filter(|title| ours.contains(title))
            .collect();
        assert_eq!(
            shared,
            vec![
                &"Cap",
                &"Cap Settings",
                &"Cap Recording Controls",
                &"Cap Camera",
                &"Cap Mode Selection",
                &"Cap Teleprompter",
            ]
        );

        let defaults_without_a_window: Vec<&&str> = DEFAULT_EXCLUDED_WINDOW_TITLES
            .iter()
            .filter(|title| !ours.contains(title))
            .collect();
        assert_eq!(
            defaults_without_a_window,
            vec![
                &"Cap Window Capture Occluder",
                &"Cap Capture Area",
                &"Cap Recordings Overlay",
            ]
        );

        let windows_without_a_default: Vec<OwnWindow> = OwnWindow::ALL
            .into_iter()
            .filter(|kind| !DEFAULT_EXCLUDED_WINDOW_TITLES.contains(&kind.title()))
            .collect();
        assert_eq!(
            windows_without_a_default,
            vec![
                OwnWindow::TargetSelect,
                OwnWindow::Editor,
                OwnWindow::ScreenshotEditor,
                OwnWindow::Onboarding,
            ]
        );
    }

    /// The rule list a start builds (`recording.rs:1879-1904`) resolved against
    /// our own windows: the defaults cover main, settings, the bar, mode select
    /// and the teleprompter in both modes, and the camera bubble in Studio only
    /// -- `filter_for_instant_mode` drops that rule for Instant, where the
    /// bubble has to be burned into the capture.
    #[test]
    fn defaults_exclude_our_windows_with_the_instant_camera_carve_out() {
        let studio = own_window_exclusion_rules(default_excluded_windows(), RecordingMode::Studio);
        assert_eq!(
            excluded_own_windows(&studio),
            vec![
                OwnWindow::Main,
                OwnWindow::Settings,
                OwnWindow::Controls,
                OwnWindow::Camera,
                OwnWindow::ModeSelect,
                OwnWindow::Teleprompter,
            ]
        );

        let instant =
            own_window_exclusion_rules(default_excluded_windows(), RecordingMode::Instant);
        assert_eq!(
            excluded_own_windows(&instant),
            vec![
                OwnWindow::Main,
                OwnWindow::Settings,
                OwnWindow::Controls,
                OwnWindow::ModeSelect,
                OwnWindow::Teleprompter,
            ]
        );
    }

    /// `teleprompter_exclusion` is appended whatever the settings say
    /// (`recording.rs:1891-1900`), and never twice.
    #[test]
    fn the_teleprompter_rule_is_always_present_and_never_duplicated() {
        let from_nothing = own_window_exclusion_rules(Vec::new(), RecordingMode::Instant);
        assert_eq!(from_nothing, vec![title_rule("Cap Teleprompter")]);
        assert_eq!(
            excluded_own_windows(&from_nothing),
            vec![OwnWindow::Teleprompter]
        );

        let already_configured =
            own_window_exclusion_rules(vec![title_rule("Cap Teleprompter")], RecordingMode::Studio);
        assert_eq!(already_configured, vec![title_rule("Cap Teleprompter")]);
    }

    /// Our own windows are matched on title *alone*
    /// (`matches_window_title` feeds `None, None, Some(title)`), so rules that
    /// need a bundle id or an owner name can only ever match another process's
    /// windows -- including the owner+title pairing, which requires both halves.
    #[test]
    fn rules_that_need_more_than_a_title_never_match_our_windows() {
        let by_identity = vec![
            WindowExclusion {
                bundle_identifier: Some("so.cap.desktop".to_string()),
                ..Default::default()
            },
            WindowExclusion {
                owner_name: Some("Cap".to_string()),
                ..Default::default()
            },
            WindowExclusion {
                owner_name: Some("Cap".to_string()),
                window_title: Some("Cap".to_string()),
                ..Default::default()
            },
        ];
        assert!(excluded_own_windows(&by_identity).is_empty());
    }

    /// `apply_content_protection` walks the same rules but skips the camera
    /// window outright (`windows.rs:3393-3398`); the camera's protection is the
    /// mode's business instead (`recording.rs:1617-1624`).
    #[test]
    fn content_protection_skips_the_camera_and_follows_the_mode() {
        let studio = own_window_exclusion_rules(default_excluded_windows(), RecordingMode::Studio);
        assert_eq!(
            content_protection_targets(&studio),
            vec![
                OwnWindow::Main,
                OwnWindow::Settings,
                OwnWindow::Controls,
                OwnWindow::ModeSelect,
                OwnWindow::Teleprompter,
            ]
        );

        let instant =
            own_window_exclusion_rules(default_excluded_windows(), RecordingMode::Instant);
        assert_eq!(
            content_protection_targets(&instant),
            content_protection_targets(&studio),
            "the instant carve-out only ever concerns the camera window"
        );

        assert!(camera_content_protected(RecordingMode::Studio));
        assert!(!camera_content_protected(RecordingMode::Instant));

        // A user who empties the list still gets the teleprompter protected,
        // the way `window_capture_excluded` short-circuits on its title.
        let emptied = own_window_exclusion_rules(Vec::new(), RecordingMode::Studio);
        assert_eq!(
            content_protection_targets(&emptied),
            vec![OwnWindow::Teleprompter]
        );
    }

    /// `repositionCameraForWindow` (`target-select-overlay.tsx:125-162`): the
    /// bubble lands one 16px padding in from the window's bottom-right corner,
    /// in global coordinates, and a window that cannot hold it plus a padding
    /// on each side is left alone.
    #[test]
    fn the_camera_parks_in_the_window_corner() {
        let window = AreaRect {
            x: 100.,
            y: 50.,
            width: 800.,
            height: 600.,
        };

        // Primary display (origin 0,0): 100+800-320-16, 50+600-240-16.
        assert_eq!(
            camera_park_position((0., 0.), window, (320., 240.)),
            Some((564., 394.))
        );

        // A window on a display to the right carries that display's origin.
        assert_eq!(
            camera_park_position((1920., 0.), window, (320., 240.)),
            Some((2484., 394.))
        );

        // Fractional geometry is rounded, the way `Math.round` rounds it.
        assert_eq!(
            camera_park_position((0.4, 0.), window, (320.3, 240.)),
            Some((564., 394.))
        );
        assert_eq!(
            camera_park_position((-1920.5, 0.), window, (320., 240.)),
            Some((-1356., 394.))
        );

        // Exactly one padding on each side still fits; one point more does not.
        let snug = AreaRect {
            x: 0.,
            y: 0.,
            width: 352.,
            height: 272.,
        };
        assert_eq!(
            camera_park_position((0., 0.), snug, (320., 240.)),
            Some((16., 16.))
        );
        assert_eq!(camera_park_position((0., 0.), snug, (321., 240.)), None);
        assert_eq!(camera_park_position((0., 0.), snug, (320., 241.)), None);
    }

    #[test]
    fn area_camera_keeps_toolbar_height_and_restores_the_original_scale() {
        let crop = AreaRect {
            x: 100.,
            y: 50.,
            width: 800.,
            height: 600.,
        };
        assert_eq!(
            camera_area_bounds((0., 0.), crop, (320., 376.)),
            Some(AreaRect {
                x: 640.,
                y: 334.,
                width: 244.,
                height: 300.,
            })
        );
        assert_eq!(
            camera_area_bounds(
                (0., 0.),
                AreaRect {
                    width: 1200.,
                    height: 1000.,
                    ..crop
                },
                (320., 376.)
            ),
            Some(AreaRect {
                x: 964.,
                y: 658.,
                width: 320.,
                height: 376.,
            })
        );
    }

    #[test]
    fn area_camera_preserves_landscape_and_portrait_content_aspects() {
        let crop = AreaRect {
            x: 100.,
            y: 50.,
            width: 600.,
            height: 400.,
        };
        assert_eq!(
            camera_area_bounds((0., 0.), crop, (320., 236.)),
            Some(AreaRect {
                x: 540.,
                y: 297.,
                width: 144.,
                height: 137.,
            })
        );
        assert_eq!(
            camera_area_bounds((0., 0.), crop, (180., 376.)),
            Some(AreaRect {
                x: 603.,
                y: 234.,
                width: 81.,
                height: 200.,
            })
        );
    }

    #[test]
    fn area_camera_uses_the_minimum_size_and_requires_room_beyond_both_insets() {
        let crop = AreaRect {
            x: 0.,
            y: 0.,
            width: 200.,
            height: 200.,
        };
        assert_eq!(
            camera_area_bounds((0., 0.), crop, (320., 376.)),
            Some(AreaRect {
                x: 84.,
                y: 28.,
                width: 100.,
                height: 156.,
            })
        );
        assert_eq!(
            camera_area_bounds(
                (0., 0.),
                AreaRect {
                    width: 132.,
                    ..crop
                },
                (320., 376.)
            ),
            None
        );
        assert_eq!(
            camera_area_bounds(
                (0., 0.),
                AreaRect {
                    height: 188.,
                    ..crop
                },
                (320., 376.)
            ),
            None
        );
    }

    #[test]
    fn area_camera_position_preserves_the_display_origin() {
        let crop = AreaRect {
            x: 100.,
            y: 50.,
            width: 800.,
            height: 600.,
        };
        assert_eq!(
            camera_area_bounds((-1920.5, -1080.25), crop, (320., 376.)),
            Some(AreaRect {
                x: -1280.5,
                y: -746.25,
                width: 244.,
                height: 300.,
            })
        );
    }
}
