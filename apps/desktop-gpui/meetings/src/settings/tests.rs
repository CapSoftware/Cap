use super::*;

#[test]
fn defaults_match_the_spec() {
    let s = MeetingSettings::default();
    assert!(!s.enabled);
    assert!(!s.setup_completed);
    assert!(s.notifications.scheduled);
    assert_eq!(s.notifications.lead_secs, 60);
    assert!(s.notifications.detected);
    assert_eq!(s.notifications.position, PromptPosition::TopRight);
    assert!(s.notifications.sound && s.notifications.show_join);
    assert_eq!(s.automation.auto_record, AutoRecord::Off);
    assert_eq!(s.automation.countdown_secs, 5);
    assert!(s.automation.bring_up_window);
    assert!(s.automation.show_cap_on_close);
    assert_eq!(s.automation.browser_policy, BrowserPolicy::Any);
    assert!(s.recording.stop_when_call_ends);
    assert_eq!(s.recording.inactivity_minutes, Some(10));
    assert!(s.recording.keep_audio);
    assert_eq!(s.recording.audio_retention_days, None);
    assert_eq!(s.recording.microphone, Microphone::Auto);
    assert!(s.recording.show_indicator && s.recording.sounds);
    assert!(!s.recording.pause_media_on_join);
    assert_eq!(s.transcription.engine, Engine::Local);
    assert_eq!(s.transcription.language, Language::Auto);
    assert!(s.transcription.live);
    assert!(s.notes.auto_generate);
    assert_eq!(s.notes.default_template_id, "general");
    assert!(s.calendar.show_next_in_menu_bar);
    assert!(s.calendar.hide_declined && s.calendar.hide_all_day);
    assert!(!s.calendar.hide_without_participants);
}

#[test]
fn empty_partial_and_unknown_json_loads() {
    assert_eq!(MeetingSettings::from_json("{}"), MeetingSettings::default());
    assert_eq!(
        MeetingSettings::from_json("garbage"),
        MeetingSettings::default()
    );
    let s = MeetingSettings::from_json(
        r#"{
            "enabled": true,
            "futureTopLevel": {"x": 1},
            "notifications": {"leadSecs": 120, "position": "middleCentre", "newThing": true},
            "automation": {"autoRecord": "both", "browserPolicy": "recognisedOnly"},
            "recording": {"microphone": {"kind": "named", "name": "Shure MV7"}},
            "transcription": {"engine": "quantum", "language": {"kind": "code", "code": "de"}},
            "calendar": "not an object"
        }"#,
    );
    assert!(s.enabled);
    assert_eq!(s.notifications.lead_secs, 120);
    assert_eq!(s.notifications.position, PromptPosition::TopRight);
    assert!(s.notifications.scheduled);
    assert_eq!(s.automation.auto_record, AutoRecord::Both);
    assert_eq!(s.automation.browser_policy, BrowserPolicy::RecognisedOnly);
    assert_eq!(
        s.recording.microphone,
        Microphone::Named("Shure MV7".into())
    );
    assert_eq!(s.transcription.engine, Engine::Local);
    assert_eq!(s.transcription.language, Language::Code("de".into()));
    assert_eq!(s.calendar, CalendarSettings::default());
}

#[test]
fn round_trip_is_camel_case() {
    let mut s = MeetingSettings {
        enabled: true,
        ..MeetingSettings::default()
    };
    s.recording.microphone = Microphone::Named("USB".into());
    s.transcription.language = Language::Code("fr".into());
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"leadSecs\":60"));
    assert!(json.contains("\"stopWhenCallEnds\":true"));
    assert!(json.contains("\"autoRecord\":\"off\""));
    assert_eq!(MeetingSettings::from_json(&json), s);
}

#[test]
fn validate_clamps_and_cleans() {
    let mut s = MeetingSettings::default();
    s.notifications.lead_secs = 10_000;
    s.notifications.muted_app_ids = vec!["zoom".into(), " zoom ".into(), "".into(), "teams".into()];
    s.automation.countdown_secs = 0;
    s.recording.inactivity_minutes = Some(0);
    s.recording.audio_retention_days = Some(0);
    s.recording.microphone = Microphone::Named("  ".into());
    s.transcription.local_model = " ".into();
    s.transcription.language = Language::Code(" AUTO ".into());
    s.transcription.dictionary = Some(
        ["Cap", "cap", "  ", &"x".repeat(100), "Multi   word  term"]
            .iter()
            .map(|t| Entry::new(*t))
            .collect(),
    );
    s.notes.default_template_id = "".into();
    s.notes.summary_language = Some("  ".into());
    s.calendar.hidden_calendar_ids = vec!["a".into(), "a".into()];
    s.validate();
    assert_eq!(s.notifications.lead_secs, 900);
    assert_eq!(s.notifications.muted_app_ids, vec!["zoom", "teams"]);
    assert_eq!(s.automation.countdown_secs, 1);
    assert_eq!(s.recording.inactivity_minutes, Some(1));
    assert_eq!(s.recording.audio_retention_days, Some(1));
    assert_eq!(s.recording.microphone, Microphone::Auto);
    assert_eq!(s.transcription.local_model, DEFAULT_LOCAL_MODEL);
    assert_eq!(s.transcription.language, Language::Auto);
    assert_eq!(s.transcription.vocabulary.len(), 3);
    assert_eq!(
        s.transcription.vocabulary[1].chars().count(),
        MAX_VOCABULARY_TERM_CHARS
    );
    assert_eq!(s.transcription.vocabulary[2], "Multi word term");
    assert_eq!(s.notes.default_template_id, "general");
    assert_eq!(s.notes.summary_language, None);
    assert_eq!(s.calendar.hidden_calendar_ids, vec!["a"]);

    let mut many = MeetingSettings::default();
    many.transcription.dictionary =
        Some((0..500).map(|i| Entry::new(format!("term{i}"))).collect());
    many.validate();
    assert_eq!(many.transcription.vocabulary.len(), MAX_VOCABULARY);
    assert_eq!(many.transcription.entries().len(), MAX_VOCABULARY);
}

#[test]
fn converters_feed_the_state_machines() {
    let mut s = MeetingSettings {
        enabled: true,
        ..MeetingSettings::default()
    };
    s.notifications.lead_secs = 300;
    s.notifications.muted_app_ids = vec!["slack".into()];
    s.automation.auto_record = AutoRecord::Detected;
    s.automation.countdown_secs = 10;
    s.automation.browser_policy = BrowserPolicy::RecognisedOnly;
    s.recording.stop_when_call_ends = false;
    s.recording.inactivity_minutes = None;
    s.notes.auto_generate = false;

    let p = s.prompt_config();
    assert!(p.detected_enabled && p.scheduled_enabled);
    assert_eq!(p.lead_ms, 300_000);
    assert_eq!(p.auto_record, AutoRecord::Detected);
    assert_eq!(p.auto_record_countdown_ms, 10_000);
    assert_eq!(p.muted_app_ids, vec!["slack"]);

    let d = s.detect_config();
    assert_eq!(d.browser_policy, BrowserPolicy::RecognisedOnly);
    assert_eq!(d.start_hold_ms, 2_000);

    let c = s.session_config();
    assert!(!c.stop_when_call_ends);
    assert_eq!(c.inactivity_warn_ms, None);
    assert!(!c.auto_generate_notes);

    s.enabled = false;
    let p = s.prompt_config();
    assert!(!p.detected_enabled && !p.scheduled_enabled);
    assert_eq!(p.auto_record, AutoRecord::Off);

    let defaults = MeetingSettings::default().session_config();
    assert_eq!(defaults.inactivity_warn_ms, Some(600_000));
}

#[test]
fn old_word_lists_become_the_dictionary_with_cap_added_once() {
    let s = MeetingSettings::from_json(
        r#"{"transcription": {"vocabulary": ["Anthropic", "Siobhan", "cap"]}}"#,
    );
    let t = &s.transcription;
    assert_eq!(t.vocabulary, vec!["Anthropic", "Siobhan", "cap"]);
    assert_eq!(
        t.entries()[2],
        Entry::new("cap").with_sounds_like(&["Kap", "Capp", "Kapp"])
    );
    assert_eq!(t.builtins_added, vec!["Cap"]);

    let s = MeetingSettings::from_json(r#"{"transcription": {"vocabulary": ["Anthropic"]}}"#);
    assert_eq!(s.transcription.vocabulary, vec!["Cap", "Anthropic"]);
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"dictionary\""));
    assert!(json.contains("\"soundsLike\":[\"Kap\",\"Capp\",\"Kapp\"]"));
    assert_eq!(MeetingSettings::from_json(&json), s);
}

#[test]
fn a_removed_builtin_stays_removed() {
    let mut s = MeetingSettings::default();
    assert_eq!(s.transcription.vocabulary, vec!["Cap"]);
    s.transcription.dictionary = Some(vec![Entry::new("Anthropic")]);
    s.validate();
    let json = serde_json::to_string(&s).unwrap();
    let back = MeetingSettings::from_json(&json);
    assert_eq!(back.transcription.vocabulary, vec!["Anthropic"]);
    assert_eq!(back, s);
}

#[test]
fn caption_words_join_once_without_the_examples() {
    let mut s = MeetingSettings::default();
    s.transcription.adopt_hints(&[
        "Cap".into(),
        "TypeScript".into(),
        "My Brand Name".into(),
        "mywebsite.com".into(),
        "Acme".into(),
    ]);
    assert_eq!(
        s.transcription.vocabulary,
        vec!["Cap", "TypeScript", "Acme"]
    );
}

#[test]
fn the_start_choice_is_remembered_and_older_files_start_by_recording() {
    let old = MeetingSettings::from_json(r#"{"notes": {"autoGenerate": false}}"#);
    assert_eq!(old.notes.start, StartChoice::Record);
    assert!(!old.notes.auto_generate);
    let mut s = MeetingSettings::default();
    s.notes.start = StartChoice::Blank;
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains(r#""start":"blank""#), "{json}");
    assert_eq!(
        MeetingSettings::from_json(&json).notes.start,
        StartChoice::Blank
    );
    let newer = MeetingSettings::from_json(
        r#"{"enabled": true, "notes": {"start": "somethingNew", "autoGenerate": false}}"#,
    );
    assert!(newer.enabled, "an unknown choice never resets the rest");
    assert!(!newer.notes.auto_generate);
    assert_eq!(newer.notes.start, StartChoice::Record);
}

#[test]
fn the_live_transcript_defaults_off_only_for_cap_cloud_on_a_slow_computer() {
    let s = TranscriptionSettings::default();
    for (engine, slow, live) in [
        (Engine::Local, false, true),
        (Engine::Cloud, false, true),
        (Engine::Local, true, true),
        (Engine::Cloud, true, false),
    ] {
        assert_eq!(s.live_for(engine, slow), live, "{engine:?} slow={slow}");
    }
    let off = TranscriptionSettings {
        live: false,
        ..TranscriptionSettings::default()
    };
    assert!(
        !off.live_for(Engine::Cloud, false),
        "a capable computer keeps the choice"
    );
    assert!(!off.live_for(Engine::Local, true));
}

#[test]
fn turning_the_live_transcript_on_with_cap_cloud_on_a_slow_computer_sticks() {
    let mut s = MeetingSettings::default();
    s.transcription.set_live_for(Engine::Cloud, true, true);
    assert!(
        s.transcription.live,
        "the everywhere-else choice is untouched"
    );
    assert_eq!(s.transcription.live_on_slow_cloud, Some(true));
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains(r#""liveOnSlowCloud":true"#), "{json}");
    let back = MeetingSettings::from_json(&json);
    assert!(back.transcription.live_for(Engine::Cloud, true));

    let mut t = TranscriptionSettings::default();
    t.set_live_for(Engine::Local, true, false);
    assert!(!t.live);
    assert_eq!(t.live_on_slow_cloud, None);
    t.set_live_for(Engine::Cloud, false, false);
    assert_eq!(
        t.live_on_slow_cloud, None,
        "only a slow computer's Cap Cloud choice"
    );
}

#[test]
fn settings_without_the_slow_cloud_choice_write_nothing_new() {
    let json = serde_json::to_string(&MeetingSettings::default()).unwrap();
    assert!(!json.contains("liveOnSlowCloud"), "{json}");
}

#[test]
fn user_entries_leave_out_what_cap_added_itself() {
    assert!(
        MeetingSettings::default()
            .transcription
            .user_entries()
            .is_empty()
    );

    let mut t = TranscriptionSettings::default();
    let mut entries = t.entries().to_vec();
    entries.push(Entry::new("Acme"));
    dictionary::learn(&mut entries, "Cap", "Kappa");
    t.dictionary = Some(entries);
    let mine = t.user_entries();
    assert_eq!(mine.len(), 2, "{mine:?}");
    assert_eq!(mine[0].spelling, "Cap");
    assert_eq!(mine[0].sounds_like, vec!["Kappa".to_string()]);
    assert_eq!(mine[1], Entry::new("Acme"));
}
