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
    /// The newest keyframe that was requested, forced or seen in the output.
    anchor: Option<i64>,
    /// A frame the encoder should make a keyframe by its own count, until its
    /// packet confirms or refutes it. Encoders may place keyframes on their
    /// own (scene cuts), so a prediction never counts once refuted.
    predicted: Option<i64>,
    frames_since_key: u32,
}

impl KeyframeCadence {
    pub(crate) fn new(interval: Duration, time_base: Rational, gop_size: i32) -> Self {
        let ticks = interval.as_secs_f64() * f64::from(time_base.denominator())
            / f64::from(time_base.numerator().max(1));
        Self {
            interval: (ticks.round() as i64).max(1),
            gop: u32::try_from(gop_size).ok().filter(|gop| *gop > 0),
            anchor: None,
            predicted: None,
            frames_since_key: 0,
        }
    }

    /// Decides whether the frame with `pts` must be sent as a keyframe:
    /// when the caller asked for one (`requested`), or when `interval` of
    /// capture time passed since the last keyframe.
    pub(crate) fn keyframe(&mut self, pts: i64, requested: bool) -> bool {
        let reference = match (self.anchor, self.predicted) {
            (None, None) => {
                self.anchor = Some(pts);
                self.frames_since_key = 1;
                return requested;
            }
            (anchor, predicted) => anchor.max(predicted).unwrap_or(pts),
        };
        let natural = self.gop.is_some_and(|gop| self.frames_since_key >= gop);
        let due = pts - reference >= self.interval;
        let keyframe = requested || due;
        if keyframe {
            self.anchor = Some(pts);
            self.predicted = None;
            self.frames_since_key = 0;
        } else if natural {
            self.predicted = Some(pts);
            self.frames_since_key = 0;
        }
        self.frames_since_key += 1;
        keyframe
    }

    /// Feeds back an encoded packet (pts in the same ticks as the frames).
    pub(crate) fn observe(&mut self, pts: i64, is_key: bool) {
        if is_key {
            self.anchor = Some(self.anchor.map_or(pts, |anchor| anchor.max(pts)));
        }
        if self.predicted.is_some_and(|predicted| pts >= predicted) {
            if is_key && self.predicted == Some(pts) {
                self.anchor = Some(self.anchor.map_or(pts, |anchor| anchor.max(pts)));
            }
            self.predicted = None;
        }
    }

    /// Sends `frame` as a keyframe when due (see [`Self::keyframe`]) and
    /// restores its picture type afterwards, so a pooled or reused frame
    /// never carries a forced type into the next send.
    pub(crate) fn send<T>(
        &mut self,
        frame: &mut frame::Video,
        requested: bool,
        send: impl FnOnce(&frame::Video) -> T,
    ) -> T {
        let Some(pts) = frame.pts() else {
            return send(frame);
        };
        if !self.keyframe(pts, requested) || frame.kind() == picture::Type::I {
            return send(frame);
        }
        let kind = frame.kind();
        frame.set_kind(picture::Type::I);
        let result = send(frame);
        frame.set_kind(kind);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cadence() -> KeyframeCadence {
        KeyframeCadence::new(Duration::from_secs(2), Rational(1, 30), 60)
    }

    /// Feeds frames and echoes each one back as a packet `lag` frames later,
    /// a keyframe when forced or when the encoder's own count says so.
    fn run(cadence: &mut KeyframeCadence, pts: &[i64], encoder_keys: &[i64]) -> Vec<i64> {
        let mut forced = Vec::new();
        for &p in pts {
            let key = cadence.keyframe(p, false);
            if key {
                forced.push(p);
            }
            cadence.observe(p, key || encoder_keys.contains(&p));
        }
        forced
    }

    #[test]
    fn frames_at_the_nominal_rate_are_keyframes_exactly_where_the_encoder_puts_them() {
        let pts: Vec<i64> = (0..600).collect();
        let keys: Vec<i64> = (0..600).step_by(60).collect();
        let forced = run(&mut cadence(), &pts, &keys);
        assert!(forced.iter().all(|p| keys.contains(p)), "{forced:?}");
    }

    #[test]
    fn slow_frames_get_a_keyframe_every_interval_of_capture_time() {
        let pts: Vec<i64> = (0..60).map(|k| k * 10).collect();
        assert_eq!(
            run(&mut cadence(), &pts, &[0]),
            vec![60, 120, 180, 240, 300, 360, 420, 480, 540]
        );
    }

    #[test]
    fn a_prediction_the_encoder_did_not_honour_does_not_reset_the_timer() {
        let mut cadence = KeyframeCadence::new(Duration::from_secs(2), Rational(1, 300), 60);
        let mut pts: Vec<i64> = (0..=60).map(|k| k * 9).collect();
        pts.extend((1..10).map(|k| 540 + k * 90));
        let forced = run(&mut cadence, &pts, &[0]);
        assert_eq!(forced.first(), Some(&630), "{forced:?}");
    }

    #[test]
    fn an_encoder_keyframe_seen_in_the_output_restarts_the_interval() {
        let pts: Vec<i64> = (0..60).map(|k| k * 10).collect();
        assert_eq!(run(&mut cadence(), &pts, &[0, 30])[0], 90);
    }

    #[test]
    fn requested_keyframes_are_kept_and_restart_the_interval() {
        let mut cadence = cadence();
        assert!(!cadence.keyframe(0, false));
        assert!(cadence.keyframe(6, true));
        assert!(!cadence.keyframe(60, false));
        assert!(cadence.keyframe(66, false));
    }

    #[test]
    fn a_forced_picture_type_does_not_outlive_its_send() {
        let mut cadence = cadence();
        let mut frame = frame::Video::new(ffmpeg::format::Pixel::YUV420P, 16, 16);
        frame.set_pts(Some(0));
        cadence.send(&mut frame, false, |_| ());
        frame.set_pts(Some(90));
        let sent = cadence.send(&mut frame, false, |frame| frame.kind());
        assert_eq!(sent, picture::Type::I);
        assert_eq!(frame.kind(), picture::Type::None);
    }
}
