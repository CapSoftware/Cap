use std::io::Write as _;
use std::time::{Duration, Instant};

use cap_calendar::link::{MeetingLink, Provider};
use cap_meetings::Millis;
use cap_meetings::apps::{AppKind, CallNoun};
use cap_meetings::detect::ActiveCall;
use cap_meetings::prompt::{Countdown, EventInfo, Prompt, PromptKind, PromptSubtitle};
use cap_meetings::settings::{MeetingSettings, PromptPosition};
use chrono::Utc;
use gpui::App;

use super::Live;
use crate::meetings::{
    ActiveMeeting, ActiveState, CalendarEvent, EngineStatus, MeetingWarning,
    SourceHealth, SourceState, StartSource, StopReason,
};

#[derive(Clone, Debug, Default)]
pub struct Seed {
    pub settings: Option<MeetingSettings>,
    pub prompts: Vec<Prompt>,
    pub active: Option<ActiveMeeting>,
    pub calls: Vec<ActiveCall>,
    pub events: Option<Vec<CalendarEvent>>,
    pub has_sources: Option<bool>,
    pub hover_prompt: Option<u64>,
    pub hover_indicator: bool,
}

fn seed(cx: &App) -> Option<&Seed> {
    super::Live::global(cx).and_then(|live| live.read(cx).seed.as_ref())
}

fn update_seed(cx: &mut App, f: impl FnOnce(&mut Seed)) {
    let Some(live) = Live::global(cx) else {
        return;
    };
    let mut next = live.read(cx).seed.clone().unwrap_or_default();
    f(&mut next);
    live.update(cx, |live, cx| live.set_seed(Some(next), cx));
}

pub fn hovered_prompt(id: u64, cx: &App) -> bool {
    seed(cx).is_some_and(|seed| seed.hover_prompt == Some(id))
}

pub fn hovered_indicator(cx: &App) -> bool {
    seed(cx).is_some_and(|seed| seed.hover_indicator)
}

pub fn start(source: StartSource, cx: &mut App) -> String {
    let title = match &source {
        StartSource::Event(id) => seed(cx)
            .and_then(|seed| seed.events.as_ref())
            .and_then(|events| {
                events
                    .iter()
                    .find(|event| crate::meetings::calendar::event_key(event) == *id)
            })
            .map(|event| event.title.clone())
            .unwrap_or_default(),
        _ => "Weekly design review".to_string(),
    };
    let active = active_meeting(&title, 0.0, 0.0);
    let doc = active.doc_id.clone();
    update_seed(cx, |seed| {
        seed.active = Some(active);
    });
    doc
}

pub fn stop(cx: &mut App) {
    update_seed(cx, |seed| {
        seed.active = None;
    });
}

pub fn clear_warning(cx: &mut App) {
    update_seed(cx, |seed| {
        if let Some(active) = seed.active.as_mut() {
            active.warning = None;
            active.state = ActiveState::Recording;
            active.resume_offer_until = None;
        }
    });
}

pub fn remove_prompt(id: u64, cx: &mut App) {
    update_seed(cx, |seed| seed.prompts.retain(|prompt| prompt.id != id));
}

fn event(
    id: &str,
    title: &str,
    minutes_from_now: i64,
    length: i64,
    link: Option<Provider>,
) -> CalendarEvent {
    let start = Utc::now() + chrono::Duration::minutes(minutes_from_now);
    CalendarEvent {
        id: id.into(),
        calendar_id: "seed".into(),
        title: title.into(),
        start,
        end: start + chrono::Duration::minutes(length),
        link: link.map(|provider| MeetingLink {
            provider,
            url: "https://example.com/join".into(),
            meeting_id: None,
        }),
        ..CalendarEvent::default()
    }
}

fn call(app_id: &str, app_name: &str, noun: CallNoun) -> ActiveCall {
    ActiveCall {
        app_id: app_id.into(),
        app_name: app_name.into(),
        kind: AppKind::Meeting,
        call_noun: noun,
        started_at: Millis(0),
        pids: Vec::new(),
        web: None,
    }
}

fn active_meeting(title: &str, you: f32, others: f32) -> ActiveMeeting {
    ActiveMeeting {
        doc_id: "seed-doc".into(),
        title: title.into(),
        started_at: Utc::now() - chrono::Duration::seconds(754),
        started: Instant::now()
            .checked_sub(Duration::from_secs(754))
            .unwrap_or_else(Instant::now),
        state: ActiveState::Recording,
        mic: SourceState {
            level: you,
            health: SourceHealth::Ok,
            ..SourceState::default()
        },
        system: SourceState {
            level: others,
            health: SourceHealth::Ok,
            ..SourceState::default()
        },
        engine: EngineStatus::default(),
        warning: None,
        resume_offer_until: None,
        app_name: Some("Zoom".into()),
        event_id: None,
        health: Vec::new(),
        not_hearing: false,
        audio_failed: false,
        low_disk: false,
    }
}

fn info(event: &CalendarEvent) -> EventInfo {
    EventInfo {
        id: crate::meetings::calendar::event_key(event),
        title: event.title.clone(),
        start: event.start,
        end: event.end,
        has_link: event.link.is_some(),
        link_provider_name: event
            .link
            .as_ref()
            .map(|link| link.provider.display_name().into()),
        attendee_count: 4,
    }
}

fn detected_prompt(id: u64, app_id: &str, app_name: &str, noun: CallNoun) -> Prompt {
    Prompt {
        id,
        kind: PromptKind::Detected,
        title: format!("{} detected", noun.word()),
        subtitle: PromptSubtitle::App(app_name.into()),
        detail: None,
        app_id: Some(app_id.into()),
        app_name: Some(app_name.into()),
        event: None,
        countdown: None,
        shown_at: Millis(0),
    }
}

fn scheduled_prompt(id: u64, event: &CalendarEvent) -> Prompt {
    Prompt {
        id,
        kind: PromptKind::Scheduled,
        title: event.title.clone(),
        subtitle: PromptSubtitle::TimeRange {
            start: event.start,
            end: event.end,
        },
        detail: None,
        app_id: None,
        app_name: None,
        event: Some(info(event)),
        countdown: None,
        shown_at: Millis(0),
    }
}

fn base_events() -> Vec<CalendarEvent> {
    let mut events = vec![
        event("e1", "Design review", 50, 30, Some(Provider::Zoom)),
        event(
            "e2",
            "Customer onboarding call",
            95,
            45,
            Some(Provider::GoogleMeet),
        ),
        event("e3", "Weekly planning", 150, 30, Some(Provider::Teams)),
    ];
    let end_of_day = (chrono::Local::now() + chrono::Duration::days(1))
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|midnight| midnight.and_local_timezone(chrono::Local).earliest())
        .map(|midnight| midnight.with_timezone(&Utc));
    if let Some(end) = end_of_day {
        let room = (end - Utc::now()).num_minutes();
        if room < 160 {
            for (index, event) in events.iter_mut().enumerate() {
                let start =
                    Utc::now() + chrono::Duration::minutes(5 + index as i64 * (room / 4).max(1));
                event.end = start + (event.end - event.start);
                event.start = start;
            }
        }
    }
    events
}

fn ready_settings() -> MeetingSettings {
    MeetingSettings {
        enabled: true,
        setup_completed: true,
        ..MeetingSettings::default()
    }
}

fn state(name: &str) -> Option<Seed> {
    let mut seed = Seed {
        settings: Some(ready_settings()),
        events: Some(base_events()),
        has_sources: Some(true),
        ..Seed::default()
    };
    match name {
        "setup" => {
            seed.settings = Some(MeetingSettings::default());
        }
        "idle" => {}
        "no-calendar" => {
            seed.events = Some(Vec::new());
            seed.has_sources = Some(false);
        }
        "empty" => seed.events = Some(Vec::new()),
        "call" => seed.calls = vec![call("zoom", "Zoom", CallNoun::Meeting)],
        "imminent" => {
            let mut events = base_events();
            events.insert(0, event("e0", "Product sync", 4, 30, Some(Provider::Zoom)));
            seed.events = Some(events);
        }
        "now" => {
            let mut events = base_events();
            events.insert(
                0,
                event("e0", "Product sync", -6, 30, Some(Provider::GoogleMeet)),
            );
            seed.events = Some(events);
        }
        "speaking-you" => {
            seed.active = Some(active_meeting("Design review", 0.8, 0.0));
        }
        "speaking-others" => {
            seed.active = Some(active_meeting("Design review", 0.0, 0.7));
        }
        "long-title" => {
            seed.active = Some(active_meeting(
                "Quarterly planning with the platform and infrastructure teams",
                0.5,
                0.4,
            ));
        }
        "recording" | "ind-silent" => {
            seed.active = Some(active_meeting("Design review", 0.0, 0.0));
        }
        "recording-sound" | "ind-sound" => {
            seed.active = Some(active_meeting("Design review", 0.82, 0.6));
        }
        "ind-hover" => {
            seed.active = Some(active_meeting("Design review", 0.7, 0.0));
            seed.hover_indicator = true;
        }
        "ending" | "ind-ending" => {
            let mut active = active_meeting("Design review", 0.0, 0.0);
            active.warning = Some(MeetingWarning::Ending {
                stop_at: Instant::now() + Duration::from_secs(12),
                reason: StopReason::CallEnded,
            });
            seed.active = Some(active);
        }
        "inactivity" | "ind-inactivity" => {
            let mut active = active_meeting("Design review", 0.0, 0.0);
            active.warning = Some(MeetingWarning::Inactivity {
                stop_at: Instant::now() + Duration::from_secs(58),
            });
            seed.active = Some(active);
        }
        "resume" | "ind-resume" => {
            let mut active = active_meeting("Design review", 0.0, 0.0);
            active.state = ActiveState::ResumeOffered;
            active.resume_offer_until = Some(Instant::now() + Duration::from_secs(90));
            seed.active = Some(active);
        }
        "problem" | "ind-problem" => {
            let mut active = active_meeting("Design review", 0.75, 0.0);
            active.not_hearing = true;
            active.health = crate::meetings::health::concerns(&active);
            seed.active = Some(active);
            seed.hover_indicator = name == "ind-problem";
        }
        "prompt-detected" => {
            seed.prompts = vec![detected_prompt(1, "zoom", "Zoom", CallNoun::Meeting)];
        }
        "prompt-call" => {
            seed.prompts = vec![detected_prompt(1, "facetime", "FaceTime", CallNoun::Call)];
        }
        "prompt-scheduled" => {
            let event = event("e9", "Design review", 1, 30, Some(Provider::Zoom));
            let mut prompt = scheduled_prompt(2, &event);
            if let Some(info) = prompt.event.as_mut() {
                info.start = Utc::now() + chrono::Duration::seconds(45);
            }
            seed.events = Some(vec![event]);
            seed.prompts = vec![prompt];
        }
        "prompt-auto" => {
            let mut prompt = detected_prompt(3, "zoom", "Zoom", CallNoun::Meeting);
            prompt.countdown = Some(Countdown {
                started_at: Millis(0),
                ends_at: Millis(5_000),
            });
            seed.prompts = vec![prompt];
        }
        "prompt-stack" => {
            let event = event("e9", "Design review", 1, 30, Some(Provider::Zoom));
            seed.events = Some(vec![event.clone()]);
            seed.prompts = vec![
                detected_prompt(4, "slack", "Slack", CallNoun::Huddle),
                scheduled_prompt(5, &event),
            ];
        }
        "prompt-hover" => {
            seed.prompts = vec![detected_prompt(6, "zoom", "Zoom", CallNoun::Meeting)];
            seed.hover_prompt = Some(6);
        }
        "prompt-tl" | "prompt-bl" | "prompt-br" | "prompt-tr" => {
            let mut settings = ready_settings();
            settings.notifications.position = match name {
                "prompt-tl" => PromptPosition::TopLeft,
                "prompt-bl" => PromptPosition::BottomLeft,
                "prompt-br" => PromptPosition::BottomRight,
                _ => PromptPosition::TopRight,
            };
            seed.settings = Some(settings);
            seed.prompts = vec![detected_prompt(7, "zoom", "Zoom", CallNoun::Meeting)];
        }
        "clear" => {}
        _ => return None,
    }
    Some(seed)
}

fn window_number(handle: gpui::AnyWindowHandle, cx: &mut App) -> Option<isize> {
    handle
        .update(cx, |_, window, _| crate::platform::window_number(window))
        .ok()
        .flatten()
}

fn targets(target: &str, cx: &mut App) -> Vec<String> {
    let mut handles: Vec<gpui::AnyWindowHandle> = Vec::new();
    match target {
        "main" => handles.push(cx.global::<crate::app_windows::AppWindows>().main.into()),
        "prompt" | "prompts" => handles.extend(super::prompt::handles(cx)),
        "indicator" => handles.extend(super::indicator::handle(cx)),
        _ => {}
    }
    handles
        .into_iter()
        .filter_map(|handle| window_number(handle, cx))
        .map(|number| number.to_string())
        .collect()
}

fn apply_main(step: &str, cx: &mut App) {
    use crate::main_window::{DeviceMenu, LibraryKind, Mode, Panel};
    let main = cx.global::<crate::app_windows::AppWindows>().main;
    main.update(cx, |view, window, cx| {
        view.close_panel(cx);
        view.debug_clear_hover();
        match step {
            "info" => view.open_panel(Panel::ModeInfo, window, cx),
            "mic" => view.open_panel(Panel::Device(DeviceMenu::Microphone), window, cx),
            "hover-instant" => view.debug_show_hover(Mode::Instant, cx),
            "hover-studio" => view.debug_show_hover(Mode::Studio, cx),
            "hover-screenshot" => view.debug_show_hover(Mode::Screenshot, cx),
            "instant" | "studio" | "screenshot" => view.set_mode(
                match step {
                    "studio" => Mode::Studio,
                    "screenshot" => Mode::Screenshot,
                    _ => Mode::Instant,
                },
                cx,
            ),
            "studio-hover-instant" => {
                view.set_mode(Mode::Studio, cx);
                view.debug_show_hover(Mode::Instant, cx);
            }
            "library-recordings" | "library-screenshots" | "library-notes" => {
                view.set_mode(Mode::Studio, cx);
                let kind = match step {
                    "library-screenshots" => LibraryKind::Screenshots,
                    "library-notes" => LibraryKind::Notes,
                    _ => LibraryKind::Recordings,
                };
                view.open_panel(Panel::Library(kind), window, cx);
            }
            "instant-info" => {
                view.set_mode(Mode::Instant, cx);
                view.open_panel(Panel::ModeInfo, window, cx);
            }
            _ => {}
        }
        cx.notify();
    })
    .ok();
}

pub fn apply(spec: &str, cx: &mut App) -> bool {
    let (state_name, main_step) = spec.split_once('+').unwrap_or((spec, ""));
    let Some(seed) = state(state_name) else {
        tracing::error!(spec, "CAP_GPUI_MEETING_UI: unknown state");
        return false;
    };
    if let Some(live) = Live::global(cx) {
        live.update(cx, |live, cx| live.set_seed(Some(seed), cx));
    }
    crate::app_windows::show_main_window(cx);
    apply_main(main_step, cx);
    true
}

fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

fn fake_call_from_env(cx: &mut App) {
    let Ok(spec) = std::env::var("CAP_GPUI_MEETING_FAKE_CALL") else {
        return;
    };
    let mut parts = spec.split(':');
    let bundle = parts.next().unwrap_or("us.zoom.xos").to_string();
    let start: u64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(8);
    let length: u64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(30);
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(Duration::from_secs(start))
            .await;
        tracing::info!(epoch_ms = epoch_ms() as u64, %bundle, "fake call started");
        cx.update(|cx| crate::meetings::dev::fake_mic_clients(&[bundle.as_str()], cx));
        cx.background_executor()
            .timer(Duration::from_secs(length))
            .await;
        tracing::info!(epoch_ms = epoch_ms() as u64, "fake call ended");
        cx.update(|cx| crate::meetings::dev::fake_mic_clients(&[], cx));
    })
    .detach();
}

pub fn run_from_env(cx: &mut App) {
    fake_call_from_env(cx);
    let Ok(spec) = std::env::var("CAP_GPUI_MEETING_UI") else {
        return;
    };
    let steps: Vec<(String, String, String, u64)> = match std::fs::read_to_string(&spec) {
        Ok(tour) => tour
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                Some((
                    parts.next()?.to_string(),
                    parts.next()?.to_string(),
                    parts.next().unwrap_or("main").to_string(),
                    parts.next().and_then(|ms| ms.parse().ok()).unwrap_or(1400),
                ))
            })
            .collect(),
        Err(_) => vec![("state".into(), spec.clone(), "main".into(), 0)],
    };
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_secs(3)).await;
        let single = steps.len() == 1 && steps[0].3 == 0;
        for (name, state, target, wait) in steps {
            if state == "menu" {
                cx.update(super::prompt::debug_open_menu);
            } else if state == "close-menu" {
                cx.update(super::prompt::debug_open_menu);
            } else if !cx.update(|cx| apply(&state, cx)) {
                continue;
            }
            if single {
                return;
            }
            cx.background_executor()
                .timer(Duration::from_millis(wait))
                .await;
            let ids = cx.update(|cx| targets(&target, cx));
            let mut out = std::io::stdout();
            let _ = writeln!(out, "SNAP {name} {}", ids.join(" "));
            let _ = out.flush();
            cx.background_executor()
                .timer(Duration::from_millis(700))
                .await;
        }
        let mut out = std::io::stdout();
        let _ = writeln!(out, "TOUR DONE");
        let _ = out.flush();
        cx.update(|cx| cx.quit());
    })
    .detach();
}
