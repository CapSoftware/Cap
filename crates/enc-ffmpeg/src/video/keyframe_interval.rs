use std::time::Duration;

#[derive(Clone, Copy)]
pub(super) struct KeyframeInterval {
    interval: Duration,
    last_keyframe: Option<Duration>,
}

impl KeyframeInterval {
    pub(super) fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_keyframe: None,
        }
    }

    pub(super) fn apply(&mut self, frame: &mut ffmpeg::frame::Video, timestamp: Duration) {
        if timestamp == Duration::MAX {
            return;
        }
        let force = frame.kind() == ffmpeg::picture::Type::I
            || self.last_keyframe.is_none_or(|previous| {
                timestamp
                    .checked_sub(previous)
                    .is_none_or(|elapsed| elapsed >= self.interval)
            });
        if force {
            frame.set_kind(ffmpeg::picture::Type::I);
            self.last_keyframe = Some(timestamp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_frames_cut_by_capture_time() {
        let mut cadence = KeyframeInterval::new(Duration::from_secs(2));
        let mut frame = ffmpeg::frame::Video::empty();
        for (millis, expected) in [
            (7_000, ffmpeg::picture::Type::I),
            (7_333, ffmpeg::picture::Type::None),
            (8_999, ffmpeg::picture::Type::None),
            (9_000, ffmpeg::picture::Type::I),
            (9_333, ffmpeg::picture::Type::None),
            (14_000, ffmpeg::picture::Type::I),
            (14_333, ffmpeg::picture::Type::None),
        ] {
            frame.set_kind(ffmpeg::picture::Type::None);
            cadence.apply(&mut frame, Duration::from_millis(millis));
            assert_eq!(frame.kind(), expected);
        }
    }

    #[test]
    fn unavailable_timestamps_preserve_caller_frame_types_and_do_not_poison_cadence() {
        let mut cadence = KeyframeInterval::new(Duration::from_secs(2));
        let mut frame = ffmpeg::frame::Video::empty();
        frame.set_kind(ffmpeg::picture::Type::P);
        cadence.apply(&mut frame, Duration::MAX);
        assert_eq!(frame.kind(), ffmpeg::picture::Type::P);
        cadence.apply(&mut frame, Duration::ZERO);
        assert_eq!(frame.kind(), ffmpeg::picture::Type::I);
        frame.set_kind(ffmpeg::picture::Type::None);
        cadence.apply(&mut frame, Duration::from_secs(2));
        assert_eq!(frame.kind(), ffmpeg::picture::Type::I);
        frame.set_kind(ffmpeg::picture::Type::None);
        cadence.apply(&mut frame, Duration::from_secs(1));
        assert_eq!(frame.kind(), ffmpeg::picture::Type::I);
    }
}
