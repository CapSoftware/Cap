//! Keyframes on a capture-time cadence for recording encoders.
//!
//! Every recording encoder is configured with a keyframe interval in frames
//! (`g` = 2 s at the nominal rate), and the fragmented writers can only cut a
//! segment at a keyframe. Screen capture delivers frames only when the screen
//! changes, and loaded machines deliver fewer than nominal, so a 120-frame GOP
//! can span far more than 2 s: a crash then loses the whole open fragment.
//! This forces a keyframe once `interval` of capture time has passed since the
//! last one, and otherwise leaves the encoder's own cadence untouched (frames
//! at the nominal rate keep exactly the keyframes they had).

use std::time::Duration;

use ffmpeg::{Rational, frame, picture};

pub(crate) struct KeyframeCadence {
    /// The interval in pts ticks.
    interval: i64,
    /// The encoder's own keyframe interval in frames (`gop_size`), if any.
    gop: Option<u32>,
    last_key: Option<i64>,
    frames_since_key: u32,
}

impl KeyframeCadence {
    pub(crate) fn new(interval: Duration, time_base: Rational, gop_size: i32) -> Self {
        let ticks = interval.as_secs_f64() * f64::from(time_base.denominator())
            / f64::from(time_base.numerator().max(1));
        Self {
            interval: (ticks.round() as i64).max(1),
            gop: u32::try_from(gop_size).ok().filter(|gop| *gop > 0),
            last_key: None,
            frames_since_key: 0,
        }
    }

    /// Marks `frame` (whose pts is already set) as a forced keyframe when it
    /// is due, and clears any picture type it carried otherwise. Returns
    /// whether it was forced.
    pub(crate) fn apply(&mut self, frame: &mut frame::Video) -> bool {
        let Some(pts) = frame.pts() else {
            return false;
        };
        let natural = match self.last_key {
            None => true,
            Some(_) => self.gop.is_some_and(|gop| self.frames_since_key >= gop),
        };
        let force = !natural && self.last_key.is_some_and(|key| pts - key >= self.interval);
        frame.set_kind(if force {
            picture::Type::I
        } else {
            picture::Type::None
        });
        if natural || force {
            self.last_key = Some(pts);
            self.frames_since_key = 0;
        }
        self.frames_since_key += 1;
        force
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(pts: i64) -> frame::Video {
        let mut frame = frame::Video::new(ffmpeg::format::Pixel::YUV420P, 16, 16);
        frame.set_pts(Some(pts));
        frame
    }

    fn forced(cadence: &mut KeyframeCadence, pts: &[i64]) -> Vec<i64> {
        pts.iter()
            .copied()
            .filter(|&pts| {
                let mut frame = frame(pts);
                let forced = cadence.apply(&mut frame);
                assert_eq!(
                    frame.kind() == picture::Type::I,
                    forced,
                    "picture type must match the decision"
                );
                forced
            })
            .collect()
    }

    #[test]
    fn frames_at_the_nominal_rate_keep_the_encoders_own_keyframes() {
        let mut cadence = KeyframeCadence::new(Duration::from_secs(2), Rational(1, 30), 60);
        let pts: Vec<i64> = (0..600).collect();
        assert!(forced(&mut cadence, &pts).is_empty());
    }

    #[test]
    fn slow_frames_get_a_keyframe_every_interval_of_capture_time() {
        let mut cadence = KeyframeCadence::new(Duration::from_secs(2), Rational(1, 30), 60);
        let pts: Vec<i64> = (0..60).map(|k| k * 10).collect();
        assert_eq!(
            forced(&mut cadence, &pts),
            vec![60, 120, 180, 240, 300, 360, 420, 480, 540]
        );
    }

    #[test]
    fn a_forced_keyframe_restarts_the_frame_count() {
        let mut cadence = KeyframeCadence::new(Duration::from_secs(2), Rational(1, 30), 60);
        let mut pts: Vec<i64> = vec![0, 70];
        pts.extend(71..200);
        assert_eq!(forced(&mut cadence, &pts), vec![70]);
    }

    #[test]
    fn a_pooled_frame_does_not_keep_a_forced_picture_type() {
        let mut cadence = KeyframeCadence::new(Duration::from_secs(2), Rational(1, 30), 60);
        let mut frame = frame(0);
        cadence.apply(&mut frame);
        frame.set_pts(Some(90));
        assert!(cadence.apply(&mut frame));
        frame.set_pts(Some(91));
        assert!(!cadence.apply(&mut frame));
        assert_eq!(frame.kind(), picture::Type::None);
    }
}
