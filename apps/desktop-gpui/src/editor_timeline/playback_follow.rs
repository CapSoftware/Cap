use std::time::{Duration, Instant};

use super::Transform;

#[derive(Default)]
pub struct PlaybackFollow {
    previous: Option<Transform>,
    resume_at: Option<Instant>,
    follow_offset: Option<f64>,
}

impl PlaybackFollow {
    pub fn reset(&mut self) {
        self.previous = None;
        self.resume_at = None;
        self.follow_offset = None;
    }

    pub fn update(
        &mut self,
        transform: &mut Transform,
        playhead: f64,
        duration: f64,
        now: Instant,
        interacting: bool,
    ) {
        if interacting || self.previous.is_some_and(|previous| previous != *transform) {
            self.resume_at = Some(now + Duration::from_secs(1));
            self.follow_offset = None;
        }
        if self.resume_at.is_none_or(|resume_at| now >= resume_at)
            && transform.position.is_finite()
            && transform.zoom.is_finite()
            && playhead.is_finite()
            && duration.is_finite()
            && transform.zoom > 0.
            && duration > 0.
        {
            let follow_offset = *self.follow_offset.get_or_insert_with(|| {
                if playhead >= transform.position && playhead <= transform.position + transform.zoom
                {
                    (transform.zoom * 0.8).max(playhead - transform.position)
                } else {
                    transform.zoom * 0.8
                }
            });
            let position = if playhead < transform.position {
                playhead - transform.zoom * 0.2
            } else if playhead > transform.position + follow_offset {
                playhead - follow_offset
            } else {
                transform.position
            };
            transform.position = position.clamp(
                0.,
                (duration - transform.zoom).max(transform.position).max(0.),
            );
        }
        self.previous = Some(*transform);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_follow_starts_from_a_visible_playhead_without_jumping() {
        for start in [28.1, 29., 30.] {
            let mut follow = PlaybackFollow::default();
            let mut transform = Transform {
                position: 20.,
                zoom: 10.,
            };
            let now = Instant::now();
            for frame in 0..=120 {
                let elapsed = f64::from(frame) / 60.;
                follow.update(
                    &mut transform,
                    start + elapsed,
                    60.,
                    now + Duration::from_secs_f64(elapsed),
                    false,
                );
                assert!((transform.position - (20. + elapsed)).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn playback_follow_preserves_a_visible_playhead_after_pause_and_seek() {
        let mut follow = PlaybackFollow::default();
        let mut transform = Transform {
            position: 0.,
            zoom: 10.,
        };
        let now = Instant::now();
        follow.update(&mut transform, 8., 60., now, false);
        follow.reset();
        transform.position = 20.;
        follow.update(&mut transform, 29., 60., now, false);
        assert_eq!(transform.position, 20.);
        follow.update(&mut transform, 29.1, 60., now, false);
        assert!((transform.position - 20.1).abs() < 1e-9);
    }

    #[test]
    fn playback_follow_preserves_manual_trailing_space() {
        let mut follow = PlaybackFollow::default();
        let mut transform = Transform {
            position: 54.,
            zoom: 10.,
        };
        for playhead in [55., 58., 60.] {
            follow.update(&mut transform, playhead, 60., Instant::now(), false);
            assert_eq!(transform.position, 54.);
        }
    }

    #[test]
    fn playback_follow_resumes_after_panning_without_jumping() {
        let mut follow = PlaybackFollow::default();
        let mut transform = Transform {
            position: 0.,
            zoom: 10.,
        };
        let now = Instant::now();
        follow.update(&mut transform, 8., 60., now, false);
        transform.position = 1.;
        follow.update(&mut transform, 9., 60., now, false);
        assert_eq!(transform.position, 1.);
        follow.update(
            &mut transform,
            10.,
            60.,
            now + Duration::from_secs(1),
            false,
        );
        assert_eq!(transform.position, 1.);
        follow.update(
            &mut transform,
            10.1,
            60.,
            now + Duration::from_millis(1100),
            false,
        );
        assert!((transform.position - 1.1).abs() < 1e-9);
    }

    #[test]
    fn playback_follow_stays_still_then_tracks_at_playback_speed() {
        let mut follow = PlaybackFollow::default();
        let mut transform = Transform {
            position: 0.,
            zoom: 10.,
        };
        let start = Instant::now();
        for frame in 0..=1080 {
            let time = f64::from(frame) / 60.;
            follow.update(
                &mut transform,
                time,
                60.,
                start + Duration::from_secs_f64(time),
                false,
            );
            assert!((transform.position - (time - 8.).max(0.)).abs() < 1e-9);
        }
    }

    #[test]
    fn playback_follow_reveals_seeks_and_restarts() {
        let mut follow = PlaybackFollow::default();
        let mut transform = Transform {
            position: 0.,
            zoom: 10.,
        };
        let now = Instant::now();
        follow.update(&mut transform, 45., 60., now, false);
        assert_eq!(transform.position, 37.);
        follow.update(&mut transform, 20., 60., now, false);
        assert_eq!(transform.position, 18.);
        follow.reset();
        follow.update(&mut transform, 0., 60., now, false);
        assert_eq!(transform.position, 0.);
    }

    #[test]
    fn playback_follow_stays_within_the_project() {
        for (position, zoom, duration, expected) in
            [(49., 10., 60., 50.), (0., 60., 60., 0.), (0., 3., 2., 0.)]
        {
            let mut follow = PlaybackFollow::default();
            let mut transform = Transform { position, zoom };
            follow.update(&mut transform, duration, duration, Instant::now(), false);
            assert_eq!(transform.position, expected);
        }
    }

    #[test]
    fn playback_follow_gives_manual_pan_and_zoom_a_grace_period() {
        for manual in [
            Transform {
                position: 30.,
                zoom: 10.,
            },
            Transform {
                position: 0.,
                zoom: 5.,
            },
        ] {
            let mut follow = PlaybackFollow::default();
            let mut transform = Transform {
                position: 0.,
                zoom: 10.,
            };
            let now = Instant::now();
            follow.update(&mut transform, 8., 60., now, false);
            transform = manual;
            follow.update(&mut transform, 9., 60., now, false);
            assert_eq!(transform, manual);
            follow.update(
                &mut transform,
                10.,
                60.,
                now + Duration::from_millis(999),
                false,
            );
            assert_eq!(transform, manual);
            follow.update(
                &mut transform,
                10.,
                60.,
                now + Duration::from_secs(1),
                false,
            );
            assert_eq!(transform.position, if manual.zoom == 10. { 8. } else { 6. });
        }
    }

    #[test]
    fn playback_follow_waits_for_stationary_drags_to_finish() {
        let mut follow = PlaybackFollow::default();
        let mut transform = Transform {
            position: 0.,
            zoom: 10.,
        };
        let now = Instant::now();
        for seconds in 0..=3 {
            follow.update(
                &mut transform,
                20.,
                60.,
                now + Duration::from_secs(seconds),
                true,
            );
            assert_eq!(transform.position, 0.);
        }
        follow.update(
            &mut transform,
            20.,
            60.,
            now + Duration::from_millis(3999),
            false,
        );
        assert_eq!(transform.position, 0.);
        follow.update(
            &mut transform,
            20.,
            60.,
            now + Duration::from_secs(4),
            false,
        );
        assert_eq!(transform.position, 12.);
    }

    #[test]
    fn playback_follow_resets_manual_suspension_on_restart() {
        let mut follow = PlaybackFollow::default();
        let mut transform = Transform {
            position: 30.,
            zoom: 10.,
        };
        let now = Instant::now();
        follow.update(&mut transform, 0., 60., now, true);
        follow.reset();
        follow.update(&mut transform, 0., 60., now, false);
        assert_eq!(transform.position, 0.);
    }

    #[test]
    fn playback_follow_ignores_invalid_geometry() {
        for (zoom, playhead, duration) in [
            (0., 10., 60.),
            (10., 10., 0.),
            (10., f64::NAN, 60.),
            (f64::INFINITY, 10., 60.),
            (10., 10., f64::NAN),
        ] {
            let mut follow = PlaybackFollow::default();
            let mut transform = Transform { position: 5., zoom };
            follow.update(&mut transform, playhead, duration, Instant::now(), false);
            assert_eq!(transform.position, 5.);
        }
    }
}
