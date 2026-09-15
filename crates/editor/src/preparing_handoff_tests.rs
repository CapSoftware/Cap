use super::*;
use crate::{PreparingEditorPhase, PreparingEditorProgress, PreparingPlaybackState};

fn snapshot(position: f64, playing: bool) -> PreparingPlaybackSnapshot {
    PreparingPlaybackSnapshot {
        sequence: 1,
        progress: PreparingEditorProgress {
            total_duration: Some(10.0),
            playable_until: 10.0,
            preview_available: true,
            phase: PreparingEditorPhase::Preparing,
        },
        playback: PreparingPlaybackState {
            playhead_seconds: position,
            playing,
            buffering: false,
        },
    }
}

fn completed() -> CompletedAudioHandoff {
    let meta = crate::completed_audio::tests::metadata();
    let count = match meta.studio_meta().unwrap() {
        cap_project::StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        _ => panic!("Expected test segments"),
    };
    CompletedAudioHandoff::from_completed_tracks(&meta, &meta, vec![Default::default(); count])
        .unwrap()
}

fn handoff() -> (
    PreparingPlaybackHandoff,
    tokio_util::sync::CancellationToken,
) {
    let snapshot = snapshot(3.0, false);
    let state = HandoffState::new();
    state.publish(snapshot.clone(), 3.0);
    state.complete(completed());
    let (stop, cancelled) = PreparingPlaybackStopHandle::test_pending(snapshot);
    (PreparingPlaybackHandoff::new(state, stop), cancelled)
}

#[tokio::test]
async fn completed_cache_is_taken_once_without_stopping_owner() {
    let (handoff, cancelled) = handoff();
    assert!(handoff.take_completed_audio().await.is_ok());
    assert!(handoff.take_completed_audio().await.is_err());
    assert!(!cancelled.is_cancelled());
    drop(handoff);
    assert!(cancelled.is_cancelled());
}

#[test]
fn discarded_candidate_does_not_cancel_preparing_playback() {
    let (handoff, cancelled) = handoff();
    let candidate = handoff.prepare_adoption().unwrap();
    candidate.cancel();
    drop(candidate);
    assert!(!cancelled.is_cancelled());
    assert!(!handoff.committed());
}

#[test]
fn newer_candidate_rejects_old_commit_and_old_cleanup() {
    let (handoff, cancelled) = handoff();
    let old = handoff.prepare_adoption().unwrap();
    let current = handoff.prepare_adoption().unwrap();
    assert!(!old.try_commit(90, 30));
    assert!(current.try_commit(90, 30));
    old.cancel();
    assert!(!cancelled.is_cancelled());
    current.cancel();
    assert!(cancelled.is_cancelled());
}

#[test]
fn command_must_settle_before_current_frame_can_commit() {
    let (handoff, _) = handoff();
    let candidate = handoff.prepare_adoption().unwrap();
    let command = handoff.0.state.begin_command().unwrap();
    assert!(!candidate.try_commit(90, 30));
    handoff.0.state.publish(snapshot(5.0, false), 5.0);
    drop(command);
    assert!(!candidate.try_commit(90, 30));
    assert!(!candidate.try_commit(150, 30));
    let renewed = handoff.prepare_adoption().unwrap();
    assert!(renewed.try_commit(150, 30));
    assert!(handoff.0.state.begin_command().is_err());
}

#[test]
fn moving_clock_rejects_old_or_future_frames() {
    let (handoff, _) = handoff();
    let candidate = handoff.prepare_adoption().unwrap();
    handoff.0.state.publish(snapshot(5.0, true), 5.0);
    assert!(!candidate.try_commit(90, 30));
    assert!(!candidate.try_commit(180, 30));
    assert!(!candidate.try_commit(150, 0));
    assert!(candidate.try_commit(150, 30));
}

#[tokio::test]
async fn terminal_failure_wakes_audio_waiter_and_rejects_adoption() {
    let state = HandoffState::new();
    let (stop, _) = PreparingPlaybackStopHandle::test_pending(snapshot(0.0, false));
    let handoff = PreparingPlaybackHandoff::new(state.clone(), stop);
    state.finish(Some("decode failed".into()));
    assert_eq!(
        handoff.take_completed_audio().await.err().as_deref(),
        Some("decode failed")
    );
    assert!(handoff.prepare_adoption().is_err());
}

#[tokio::test]
async fn adopted_stop_awaits_actual_retained_completion() {
    let (handoff, cancelled) = handoff();
    let candidate = handoff.prepare_adoption().unwrap();
    assert!(candidate.try_commit(90, 30));
    assert!(!cancelled.is_cancelled());
    let exit = candidate.stop_and_wait().await.unwrap();
    assert!(cancelled.is_cancelled());
    assert!(!exit.cleanup_failed);
}

#[test]
fn completed_same_frame_pause_or_seek_invalidates_pending_presentation() {
    let (handoff, cancelled) = handoff();
    for _ in 0..2 {
        let candidate = handoff.prepare_adoption().unwrap();
        let command = handoff.0.state.begin_command().unwrap();
        handoff.0.state.publish(snapshot(3.0, false), 3.0);
        drop(command);
        assert!(candidate.invalidated());
        assert!(!candidate.try_commit(90, 30));
        assert!(!cancelled.is_cancelled());
    }
}

#[test]
fn cancellation_invalidates_a_previously_ready_candidate() {
    let (handoff, _) = handoff();
    let candidate = handoff.prepare_adoption().unwrap();
    handoff.cancel();
    assert!(!candidate.try_commit(90, 30));
}

#[test]
fn end_position_targets_last_video_frame() {
    assert_eq!(presentation_frame(&snapshot(10.0, false), 30), 299);
}

#[tokio::test]
async fn queued_intent_blocks_recreation_until_actual_command_owner_drops() {
    let (handoff, _) = handoff();
    let candidate = handoff.prepare_adoption().unwrap();
    let intent = handoff.reserve_command().unwrap();
    let retry = tokio::spawn(async move { candidate.retry().await });
    tokio::task::yield_now().await;
    assert!(!retry.is_finished());
    drop(intent);
    let renewed = retry.await.unwrap().unwrap();
    assert!(renewed.try_commit(90, 30));
}

#[test]
fn only_the_matching_completed_pcm_and_output_can_be_adopted() {
    let (handoff, _) = handoff();
    let output = Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {})));
    let other_output = Arc::new(crate::AudioOutput::new_headless(Box::new(|_, _| {})));
    let tracks = vec![crate::completed_audio::CompletedAudioSegment {
        mic: Some(crate::completed_audio::tests::audio()),
        system_audio: None,
    }];
    handoff.0.state.set_completed_identity(&tracks, &output);
    let identity = completed_track_identity(&tracks);
    assert!(handoff.matches_completed_audio(&identity, &output));
    assert!(!handoff.matches_completed_audio(&identity, &other_output));
    let different_pcm = vec![crate::completed_audio::CompletedAudioSegment {
        mic: Some(crate::completed_audio::tests::audio()),
        system_audio: None,
    }];
    assert!(!handoff.matches_completed_audio(&completed_track_identity(&different_pcm), &output));
    assert!(!handoff.matches_completed_audio(&Vec::new(), &output));
}

#[test]
fn direct_stop_rejects_commit_before_runner_cleanup_finishes() {
    let (handoff, cancelled) = handoff();
    let candidate = handoff.prepare_adoption().unwrap();
    handoff.0.stop.cancel();
    assert!(cancelled.is_cancelled());
    assert!(candidate.invalidated());
    assert!(!candidate.try_commit(90, 30));
    assert!(handoff.prepare_adoption().is_err());
    assert!(handoff.reserve_command().is_err());
}

#[tokio::test]
async fn direct_stop_wakes_a_pending_audio_handoff_without_waiting_for_cleanup() {
    let state = HandoffState::new();
    let (stop, _) = PreparingPlaybackStopHandle::test_pending(snapshot(0.0, false));
    let handoff = PreparingPlaybackHandoff::new(state, stop);
    let waiter = tokio::spawn({
        let handoff = handoff.clone();
        async move { handoff.take_completed_audio().await }
    });
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());
    handoff.0.stop.cancel();
    assert_eq!(
        waiter.await.unwrap().err().as_deref(),
        Some("Preparing playback has ended")
    );
}

#[tokio::test]
async fn retained_task_join_error_wakes_audio_and_adoption_waiters() {
    let state = HandoffState::new();
    let initial = snapshot(0.0, false);
    let (stop, _) = PreparingPlaybackStopHandle::test_pending(initial.clone());
    let handoff = PreparingPlaybackHandoff::new(state.clone(), stop);
    let intent = handoff.reserve_command().unwrap();
    let audio = tokio::spawn({
        let handoff = handoff.clone();
        async move { handoff.take_completed_audio().await }
    });
    let adoption = tokio::spawn({
        let handoff = handoff.clone();
        async move { handoff.prepare_when_settled().await }
    });
    let committed = tokio::spawn({
        let handoff = handoff.clone();
        async move { handoff.wait_committed().await }
    });
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        released.await.unwrap();
        panic!("injected cleanup panic")
    });
    let retained = tokio::spawn(crate::preparing_playback::join_preparing_task(
        task, initial, state,
    ));
    tokio::task::yield_now().await;
    assert!(!audio.is_finished());
    assert!(!adoption.is_finished());
    release.send(()).unwrap();
    let exit = retained.await.unwrap();
    assert!(exit.cleanup_failed);
    assert!(
        audio
            .await
            .unwrap()
            .err()
            .unwrap()
            .contains("injected cleanup panic")
    );
    assert!(adoption.await.unwrap().is_err());
    assert!(!committed.await.unwrap());
    drop(intent);
}
