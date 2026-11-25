use chrono::{Duration, Utc};

use cap_calendar::link::{MeetingLink, Provider};
use cap_meetings::Millis;
use cap_meetings::apps::{AppKind, CallNoun};
use cap_meetings::detect::ActiveCall;
use cap_meetings::prompt::{Countdown, EventInfo, Prompt, PromptKind, PromptSubtitle};
use cap_meetings::settings::PromptPosition;

use super::model::{self, PromptLine, PromptPrimary, PromptTitle, Rect};
use crate::meetings::CalendarEvent;

fn event(id: &str, minutes: i64, length: i64, link: bool) -> CalendarEvent {
    let start = Utc::now() + Duration::minutes(minutes);
    CalendarEvent {
        id: id.into(),
        calendar_id: "cal".into(),
        title: format!("Event {id}"),
        start,
        end: start + Duration::minutes(length),
        link: link.then(|| MeetingLink {
            provider: Provider::Zoom,
            url: format!("https://example.com/{id}"),
            meeting_id: None,
        }),
        ..CalendarEvent::default()
    }
}

fn call(app_id: &str, noun: CallNoun) -> ActiveCall {
    ActiveCall {
        app_id: app_id.into(),
        app_name: "Zoom".into(),
        kind: AppKind::Meeting,
        call_noun: noun,
        started_at: Millis(0),
        pids: Vec::new(),
        web: None,
    }
}

fn detected(app_id: &str) -> Prompt {
    Prompt {
        id: 1,
        kind: PromptKind::Detected,
        title: "Meeting detected".into(),
        subtitle: PromptSubtitle::App("Zoom".into()),
        detail: None,
        app_id: Some(app_id.into()),
        app_name: Some("Zoom".into()),
        event: None,
        countdown: None,
        shown_at: Millis(0),
    }
}

fn scheduled(event: &CalendarEvent) -> Prompt {
    Prompt {
        id: 2,
        kind: PromptKind::Scheduled,
        title: event.title.clone(),
        subtitle: PromptSubtitle::TimeRange {
            start: event.start,
            end: event.end,
        },
        detail: None,
        app_id: None,
        app_name: None,
        event: Some(EventInfo {
            id: crate::meetings::calendar::event_key(event),
            title: event.title.clone(),
            start: event.start,
            end: event.end,
            has_link: event.link.is_some(),
            link_provider_name: None,
            attendee_count: 2,
        }),
        countdown: None,
        shown_at: Millis(0),
    }
}

#[test]
fn elapsed_and_short_titles_read_naturally() {
    assert_eq!(model::elapsed(0), "0:00");
    assert_eq!(model::elapsed(754), "12:34");
    assert_eq!(model::elapsed(3723), "1:02:03");
    assert_eq!(model::short_title("Design review", 12), "Design revi…");
    assert_eq!(model::short_title("Standup", 12), "Standup");
}

#[test]
fn detected_prompt_takes_the_call_noun_and_offers_notes() {
    let prompt = detected("slack");
    let view = model::prompt_view(
        &prompt,
        &[call("slack", CallNoun::Huddle)],
        &[],
        true,
        None,
        Utc::now(),
    );
    assert_eq!(view.title, PromptTitle::Detected(CallNoun::Huddle));
    assert_eq!(view.line, PromptLine::App("Zoom".into()));
    assert_eq!(view.primary, PromptPrimary::TakeNotes);
    assert_eq!(view.mutable_app, Some(("slack".into(), "Zoom".into())));
    assert!(view.join_url.is_none());
}

#[test]
fn scheduled_prompt_counts_down_and_offers_join_only_with_a_link() {
    let now = Utc::now();
    let linked = event("a", 1, 30, true);
    let view = model::prompt_view(&scheduled(&linked), &[], &[linked.clone()], true, None, now);
    assert_eq!(view.title, PromptTitle::Event("Event a".into()));
    assert!(matches!(view.line, PromptLine::StartsIn(secs) if (55..=60).contains(&secs)));
    assert_eq!(view.primary, PromptPrimary::JoinAndTakeNotes);
    assert_eq!(view.join_url.as_deref(), Some("https://example.com/a"));

    let hidden = model::prompt_view(
        &scheduled(&linked),
        &[],
        &[linked.clone()],
        false,
        None,
        now,
    );
    assert_eq!(hidden.primary, PromptPrimary::TakeNotes);

    let plain = event("b", 1, 30, false);
    let view = model::prompt_view(&scheduled(&plain), &[], &[plain.clone()], true, None, now);
    assert_eq!(view.primary, PromptPrimary::TakeNotes);
}

#[test]
fn auto_record_prompt_shows_the_countdown_on_the_button() {
    let mut prompt = detected("zoom");
    prompt.countdown = Some(Countdown {
        started_at: Millis(0),
        ends_at: Millis(5000),
    });
    let view = model::prompt_view(&prompt, &[], &[], true, Some(4), Utc::now());
    assert_eq!(view.primary, PromptPrimary::RecordingIn(4));
    assert!(view.auto);
}

#[test]
fn prompts_stack_from_the_chosen_corner_below_the_menu_bar() {
    let visible = Rect::new(0., 25., 1512., 957.);
    let frames = model::prompt_frames(visible, PromptPosition::TopRight, &[92., 92.]);
    assert_eq!(frames[0], Rect::new(1512. - 16. - 380., 41., 380., 92.));
    assert_eq!(frames[1].y, frames[0].y + 92. + 10.);
    let open = model::prompt_menu_height(4);
    let grown = model::prompt_frames(visible, PromptPosition::TopRight, &[open, 92.]);
    assert_eq!(grown[0].y, frames[0].y);
    assert_eq!(grown[1].y, grown[0].y + open + 10.);
    let bottom = model::prompt_frames(visible, PromptPosition::BottomLeft, &[92., 92.]);
    assert_eq!(bottom[1].x, 16.);
    assert_eq!(bottom[1].y, 25. + 957. - 16. - 92. - 102.);
    assert_eq!(
        model::prompt_entry(frames[0], PromptPosition::TopRight).x,
        frames[0].x + 16.
    );
    assert_eq!(
        model::prompt_entry(bottom[1], PromptPosition::BottomLeft).x,
        bottom[1].x - 16.
    );
}

#[test]
fn indicator_stays_where_it_is_dropped_and_settles_near_edges() {
    let visible = Rect::new(0., 25., 1512., 957.);
    let (w, h, m) = (
        model::INDICATOR_WIDTH,
        model::INDICATOR_HEIGHT,
        model::INDICATOR_MARGIN,
    );
    // First time: against the right edge, a little below the middle.
    let frame = model::indicator_frame(visible, model::Dock::default(), w);
    assert_eq!(frame.x, 1512. - m - w);
    assert!((frame.y - (25. + m + (957. - 2. * m - h) * 0.62)).abs() < 0.01);
    // Dropped in the open: it stays exactly there.
    let dropped = Rect::new(600., 300., w, h);
    let dock = model::snap(visible, dropped);
    let again = model::indicator_frame(visible, dock, w);
    assert!((again.x - 600.).abs() < 0.01 && (again.y - 300.).abs() < 0.01);
    assert!(!dock.right());
    // Dropped near the left edge: it settles against it.
    let dock = model::snap(visible, Rect::new(30., 300., w, h));
    assert_eq!(dock.x, 0.);
    assert_eq!(model::indicator_frame(visible, dock, w).x, m);
    // Near the bottom right: into the corner.
    let dock = model::snap(
        visible,
        Rect::new(1512. - w - 20., 957. + 25. - h - 15., w, h),
    );
    assert_eq!((dock.x, dock.y), (1., 1.));
    // Dragged past the edge: kept on screen.
    let dock = model::snap(visible, Rect::new(-400., 2000., w, h));
    assert_eq!((dock.x, dock.y), (0., 1.));
}

#[test]
fn indicator_never_lands_off_a_smaller_display() {
    let big = Rect::new(0., 25., 2560., 1415.);
    let small = Rect::new(0., 25., 1280., 775.);
    for (x, y) in [(2300., 1300.), (10., 10.), (1200., 700.)] {
        let dock = model::snap(
            big,
            Rect::new(x, y, model::INDICATOR_WIDTH, model::INDICATOR_HEIGHT),
        );
        let frame = model::indicator_frame(small, dock, model::INDICATOR_EXPANDED_WIDTH);
        assert!(
            frame.x >= small.x && frame.x + frame.w <= small.x + small.w,
            "{frame:?}"
        );
        assert!(
            frame.y >= small.y && frame.y + frame.h <= small.y + small.h,
            "{frame:?}"
        );
    }
}

#[test]
fn a_press_that_barely_moves_is_a_click_not_a_drag() {
    assert!(!model::dragged((10., 10.), (12., 12.)));
    assert!(model::dragged((10., 10.), (14., 10.)));
}

#[test]
fn meter_is_still_in_silence_and_steps_with_speech() {
    assert_eq!(model::meter_step(0.0), 0);
    assert_eq!(model::meter_step(0.2), 0);
    assert_eq!(model::meter_step(f32::NAN), 0);
    let quiet = model::meter_step(0.4);
    let loud = model::meter_step(0.95);
    assert!(quiet >= 1);
    assert!(loud > quiet);
    assert_eq!(loud, model::METER_STEPS);
    assert_eq!(model::meter_bars(0), [0.; 3]);
    let bars = model::meter_bars(loud);
    assert!(bars.iter().all(|bar| *bar > 0.));
}

#[test]
fn context_prefers_a_live_call_and_otherwise_an_imminent_event() {
    let now = Utc::now();
    let soon = event("soon", 4, 30, true);
    let later = event("later", 40, 30, true);
    let events = vec![later.clone(), soon.clone()];

    let context = model::context(&[], &events, now).unwrap();
    assert!(context.call.is_none());
    assert_eq!(context.event.as_ref().unwrap().id, "cal|soon");

    let with_call = model::context(&[call("zoom", CallNoun::Meeting)], &events, now).unwrap();
    assert!(with_call.call.is_some());

    assert!(model::context(&[], &[later], now).is_none());
}

#[test]
fn coming_up_lists_the_rest_of_today_without_the_context_event() {
    // Local noon, so "the rest of today" holds every event below whenever
    // the test runs (just before midnight they would fall on tomorrow).
    let noon = chrono::Local::now()
        .date_naive()
        .and_hms_opt(12, 0, 0)
        .and_then(|t| t.and_local_timezone(chrono::Local).earliest())
        .map(|t| t.with_timezone(&Utc))
        .unwrap();
    let shift = noon - Utc::now();
    let events: Vec<CalendarEvent> = [
        event("past", -90, 30, false),
        event("a", 5, 30, false),
        event("b", 6, 30, false),
        event("c", 7, 30, false),
        event("d", 8, 30, false),
    ]
    .into_iter()
    .map(|mut event| {
        event.start += shift;
        event.end += shift;
        event
    })
    .collect();
    let rows = model::coming_up(&events, noon, Some("cal|a"), 2);
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, vec!["cal|b", "cal|c"]);
}

#[test]
fn imminence_and_minute_math() {
    let now = Utc::now();
    let soon = model::EventSummary::of(&event("x", 3, 30, false));
    assert!(model::imminent(&soon, now, model::MENU_BAR_LEAD_SECS));
    let far = model::EventSummary::of(&event("y", 30, 30, false));
    assert!(!model::imminent(&far, now, model::MENU_BAR_LEAD_SECS));
    assert_eq!(model::minutes_until(now + Duration::seconds(61), now), 2);
    assert_eq!(model::minutes_until(now - Duration::seconds(5), now), 0);
    let wait = model::next_minute_boundary(now);
    assert!(wait.as_millis() > 0 && wait.as_millis() <= 60_000);
}

#[test]
fn chime_is_short_and_soft() {
    let samples = super::chime::samples();
    let peak = samples.iter().fold(0f32, |peak, s| peak.max(s.abs()));
    assert!(peak > 0.1 && peak <= 0.17, "{peak}");
    assert!(samples.len() < 44_100);
    assert!(samples.last().is_some_and(|s| s.abs() < 1e-3));
}

#[gpui::test]
fn seeded_actions_route_through_the_live_hub(cx: &mut gpui::TestAppContext) {
    use crate::meetings::{StartSource, StopReason};

    cx.update(|cx| {
        super::init(cx);
        let live = super::Live::global(cx).unwrap();
        let mut prompt = detected("zoom");
        prompt.app_id = None;
        live.update(cx, |live, cx| {
            live.set_seed(
                Some(super::debug::Seed {
                    prompts: vec![prompt],
                    ..super::debug::Seed::default()
                }),
                cx,
            )
        });
        assert_eq!(super::prompts(cx).len(), 1);
        super::dismiss_prompt(1, cx);
        assert!(super::prompts(cx).is_empty());
        assert!(!super::recording(cx));
        let doc = super::start(StartSource::Manual, cx).unwrap();
        assert!(super::recording(cx));
        assert_eq!(super::active(cx).unwrap().doc_id, doc);
        super::stop(StopReason::User, cx);
        assert!(!super::recording(cx));
    });
}

#[gpui::test]
fn live_hub_without_the_meeting_service_is_inert(cx: &mut gpui::TestAppContext) {
    cx.update(|cx| {
        super::init(cx);
        assert!(super::settings(cx).is_none());
        assert!(!super::ready(cx));
        assert!(super::prompts(cx).is_empty());
        assert!(super::active(cx).is_none());
        assert!(super::start(crate::meetings::StartSource::Manual, cx).is_err());
        let menu = crate::tray::meetings::state(cx);
        assert!(!menu.enabled);
    });
}

#[test]
fn summaries_and_join_links_use_the_calendar_key() {
    let ev = event("abc", 3, 30, true);
    let summary = model::EventSummary::of(&ev);
    assert_eq!(summary.id, crate::meetings::calendar::event_key(&ev));
    assert_eq!(summary.id, "cal|abc");
    assert_eq!(
        model::event_link(&summary.id, std::slice::from_ref(&ev)).as_deref(),
        Some("https://example.com/abc")
    );
    assert!(model::event_link("abc", std::slice::from_ref(&ev)).is_none());
}

fn active(state: crate::meetings::ActiveState) -> crate::meetings::ActiveMeeting {
    crate::meetings::ActiveMeeting {
        doc_id: "live-doc".into(),
        title: "Standup".into(),
        started_at: Utc::now(),
        started: std::time::Instant::now(),
        state,
        mic: Default::default(),
        system: Default::default(),
        engine: Default::default(),
        warning: None,
        resume_offer_until: None,
        slept: false,
        resumed_after_sleep: false,
        app_name: None,
        event_id: None,
        health: Vec::new(),
        not_hearing: false,
        audio_failed: false,
        low_disk: false,
    }
}

#[test]
fn the_indicator_says_a_meeting_resumed_after_a_sleep_with_stop_at_hand() {
    use super::indicator::{Banner, banner, banner_title, countdown_until};
    use crate::meetings::{ActiveState, MeetingWarning};
    let mut live = active(ActiveState::Recording);
    assert_eq!(banner(&live), None);
    live.resumed_after_sleep = true;
    assert_eq!(banner(&live), Some(Banner::Resumed));
    assert_eq!(countdown_until(&live), None);
    assert!(!banner_title(Banner::Resumed).is_empty());
    live.warning = Some(MeetingWarning::Inactivity {
        stop_at: std::time::Instant::now(),
    });
    assert_eq!(banner(&live), Some(Banner::Inactivity));
    let mut starting = active(ActiveState::Starting);
    starting.resumed_after_sleep = true;
    assert_eq!(banner(&starting), None);
}

#[test]
fn the_indicator_shows_the_first_health_concern_in_short() {
    use crate::meetings::health::Concern;
    let mut live = active(crate::meetings::ActiveState::Recording);
    assert_eq!(super::indicator::health_text(&live), None);
    live.health = vec![Concern::NotHearingApp(Some("Zoom".into())), Concern::MicSilent];
    let text = super::indicator::health_text(&live).unwrap();
    assert!(text.contains("Zoom"), "{text}");
    live.health = vec![Concern::NoModel];
    assert_eq!(super::indicator::health_text(&live), None, "the notes window says this one");
}

#[test]
fn open_notes_lands_on_the_live_note_while_one_is_running() {
    use super::open_target;
    use crate::meetings::ActiveState;
    assert_eq!(open_target(None, None), None, "nothing running: home");
    for state in [
        ActiveState::Starting,
        ActiveState::Recording,
        ActiveState::Stopping,
    ] {
        let live = active(state);
        assert_eq!(open_target(None, Some(&live)).as_deref(), Some("live-doc"));
        assert_eq!(
            open_target(Some("other".into()), Some(&live)).as_deref(),
            Some("other"),
            "an explicit note wins"
        );
    }
    let offered = active(ActiveState::ResumeOffered);
    assert_eq!(open_target(None, Some(&offered)), None);
}

#[test]
fn the_main_row_is_only_there_when_a_meeting_matters() {
    use crate::meetings::ActiveState;
    let now = Utc::now();
    let far = event("far", 30, 30, false);
    assert_eq!(model::main_row(None, &[], &[far.clone()], true, now), None);
    assert_eq!(
        model::main_row(None, &[], &[event("soon", 3, 30, false)], false, now),
        None,
        "detection off: no offer"
    );

    let soon = event("soon", 3, 30, false);
    assert_eq!(
        model::main_row(None, &[], &[far.clone(), soon], true, now),
        Some(model::MainRow::Offer {
            title: "Event soon".into(),
            starts_in_minutes: Some(3),
            event_id: Some("cal|soon".into()),
        })
    );
    assert!(model::main_row(None, &[], &[event("six", 6, 30, false)], true, now).is_none());

    let zoom = call("zoom", CallNoun::Meeting);
    assert_eq!(
        model::main_row(None, std::slice::from_ref(&zoom), &[], true, now),
        Some(model::MainRow::Offer {
            title: "Zoom".into(),
            starts_in_minutes: None,
            event_id: None,
        })
    );

    let live = active(ActiveState::Recording);
    assert!(
        matches!(
            model::main_row(Some(&live), &[zoom], &[], false, now),
            Some(model::MainRow::Recording { ref title, .. }) if title == "Standup"
        ),
        "a recording shows even with detection off"
    );
    let stopping = active(ActiveState::Stopping);
    assert_eq!(model::main_row(Some(&stopping), &[], &[], false, now), None);
}

#[test]
fn the_main_row_only_wakes_when_its_text_can_change() {
    let now = Utc::now();
    assert_eq!(model::main_row_wake(None, &[], true, now), None);
    assert_eq!(
        model::main_row_wake(None, &[event("x", 30, 30, false)], false, now),
        None
    );
    let wake = model::main_row_wake(None, &[event("x", 30, 30, false)], true, now).unwrap();
    assert!(
        wake.as_secs() >= 24 * 60 && wake.as_secs() <= 25 * 60,
        "{wake:?}"
    );
    let recording = model::MainRow::Recording {
        title: String::new(),
        secs: 0,
    };
    assert_eq!(
        model::main_row_wake(Some(&recording), &[], false, now),
        Some(std::time::Duration::from_secs(1))
    );
}

#[test]
fn a_hidden_indicator_stays_hidden_across_launches() {
    use cap_meetings::settings::MeetingSettings;
    let mut settings = MeetingSettings::default();
    assert!(super::indicator::shows(true, Some(&settings)));
    assert!(!super::indicator::shows(false, Some(&settings)));
    // The x turns the setting off; it is saved with the rest.
    settings.recording.show_indicator = false;
    let saved = serde_json::to_string(&settings).unwrap();
    let loaded: MeetingSettings = serde_json::from_str(&saved).unwrap();
    assert!(!super::indicator::shows(true, Some(&loaded)));
}

#[test]
fn the_indicator_remembers_where_it_was_left_and_reads_old_files() {
    let old: crate::store::RememberedIndicatorDock =
        serde_json::from_str(r#"{"display":"d1","right":false,"y":0.3}"#).unwrap();
    assert_eq!(
        super::indicator::dock_of(&old),
        model::Dock { x: 0., y: 0.3 }
    );
    let new: crate::store::RememberedIndicatorDock =
        serde_json::from_str(r#"{"display":"d1","right":true,"y":0.4,"x":0.55}"#).unwrap();
    assert_eq!(
        super::indicator::dock_of(&new),
        model::Dock { x: 0.55, y: 0.4 }
    );
}
