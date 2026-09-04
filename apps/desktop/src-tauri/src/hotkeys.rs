use crate::{
    App, ArcLock, RequestOpenRecordingPicker, RequestStartRecording, recording,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    tray,
    windows::ShowCapWindow,
};
use cap_recording::feeds::microphone::MicrophoneFeed;
use cap_recording::screen_capture::ScreenCaptureTarget;
use global_hotkey::HotKeyState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_store::StoreExt;
use tauri_specta::Event;
use tracing::instrument;

#[derive(Serialize, Deserialize, Type, PartialEq, Clone, Copy, Debug)]
pub struct Hotkey {
    #[specta(type = String)]
    code: Code,
    meta: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

impl From<Hotkey> for Shortcut {
    fn from(hotkey: Hotkey) -> Self {
        let mut modifiers = Modifiers::empty();

        if hotkey.meta {
            modifiers |= Modifiers::META;
        }
        if hotkey.ctrl {
            modifiers |= Modifiers::CONTROL;
        }
        if hotkey.alt {
            modifiers |= Modifiers::ALT;
        }
        if hotkey.shift {
            modifiers |= Modifiers::SHIFT;
        }

        Shortcut::new(Some(modifiers), hotkey.code)
    }
}

#[derive(Serialize, Deserialize, Type, PartialEq, Eq, Hash, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)]
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
    #[serde(other)]
    Other,
}

#[derive(Serialize, Deserialize, Type, Default)]
pub struct HotkeysStore {
    hotkeys: HashMap<HotkeyAction, Hotkey>,
}

impl HotkeysStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let Ok(Some(store)) = app.store("store").map(|s| s.get("hotkeys")) else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
    }
}

#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct OnEscapePress;

pub type HotkeysState = Mutex<HotkeysStore>;

fn clean_capture_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F9)
}

#[cfg(any(target_os = "linux", test))]
fn existing_clean_capture_stop(store: &HotkeysStore) -> Result<bool, String> {
    let shortcut = clean_capture_shortcut();
    let mut existing_stop = false;
    for (action, hotkey) in &store.hotkeys {
        if Shortcut::from(*hotkey) == shortcut {
            if !matches!(action, HotkeyAction::StopRecording) {
                return Err("Ctrl+Shift+F9 is assigned to another Cap action. Change that shortcut before starting clean Studio capture.".into());
            }
            existing_stop = true;
        }
    }
    Ok(existing_stop)
}

#[cfg(target_os = "linux")]
pub(crate) fn reserve_clean_capture_stop(app: &AppHandle) -> Result<bool, String> {
    let shortcut = clean_capture_shortcut();
    let state = app.state::<HotkeysState>();
    let store = state.lock().unwrap();
    let existing_stop = existing_clean_capture_stop(&store)?;
    let shortcuts = app.global_shortcut();
    if shortcuts.is_registered(shortcut) {
        return if existing_stop {
            Ok(false)
        } else {
            Err("Ctrl+Shift+F9 is already reserved. Release it before starting clean Studio capture.".into())
        };
    }
    shortcuts.register(shortcut).map_err(|error| {
        format!("Cannot reserve Ctrl+Shift+F9 to stop recording: {error}. Change the conflicting system shortcut and try again.")
    })?;
    Ok(true)
}

pub(crate) fn release_clean_capture_stop(app: &AppHandle, owned: bool) {
    if owned && let Err(error) = app.global_shortcut().unregister(clean_capture_shortcut()) {
        tracing::warn!(%error, "Could not release temporary recording shortcut");
    }
}

const RECORDING_START_SAFETY_STORE_KEY: &str = "recording_start_safety";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RecordingStartSafetySettings {
    confirm_before_recording_without_microphone: bool,
}

impl Default for RecordingStartSafetySettings {
    fn default() -> Self {
        Self {
            confirm_before_recording_without_microphone: true,
        }
    }
}

fn should_confirm_without_microphone(enabled: bool, microphone_available: bool) -> bool {
    enabled && !microphone_available
}

#[cfg(any(target_os = "macos", test))]
fn microphone_available_for_confirmation(
    name: Option<&str>,
    permission: impl FnOnce() -> Result<(), String>,
    contains: impl FnOnce(&str) -> bool,
) -> Result<bool, String> {
    let Some(name) = name else {
        return Ok(false);
    };
    permission().map_err(|error| {
        format!("{error} To record without a microphone, turn the microphone Off in Cap.")
    })?;
    if !contains(name) {
        return Err(format!(
            "Selected microphone '{name}' is no longer available. Reconnect it, select another microphone, or turn the microphone Off to record without it."
        ));
    }
    Ok(true)
}

fn should_confirm_direct_recording(app: &AppHandle) -> Result<bool, String> {
    let enabled = app
        .store("store")
        .ok()
        .and_then(|store| store.get(RECORDING_START_SAFETY_STORE_KEY))
        .and_then(|value| serde_json::from_value::<RecordingStartSafetySettings>(value).ok())
        .unwrap_or_default()
        .confirm_before_recording_without_microphone;

    #[cfg(not(target_os = "macos"))]
    if !enabled {
        return Ok(false);
    }

    let microphone_name = RecordingSettingsStore::get(app)
        .ok()
        .flatten()
        .and_then(|settings| settings.mic_name);
    #[cfg(target_os = "macos")]
    let microphone_available = microphone_available_for_confirmation(
        microphone_name.as_deref(),
        crate::permissions::check_microphone_access,
        |name| {
            MicrophoneFeed::list_names()
                .iter()
                .any(|device| device == name)
        },
    )?;
    #[cfg(not(target_os = "macos"))]
    let microphone_available = microphone_name
        .as_deref()
        .is_some_and(|name| MicrophoneFeed::list().contains_key(name));

    Ok(should_confirm_without_microphone(
        enabled,
        microphone_available,
    ))
}

async fn confirm_direct_recording_without_microphone(app: &AppHandle) -> bool {
    match should_confirm_direct_recording(app) {
        Ok(false) => return true,
        Ok(true) => {}
        Err(message) => {
            app.dialog()
                .message(message)
                .title("Microphone unavailable")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::Ok)
                .show(|_| {});
            return false;
        }
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message("This recording will not include your voice.")
        .title("No microphone detected")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Record without microphone".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });

    receiver.await.unwrap_or(false)
}

async fn start_recording_from_hotkey(
    app: AppHandle,
    mode: cap_recording::RecordingMode,
) -> Result<(), String> {
    if app
        .state::<ArcLock<App>>()
        .read()
        .await
        .is_recording_active_or_pending()
    {
        let _ = RequestStartRecording { mode }.emit(&app);
        return Ok(());
    }

    if confirm_direct_recording_without_microphone(&app).await {
        let _ = RequestStartRecording { mode }.emit(&app);
    }

    Ok(())
}

fn spawn_shortcut_task<F>(task: F)
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    drop(tauri::async_runtime::spawn(task));
}

pub fn init(app: &AppHandle) {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if *shortcut == clean_capture_shortcut()
                    && crate::clean_capture::handle_shortcut(
                        app,
                        event.state() == HotKeyState::Pressed,
                    )
                {
                    return;
                }
                if !matches!(event.state(), HotKeyState::Pressed) {
                    return;
                }

                if shortcut.key == Code::Escape {
                    OnEscapePress.emit(app).ok();
                }

                if shortcut.key == Code::Comma && shortcut.mods == Modifiers::META {
                    let app = app.clone();
                    spawn_shortcut_task(async move {
                        let _ = ShowCapWindow::Settings { page: None }.show(&app).await;
                    });
                }

                let state = app.state::<HotkeysState>();
                let store = state.lock().unwrap();

                for (action, hotkey) in &store.hotkeys {
                    if &Shortcut::from(*hotkey) == shortcut {
                        spawn_shortcut_task(handle_hotkey(app.clone(), *action));
                    }
                }
            })
            .build(),
    )
    .unwrap();

    let store = match HotkeysStore::get(app) {
        Ok(Some(s)) => s,
        Ok(None) => HotkeysStore::default(),
        Err(e) => {
            eprintln!("Failed to load hotkeys store: {e}");
            HotkeysStore::default()
        }
    };

    let global_shortcut = app.global_shortcut();
    for hotkey in store.hotkeys.values() {
        global_shortcut.register(Shortcut::from(*hotkey)).ok();
    }

    app.manage(Mutex::new(store));
}

async fn handle_hotkey(app: AppHandle, action: HotkeyAction) -> Result<(), String> {
    match action {
        HotkeyAction::StartStudioRecording => {
            start_recording_from_hotkey(app, cap_recording::RecordingMode::Studio).await
        }
        HotkeyAction::StartInstantRecording => {
            start_recording_from_hotkey(app, cap_recording::RecordingMode::Instant).await
        }
        HotkeyAction::StopRecording => recording::stop_recording(app.clone(), app.state()).await,
        HotkeyAction::RestartRecording => recording::restart_recording(app.clone(), app.state())
            .await
            .map(|_| ()),
        HotkeyAction::TogglePauseRecording => {
            recording::toggle_pause_recording(app.clone(), app.state()).await
        }
        HotkeyAction::CycleRecordingMode => {
            let current = RecordingSettingsStore::get(&app)
                .ok()
                .flatten()
                .and_then(|s| s.mode)
                .unwrap_or_default();

            let next = match current {
                cap_recording::RecordingMode::Studio => cap_recording::RecordingMode::Instant,
                cap_recording::RecordingMode::Instant => cap_recording::RecordingMode::Screenshot,
                cap_recording::RecordingMode::Screenshot => cap_recording::RecordingMode::Studio,
            };

            RecordingSettingsStore::set_mode(&app, next)
                .map_err(|e| format!("Failed to cycle mode: {e}"))?;

            tray::update_tray_icon_for_mode(&app, next);

            Ok(())
        }
        HotkeyAction::OpenRecordingPicker => {
            let _ = RequestOpenRecordingPicker { target_mode: None }.emit(&app);
            Ok(())
        }
        HotkeyAction::OpenRecordingPickerDisplay => {
            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Display),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::OpenRecordingPickerWindow => {
            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Window),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::OpenRecordingPickerArea => {
            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Area),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::ScreenshotDisplay => {
            use scap_targets::Display;

            let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
            let target = ScreenCaptureTarget::Display { id: display.id() };

            match recording::take_screenshot(app.clone(), target.clone()).await {
                Ok(path) => {
                    if crate::automation::should_open_screenshot_editor(&app, &target) {
                        let _ = ShowCapWindow::ScreenshotEditor { path }.show(&app).await;
                    }
                    Ok(())
                }
                Err(e) => Err(format!("Failed to take screenshot: {e}")),
            }
        }
        HotkeyAction::ScreenshotWindow => {
            use scap_targets::Window;

            let target = {
                let window = Window::get_topmost_at_cursor()
                    .ok_or_else(|| "No window found under cursor".to_string())?;
                ScreenCaptureTarget::Window { id: window.id() }
            };

            match recording::take_screenshot(app.clone(), target.clone()).await {
                Ok(path) => {
                    if crate::automation::should_open_screenshot_editor(&app, &target) {
                        let _ = ShowCapWindow::ScreenshotEditor { path }.show(&app).await;
                    }
                    Ok(())
                }
                Err(e) => Err(format!("Failed to take screenshot: {e}")),
            }
        }
        HotkeyAction::ScreenshotArea => {
            RecordingSettingsStore::set_mode(&app, cap_recording::RecordingMode::Screenshot)
                .map_err(|e| format!("Failed to set screenshot mode: {e}"))?;

            tray::update_tray_icon_for_mode(&app, cap_recording::RecordingMode::Screenshot);

            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Area),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::Other => Ok(()),
    }
}

#[tauri::command(async)]
#[specta::specta]
#[instrument(skip(app))]
pub fn set_hotkey(app: AppHandle, action: HotkeyAction, hotkey: Option<Hotkey>) -> Result<(), ()> {
    let global_shortcut = app.global_shortcut();
    let state = app.state::<HotkeysState>();
    let mut store = state.lock().unwrap();
    if crate::clean_capture::phase(&app).is_some() {
        return Err(());
    }

    let prev = store.hotkeys.get(&action).cloned();

    if let Some(hotkey) = hotkey {
        store.hotkeys.insert(action, hotkey);
    } else {
        store.hotkeys.remove(&action);
    }

    if let Some(prev) = prev
        && !store.hotkeys.values().any(|h| h == &prev)
    {
        global_shortcut.unregister(Shortcut::from(prev)).ok();
    }

    if let Some(hotkey) = hotkey {
        global_shortcut.register(Shortcut::from(hotkey)).ok();
    }

    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) struct WaylandStop {
    generation: u32,
    cancel: tokio::sync::watch::Sender<bool>,
    task: Option<tauri::async_runtime::JoinHandle<Result<(), String>>>,
    completed: Option<Result<(), String>>,
}

#[cfg(target_os = "linux")]
pub(crate) async fn reserve_wayland_stop(app: &AppHandle, generation: u32) -> Result<(), String> {
    let state = app.state::<crate::clean_capture::State>();
    let mut owned = state.portal_stop.lock().await;
    if owned.is_some() {
        return Err("Previous Wayland Stop session has not closed".into());
    }
    let (cancel, receiver) = tokio::sync::watch::channel(false);
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        if run_wayland_tray(&handle, generation, receiver.clone()).await? {
            Ok(())
        } else {
            run_wayland_stop(&handle, generation, receiver).await
        }
    });
    *owned = Some(WaylandStop {
        generation,
        cancel,
        task: Some(task),
        completed: None,
    });
    Ok(())
}

#[cfg(target_os = "linux")]
async fn run_wayland_stop(
    app: &AppHandle,
    generation: u32,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
    use futures::StreamExt;
    let portal = tokio::select! {
        _ = cancel.changed() => return Ok(()),
        result = GlobalShortcuts::new() => match result {
            Ok(portal) => portal,
            Err(error) => { report_wayland_stop_loss(app, generation, &error.to_string()); return Ok(()); }
        },
    };
    if *cancel.borrow() {
        return Ok(());
    }
    // Keep session creation owned even if Stop arrives while the portal replies;
    // dropping CreateSession could lose the only handle needed to close it.
    let session = match portal.create_session().await {
        Ok(session) => session,
        Err(error) => {
            report_wayland_stop_loss(app, generation, &error.to_string());
            return Ok(());
        }
    };
    let result = async {
        let session_path = serde_json::to_value(&session).map_err(|error| error.to_string())?;
        let session_path = session_path
            .as_str()
            .ok_or("Invalid Stop session identity")?;
        let id = format!("cap-clean-stop-{generation}");
        let mut activated = portal
            .receive_activated()
            .await
            .map_err(|error| error.to_string())?;
        let mut deactivated = portal
            .receive_deactivated()
            .await
            .map_err(|error| error.to_string())?;
        let mut closed = session
            .receive_closed()
            .await
            .map_err(|error| error.to_string())?;
        let bound = portal
            .bind_shortcuts(
                &session,
                &[NewShortcut::new(&id, "Start or stop Cap clean recording")
                    .preferred_trigger(Some("CTRL+SHIFT+F9"))],
                None,
            )
            .await
            .map_err(|error| error.to_string())?
            .response()
            .map_err(|error| error.to_string())?;
        let shortcut = bound
            .shortcuts()
            .iter()
            .find(|shortcut| shortcut.id() == id)
            .ok_or("Stop shortcut was not granted")?;
        crate::clean_capture::describe_wayland_stop(
            app,
            generation,
            format!("{} (desktop shortcut)", shortcut.trigger_description()),
        );
        loop {
            tokio::select! {
                event = activated.next() => match event {
                    Some(event) if event.session_handle().as_str() == session_path && event.shortcut_id() == id => {
                        crate::clean_capture::handle_wayland_stop(app, generation, crate::clean_capture::StopRoute::Portal, true);
                    }
                    Some(_) => {}
                    None => return Err("Stop shortcut event stream closed".into()),
                },
                event = deactivated.next() => match event {
                    Some(event) if event.session_handle().as_str() == session_path && event.shortcut_id() == id => {
                        crate::clean_capture::handle_wayland_stop(app, generation, crate::clean_capture::StopRoute::Portal, false);
                    }
                    Some(_) => {}
                    None => return Err("Stop shortcut event stream closed".into()),
                },
                _ = closed.next() => return Err("Stop shortcut session was revoked".into()),
            }
        }
    };
    let result: Result<(), String> = if *cancel.borrow() {
        Ok(())
    } else {
        tokio::select! {
            _ = cancel.changed() => Ok(()),
            result = result => result,
        }
    };
    if let Err(error) = &result {
        report_wayland_stop_loss(app, generation, error);
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), session.close())
        .await
        .map_err(|_| "Stop session close timed out".to_string())?
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn report_wayland_stop_loss(app: &AppHandle, generation: u32, error: &str) {
    crate::clean_capture::wayland_stop_lost(
        app,
        generation,
        crate::clean_capture::StopRoute::Portal,
        error.to_string(),
    );
}

#[cfg(target_os = "linux")]
pub(crate) async fn release_wayland_stop(app: &AppHandle, generation: u32) -> Result<(), String> {
    let state = app.state::<crate::clean_capture::State>();
    let mut owned = state.portal_stop.lock().await;
    let Some(stop) = owned.as_mut().filter(|stop| stop.generation == generation) else {
        return Ok(());
    };
    if let Some(result) = &stop.completed {
        return result.clone();
    }
    let _ = stop.cancel.send(true);
    let task = stop
        .task
        .as_mut()
        .ok_or("Stop session worker ownership was lost")?;
    let joined = tokio::time::timeout(std::time::Duration::from_secs(3), task)
        .await
        .map_err(|_| "Stop session worker has not joined".to_string())?;
    let _finished = stop.task.take();
    let result = joined
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    stop.completed = Some(result.clone());
    if result.is_ok() {
        let _released = owned.take();
    }
    result
}

#[cfg(target_os = "linux")]
async fn run_wayland_tray(
    app: &AppHandle,
    generation: u32,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<bool, String> {
    use cap_utils::linux_recording_stop::{StopTray, StopTrayEvent};
    let icon = match crate::tray::clean_stop_icon() {
        Ok(icon) => icon,
        Err(error) => {
            crate::clean_capture::wayland_stop_lost(
                app,
                generation,
                crate::clean_capture::StopRoute::Tray,
                error,
            );
            return Ok(false);
        }
    };
    let tray = match StopTray::open(u64::from(generation), icon).await {
        Ok(tray) => tray,
        Err(error) => {
            let can_fallback = error.can_fallback();
            let message = error.to_string();
            crate::clean_capture::wayland_stop_lost(
                app,
                generation,
                crate::clean_capture::StopRoute::Tray,
                message.clone(),
            );
            if !can_fallback {
                crate::clean_capture::wayland_stop_lost(
                    app,
                    generation,
                    crate::clean_capture::StopRoute::Portal,
                    message.clone(),
                );
                return Err(message);
            }
            return Ok(false);
        }
    };
    let events = tray.events();
    let mut used = false;
    let mut cancelled = false;
    loop {
        tokio::select! {
            _ = cancel.changed() => { cancelled = true; break; },
            event = events.recv_async() => match event {
                Ok(StopTrayEvent::Activated { generation: received }) if received == u64::from(generation) => {
                    used = true;
                    crate::clean_capture::handle_wayland_stop(app, generation, crate::clean_capture::StopRoute::Tray, true);
                    crate::clean_capture::handle_wayland_stop(app, generation, crate::clean_capture::StopRoute::Tray, false);
                }
                Ok(StopTrayEvent::Unavailable { generation: received }) if received == u64::from(generation) => {
                    crate::clean_capture::wayland_stop_lost(app, generation, crate::clean_capture::StopRoute::Tray, "The Stop tray host is unavailable".into());
                    break;
                }
                Ok(_) => {}
                Err(_) => {
                    crate::clean_capture::wayland_stop_lost(app, generation, crate::clean_capture::StopRoute::Tray, "The Stop tray event stream closed".into());
                    break;
                }
            }
        }
    }
    tray.close().await?;
    Ok(used || cancelled)
}

#[cfg(test)]
mod tests {
    use super::{
        microphone_available_for_confirmation, should_confirm_without_microphone,
        spawn_shortcut_task,
    };
    use std::time::Duration;

    #[test]
    fn microphone_confirmation_does_not_probe_without_permission_or_selection() {
        assert!(
            microphone_available_for_confirmation(
                Some("Saved microphone"),
                || Err("Permission denied".into()),
                |_| panic!("denied microphone must not be enumerated"),
            )
            .unwrap_err()
            .contains("turn the microphone Off")
        );
        assert!(
            !microphone_available_for_confirmation(
                None,
                || panic!("disabled microphone does not need permission"),
                |_| panic!("disabled microphone must not be enumerated"),
            )
            .unwrap()
        );
    }

    #[test]
    fn microphone_confirmation_checks_only_the_requested_name_after_grant() {
        assert!(
            microphone_available_for_confirmation(
                Some("Saved microphone"),
                || Ok(()),
                |name| name == "Saved microphone",
            )
            .unwrap()
        );
        let error = microphone_available_for_confirmation(
            Some("Disconnected microphone"),
            || Ok(()),
            |_| false,
        )
        .unwrap_err();
        assert!(error.contains("Reconnect it"));
        assert!(error.contains("turn the microphone Off"));
    }

    #[test]
    fn clean_capture_reuses_only_an_existing_stop_binding() {
        let hotkey = super::Hotkey {
            code: super::Code::F9,
            meta: false,
            ctrl: true,
            alt: false,
            shift: true,
        };
        let mut store = super::HotkeysStore::default();
        assert!(!super::existing_clean_capture_stop(&store).unwrap());
        store
            .hotkeys
            .insert(super::HotkeyAction::StopRecording, hotkey);
        assert!(super::existing_clean_capture_stop(&store).unwrap());
        store
            .hotkeys
            .insert(super::HotkeyAction::StartStudioRecording, hotkey);
        assert!(super::existing_clean_capture_stop(&store).is_err());
    }

    #[test]
    fn shortcut_dispatch_runs_from_thread_without_tokio_runtime() {
        let (sent, received) = std::sync::mpsc::channel();
        let caller = std::thread::spawn(move || {
            assert!(tokio::runtime::Handle::try_current().is_err());
            let caller_id = std::thread::current().id();
            spawn_shortcut_task(async move {
                assert!(tokio::runtime::Handle::try_current().is_ok());
                tokio::time::sleep(Duration::from_millis(1)).await;
                sent.send((caller_id, std::thread::current().id())).unwrap();
                Ok::<(), String>(())
            });
        });
        caller.join().expect("OS callback thread must not panic");
        let (caller_id, task_id) = received
            .recv_timeout(Duration::from_secs(2))
            .expect("Shortcut action must run on the application runtime");
        assert_ne!(caller_id, task_id);
    }

    #[test]
    fn shortcut_dispatch_keeps_detached_settings_task_alive() {
        let (sent, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            assert!(tokio::runtime::Handle::try_current().is_err());
            spawn_shortcut_task(async move {
                tokio::time::sleep(Duration::from_millis(1)).await;
                sent.send(()).unwrap();
            });
        })
        .join()
        .expect("OS callback thread must not panic");
        received
            .recv_timeout(Duration::from_secs(2))
            .expect("Detached settings task must complete");
    }

    #[test]
    fn confirms_when_enabled_without_microphone() {
        assert!(should_confirm_without_microphone(true, false));
    }

    #[test]
    fn skips_confirmation_with_selected_microphone() {
        assert!(!should_confirm_without_microphone(true, true));
    }

    #[test]
    fn skips_confirmation_when_disabled() {
        assert!(!should_confirm_without_microphone(false, false));
    }
}
