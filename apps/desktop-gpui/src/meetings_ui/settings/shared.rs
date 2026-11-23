use std::time::Duration;

use cap_meetings::settings::{Engine, MeetingSettings};
use chrono::{DateTime, Utc};
use gpui::{AnyElement, App, Hsla, IntoElement, ParentElement, Styled, div, px, svg};

use crate::{
    editor_tabs::{CaptionModel, available_caption_models},
    i18n::tr,
    meetings::{CalendarError, CalendarSource, Meetings, SourceConfig, SyncErrorKind},
    theme::Theme,
    transcription::{self, DownloadState},
};

pub const DOWNLOAD_REPAINT: Duration = Duration::from_millis(250);
pub const PERMISSION_POLL: Duration = Duration::from_secs(1);
pub const LEAD_OPTIONS: [u32; 7] = [0, 30, 60, 120, 300, 600, 900];
pub const COUNTDOWN_OPTIONS: [u32; 3] = [3, 5, 10];
pub const SILENCE_OPTIONS: [Option<u32>; 5] = [None, Some(5), Some(10), Some(15), Some(30)];
pub const RETENTION_OPTIONS: [Option<u32>; 4] = [None, Some(7), Some(30), Some(90)];

#[cfg(debug_assertions)]
pub(crate) fn fake(key: &str) -> Option<String> {
    let spec = std::env::var("CAP_GPUI_MEETING_FAKE").ok()?;
    spec.split(',').find_map(|token| {
        let (name, value) = token.split_once('=')?;
        (name.trim() == key).then(|| value.trim().to_string())
    })
}

#[cfg(not(debug_assertions))]
pub(crate) fn fake(_key: &str) -> Option<String> {
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Granted,
    Denied,
    NotDetermined,
    NotNeeded,
    Unsupported,
}

impl Access {
    pub fn ready(self) -> bool {
        matches!(self, Access::Granted | Access::NotNeeded)
    }

    fn from_fake(value: &str) -> Option<Self> {
        Some(match value {
            "granted" => Access::Granted,
            "denied" => Access::Denied,
            "nd" => Access::NotDetermined,
            "unneeded" => Access::NotNeeded,
            "unsupported" => Access::Unsupported,
            _ => return None,
        })
    }
}

pub fn audio_access() -> Access {
    if let Some(access) = fake("audio").as_deref().and_then(Access::from_fake) {
        return access;
    }
    #[cfg(target_os = "macos")]
    {
        use cap_meeting_platform::AudioCapturePermission as P;
        match cap_meeting_platform::audio_capture_permission() {
            P::Granted => Access::Granted,
            P::Denied => Access::Denied,
            P::NotDetermined | P::Unknown => Access::NotDetermined,
            P::NotNeeded => Access::Unsupported,
        }
    }
    #[cfg(windows)]
    {
        Access::NotNeeded
    }
    #[cfg(target_os = "linux")]
    {
        if crate::meetings::capture::system_audio_available() {
            Access::NotNeeded
        } else {
            Access::Unsupported
        }
    }
}

pub fn accessibility_access() -> Access {
    if let Some(access) = fake("ax").as_deref().and_then(Access::from_fake) {
        return access;
    }
    #[cfg(target_os = "macos")]
    {
        if cap_meeting_platform::accessibility_trusted() {
            Access::Granted
        } else {
            Access::NotDetermined
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Access::NotNeeded
    }
}

pub fn calendar_access() -> Access {
    if let Some(access) = fake("calendar").as_deref().and_then(Access::from_fake) {
        return access;
    }
    use cap_meeting_platform::CalendarAccess as C;
    match cap_meeting_platform::calendar_access() {
        C::Granted => Access::Granted,
        C::Denied => Access::Denied,
        C::NotDetermined => Access::NotDetermined,
        C::Unsupported => Access::Unsupported,
    }
}

pub fn microphone_access(cx: &App) -> Access {
    use crate::permissions::{OSPermission, OSPermissionStatus};
    match crate::media_access::MediaAccess::global(cx)
        .read(cx)
        .status(OSPermission::Microphone)
    {
        OSPermissionStatus::Granted => Access::Granted,
        OSPermissionStatus::NotNeeded => Access::NotNeeded,
        OSPermissionStatus::Denied => Access::Denied,
        OSPermissionStatus::NotDetermined => Access::NotDetermined,
    }
}

pub fn sweep_permissions() -> (Access, Access, Access) {
    (audio_access(), accessibility_access(), calendar_access())
}

#[cfg(target_os = "macos")]
fn open_pane(anchor: &str) {
    if cfg!(test) {
        return;
    }
    crate::platform::set_activation_policy(true);
    if let Err(error) = std::process::Command::new("open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.preference.security?{anchor}"
        ))
        .spawn()
    {
        tracing::warn!("opening the privacy pane failed: {error}");
    }
}

pub fn open_audio_settings() {
    #[cfg(target_os = "macos")]
    open_pane("Privacy_ScreenCapture");
}

pub fn open_calendar_settings() {
    #[cfg(target_os = "macos")]
    open_pane("Privacy_Calendars");
}

pub fn open_accessibility_settings() {
    crate::permissions::open_permission_settings(crate::permissions::OSPermission::Accessibility);
}

pub fn request_accessibility() {
    crate::permissions::request_permission(crate::permissions::OSPermission::Accessibility);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloudState {
    SignedOut,
    Free,
    Checking,
    Available,
    Unavailable,
    Offline,
}

impl CloudState {
    pub fn selectable(self) -> bool {
        self == CloudState::Available
    }
}

pub fn cloud_state(meetings: &Meetings) -> CloudState {
    if let Some(state) = fake("account").as_deref() {
        match state {
            "signed_out" => return CloudState::SignedOut,
            "free" => return CloudState::Free,
            _ => {}
        }
        match fake("cloud").as_deref() {
            Some("unavailable") => return CloudState::Unavailable,
            Some("offline") => return CloudState::Offline,
            Some("checking") => return CloudState::Checking,
            _ => return CloudState::Available,
        }
    }
    let auth = crate::store::auth_snapshot();
    if !auth.signed_in() {
        return CloudState::SignedOut;
    }
    if !auth.is_upgraded() {
        return CloudState::Free;
    }
    if let Some(caps) = meetings.capabilities() {
        return if caps.transcription {
            CloudState::Available
        } else {
            CloudState::Unavailable
        };
    }
    if meetings.capabilities_pending() {
        return CloudState::Checking;
    }
    match meetings.capabilities_error() {
        Some(crate::meetings::cloud::CloudError::Offline(_)) => CloudState::Offline,
        Some(_) => CloudState::Unavailable,
        None => CloudState::Checking,
    }
}

pub fn ensure_capabilities(cx: &mut App) {
    if fake("account").is_some() {
        return;
    }
    let Some(meetings) = Meetings::try_global(cx) else {
        return;
    };
    let auth = crate::store::auth_snapshot();
    if !auth.signed_in() || !auth.is_upgraded() {
        return;
    }
    let needed = {
        let m = meetings.read(cx);
        m.capabilities().is_none() && !m.capabilities_pending() && m.capabilities_error().is_none()
    };
    if needed {
        meetings.update(cx, |m, cx| m.refresh_capabilities(cx));
    }
}

pub fn retry_capabilities(cx: &mut App) {
    if let Some(meetings) = Meetings::try_global(cx) {
        meetings.update(cx, |m, cx| m.refresh_capabilities(cx));
    }
}

pub fn sign_in(cx: &mut App) {
    let sign_in = crate::sign_in::SignIn::global(cx);
    sign_in.update(cx, |s, cx| {
        s.start(crate::sign_in::SignInOrigin::Settings, cx)
    });
}

pub fn upgrade(cx: &mut App) {
    cx.open_url(crate::auth::PRICING_URL);
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelState {
    Missing,
    Downloading(f64),
    Failed,
    Ready,
}

/// The one speech model Cap Notes needs here, and how far along it is.
pub struct NotesModel {
    pub model: &'static CaptionModel,
    pub state: ModelState,
    pub why: NotesModelWhy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotesModelWhy {
    /// The model Cap Notes is tuned for.
    Tuned,
    /// This Mac cannot run it.
    NeedsAppleSilicon,
    /// It does not write the chosen language.
    Language,
    /// This computer is too slow for the others (`device::slow`): the most
    /// compatible model that keeps up.
    Slow,
}

/// Cap Notes' Whisper base, for a computer too slow for the others. Not in
/// the editor's caption list; only its name and size are shown.
static SLOW_NOTES_CAPTION_MODEL: CaptionModel = CaptionModel {
    name: crate::meetings::SLOW_NOTES_MODEL,
    label: tr::editor::tabs::captions::model::small,
    model_name: "whisper.cpp base",
    size: "148MB",
    description: tr::editor::tabs::captions::model::small_description,
};

/// What the slow computer note offers: sign in, upgrade, or switch to Cap
/// Cloud when the account has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloudAction {
    SignIn,
    Upgrade,
    UseCloud,
}

pub fn cloud_action(cloud: CloudState) -> Option<CloudAction> {
    match cloud {
        CloudState::SignedOut => Some(CloudAction::SignIn),
        CloudState::Free => Some(CloudAction::Upgrade),
        CloudState::Available => Some(CloudAction::UseCloud),
        CloudState::Checking | CloudState::Unavailable | CloudState::Offline => None,
    }
}

impl CloudAction {
    pub fn label(self) -> &'static str {
        match self {
            CloudAction::SignIn => tr::settings::meetings::transcription::sign_in(),
            CloudAction::Upgrade => tr::settings::meetings::transcription::upgrade(),
            CloudAction::UseCloud => tr::settings::meetings::transcription::use_cloud(),
        }
    }
}

fn fake_model() -> Option<ModelState> {
    let value = fake("model")?;
    Some(match value.as_str() {
        "ready" => ModelState::Ready,
        "downloading" => ModelState::Downloading(42.),
        "failed" => ModelState::Failed,
        _ => ModelState::Missing,
    })
}

pub fn notes_model(settings: &MeetingSettings) -> NotesModel {
    let name = crate::meetings::notes_model(&settings.transcription.language);
    let models = available_caption_models();
    let model = models
        .iter()
        .find(|m| m.name == name)
        .or_else(|| (name == SLOW_NOTES_CAPTION_MODEL.name).then_some(&SLOW_NOTES_CAPTION_MODEL))
        .unwrap_or(&models[0]);
    let why = if crate::meetings::device::slow() {
        NotesModelWhy::Slow
    } else if name == crate::meetings::NOTES_MODEL {
        NotesModelWhy::Tuned
    } else if transcription::supports_parakeet() {
        NotesModelWhy::Language
    } else {
        NotesModelWhy::NeedsAppleSilicon
    };
    let state = fake_model().unwrap_or_else(|| {
        let snapshot = transcription::ui_snapshot(std::path::Path::new(""));
        match snapshot.download.as_ref().filter(|d| d.model == model.name) {
            Some(d) if d.state == DownloadState::Downloading => ModelState::Downloading(d.progress),
            Some(d) if d.state == DownloadState::Failed => ModelState::Failed,
            _ if snapshot.downloaded.contains(model.name) => ModelState::Ready,
            _ => ModelState::Missing,
        }
    });
    NotesModel { model, state, why }
}

pub fn local_ready(settings: &MeetingSettings) -> bool {
    notes_model(settings).state == ModelState::Ready
}

/// "870 MB" from a catalogue size such as "~870MB", with the reader's
/// decimal mark.
pub fn mega_size(size: &str) -> String {
    let size = size.trim_start_matches('~');
    for unit in ["MB", "GB"] {
        if let Some(number) = size.strip_suffix(unit) {
            return format!("{} {unit}", crate::i18n::decimal(number.trim()));
        }
    }
    size.to_string()
}

pub fn download_running() -> bool {
    fake("model").is_some_and(|m| m == "downloading")
        || transcription::download_active()
        || matches!(speakers_model(), Some(SpeakersModel::Downloading(_)))
}

pub use crate::meetings::speakers::NemotronState as SpeakersModel;

/// The model that tells voices apart better, fetched on demand; None where
/// this computer cannot run speaker models at all. Dev builds can fake it
/// (CAP_GPUI_MEETING_FAKE=speakers=missing|downloading|ready|failed).
pub fn speakers_model() -> Option<SpeakersModel> {
    let state = match fake("speakers").as_deref() {
        Some("ready") => SpeakersModel::Ready,
        Some("downloading") => SpeakersModel::Downloading(0.42),
        Some("failed") => SpeakersModel::Failed,
        Some(_) => SpeakersModel::Missing,
        None => crate::meetings::speakers::nemotron_state(),
    };
    (state != SpeakersModel::Unsupported).then_some(state)
}

/// Fetch it now (or again after a failure).
pub fn start_speakers_download(cx: &mut App) {
    crate::meetings::speakers::retry_nemotron(&gpui_tokio::Tokio::handle(cx));
}

pub fn start_download(model: &str, cx: &mut App) {
    transcription::refresh_downloaded_models();
    if transcription::begin_download(model) {
        gpui_tokio::Tokio::spawn(cx, transcription::run_model_download(model.to_string())).detach();
    }
}

pub fn delete_model(model: &'static str, cx: &mut App) -> gpui::Task<()> {
    if !transcription::begin_delete(model) {
        return gpui::Task::ready(());
    }
    cx.background_executor()
        .spawn(async move { transcription::run_model_delete(model) })
}

pub fn effective_engine(settings: &MeetingSettings, cloud: CloudState) -> Engine {
    if settings.transcription.engine == Engine::Cloud && cloud.selectable() {
        Engine::Cloud
    } else {
        Engine::Local
    }
}

pub fn local_label() -> &'static str {
    if cfg!(target_os = "macos") {
        tr::settings::meetings::transcription::local_mac()
    } else if cfg!(windows) {
        tr::settings::meetings::transcription::local_pc()
    } else {
        tr::settings::meetings::transcription::local_computer()
    }
}

pub fn sync_error_text(kind: SyncErrorKind) -> &'static str {
    match kind {
        SyncErrorKind::Offline => tr::settings::meetings::calendars::error_offline(),
        SyncErrorKind::Rejected => tr::settings::meetings::calendars::error_rejected(),
        SyncErrorKind::Server => tr::settings::meetings::calendars::error_server(),
        SyncErrorKind::NotCalendar => tr::settings::meetings::calendars::error_not_calendar(),
        SyncErrorKind::TooLarge => tr::settings::meetings::calendars::error_too_large(),
        SyncErrorKind::AccessDenied => tr::settings::meetings::calendars::error_access(),
        SyncErrorKind::Unsupported => tr::settings::meetings::calendars::error_unsupported(),
        SyncErrorKind::Other => tr::settings::meetings::calendars::error_other(),
    }
}

pub fn add_error_text(error: &CalendarError) -> &'static str {
    match error {
        CalendarError::InvalidUrl(_) => tr::settings::meetings::calendars::invalid_link(),
        CalendarError::Duplicate => tr::settings::meetings::calendars::duplicate(),
        CalendarError::NotFound => tr::settings::meetings::calendars::error_other(),
    }
}

pub fn source_title(source: &CalendarSource) -> String {
    use cap_calendar::SourceKind;
    match source.config.kind() {
        SourceKind::System => system_label().to_string(),
        SourceKind::Google if source.name.trim().is_empty() => {
            tr::settings::meetings::accounts::google().to_string()
        }
        SourceKind::Microsoft if source.name.trim().is_empty() => {
            tr::settings::meetings::accounts::outlook().to_string()
        }
        _ if !source.name.trim().is_empty() => source.name.clone(),
        _ => match &source.config {
            SourceConfig::Ics { url } => reqwest::Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| url.clone()),
            _ => source.name.clone(),
        },
    }
}

pub fn system_label() -> &'static str {
    tr::settings::meetings::calendars::system()
}

pub fn synced_text(at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let minutes = (now - at).num_minutes().max(0) as usize;
    if minutes < 1 {
        tr::settings::meetings::calendars::synced_just_now().to_string()
    } else if minutes < 60 {
        tr::settings::meetings::calendars::synced_minutes(minutes)
    } else if minutes < 60 * 24 {
        tr::settings::meetings::calendars::synced_hours(minutes / 60)
    } else {
        tr::settings::meetings::calendars::synced_days(minutes / (60 * 24))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourcePhase {
    Syncing,
    Failed(SyncErrorKind),
    Synced,
}

pub fn source_phase(source: &CalendarSource, syncing: bool) -> SourcePhase {
    if let Some(kind) = source.status.error_kind {
        if syncing && source.status.last_attempt.is_none() {
            return SourcePhase::Syncing;
        }
        return SourcePhase::Failed(kind);
    }
    if source.status.error.is_some() {
        return SourcePhase::Failed(SyncErrorKind::Other);
    }
    if source.status.last_sync.is_none() {
        return SourcePhase::Syncing;
    }
    SourcePhase::Synced
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub text: Hsla,
    pub muted: Hsla,
    pub border: Hsla,
    pub fill: Hsla,
    pub hover: Hsla,
    pub card: Hsla,
    pub accent: Hsla,
    pub accent_soft: Hsla,
    pub green: Hsla,
    pub amber: Hsla,
    pub red: Hsla,
}

impl Palette {
    pub fn new(theme: &Theme) -> Self {
        let accent: Hsla = gpui::rgb(Theme::SETTINGS_ACCENT).into();
        let dark = theme.is_dark();
        Self {
            text: theme.settings_text(),
            muted: theme.settings_muted(),
            border: theme.settings_border(),
            fill: theme.settings_fill(),
            hover: theme.settings_hover(),
            card: theme.settings_card_bg(),
            accent,
            accent_soft: Theme::with_alpha(
                gpui::rgb(Theme::SETTINGS_ACCENT),
                if dark { 0.08 } else { 0.035 },
            ),
            green: if dark {
                gpui::rgb(0x3dd68c).into()
            } else {
                gpui::rgb(0x18794e).into()
            },
            amber: Hsla::from(theme.amber_11),
            red: Hsla::from(theme.red_11),
        }
    }
}

pub fn glyph(path: &'static str, size: f32, color: Hsla) -> gpui::Svg {
    svg()
        .path(path)
        .size(px(size))
        .flex_shrink_0()
        .text_color(color)
}

pub fn status_dot(color: Hsla) -> gpui::Div {
    div().size(px(7.)).rounded_full().flex_none().bg(color)
}

pub fn progress_bar(palette: Palette, fraction: f32) -> gpui::Div {
    div()
        .h(px(4.))
        .w_full()
        .rounded_full()
        .bg(palette.fill)
        .overflow_hidden()
        .child(
            div()
                .h_full()
                .w(gpui::relative(fraction.clamp(0., 1.)))
                .rounded_full()
                .bg(palette.accent),
        )
}

pub fn spinner(id: &'static str, color: Hsla) -> AnyElement {
    use gpui::{Animation, AnimationExt as _};
    glyph("icons/refresh-cw.svg", 12., color)
        .with_animation(
            id,
            Animation::new(Duration::from_millis(900)).repeat(),
            |svg, t| {
                svg.with_transformation(gpui::Transformation::rotate(gpui::radians(
                    t * std::f32::consts::TAU,
                )))
            },
        )
        .into_any_element()
}

pub fn sync_unsynced_calendars(cx: &mut App) {
    let Some(meetings) = Meetings::try_global(cx) else {
        return;
    };
    meetings.update(cx, |m, cx| m.load_calendars(cx));
    let pending = meetings
        .read(cx)
        .calendar_sources()
        .iter()
        .any(|source| source.status.last_attempt.is_none())
        && !meetings.read(cx).calendar_syncing();
    if pending {
        meetings.update(cx, |m, cx| m.sync_calendars(cx));
    }
}
