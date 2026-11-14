use std::sync::atomic::Ordering;

use gpui::{AppContext as _, Bounds, TestAppContext, point, px, size};

use super::*;
use crate::store::PostStudioBehaviour;

#[test]
fn every_studio_behaviour_has_one_completion() {
    assert_eq!(
        studio_completion(PostStudioBehaviour::OpenEditor),
        StudioCompletion::OpenEditor
    );
    assert_eq!(
        studio_completion(PostStudioBehaviour::ShowOverlay),
        StudioCompletion::ShowOverlay
    );
    assert_eq!(
        studio_completion(PostStudioBehaviour::DoNothing),
        StudioCompletion::StayOutOfTheWay
    );
}

#[test]
fn share_uses_the_saved_organization_only_while_it_is_still_yours() {
    let orgs = vec!["first".to_string(), "second".to_string()];
    assert_eq!(
        share_organization(Some("second"), &orgs).as_deref(),
        Some("second")
    );
    assert_eq!(
        share_organization(Some("gone"), &orgs).as_deref(),
        Some("first")
    );
    assert_eq!(share_organization(None, &orgs).as_deref(), Some("first"));
    assert_eq!(share_organization(Some("second"), &[]), None);
}

#[test]
fn the_stack_sits_in_the_bottom_left_corner_of_the_work_area() {
    let area = Bounds {
        origin: point(px(1440.), px(25.)),
        size: size(px(1920.), px(1055.)),
    };
    let one = stack_bounds(area, 1);
    assert_eq!(one.size.width, px(CARD_WIDTH + WINDOW_PADDING * 2.));
    assert_eq!(one.size.height, px(CARD_HEIGHT + WINDOW_PADDING * 2.));
    assert_eq!(one.origin.x, px(1440. + EDGE_OFFSET - WINDOW_PADDING));
    let card_bottom = one.origin.y + one.size.height - px(WINDOW_PADDING);
    assert_eq!(
        card_bottom,
        area.origin.y + area.size.height - px(EDGE_OFFSET)
    );

    let three = stack_bounds(area, 3);
    assert_eq!(
        three.size.height,
        px(3. * CARD_HEIGHT + 2. * CARD_GAP + WINDOW_PADDING * 2.)
    );
    assert_eq!(
        three.origin.y + three.size.height,
        one.origin.y + one.size.height
    );

    let tiny = Bounds {
        origin: point(px(0.), px(0.)),
        size: size(px(800.), px(120.)),
    };
    let squeezed = stack_bounds(tiny, 4);
    assert_eq!(squeezed.size.height, px(120.));
    assert_eq!(squeezed.origin.y, px(0.));
}

#[test]
fn the_card_limit_follows_the_display_height() {
    assert_eq!(max_cards(100.), 1);
    assert_eq!(max_cards(1055.), 6);
    assert_eq!(max_cards(675.), 3);
    assert_eq!(stack_height(0), 0.);
}

#[test]
fn overflow_drops_the_oldest_idle_cards_first() {
    assert!(overflow(&[false, false], 2).is_empty());
    assert_eq!(overflow(&[false, false, false], 2), vec![2]);
    assert_eq!(overflow(&[false, false, true], 2), vec![1]);
    assert_eq!(overflow(&[true, true, true], 1), Vec::<usize>::new());
    assert_eq!(overflow(&[false, true, false, false], 1), vec![3, 2, 0]);
}

#[test]
fn progress_matches_the_tauri_overlay() {
    let rendering =
        |rendered, total| ActionState::Busy(ActionKind::Copy, Stage::Rendering { rendered, total });
    assert_eq!(ActionState::Idle.progress(), 0.);
    assert_eq!(rendering(0, 0).progress(), 0.);
    assert_eq!(rendering(30, 120).progress(), 0.25);
    assert_eq!(rendering(500, 120).progress(), 1.);
    assert_eq!(
        ActionState::Busy(ActionKind::Copy, Stage::Copying).progress(),
        0.5
    );
    assert_eq!(
        ActionState::Busy(ActionKind::Save, Stage::ChoosingLocation).progress(),
        0.
    );
    assert_eq!(
        ActionState::Busy(ActionKind::Share, Stage::Uploading(0.4)).progress(),
        0.4
    );
    assert_eq!(ActionState::Done(ActionKind::Share).progress(), 1.);
    assert_eq!(
        ActionState::Failed(ActionKind::Share, "offline".into()).progress(),
        0.
    );
}

#[test]
fn every_state_has_the_title_its_action_shows() {
    let video = MediaKind::Recording;
    let image = MediaKind::Screenshot;
    let title = |state: ActionState, kind| state.title(kind);
    assert_eq!(title(ActionState::Idle, video), None);
    assert_eq!(
        title(
            ActionState::Busy(
                ActionKind::Share,
                Stage::Rendering {
                    rendered: 1,
                    total: 2
                }
            ),
            video
        ),
        Some("Rendering video")
    );
    assert_eq!(
        title(
            ActionState::Busy(ActionKind::Share, Stage::Uploading(0.)),
            video
        ),
        Some("Creating shareable link")
    );
    assert_eq!(
        title(ActionState::Done(ActionKind::Share), video),
        Some("Shareable link copied")
    );
    assert_eq!(
        title(ActionState::Done(ActionKind::Copy), image),
        Some("Copied to clipboard")
    );
    assert_eq!(
        title(
            ActionState::Busy(ActionKind::Save, Stage::ChoosingLocation),
            video
        ),
        Some("Preparing")
    );
    assert_eq!(
        title(ActionState::Busy(ActionKind::Save, Stage::Saving), image),
        Some("Saving image")
    );
    assert_eq!(
        title(ActionState::Done(ActionKind::Save), video),
        Some("Video saved")
    );
    assert_eq!(
        title(ActionState::Failed(ActionKind::Share, "x".into()), video),
        Some("Couldn't create the link")
    );

    assert_eq!(
        ActionState::Busy(ActionKind::Save, Stage::ChoosingLocation)
            .message(image)
            .as_deref(),
        Some("Choose where to save the image")
    );
    assert_eq!(
        ActionState::Busy(ActionKind::Share, Stage::Uploading(0.427))
            .message(video)
            .as_deref(),
        Some("42%")
    );
    assert_eq!(
        ActionState::Failed(ActionKind::Share, "Upload failed".into())
            .message(video)
            .as_deref(),
        Some("Upload failed")
    );
}

#[test]
fn details_read_like_the_tauri_strip() {
    assert_eq!(format_duration(0.4), "0:00");
    assert_eq!(format_duration(65.2), "1:05");
    assert_eq!(format_duration(3725.), "1:02:05");
    assert_eq!(format_size(3 * 1024 * 1024 + 512 * 1024), "3.50 MB");
}

fn bundle(dir: &tempfile::TempDir, name: &str) -> PathBuf {
    let path = dir.path().join(format!("{name}.cap"));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn paths(overlay: &Entity<Overlay>, cx: &mut TestAppContext) -> Vec<PathBuf> {
    overlay.read_with(cx, |overlay, _| {
        overlay
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect()
    })
}

#[gpui::test]
fn recordings_stack_newest_first_and_never_twice(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let first = bundle(&dir, "first");
    let second = bundle(&dir, "second");
    let overlay = cx.new(|_| Overlay::default());
    overlay.update(cx, |overlay, cx| {
        overlay.add(first.clone(), MediaKind::Recording, cx);
        overlay.add(second.clone(), MediaKind::Recording, cx);
        overlay.add(first.clone(), MediaKind::Recording, cx);
    });
    assert_eq!(paths(&overlay, cx), vec![second, first]);
}

#[gpui::test]
fn a_screenshot_joins_only_a_stack_that_is_already_up(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let screenshot = dir.path().join("shot.cap").join("shot.png");
    std::fs::create_dir_all(screenshot.parent().unwrap()).unwrap();
    std::fs::write(&screenshot, b"png").unwrap();
    let recording = bundle(&dir, "recording");
    let overlay = cx.new(|_| Overlay::default());

    overlay.update(cx, |overlay, cx| {
        overlay.set_hidden_for_capture(true, cx);
        overlay.screenshot_captured(Some(&screenshot), cx);
    });
    assert!(paths(&overlay, cx).is_empty());
    assert!(overlay.read_with(cx, |overlay, _| !overlay.hidden_for_capture));

    overlay.update(cx, |overlay, cx| {
        overlay.add(recording.clone(), MediaKind::Recording, cx);
        overlay.set_hidden_for_capture(true, cx);
        overlay.screenshot_captured(Some(&screenshot), cx);
    });
    assert_eq!(paths(&overlay, cx), vec![screenshot.clone(), recording]);
    let kind = overlay.read_with(cx, |overlay, _| overlay.entries[0].kind);
    assert_eq!(kind, MediaKind::Screenshot);

    overlay.update(cx, |overlay, cx| {
        overlay.set_hidden_for_capture(true, cx);
        overlay.screenshot_captured(None, cx);
    });
    assert_eq!(paths(&overlay, cx).len(), 2);
    assert!(overlay.read_with(cx, |overlay, _| !overlay.hidden_for_capture));
}

#[gpui::test]
fn coming_back_from_a_capture_drops_recordings_deleted_meanwhile(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let kept = bundle(&dir, "kept");
    let deleted = bundle(&dir, "deleted");
    let busy = bundle(&dir, "busy");
    let overlay = cx.new(|_| Overlay::default());
    overlay.update(cx, |overlay, cx| {
        overlay.add(kept.clone(), MediaKind::Recording, cx);
        overlay.add(deleted.clone(), MediaKind::Recording, cx);
        overlay.add(busy.clone(), MediaKind::Recording, cx);
        let id = overlay.entries[0].id;
        assert!(overlay.begin(id, ActionKind::Share, Stage::Uploading(0.), cx));
        overlay.set_hidden_for_capture(true, cx);
    });
    std::fs::remove_dir_all(&deleted).unwrap();
    std::fs::remove_dir_all(&busy).unwrap();
    overlay.update(cx, |overlay, cx| overlay.set_hidden_for_capture(false, cx));
    assert_eq!(paths(&overlay, cx), vec![busy, kept]);
}

#[gpui::test]
fn one_action_at_a_time_and_closing_cancels_it(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let path = bundle(&dir, "recording");
    let overlay = cx.new(|_| Overlay::default());
    let (id, cancel) = overlay.update(cx, |overlay, cx| {
        overlay.add(path.clone(), MediaKind::Recording, cx);
        let id = overlay.entries[0].id;
        assert!(overlay.begin(
            id,
            ActionKind::Share,
            Stage::Rendering {
                rendered: 0,
                total: 0
            },
            cx
        ));
        assert!(!overlay.begin(id, ActionKind::Copy, Stage::Copying, cx));
        (id, overlay.cancel_flag(id))
    });
    assert!(!cancel.load(Ordering::Acquire));
    overlay.update(cx, |overlay, cx| overlay.remove(id, cx));
    assert!(cancel.load(Ordering::Acquire));
    assert!(paths(&overlay, cx).is_empty());
}

#[gpui::test]
fn an_action_on_a_deleted_recording_closes_its_card(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let path = bundle(&dir, "recording");
    let overlay = cx.new(|_| Overlay::default());
    let id = overlay.update(cx, |overlay, cx| {
        overlay.add(path.clone(), MediaKind::Recording, cx);
        overlay.entries[0].id
    });
    std::fs::remove_dir_all(&path).unwrap();
    let started = overlay.update(cx, |overlay, cx| {
        overlay.begin(id, ActionKind::Copy, Stage::Copying, cx)
    });
    assert!(!started);
    assert!(paths(&overlay, cx).is_empty());
}

#[gpui::test]
fn finished_and_failed_actions_settle_back_to_the_actions(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let path = bundle(&dir, "recording");
    let overlay = cx.new(|_| Overlay::default());
    let id = overlay.update(cx, |overlay, cx| {
        overlay.add(path.clone(), MediaKind::Recording, cx);
        let id = overlay.entries[0].id;
        overlay.set_state(id, ActionState::Done(ActionKind::Copy), cx);
        id
    });
    let state = |cx: &mut TestAppContext| {
        overlay.read_with(cx, |overlay, _| overlay.entry(id).unwrap().state.clone())
    };
    cx.executor().advance_clock(DONE_VISIBLE / 2);
    assert_eq!(state(cx), ActionState::Done(ActionKind::Copy));
    cx.executor().advance_clock(DONE_VISIBLE);
    assert_eq!(state(cx), ActionState::Idle);

    overlay.update(cx, |overlay, cx| {
        overlay.set_state(
            id,
            ActionState::Failed(ActionKind::Share, "Upload failed".into()),
            cx,
        )
    });
    cx.executor().advance_clock(DONE_VISIBLE);
    assert!(matches!(state(cx), ActionState::Failed(..)));
    cx.executor().advance_clock(FAILURE_VISIBLE);
    assert_eq!(state(cx), ActionState::Idle);
}

#[gpui::test]
fn the_card_limit_keeps_a_busy_card_over_an_idle_newer_one(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let oldest = bundle(&dir, "oldest");
    let middle = bundle(&dir, "middle");
    let newest = bundle(&dir, "newest");
    let overlay = cx.new(|_| Overlay::default());
    overlay.update(cx, |overlay, cx| {
        overlay.add(oldest.clone(), MediaKind::Recording, cx);
        let id = overlay.entries[0].id;
        assert!(overlay.begin(id, ActionKind::Share, Stage::Uploading(0.5), cx));
        overlay.add(middle.clone(), MediaKind::Recording, cx);
        overlay.set_card_limit(2, cx);
        overlay.add(newest.clone(), MediaKind::Recording, cx);
    });
    assert_eq!(paths(&overlay, cx), vec![newest, oldest]);
}
