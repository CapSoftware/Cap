use super::*;
use crate::detect::ActiveCall;
use crate::test_rng::Rng;

const MIN: u64 = 60_000;

struct Sim {
    session: Session,
    now: u64,
    log: Vec<(u64, SessionAction)>,
}

impl Sim {
    fn new() -> Self {
        Self::with(SessionConfig::default())
    }

    fn with(config: SessionConfig) -> Self {
        Self {
            session: Session::new(config),
            now: 0,
            log: Vec::new(),
        }
    }

    fn record(&mut self, actions: Vec<SessionAction>) -> &mut Self {
        let now = self.now;
        self.log.extend(actions.into_iter().map(|a| (now, a)));
        self
    }

    fn at(&mut self, t: u64) -> &mut Self {
        while let Some(due) = self.session.next_deadline() {
            if due.0 > t {
                break;
            }
            assert!(due.0 >= self.now);
            self.now = due.0;
            let actions = self.session.tick(due);
            assert!(!actions.is_empty(), "spurious wake at {}", self.now);
            self.record(actions);
        }
        self.now = self.now.max(t);
        self
    }

    fn m(&self) -> Millis {
        Millis(self.now)
    }

    fn start(&mut self, app: Option<&str>) -> &mut Self {
        let a = self.session.start(self.m(), app.map(str::to_string));
        self.record(a)
    }

    fn captured(&mut self) -> &mut Self {
        let a = self.session.on_capture_started(self.m());
        self.record(a)
    }

    fn recording(&mut self, app: Option<&str>) -> &mut Self {
        self.start(app).captured();
        self.log.clear();
        self
    }

    fn stopped(&mut self, chars: usize) -> &mut Self {
        let a = self.session.on_capture_stopped(self.m(), chars);
        self.record(a)
    }

    fn stop(&mut self, reason: StopReason) -> &mut Self {
        let a = self.session.stop(self.m(), reason);
        self.record(a)
    }

    fn speech(&mut self, source: Source, ms: u64) -> &mut Self {
        let a = self.session.on_speech(self.m(), source, ms);
        self.record(a)
    }

    fn call_ended(&mut self, app: &str) -> &mut Self {
        let event = DetectEvent::CallEnded {
            app_id: app.into(),
            ended_at: self.m(),
            held_for_ms: 0,
        };
        let a = self.session.on_detect(self.m(), &event);
        self.record(a)
    }

    fn call_started(&mut self, app: &str) -> &mut Self {
        let event = DetectEvent::CallStarted(ActiveCall {
            app_id: app.into(),
            app_name: app.into(),
            kind: crate::apps::AppKind::Meeting,
            call_noun: crate::apps::CallNoun::Meeting,
            started_at: self.m(),
            pids: Vec::new(),
            web: None,
        });
        let a = self.session.on_detect(self.m(), &event);
        self.record(a)
    }

    fn keep(&mut self) -> &mut Self {
        let a = self.session.keep_recording(self.m());
        self.record(a)
    }

    fn sleep(&mut self) -> &mut Self {
        let a = self.session.on_sleep(self.m());
        self.record(a)
    }

    fn wake(&mut self) -> &mut Self {
        let a = self.session.on_wake(self.m());
        self.record(a)
    }

    fn resume(&mut self) -> &mut Self {
        let a = self.session.resume(self.m());
        self.record(a)
    }

    fn call_still_on(&mut self) -> &mut Self {
        let a = self.session.call_still_on_after_wake(self.m());
        self.record(a)
    }

    fn error(&mut self) -> &mut Self {
        let a = self.session.on_capture_error(self.m());
        self.record(a)
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

    fn far_speech(&mut self, total_ms: u64) -> &mut Self {
        let a = self.session.on_speech(self.m(), Source::System, total_ms);
        self.record(a);
        self.log.clear();
        self
    }
}

fn describe(action: &SessionAction) -> String {
    match action {
        SessionAction::StartCapture { resume: false } => "start".into(),
        SessionAction::StartCapture { resume: true } => "resume".into(),
        SessionAction::StopCapture { reason } => format!("stop {reason:?}"),
        SessionAction::ShowEndingCountdown { stop_at } => format!("ending {}", stop_at.0),
        SessionAction::ShowInactivityWarning { stop_at } => format!("inactive {}", stop_at.0),
        SessionAction::ClearWarning => "clear".into(),
        SessionAction::OfferResume { until } => format!("offer {}", until.0),
        SessionAction::GenerateNotes => "notes".into(),
        SessionAction::JoinedCall { app_id } => format!("joined {app_id}"),
        SessionAction::LeftCall => "left".into(),
    }
}

#[test]
fn user_start_stop_and_notes_threshold() {
    let mut s = Sim::new();
    s.start(Some("zoom")).expect(&[(0, "start")]);
    assert_eq!(s.session.state(), SessionState::Starting);
    s.at(500).captured().quiet();
    assert_eq!(s.session.state(), SessionState::Recording);
    s.at(60_000)
        .stop(StopReason::User)
        .expect(&[(60_000, "stop User")]);
    assert_eq!(s.session.state(), SessionState::Stopping);
    s.at(61_000).stopped(400).expect(&[(61_000, "notes")]);
    assert_eq!(s.session.state(), SessionState::Idle);

    s.start(None)
        .captured()
        .stop(StopReason::UserFromIndicator)
        .take();
    s.stopped(399).quiet();

    let mut s = Sim::with(SessionConfig {
        auto_generate_notes: false,
        ..SessionConfig::default()
    });
    s.recording(None).stop(StopReason::User).stopped(10_000);
    s.expect(&[(0, "stop User")]);
}

#[test]
fn a_short_call_that_ends_counts_down_like_a_long_one() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(MIN).far_speech(60_000);
    s.at(2 * MIN)
        .call_ended("zoom")
        .expect(&[(120_000, "ending 140000")]);
    s.at(139_999).quiet();
    s.at(140_000)
        .expect(&[(140_000, "clear"), (140_000, "stop CallEnded")]);
    assert_eq!(s.session.last_stop_reason(), Some(StopReason::CallEnded));
}

#[test]
fn a_short_call_dropping_the_microphone_for_a_moment_keeps_recording() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(MIN).call_ended("zoom").take();
    s.at(MIN + 4_000)
        .call_started("zoom")
        .expect(&[(64_000, "clear")]);
    s.at(3 * MIN).quiet();
    assert_eq!(s.session.state(), SessionState::Recording);
}

#[test]
fn keeping_a_call_end_that_replaced_the_inactivity_warning_counts_as_activity() {
    let mut s = Sim::with(SessionConfig {
        inactivity_warn_ms: Some(MIN),
        ..SessionConfig::default()
    });
    s.recording(Some("zoom"));
    s.at(MIN).expect(&[(60_000, "inactive 180000")]);
    s.at(MIN + 10_000)
        .call_ended("zoom")
        .expect(&[(70_000, "ending 90000")]);
    s.at(MIN + 15_000).keep().expect(&[(75_000, "clear")]);
    assert_eq!(s.session.next_deadline(), Some(Millis(75_000 + MIN)));
    s.at(75_000 + MIN).expect(&[(135_000, "inactive 255000")]);
}

#[test]
fn a_call_joined_after_starting_notes_ends_the_meeting_with_it() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(30_000)
        .call_started("zoom")
        .expect(&[(30_000, "joined zoom")]);
    assert_eq!(s.session.attached_app(), Some("zoom"));
    s.at(2 * MIN).far_speech(70_000);
    s.at(3 * MIN)
        .call_ended("zoom")
        .expect(&[(180_000, "ending 200000")]);
    s.at(200_000)
        .expect(&[(200_000, "clear"), (200_000, "stop CallEnded")]);
}

#[test]
fn a_call_that_begins_late_in_a_meeting_without_one_is_not_its_call() {
    let mut s = Sim::with(SessionConfig {
        inactivity_warn_ms: None,
        ..SessionConfig::default()
    });
    s.recording(None);
    s.at(5 * MIN).call_started("zoom").quiet();
    assert_eq!(s.session.attached_app(), None);
    s.at(7 * MIN).far_speech(120_000);
    s.call_ended("zoom").quiet();
    assert_eq!(s.session.state(), SessionState::Recording);
}

#[test]
fn a_short_call_joined_before_a_minute_of_speech_never_ends_the_notes() {
    let mut s = Sim::with(SessionConfig {
        inactivity_warn_ms: None,
        ..SessionConfig::default()
    });
    s.recording(None);
    s.at(MIN)
        .call_started("slack")
        .expect(&[(60_000, "joined slack")]);
    s.speech(Source::Mic, 40_000).take();
    s.at(90_000).call_ended("slack").expect(&[(90_000, "left")]);
    assert_eq!(s.session.attached_app(), None);
    s.at(4 * MIN).quiet();
    assert_eq!(s.session.state(), SessionState::Recording);
    s.call_started("zoom").expect(&[(240_000, "joined zoom")]);
}

#[test]
fn a_false_end_of_a_short_call_is_kept_with_keep_recording() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(90_000).call_ended("zoom").take();
    s.at(95_000).keep().expect(&[(95_000, "clear")]);
    s.at(4 * MIN).quiet();
    assert_eq!(s.session.state(), SessionState::Recording);
}

#[test]
fn call_end_after_far_speech_floor_counts_down() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(4 * MIN).far_speech(180_000);
    s.call_ended("zoom").expect(&[(240_000, "ending 260000")]);
    s.at(259_999).quiet();
    s.at(260_000)
        .expect(&[(260_000, "clear"), (260_000, "stop CallEnded")]);
    s.stopped(5_000).expect(&[(260_000, "notes")]);
    assert_eq!(s.session.last_stop_reason(), Some(StopReason::CallEnded));
}

#[test]
fn call_end_after_five_minutes_without_far_speech() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(5 * MIN).call_ended("zoom");
    s.expect(&[(300_000, "ending 320000")]);
}

#[test]
fn call_end_near_event_end_uses_short_countdown() {
    let quiet_room = SessionConfig {
        inactivity_warn_ms: None,
        ..SessionConfig::default()
    };
    let mut s = Sim::with(quiet_room.clone());
    s.recording(Some("teams"));
    s.session.set_linked_event_end(Some(Millis(30 * MIN)));
    s.at(26 * MIN).call_ended("teams");
    s.expect(&[(1_560_000, "ending 1570000")]);
    s.at(26 * MIN + 10_000).expect(&[
        (1_570_000, "clear"),
        (1_570_000, "stop CallEndedNearEventEnd"),
    ]);

    let mut s = Sim::with(quiet_room);
    s.recording(Some("teams"));
    s.session.set_linked_event_end(Some(Millis(30 * MIN)));
    s.at(35 * MIN + 1).call_ended("teams");
    s.expect(&[(2_100_001, "ending 2120001")]);
}

#[test]
fn keep_recording_suppresses_until_next_release() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(6 * MIN).call_ended("zoom").take();
    s.at(6 * MIN + 5_000).keep().expect(&[(365_000, "clear")]);
    s.at(7 * MIN).call_ended("zoom").quiet();
    s.at(8 * MIN).call_started("zoom").quiet();
    s.at(9 * MIN).call_ended("zoom");
    s.expect(&[(540_000, "ending 560000")]);
}

#[test]
fn reacquire_during_countdown_cancels_silently() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(6 * MIN).call_ended("zoom").take();
    s.at(6 * MIN + 3_000)
        .call_started("zoom")
        .expect(&[(363_000, "clear")]);
    s.at(9 * MIN).quiet();
    assert_eq!(s.session.state(), SessionState::Recording);
}

#[test]
fn call_end_for_other_app_or_disabled_setting() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(6 * MIN).call_ended("teams").quiet();
    let mut s = Sim::with(SessionConfig {
        stop_when_call_ends: false,
        ..SessionConfig::default()
    });
    s.recording(Some("zoom"));
    s.at(6 * MIN).call_ended("zoom").quiet();
    let mut s = Sim::new();
    s.recording(None);
    s.at(6 * MIN).call_ended("zoom").quiet();
    s.session.set_attached_app(Some("zoom".into()));
    s.call_ended("zoom").expect(&[(360_000, "ending 380000")]);
}

#[test]
fn inactivity_warns_clears_and_stops_with_resume_offer() {
    let mut s = Sim::new();
    s.recording(None);
    assert_eq!(s.session.next_deadline(), Some(Millis(10 * MIN)));
    s.at(10 * MIN).expect(&[(600_000, "inactive 720000")]);
    s.at(11 * MIN)
        .speech(Source::Mic, 1_500)
        .expect(&[(660_000, "clear")]);
    assert_eq!(s.session.next_deadline(), Some(Millis(21 * MIN)));
    s.at(21 * MIN).expect(&[(1_260_000, "inactive 1380000")]);
    s.at(23 * MIN).expect(&[
        (1_380_000, "clear"),
        (1_380_000, "stop Inactivity"),
        (1_380_000, "offer 1410000"),
    ]);
    s.at(23 * MIN + 1_000).stopped(2_000).quiet();
    s.at(23 * MIN + 30_000).expect(&[(1_410_000, "notes")]);
}

#[test]
fn resume_during_offer_skips_notes_and_continues() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(12 * MIN).take();
    s.stopped(2_000).quiet();
    s.at(12 * MIN + 10_000)
        .resume()
        .expect(&[(730_000, "resume")]);
    s.captured();
    s.at(13 * MIN).quiet();
    s.stop(StopReason::User).stopped(2_500);
    s.expect(&[(780_000, "stop User"), (780_000, "notes")]);
}

#[test]
fn resume_while_stopping_is_queued() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(12 * MIN).take();
    s.resume().quiet();
    s.at(12 * MIN + 500)
        .stopped(1_000)
        .expect(&[(720_500, "resume")]);
    s.at(12 * MIN + 900).captured().quiet();
    s.at(20 * MIN).quiet();
}

#[test]
fn decline_resume_generates_notes_immediately() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(12 * MIN).take();
    s.stopped(1_000);
    let a = s.session.decline_resume(Millis(12 * MIN + 1_000));
    assert_eq!(a, vec![SessionAction::GenerateNotes]);
    assert_eq!(s.session.next_deadline(), None);
}

#[test]
fn inactivity_disabled_has_no_deadline() {
    let mut s = Sim::with(SessionConfig {
        inactivity_warn_ms: None,
        ..SessionConfig::default()
    });
    s.recording(None);
    assert_eq!(s.session.next_deadline(), None);
    s.at(10 * 60 * MIN).quiet();
}

#[test]
fn keep_recording_on_inactivity_warning_resets_timer() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(10 * MIN).take();
    s.at(10 * MIN + 30_000).keep().expect(&[(630_000, "clear")]);
    assert_eq!(s.session.next_deadline(), Some(Millis(20 * MIN + 30_000)));
}

#[test]
fn sleep_stops_and_wake_offers_resume_before_the_notes() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(5 * MIN).sleep().expect(&[(300_000, "stop Sleep")]);
    s.stopped(5_000).quiet();
    s.sleep().quiet();
    assert_eq!(s.session.next_deadline(), None);
    s.at(60 * MIN)
        .wake()
        .expect(&[(3_600_000, "offer 3900000")]);
    s.wake().quiet();
    s.at(65 * MIN).expect(&[(3_900_000, "notes")]);
    s.resume().expect(&[(3_900_000, "resume")]);
}

#[test]
fn resume_after_wake_continues_the_same_meeting() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(30 * MIN)
        .wake()
        .expect(&[(1_800_000, "offer 2100000")]);
    s.at(30 * MIN + 5_000)
        .resume()
        .expect(&[(1_805_000, "resume")]);
    s.captured();
    s.at(31 * MIN).stop(StopReason::User).stopped(6_000);
    s.expect(&[(1_860_000, "stop User"), (1_860_000, "notes")]);
}

#[test]
fn declining_resume_after_wake_writes_the_notes_now() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(30 * MIN).wake().take();
    let a = s.session.decline_resume(Millis(30 * MIN + 2_000));
    assert_eq!(a, vec![SessionAction::GenerateNotes]);
    assert_eq!(s.session.next_deadline(), None);
}

#[test]
fn sleep_before_stop_confirmed_defers_until_both() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(MIN).sleep().take();
    s.at(30 * MIN)
        .wake()
        .expect(&[(1_800_000, "offer 2100000")]);
    s.stopped(5_000).quiet();
    s.at(35 * MIN).expect(&[(2_100_000, "notes")]);
}

#[test]
fn lid_closed_past_the_meetings_end_still_offers_then_writes_notes() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.session.set_linked_event_end(Some(Millis(20 * MIN)));
    s.at(10 * MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(90 * MIN)
        .wake()
        .expect(&[(5_400_000, "offer 5430000")]);
    s.at(91 * MIN).expect(&[(5_430_000, "notes")]);
}

#[test]
fn sleep_during_the_after_stop_pass_writes_notes_on_wake_as_before() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(5 * MIN)
        .stop(StopReason::User)
        .expect(&[(300_000, "stop User")]);
    s.sleep().quiet();
    s.stopped(5_000).quiet();
    s.at(40 * MIN).wake().expect(&[(2_400_000, "notes")]);
}

#[test]
fn a_second_sleep_while_resume_is_offered_offers_it_again() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(10 * MIN).wake().expect(&[(600_000, "offer 900000")]);
    s.at(10 * MIN + 10_000).sleep().quiet();
    assert_eq!(s.session.next_deadline(), None);
    s.at(50 * MIN)
        .wake()
        .expect(&[(3_000_000, "offer 3300000")]);
    s.at(55 * MIN).expect(&[(3_300_000, "notes")]);
}

#[test]
fn sleep_during_an_inactivity_offer_offers_it_again_on_wake() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(12 * MIN).take();
    s.stopped(2_000).quiet();
    s.at(12 * MIN + 5_000).sleep().quiet();
    s.at(40 * MIN)
        .wake()
        .expect(&[(2_400_000, "offer 2430000")]);
    s.at(41 * MIN).expect(&[(2_430_000, "notes")]);
}

#[test]
fn a_call_still_on_after_the_wake_resumes_the_same_meeting_by_itself() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(5 * MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(20 * MIN)
        .wake()
        .expect(&[(1_200_000, "offer 1500000")]);
    assert_eq!(
        s.session
            .call_to_look_for_after_wake(Millis(20 * MIN + 1_000)),
        Some("zoom")
    );
    s.at(20 * MIN + 1_000)
        .call_still_on()
        .expect(&[(1_201_000, "resume")]);
    s.call_still_on().quiet();
    s.captured();
    assert_eq!(s.session.resume_offer_until(), None);
    s.at(30 * MIN).stop(StopReason::User).stopped(9_000);
    s.expect(&[(1_800_000, "stop User"), (1_800_000, "notes")]);
}

#[test]
fn a_resume_may_follow_a_sleep_until_its_offer_ends() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    assert!(!s.session.resume_may_follow());
    s.at(5 * MIN).sleep().take();
    assert!(s.session.resume_may_follow(), "the wake will offer it");
    s.stopped(5_000).quiet();
    s.at(20 * MIN).wake().take();
    assert!(s.session.resume_may_follow(), "offered");
    s.at(25 * MIN).expect(&[(1_500_000, "notes")]);
    assert!(!s.session.resume_may_follow(), "the offer ended");

    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(5 * MIN).sleep().take();
    s.at(20 * MIN).wake().take();
    s.at(20 * MIN + 500).call_still_on().quiet();
    assert!(s.session.resume_may_follow(), "asked for before the capture stopped");

    let mut s = Sim::new();
    s.recording(None);
    s.at(MIN).stop(StopReason::User).stopped(0);
    assert!(!s.session.resume_may_follow());
}

#[test]
fn a_call_on_the_microphone_long_after_the_wake_does_not_resume() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(5 * MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(20 * MIN).wake().take();
    let late = 20 * MIN + WAKE_CALL_WINDOW_MS + 1;
    s.at(late).call_still_on().quiet();
    assert_eq!(s.session.call_to_look_for_after_wake(Millis(late)), None);
    s.at(26 * MIN).expect(&[(1_500_000, "notes")]);
}

#[test]
fn a_call_still_on_resumes_once_the_stopped_capture_has_finished() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(5 * MIN).sleep().take();
    s.at(20 * MIN).wake().take();
    s.at(20 * MIN + 500).call_still_on().quiet();
    s.stopped(5_000).expect(&[(1_200_500, "resume")]);
}

#[test]
fn without_a_call_app_the_wake_only_offers() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(5 * MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(20 * MIN).wake().take();
    assert_eq!(s.session.call_to_look_for_after_wake(Millis(20 * MIN)), None);
    s.call_still_on().quiet();
    s.at(25 * MIN).expect(&[(1_500_000, "notes")]);
}

#[test]
fn a_meeting_already_stopped_for_a_quiet_spell_never_resumes_by_itself() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(12 * MIN).take();
    s.stopped(2_000).quiet();
    s.at(12 * MIN + 5_000).sleep().quiet();
    s.at(40 * MIN)
        .wake()
        .expect(&[(2_400_000, "offer 2430000")]);
    assert_eq!(s.session.call_to_look_for_after_wake(Millis(40 * MIN)), None);
    s.call_still_on().quiet();
    s.at(41 * MIN).expect(&[(2_430_000, "notes")]);
}

#[test]
fn a_meeting_stopped_before_the_sleep_never_resumes_by_itself() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(5 * MIN).stop(StopReason::User).take();
    s.stopped(5_000).expect(&[(300_000, "notes")]);
    s.sleep().quiet();
    s.at(20 * MIN).wake().quiet();
    s.call_still_on().quiet();
    assert_eq!(s.session.next_deadline(), None);
}

#[test]
fn a_call_that_ended_keeps_resume_until_the_calendar_event_ends() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.session.set_linked_event_end(Some(Millis(60 * MIN)));
    s.at(10 * MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(20 * MIN)
        .wake()
        .expect(&[(1_200_000, "offer 3600000")]);
    s.at(50 * MIN).resume().expect(&[(3_000_000, "resume")]);

    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.session.set_linked_event_end(Some(Millis(60 * MIN)));
    s.at(10 * MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(20 * MIN).wake().take();
    s.at(59 * MIN).quiet();
    s.at(60 * MIN).expect(&[(3_600_000, "notes")]);
}

#[test]
fn an_event_about_to_end_still_gets_the_usual_offer() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.session
        .set_linked_event_end(Some(Millis(20 * MIN + 10_000)));
    s.at(10 * MIN).sleep().take();
    s.stopped(5_000).quiet();
    s.at(20 * MIN)
        .wake()
        .expect(&[(1_200_000, "offer 1230000")]);
}

#[test]
fn sleep_while_idle_does_nothing() {
    let mut s = Sim::new();
    s.sleep().wake().quiet();
    s.start(None).expect(&[(0, "start")]);
}

#[test]
fn duplicate_inputs_are_ignored() {
    let mut s = Sim::new();
    s.start(None).start(Some("zoom")).expect(&[(0, "start")]);
    s.captured().captured().quiet();
    s.stop(StopReason::User)
        .stop(StopReason::User)
        .stop(StopReason::Quit);
    s.expect(&[(0, "stop User")]);
    s.stopped(1_000).stopped(1_000);
    s.expect(&[(0, "notes")]);
    s.error().quiet();
}

#[test]
fn user_stop_wins_over_pending_countdown() {
    let mut s = Sim::new();
    s.recording(Some("zoom"));
    s.at(6 * MIN).call_ended("zoom").take();
    s.at(6 * MIN + 2_000)
        .stop(StopReason::User)
        .expect(&[(362_000, "clear"), (362_000, "stop User")]);
    s.at(10 * MIN).quiet();
    assert_eq!(s.session.last_stop_reason(), Some(StopReason::User));
}

#[test]
fn error_quit_and_delete_reasons() {
    let mut s = Sim::new();
    s.start(None)
        .error()
        .expect(&[(0, "start"), (0, "stop Error")]);
    assert_eq!(s.session.state(), SessionState::Idle);
    s.stopped(1_000).quiet();

    let mut s = Sim::new();
    s.recording(None).stop(StopReason::Quit).stopped(1_000);
    s.expect(&[(0, "stop Quit")]);

    let mut s = Sim::new();
    s.recording(None).stop(StopReason::Deleted).stopped(1_000);
    s.expect(&[(0, "stop Deleted")]);
    s.resume().quiet();
}

#[test]
fn start_failures_always_return_to_idle() {
    let mut s = Sim::new();
    s.start(Some("zoom")).take();
    s.at(1_000).stopped(0).expect(&[(1_000, "stop Error")]);
    assert_eq!(s.session.state(), SessionState::Idle);
    assert_eq!(s.session.last_stop_reason(), Some(StopReason::Error));
    assert_eq!(s.session.next_deadline(), None);
    s.start(Some("zoom")).expect(&[(1_000, "start")]);
    s.captured().quiet();
    assert_eq!(s.session.state(), SessionState::Recording);

    let mut s = Sim::new();
    s.start(None).take();
    assert_eq!(s.session.next_deadline(), Some(Millis(30_000)));
    s.at(29_999).quiet();
    s.at(30_000).expect(&[(30_000, "stop Error")]);
    assert_eq!(s.session.state(), SessionState::Idle);
    s.at(31_000).captured().stopped(0).error().quiet();
    assert_eq!(s.session.state(), SessionState::Idle);
    s.start(None).expect(&[(31_000, "start")]);

    let mut s = Sim::new();
    s.recording(None);
    s.at(5 * MIN)
        .stopped(900)
        .expect(&[(300_000, "stop Error"), (300_000, "notes")]);
    assert_eq!(s.session.state(), SessionState::Idle);
    assert_eq!(s.session.recorded_ms(), 5 * MIN);

    let mut s = Sim::new();
    s.recording(None);
    s.at(12 * MIN).take();
    assert_eq!(s.session.state(), SessionState::Stopping);
    s.stopped(900).take();
    s.resume().expect(&[(720_000, "resume")]);
    s.at(720_500)
        .error()
        .expect(&[(720_500, "stop Error"), (720_500, "notes")]);
    assert_eq!(s.session.state(), SessionState::Idle);
}

#[test]
fn new_start_flushes_previous_pending_notes() {
    let mut s = Sim::new();
    s.recording(None);
    s.at(12 * MIN).take();
    s.stopped(2_000).quiet();
    s.at(12 * MIN + 5_000).start(None);
    s.expect(&[(725_000, "notes"), (725_000, "start")]);
}

#[test]
fn speech_accounting_and_recorded_time() {
    let mut s = Sim::new();
    s.speech(Source::System, 5_000).quiet();
    assert_eq!(s.session.speech_ms(Source::System), 0);
    s.recording(None);
    s.speech(Source::System, 5_000).speech(Source::Mic, 2_000);
    assert_eq!(s.session.speech_ms(Source::System), 5_000);
    assert_eq!(s.session.speech_ms(Source::Mic), 2_000);
    s.at(4 * MIN).stop(StopReason::User).stopped(10);
    s.resume().captured();
    s.at(5 * MIN).tick_to_now();
    assert_eq!(s.session.recorded_ms(), 5 * MIN);
}

impl Sim {
    fn tick_to_now(&mut self) -> &mut Self {
        let a = self.session.tick(self.m());
        self.record(a)
    }
}

#[test]
fn out_of_order_time_is_clamped() {
    let mut s = Sim::new();
    s.at(10 * MIN).recording(None);
    let a = s.session.tick(Millis(MIN));
    assert!(a.is_empty());
    assert_eq!(s.session.next_deadline(), Some(Millis(20 * MIN)));
}

#[test]
fn randomised_invariants() {
    let reasons = [
        StopReason::User,
        StopReason::UserFromIndicator,
        StopReason::Quit,
        StopReason::Replaced,
        StopReason::Deleted,
    ];
    for seed in 0..80 {
        let mut rng = Rng::new(seed);
        let mut session = Session::new(SessionConfig {
            inactivity_warn_ms: if seed % 3 == 0 {
                None
            } else {
                Some(rng.below(900_000) + 1)
            },
            ..SessionConfig::default()
        });
        let mut now = 0u64;
        let mut capturing = false;
        let mut stopping = false;
        let mut notes_since_stop = 0;
        for step in 0..800 {
            if rng.chance(3) {
                now = now.saturating_sub(rng.below(10_000));
            } else {
                now += rng.below(90_000);
            }
            let t = Millis(now);
            let input = rng.below(15);
            let was_starting = session.state() == SessionState::Starting;
            if input == 2 && session.state() == SessionState::Stopping {
                stopping = false;
            }
            let actions = match input {
                0 => session.start(t, Some("zoom".into())),
                1 => session.on_capture_started(t),
                2 => session.on_capture_stopped(t, rng.below(1_000) as usize),
                3 => session.stop(t, *rng.pick(&reasons)),
                4 => session.on_speech(
                    t,
                    if rng.chance(50) {
                        Source::Mic
                    } else {
                        Source::System
                    },
                    rng.below(200_000),
                ),
                5 => session.on_call_ended(t, if rng.chance(80) { "zoom" } else { "teams" }),
                6 => session.on_call_started(t, "zoom"),
                7 => session.keep_recording(t),
                8 => session.on_sleep(t),
                9 => {
                    let mut actions = session.on_wake(t);
                    if rng.chance(50) {
                        actions.extend(session.call_still_on_after_wake(t));
                    }
                    actions
                }
                10 => session.resume(t),
                11 => session.on_capture_error(t),
                12 => session.decline_resume(t),
                13 => session.call_still_on_after_wake(t),
                _ => match session.next_deadline() {
                    Some(due) if rng.chance(85) => {
                        now = now.max(due.0);
                        session.tick(due)
                    }
                    _ => session.tick(t),
                },
            };
            for action in &actions {
                match action {
                    SessionAction::StartCapture { .. } => {
                        assert!(
                            !capturing && !stopping,
                            "seed {seed} step {step}: start while active"
                        );
                        capturing = true;
                        notes_since_stop = 0;
                    }
                    SessionAction::StopCapture { reason } => {
                        assert!(
                            capturing,
                            "seed {seed} step {step}: stop while not capturing"
                        );
                        capturing = false;
                        stopping = !(was_starting && *reason == StopReason::Error);
                        notes_since_stop = 0;
                    }
                    SessionAction::GenerateNotes => {
                        notes_since_stop += 1;
                        assert_eq!(notes_since_stop, 1, "seed {seed} step {step}: notes twice");
                        assert!(!capturing);
                    }
                    _ => {}
                }
            }
            if session.state() == SessionState::Idle {
                stopping = false;
            }
            match session.state() {
                SessionState::Starting | SessionState::Recording => assert!(capturing),
                SessionState::Stopping => assert!(stopping),
                SessionState::Idle => assert!(!capturing),
            }
            if let Some(due) = session.next_deadline() {
                assert!(
                    due > session.now,
                    "seed {seed} step {step}: {due:?} <= {:?}",
                    session.now
                );
            }
        }
    }
}
