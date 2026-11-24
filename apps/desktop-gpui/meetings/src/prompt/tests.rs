use chrono::TimeZone;

use super::*;
use crate::test_rng::Rng;

const MIN: u64 = 60_000;

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 12, 10, 0, 0).unwrap()
}

fn wall(ms: i64) -> DateTime<Utc> {
    base() + Duration::milliseconds(ms)
}

fn ev(id: &str, title: &str, start_ms: i64, duration_ms: i64, has_link: bool) -> EventInfo {
    EventInfo {
        id: id.into(),
        title: title.into(),
        start: wall(start_ms),
        end: wall(start_ms + duration_ms),
        has_link,
        link_provider_name: has_link.then(|| "Zoom".to_string()),
        attendee_count: 3,
    }
}

fn call(app_id: &str, started_at: u64) -> ActiveCall {
    let info = crate::apps::app_by_id(app_id).unwrap();
    ActiveCall {
        app_id: app_id.into(),
        app_name: info.name.into(),
        kind: info.kind,
        call_noun: info.call_noun,
        started_at: Millis(started_at),
        pids: vec![1],
        web: None,
    }
}

struct Sim {
    planner: PromptPlanner,
    now: u64,
    log: Vec<(u64, PromptAction)>,
}

impl Sim {
    fn new() -> Self {
        Self::with(PromptConfig::default())
    }

    fn with(config: PromptConfig) -> Self {
        Self {
            planner: PromptPlanner::new(config),
            now: 0,
            log: Vec::new(),
        }
    }

    fn clock(&self) -> Now {
        Now::new(Millis(self.now), wall(self.now as i64))
    }

    fn record(&mut self, actions: Vec<PromptAction>) {
        let now = self.now;
        self.log.extend(actions.into_iter().map(|a| (now, a)));
    }

    fn at(&mut self, t: u64) -> &mut Self {
        while let Some(due) = self.planner.next_deadline() {
            if due.0 > t {
                break;
            }
            assert!(due.0 >= self.now, "deadline {due:?} behind {}", self.now);
            self.now = due.0;
            let actions = self.planner.tick(self.clock());
            assert!(!actions.is_empty(), "spurious wake at {}", self.now);
            self.record(actions);
        }
        self.now = self.now.max(t);
        self
    }

    fn started(&mut self, app_id: &str) -> &mut Self {
        let event = DetectEvent::CallStarted(call(app_id, self.now));
        let actions = self.planner.on_detect(self.clock(), &event);
        self.record(actions);
        self
    }

    fn started_at(&mut self, app_id: &str, started_at: u64) -> &mut Self {
        let event = DetectEvent::CallStarted(call(app_id, started_at));
        let actions = self.planner.on_detect(self.clock(), &event);
        self.record(actions);
        self
    }

    fn ended(&mut self, app_id: &str) -> &mut Self {
        let event = DetectEvent::CallEnded {
            app_id: app_id.into(),
            ended_at: Millis(self.now),
            held_for_ms: 0,
        };
        let actions = self.planner.on_detect(self.clock(), &event);
        self.record(actions);
        self
    }

    fn events(&mut self, events: Vec<EventInfo>) -> &mut Self {
        let actions = self.planner.set_events(self.clock(), events);
        self.record(actions);
        self
    }

    fn recording(&mut self, state: RecordingState) -> &mut Self {
        let actions = self.planner.set_recording(self.clock(), state);
        self.record(actions);
        self
    }

    fn hover(&mut self, id: u64, on: bool) -> &mut Self {
        let actions = self.planner.hover(self.clock(), id, on);
        self.record(actions);
        self
    }

    fn dismiss(&mut self, id: u64) -> &mut Self {
        let actions = self.planner.dismiss(self.clock(), id);
        self.record(actions);
        self
    }

    fn cancel(&mut self, id: u64) -> &mut Self {
        let actions = self.planner.cancel(self.clock(), id);
        self.record(actions);
        self
    }

    fn accept(&mut self, id: u64) -> &mut Self {
        let actions = self.planner.accept(self.clock(), id);
        self.record(actions);
        self
    }

    fn take(&mut self) -> Vec<(u64, String)> {
        std::mem::take(&mut self.log)
            .into_iter()
            .map(|(t, a)| (t, describe(&a)))
            .collect()
    }

    fn expect(&mut self, expected: &[(u64, &str)]) -> &mut Self {
        let expected: Vec<(u64, String)> =
            expected.iter().map(|(t, s)| (*t, s.to_string())).collect();
        assert_eq!(self.take(), expected);
        self
    }

    fn quiet(&mut self) -> &mut Self {
        self.expect(&[])
    }

    fn visible_ids(&self) -> Vec<u64> {
        self.planner.visible().map(|p| p.id).collect()
    }
}

fn describe(action: &PromptAction) -> String {
    let prompt = |p: &Prompt| {
        let subtitle = match &p.subtitle {
            PromptSubtitle::App(app) => app.clone(),
            PromptSubtitle::TimeRange { start, end } => format!(
                "{}-{}",
                (*start - base()).num_seconds(),
                (*end - base()).num_seconds()
            ),
        };
        let countdown = p
            .countdown
            .map(|c| format!(" countdown {}", c.ends_at.0))
            .unwrap_or_default();
        format!("#{} {:?} {} | {subtitle}{countdown}", p.id, p.kind, p.title)
    };
    match action {
        PromptAction::Show(p) => format!("show {}", prompt(p)),
        PromptAction::Update(p) => format!("update {}", prompt(p)),
        PromptAction::Dismiss { id, reason } => format!("dismiss #{id} {reason:?}"),
        PromptAction::StartRecording { source } => match source {
            RecordSource::DetectedCall { app_id, event_id } => {
                format!("record call {app_id} {event_id:?}")
            }
            RecordSource::Scheduled { event_id } => format!("record event {event_id}"),
        },
    }
}

#[test]
fn detected_prompt_shows_and_times_out() {
    let mut s = Sim::new();
    s.at(2_000).started("zoom");
    s.expect(&[(2_000, "show #1 Detected Meeting detected | Zoom")]);
    s.at(21_999).quiet();
    s.at(22_000).expect(&[(22_000, "dismiss #1 TimedOut")]);
    assert_eq!(s.planner.next_deadline(), None);
}

#[test]
fn call_nouns_shape_the_title() {
    let mut s = Sim::new();
    s.started("slack").started("facetime");
    s.expect(&[
        (0, "show #1 Detected Huddle detected | Slack"),
        (0, "show #2 Detected Call detected | FaceTime"),
    ]);
    assert_eq!(s.visible_ids(), vec![2, 1]);
}

#[test]
fn hover_pauses_auto_dismiss() {
    let mut s = Sim::new();
    s.started("zoom").take();
    s.at(5_000).hover(1, true);
    s.at(15_000).hover(1, false);
    s.at(25_000).hover(1, true);
    s.at(26_000).hover(1, false).quiet();
    s.at(29_999).quiet();
    s.at(31_000).expect(&[(31_000, "dismiss #1 TimedOut")]);
}

#[test]
fn hover_cannot_hold_past_hard_cap() {
    let mut s = Sim::new();
    s.started("zoom").take();
    s.at(1_000).hover(1, true);
    s.at(119_999).quiet();
    s.at(120_000).expect(&[(120_000, "dismiss #1 TimedOut")]);
}

#[test]
fn muted_app_and_disabled_detection() {
    let mut s = Sim::with(PromptConfig {
        muted_app_ids: vec!["zoom".into()],
        ..PromptConfig::default()
    });
    s.started("zoom").quiet();
    let mut s = Sim::with(PromptConfig {
        detected_enabled: false,
        ..PromptConfig::default()
    });
    s.started("zoom").quiet();
}

#[test]
fn no_prompt_while_recording_or_starting() {
    let mut s = Sim::new();
    s.recording(RecordingState::Starting { event_id: None });
    s.started("zoom").quiet();
    s.recording(RecordingState::Recording { event_id: None });
    s.started("teams").quiet();
}

#[test]
fn same_call_is_prompted_once() {
    let mut s = Sim::new();
    s.started_at("zoom", 0).take();
    s.at(1_000).started_at("zoom", 0).quiet();
    s.at(25_000).take();
    s.started_at("zoom", 0).quiet();
}

#[test]
fn cooldown_per_app() {
    let mut s = Sim::new();
    s.started("zoom").take();
    s.at(10_000).ended("zoom");
    s.expect(&[(10_000, "dismiss #1 CallEnded")]);
    s.at(60_000).started("zoom").quiet();
    s.at(70_000).started("teams");
    s.expect(&[(
        70_000,
        "show #2 Detected Meeting detected | Microsoft Teams",
    )]);
    s.at(119_000).ended("zoom");
    s.at(121_000).started("zoom");
    let shown = s.take();
    assert!(
        shown.iter().any(|(_, a)| a.starts_with("show #3")),
        "{shown:?}"
    );
}

#[test]
fn dismissed_prompt_does_not_return_for_same_call() {
    let mut s = Sim::new();
    s.started_at("zoom", 0).take();
    s.at(3_000).dismiss(1).expect(&[(3_000, "dismiss #1 User")]);
    let update = DetectEvent::CallUpdated(call("zoom", 0));
    let actions = s.planner.on_detect(s.clock(), &update);
    assert!(actions.is_empty());
    s.at(200_000).started_at("zoom", 0).quiet();
    s.ended("zoom");
    s.at(400_000).started("zoom");
    assert_eq!(s.take().len(), 1);
}

#[test]
fn recording_start_dismisses_detected_prompt() {
    let mut s = Sim::new();
    s.started("zoom").take();
    s.at(4_000)
        .recording(RecordingState::Starting { event_id: None })
        .expect(&[(4_000, "dismiss #1 RecordingStarted")]);
}

#[test]
fn web_title_update_flows_into_prompt() {
    let mut s = Sim::new();
    s.started_at("chrome", 0).take();
    let mut updated = call("chrome", 0);
    updated.web = Some(crate::detect::WebMeeting {
        provider: crate::browser::WebProvider::GoogleMeet,
        meeting_id: None,
        title: Some("Design review".into()),
    });
    let actions = s
        .planner
        .on_detect(s.clock(), &DetectEvent::CallUpdated(updated));
    assert!(
        matches!(&actions[..], [PromptAction::Update(p)] if p.detail.as_deref() == Some("Design review"))
    );
}

#[test]
fn auto_record_countdown_and_completion() {
    let mut s = Sim::with(PromptConfig {
        auto_record: AutoRecord::Detected,
        ..PromptConfig::default()
    });
    s.at(1_000).started("zoom");
    s.expect(&[(
        1_000,
        "show #1 Detected Meeting detected | Zoom countdown 6000",
    )]);
    s.at(6_000).expect(&[
        (6_000, "record call zoom None"),
        (6_000, "dismiss #1 RecordingStarted"),
    ]);
    assert_eq!(
        s.planner.recording(),
        &RecordingState::Starting { event_id: None }
    );
    s.started("teams").quiet();
}

#[test]
fn auto_record_cancel_suppresses_for_call() {
    let mut s = Sim::with(PromptConfig {
        auto_record: AutoRecord::Both,
        detected_enabled: false,
        ..PromptConfig::default()
    });
    s.started_at("zoom", 0).take();
    s.at(2_000)
        .cancel(1)
        .expect(&[(2_000, "dismiss #1 Cancelled")]);
    s.at(10_000).quiet();
    s.started_at("zoom", 0).quiet();
}

#[test]
fn accept_starts_recording_once() {
    let mut s = Sim::new();
    s.started("zoom").started("teams").take();
    s.at(1_000).accept(2).expect(&[
        (1_000, "record call teams None"),
        (1_000, "dismiss #2 RecordingStarted"),
        (1_000, "dismiss #1 RecordingStarted"),
    ]);
    s.accept(1).quiet();
}

#[test]
fn ongoing_event_attaches_regardless_of_age() {
    let mut s = Sim::new();
    s.at(3 * 60 * MIN);
    s.events(vec![ev(
        "long",
        "All-day workshop",
        0,
        8 * 60 * MIN as i64,
        false,
    )]);
    s.take();
    s.started("zoom");
    s.expect(&[(10_800_000, "show #1 Detected All-day workshop | 0-28800")]);
}

#[test]
fn event_match_window_and_preference() {
    let mut s = Sim::with(PromptConfig {
        scheduled_enabled: false,
        ..PromptConfig::default()
    });
    s.events(vec![
        ev("far", "Too far", 100_000, 30 * MIN as i64, true),
        ev("near", "Soon", 80_000, 30 * MIN as i64, false),
    ]);
    s.started("zoom");
    s.expect(&[(0, "show #1 Detected Soon | 80-1880")]);

    let mut s = Sim::with(PromptConfig {
        scheduled_enabled: false,
        ..PromptConfig::default()
    });
    s.at(10 * MIN);
    s.events(vec![
        ev(
            "nolink",
            "Nearest",
            10 * MIN as i64 - 1_000,
            30 * MIN as i64,
            false,
        ),
        ev(
            "link",
            "Has link",
            10 * MIN as i64 - 300_000,
            30 * MIN as i64,
            true,
        ),
        ev(
            "link2",
            "Has link nearer",
            10 * MIN as i64 - 100_000,
            30 * MIN as i64,
            true,
        ),
    ]);
    s.started("zoom");
    let shown = s.take();
    assert!(shown[0].1.contains("Has link nearer"), "{shown:?}");
}

#[test]
fn reminder_exact_boundaries() {
    let mut s = Sim::new();
    s.events(vec![ev(
        "e1",
        "Planning",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    assert_eq!(s.planner.next_deadline(), Some(Millis(9 * MIN)));
    s.at(9 * MIN - 1).quiet();
    s.at(9 * MIN)
        .expect(&[(540_000, "show #1 Scheduled Planning | 600-2400")]);
    s.at(10 * MIN + 4 * MIN - 1).quiet();
    s.at(14 * MIN).expect(&[(840_000, "dismiss #1 EventOver")]);
    s.at(60 * MIN).quiet();
}

#[test]
fn reminder_never_for_event_started_long_ago() {
    let mut s = Sim::new();
    s.at(20 * MIN);
    s.events(vec![
        ev("old", "Old", 15 * MIN as i64, 60 * MIN as i64, true),
        ev("recent", "Recent", 17 * MIN as i64, 60 * MIN as i64, true),
    ]);
    s.expect(&[(1_200_000, "show #1 Scheduled Recent | 1020-4620")]);
    s.at(21 * MIN)
        .expect(&[(1_260_000, "dismiss #1 EventOver")]);
}

#[test]
fn reminder_lead_zero_and_configured_lead() {
    let mut s = Sim::with(PromptConfig {
        lead_ms: 0,
        ..PromptConfig::default()
    });
    s.events(vec![ev("e", "Zero", 5 * MIN as i64, MIN as i64, false)]);
    s.at(5 * MIN - 1).quiet();
    s.at(5 * MIN)
        .expect(&[(300_000, "show #1 Scheduled Zero | 300-360")]);
    let mut s = Sim::with(PromptConfig {
        lead_ms: 15 * MIN,
        ..PromptConfig::default()
    });
    s.events(vec![ev("e", "Early", 20 * MIN as i64, MIN as i64, false)]);
    s.at(5 * MIN)
        .expect(&[(300_000, "show #1 Scheduled Early | 1200-1260")]);
}

#[test]
fn reminder_rescheduled_and_removed() {
    let mut s = Sim::new();
    s.events(vec![ev(
        "e1",
        "Planning",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.at(9 * MIN).take();
    s.at(9 * MIN + 1_000).events(vec![ev(
        "e1",
        "Planning v2",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.expect(&[(541_000, "update #1 Scheduled Planning v2 | 600-2400")]);
    s.events(vec![ev(
        "e1",
        "Planning v2",
        70 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.expect(&[(541_000, "dismiss #1 EventRescheduled")]);
    s.at(69 * MIN)
        .expect(&[(4_140_000, "show #2 Scheduled Planning v2 | 4200-6000")]);
    s.events(vec![]);
    s.expect(&[(4_140_000, "dismiss #2 EventRemoved")]);
    s.at(200 * MIN).quiet();
}

#[test]
fn reminder_moved_within_window_updates_in_place() {
    let mut s = Sim::new();
    s.events(vec![ev(
        "e1",
        "Sync",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.at(9 * MIN).take();
    s.events(vec![ev(
        "e1",
        "Sync",
        10 * MIN as i64 + 30_000,
        30 * MIN as i64,
        true,
    )]);
    s.expect(&[(540_000, "update #1 Scheduled Sync | 630-2430")]);
    s.at(14 * MIN + 29_999).quiet();
    s.at(14 * MIN + 30_000)
        .expect(&[(870_000, "dismiss #1 EventOver")]);
}

#[test]
fn removed_before_reminder_never_shows() {
    let mut s = Sim::new();
    s.events(vec![ev(
        "e1",
        "Gone",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.at(5 * MIN).events(vec![]);
    s.at(30 * MIN).quiet();
}

#[test]
fn no_reminder_for_event_being_recorded() {
    let mut s = Sim::new();
    s.recording(RecordingState::Recording {
        event_id: Some("e1".into()),
    });
    s.events(vec![
        ev(
            "e1",
            "Being recorded",
            10 * MIN as i64,
            30 * MIN as i64,
            true,
        ),
        ev("e2", "Next one", 10 * MIN as i64, 30 * MIN as i64, true),
    ]);
    s.at(9 * MIN)
        .expect(&[(540_000, "show #1 Scheduled Next one | 600-2400")]);
}

#[test]
fn recording_start_dismisses_reminder_for_that_event_only() {
    let mut s = Sim::new();
    s.events(vec![
        ev("a", "A", 10 * MIN as i64, 30 * MIN as i64, true),
        ev("b", "B", 10 * MIN as i64, 30 * MIN as i64, true),
    ]);
    s.at(9 * MIN).take();
    s.recording(RecordingState::Starting {
        event_id: Some("a".into()),
    });
    s.expect(&[(540_000, "dismiss #1 RecordingStarted")]);
    assert_eq!(s.visible_ids(), vec![2]);
}

#[test]
fn detected_call_upgrades_visible_reminder() {
    let mut s = Sim::new();
    s.events(vec![ev(
        "e1",
        "Weekly",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.at(9 * MIN).take();
    s.at(9 * MIN + 30_000).started("zoom");
    s.expect(&[(570_000, "update #1 Detected Weekly | 600-2400")]);
    assert_eq!(s.visible_ids(), vec![1]);
    s.at(9 * MIN + 30_000 + 20_000)
        .expect(&[(590_000, "dismiss #1 TimedOut")]);
    s.at(30 * MIN).quiet();
}

#[test]
fn detected_attach_consumes_upcoming_reminder() {
    let mut s = Sim::new();
    s.events(vec![ev(
        "e1",
        "Weekly",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.at(10 * MIN - 80_000).started("zoom");
    s.expect(&[(520_000, "show #1 Detected Weekly | 600-2400")]);
    s.at(30 * MIN).expect(&[(540_000, "dismiss #1 TimedOut")]);
}

#[test]
fn at_most_three_prompts_newest_first() {
    let mut s = Sim::new();
    for app in ["zoom", "teams", "slack", "discord"] {
        s.started(app);
    }
    let log = s.take();
    assert!(
        log.iter().any(|(_, a)| a == "dismiss #1 Evicted"),
        "{log:?}"
    );
    assert_eq!(s.visible_ids(), vec![4, 3, 2]);
}

#[test]
fn scheduled_auto_record_counts_down_at_start() {
    let mut s = Sim::with(PromptConfig {
        auto_record: AutoRecord::Scheduled,
        ..PromptConfig::default()
    });
    s.events(vec![ev(
        "e1",
        "Board",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.at(9 * MIN).take();
    s.at(10 * MIN).expect(&[(
        600_000,
        "update #1 Scheduled Board | 600-2400 countdown 605000",
    )]);
    s.at(10 * MIN + 5_000).expect(&[
        (605_000, "record event e1"),
        (605_000, "dismiss #1 RecordingStarted"),
    ]);
}

#[test]
fn scheduled_auto_record_applies_to_detected_with_event() {
    let mut s = Sim::with(PromptConfig {
        auto_record: AutoRecord::Scheduled,
        ..PromptConfig::default()
    });
    s.started("zoom");
    s.expect(&[(0, "show #1 Detected Meeting detected | Zoom")]);
    s.events(vec![ev(
        "e1",
        "Board",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.ended("zoom").take();
    s.at(10 * MIN).take();
    s.at(10 * MIN + 1_000).started("teams");
    s.expect(&[(
        601_000,
        "update #2 Detected Board | 600-2400 countdown 606000",
    )]);
    s.at(10 * MIN + 6_000).expect(&[
        (606_000, "record call teams Some(\"e1\")"),
        (606_000, "dismiss #2 RecordingStarted"),
    ]);
}

#[test]
fn config_changes_dismiss_and_clear_countdowns() {
    let mut s = Sim::with(PromptConfig {
        auto_record: AutoRecord::Detected,
        ..PromptConfig::default()
    });
    s.started("zoom").started("teams").take();
    let actions = s.planner.set_config(
        s.clock(),
        PromptConfig {
            muted_app_ids: vec!["zoom".into()],
            ..PromptConfig::default()
        },
    );
    s.record(actions);
    let log = s.take();
    assert!(
        log.iter().any(|(_, a)| a == "dismiss #1 Disabled"),
        "{log:?}"
    );
    assert!(
        log.iter()
            .any(|(_, a)| a.starts_with("update #2") && !a.contains("countdown")),
        "{log:?}"
    );
}

#[test]
fn clock_going_backwards_is_ignored() {
    let mut s = Sim::new();
    s.at(10_000).started("zoom").take();
    let early = Now::new(Millis(5_000), wall(5_000));
    assert!(s.planner.tick(early).is_empty());
    assert_eq!(s.planner.next_deadline(), Some(Millis(30_000)));
}

#[test]
fn extreme_event_dates_do_not_panic() {
    let mut s = Sim::new();
    s.events(vec![
        EventInfo {
            id: "max".into(),
            start: DateTime::<Utc>::MAX_UTC,
            end: DateTime::<Utc>::MAX_UTC,
            ..EventInfo::default()
        },
        EventInfo {
            id: "min".into(),
            start: DateTime::<Utc>::MIN_UTC,
            end: DateTime::<Utc>::MIN_UTC,
            ..EventInfo::default()
        },
    ]);
    s.at(10 * MIN);
    let _ = s.planner.next_deadline();
    let mut s = Sim::with(PromptConfig {
        lead_ms: u64::MAX,
        reminder_tail_ms: u64::MAX,
        cooldown_ms: u64::MAX,
        visible_ms: u64::MAX,
        max_visible_ms: u64::MAX,
        auto_record_countdown_ms: u64::MAX,
        event_match_window_ms: u64::MAX,
        max_prompts: 0,
        ..PromptConfig::default()
    });
    s.events(vec![ev("e", "x", 0, 1, false)]);
    s.started("zoom");
    let _ = s.planner.tick(s.clock());
}

#[test]
fn randomised_invariants() {
    let apps = ["zoom", "teams", "slack", "chrome", "facetime"];
    for seed in 0..60 {
        let mut rng = Rng::new(seed);
        let auto = [
            AutoRecord::Off,
            AutoRecord::Detected,
            AutoRecord::Scheduled,
            AutoRecord::Both,
        ][(seed % 4) as usize];
        let mut planner = PromptPlanner::new(PromptConfig {
            auto_record: auto,
            lead_ms: rng.below(900_001),
            ..PromptConfig::default()
        });
        let mut now = 0u64;
        let mut visible: Vec<u64> = Vec::new();
        let mut recording_requested = false;
        let mut live_calls: Vec<(String, u64)> = Vec::new();
        for step in 0..600 {
            now += rng.below(30_000);
            let clock = Now::new(Millis(now), wall(now as i64));
            let actions = match rng.below(10) {
                0 => {
                    let app = rng.pick(&apps).to_string();
                    let started = live_calls
                        .iter()
                        .find(|(a, _)| *a == app)
                        .map(|(_, s)| *s)
                        .unwrap_or(now);
                    if !live_calls.iter().any(|(a, _)| *a == app) {
                        live_calls.push((app.clone(), started));
                    }
                    planner.on_detect(clock, &DetectEvent::CallStarted(call(&app, started)))
                }
                1 => {
                    let app = rng.pick(&apps).to_string();
                    live_calls.retain(|(a, _)| *a != app);
                    planner.on_detect(
                        clock,
                        &DetectEvent::CallEnded {
                            app_id: app,
                            ended_at: Millis(now),
                            held_for_ms: 0,
                        },
                    )
                }
                2 => {
                    let events = (0..rng.below(4))
                        .map(|i| {
                            ev(
                                &format!("e{}", rng.below(5)),
                                &format!("Event {i}"),
                                now as i64 + rng.below(40 * MIN) as i64 - (10 * MIN) as i64,
                                rng.below(90 * MIN) as i64,
                                rng.chance(50),
                            )
                        })
                        .collect();
                    planner.set_events(clock, events)
                }
                3 => {
                    let state = match rng.below(3) {
                        0 => {
                            recording_requested = false;
                            RecordingState::Idle
                        }
                        1 => RecordingState::Starting {
                            event_id: Some(format!("e{}", rng.below(5))),
                        },
                        _ => RecordingState::Recording { event_id: None },
                    };
                    if state.is_active() {
                        recording_requested = true;
                    }
                    planner.set_recording(clock, state)
                }
                4 if !visible.is_empty() => {
                    let id = *rng.pick(&visible);
                    match rng.below(4) {
                        0 => planner.dismiss(clock, id),
                        1 => planner.cancel(clock, id),
                        2 => planner.accept(clock, id),
                        _ => planner.hover(clock, id, rng.chance(50)),
                    }
                }
                _ => match planner.next_deadline() {
                    Some(due) if due.0 >= now => {
                        now = due.0;
                        planner.tick(Now::new(due, wall(due.0 as i64)))
                    }
                    _ => planner.tick(clock),
                },
            };
            for action in &actions {
                match action {
                    PromptAction::Show(p) => {
                        assert!(!visible.contains(&p.id));
                        visible.insert(0, p.id);
                    }
                    PromptAction::Update(p) => assert!(visible.contains(&p.id)),
                    PromptAction::Dismiss { id, .. } => {
                        assert!(
                            visible.contains(id),
                            "seed {seed} step {step}: unknown {id}"
                        );
                        visible.retain(|v| v != id);
                    }
                    PromptAction::StartRecording { .. } => {
                        assert!(
                            !recording_requested,
                            "seed {seed} step {step}: double start"
                        );
                        recording_requested = true;
                    }
                }
                assert!(visible.len() <= 3);
            }
            let actual: Vec<u64> = planner.visible().map(|p| p.id).collect();
            assert_eq!(actual, visible, "seed {seed} step {step}");
            if let Some(due) = planner.next_deadline() {
                assert!(
                    due.0 > now,
                    "seed {seed} step {step}: deadline {due:?} at {now}"
                );
            }
        }
    }
}

#[test]
fn auto_record_scheduled_works_with_notifications_off() {
    for auto_record in [AutoRecord::Scheduled, AutoRecord::Both] {
        let mut s = Sim::with(PromptConfig {
            scheduled_enabled: false,
            auto_record,
            ..PromptConfig::default()
        });
        s.events(vec![ev(
            "e1",
            "Board",
            10 * MIN as i64,
            30 * MIN as i64,
            true,
        )]);
        assert_eq!(s.planner.next_deadline(), Some(Millis(10 * MIN)));
        s.at(10 * MIN - 1).quiet();
        s.at(10 * MIN).expect(&[(
            600_000,
            "show #1 Scheduled Board | 600-2400 countdown 605000",
        )]);
        s.at(10 * MIN + 5_000).expect(&[
            (605_000, "record event e1"),
            (605_000, "dismiss #1 RecordingStarted"),
        ]);
        s.recording(RecordingState::Recording {
            event_id: Some("e1".into()),
        });
        s.at(60 * MIN).quiet();
        assert_eq!(s.planner.next_deadline(), None);
    }

    let mut s = Sim::with(PromptConfig {
        scheduled_enabled: false,
        auto_record: AutoRecord::Scheduled,
        ..PromptConfig::default()
    });
    s.events(vec![ev(
        "e1",
        "Board",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    s.at(10 * MIN).take();
    let actions = s.planner.set_config(
        s.clock(),
        PromptConfig {
            scheduled_enabled: false,
            ..PromptConfig::default()
        },
    );
    s.record(actions);
    s.expect(&[(600_000, "dismiss #1 Disabled")]);
    s.at(60 * MIN).quiet();

    let mut s = Sim::with(PromptConfig {
        scheduled_enabled: false,
        auto_record: AutoRecord::Off,
        ..PromptConfig::default()
    });
    s.events(vec![ev(
        "e1",
        "Board",
        10 * MIN as i64,
        30 * MIN as i64,
        true,
    )]);
    assert_eq!(s.planner.next_deadline(), None);
    s.at(60 * MIN).quiet();
}

struct Clocks {
    planner: PromptPlanner,
    mono: u64,
    wall: i64,
    log: Vec<String>,
}

impl Clocks {
    fn new(config: PromptConfig) -> Self {
        Self {
            planner: PromptPlanner::new(config),
            mono: 0,
            wall: 0,
            log: Vec::new(),
        }
    }

    fn now(&self) -> Now {
        Now::new(Millis(self.mono), wall(self.wall))
    }

    fn record(&mut self, actions: Vec<PromptAction>) {
        self.log.extend(actions.iter().map(describe));
    }

    fn run_until(&mut self, mono: u64) {
        let mut wakes = 0;
        while let Some(due) = self.planner.next_deadline().filter(|d| d.0 <= mono) {
            wakes += 1;
            assert!(wakes < 1_000, "deadline loop at {due:?}");
            let step = due.0.saturating_sub(self.mono);
            self.mono = self.mono.max(due.0);
            self.wall += step as i64;
            let actions = self.planner.tick(self.now());
            self.record(actions);
        }
        let step = mono.saturating_sub(self.mono);
        self.mono = self.mono.max(mono);
        self.wall += step as i64;
    }

    fn suspend(&mut self, wall_ms: i64, mono_ms: u64) {
        self.wall += wall_ms;
        self.mono += mono_ms;
        let actions = self.planner.tick(self.now());
        self.record(actions);
    }

    fn take(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log)
    }
}

const HOUR: u64 = 60 * MIN;

#[test]
fn system_sleep_never_starts_a_recording_from_a_stale_countdown() {
    for mono_advances in [0, 2 * HOUR] {
        let mut c = Clocks::new(PromptConfig {
            auto_record: AutoRecord::Scheduled,
            ..PromptConfig::default()
        });
        let actions = c.planner.set_events(
            c.now(),
            vec![ev("e1", "Board", 10 * MIN as i64, 30 * MIN as i64, true)],
        );
        c.record(actions);
        c.run_until(10 * MIN + 2_000);
        let before = c.take();
        assert!(
            before.iter().any(|a| a.contains("countdown 605000")),
            "{before:?}"
        );
        c.suspend(2 * HOUR as i64, mono_advances);
        c.run_until(c.mono + 10 * MIN);
        assert_eq!(
            c.take(),
            vec!["dismiss #1 EventOver".to_string()],
            "mono advanced {mono_advances}"
        );
        assert!(c.planner.visible().next().is_none());
    }

    for mono_advances in [0, 2 * HOUR] {
        let mut c = Clocks::new(PromptConfig {
            auto_record: AutoRecord::Detected,
            ..PromptConfig::default()
        });
        c.run_until(1_000);
        let actions = c
            .planner
            .on_detect(c.now(), &DetectEvent::CallStarted(call("zoom", 1_000)));
        c.record(actions);
        assert_eq!(
            c.take(),
            vec!["show #1 Detected Meeting detected | Zoom countdown 6000".to_string()]
        );
        c.run_until(3_000);
        c.suspend(2 * HOUR as i64, mono_advances);
        c.run_until(c.mono + 10 * MIN);
        assert_eq!(
            c.take(),
            vec!["dismiss #1 TimedOut".to_string()],
            "mono advanced {mono_advances}"
        );
    }
}

#[test]
fn reminders_after_system_sleep_follow_the_lateness_rule_once() {
    let range = |start: i64| format!("{}-{}", start / 1000, (start + 30 * MIN as i64) / 1000);
    for mono_advances in [0, 2 * HOUR] {
        let mut c = Clocks::new(PromptConfig::default());
        let wake = 2 * HOUR as i64 + MIN as i64;
        let events = vec![
            ev("during", "During", HOUR as i64, 30 * MIN as i64, true),
            ev(
                "five",
                "Five late",
                wake - 5 * MIN as i64,
                30 * MIN as i64,
                true,
            ),
            ev(
                "three",
                "Three late",
                wake - 3 * MIN as i64,
                30 * MIN as i64,
                true,
            ),
            ev("soon", "Soon", wake + 30_000, 30 * MIN as i64, true),
            ev(
                "later",
                "Later",
                wake + 20 * MIN as i64,
                30 * MIN as i64,
                true,
            ),
        ];
        let actions = c.planner.set_events(c.now(), events.clone());
        c.record(actions);
        c.run_until(MIN);
        assert!(c.take().is_empty());
        c.suspend(2 * HOUR as i64, mono_advances);
        assert_eq!(
            c.take(),
            vec![
                format!(
                    "show #1 Scheduled Three late | {}",
                    range(wake - 3 * MIN as i64)
                ),
                format!("show #2 Scheduled Soon | {}", range(wake + 30_000)),
            ],
            "mono advanced {mono_advances}"
        );
        let actions = c.planner.set_events(c.now(), events);
        c.record(actions);
        let actions = c.planner.tick(c.now());
        c.record(actions);
        assert!(c.take().is_empty());
        c.run_until(c.mono + 40 * MIN);
        let log = c.take();
        let shows: Vec<&String> = log.iter().filter(|a| a.starts_with("show")).collect();
        assert_eq!(shows.len(), 1, "{log:?}");
        assert!(shows[0].contains("Later"), "{log:?}");
        assert!(log.iter().any(|a| a == "dismiss #1 EventOver"), "{log:?}");
        assert!(log.iter().any(|a| a == "dismiss #2 EventOver"), "{log:?}");
    }
}
