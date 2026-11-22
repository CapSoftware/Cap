use cap_meetings::{
    detect::BrowserPolicy,
    settings::{Engine, Language, MAX_VOCABULARY, MeetingSettings, Microphone, PromptPosition},
};
use gpui::{
    AppContext as _, Context, Entity, IntoElement, ParentElement, Render, TestAppContext,
    VisualTestContext, Window, size,
};

use super::{
    AUTO_RECORD, CORNERS, Flag, MeetingsMenu, muted_candidates, notes_languages,
    shared::{COUNTDOWN_OPTIONS, CloudState, LEAD_OPTIONS, RETENTION_OPTIONS, SILENCE_OPTIONS},
};
use crate::{
    editor_tabs::CAPTION_LANGUAGES,
    meetings::Meetings,
    settings_window::{Page, SettingsWindow, recording_action_tests::settings_fixture},
};

struct Host {
    settings: Entity<SettingsWindow>,
}

impl Render for Host {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.settings.update(cx, |settings, cx| {
            gpui::div().children(settings.render_meetings(window, cx))
        })
    }
}

pub(crate) struct Fixture {
    _dir: tempfile::TempDir,
    _runtime: tokio::runtime::Runtime,
}

pub(crate) fn install(
    cx: &mut TestAppContext,
    initial: MeetingSettings,
) -> (Entity<Meetings>, Fixture) {
    let dir = tempfile::tempdir().unwrap();
    let calendar_dir = dir.path().to_path_buf();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let handle = runtime.handle().clone();
    let meetings = cx.update(|cx| {
        gpui_tokio::init_from_handle(cx, handle);
        crate::media_access::MediaAccess::init(cx);
        crate::sign_in::SignIn::init(cx);
        Meetings::install_for_tests(initial, calendar_dir, cx)
    });
    (
        meetings,
        Fixture {
            _dir: dir,
            _runtime: runtime,
        },
    )
}

fn open(
    cx: &mut TestAppContext,
    initial: MeetingSettings,
) -> (
    Entity<SettingsWindow>,
    Entity<Meetings>,
    VisualTestContext,
    Fixture,
) {
    let (meetings, fixture) = install(cx, initial);
    let window = cx.open_window(size(gpui::px(780.), gpui::px(4000.)), |window, cx| Host {
        settings: cx.new(|cx| {
            let mut settings = settings_fixture(window, cx);
            settings.page = Page::Meetings;
            settings
        }),
    });
    let settings = window
        .read_with(cx, |host, _| host.settings.clone())
        .unwrap();
    let mut visual = VisualTestContext::from_window(window.into(), cx);
    visual.update(|window, cx| {
        settings.update(cx, |s, cx| s.meetings_page_shown(window, cx));
        window.refresh();
        window.draw(cx).clear();
    });
    (settings, meetings, visual, fixture)
}

fn read(meetings: &Entity<Meetings>, cx: &mut VisualTestContext) -> MeetingSettings {
    meetings.read_with(cx, |m, _| m.settings().clone())
}

fn choose(
    settings: &Entity<SettingsWindow>,
    menu: MeetingsMenu,
    index: usize,
    cx: &mut VisualTestContext,
) {
    cx.update(|window, cx| {
        settings.update(cx, |s, cx| s.meetings_choose(menu, index, window, cx));
    });
}

#[test]
fn the_page_is_registered_after_the_recording_pages() {
    assert_eq!(Page::from_slug("meetings"), Some(Page::Meetings));
    let screenshots = Page::ALL
        .iter()
        .position(|p| *p == Page::Screenshots)
        .unwrap();
    assert_eq!(Page::ALL[screenshots + 1], Page::Meetings);
}

#[gpui::test]
fn every_toggle_round_trips_through_the_page(cx: &mut TestAppContext) {
    let (settings, meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    for flag in Flag::ALL {
        let before = flag.get(&read(&meetings, &mut cx));
        settings.update(&mut cx, |s, cx| s.meetings_toggle_flag(flag, cx));
        let after = read(&meetings, &mut cx);
        assert_eq!(flag.get(&after), !before, "{flag:?}");
        assert_eq!(
            flag.get(&settings.read_with(&mut cx, |s, _| s.pages.meetings.settings.clone())),
            !before,
            "{flag:?} cache"
        );
    }
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

fn live_on_page(settings: &Entity<SettingsWindow>, cx: &mut VisualTestContext) -> bool {
    settings.read_with(cx, |s, _| s.meetings_live())
}

#[gpui::test]
fn the_live_switch_is_unchanged_on_a_capable_computer(cx: &mut TestAppContext) {
    let mut initial = MeetingSettings::default();
    initial.transcription.engine = Engine::Cloud;
    let (settings, meetings, mut cx, _dir) = open(cx, initial);
    settings.update(&mut cx, |s, _| {
        s.pages.meetings.cloud = CloudState::Available
    });
    assert!(
        live_on_page(&settings, &mut cx),
        "on with Cap Cloud, as before"
    );
    settings.update(&mut cx, |s, cx| s.meetings_toggle_live(cx));
    let saved = read(&meetings, &mut cx);
    assert!(!saved.transcription.live);
    assert_eq!(saved.transcription.live_on_slow_cloud, None);
    assert!(!live_on_page(&settings, &mut cx));
}

#[gpui::test]
fn the_live_switch_starts_off_with_cap_cloud_on_a_slow_computer(cx: &mut TestAppContext) {
    crate::meetings::device::TEST_CLASS.with(|c| c.set(crate::meetings::device::Class::IntelMac));
    let mut initial = MeetingSettings::default();
    initial.transcription.engine = Engine::Cloud;
    let (settings, meetings, mut cx, _dir) = open(cx, initial);
    settings.update(&mut cx, |s, _| {
        s.pages.meetings.cloud = CloudState::Available
    });
    assert!(
        !live_on_page(&settings, &mut cx),
        "off by default with Cap Cloud"
    );
    settings.update(&mut cx, |s, cx| s.meetings_toggle_live(cx));
    let saved = read(&meetings, &mut cx);
    assert_eq!(
        saved.transcription.live_on_slow_cloud,
        Some(true),
        "turned back on"
    );
    assert!(saved.transcription.live, "the local choice is untouched");
    assert!(live_on_page(&settings, &mut cx));

    settings.update(&mut cx, |s, _| s.pages.meetings.cloud = CloudState::Free);
    assert!(
        live_on_page(&settings, &mut cx),
        "without Cap Cloud the local switch shows"
    );
    settings.update(&mut cx, |s, cx| s.meetings_toggle_live(cx));
    let saved = read(&meetings, &mut cx);
    assert!(!saved.transcription.live);
    assert_eq!(saved.transcription.live_on_slow_cloud, Some(true));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    crate::meetings::device::TEST_CLASS.with(|c| c.set(crate::meetings::device::Class::Capable));
}

#[gpui::test]
fn every_menu_choice_lands_in_the_settings(cx: &mut TestAppContext) {
    let (settings, meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    for (index, secs) in LEAD_OPTIONS.iter().enumerate() {
        choose(&settings, MeetingsMenu::Lead, index, &mut cx);
        assert_eq!(read(&meetings, &mut cx).notifications.lead_secs, *secs);
    }
    for (index, value) in AUTO_RECORD.iter().enumerate() {
        choose(&settings, MeetingsMenu::AutoRecord, index, &mut cx);
        assert_eq!(read(&meetings, &mut cx).automation.auto_record, *value);
    }
    for (index, secs) in COUNTDOWN_OPTIONS.iter().enumerate() {
        choose(&settings, MeetingsMenu::Countdown, index, &mut cx);
        assert_eq!(read(&meetings, &mut cx).automation.countdown_secs, *secs);
    }
    for (index, value) in SILENCE_OPTIONS.iter().enumerate() {
        choose(&settings, MeetingsMenu::Silence, index, &mut cx);
        assert_eq!(
            read(&meetings, &mut cx).recording.inactivity_minutes,
            *value
        );
    }
    for (index, value) in RETENTION_OPTIONS.iter().enumerate() {
        choose(&settings, MeetingsMenu::Retention, index, &mut cx);
        assert_eq!(
            read(&meetings, &mut cx).recording.audio_retention_days,
            *value
        );
    }
    for (index, (code, _)) in CAPTION_LANGUAGES.iter().enumerate() {
        choose(&settings, MeetingsMenu::Language, index, &mut cx);
        let expected = if *code == "auto" {
            Language::Auto
        } else {
            Language::Code((*code).to_string())
        };
        assert_eq!(read(&meetings, &mut cx).transcription.language, expected);
    }
    choose(&settings, MeetingsMenu::NotesLanguage, 0, &mut cx);
    assert_eq!(read(&meetings, &mut cx).notes.summary_language, None);
    for (index, code) in notes_languages().into_iter().enumerate() {
        choose(&settings, MeetingsMenu::NotesLanguage, index + 1, &mut cx);
        assert_eq!(
            read(&meetings, &mut cx).notes.summary_language.as_deref(),
            Some(code)
        );
    }
    let templates = settings.read_with(&mut cx, |s, _| s.pages.meetings.templates.clone());
    assert!(templates.len() > 1);
    for (index, template) in templates.iter().enumerate() {
        choose(&settings, MeetingsMenu::Template, index, &mut cx);
        assert_eq!(
            read(&meetings, &mut cx).notes.default_template_id,
            template.id
        );
    }

    settings.update(&mut cx, |s, _| {
        s.pages.meetings.microphones = vec!["Desk Mic".into(), "Headset".into()];
    });
    choose(&settings, MeetingsMenu::Microphone, 2, &mut cx);
    assert_eq!(
        read(&meetings, &mut cx).recording.microphone,
        Microphone::Named("Headset".into())
    );
    choose(&settings, MeetingsMenu::Microphone, 0, &mut cx);
    assert_eq!(
        read(&meetings, &mut cx).recording.microphone,
        Microphone::Auto
    );
}

#[gpui::test]
fn muted_apps_corners_policy_engine_and_vocabulary_round_trip(cx: &mut TestAppContext) {
    let (settings, meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    let first = muted_candidates(&read(&meetings, &mut cx))[0].id;
    choose(&settings, MeetingsMenu::AddApp, 0, &mut cx);
    assert_eq!(
        read(&meetings, &mut cx).notifications.muted_app_ids,
        vec![first.to_string()]
    );
    assert!(
        muted_candidates(&read(&meetings, &mut cx))
            .iter()
            .all(|app| app.id != first),
        "a muted app is not offered again"
    );
    settings.update(&mut cx, |s, cx| s.meetings_unmute(first, cx));
    assert!(
        read(&meetings, &mut cx)
            .notifications
            .muted_app_ids
            .is_empty()
    );

    for corner in CORNERS {
        settings.update(&mut cx, |s, cx| s.meetings_set_corner(corner, cx));
        assert_eq!(read(&meetings, &mut cx).notifications.position, corner);
    }
    settings.update(&mut cx, |s, cx| {
        s.meetings_set_corner(PromptPosition::TopRight, cx)
    });

    settings.update(&mut cx, |s, cx| {
        s.meetings_set_browser_policy(BrowserPolicy::RecognisedOnly, cx)
    });
    assert_eq!(
        read(&meetings, &mut cx).automation.browser_policy,
        BrowserPolicy::RecognisedOnly
    );

    settings.update(&mut cx, |s, cx| s.meetings_set_engine(Engine::Cloud, cx));
    assert_eq!(read(&meetings, &mut cx).transcription.engine, Engine::Cloud);
    settings.update(&mut cx, |s, cx| s.meetings_set_engine(Engine::Local, cx));
    assert_eq!(read(&meetings, &mut cx).transcription.engine, Engine::Local);

    settings.update(&mut cx, |s, cx| {
        s.pages.meetings.vocab_draft = "Ana Ruiz,  Northwind , ana ruiz".into();
        s.meetings_add_term(cx);
    });
    assert_eq!(
        read(&meetings, &mut cx).transcription.vocabulary,
        vec![
            "Cap".to_string(),
            "Ana Ruiz".to_string(),
            "Northwind".to_string()
        ],
        "the dictionary starts with Cap and merges the same name typed twice"
    );
    let long = "x".repeat(200);
    settings.update(&mut cx, |s, cx| {
        s.pages.meetings.vocab_draft = long.clone();
        s.meetings_add_term(cx);
        s.meetings_remove_term("Northwind", cx);
    });
    let vocabulary = read(&meetings, &mut cx).transcription.vocabulary;
    assert_eq!(vocabulary.len(), 3);
    assert_eq!(vocabulary[2].chars().count(), 64);
    settings.update(&mut cx, |s, cx| {
        s.pages.meetings.vocab_draft = (0..300)
            .map(|i| format!("t{i}"))
            .collect::<Vec<_>>()
            .join(",");
        s.meetings_add_term(cx);
    });
    assert_eq!(
        read(&meetings, &mut cx).transcription.vocabulary.len(),
        MAX_VOCABULARY
    );

    settings.update(&mut cx, |s, cx| s.meetings_toggle_calendar("cal-1", cx));
    assert_eq!(
        read(&meetings, &mut cx).calendar.hidden_calendar_ids,
        vec!["cal-1".to_string()]
    );
    settings.update(&mut cx, |s, cx| s.meetings_toggle_calendar("cal-1", cx));
    assert!(
        read(&meetings, &mut cx)
            .calendar
            .hidden_calendar_ids
            .is_empty()
    );
}

#[gpui::test]
fn turning_on_before_setup_does_not_enable_silently(cx: &mut TestAppContext) {
    let (settings, meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    let before = crate::meetings_ui::setup::OPEN_REQUESTS.with(|c| c.get());
    settings.update(&mut cx, |s, cx| s.meetings_set_enabled(true, cx));
    cx.run_until_parked();
    assert!(!read(&meetings, &mut cx).enabled);
    assert_eq!(
        crate::meetings_ui::setup::OPEN_REQUESTS.with(|c| c.get()),
        before + 1,
        "the setup flow opens instead"
    );

    meetings.update(&mut cx, |m, cx| {
        m.update_settings(
            |s| {
                s.setup_completed = true;
                s.notifications.detected = false;
                s.notifications.scheduled = false;
            },
            cx,
        )
    });
    settings.update(&mut cx, |s, cx| s.meetings_set_enabled(true, cx));
    assert!(read(&meetings, &mut cx).enabled);
    settings.update(&mut cx, |s, cx| s.meetings_set_enabled(false, cx));
    assert!(!read(&meetings, &mut cx).enabled);
}

#[gpui::test]
fn calendar_links_are_added_rejected_and_removed(cx: &mut TestAppContext) {
    let (settings, meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    settings.update(&mut cx, |s, cx| {
        s.pages.meetings.url_draft = "not a link".into();
        s.meetings_add_link(cx);
    });
    assert!(matches!(
        settings.read_with(&mut cx, |s, _| s.pages.meetings.add_error.clone()),
        Some(crate::meetings::CalendarError::InvalidUrl(_))
    ));
    assert!(meetings.read_with(&mut cx, |m, _| m.calendar_sources().is_empty()));

    settings.update(&mut cx, |s, cx| {
        s.pages.meetings.link_form = true;
        s.pages.meetings.url_draft = "webcal://127.0.0.1:9/team.ics".into();
        s.pages.meetings.name_draft = "Team".into();
        s.meetings_add_link(cx);
    });
    let (added, form, error) = settings.read_with(&mut cx, |s, _| {
        (
            s.pages.meetings.added.clone(),
            s.pages.meetings.link_form,
            s.pages.meetings.add_error.clone(),
        )
    });
    assert!(error.is_none());
    assert!(!form);
    let id = added.unwrap();
    let sources = meetings.read_with(&mut cx, |m, _| m.calendar_sources().to_vec());
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].name, "Team");

    settings.update(&mut cx, |s, cx| {
        s.pages.meetings.url_draft = "https://127.0.0.1:9/team.ics".into();
        s.meetings_add_link(cx);
    });
    assert_eq!(
        settings.read_with(&mut cx, |s, _| s.pages.meetings.add_error.clone()),
        Some(crate::meetings::CalendarError::Duplicate)
    );

    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });

    settings.update(&mut cx, |s, cx| s.meetings_remove_calendar(&id, cx));
    assert!(meetings.read_with(&mut cx, |m, _| m.calendar_sources().is_empty()));
    assert!(settings.read_with(&mut cx, |s, _| s.pages.meetings.added.is_none()));
}

#[gpui::test]
fn leaving_the_page_holds_no_timers(cx: &mut TestAppContext) {
    let (settings, _meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    cx.run_until_parked();
    cx.update(|window, cx| {
        settings.update(cx, |s, cx| s.set_page(Page::General, window, cx));
    });
    cx.run_until_parked();
    settings.read_with(&mut cx, |s, _| {
        assert!(s.pages.meetings.download_tick.is_none());
        assert!(s.pages.meetings.sweep.is_none());
        assert!(s.pages.meetings.calendar_request.is_none());
    });
}

#[gpui::test]
fn the_voice_row_shows_what_was_learnt_and_forgetting_removes_it(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice-profile.json");
    crate::meetings::speakers::TEST_PROFILE_PATH.with(|p| *p.borrow_mut() = Some(path.clone()));
    let (settings, _meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    settings.update(&mut cx, |s, _| s.meetings_refresh_voice());
    assert_eq!(
        settings.read_with(&mut cx, |s, _| s.pages.meetings.voice_meetings),
        None,
        "nothing learnt, no forget button"
    );
    let mut profile = cap_diarize::VoiceProfile::new("model", &[1.0, 0.0], 20_000);
    profile.meetings = 3;
    profile.save(&path).unwrap();
    settings.update(&mut cx, |s, _| s.meetings_refresh_voice());
    assert_eq!(
        settings.read_with(&mut cx, |s, _| s.pages.meetings.voice_meetings),
        Some(3)
    );
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    settings.update(&mut cx, |s, cx| s.meetings_forget_voice(cx));
    assert!(!path.exists(), "the profile file is deleted");
    assert_eq!(
        settings.read_with(&mut cx, |s, _| s.pages.meetings.voice_meetings),
        None
    );
    crate::meetings::speakers::TEST_PROFILE_PATH.with(|p| *p.borrow_mut() = None);
}

#[test]
fn cap_notes_asks_for_one_model_and_the_one_that_writes_the_language() {
    use super::shared::{NotesModelWhy, notes_model};
    let mut settings = MeetingSettings::default();
    let tuned = notes_model(&settings);
    if crate::transcription::supports_parakeet() {
        assert_eq!(tuned.model.name, crate::meetings::NOTES_MODEL);
        assert_eq!(tuned.why, NotesModelWhy::Tuned);
        for code in ["en", "de", "uk"] {
            settings.transcription.language = Language::Code(code.into());
            assert_eq!(notes_model(&settings).why, NotesModelWhy::Tuned, "{code}");
        }
        settings.transcription.language = Language::Code("ja".into());
        let other = notes_model(&settings);
        assert_eq!(other.model.name, crate::meetings::NOTES_FALLBACK_MODEL);
        assert_eq!(other.why, NotesModelWhy::Language);
    } else {
        assert_eq!(tuned.model.name, crate::meetings::NOTES_FALLBACK_MODEL);
        assert_eq!(tuned.why, NotesModelWhy::NeedsAppleSilicon);
    }
}

#[gpui::test]
fn use_cap_cloud_on_a_slow_computer_switches_the_engine(cx: &mut TestAppContext) {
    use super::shared::{CloudAction, cloud_action};
    crate::meetings::device::TEST_CLASS.with(|c| c.set(crate::meetings::device::Class::IntelMac));
    assert_eq!(
        cloud_action(CloudState::Available),
        Some(CloudAction::UseCloud)
    );
    assert_eq!(cloud_action(CloudState::Free), Some(CloudAction::Upgrade));
    assert_eq!(
        cloud_action(CloudState::SignedOut),
        Some(CloudAction::SignIn)
    );
    assert_eq!(cloud_action(CloudState::Checking), None);
    let (settings, meetings, mut cx, _dir) = open(cx, MeetingSettings::default());
    settings.update(&mut cx, |s, _| {
        s.pages.meetings.cloud = CloudState::Available
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert_eq!(read(&meetings, &mut cx).transcription.engine, Engine::Local);
    settings.update(&mut cx, |s, cx| {
        s.meetings_run_cloud_action(CloudAction::UseCloud, cx)
    });
    let saved = read(&meetings, &mut cx);
    assert_eq!(saved.transcription.engine, Engine::Cloud);
    assert!(
        !saved.transcription.live_for(Engine::Cloud, true),
        "and the live transcript is off there by default"
    );
    crate::meetings::device::TEST_CLASS.with(|c| c.set(crate::meetings::device::Class::Capable));
}
