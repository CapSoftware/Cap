//! `cap-desktop://` deep-link actions -- the gpui port of
//! `apps/desktop/src-tauri/src/deeplink_actions.rs`.
//!
//! The URL grammar is byte-identical to the Tauri app's: an action deep link
//! is `<scheme>://action?value=<url-encoded JSON>`, where the JSON is the
//! serde form of [`DeepLinkAction`] (externally tagged, `snake_case` variant
//! names). The scheme itself is deliberately not checked -- the Tauri parser
//! (`deeplink_actions.rs:155-183`) discriminates on the *host* alone, so
//! `cap-desktop://` and `cap://` both work, and any URL whose host is not
//! `action` is either "not ours" ([`ActionParseFromUrlError::NotAction`], the
//! login callback's host is `auth`) or malformed. No URL is ever *built* from
//! these parts, so the userinfo/port authority-injection class that bit the
//! web session endpoint (2026-08, the `port=pwn@evil.example` takeover) has no
//! sink here -- but the host match is still exact, never a substring, and every
//! parse failure is a dropped action, never a panic: this input arrives
//! straight from the OS on behalf of whatever wrote the URL.
//!
//! Delivery, and how it maps onto the Tauri app's two paths:
//!
//! * **App already running.** Tauri receives the URL through
//!   `tauri_plugin_deep_link`'s `on_open_url` (`lib.rs:5601-5603`); on macOS
//!   that plugin is a GURL AppleEvent handler, and this app installs its own in
//!   [`crate::platform::install_url_scheme_handler`], which forwards every URL
//!   to [`submit_deep_link`]. A URL opened while the app runs never spawns a
//!   second instance on macOS -- the AppleEvent goes to the running process.
//! * **App launched by the URL.** Tauri's single-instance plugin hands the new
//!   launch's `cap-desktop://` argv to the surviving old instance
//!   (`lib.rs:5193-5204`). This app's single instancing is new-instance-wins
//!   (see [`crate::single_instance`]), so the launch that carries the URL *is*
//!   the instance that survives: [`init`] reads its own argv. On macOS the
//!   launch URL additionally arrives as the same GURL event once the run loop
//!   starts; both roads feed one channel, and the channel buffers until the
//!   drain task exists, so neither ordering loses the action.
//!
//! Execution mirrors `DeepLinkActionExecutor` (`deeplink_actions.rs:69-105`):
//! a single queue, actions run strictly in arrival order. Over there the
//! consumer is a dedicated thread `block_on`-ing each action; here it is one
//! foreground task draining into `cx.update`, the same channel discipline the
//! tray and the global hotkeys use.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use cap_recording::feeds::camera::DeviceOrModelID;
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::App;
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::{
    app_windows,
    feeds::{Feeds, SelectedCamera},
    library, recording,
    session::RecordingSession,
    settings_window::Page,
};

/// `CaptureArea` (`deeplink_actions.rs:18-25`). Debug-gated exactly as it is
/// over there: area capture via deep link is a harness affordance, not a
/// shipping surface.
#[cfg(debug_assertions)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CaptureArea {
    screen: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// `CaptureMode` (`deeplink_actions.rs:27-36`): the screen and window are
/// addressed by *name*, resolved against the live target lists at execution
/// time, matching the Tauri lookup verbatim.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
    #[cfg(debug_assertions)]
    Area(Box<CaptureArea>),
    #[cfg(debug_assertions)]
    CameraOnly,
}

/// `CameraPreviewShape` (`src-tauri/src/camera.rs:161-168`), mirrored here so
/// the debug `set_camera_preview_state` payload deserializes identically.
#[cfg(debug_assertions)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewShape {
    #[default]
    Round,
    Square,
    Full,
}

/// `CameraPreviewState` (`src-tauri/src/camera.rs:170-177`). `background_blur`
/// keeps its `#[serde(default)]` and its `cap_project` type, so the accepted
/// JSON is the Tauri app's exactly.
#[cfg(debug_assertions)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CameraPreviewState {
    pub size: f32,
    pub shape: CameraPreviewShape,
    pub mirrored: bool,
    #[serde(default)]
    pub background_blur: cap_project::BackgroundBlurMode,
}

/// `DeepLinkAction` (`deeplink_actions.rs:38-67`), variant for variant,
/// including which ones exist only under `debug_assertions`. `mode` uses
/// `cap_recording::RecordingMode` -- the exact type the Tauri enum embeds --
/// so `"studio"`/`"instant"`/`"screenshot"` all *parse*; the screenshot case
/// is then refused at execution with the Tauri app's own error (its
/// `start_recording` returns "Use take_screenshot for screenshots",
/// `src-tauri/src/recording.rs:1699-1704`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DeepLinkAction {
    StartRecording {
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: cap_recording::RecordingMode,
    },
    StopRecording,
    #[cfg(debug_assertions)]
    PauseRecording,
    #[cfg(debug_assertions)]
    ResumeRecording,
    #[cfg(debug_assertions)]
    OpenCamera {
        camera: DeviceOrModelID,
    },
    #[cfg(debug_assertions)]
    SetCameraPreviewState {
        state: CameraPreviewState,
    },
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
}

/// `ActionParseFromUrlError` (`deeplink_actions.rs:148-153`).
#[derive(Debug, PartialEq, Eq)]
pub enum ActionParseFromUrlError {
    ParseFailed(String),
    Invalid,
    NotAction,
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = ActionParseFromUrlError;

    /// `deeplink_actions.rs:158-182`, verbatim. The `file://` branch is the
    /// macOS "open with Cap" path; this binary registers no document types so
    /// only tests reach it today, but the grammar stays whole.
    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        #[cfg(target_os = "macos")]
        if url.scheme() == "file" {
            return url
                .to_file_path()
                .map(|project_path| Self::OpenEditor { project_path })
                .map_err(|_| ActionParseFromUrlError::Invalid);
        }

        match url.domain() {
            Some("action") => {}
            Some(_) => return Err(ActionParseFromUrlError::NotAction),
            None => return Err(ActionParseFromUrlError::Invalid),
        }

        let params = url.query_pairs().collect::<HashMap<_, _>>();
        let json_value = params
            .get("value")
            .ok_or(ActionParseFromUrlError::Invalid)?;
        let action: Self = serde_json::from_str(json_value)
            .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))?;
        Ok(action)
    }
}

/// The action queue. Unbounded and created on first touch, so URLs submitted
/// before [`init`] runs (the launch AppleEvent, argv) wait for the drain task
/// instead of being dropped -- the buffering the Tauri app gets from its
/// executor being managed before `on_open_url` is wired.
fn channel() -> &'static (
    flume::Sender<DeepLinkAction>,
    flume::Receiver<DeepLinkAction>,
) {
    static CHANNEL: OnceLock<(
        flume::Sender<DeepLinkAction>,
        flume::Receiver<DeepLinkAction>,
    )> = OnceLock::new();
    CHANNEL.get_or_init(flume::unbounded)
}

/// The one entry point for a URL handed over by the OS -- what
/// `platform::install_url_scheme_handler`'s AppleEvent handler calls. Safe
/// from any thread; does no gpui work itself.
///
/// Every URL is first forwarded to the sign-in flow ([`crate::auth`]), whose
/// slot only exists during an active sign-in and filters for its own
/// `token`/`api_key` parameters -- the pre-existing behavior of the handler,
/// unchanged. Action parsing happens on top.
pub fn submit_deep_link(raw: &str) {
    crate::auth::submit_deep_link(raw);
    submit_action_url(raw);
}

/// Parse-and-queue half of [`submit_deep_link`]; also the argv path in
/// [`init`], which skips the auth forward because `main` already routes
/// token-bearing arguments there.
///
/// Error reporting mirrors `deeplink_actions::handle`
/// (`deeplink_actions.rs:107-133`) with one deliberate deviation: the failed
/// URL's *content* is never logged, only its shape -- an auth callback that
/// lands in the `Invalid` arm must not write its token into the log.
fn submit_action_url(raw: &str) {
    if raw.is_empty() {
        return;
    }
    let Ok(url) = Url::parse(raw) else {
        tracing::debug!("deep link is not a URL; ignored");
        return;
    };
    match DeepLinkAction::try_from(&url) {
        Ok(action) => {
            tracing::info!(?action, "queueing deep link action");
            if let Err(error) = channel().0.send(action) {
                tracing::error!(%error, "failed to queue deep link action");
            }
        }
        Err(ActionParseFromUrlError::ParseFailed(message)) => {
            tracing::error!(
                scheme = url.scheme(),
                host = url.host_str().unwrap_or_default(),
                %message,
                "failed to parse deep link action"
            );
        }
        Err(ActionParseFromUrlError::Invalid) => {
            tracing::error!(
                scheme = url.scheme(),
                host = url.host_str().unwrap_or_default(),
                "invalid deep link format"
            );
        }
        // Likely login action, not handled here -- the auth slot got it.
        Err(ActionParseFromUrlError::NotAction) => {}
    }
}

/// Wire the executor: scan the launch argv for action URLs (the
/// new-instance-wins counterpart of Tauri's single-instance argv forwarding,
/// `lib.rs:5195-5204`, which filters on the `cap-desktop://` prefix), then
/// start the drain task that runs each queued action on the main thread with
/// a clean borrow. Called once from [`crate::app_windows::init`], after the
/// window registry the actions dispatch into exists.
pub fn init(cx: &mut App) {
    for argument in std::env::args().skip(1) {
        if argument.starts_with("cap-desktop://") || argument.starts_with("cap://") {
            submit_action_url(&argument);
        }
    }

    let rx = channel().1.clone();
    cx.spawn(async move |cx| {
        while let Ok(action) = rx.recv_async().await {
            cx.update(|cx| {
                tracing::info!(?action, "executing deep link action");
                if let Err(error) = action.execute(cx) {
                    tracing::error!(%error, "failed to handle deep link action");
                }
            });
        }
    })
    .detach();
}

impl DeepLinkAction {
    /// `DeepLinkAction::execute` (`deeplink_actions.rs:186-296`), arm for arm,
    /// against this app's counterparts: the session and feeds globals where
    /// the Tauri arms call commands on `ArcLock<App>`, and
    /// [`crate::app_windows`] where they call `ShowCapWindow`.
    pub fn execute(self, cx: &mut App) -> Result<(), String> {
        match self {
            DeepLinkAction::StartRecording {
                capture_mode,
                camera,
                mic_label,
                capture_system_audio,
                mode,
            } => {
                // `set_camera_input` / `set_mic_input`: the deep link's devices
                // replace the current selections (including `None` clearing
                // them). `Feeds::set_camera` also opens/closes the preview
                // bubble, which is what `set_camera_input` does through the
                // camera preview over there.
                let selection = camera.clone().map(|id| SelectedCamera {
                    label: camera_label(&id),
                    id,
                });
                Feeds::global(cx).update(cx, |feeds, cx| {
                    feeds.set_camera(selection, cx);
                    feeds.set_microphone(mic_label.clone(), cx);
                });

                // The name -> target resolution, verbatim from
                // `deeplink_actions.rs:200-231`.
                let capture_target: ScreenCaptureTarget = match capture_mode {
                    CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
                        .into_iter()
                        .find(|(s, _)| s.name == name)
                        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                        .ok_or(format!("No screen with name \"{}\"", name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == name)
                        .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                        .ok_or(format!("No window with name \"{}\"", name))?,
                    #[cfg(debug_assertions)]
                    CaptureMode::Area(area) => {
                        if area.width <= 0.0 || area.height <= 0.0 {
                            return Err("Area width and height must be positive".to_string());
                        }
                        let screen = cap_recording::screen_capture::list_displays()
                            .into_iter()
                            .find(|(display, _)| display.name == area.screen)
                            .map(|(display, _)| display.id)
                            .ok_or(format!("No screen with name \"{}\"", area.screen))?;
                        ScreenCaptureTarget::Area {
                            screen,
                            bounds: scap_targets::bounds::LogicalBounds::new(
                                scap_targets::bounds::LogicalPosition::new(area.x, area.y),
                                scap_targets::bounds::LogicalSize::new(area.width, area.height),
                            ),
                        }
                    }
                    #[cfg(debug_assertions)]
                    CaptureMode::CameraOnly => ScreenCaptureTarget::CameraOnly,
                };

                let mode = match mode {
                    cap_recording::RecordingMode::Studio => recording::RecordingMode::Studio,
                    cap_recording::RecordingMode::Instant => recording::RecordingMode::Instant,
                    // The Tauri parser admits it and its `start_recording`
                    // refuses it (`recording.rs:1699-1704`); same split here.
                    cap_recording::RecordingMode::Screenshot => {
                        return Err("Use take_screenshot for screenshots".to_string());
                    }
                };

                // Deferred behind `set_camera`'s own deferred
                // `open_camera_window`, so a studio start finds the bubble
                // already open and excludes it from capture
                // (`begin_recording`'s `camera_window_number` read). gpui
                // flushes deferred callbacks in FIFO order.
                cx.defer(move |cx| {
                    let (camera_feed, mic_feed) = {
                        let feeds = Feeds::global(cx);
                        let feeds = feeds.read(cx);
                        (feeds.camera_actor(), feeds.mic_actor())
                    };
                    app_windows::begin_recording(
                        recording::StartConfig {
                            mode,
                            target: capture_target,
                            microphone: mic_label,
                            camera,
                            system_audio: capture_system_audio,
                            excluded_windows: Vec::new(),
                            camera_feed,
                            mic_feed,
                        },
                        cx,
                    );
                });
                Ok(())
            }
            // `recording::stop_recording`; the session's own phase guard is
            // the Tauri command's "no recording in progress" early-out.
            DeepLinkAction::StopRecording => {
                RecordingSession::global(cx).update(cx, |session, cx| session.stop(cx));
                Ok(())
            }
            // `pause_recording` / `resume_recording`
            // (`src-tauri/src/recording.rs:2421-2444`) are directional and
            // no-ops without a live recording; the session only exposes the
            // bar's toggle, so the direction is enforced here.
            #[cfg(debug_assertions)]
            DeepLinkAction::PauseRecording => {
                RecordingSession::global(cx).update(cx, |session, cx| {
                    if matches!(
                        session.phase,
                        crate::session::Phase::Recording { paused: false }
                    ) {
                        session.toggle_pause(cx);
                    }
                });
                Ok(())
            }
            #[cfg(debug_assertions)]
            DeepLinkAction::ResumeRecording => {
                RecordingSession::global(cx).update(cx, |session, cx| {
                    if session.is_paused() {
                        session.toggle_pause(cx);
                    }
                });
                Ok(())
            }
            // `set_camera_input(Some)` + the native preview: `Feeds::set_camera`
            // is both halves here -- the gpui camera window *is* the native
            // preview, and `set_camera` opens it. The
            // `instant-mode-harness-camera-opened` emits are webview harness
            // signals with no consumer in this app.
            #[cfg(debug_assertions)]
            DeepLinkAction::OpenCamera { camera } => {
                let selection = SelectedCamera {
                    label: camera_label(&camera),
                    id: camera,
                };
                Feeds::global(cx).update(cx, |feeds, cx| feeds.set_camera(Some(selection), cx));
                Ok(())
            }
            // `set_camera_preview_state`: persist the state, then bounce the
            // bubble if it is up -- the gpui camera window reads its chrome
            // state at construction (`CameraWindow::new`), so a reopen is the
            // live-apply seam.
            #[cfg(debug_assertions)]
            DeepLinkAction::SetCameraPreviewState { state } => {
                let shape = match state.shape {
                    CameraPreviewShape::Round => crate::store::CameraShape::Round,
                    CameraPreviewShape::Square => crate::store::CameraShape::Square,
                    CameraPreviewShape::Full => crate::store::CameraShape::Full,
                };
                let background_blur = match state.background_blur {
                    cap_project::BackgroundBlurMode::Off => crate::store::BlurMode::Off,
                    cap_project::BackgroundBlurMode::Light => crate::store::BlurMode::Light,
                    cap_project::BackgroundBlurMode::Heavy => crate::store::BlurMode::Heavy,
                };
                crate::store::update(|persisted| {
                    persisted.camera_window = Some(crate::store::CameraWindowState {
                        size: state.size,
                        shape,
                        mirrored: state.mirrored,
                        background_blur,
                    });
                });
                if cx.global::<app_windows::AppWindows>().camera.is_some() {
                    app_windows::close_camera_window(cx);
                    app_windows::open_camera_window(cx);
                }
                Ok(())
            }
            // `open_project_from_path` (`src-tauri/src/lib.rs:6877-6907`):
            // studio bundles go to the editor after the status gate, instant
            // bundles open their mp4 in the system player and hide the main
            // window. The meta load is also the validation seam for this
            // OS-supplied path -- anything that is not a readable `.cap`
            // bundle fails here and opens nothing.
            DeepLinkAction::OpenEditor { project_path } => {
                use cap_project::{RecordingMeta, RecordingMetaInner, StudioRecordingStatus};

                let meta =
                    RecordingMeta::load_for_project(&project_path).map_err(|v| v.to_string())?;
                match &meta.inner {
                    RecordingMetaInner::Studio(studio) => {
                        let status = studio.status();
                        if let StudioRecordingStatus::Failed { .. } = status {
                            return Err("Unable to open failed recording".to_string());
                        } else if let StudioRecordingStatus::InProgress = status {
                            return Err("Recording in progress".to_string());
                        }
                        // Deferred like `activate_recent`: `open_editor` opens
                        // a window, which must not happen from inside an
                        // entity update.
                        cx.defer(move |cx| app_windows::open_editor(project_path, cx));
                    }
                    RecordingMetaInner::Instant(_) => {
                        let mp4_path = project_path.join("content/output.mp4");
                        if mp4_path.exists() && mp4_path.is_file() {
                            library::open_path(&mp4_path);
                            app_windows::hide_main_window(cx);
                        }
                    }
                }
                Ok(())
            }
            // `ShowCapWindow::Settings { page }`. The Tauri window navigates
            // to `/settings/{page}` and an unknown slug is a dead route; here
            // an unknown (or absent) slug lands on General, the settings
            // window's own default.
            DeepLinkAction::OpenSettings { page } => {
                let page = page
                    .as_deref()
                    .and_then(Page::from_slug)
                    .unwrap_or(Page::General);
                app_windows::open_settings(page, cx);
                Ok(())
            }
        }
    }
}

/// The display label for a deep-linked camera id. The Tauri action carries no
/// label (its command takes the bare `DeviceOrModelID`); this app's
/// [`SelectedCamera`] wants one for the pickers, so it is resolved against the
/// same enumeration `devices.rs` lists from, falling back to the raw device id
/// for a device that is not currently attached.
fn camera_label(id: &DeviceOrModelID) -> String {
    cap_camera::list_cameras()
        .find(|info| match id {
            DeviceOrModelID::DeviceID(device_id) => info.device_id() == device_id.as_str(),
            DeviceOrModelID::ModelID(model) => info.model_id() == Some(model),
        })
        .map(|info| info.display_name().to_string())
        .unwrap_or_else(|| match id {
            DeviceOrModelID::DeviceID(device_id) => device_id.clone(),
            DeviceOrModelID::ModelID(_) => "Camera".to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- The Tauri parser's own tests (`deeplink_actions.rs:299-514`),
    // -- unchanged except for crate paths, so grammar drift fails loudly.

    #[test]
    fn parses_stop_recording_action_url() {
        let url = Url::parse("cap-desktop://action?value=%22stop_recording%22").unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::StopRecording)
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_open_camera_action_url() {
        let value = serde_json::json!({
            "open_camera": {
                "camera": { "DeviceID": "camera-1" }
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::OpenCamera {
                camera: DeviceOrModelID::DeviceID("camera-1".to_string())
            })
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_camera_preview_state_action_url() {
        let value = serde_json::json!({
            "set_camera_preview_state": {
                "state": {
                    "size": 400.0,
                    "shape": "full",
                    "mirrored": true,
                    "background_blur": "heavy"
                }
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::SetCameraPreviewState {
                state: CameraPreviewState {
                    size: 400.0,
                    shape: CameraPreviewShape::Full,
                    mirrored: true,
                    background_blur: cap_project::BackgroundBlurMode::Heavy,
                }
            })
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_pause_and_resume_action_urls() {
        let pause_url = Url::parse("cap-desktop://action?value=%22pause_recording%22").unwrap();
        let resume_url = Url::parse("cap-desktop://action?value=%22resume_recording%22").unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&pause_url),
            Ok(DeepLinkAction::PauseRecording)
        );
        assert_eq!(
            DeepLinkAction::try_from(&resume_url),
            Ok(DeepLinkAction::ResumeRecording)
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_area_recording_action_url() {
        let value = serde_json::json!({
            "start_recording": {
                "capture_mode": {
                    "area": {
                        "screen": "Built-in Retina Display",
                        "x": 10.0,
                        "y": 20.0,
                        "width": 800.0,
                        "height": 600.0
                    }
                },
                "camera": { "DeviceID": "camera-1" },
                "mic_label": "microphone-1",
                "capture_system_audio": false,
                "mode": "instant"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::StartRecording {
                capture_mode: CaptureMode::Area(Box::new(CaptureArea {
                    screen: "Built-in Retina Display".to_string(),
                    x: 10.0,
                    y: 20.0,
                    width: 800.0,
                    height: 600.0,
                })),
                camera: Some(DeviceOrModelID::DeviceID("camera-1".to_string())),
                mic_label: Some("microphone-1".to_string()),
                capture_system_audio: false,
                mode: cap_recording::RecordingMode::Instant,
            })
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_camera_only_recording_action_url() {
        let value = serde_json::json!({
            "start_recording": {
                "capture_mode": "camera_only",
                "camera": { "DeviceID": "camera-1" },
                "mic_label": "microphone-1",
                "capture_system_audio": false,
                "mode": "studio"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::StartRecording {
                capture_mode: CaptureMode::CameraOnly,
                camera: Some(DeviceOrModelID::DeviceID("camera-1".to_string())),
                mic_label: Some("microphone-1".to_string()),
                capture_system_audio: false,
                mode: cap_recording::RecordingMode::Studio,
            })
        );
    }

    #[test]
    fn parses_start_recording_action_url() {
        let url = Url::parse(
            "cap-desktop://action?value=%7B%22start_recording%22%3A%7B%22capture_mode%22%3A%7B%22screen%22%3A%22Odyssey%20G93SC%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3A%22Shure%20MV7%2B%22%2C%22capture_system_audio%22%3Atrue%2C%22mode%22%3A%22studio%22%7D%7D",
        )
        .unwrap();

        let Ok(DeepLinkAction::StartRecording {
            capture_mode,
            camera,
            mic_label,
            capture_system_audio,
            mode,
        }) = DeepLinkAction::try_from(&url)
        else {
            panic!("expected start recording action");
        };

        assert_eq!(
            capture_mode,
            CaptureMode::Screen("Odyssey G93SC".to_string())
        );
        assert_eq!(camera, None);
        assert_eq!(mic_label.as_deref(), Some("Shure MV7+"));
        assert!(capture_system_audio);
        assert_eq!(mode, cap_recording::RecordingMode::Studio);
    }

    #[test]
    fn parses_start_recording_action_with_camera_device_id() {
        let value = serde_json::json!({
            "start_recording": {
                "capture_mode": { "screen": "Odyssey G93SC" },
                "camera": { "DeviceID": "camera-1" },
                "mic_label": "Shure MV7+",
                "capture_system_audio": true,
                "mode": "studio"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        let Ok(DeepLinkAction::StartRecording {
            camera,
            mic_label,
            capture_system_audio,
            ..
        }) = DeepLinkAction::try_from(&url)
        else {
            panic!("expected start recording action");
        };

        assert_eq!(
            camera,
            Some(DeviceOrModelID::DeviceID("camera-1".to_string()))
        );
        assert_eq!(mic_label.as_deref(), Some("Shure MV7+"));
        assert!(capture_system_audio);
    }

    #[test]
    fn rejects_non_action_host() {
        let url = Url::parse("cap-desktop://login?value=%22stop_recording%22").unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::NotAction)
        );
    }

    // -- This port's own coverage: the editor/settings shapes the Tauri file
    // -- never wrote tests for, and hostile input.

    #[test]
    fn parses_open_editor_and_open_settings_urls() {
        let editor = serde_json::json!({
            "open_editor": { "project_path": "/tmp/My Recording.cap" }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", editor)]).unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::OpenEditor {
                project_path: PathBuf::from("/tmp/My Recording.cap"),
            })
        );

        let settings = serde_json::json!({ "open_settings": { "page": "hotkeys" } }).to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", settings)]).unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::OpenSettings {
                page: Some("hotkeys".to_string()),
            })
        );

        let settings = serde_json::json!({ "open_settings": { "page": null } }).to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", settings)]).unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::OpenSettings { page: None })
        );
    }

    /// Screenshot mode parses -- the type is `cap_recording::RecordingMode`,
    /// same as the Tauri enum -- and is refused later, at execution.
    #[test]
    fn parses_screenshot_mode() {
        let value = serde_json::json!({
            "start_recording": {
                "capture_mode": { "screen": "Display" },
                "camera": null,
                "mic_label": null,
                "capture_system_audio": false,
                "mode": "screenshot"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        let Ok(DeepLinkAction::StartRecording { mode, .. }) = DeepLinkAction::try_from(&url) else {
            panic!("expected start recording action");
        };
        assert_eq!(mode, cap_recording::RecordingMode::Screenshot);
    }

    /// Malformed shapes are all `Err`, never a panic: this parser eats
    /// whatever the OS relays.
    #[test]
    fn rejects_malformed_urls() {
        // No authority at all -> no domain -> Invalid.
        let url = Url::parse("cap-desktop:action?value=%22stop_recording%22").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::Invalid)
        );

        // Right host, no `value` parameter.
        let url = Url::parse("cap-desktop://action").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::Invalid)
        );

        // `value` present but empty / not JSON / unknown action.
        for value in ["", "not json", "\"unknown_action\"", "{}", "[1,2,3]"] {
            let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();
            assert!(
                matches!(
                    DeepLinkAction::try_from(&url),
                    Err(ActionParseFromUrlError::ParseFailed(_))
                ),
                "value {value:?} should fail to parse"
            );
        }

        // A known action with the wrong payload shape.
        let value = serde_json::json!({ "start_recording": { "capture_mode": 42 } }).to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();
        assert!(matches!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::ParseFailed(_))
        ));
    }

    /// Any host other than exactly `action` is not ours -- the host is
    /// compared whole, never substring-matched, so `action.evil.example`
    /// cannot smuggle an action in.
    #[test]
    fn rejects_foreign_hosts() {
        for hostile in [
            "cap-desktop://evil.example?value=%22stop_recording%22",
            "cap-desktop://action.evil.example?value=%22stop_recording%22",
            "cap-desktop://xaction?value=%22stop_recording%22",
        ] {
            let url = Url::parse(hostile).unwrap();
            assert_eq!(
                DeepLinkAction::try_from(&url),
                Err(ActionParseFromUrlError::NotAction),
                "{hostile} must not parse as an action"
            );
        }
    }

    /// The Tauri parser discriminates on `Url::domain()`, which ignores the
    /// authority's userinfo and port -- so `user@action:8080` still reads as
    /// host `action`. Reproduced (and pinned) rather than tightened: nothing
    /// here ever *builds* a URL from these parts, which is where the
    /// port-injection class lives, and diverging would break URLs the
    /// shipping app accepts.
    #[test]
    fn authority_decorations_match_tauri() {
        for accepted in [
            "cap-desktop://action:8080?value=%22stop_recording%22",
            "cap-desktop://user@action?value=%22stop_recording%22",
        ] {
            let url = Url::parse(accepted).unwrap();
            assert_eq!(
                DeepLinkAction::try_from(&url),
                Ok(DeepLinkAction::StopRecording),
                "{accepted} parses on the Tauri grammar"
            );
        }
    }

    /// A nesting bomb is an `Err`, not a crash: the enum deserializer rejects
    /// the wrong shape immediately, and serde_json's own recursion limit
    /// backstops anything that gets deeper. Pinned so a hand-rolled parser
    /// can never regress this into a stack overflow.
    #[test]
    fn hostile_json_does_not_panic() {
        let bomb = format!("{}{}", "[".repeat(400), "]".repeat(400));
        let url = Url::parse_with_params("cap-desktop://action", &[("value", bomb)]).unwrap();
        assert!(matches!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::ParseFailed(_))
        ));

        let nul = "\"stop_recording\u{0}\"";
        let url = Url::parse_with_params("cap-desktop://action", &[("value", nul)]).unwrap();
        assert!(DeepLinkAction::try_from(&url).is_err());
    }

    /// The macOS `file://` branch: a local path becomes `OpenEditor`; a
    /// remote-host file URL does not convert to a path and is rejected.
    #[cfg(target_os = "macos")]
    #[test]
    fn file_urls_open_the_editor() {
        let url = Url::parse("file:///tmp/My%20Recording.cap").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::OpenEditor {
                project_path: PathBuf::from("/tmp/My Recording.cap"),
            })
        );

        let url = Url::parse("file://evil.example/tmp/foo.cap").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::Invalid)
        );
    }
}
