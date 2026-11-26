use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

/// How fast the editor preview plays, in quarter steps. Only the preview
/// clock and the preview audio honour it: export, the timeline and the
/// project file never see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PreviewSpeed(u8);

impl PreviewSpeed {
    pub const NORMAL: Self = Self(4);
    pub const ALL: [Self; 8] = [
        Self(2),
        Self(3),
        Self(4),
        Self(5),
        Self(6),
        Self(7),
        Self(8),
        Self(12),
    ];

    pub fn from_f64(value: f64) -> Option<Self> {
        if !value.is_finite() {
            return None;
        }
        Self::ALL
            .into_iter()
            .find(|speed| (speed.as_f64() - value).abs() < 1e-6)
    }

    fn from_quarters(quarters: u8) -> Option<Self> {
        Self::ALL.into_iter().find(|speed| speed.0 == quarters)
    }

    pub fn as_f64(self) -> f64 {
        f64::from(self.0) / 4.0
    }

    pub fn is_normal(self) -> bool {
        self == Self::NORMAL
    }

    pub fn faster(self) -> Option<Self> {
        Self::ALL.into_iter().find(|speed| *speed > self)
    }

    pub fn slower(self) -> Option<Self> {
        Self::ALL.into_iter().rev().find(|speed| *speed < self)
    }

    pub fn label(self) -> String {
        let value = self.as_f64();
        if value.fract() == 0.0 {
            format!("{value:.0}x")
        } else if (value * 2.0).fract() == 0.0 {
            format!("{value:.1}x")
        } else {
            format!("{value:.2}x")
        }
    }

    /// The timeline frame the playback clock shows after `frame`. Above 1x
    /// the clock keeps its display cadence and steps over frames instead of
    /// asking the decoder and renderer for more of them per second: it shows
    /// `floor(m * speed)` for every tick `m`, so 2x shows every other frame and
    /// 1.5x alternates steps of one and two.
    pub fn next_frame(self, frame: u32) -> u32 {
        let quarters = u64::from(self.0);
        if quarters <= 4 {
            return frame.saturating_add(1);
        }
        let tick = (4 * (u64::from(frame) + 1)).div_ceil(quarters);
        u32::try_from(tick * quarters / 4).unwrap_or(u32::MAX)
    }

    /// Wall-clock time from the clock's anchor until `frames` timeline
    /// frames later are due.
    pub fn wall_time(self, frame_duration: Duration, frames: u32) -> Duration {
        frame_duration.mul_f64(f64::from(frames) / self.as_f64())
    }

    /// Timeline frames the clock has advanced after `elapsed` wall time.
    pub fn frames_elapsed(self, elapsed: Duration, fps: f64) -> f64 {
        elapsed.as_secs_f64() * fps * self.as_f64()
    }
}

impl Default for PreviewSpeed {
    fn default() -> Self {
        Self::NORMAL
    }
}

/// The preview speed shared by the UI, the playback clock and the audio
/// callback. A store is one relaxed atomic write, so the audio thread can
/// read it every block without locking.
#[derive(Clone, Debug)]
pub struct PreviewSpeedHandle(Arc<AtomicU8>);

impl PreviewSpeedHandle {
    pub fn new(speed: PreviewSpeed) -> Self {
        Self(Arc::new(AtomicU8::new(speed.0)))
    }

    pub fn get(&self) -> PreviewSpeed {
        PreviewSpeed::from_quarters(self.0.load(Ordering::Relaxed)).unwrap_or_default()
    }

    pub fn set(&self, speed: PreviewSpeed) {
        self.0.store(speed.0, Ordering::Relaxed);
    }
}

impl Default for PreviewSpeedHandle {
    fn default() -> Self {
        Self::new(PreviewSpeed::NORMAL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_cover_the_offered_speeds_in_order() {
        let values: Vec<f64> = PreviewSpeed::ALL.iter().map(|s| s.as_f64()).collect();
        assert_eq!(values, [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0]);
        assert!(PreviewSpeed::default().is_normal());
    }

    #[test]
    fn faster_and_slower_walk_the_steps_and_stop_at_the_ends() {
        let mut speed = PreviewSpeed::ALL[0];
        let mut walked = vec![speed];
        while let Some(next) = speed.faster() {
            speed = next;
            walked.push(speed);
        }
        assert_eq!(walked, PreviewSpeed::ALL);
        assert_eq!(speed.faster(), None);
        let mut back = vec![speed];
        while let Some(next) = speed.slower() {
            speed = next;
            back.push(speed);
        }
        back.reverse();
        assert_eq!(back, PreviewSpeed::ALL);
        assert_eq!(PreviewSpeed::ALL[0].slower(), None);
    }

    #[test]
    fn parsing_accepts_only_offered_speeds() {
        assert_eq!(PreviewSpeed::from_f64(1.5).map(|s| s.as_f64()), Some(1.5));
        assert_eq!(PreviewSpeed::from_f64(3.0).map(|s| s.as_f64()), Some(3.0));
        assert_eq!(PreviewSpeed::from_f64(2.5), None);
        assert_eq!(PreviewSpeed::from_f64(0.0), None);
        assert_eq!(PreviewSpeed::from_f64(-1.0), None);
        assert_eq!(PreviewSpeed::from_f64(f64::NAN), None);
        assert_eq!(PreviewSpeed::from_f64(f64::INFINITY), None);
    }

    #[test]
    fn labels_are_short_and_plain() {
        let labels: Vec<String> = PreviewSpeed::ALL.iter().map(|s| s.label()).collect();
        assert_eq!(
            labels,
            ["0.5x", "0.75x", "1x", "1.25x", "1.5x", "1.75x", "2x", "3x"]
        );
    }

    #[test]
    fn at_or_below_normal_speed_every_frame_is_shown() {
        for speed in [
            PreviewSpeed::ALL[0],
            PreviewSpeed::ALL[1],
            PreviewSpeed::NORMAL,
        ] {
            for frame in [0, 1, 59, 60, 1_000_000] {
                assert_eq!(speed.next_frame(frame), frame + 1);
            }
        }
    }

    #[test]
    fn above_normal_speed_the_clock_steps_over_frames_on_a_fixed_grid() {
        let walk = |speed: PreviewSpeed, count: usize| {
            let mut frame = 0;
            let mut frames = vec![frame];
            for _ in 1..count {
                frame = speed.next_frame(frame);
                frames.push(frame);
            }
            frames
        };
        let speed = |value| PreviewSpeed::from_f64(value).unwrap();
        assert_eq!(walk(speed(2.0), 5), [0, 2, 4, 6, 8]);
        assert_eq!(walk(speed(3.0), 5), [0, 3, 6, 9, 12]);
        assert_eq!(walk(speed(1.5), 6), [0, 1, 3, 4, 6, 7]);
        assert_eq!(walk(speed(1.25), 6), [0, 1, 2, 3, 5, 6]);
        assert_eq!(walk(speed(1.75), 6), [0, 1, 3, 5, 7, 8]);
    }

    #[test]
    fn stepping_averages_exactly_the_requested_speed() {
        for speed in PreviewSpeed::ALL {
            if speed.as_f64() < 1.0 {
                continue;
            }
            let mut frame = 0u32;
            let mut ticks = 0u32;
            while frame < 60 * 600 {
                frame = speed.next_frame(frame);
                ticks += 1;
            }
            let measured = f64::from(frame) / f64::from(ticks);
            assert!(
                (measured - speed.as_f64()).abs() < 1e-3,
                "{speed:?} averaged {measured}"
            );
        }
    }

    #[test]
    fn an_off_grid_frame_rejoins_the_grid_without_going_backwards() {
        let speed = PreviewSpeed::from_f64(2.0).unwrap();
        assert_eq!(speed.next_frame(3), 4);
        assert_eq!(speed.next_frame(4), 6);
        let speed = PreviewSpeed::from_f64(3.0).unwrap();
        assert_eq!(speed.next_frame(1), 3);
        assert_eq!(speed.next_frame(2), 3);
        for speed in PreviewSpeed::ALL {
            for frame in 0..200 {
                assert!(speed.next_frame(frame) > frame);
            }
        }
    }

    #[test]
    fn stepping_saturates_at_the_end_of_the_frame_range() {
        for speed in PreviewSpeed::ALL {
            assert_eq!(speed.next_frame(u32::MAX), u32::MAX);
            assert!(speed.next_frame(u32::MAX - 1) >= u32::MAX - 1);
        }
    }

    #[test]
    fn deadlines_shrink_with_speed_and_match_one_x_exactly() {
        let frame = Duration::from_secs_f64(1.0 / 60.0);
        assert_eq!(PreviewSpeed::NORMAL.wall_time(frame, 7), frame.mul_f64(7.0));
        let two = PreviewSpeed::from_f64(2.0).unwrap();
        assert!((two.wall_time(frame, 120).as_secs_f64() - 1.0).abs() < 1e-6);
        let half = PreviewSpeed::ALL[0];
        assert!((half.wall_time(frame, 30).as_secs_f64() - 1.0).abs() < 1e-6);
        assert!((two.frames_elapsed(Duration::from_secs(1), 60.0) - 120.0).abs() < 1e-9);
    }

    #[test]
    fn the_shared_handle_round_trips_every_speed() {
        let handle = PreviewSpeedHandle::default();
        assert!(handle.get().is_normal());
        let clone = handle.clone();
        for speed in PreviewSpeed::ALL {
            handle.set(speed);
            assert_eq!(clone.get(), speed);
        }
    }
}
