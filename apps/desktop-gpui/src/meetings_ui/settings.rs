pub(crate) mod accounts;
mod calendars;
mod dictionary;
mod page;
pub(crate) mod shared;
#[cfg(test)]
pub(crate) mod tests;

use cap_meetings::{
    apps::all_apps,
    detect::BrowserPolicy,
    prompt::AutoRecord,
    settings::{Engine, Language, MeetingSettings, Microphone, PromptPosition},
    templates::Template,
};
use gpui::{App, AppContext as _, Context, Entity, Subscription, Task, Window};

use crate::{
    editor_tabs::CAPTION_LANGUAGES,
    i18n::tr,
    meetings::{CalendarError, MeetingEvent, Meetings},
    settings_window::{MenuKind, Page, SettingsWindow},
    ui,
};

use shared::{Access, CloudState};

pub fn open(cx: &mut App) {
    crate::app_windows::open_settings(Page::Meetings, cx);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeetingsMenu {
    Lead,
    AddApp,
    AutoRecord,
    Countdown,
    Silence,
    Retention,
    Microphone,
    Language,
    Template,
    NotesLanguage,
    AddCalendar,
}

pub(crate) const AUTO_RECORD: [AutoRecord; 4] = [
    AutoRecord::Off,
    AutoRecord::Detected,
    AutoRecord::Scheduled,
    AutoRecord::Both,
];

pub(crate) const CORNERS: [PromptPosition; 4] = [
    PromptPosition::TopLeft,
    PromptPosition::TopRight,
    PromptPosition::BottomLeft,
    PromptPosition::BottomRight,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Flag {
    Scheduled,
    ShowJoin,
    Detected,
    Sound,
    BringForward,
    ShowCap,
    StopOnEnd,
    KeepAudio,
    Indicator,
    Sounds,
    LearnVoice,
    AppNames,
    AutoNotes,
    HideDeclined,
    HideAllDay,
    HideSolo,
    MenuBar,
}

impl Flag {
    #[cfg(test)]
    pub(crate) const ALL: [Flag; 17] = [
        Flag::Scheduled,
        Flag::ShowJoin,
        Flag::Detected,
        Flag::Sound,
        Flag::BringForward,
        Flag::ShowCap,
        Flag::StopOnEnd,
        Flag::KeepAudio,
        Flag::Indicator,
        Flag::Sounds,
        Flag::LearnVoice,
        Flag::AppNames,
        Flag::AutoNotes,
        Flag::HideDeclined,
        Flag::HideAllDay,
        Flag::HideSolo,
        Flag::MenuBar,
    ];

    fn slot(self, s: &mut MeetingSettings) -> &mut bool {
        match self {
            Flag::Scheduled => &mut s.notifications.scheduled,
            Flag::ShowJoin => &mut s.notifications.show_join,
            Flag::Detected => &mut s.notifications.detected,
            Flag::Sound => &mut s.notifications.sound,
            Flag::BringForward => &mut s.automation.bring_up_window,
            Flag::ShowCap => &mut s.automation.show_cap_on_close,
            Flag::StopOnEnd => &mut s.recording.stop_when_call_ends,
            Flag::KeepAudio => &mut s.recording.keep_audio,
            Flag::Indicator => &mut s.recording.show_indicator,
            Flag::Sounds => &mut s.recording.sounds,
            Flag::LearnVoice => &mut s.transcription.learn_voice,
            Flag::AppNames => &mut s.transcription.name_speakers_from_apps,
            Flag::AutoNotes => &mut s.notes.auto_generate,
            Flag::HideDeclined => &mut s.calendar.hide_declined,
            Flag::HideAllDay => &mut s.calendar.hide_all_day,
            Flag::HideSolo => &mut s.calendar.hide_without_participants,
            Flag::MenuBar => &mut s.calendar.show_next_in_menu_bar,
        }
    }

    pub(crate) fn get(self, s: &MeetingSettings) -> bool {
        match self {
            Flag::Scheduled => s.notifications.scheduled,
            Flag::ShowJoin => s.notifications.show_join,
            Flag::Detected => s.notifications.detected,
            Flag::Sound => s.notifications.sound,
            Flag::BringForward => s.automation.bring_up_window,
            Flag::ShowCap => s.automation.show_cap_on_close,
            Flag::StopOnEnd => s.recording.stop_when_call_ends,
            Flag::KeepAudio => s.recording.keep_audio,
            Flag::Indicator => s.recording.show_indicator,
            Flag::Sounds => s.recording.sounds,
            Flag::LearnVoice => s.transcription.learn_voice,
            Flag::AppNames => s.transcription.name_speakers_from_apps,
            Flag::AutoNotes => s.notes.auto_generate,
            Flag::HideDeclined => s.calendar.hide_declined,
            Flag::HideAllDay => s.calendar.hide_all_day,
            Flag::HideSolo => s.calendar.hide_without_participants,
            Flag::MenuBar => s.calendar.show_next_in_menu_bar,
        }
    }

    pub(crate) fn toggle(self, s: &mut MeetingSettings) {
        let slot = self.slot(s);
        *slot = !*slot;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddChoice {
    System,
    Link,
}

pub(crate) fn add_choices(has_system: bool) -> Vec<AddChoice> {
    if cfg!(target_os = "macos") && !has_system {
        vec![AddChoice::System, AddChoice::Link]
    } else {
        vec![AddChoice::Link]
    }
}

pub(crate) fn lead_label(secs: u32) -> &'static str {
    match secs {
        0 => tr::settings::meetings::notifications::lead_start(),
        30 => tr::settings::meetings::notifications::lead_30s(),
        60 => tr::settings::meetings::notifications::lead_1m(),
        120 => tr::settings::meetings::notifications::lead_2m(),
        300 => tr::settings::meetings::notifications::lead_5m(),
        600 => tr::settings::meetings::notifications::lead_10m(),
        _ => tr::settings::meetings::notifications::lead_15m(),
    }
}

pub(crate) fn auto_record_label(value: AutoRecord) -> &'static str {
    match value {
        AutoRecord::Off => tr::settings::meetings::automation::never(),
        AutoRecord::Detected => tr::settings::meetings::automation::detected(),
        AutoRecord::Scheduled => tr::settings::meetings::automation::scheduled(),
        AutoRecord::Both => tr::settings::meetings::automation::both(),
    }
}

pub(crate) fn corner_label(position: PromptPosition) -> &'static str {
    match position {
        PromptPosition::TopLeft => tr::settings::meetings::notifications::top_left(),
        PromptPosition::TopRight => tr::settings::meetings::notifications::top_right(),
        PromptPosition::BottomLeft => tr::settings::meetings::notifications::bottom_left(),
        PromptPosition::BottomRight => tr::settings::meetings::notifications::bottom_right(),
    }
}

pub(crate) fn silence_label(minutes: Option<u32>) -> String {
    match minutes {
        None => tr::settings::meetings::recording::never().to_string(),
        Some(m) => tr::settings::meetings::recording::minutes(m as usize),
    }
}

pub(crate) fn retention_label(days: Option<u32>) -> String {
    match days {
        None => tr::settings::meetings::recording::forever().to_string(),
        Some(d) => tr::settings::meetings::recording::days(d as usize),
    }
}

pub(crate) fn language_label(code: &str) -> &'static str {
    CAPTION_LANGUAGES
        .iter()
        .find(|(c, _)| *c == code)
        .map_or_else(
            || tr::editor::tabs::captions::language::auto(),
            |(_, l)| l(),
        )
}

pub(crate) fn notes_languages() -> Vec<&'static str> {
    CAPTION_LANGUAGES
        .iter()
        .map(|(code, _)| *code)
        .filter(|code| crate::meetings::generate::SUMMARY_LANGUAGES.contains(code))
        .collect()
}

pub(crate) fn muted_candidates(
    settings: &MeetingSettings,
) -> Vec<&'static cap_meetings::apps::AppInfo> {
    let mut apps: Vec<_> = all_apps()
        .iter()
        .filter(|app| {
            !settings
                .notifications
                .muted_app_ids
                .iter()
                .any(|id| id == app.id)
        })
        .collect();
    apps.sort_by_key(|app| app.name.to_ascii_lowercase());
    apps.dedup_by_key(|app| app.name);
    apps
}

pub(crate) fn app_name(id: &str) -> String {
    cap_meetings::apps::app_by_id(id).map_or_else(|| id.to_string(), |app| app.name.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Field {
    Url,
    Name,
    Vocabulary,
    Sounds,
}

pub(crate) struct PageState {
    pub(crate) settings: MeetingSettings,
    pub(crate) url_input: Entity<ui::TextInputState>,
    pub(crate) name_input: Entity<ui::TextInputState>,
    pub(crate) vocab_input: Entity<ui::TextInputState>,
    pub(crate) url_draft: String,
    pub(crate) name_draft: String,
    pub(crate) vocab_draft: String,
    /// The dictionary entry whose "sounds like" form is being typed.
    pub(crate) sounds_for: Option<usize>,
    pub(crate) sounds_input: Entity<ui::TextInputState>,
    pub(crate) sounds_draft: String,
    pub(crate) link_form: bool,
    pub(crate) add_error: Option<CalendarError>,
    pub(crate) added: Option<String>,
    pub(crate) help_open: bool,
    pub(crate) expanded_system: bool,
    pub(crate) audio: Access,
    pub(crate) accessibility: Access,
    pub(crate) calendar: Access,
    pub(crate) ax_requested: bool,
    pub(crate) calendar_requesting: bool,
    pub(crate) cloud: CloudState,
    pub(crate) microphones: Vec<String>,
    pub(crate) templates: Vec<Template>,
    pub(crate) download_tick: Option<Task<()>>,
    pub(crate) sweep: Option<Task<()>>,
    pub(crate) delete: Option<Task<()>>,
    pub(crate) calendar_request: Option<Task<()>>,
    /// How many meetings the stored voice profile was learnt from.
    pub(crate) voice_meetings: Option<u32>,
    _subscriptions: Vec<Subscription>,
}

impl PageState {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<SettingsWindow>) -> Self {
        let url_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let name_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let vocab_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let sounds_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let mut subscriptions = vec![
            cx.subscribe(&sounds_input, |this, input, event, cx| {
                this.meetings_field_event(Field::Sounds, input, event, cx)
            }),
            cx.subscribe(&url_input, |this, input, event, cx| {
                this.meetings_field_event(Field::Url, input, event, cx)
            }),
            cx.subscribe(&name_input, |this, input, event, cx| {
                this.meetings_field_event(Field::Name, input, event, cx)
            }),
            cx.subscribe(&vocab_input, |this, input, event, cx| {
                this.meetings_field_event(Field::Vocabulary, input, event, cx)
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                if this.page == Page::Meetings && window.is_window_active() {
                    this.meetings_refresh_voice();
                    this.meetings_sweep(window, cx);
                    this.meetings_arm_download_tick(window, cx);
                }
            }),
        ];
        let mut settings = MeetingSettings::default();
        let mut cloud = CloudState::SignedOut;
        if let Some(meetings) = Meetings::try_global(cx) {
            settings = meetings.read(cx).settings().clone();
            cloud = shared::cloud_state(meetings.read(cx));
            subscriptions.push(cx.subscribe(&meetings, |this, meetings, event, cx| {
                match event {
                    MeetingEvent::SettingsChanged => {
                        this.pages.meetings.settings = meetings.read(cx).settings().clone();
                    }
                    MeetingEvent::CalendarChanged => {}
                    _ => return,
                }
                if this.page == Page::Meetings {
                    cx.notify();
                }
            }));
            subscriptions.push(cx.observe(&meetings, |this, meetings, cx| {
                let cloud = shared::cloud_state(meetings.read(cx));
                if cloud != this.pages.meetings.cloud {
                    this.pages.meetings.cloud = cloud;
                    if this.page == Page::Meetings {
                        cx.notify();
                    }
                }
            }));
        }
        Self {
            settings,
            url_input,
            name_input,
            vocab_input,
            url_draft: String::new(),
            name_draft: String::new(),
            vocab_draft: String::new(),
            sounds_for: None,
            sounds_input,
            sounds_draft: String::new(),
            link_form: false,
            add_error: None,
            added: None,
            help_open: false,
            expanded_system: false,
            audio: Access::NotNeeded,
            accessibility: Access::NotNeeded,
            calendar: Access::Unsupported,
            ax_requested: false,
            calendar_requesting: false,
            cloud,
            microphones: Vec::new(),
            templates: Vec::new(),
            download_tick: None,
            sweep: None,
            delete: None,
            calendar_request: None,
            voice_meetings: None,
            _subscriptions: subscriptions,
        }
    }
}

impl SettingsWindow {
    pub(crate) fn meetings_page_shown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(meetings) = Meetings::try_global(cx) {
            let m = meetings.read(cx);
            self.pages.meetings.settings = m.settings().clone();
            self.pages.meetings.templates = m.templates();
        }
        self.meetings_refresh_voice();
        crate::transcription::refresh_downloaded_models();
        shared::ensure_capabilities(cx);
        crate::meetings_ui::cap_ai::ensure_access(cx);
        #[cfg(debug_assertions)]
        if let Some(y) = std::env::var("CAP_GPUI_SETTINGS_SCROLL_Y")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
        {
            let scroll = self.page_scroll.clone();
            window.on_next_frame(move |_, _| {
                scroll.set_offset(gpui::point(gpui::px(0.), gpui::px(-y)));
            });
        }
        shared::sync_unsynced_calendars(cx);
        if let Some(meetings) = Meetings::try_global(cx) {
            self.pages.meetings.cloud = shared::cloud_state(meetings.read(cx));
        }
        self.pages.meetings.add_error = None;
        self.meetings_sweep(window, cx);
        self.meetings_arm_download_tick(window, cx);
    }

    pub(crate) fn meetings_sweep(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pages.meetings.sweep.is_some() {
            return;
        }
        crate::media_access::MediaAccess::refresh_global(cx);
        self.pages.meetings.sweep = Some(cx.spawn_in(window, async move |this, cx| {
            let ((audio, accessibility, calendar), microphones) = cx
                .background_executor()
                .spawn(async {
                    (
                        shared::sweep_permissions(),
                        cap_recording::feeds::microphone::MicrophoneFeed::list_names(),
                    )
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                let state = &mut this.pages.meetings;
                state.sweep = None;
                let calendar_changed = state.calendar != calendar;
                state.audio = audio;
                state.accessibility = accessibility;
                state.calendar = calendar;
                state.microphones = microphones;
                if calendar_changed && let Some(meetings) = Meetings::try_global(cx) {
                    meetings.update(cx, |m, cx| m.calendar_access_changed(cx));
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        }));
    }

    pub(crate) fn meetings_arm_download_tick(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pages.meetings.download_tick.is_some() || !shared::download_running() {
            return;
        }
        self.pages.meetings.download_tick = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(shared::DOWNLOAD_REPAINT)
                    .await;
                let keep = this
                    .update_in(cx, |this, window, cx| {
                        cx.notify();
                        window.refresh();
                        let keep = this.page == Page::Meetings
                            && window.is_window_active()
                            && shared::download_running();
                        if !keep {
                            this.pages.meetings.download_tick = None;
                        }
                        keep
                    })
                    .unwrap_or(false);
                if !keep {
                    return;
                }
            }
        }));
    }

    pub(crate) fn meetings_update(
        &mut self,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut MeetingSettings),
    ) {
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        meetings.update(cx, |m, cx| m.update_settings(change, cx));
        self.pages.meetings.settings = meetings.read(cx).settings().clone();
        cx.notify();
    }

    pub(crate) fn meetings_refresh_voice(&mut self) {
        self.pages.meetings.voice_meetings =
            crate::meetings::speakers::load_profile().map(|p| p.meetings.max(1));
    }

    pub(crate) fn meetings_forget_voice(&mut self, cx: &mut Context<Self>) {
        if let Err(error) = crate::meetings::speakers::forget_profile() {
            tracing::warn!(%error, "could not delete the voice profile");
        }
        self.meetings_refresh_voice();
        cx.notify();
    }

    pub(crate) fn meetings_toggle_flag(&mut self, flag: Flag, cx: &mut Context<Self>) {
        self.meetings_update(cx, move |s| flag.toggle(s));
    }

    /// Whether the transcript shows live with the engine meetings use now on
    /// this computer (off by default with Cap Cloud on a slow one).
    pub(crate) fn meetings_live(&self) -> bool {
        let settings = &self.pages.meetings.settings;
        let engine = shared::effective_engine(settings, self.pages.meetings.cloud);
        settings
            .transcription
            .live_for(engine, crate::meetings::device::slow())
    }

    pub(crate) fn meetings_toggle_live(&mut self, cx: &mut Context<Self>) {
        let engine =
            shared::effective_engine(&self.pages.meetings.settings, self.pages.meetings.cloud);
        let slow = crate::meetings::device::slow();
        let on = !self.meetings_live();
        self.meetings_update(cx, move |s| s.transcription.set_live_for(engine, slow, on));
    }

    /// The slow computer's Cap Cloud recommendation: sign in, upgrade, or
    /// switch this computer's meetings to Cap Cloud.
    pub(crate) fn meetings_run_cloud_action(
        &mut self,
        action: shared::CloudAction,
        cx: &mut Context<Self>,
    ) {
        match action {
            shared::CloudAction::SignIn => shared::sign_in(cx),
            shared::CloudAction::Upgrade => crate::meetings_ui::cap_ai::open_upgrade(
                None,
                crate::meetings_ui::cap_ai::Host::Window,
                cx,
            ),
            shared::CloudAction::UseCloud => self.meetings_set_engine(Engine::Cloud, cx),
        }
    }

    pub(crate) fn meetings_set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if enabled && !self.pages.meetings.settings.setup_completed {
            cx.defer(crate::meetings_ui::setup::open);
            return;
        }
        self.meetings_update(cx, |s| s.enabled = enabled);
    }

    pub(crate) fn meetings_run_setup(&mut self, cx: &mut Context<Self>) {
        cx.defer(crate::meetings_ui::setup::open);
    }

    pub(crate) fn meetings_set_corner(&mut self, position: PromptPosition, cx: &mut Context<Self>) {
        self.meetings_update(cx, |s| s.notifications.position = position);
    }

    pub(crate) fn meetings_unmute(&mut self, id: &str, cx: &mut Context<Self>) {
        let id = id.to_string();
        self.meetings_update(cx, |s| s.notifications.muted_app_ids.retain(|m| *m != id));
    }

    pub(crate) fn meetings_set_browser_policy(
        &mut self,
        policy: BrowserPolicy,
        cx: &mut Context<Self>,
    ) {
        self.meetings_update(cx, |s| s.automation.browser_policy = policy);
    }

    pub(crate) fn meetings_set_engine(&mut self, engine: Engine, cx: &mut Context<Self>) {
        self.meetings_update(cx, |s| s.transcription.engine = engine);
    }

    pub(crate) fn meetings_download(
        &mut self,
        model: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        shared::start_download(model, cx);
        self.meetings_arm_download_tick(window, cx);
        cx.notify();
    }

    pub(crate) fn meetings_delete_model(
        &mut self,
        model: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let task = shared::delete_model(model, cx);
        if self.pages.meetings.settings.transcription.local_model == model {
            self.meetings_update(cx, |s| {
                s.transcription.local_model = cap_meetings::settings::DEFAULT_LOCAL_MODEL.into()
            });
        }
        self.pages.meetings.delete = Some(cx.spawn_in(window, async move |this, cx| {
            task.await;
            this.update_in(cx, |this, window, cx| {
                this.pages.meetings.delete = None;
                cx.notify();
                window.refresh();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Every dictionary change: the meetings settings hold it, and its
    /// spellings are written where caption settings and older builds read.
    pub(crate) fn dictionary_update(
        &mut self,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut Vec<cap_meetings::dictionary::Entry>),
    ) {
        let before = self
            .pages
            .meetings
            .settings
            .transcription
            .vocabulary
            .clone();
        self.meetings_update(cx, |s| {
            let mut entries = s.transcription.entries().to_vec();
            change(&mut entries);
            s.transcription.dictionary = Some(entries);
        });
        let after = &self.pages.meetings.settings.transcription.vocabulary;
        if *after != before {
            crate::store::mirror_transcription_hints(after);
        }
    }

    pub(crate) fn meetings_add_term(&mut self, cx: &mut Context<Self>) {
        let terms: Vec<String> = self
            .pages
            .meetings
            .vocab_draft
            .split([',', '\n'])
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect();
        if terms.is_empty() {
            return;
        }
        self.pages.meetings.vocab_draft.clear();
        let input = self.pages.meetings.vocab_input.clone();
        input.update(cx, |input, cx| input.set_text("", cx));
        self.dictionary_update(cx, |entries| {
            entries.extend(terms.into_iter().map(cap_meetings::dictionary::Entry::new))
        });
    }

    pub(crate) fn meetings_remove_term(&mut self, term: &str, cx: &mut Context<Self>) {
        let term = term.to_string();
        self.pages.meetings.sounds_for = None;
        self.dictionary_update(cx, |entries| entries.retain(|e| e.spelling != term));
    }

    pub(crate) fn meetings_edit_sounds(&mut self, index: Option<usize>, cx: &mut Context<Self>) {
        self.pages.meetings.sounds_for = index;
        self.pages.meetings.sounds_draft.clear();
        let input = self.pages.meetings.sounds_input.clone();
        input.update(cx, |input, cx| input.set_text("", cx));
        cx.notify();
    }

    pub(crate) fn meetings_add_sound(&mut self, cx: &mut Context<Self>) {
        let Some(index) = self.pages.meetings.sounds_for else {
            return;
        };
        let forms: Vec<String> = self
            .pages
            .meetings
            .sounds_draft
            .split([',', '\n'])
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect();
        self.meetings_edit_sounds(None, cx);
        if forms.is_empty() {
            return;
        }
        self.dictionary_update(cx, |entries| {
            if let Some(entry) = entries.get_mut(index) {
                entry.sounds_like.extend(forms);
            }
        });
    }

    pub(crate) fn meetings_remove_sound(
        &mut self,
        index: usize,
        form: &str,
        cx: &mut Context<Self>,
    ) {
        let form = form.to_string();
        self.dictionary_update(cx, |entries| {
            if let Some(entry) = entries.get_mut(index) {
                entry.sounds_like.retain(|f| *f != form);
            }
        });
    }

    pub(crate) fn meetings_toggle_calendar(&mut self, calendar_id: &str, cx: &mut Context<Self>) {
        let id = calendar_id.to_string();
        self.meetings_update(cx, |s| {
            let hidden = &mut s.calendar.hidden_calendar_ids;
            if let Some(index) = hidden.iter().position(|h| *h == id) {
                hidden.remove(index);
            } else {
                hidden.push(id);
            }
        });
    }

    pub(crate) fn meetings_add_link(&mut self, cx: &mut Context<Self>) {
        let url = self.pages.meetings.url_draft.trim().to_string();
        if url.is_empty() {
            return;
        }
        let name =
            Some(self.pages.meetings.name_draft.trim().to_string()).filter(|n| !n.is_empty());
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        match meetings.update(cx, |m, cx| m.add_calendar_feed(&url, name, cx)) {
            Ok(id) => {
                let state = &mut self.pages.meetings;
                state.added = Some(id);
                state.add_error = None;
                state.link_form = false;
                state.url_draft.clear();
                state.name_draft.clear();
                let (url_input, name_input) = (state.url_input.clone(), state.name_input.clone());
                url_input.update(cx, |i, cx| i.set_text("", cx));
                name_input.update(cx, |i, cx| i.set_text("", cx));
            }
            Err(error) => self.pages.meetings.add_error = Some(error),
        }
        cx.notify();
    }

    pub(crate) fn meetings_add_system(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.pages.meetings.calendar {
            Access::Granted => self.meetings_connect_system(cx),
            Access::NotDetermined => {
                self.pages.meetings.calendar_requesting = true;
                let (tx, rx) = flume::bounded::<bool>(1);
                cap_meeting_platform::request_calendar_access(move |granted| {
                    let _ = tx.send(granted);
                });
                self.pages.meetings.calendar_request =
                    Some(cx.spawn_in(window, async move |this, cx| {
                        let granted = rx.recv_async().await.unwrap_or(false);
                        this.update_in(cx, |this, window, cx| {
                            let state = &mut this.pages.meetings;
                            state.calendar_requesting = false;
                            state.calendar_request = None;
                            state.calendar = if granted {
                                Access::Granted
                            } else {
                                Access::Denied
                            };
                            if granted {
                                this.meetings_connect_system(cx);
                            }
                            cx.notify();
                            window.refresh();
                        })
                        .ok();
                    }));
                cx.notify();
            }
            Access::Denied => shared::open_calendar_settings(),
            Access::NotNeeded | Access::Unsupported => {}
        }
    }

    pub(crate) fn meetings_connect_system(&mut self, cx: &mut Context<Self>) {
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        match meetings.update(cx, |m, cx| m.add_system_calendar(cx)) {
            Ok(id) => {
                self.pages.meetings.added = Some(id);
                self.pages.meetings.add_error = None;
            }
            Err(CalendarError::Duplicate) => {
                meetings.update(cx, |m, cx| m.calendar_access_changed(cx));
            }
            Err(error) => self.pages.meetings.add_error = Some(error),
        }
        cx.notify();
    }

    pub(crate) fn meetings_remove_calendar(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(meetings) = Meetings::try_global(cx) {
            let _ = meetings.update(cx, |m, cx| m.remove_calendar(id, cx));
        }
        if self.pages.meetings.added.as_deref() == Some(id) {
            self.pages.meetings.added = None;
        }
        cx.notify();
    }

    pub(crate) fn meetings_retry_calendars(&mut self, cx: &mut Context<Self>) {
        if let Some(meetings) = Meetings::try_global(cx) {
            meetings.update(cx, |m, cx| m.sync_calendars(cx));
        }
    }

    pub(crate) fn meetings_grant_accessibility(&mut self, cx: &mut Context<Self>) {
        if self.pages.meetings.ax_requested {
            shared::open_accessibility_settings();
        } else {
            self.pages.meetings.ax_requested = true;
            shared::request_accessibility();
        }
        cx.notify();
    }

    fn meetings_field_event(
        &mut self,
        field: Field,
        input: Entity<ui::TextInputState>,
        event: &ui::TextInputEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                let value = input.read(cx).text().to_string();
                let state = &mut self.pages.meetings;
                match field {
                    Field::Url => {
                        state.url_draft = value;
                        state.add_error = None;
                    }
                    Field::Name => state.name_draft = value,
                    Field::Vocabulary => state.vocab_draft = value,
                    Field::Sounds => state.sounds_draft = value,
                }
                cx.notify();
            }
            ui::TextInputEvent::Confirmed => match field {
                Field::Url | Field::Name => self.meetings_add_link(cx),
                Field::Vocabulary => self.meetings_add_term(cx),
                Field::Sounds => self.meetings_add_sound(cx),
            },
            ui::TextInputEvent::Cancelled if field == Field::Sounds => {
                self.meetings_edit_sounds(None, cx);
            }
            ui::TextInputEvent::Cancelled if matches!(field, Field::Url | Field::Name) => {
                self.pages.meetings.link_form = false;
                cx.notify();
            }
            _ => {}
        }
    }

    pub(crate) fn meetings_menu_items(&self, menu: MeetingsMenu) -> Vec<ui::MenuItem> {
        let s = &self.pages.meetings.settings;
        match menu {
            MeetingsMenu::Lead => shared::LEAD_OPTIONS
                .iter()
                .map(|secs| {
                    ui::MenuItem::new(lead_label(*secs), *secs == s.notifications.lead_secs)
                })
                .collect(),
            MeetingsMenu::AddApp => muted_candidates(s)
                .into_iter()
                .map(|app| ui::MenuItem::new(app.name, false))
                .collect(),
            MeetingsMenu::AutoRecord => AUTO_RECORD
                .iter()
                .map(|v| ui::MenuItem::new(auto_record_label(*v), *v == s.automation.auto_record))
                .collect(),
            MeetingsMenu::Countdown => shared::COUNTDOWN_OPTIONS
                .iter()
                .map(|secs| {
                    ui::MenuItem::new(
                        tr::settings::meetings::automation::seconds(*secs as usize),
                        *secs == s.automation.countdown_secs,
                    )
                })
                .collect(),
            MeetingsMenu::Silence => shared::SILENCE_OPTIONS
                .iter()
                .map(|m| ui::MenuItem::new(silence_label(*m), *m == s.recording.inactivity_minutes))
                .collect(),
            MeetingsMenu::Retention => shared::RETENTION_OPTIONS
                .iter()
                .map(|d| {
                    ui::MenuItem::new(retention_label(*d), *d == s.recording.audio_retention_days)
                })
                .collect(),
            MeetingsMenu::Microphone => {
                let mut items = vec![ui::MenuItem::new(
                    tr::settings::meetings::recording::mic_auto(),
                    s.recording.microphone == Microphone::Auto,
                )];
                items.extend(self.meetings_microphones().into_iter().map(|name| {
                    let checked = s.recording.microphone == Microphone::Named(name.clone());
                    ui::MenuItem::new(name, checked)
                }));
                items
            }
            MeetingsMenu::Language => CAPTION_LANGUAGES
                .iter()
                .map(|(code, label)| {
                    let checked = match &s.transcription.language {
                        Language::Auto => *code == "auto",
                        Language::Code(c) => c == code,
                    };
                    ui::MenuItem::new(label(), checked)
                })
                .collect(),
            MeetingsMenu::Template => self
                .pages
                .meetings
                .templates
                .iter()
                .map(|t| {
                    ui::MenuItem::new(
                        crate::meetings_ui::documents::format::template_name(t),
                        t.id == s.notes.default_template_id,
                    )
                })
                .collect(),
            MeetingsMenu::NotesLanguage => {
                let mut items = vec![ui::MenuItem::new(
                    tr::settings::meetings::notes::same_as_meeting(),
                    s.notes.summary_language.is_none(),
                )];
                items.extend(notes_languages().into_iter().map(|code| {
                    ui::MenuItem::new(
                        language_label(code),
                        s.notes.summary_language.as_deref() == Some(code),
                    )
                }));
                items
            }
            MeetingsMenu::AddCalendar => add_choices(false)
                .into_iter()
                .map(|choice| match choice {
                    AddChoice::System => {
                        ui::MenuItem::new(tr::settings::meetings::calendars::system(), false)
                    }
                    AddChoice::Link => {
                        ui::MenuItem::new(tr::settings::meetings::calendars::link(), false)
                    }
                })
                .collect(),
        }
    }

    pub(crate) fn meetings_microphones(&self) -> Vec<String> {
        let mut names = self.pages.meetings.microphones.clone();
        if let Microphone::Named(name) = &self.pages.meetings.settings.recording.microphone
            && !names.contains(name)
        {
            names.push(name.clone());
        }
        names
    }

    pub(crate) fn meetings_choose(
        &mut self,
        menu: MeetingsMenu,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match menu {
            MeetingsMenu::Lead => {
                if let Some(secs) = shared::LEAD_OPTIONS.get(index).copied() {
                    self.meetings_update(cx, |s| s.notifications.lead_secs = secs);
                }
            }
            MeetingsMenu::AddApp => {
                if let Some(app) = muted_candidates(&self.pages.meetings.settings).get(index) {
                    let id = app.id.to_string();
                    self.meetings_update(cx, |s| s.notifications.muted_app_ids.push(id));
                }
            }
            MeetingsMenu::AutoRecord => {
                if let Some(value) = AUTO_RECORD.get(index).copied() {
                    self.meetings_update(cx, |s| s.automation.auto_record = value);
                }
            }
            MeetingsMenu::Countdown => {
                if let Some(secs) = shared::COUNTDOWN_OPTIONS.get(index).copied() {
                    self.meetings_update(cx, |s| s.automation.countdown_secs = secs);
                }
            }
            MeetingsMenu::Silence => {
                if let Some(value) = shared::SILENCE_OPTIONS.get(index).copied() {
                    self.meetings_update(cx, |s| s.recording.inactivity_minutes = value);
                }
            }
            MeetingsMenu::Retention => {
                if let Some(value) = shared::RETENTION_OPTIONS.get(index).copied() {
                    self.meetings_update(cx, |s| s.recording.audio_retention_days = value);
                }
            }
            MeetingsMenu::Microphone => {
                let value = match index {
                    0 => Some(Microphone::Auto),
                    i => self
                        .meetings_microphones()
                        .get(i - 1)
                        .cloned()
                        .map(Microphone::Named),
                };
                if let Some(value) = value {
                    self.meetings_update(cx, |s| s.recording.microphone = value);
                }
            }
            MeetingsMenu::Language => {
                if let Some((code, _)) = CAPTION_LANGUAGES.get(index) {
                    let value = if *code == "auto" {
                        Language::Auto
                    } else {
                        Language::Code((*code).to_string())
                    };
                    self.meetings_update(cx, |s| s.transcription.language = value);
                }
            }
            MeetingsMenu::Template => {
                if let Some(id) = self
                    .pages
                    .meetings
                    .templates
                    .get(index)
                    .map(|t| t.id.clone())
                {
                    self.meetings_update(cx, |s| s.notes.default_template_id = id);
                }
            }
            MeetingsMenu::NotesLanguage => {
                let value = match index {
                    0 => Some(None),
                    i => notes_languages().get(i - 1).map(|c| Some((*c).to_string())),
                };
                if let Some(value) = value {
                    self.meetings_update(cx, |s| s.notes.summary_language = value);
                }
            }
            MeetingsMenu::AddCalendar => match add_choices(self.meetings_has_system(cx)).get(index)
            {
                Some(AddChoice::System) => self.meetings_add_system(window, cx),
                Some(AddChoice::Link) => {
                    self.pages.meetings.link_form = true;
                    self.pages.meetings.add_error = None;
                    let input = self.pages.meetings.url_input.clone();
                    input.update(cx, |input, cx| input.focus_and_select_all(window, cx));
                }
                None => {}
            },
        }
        cx.notify();
    }

    pub(crate) fn meetings_open_menu(
        &mut self,
        menu: MeetingsMenu,
        position: gpui::Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if menu == MeetingsMenu::Template
            && let Some(meetings) = Meetings::try_global(cx)
        {
            self.pages.meetings.templates = meetings.read(cx).templates();
        }
        self.open_menu(MenuKind::Meetings(menu), position, window, cx);
    }
}
