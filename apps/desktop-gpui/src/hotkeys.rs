//! Global hotkeys -- `apps/desktop/src-tauri/src/hotkeys.rs`, natively.
//!
//! The Tauri app registers the store's bindings through
//! `tauri_plugin_global_shortcut`, which wraps the `global-hotkey` crate;
//! this module uses that crate directly at the same pin, so the platform
//! mapping from the store's W3C `KeyboardEvent.code` strings to Carbon
//! virtual keycodes is the exact code path the shipping app runs. Bindings
//! live in the shared store (`hotkeys.hotkeys`, see `store::hotkeys_raw`),
//! and the settings Shortcuts page's commit calls [`reload`] where the Tauri
//! page calls `commands.setHotkey`.
//!
//! The overlay's global Escape stays on its own Carbon registration
//! (`platform::register_escape_hotkey`) exactly as it is separate in the
//! Tauri app (`target_select_overlay.rs`, not a `HotkeyAction`). The Tauri
//! handler's `OnEscapePress` emit only ever reaches that overlay too -- its
//! sole listener is `target-select-overlay.tsx` -- so the native registration
//! covers the whole behaviour.

use std::str::FromStr as _;

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use global_hotkey::{
    GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
    hotkey::{Code, HotKey, Modifiers},
};
use gpui::{App, Global, PromptButton, PromptLevel};

use crate::{
    app_windows,
    main_window::{Mode, TargetType},
    session::{Phase, RecordingSession},
    store,
};

/// `HotkeyAction` (`hotkeys.rs:52-71` over there); the variants are the
/// camelCase store keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotkeyAction {
    StartStudioRecording,
    StartInstantRecording,
    StopRecording,
    RestartRecording,
    TogglePauseRecording,
    CycleRecordingMode,
    OpenRecordingPicker,
    OpenRecordingPickerDisplay,
    OpenRecordingPickerWindow,
    OpenRecordingPickerArea,
    ScreenshotDisplay,
    ScreenshotWindow,
    ScreenshotArea,
}

const ACTION_KEYS: [(&str, HotkeyAction); 13] = [
    ("startStudioRecording", HotkeyAction::StartStudioRecording),
    ("startInstantRecording", HotkeyAction::StartInstantRecording),
    ("stopRecording", HotkeyAction::StopRecording),
    ("restartRecording", HotkeyAction::RestartRecording),
    ("togglePauseRecording", HotkeyAction::TogglePauseRecording),
    ("cycleRecordingMode", HotkeyAction::CycleRecordingMode),
    ("openRecordingPicker", HotkeyAction::OpenRecordingPicker),
    (
        "openRecordingPickerDisplay",
        HotkeyAction::OpenRecordingPickerDisplay,
    ),
    (
        "openRecordingPickerWindow",
        HotkeyAction::OpenRecordingPickerWindow,
    ),
    (
        "openRecordingPickerArea",
        HotkeyAction::OpenRecordingPickerArea,
    ),
    ("screenshotDisplay", HotkeyAction::ScreenshotDisplay),
    ("screenshotWindow", HotkeyAction::ScreenshotWindow),
    ("screenshotArea", HotkeyAction::ScreenshotArea),
];

impl HotkeyAction {
    /// `#[serde(other)] Other` over there: a newer app's action survives in
    /// the store and registers nothing here.
    fn from_store_key(key: &str) -> Option<Self> {
        ACTION_KEYS
            .iter()
            .find(|(stored, _)| *stored == key)
            .map(|(_, action)| *action)
    }

    fn store_key(self) -> &'static str {
        ACTION_KEYS
            .iter()
            .find(|(_, action)| *action == self)
            .map(|(key, _)| *key)
            .unwrap_or_default()
    }
}

struct Hotkeys {
    /// Only alive while something is registered: on X11 the manager owns a
    /// thread that polls the server every 50ms whether or not any key is
    /// grabbed.
    manager: Option<GlobalHotKeyManager>,
    bindings: Vec<(HotKey, HotkeyAction)>,
    /// Bindings the OS refused, usually because macOS or another app already
    /// owns the combo. The Shortcuts page flags these rows.
    unavailable: Vec<HotkeyAction>,
    /// Set while the Shortcuts page records a new combo: a registered combo
    /// would otherwise fire its action instead of reaching the page.
    paused: bool,
    #[cfg(target_os = "linux")]
    capture_stop: Option<HotKey>,
}

impl Global for Hotkeys {}

impl Hotkeys {
    fn manager(&mut self) -> Result<&GlobalHotKeyManager, String> {
        match &mut self.manager {
            Some(manager) => Ok(manager),
            slot @ None => {
                Ok(slot.insert(GlobalHotKeyManager::new().map_err(|error| error.to_string())?))
            }
        }
    }

    fn idle(&self) -> bool {
        #[cfg(target_os = "linux")]
        if self.capture_stop.is_some() {
            return false;
        }
        self.bindings.is_empty()
    }

    fn release_idle_manager(&mut self) {
        if self.idle() {
            self.manager = None;
        }
    }
}

/// Register the store's bindings (on the main thread, where the manager
/// installs the Carbon event handler) and start the drain. The handler callback
/// fires on the OS event seam, so it only forwards into a channel; the gpui
/// task dispatches with a clean borrow -- the tray-channel discipline.
pub fn init(cx: &mut App) {
    cx.set_global(Hotkeys {
        manager: None,
        bindings: Vec::new(),
        unavailable: Vec::new(),
        paused: false,
        #[cfg(target_os = "linux")]
        capture_stop: None,
    });
    register_from_store(cx);

    let (tx, rx) = flume::unbounded::<GlobalHotKeyEvent>();
    GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
        let _ = tx.send(event);
    }));
    cx.spawn(async move |cx| {
        while let Ok(event) = rx.recv_async().await {
            #[cfg(target_os = "linux")]
            if cx.update(|cx| {
                if cx
                    .global::<Hotkeys>()
                    .capture_stop
                    .is_some_and(|key| key.id() == event.id())
                {
                    app_windows::handle_clean_capture_shortcut(event.state, cx);
                    true
                } else {
                    false
                }
            }) {
                continue;
            }
            // Pressed only, like the Tauri handler (`hotkeys.rs:183-185`).
            if event.state == HotKeyState::Pressed {
                cx.update(|cx| dispatch_id(event.id(), cx));
            }
        }
    })
    .detach();
}

/// Re-read the store and swap every OS registration -- the settings page's
/// commit seam (`commands.setHotkey` re-registers over there).
pub fn reload(cx: &mut App) {
    if !cx.has_global::<Hotkeys>() || cx.global::<Hotkeys>().paused {
        return;
    }
    #[cfg(target_os = "linux")]
    if cx.global::<Hotkeys>().capture_stop.is_some() {
        return;
    }
    unregister_all(cx);
    register_from_store(cx);
}

/// Drop every OS registration while the Shortcuts page records a combo, so
/// pressing an already-bound combo reaches the page instead of firing.
/// Returns false when the bindings cannot be released: on Linux a recording's
/// temporary stop key holds the registrations until the recording ends.
pub fn pause(cx: &mut App) -> bool {
    if !cx.has_global::<Hotkeys>() || cx.global::<Hotkeys>().paused {
        return true;
    }
    if editing_blocked(cx) {
        return false;
    }
    unregister_all(cx);
    let hotkeys = cx.global_mut::<Hotkeys>();
    hotkeys.paused = true;
    hotkeys.release_idle_manager();
    tracing::info!("global hotkeys paused while a shortcut is recorded");
    crate::tray::refresh_menu(cx);
    true
}

pub fn is_paused(cx: &App) -> bool {
    cx.try_global::<Hotkeys>()
        .is_some_and(|hotkeys| hotkeys.paused)
}

pub fn editing_blocked(cx: &App) -> bool {
    #[cfg(target_os = "linux")]
    if cx
        .try_global::<Hotkeys>()
        .is_some_and(|hotkeys| hotkeys.capture_stop.is_some())
    {
        return true;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cx;
    false
}

/// End a [`pause`] and register the store's bindings again. Returns whether
/// anything was paused; without a pause the registrations are left alone.
pub fn resume(cx: &mut App) -> bool {
    if !cx.has_global::<Hotkeys>() || !cx.global::<Hotkeys>().paused {
        return false;
    }
    cx.global_mut::<Hotkeys>().paused = false;
    reload(cx);
    true
}

/// The registered combo for an action, or `None` when nothing is bound. The
/// tray menu renders it as the row's accelerator.
pub(crate) fn accelerator(action: HotkeyAction, cx: &App) -> Option<HotKey> {
    cx.try_global::<Hotkeys>()?
        .bindings
        .iter()
        .find(|(_, bound)| *bound == action)
        .map(|(hotkey, _)| *hotkey)
}

pub fn unavailable_actions(cx: &App) -> Vec<&'static str> {
    cx.try_global::<Hotkeys>()
        .map(|hotkeys| {
            hotkeys
                .unavailable
                .iter()
                .map(|action| action.store_key())
                .collect()
        })
        .unwrap_or_default()
}

fn unregister_all(cx: &mut App) {
    let hotkeys = cx.global_mut::<Hotkeys>();
    // Two actions on one combo share one OS registration, so unregister each
    // combo once.
    let mut old: Vec<HotKey> = Vec::new();
    for (hotkey, _) in &hotkeys.bindings {
        if !old.iter().any(|existing| existing.id() == hotkey.id()) {
            old.push(*hotkey);
        }
    }
    if let Some(manager) = &hotkeys.manager
        && let Err(error) = manager.unregister_all(&old)
    {
        tracing::warn!("unregistering global hotkeys failed: {error}");
    }
    hotkeys.bindings.clear();
    hotkeys.unavailable.clear();
}

#[cfg(target_os = "linux")]
fn clean_capture_shortcut_conflicts(actions: &[HotkeyAction]) -> bool {
    actions
        .iter()
        .any(|action| *action != HotkeyAction::StopRecording)
}

#[cfg(target_os = "linux")]
struct WaylandStop {
    generation: u64,
    label: String,
    ready: bool,
    cancel: flume::Sender<()>,
    worker: Option<tokio::task::JoinHandle<Result<(), String>>>,
    cleanup: Option<futures_util::future::Shared<gpui::Task<Result<(), String>>>>,
}

#[cfg(target_os = "linux")]
impl Global for WaylandStop {}

#[cfg(target_os = "linux")]
enum WaylandStopEvent {
    Ready(String),
    Key(HotKeyState),
    Activate,
    Unavailable(String),
}

#[cfg(target_os = "linux")]
pub fn clean_capture_stop_message(cx: &App) -> String {
    if let Some(stop) = cx.try_global::<WaylandStop>() {
        return stop.label.clone();
    }
    "Press and release Ctrl+Shift+F9 to start. Use the same shortcut to stop. This temporary shortcut does not change your settings.".into()
}

#[cfg(target_os = "linux")]
fn clean_capture_shortcut_label(trigger: &str) -> String {
    let trigger = readable_trigger(trigger);
    format!(
        "Press and release {trigger} to start. Use the same shortcut to stop. This temporary shortcut does not change your settings."
    )
}

/// Portal backends describe triggers in their own words: GNOME says
/// "Press <Shift><Control>F9", KDE "Ctrl+Shift+F9". Show one form.
#[cfg(any(target_os = "linux", test))]
fn readable_trigger(trigger: &str) -> String {
    let trigger = trigger.trim();
    let trigger = trigger
        .get(..6)
        .filter(|prefix| prefix.eq_ignore_ascii_case("press "))
        .map_or(trigger, |_| trigger[6..].trim_start());
    let mut readable = String::new();
    let mut rest = trigger;
    while let Some(open) = rest.strip_prefix('<') {
        let Some(end) = open.find('>') else { break };
        let modifier = match open[..end].to_ascii_lowercase().as_str() {
            "control" | "ctrl" | "primary" => "Ctrl",
            "shift" => "Shift",
            "alt" | "mod1" => "Alt",
            "super" | "meta" | "mod4" | "hyper" => "Super",
            _ => &open[..end],
        };
        readable.push_str(modifier);
        readable.push('+');
        rest = &open[end + 1..];
    }
    readable.push_str(rest);
    readable
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
enum ShortcutChange {
    Relabel(String),
    Unchanged,
    Removed,
}

/// `ShortcutsChanged` reports the session's registered shortcuts, and GNOME
/// sends one right after every bind it approves. Activation is matched by
/// shortcut id, so a new trigger only changes what the prompt should say. The
/// Stop control is lost only when the portal lists shortcuts without this one;
/// an empty list is ambiguous across backends and must not end a recording.
#[cfg(any(target_os = "linux", test))]
fn shortcut_change<'a>(
    shortcuts: impl IntoIterator<Item = (&'a str, &'a str)>,
    shortcut_id: &str,
) -> ShortcutChange {
    let mut listed = false;
    let ours = shortcuts.into_iter().find(|(id, _)| {
        listed = true;
        *id == shortcut_id
    });
    match ours {
        None if listed => ShortcutChange::Removed,
        None => ShortcutChange::Unchanged,
        Some((_, trigger)) if trigger.trim().is_empty() => ShortcutChange::Unchanged,
        Some((_, trigger)) => ShortcutChange::Relabel(trigger.to_owned()),
    }
}

#[cfg(target_os = "linux")]
fn reserve_wayland_stop(generation: u64, cx: &mut App) -> anyhow::Result<()> {
    anyhow::ensure!(
        !cx.has_global::<WaylandStop>(),
        "A recording Stop control is already reserved"
    );
    let (cancel, cancelled) = flume::bounded(1);
    let (events, received) = flume::unbounded();
    let worker =
        gpui_tokio::Tokio::handle(cx).spawn(run_wayland_stop(generation, cancelled, events));
    cx.set_global(WaylandStop {
        generation,
        label: "Approve a recording shortcut, or activate the Cap Stop tray icon when it appears. Recording has not started.".into(),
        ready: false,
        cancel,
        worker: Some(worker),
        cleanup: None,
    });
    cx.spawn(async move |cx| {
        while let Ok(event) = received.recv_async().await {
            cx.update(|cx| {
                if !cx.has_global::<WaylandStop>() {
                    return;
                }
                let stop = cx.global_mut::<WaylandStop>();
                if stop.generation != generation {
                    return;
                }
                match event {
                    WaylandStopEvent::Ready(label) => {
                        tracing::info!(%label, "recording Stop control ready");
                        stop.ready = true;
                        stop.label = label;
                        app_windows::notify_clean_capture_preflight(cx);
                    }
                    WaylandStopEvent::Key(state) if stop.ready => {
                        app_windows::handle_owned_clean_capture_shortcut(generation, state, cx);
                    }
                    WaylandStopEvent::Activate if stop.ready => {
                        app_windows::handle_owned_clean_capture_shortcut(
                            generation,
                            HotKeyState::Pressed,
                            cx,
                        );
                        app_windows::handle_owned_clean_capture_shortcut(
                            generation,
                            HotKeyState::Released,
                            cx,
                        );
                    }
                    WaylandStopEvent::Unavailable(error) => {
                        let was_ready = stop.ready;
                        stop.ready = false;
                        app_windows::clean_capture_stop_unavailable(
                            generation, error, was_ready, cx,
                        );
                    }
                    _ => {}
                }
            });
        }
        cx.update(|cx| {
            if let Some(was_ready) = cx
                .try_global::<WaylandStop>()
                .filter(|stop| stop.generation == generation && stop.cleanup.is_none())
                .map(|stop| stop.ready)
            {
                app_windows::clean_capture_stop_unavailable(
                    generation,
                    "The recording Stop worker ended".into(),
                    was_ready,
                    cx,
                );
            }
        });
    })
    .detach();
    Ok(())
}

#[cfg(target_os = "linux")]
async fn run_wayland_stop(
    generation: u64,
    cancel: flume::Receiver<()>,
    events: flume::Sender<WaylandStopEvent>,
) -> Result<(), String> {
    let mut ready = false;
    let mut fallback_safe = true;
    let result =
        run_portal_stop(generation, &cancel, &events, &mut ready, &mut fallback_safe).await;
    if cancel.is_disconnected() || !cancel.is_empty() {
        return result.map_err(|error| error.to_string());
    }
    if result.is_ok() {
        return Ok(());
    }
    if !fallback_safe {
        let error = format!(
            "The recording shortcut registration could not be cleaned up safely: {}",
            result.unwrap_err()
        );
        let _ = events.send(WaylandStopEvent::Unavailable(error.clone()));
        return Err(error);
    }
    if ready {
        if let Err(error) = result {
            let _ = events.send(WaylandStopEvent::Unavailable(error.to_string()));
        }
        return Ok(());
    }
    if let Err(error) = result {
        tracing::info!(%error, "Using the recording Stop tray instead of GlobalShortcuts");
    }
    match run_tray_stop(generation, &cancel, &events).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = events.send(WaylandStopEvent::Unavailable(error.to_string()));
            // A tray that never registered left nothing to clean up; failing
            // here would block every later recording behind a cleanup error.
            if error.is::<StopTrayNeverRegistered>() {
                Ok(())
            } else {
                Err(error.to_string())
            }
        }
    }
}

/// The recording Stop tray could not register at all (no StatusNotifier
/// watcher, as on GNOME without the AppIndicator extension).
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct StopTrayNeverRegistered(String);

#[cfg(target_os = "linux")]
impl std::fmt::Display for StopTrayNeverRegistered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(target_os = "linux")]
impl std::error::Error for StopTrayNeverRegistered {}

#[cfg(target_os = "linux")]
fn wayland_stop_icon() -> anyhow::Result<cap_utils::linux_recording_stop::StopTrayIcon> {
    let image = image::load_from_memory(include_bytes!("../assets/tray/tray-stop-icon.png"))?
        .resize_exact(32, 32, image::imageops::FilterType::Triangle)
        .into_rgba8();
    cap_utils::linux_recording_stop::StopTrayIcon::from_rgba(
        image.width(),
        image.height(),
        image.as_raw(),
    )
    .map_err(anyhow::Error::msg)
}

#[cfg(target_os = "linux")]
async fn join_wayland_stop_worker(
    worker: Option<tokio::task::JoinHandle<Result<(), String>>>,
) -> Result<(), String> {
    let worker = worker.ok_or_else(|| "Recording Stop worker ownership was lost".to_string())?;
    worker
        .await
        .map_err(|error| format!("Recording Stop worker failed: {error}"))?
}

#[cfg(target_os = "linux")]
async fn run_tray_stop(
    generation: u64,
    cancel: &flume::Receiver<()>,
    events: &flume::Sender<WaylandStopEvent>,
) -> anyhow::Result<()> {
    use cap_utils::linux_recording_stop::{StopTray, StopTrayEvent};
    let icon = wayland_stop_icon()
        .map_err(|error| anyhow::Error::new(StopTrayNeverRegistered(error.to_string())))?;
    let tray = StopTray::open(generation, icon).await.map_err(|error| {
        if error.can_fallback() {
            anyhow::Error::new(StopTrayNeverRegistered(error.to_string()))
        } else {
            anyhow::anyhow!("Recording Stop tray registration cleanup is unconfirmed: {error}")
        }
    })?;
    let received = tray.events();
    let outcome = async {
        events.send(WaylandStopEvent::Ready("Activate the Cap Stop tray icon to start. Activate the same icon again to stop. Recording will not start until you use that control.".into()))?;
        loop {
            tokio::select! {
                biased;
                _ = cancel.recv_async() => return Ok(()),
                event = received.recv_async() => match event? {
                    StopTrayEvent::Activated { generation: owner } if owner == generation => events.send(WaylandStopEvent::Activate)?,
                    StopTrayEvent::Unavailable { generation: owner } if owner == generation => anyhow::bail!("The recording Stop tray is no longer available"),
                    _ => {}
                }
            }
        }
    }.await;
    let closed = tray.close().await.map_err(anyhow::Error::msg);
    outcome.and(closed)
}

#[cfg(target_os = "linux")]
async fn run_portal_stop(
    generation: u64,
    cancel: &flume::Receiver<()>,
    events: &flume::Sender<WaylandStopEvent>,
    ready: &mut bool,
    fallback_safe: &mut bool,
) -> anyhow::Result<()> {
    use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
    use futures_util::StreamExt;
    use std::time::Duration;
    let portal = tokio::time::timeout(Duration::from_secs(5), GlobalShortcuts::new()).await??;
    tokio::time::timeout(
        Duration::from_secs(5),
        portal.get_property::<u32>("version"),
    )
    .await??;
    let session = tokio::time::timeout(Duration::from_secs(5), portal.create_session()).await??;
    *fallback_safe = false;
    let outcome = async {
        let session_path = serde_json::to_value(&session)?.as_str().ok_or_else(|| anyhow::anyhow!("Invalid shortcut session identity"))?.to_owned();
        let shortcut_id = format!("cap-recording-stop-{generation}");
        let activated = portal.receive_activated().await?;
        let deactivated = portal.receive_deactivated().await?;
        let changed = portal.receive_shortcuts_changed().await?;
        let closed = session.receive_closed().await?;
        futures_util::pin_mut!(activated, deactivated, changed, closed);
        let shortcuts = [NewShortcut::new(&shortcut_id, "Start or stop this Cap recording").preferred_trigger("CTRL+SHIFT+F9")];
        let bind = portal.bind_shortcuts(&session, &shortcuts, None);
        let response = tokio::select! {
            _ = cancel.recv_async() => return Ok(()),
            response = tokio::time::timeout(Duration::from_secs(60), bind) => response??.response()?,
        };
        let shortcut = response.shortcuts().iter().find(|shortcut| shortcut.id() == shortcut_id).ok_or_else(|| anyhow::anyhow!("The portal did not grant the recording Stop shortcut"))?;
        let label = shortcut.trigger_description();
        anyhow::ensure!(!label.trim().is_empty(), "The portal did not describe the granted Stop shortcut");
        events.send(WaylandStopEvent::Ready(clean_capture_shortcut_label(label)))?;
        *ready = true;
        loop {
            tokio::select! {
                biased;
                _ = cancel.recv_async() => return Ok(()),
                event = activated.next() => {
                    let event = event.ok_or_else(|| anyhow::anyhow!("Recording shortcut activation stream closed"))?;
                    if event.session_handle().as_str() == session_path && event.shortcut_id() == shortcut_id { events.send(WaylandStopEvent::Key(HotKeyState::Pressed))?; }
                }
                event = deactivated.next() => {
                    let event = event.ok_or_else(|| anyhow::anyhow!("Recording shortcut release stream closed"))?;
                    if event.session_handle().as_str() == session_path && event.shortcut_id() == shortcut_id { events.send(WaylandStopEvent::Key(HotKeyState::Released))?; }
                }
                event = changed.next() => {
                    let event = event.ok_or_else(|| anyhow::anyhow!("Recording shortcut change stream closed"))?;
                    if event.session_handle().as_str() != session_path { continue; }
                    let shortcuts = event.shortcuts().iter().map(|shortcut| (shortcut.id(), shortcut.trigger_description()));
                    match shortcut_change(shortcuts, &shortcut_id) {
                        ShortcutChange::Relabel(label) => events.send(WaylandStopEvent::Ready(clean_capture_shortcut_label(&label)))?,
                        ShortcutChange::Unchanged => {}
                        ShortcutChange::Removed => anyhow::bail!("The recording shortcut was removed. Recording has stopped."),
                    }
                }
                _ = closed.next() => anyhow::bail!("The recording shortcut session closed"),
            }
        }
    }.await;
    let closed = tokio::time::timeout(Duration::from_secs(3), session.close()).await;
    match closed {
        Ok(Ok(())) => {
            *fallback_safe = true;
            outcome
        }
        Ok(Err(error)) => Err(error.into()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
pub fn reserve_clean_capture_stop(
    generation: u64,
    wayland: bool,
    cx: &mut App,
) -> anyhow::Result<()> {
    if wayland {
        return reserve_wayland_stop(generation, cx);
    }
    if !cx.has_global::<Hotkeys>() {
        anyhow::bail!("Global shortcuts are unavailable. Recording has not started.");
    }
    let hotkeys = cx.global_mut::<Hotkeys>();
    if hotkeys.capture_stop.is_some() {
        anyhow::bail!("A recording shortcut is already reserved.");
    }
    let key = HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F9);
    let actions = actions_for(&hotkeys.bindings, key.id());
    if clean_capture_shortcut_conflicts(&actions) {
        anyhow::bail!(
            "Ctrl+Shift+F9 is assigned to another Cap action. Change that shortcut before recording."
        );
    }
    if actions.is_empty() {
        let registered = hotkeys
            .manager()
            .and_then(|manager| manager.register(key).map_err(|error| error.to_string()));
        if let Err(error) = registered {
            hotkeys.release_idle_manager();
            anyhow::bail!("Ctrl+Shift+F9 is unavailable: {error}. Recording has not started.");
        }
    }
    hotkeys.capture_stop = Some(key);
    Ok(())
}

#[cfg(target_os = "linux")]
pub type CleanStopCleanup = futures_util::future::BoxFuture<'static, Result<(), String>>;

#[cfg(target_os = "linux")]
pub fn begin_wayland_stop_cleanup(cx: &mut App) -> CleanStopCleanup {
    if cx.has_global::<WaylandStop>() {
        use futures_util::FutureExt;
        let executor = cx.background_executor().clone();
        let stop = cx.global_mut::<WaylandStop>();
        if stop.cleanup.is_none() {
            let worker = stop.worker.take();
            let _ = stop.cancel.send(());
            stop.cleanup = Some(executor.spawn(join_wayland_stop_worker(worker)).shared());
        }
        let cleanup = stop.cleanup.as_ref().unwrap().clone();
        return Box::pin(async move {
            tokio::time::timeout(std::time::Duration::from_secs(3), cleanup)
                .await
                .map_err(|_| {
                    "Recording Stop cleanup has not joined; its worker remains owned".to_string()
                })?
        });
    }
    Box::pin(async { Ok(()) })
}

#[cfg(target_os = "linux")]
pub fn release_clean_capture_stop(cx: &mut App) {
    if !cx.has_global::<Hotkeys>() {
        return;
    }
    let hotkeys = cx.global_mut::<Hotkeys>();
    let Some(key) = hotkeys.capture_stop.take() else {
        return;
    };
    if actions_for(&hotkeys.bindings, key.id()).is_empty()
        && let Some(manager) = &hotkeys.manager
        && let Err(error) = manager.unregister(key)
    {
        tracing::warn!(%error, "Could not release the temporary recording shortcut");
    }
    reload(cx);
}

#[cfg(target_os = "linux")]
pub fn complete_clean_capture_stop(generation: u64, cx: &mut App) {
    if cx
        .try_global::<WaylandStop>()
        .is_some_and(|stop| stop.generation == generation && stop.cleanup.is_some())
    {
        let _closed = cx.remove_global::<WaylandStop>();
    }
}

fn register_from_store(cx: &mut App) {
    let stored = store::hotkeys_raw();
    let hotkeys = cx.global_mut::<Hotkeys>();
    for (key, value) in &stored {
        let Some(action) = HotkeyAction::from_store_key(key) else {
            tracing::debug!(key, "hotkey action unknown to this build; skipped");
            continue;
        };
        let Some(binding) = store::hotkey_from_value(value) else {
            tracing::warn!(key, "unparseable hotkey binding in the store");
            continue;
        };
        let Ok(code) = Code::from_str(&binding.code) else {
            tracing::warn!(key, code = %binding.code, "unknown hotkey code");
            continue;
        };
        let mut mods = Modifiers::empty();
        if binding.meta {
            mods |= Modifiers::META;
        }
        if binding.ctrl {
            mods |= Modifiers::CONTROL;
        }
        if binding.alt {
            mods |= Modifiers::ALT;
        }
        if binding.shift {
            mods |= Modifiers::SHIFT;
        }
        let hotkey = HotKey::new(Some(mods), code);
        // The same combo bound to a second action keeps the one OS
        // registration; the dispatch fires every action on it, the way the
        // Tauri handler loops the whole map per press (`hotkeys.rs:201-205`
        // over there).
        if hotkeys
            .bindings
            .iter()
            .any(|(existing, _)| existing.id() == hotkey.id())
        {
            hotkeys.bindings.push((hotkey, action));
            continue;
        }
        let registered = hotkeys
            .manager()
            .and_then(|manager| manager.register(hotkey).map_err(|error| error.to_string()));
        match registered {
            Ok(()) => hotkeys.bindings.push((hotkey, action)),
            Err(error) => {
                tracing::warn!(?action, code = %binding.code, "registering global hotkey failed: {error}");
                hotkeys.unavailable.push(action);
            }
        }
    }
    hotkeys.release_idle_manager();
    tracing::info!(count = hotkeys.bindings.len(), "global hotkeys registered");
    crate::tray::refresh_menu(cx);
}

/// `CAP_GPUI_AUTO_HOTKEY=<store key>`: run an action's dispatch arm without
/// the OS keypress (unprivileged synthetic key events are dropped, the same
/// reason every other `CAP_GPUI_AUTO_*` hook exists).
pub fn dispatch_for_harness(key: &str, cx: &mut App) {
    match HotkeyAction::from_store_key(key) {
        Some(action) => dispatch(action, cx),
        None => tracing::error!(key, "CAP_GPUI_AUTO_HOTKEY: unknown action"),
    }
}

// The Tauri handler carries a ⌘, special case (`shortcut.mods ==
// Modifiers::META && shortcut.key == Code::Comma` opens Settings,
// `hotkeys.rs:191-196` over there) that is dead code at this pin:
// `HotKey::new` rewrites META into SUPER on every registration path, so no
// shortcut the handler ever sees carries META. Not reproduced -- the audit
// keeps the *observed* behaviour, which is that a Comma binding runs its
// action and nothing else.
fn dispatch_id(id: u32, cx: &mut App) {
    let actions = actions_for(&cx.global::<Hotkeys>().bindings, id);
    for action in actions {
        dispatch(action, cx);
    }
}

/// Every action bound to the pressed combo, in store order. The Tauri handler
/// loops the whole map per press (`hotkeys.rs:201-205` over there), so two
/// actions sharing one binding both fire.
fn actions_for(bindings: &[(HotKey, HotkeyAction)], id: u32) -> Vec<HotkeyAction> {
    bindings
        .iter()
        .filter(|(hotkey, _)| hotkey.id() == id)
        .map(|(_, action)| *action)
        .collect()
}

/// `handle_hotkey` (`hotkeys.rs:228-337` over there), against this app's
/// counterparts. Session methods are no-ops in the wrong phase, matching the
/// Tauri commands' own early returns.
fn dispatch(action: HotkeyAction, cx: &mut App) {
    tracing::info!(?action, "global hotkey");
    match action {
        HotkeyAction::StartStudioRecording => start_from_hotkey(Mode::Studio, cx),
        HotkeyAction::StartInstantRecording => start_from_hotkey(Mode::Instant, cx),
        HotkeyAction::StopRecording => {
            RecordingSession::global(cx).update(cx, |session, cx| session.stop(cx));
        }
        HotkeyAction::RestartRecording => {
            RecordingSession::global(cx).update(cx, |session, cx| session.restart(cx));
        }
        HotkeyAction::TogglePauseRecording => {
            RecordingSession::global(cx).update(cx, |session, cx| session.toggle_pause(cx));
        }
        HotkeyAction::CycleRecordingMode => {
            // `Studio -> Instant -> Screenshot -> Studio` (`hotkeys.rs:262`).
            let next = match Mode::from_store() {
                Mode::Studio => Mode::Instant,
                Mode::Instant => Mode::Screenshot,
                Mode::Screenshot => Mode::Studio,
            };
            app_windows::set_recording_mode(next, cx);
        }
        HotkeyAction::OpenRecordingPicker => {
            app_windows::show_main_window(cx);
            cx.activate(true);
        }
        HotkeyAction::OpenRecordingPickerDisplay => {
            app_windows::arm_target_mode(TargetType::Display, cx)
        }
        HotkeyAction::OpenRecordingPickerWindow => {
            app_windows::arm_target_mode(TargetType::Window, cx)
        }
        HotkeyAction::OpenRecordingPickerArea => app_windows::arm_target_mode(TargetType::Area, cx),
        HotkeyAction::ScreenshotDisplay => {
            let display = scap_targets::Display::get_containing_cursor()
                .unwrap_or_else(scap_targets::Display::primary);
            crate::screenshot::take_screenshot(
                ScreenCaptureTarget::Display { id: display.id() },
                cx,
            );
        }
        // Falls through our own windows to the one beneath, like the picker
        // list and the overlay hover (`devices::topmost_foreign_window_at_cursor`).
        HotkeyAction::ScreenshotWindow => {
            match crate::devices::topmost_foreign_window_at_cursor() {
                Some(window) => crate::screenshot::take_screenshot(
                    ScreenCaptureTarget::Window { id: window.id() },
                    cx,
                ),
                None => tracing::warn!("no window under the cursor to screenshot"),
            }
        }
        HotkeyAction::ScreenshotArea => {
            // `set_mode(Screenshot)` + the area picker (`hotkeys.rs:311-323`):
            // the grab happens when the drawn area is released.
            app_windows::set_recording_mode(Mode::Screenshot, cx);
            app_windows::arm_target_mode(TargetType::Area, cx);
        }
    }
}

fn microphone_available(name: &str) -> bool {
    use cap_recording::feeds::microphone::MicrophoneFeed;

    if cfg!(target_os = "macos") {
        MicrophoneFeed::list_names()
            .iter()
            .any(|device| device == name)
    } else {
        MicrophoneFeed::list().contains_key(name)
    }
}

/// `start_recording_from_hotkey` + the `RequestStartRecording` listener
/// (`hotkeys.rs:158-177`, `lib.rs:5529-5551` over there): confirm a start
/// without a working microphone, then record. Mic/camera come off the main
/// window's current selections through its ordinary start path.
///
/// The mode is set through [`app_windows::set_recording_mode`] first, so the
/// pill, the tray tick and the shared store all follow the hotkey; the Tauri
/// listener hands the mode straight to the engine and leaves the setting
/// where it was. Deliberate: this app's start path reads the window's mode,
/// and a recording visibly in Studio mode with the pill saying Instant is the
/// worse mismatch.
fn start_from_hotkey(mode: Mode, cx: &mut App) {
    app_windows::set_recording_mode(mode, cx);
    let main = cx.global::<app_windows::AppWindows>().main;
    let armed = main.read(cx).ok().and_then(|view| view.armed_target());
    let stored = stored_target();

    // `is_recording_active_or_pending` (`hotkeys.rs:162-170` over there): an
    // active session skips the confirm -- the re-start is a no-op either way,
    // `start_recording_with_target`'s phase check here and `start_recording`'s
    // over there.
    let idle = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
    let confirm = idle && store::GeneralSettings::load().confirm_without_microphone;
    let mic_name = main.read(cx).ok().and_then(|view| {
        view.microphone_selection()
            .map(|microphone| microphone.name.clone())
    });

    cx.spawn(async move |cx| {
        // Window and display lookups enumerate the system, so they run off
        // the main thread along with the microphone probe below.
        let target = cx
            .background_executor()
            .spawn(async move {
                pick_hotkey_target(armed, stored, target_is_live, || {
                    scap_targets::Display::get_containing_cursor()
                        .unwrap_or_else(scap_targets::Display::primary)
                        .id()
                })
            })
            .await;
        if !confirm {
            cx.update(|cx| start_now(main, mode, target, cx));
            return;
        }
        // The availability probe the Tauri confirm runs. On macOS that is a
        // name match (`microphone_available_for_confirmation` over there):
        // `MicrophoneFeed::list()` reads every input device's configuration,
        // which held the hotkey start for over 100 ms. No selection means no
        // microphone, which needs no enumeration to know.
        let available = match mic_name {
            Some(name) => {
                cx.background_executor()
                    .spawn(async move { microphone_available(&name) })
                    .await
            }
            None => false,
        };
        if available {
            cx.update(|cx| start_now(main, mode, target, cx));
            return;
        }
        // The Tauri dialog, word for word
        // (`confirm_direct_recording_without_microphone`). gpui prompts are
        // window sheets rather than free-standing alerts, so the main window
        // comes forward to host it.
        let receiver = cx.update(|cx| {
            app_windows::show_main_window(cx);
            cx.activate(true);
            main.update(cx, |_, window, cx| {
                window.prompt(
                    PromptLevel::Warning,
                    "No microphone detected",
                    Some("This recording will not include your voice."),
                    &[
                        PromptButton::ok("Record without microphone"),
                        PromptButton::cancel("Cancel"),
                    ],
                    cx,
                )
            })
        });
        let Ok(receiver) = receiver else {
            return;
        };
        // `receiver.await.unwrap_or(false)`: a dismissed sheet records
        // nothing.
        if receiver.await == Ok(0) {
            cx.update(|cx| start_now(main, mode, target, cx));
        }
    })
    .detach();
}

/// What a Start shortcut records: the target selected in the main window,
/// else the last recorded target, else the display under the pointer -- and
/// only a candidate that still exists. The stored target can be whatever was
/// recorded last, possibly by the Tauri app long ago, and a closed window or
/// unplugged display used to fail the start with "target_display_crop:
/// Display not found". A stored camera-only target is skipped: without a
/// camera selected it cannot start, so only an explicit choice records it.
fn pick_hotkey_target(
    armed: Option<ScreenCaptureTarget>,
    stored: Option<ScreenCaptureTarget>,
    is_live: impl Fn(&ScreenCaptureTarget) -> bool,
    fallback_display: impl FnOnce() -> scap_targets::DisplayId,
) -> ScreenCaptureTarget {
    let stored = stored.filter(|target| !matches!(target, ScreenCaptureTarget::CameraOnly));
    [armed, stored]
        .into_iter()
        .flatten()
        .find(|target| is_live(target))
        .unwrap_or_else(|| ScreenCaptureTarget::Display {
            id: fallback_display(),
        })
}

fn target_is_live(target: &ScreenCaptureTarget) -> bool {
    match target {
        ScreenCaptureTarget::Display { id } => scap_targets::Display::from_id(id).is_some(),
        ScreenCaptureTarget::Window { id } => {
            scap_targets::Window::from_id(id).is_some_and(|window| window.display().is_some())
        }
        ScreenCaptureTarget::Area { screen, .. } => {
            scap_targets::Display::from_id(screen).is_some()
        }
        ScreenCaptureTarget::CameraOnly => true,
    }
}

fn start_now(
    main: gpui::WindowHandle<crate::main_window::MainWindow>,
    mode: Mode,
    target: ScreenCaptureTarget,
    cx: &mut App,
) {
    // The start waited on the target lookup (and maybe the microphone
    // prompt); another Start or Cycle shortcut can change the mode meanwhile,
    // and the start path reads the window's mode.
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        app_windows::set_recording_mode(mode, cx);
    }
    main.update(cx, |view, window, cx| {
        view.start_recording_with_target(target, Vec::new(), window, cx)
    })
    .ok();
}

/// `RecordingSettingsStore.target`, straight off the shared store's JSON. A
/// missing key, a `null`, or a shape this build's `ScreenCaptureTarget` does
/// not know is `None` -- the primary-display fallback.
fn stored_target() -> Option<ScreenCaptureTarget> {
    let value = store::store_section(store::RECORDING_SETTINGS).remove("target")?;
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_manager_is_only_kept_while_a_shortcut_is_registered() {
        use super::{Code, HotKey, HotkeyAction, Hotkeys, Modifiers};

        let mut hotkeys = Hotkeys {
            manager: None,
            bindings: Vec::new(),
            unavailable: Vec::new(),
            paused: false,
            #[cfg(target_os = "linux")]
            capture_stop: None,
        };
        assert!(hotkeys.idle());
        hotkeys.release_idle_manager();
        assert!(hotkeys.manager.is_none());

        let key = HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyR);
        hotkeys.bindings.push((key, HotkeyAction::StopRecording));
        assert!(!hotkeys.idle());
        hotkeys.bindings.clear();

        #[cfg(target_os = "linux")]
        {
            hotkeys.capture_stop = Some(key);
            assert!(!hotkeys.idle());
            hotkeys.capture_stop = None;
        }
        assert!(hotkeys.idle());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn actual_stop_asset_is_resized_for_shared_tray_contract() {
        assert!(super::wayland_stop_icon().is_ok());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn wayland_stop_join_preserves_close_failure() {
        let worker = tokio::spawn(async { Err("native close failed".to_string()) });
        assert_eq!(
            super::join_wayland_stop_worker(Some(worker)).await,
            Err("native close failed".to_string())
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn wayland_stop_join_waits_for_the_owned_worker() {
        let (send, receive) = flume::bounded::<()>(1);
        let worker = tokio::spawn(async move {
            receive
                .recv_async()
                .await
                .map_err(|error| error.to_string())?;
            Ok(())
        });
        let mut joined = Box::pin(super::join_wayland_stop_worker(Some(worker)));
        assert!(futures_util::poll!(&mut joined).is_pending());
        send.send(()).unwrap();
        joined.await.unwrap();
    }

    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn temporary_stop_reuses_only_an_existing_stop_binding() {
        assert!(!clean_capture_shortcut_conflicts(&[]));
        assert!(!clean_capture_shortcut_conflicts(&[
            HotkeyAction::StopRecording
        ]));
        assert!(clean_capture_shortcut_conflicts(&[
            HotkeyAction::StartStudioRecording
        ]));
        assert!(clean_capture_shortcut_conflicts(&[
            HotkeyAction::StopRecording,
            HotkeyAction::StartStudioRecording
        ]));
    }

    /// Every store key the Tauri `HotkeyAction`'s camelCase serde produces
    /// maps to a variant here, and an unknown key registers nothing.
    #[test]
    fn action_keys_match_the_tauri_serde_names() {
        for key in [
            "startStudioRecording",
            "startInstantRecording",
            "stopRecording",
            "restartRecording",
            "togglePauseRecording",
            "cycleRecordingMode",
            "openRecordingPicker",
            "openRecordingPickerDisplay",
            "openRecordingPickerWindow",
            "openRecordingPickerArea",
            "screenshotDisplay",
            "screenshotWindow",
            "screenshotArea",
        ] {
            assert!(
                HotkeyAction::from_store_key(key).is_some(),
                "{key} should map to an action"
            );
        }
        assert_eq!(HotkeyAction::from_store_key("someFutureAction"), None);
        for (key, action) in ACTION_KEYS {
            assert_eq!(action.store_key(), key);
        }
    }

    fn window(id: &str) -> ScreenCaptureTarget {
        serde_json::from_value(serde_json::json!({ "variant": "window", "id": id })).unwrap()
    }

    fn display(id: &str) -> ScreenCaptureTarget {
        serde_json::from_value(serde_json::json!({ "variant": "display", "id": id })).unwrap()
    }

    fn display_id(id: &str) -> scap_targets::DisplayId {
        id.parse().unwrap()
    }

    fn same(a: &ScreenCaptureTarget, b: &ScreenCaptureTarget) -> bool {
        serde_json::to_value(a).unwrap() == serde_json::to_value(b).unwrap()
    }

    /// The store shape from the report: a Tauri-era window that no longer
    /// exists. The start must fall through to the pointer's display.
    #[test]
    fn a_stale_stored_window_falls_back_to_the_pointer_display() {
        let stored: ScreenCaptureTarget =
            serde_json::from_str(r#"{ "id": "7022", "variant": "window" }"#).unwrap();
        let picked = pick_hotkey_target(None, Some(stored), |_| false, || display_id("2"));
        assert!(same(&picked, &display("2")));
    }

    #[test]
    fn the_main_window_selection_wins_when_it_exists() {
        let picked = pick_hotkey_target(
            Some(window("11")),
            Some(window("22")),
            |_| true,
            || display_id("1"),
        );
        assert!(same(&picked, &window("11")));

        let picked = pick_hotkey_target(
            Some(window("11")),
            Some(window("22")),
            |target| same(target, &window("22")),
            || display_id("1"),
        );
        assert!(same(&picked, &window("22")));
    }

    #[test]
    fn the_last_target_is_used_when_nothing_is_selected() {
        let picked = pick_hotkey_target(None, Some(display("5")), |_| true, || display_id("1"));
        assert!(same(&picked, &display("5")));
    }

    #[test]
    fn a_stored_camera_only_target_never_starts_a_shortcut_recording() {
        let picked = pick_hotkey_target(
            None,
            Some(ScreenCaptureTarget::CameraOnly),
            |_| true,
            || display_id("3"),
        );
        assert!(same(&picked, &display("3")));
        let picked = pick_hotkey_target(
            Some(ScreenCaptureTarget::CameraOnly),
            None,
            |_| true,
            || display_id("3"),
        );
        assert!(matches!(picked, ScreenCaptureTarget::CameraOnly));
    }

    /// What the main window writes on every start is what the shortcut reads
    /// back.
    #[test]
    fn the_saved_target_round_trips_through_the_store_shape() {
        for target in [window("7022"), display("1")] {
            let value = serde_json::to_value(&target).unwrap();
            let back: ScreenCaptureTarget = serde_json::from_value(value).unwrap();
            assert!(same(&back, &target));
        }
    }

    /// Against the real system: a window id that cannot exist is never
    /// treated as recordable.
    #[test]
    fn a_missing_window_is_not_live() {
        assert!(!target_is_live(&window("4294967294")));
    }

    /// Two actions on the same combo both fire on one press -- the Tauri
    /// handler loops the whole map (`hotkeys.rs:201-205` over there).
    #[test]
    fn a_shared_binding_fires_every_action_on_it() {
        let stop = HotKey::new(Some(Modifiers::META | Modifiers::SHIFT), Code::KeyS);
        let restart = HotKey::new(Some(Modifiers::META | Modifiers::SHIFT), Code::KeyS);
        let pause = HotKey::new(Some(Modifiers::META), Code::KeyP);
        assert_eq!(stop.id(), restart.id());

        let bindings = vec![
            (stop, HotkeyAction::StopRecording),
            (pause, HotkeyAction::TogglePauseRecording),
            (restart, HotkeyAction::RestartRecording),
        ];
        assert_eq!(
            actions_for(&bindings, stop.id()),
            vec![HotkeyAction::StopRecording, HotkeyAction::RestartRecording]
        );
        assert_eq!(
            actions_for(&bindings, pause.id()),
            vec![HotkeyAction::TogglePauseRecording]
        );
    }

    /// GNOME answers an approved bind with `ShortcutsChanged` carrying the
    /// same shortcut; 0.6.1 treated that as a lost Stop control and blocked
    /// every Wayland recording on GNOME 50.
    #[test]
    fn shortcuts_changed_after_bind_keeps_the_stop_control() {
        let id = "cap-recording-stop-1";
        assert_eq!(
            shortcut_change([(id, "Shift+Ctrl+F9")], id),
            ShortcutChange::Relabel("Shift+Ctrl+F9".into())
        );
        assert_eq!(shortcut_change([(id, "  ")], id), ShortcutChange::Unchanged);
        assert_eq!(shortcut_change([], id), ShortcutChange::Unchanged);
        assert_eq!(
            shortcut_change([("cap-recording-stop-0", "F9")], id),
            ShortcutChange::Removed
        );
        assert_eq!(
            shortcut_change([("other", "F8"), (id, "F9")], id),
            ShortcutChange::Relabel("F9".into())
        );
    }

    #[test]
    fn portal_trigger_descriptions_read_the_same_on_every_desktop() {
        assert_eq!(
            readable_trigger("Press <Shift><Control>F9"),
            "Shift+Ctrl+F9"
        );
        assert_eq!(readable_trigger("<Primary><Alt>r"), "Ctrl+Alt+r");
        assert_eq!(readable_trigger("Ctrl+Shift+F9"), "Ctrl+Shift+F9");
        assert_eq!(readable_trigger("  press F9 "), "F9");
        assert_eq!(readable_trigger("<Super"), "<Super");
        assert_eq!(readable_trigger("Pressure"), "Pressure");
    }

    /// Why the Tauri handler's ⌘, special case is not reproduced (see
    /// [`dispatch_id`]): registration rewrites META into SUPER, so its
    /// `mods == Modifiers::META` guard can never hold.
    #[test]
    fn registration_never_leaves_meta_in_the_modifiers() {
        let settings = HotKey::new(Some(Modifiers::META), Code::Comma);
        assert!(!settings.mods.contains(Modifiers::META));
        assert!(settings.mods.contains(Modifiers::SUPER));
    }
}
