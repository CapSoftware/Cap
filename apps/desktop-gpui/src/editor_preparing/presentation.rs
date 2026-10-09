use cap_editor::{PreparingEditorPhase, PreparingEditorProgress, PreparingPlaybackState};
use cap_project::ProjectConfiguration;

#[derive(Clone)]
pub(crate) struct PreparingTimelineSeed {
    pub(crate) project: ProjectConfiguration,
    pub(crate) pretty_name: String,
    pub(crate) has_camera: bool,
    pub(crate) multiple_clips: bool,
}

#[derive(Default)]
pub(crate) struct PreparingPresentation {
    pub(crate) progress: PreparingEditorProgress,
    pub(crate) playback: PreparingPlaybackState,
    sequence: u64,
}

impl PreparingPresentation {
    pub(crate) fn apply(
        &mut self,
        sequence: u64,
        progress: PreparingEditorProgress,
        playback: PreparingPlaybackState,
    ) -> bool {
        if sequence <= self.sequence
            || !progress.playable_until.is_finite()
            || progress.playable_until < 0.0
            || progress.total_duration.is_some_and(|total| {
                !total.is_finite() || total <= 0.0 || progress.playable_until > total
            })
            || (progress.total_duration.is_none() && progress.playable_until != 0.0)
            || !playback.playhead_seconds.is_finite()
            || playback.playhead_seconds < 0.0
            || progress
                .total_duration
                .is_some_and(|total| playback.playhead_seconds > total)
            || (progress.phase == PreparingEditorPhase::Unavailable
                && progress.playable_until != 0.0)
            || (playback.playing
                && (!progress.preview_available
                    || progress.phase == PreparingEditorPhase::Unavailable
                    || playback.playhead_seconds > progress.playable_until
                    || (playback.playhead_seconds == progress.playable_until
                        && !playback.buffering)))
        {
            return false;
        }
        self.sequence = sequence;
        self.progress = progress;
        self.playback = playback;
        true
    }

    pub(crate) fn controls_ready(&self) -> bool {
        self.progress.phase == PreparingEditorPhase::Preparing
            && self.progress.preview_available
            && self.progress.playable_until > 0.0
    }

    pub(crate) fn last_playable_frame_time(&self, fps: u32) -> Option<f64> {
        (self.controls_ready() && fps > 0).then(|| {
            let frame =
                ((self.progress.playable_until * f64::from(fps)).ceil() as u64).saturating_sub(1);
            frame as f64 / f64::from(fps)
        })
    }

    pub(crate) fn seek_target(&self, seconds: f64, fps: u32) -> Option<f64> {
        if !self.controls_ready()
            || !seconds.is_finite()
            || seconds < 0.0
            || seconds > self.progress.playable_until
        {
            return None;
        }
        self.last_playable_frame_time(fps)
            .map(|last| seconds.min(last))
    }

    pub(crate) fn handoff(&mut self) {
        self.progress.phase = PreparingEditorPhase::Handoff;
        self.playback.buffering = false;
    }

    pub(crate) fn toggle_handoff_playback(&mut self, at_end: bool) -> Option<f64> {
        if at_end {
            self.playback.playing = true;
            self.playback.playhead_seconds = 0.0;
            Some(0.0)
        } else {
            self.playback.playing = !self.playback.playing;
            None
        }
    }

    pub(crate) fn handoff_frame(&self, total: f64, fps: u32) -> u32 {
        let target = (self.playback.playhead_seconds * f64::from(fps)).round() as u32;
        if total.is_finite() && total > 0.0 {
            target.min(((total * f64::from(fps)).ceil() as u32).saturating_sub(1))
        } else {
            target
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress() -> PreparingEditorProgress {
        PreparingEditorProgress {
            total_duration: Some(60.0),
            playable_until: 20.0,
            preview_available: true,
            ..Default::default()
        }
    }

    #[test]
    fn preview_alone_has_no_playable_prefix() {
        let state = PreparingPresentation::default();
        assert_eq!(state.progress.playable_until, 0.0);
        assert!(!state.playback.playing);
        assert_eq!(state.progress.total_duration, None);
    }

    #[test]
    fn invalid_or_stale_readiness_preserves_last_confirmed_state() {
        let mut state = PreparingPresentation::default();
        assert!(state.apply(2, progress(), PreparingPlaybackState::default()));
        assert!(!state.apply(1, PreparingEditorProgress::default(), Default::default()));
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 61.0] {
            let mut next = progress();
            next.playable_until = invalid;
            assert!(!state.apply(3, next, Default::default()));
        }
        assert_eq!(state.progress, progress());
    }

    #[test]
    fn unknown_duration_never_admits_a_playable_prefix() {
        let mut state = PreparingPresentation::default();
        let next = PreparingEditorProgress {
            playable_until: 1.0,
            ..Default::default()
        };
        assert!(!state.apply(1, next, Default::default()));
    }

    #[test]
    fn playing_requires_a_real_preview_and_confirmed_prefix() {
        let mut state = PreparingPresentation::default();
        let playback = PreparingPlaybackState {
            playhead_seconds: 20.0,
            playing: true,
            buffering: false,
        };
        assert!(!state.apply(1, progress(), playback));
        let mut next = progress();
        next.preview_available = false;
        assert!(!state.apply(
            1,
            next,
            PreparingPlaybackState {
                playhead_seconds: 10.0,
                ..playback
            }
        ));
        assert!(state.apply(
            1,
            progress(),
            PreparingPlaybackState {
                playhead_seconds: 10.0,
                ..playback
            }
        ));
    }

    #[test]
    fn seeking_never_crosses_the_confirmed_frontier_or_exact_end_frame() {
        let mut state = PreparingPresentation::default();
        assert_eq!(state.seek_target(0.0, 30), None);
        assert!(state.apply(1, progress(), Default::default()));
        assert_eq!(state.seek_target(12.25, 30), Some(12.25));
        assert_eq!(state.seek_target(20.0, 30), Some(599.0 / 30.0));
        for invalid in [20.001, -0.1, f64::NAN, f64::INFINITY] {
            assert_eq!(state.seek_target(invalid, 30), None);
        }
        assert_eq!(state.seek_target(0.0, 0), None);
        state.handoff();
        assert!(!state.controls_ready());
        assert_eq!(state.seek_target(0.0, 30), None);
    }

    #[test]
    fn terminal_failure_disables_controls_and_preserves_a_retained_image_position() {
        let mut state = PreparingPresentation::default();
        assert!(state.apply(
            1,
            progress(),
            PreparingPlaybackState {
                playhead_seconds: 12.25,
                ..Default::default()
            }
        ));
        assert!(state.controls_ready());
        let failed = PreparingEditorProgress {
            phase: PreparingEditorPhase::Unavailable,
            playable_until: 0.0,
            ..progress()
        };
        assert!(state.apply(2, failed, state.playback));
        assert!(!state.controls_ready());
        assert_eq!(state.playback.playhead_seconds, 12.25);
        assert!(!state.apply(1, progress(), Default::default()));
    }

    #[test]
    fn natural_end_retains_exact_playhead_with_a_valid_last_image() {
        let mut state = PreparingPresentation::default();
        let ready = PreparingEditorProgress {
            total_duration: Some(10.0),
            playable_until: 10.0,
            ..progress()
        };
        assert!(state.apply(
            1,
            ready,
            PreparingPlaybackState {
                playhead_seconds: 10.0,
                ..Default::default()
            }
        ));
        state.handoff();
        assert_eq!(state.handoff_frame(10.0, 30), 299);
        assert_eq!(state.playback.playhead_seconds, 10.0);
        assert!(!state.playback.playing);
    }

    #[test]
    fn newer_handoff_play_intent_restarts_at_end_and_can_be_paused_again() {
        let mut state = PreparingPresentation::default();
        state.playback.playhead_seconds = 10.0;
        state.handoff();
        assert_eq!(state.toggle_handoff_playback(true), Some(0.0));
        assert_eq!(state.handoff_frame(10.0, 30), 0);
        assert!(state.playback.playing);
        assert_eq!(state.toggle_handoff_playback(false), None);
        assert!(!state.playback.playing);
        assert_eq!(state.playback.playhead_seconds, 0.0);
    }

    #[test]
    fn handoff_retains_position_and_playing_intent() {
        let mut state = PreparingPresentation::default();
        assert!(state.apply(
            1,
            progress(),
            PreparingPlaybackState {
                playhead_seconds: 12.25,
                playing: true,
                buffering: false,
            }
        ));
        state.handoff();
        assert_eq!(state.progress.phase, PreparingEditorPhase::Handoff);
        assert_eq!(state.handoff_frame(60.0, 30), 368);
        assert_eq!(state.handoff_frame(10.0, 30), 299);
        assert_eq!(state.playback.playhead_seconds, 12.25);
        assert_eq!(state.handoff_frame(0.01, 30), 0);
        assert_eq!(state.handoff_frame(10.01, 30), 300);
        assert!(state.playback.playing);
    }
}
