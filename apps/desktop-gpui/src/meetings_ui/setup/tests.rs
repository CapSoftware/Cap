use cap_meetings::settings::{Engine, MeetingSettings};
use gpui::{Entity, TestAppContext, VisualTestContext, size};

use super::{Ask, Perm, SetupWindow, Stage, Step, resume_step};
use crate::meetings::Meetings;
use crate::meetings_ui::settings::{shared::Access, tests::install};

fn open(
    cx: &mut TestAppContext,
    initial: MeetingSettings,
    step: Step,
) -> (
    Entity<SetupWindow>,
    Entity<Meetings>,
    VisualTestContext,
    crate::meetings_ui::settings::tests::Fixture,
) {
    let (meetings, fixture) = install(cx, initial);
    let window = cx.open_window(
        size(gpui::px(super::SETUP_WIDTH), gpui::px(super::SETUP_HEIGHT)),
        |window, cx| SetupWindow::new(Some(step), window, cx),
    );
    let view = window.root(cx).unwrap();
    let visual = VisualTestContext::from_window(window.into(), cx);
    visual.run_until_parked();
    (view, meetings, visual, fixture)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

#[test]
fn a_reopened_setup_resumes_where_it_was_left() {
    let fresh = MeetingSettings::default();
    assert_eq!(resume_step(&fresh, None), Step::Welcome);
    assert_eq!(resume_step(&fresh, Some(Step::Calendar)), Step::Calendar);
    assert_eq!(resume_step(&fresh, Some(Step::Ready)), Step::Behavior);
    let done = MeetingSettings {
        setup_completed: true,
        ..MeetingSettings::default()
    };
    assert_eq!(resume_step(&done, Some(Step::Calendar)), Step::Welcome);
    for step in Step::ALL {
        assert_eq!(Step::from_slug(step.slug()), Some(step));
    }
}

#[gpui::test]
fn the_microphone_gates_permissions_and_every_other_step_can_be_skipped(cx: &mut TestAppContext) {
    let (view, meetings, mut cx, _fixture) = open(cx, MeetingSettings::default(), Step::Welcome);
    let next = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| view.update(cx, |v, cx| v.next(window, cx)));
    };
    next(&mut cx);
    assert_eq!(view.read_with(&mut cx, |v, _| v.step), Step::Permissions);
    view.update(&mut cx, |v, _| {
        v.mic = Access::Denied;
        v.audio = Access::NotDetermined;
    });
    draw(&mut cx);
    next(&mut cx);
    assert_eq!(view.read_with(&mut cx, |v, _| v.step), Step::Permissions);
    view.update(&mut cx, |v, _| v.mic = Access::Granted);
    next(&mut cx);
    assert_eq!(view.read_with(&mut cx, |v, _| v.step), Step::Transcription);
    draw(&mut cx);
    for expected in [Step::Calendar, Step::Behavior, Step::Ready] {
        next(&mut cx);
        assert_eq!(view.read_with(&mut cx, |v, _| v.step), expected);
        draw(&mut cx);
    }
    cx.update(|window, cx| view.update(cx, |v, cx| v.back(window, cx)));
    assert_eq!(view.read_with(&mut cx, |v, _| v.step), Step::Behavior);
    assert!(!meetings.read_with(&mut cx, |m, _| m.settings().setup_completed));
}

#[gpui::test]
fn done_completes_setup_and_turns_notes_on(cx: &mut TestAppContext) {
    let initial = MeetingSettings {
        notifications: cap_meetings::settings::NotificationSettings {
            detected: false,
            scheduled: false,
            ..Default::default()
        },
        ..MeetingSettings::default()
    };
    let (view, meetings, mut cx, _fixture) = open(cx, initial, Step::Ready);
    draw(&mut cx);
    view.update(&mut cx, |v, cx| v.finish(cx));
    let settings = meetings.read_with(&mut cx, |m, _| m.settings().clone());
    assert!(settings.setup_completed);
    assert!(settings.enabled);
}

#[gpui::test]
fn the_permission_poll_runs_only_on_its_step(cx: &mut TestAppContext) {
    let (view, _meetings, mut cx, _fixture) =
        open(cx, MeetingSettings::default(), Step::Transcription);
    view.update(&mut cx, |v, _| v.visible_override = Some(true));
    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Permissions, window, cx)));
    assert!(view.read_with(&mut cx, |v, _| v.poll.is_some()));
    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Transcription, window, cx)));
    assert!(view.read_with(&mut cx, |v, _| v.poll.is_none()));

    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Permissions, window, cx)));
    view.update(&mut cx, |v, _| v.visible_override = Some(false));
    cx.executor()
        .advance_clock(crate::meetings_ui::settings::shared::PERMISSION_POLL * 2);
    cx.run_until_parked();
    assert!(
        view.read_with(&mut cx, |v, _| v.poll.is_none()),
        "a hidden window stops polling"
    );
}

#[gpui::test]
fn the_transcription_step_preselects_and_records_the_choice(cx: &mut TestAppContext) {
    let (view, meetings, mut cx, _fixture) = open(cx, MeetingSettings::default(), Step::Calendar);
    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Transcription, window, cx)));
    let engine = meetings.read_with(&mut cx, |m, _| m.settings().transcription.engine);
    assert_eq!(engine, Engine::Local, "no Cap Pro account here");
    view.update(&mut cx, |v, cx| {
        v.update_settings(cx, |s| s.transcription.engine = Engine::Cloud)
    });
    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Calendar, window, cx)));
    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Transcription, window, cx)));
    assert_eq!(
        meetings.read_with(&mut cx, |m, _| m.settings().transcription.engine),
        Engine::Cloud,
        "coming back keeps the choice"
    );
    draw(&mut cx);
}

#[gpui::test]
fn the_permission_card_walks_through_what_is_missing(cx: &mut TestAppContext) {
    let (view, _meetings, mut cx, _fixture) =
        open(cx, MeetingSettings::default(), Step::Permissions);
    view.update(&mut cx, |v, _| {
        v.mic = Access::NotDetermined;
        v.audio = Access::NotDetermined;
        v.accessibility = Access::NotDetermined;
    });
    let stage = |cx: &mut VisualTestContext| view.read_with(cx, |v, _| v.current_stage());
    let settle = |cx: &mut VisualTestContext| {
        draw(cx);
        cx.executor()
            .advance_clock(std::time::Duration::from_secs(2));
        cx.run_until_parked();
    };
    draw(&mut cx);
    assert_eq!(stage(&mut cx), Stage::Permission(Perm::Microphone));
    view.update(&mut cx, |v, _| v.mic = Access::Granted);
    settle(&mut cx);
    assert_eq!(stage(&mut cx), Stage::Permission(Perm::Audio));
    view.update(&mut cx, |v, _| v.audio = Access::Granted);
    let shown = view.read_with(&mut cx, |v, _| v.shown_perms());
    if shown.contains(&Perm::Accessibility) {
        assert_eq!(stage(&mut cx), Stage::Permission(Perm::Accessibility));
        view.update(&mut cx, |v, cx| v.skip_accessibility(cx));
    }
    draw(&mut cx);
    assert_eq!(
        stage(&mut cx),
        Stage::Permission(Perm::Audio),
        "a permission granted on the card holds there for a moment"
    );
    cx.executor()
        .advance_clock(std::time::Duration::from_secs(2));
    cx.run_until_parked();
    assert_eq!(stage(&mut cx), Stage::AllSet);
    view.update(&mut cx, |v, cx| v.focus_permission(Perm::Microphone, cx));
    assert_eq!(
        stage(&mut cx),
        Stage::Permission(Perm::Microphone),
        "a clicked row stays on the card"
    );
    draw(&mut cx);
}

#[gpui::test]
fn computer_audio_shows_where_the_request_stands(cx: &mut TestAppContext) {
    let (view, _meetings, mut cx, _fixture) =
        open(cx, MeetingSettings::default(), Step::Permissions);
    let audio = Perm::Audio.index();
    view.update(&mut cx, |v, _| {
        v.mic = Access::Granted;
        v.audio = Access::NotDetermined;
        v.asks[audio] = Ask::Waiting;
    });
    draw(&mut cx);
    view.update(&mut cx, |v, cx| v.audio_answered(Access::NotDetermined, cx));
    assert_eq!(
        view.read_with(&mut cx, |v, _| v.asks[audio]),
        Ask::NoAnswer,
        "a request that comes back unanswered says so instead of resetting"
    );
    draw(&mut cx);
    view.update(&mut cx, |v, cx| v.audio_answered(Access::Denied, cx));
    assert_eq!(view.read_with(&mut cx, |v, _| v.asks[audio]), Ask::Idle);
    assert_eq!(view.read_with(&mut cx, |v, _| v.audio), Access::Denied);
    draw(&mut cx);
    view.update(&mut cx, |v, cx| v.audio_answered(Access::Granted, cx));
    draw(&mut cx);
    assert!(view.read_with(&mut cx, |v, _| v.audio.ready()));
    assert_eq!(
        view.read_with(&mut cx, |v, _| v.marks[audio].0),
        super::Mark::Granted
    );
}

#[gpui::test]
fn leaving_the_step_drops_a_pending_prompt_wait(cx: &mut TestAppContext) {
    let (view, _meetings, mut cx, _fixture) =
        open(cx, MeetingSettings::default(), Step::Permissions);
    let audio = Perm::Audio.index();
    view.update(&mut cx, |v, _| v.asks[audio] = Ask::Waiting);
    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Welcome, window, cx)));
    assert_eq!(view.read_with(&mut cx, |v, _| v.asks[audio]), Ask::Idle);
    view.update(&mut cx, |v, _| v.mic = Access::Granted);
    cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Permissions, window, cx)));
    let revision = view.read_with(&mut cx, |v, _| v.step_revision);
    assert_eq!(revision, 2, "every step change replays the entrance");
}

#[gpui::test]
fn every_step_renders_in_both_appearances(cx: &mut TestAppContext) {
    let (view, _meetings, mut cx, _fixture) = open(cx, MeetingSettings::default(), Step::Welcome);
    for dark in [false, true] {
        view.update(&mut cx, |v, _| {
            v.theme = if dark {
                crate::theme::Theme::dark()
            } else {
                crate::theme::Theme::light()
            };
            v.mic = Access::Granted;
            v.link_open = true;
        });
        for step in Step::ALL {
            cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(step, window, cx)));
            draw(&mut cx);
        }
        cx.update(|window, cx| view.update(cx, |v, cx| v.go_to(Step::Welcome, window, cx)));
    }
}

/// From macOS 27.3 Accessibility can't be granted from a prompt or the
/// Accessibility list (issue #4410), so setup leaves the step out there
/// instead of leading to System & App Protection Override.
#[test]
fn the_accessibility_step_shows_only_where_it_can_be_granted() {
    use super::permissions::accessibility_step_shown;
    assert!(accessibility_step_shown(true, false), "macOS before 27.3");
    assert!(
        !accessibility_step_shown(true, true),
        "macOS 27.3 and later"
    );
    assert!(!accessibility_step_shown(false, false), "Windows and Linux");
}

#[gpui::test]
fn use_cap_cloud_in_setup_on_a_slow_computer_switches_the_engine(cx: &mut TestAppContext) {
    crate::meetings::device::TEST_CLASS.with(|c| c.set(crate::meetings::device::Class::IntelMac));
    let initial = MeetingSettings {
        setup_completed: true,
        ..MeetingSettings::default()
    };
    let (view, meetings, mut cx, _fixture) = open(cx, initial, Step::Transcription);
    view.update(&mut cx, |v, _| {
        v.cloud = crate::meetings_ui::settings::shared::CloudState::Available
    });
    draw(&mut cx);
    assert_eq!(
        meetings.read_with(&mut cx, |m, _| m.settings().transcription.engine),
        Engine::Local
    );
    view.update(&mut cx, |v, cx| {
        v.run_cloud_action(
            crate::meetings_ui::settings::shared::CloudAction::UseCloud,
            cx,
        )
    });
    assert_eq!(
        meetings.read_with(&mut cx, |m, _| m.settings().transcription.engine),
        Engine::Cloud
    );
    draw(&mut cx);
    crate::meetings::device::TEST_CLASS.with(|c| c.set(crate::meetings::device::Class::Capable));
}
