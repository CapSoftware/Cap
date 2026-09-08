use cap_timestamp::{Timestamp, Timestamps};
use std::time::{Duration, Instant};

const MAX_CAPTURE_CLOCK_SKEW: Duration = Duration::from_secs(5);

pub(crate) struct CaptureClock {
    reference: Timestamps,
    anchor: Option<(f64, Instant)>,
}

impl CaptureClock {
    pub(crate) fn new(reference: Timestamps) -> Self {
        Self {
            reference,
            anchor: None,
        }
    }

    pub(crate) fn timestamp(
        &mut self,
        captured: Timestamp,
        observed: Instant,
        buffer_duration: Duration,
    ) -> Timestamp {
        let source_seconds = captured.signed_duration_since_secs(self.reference);
        let observed_seconds = observed
            .saturating_duration_since(self.reference.instant())
            .as_secs_f64();

        if let Some((source_anchor, mapped_anchor)) = self.anchor {
            if let Ok(elapsed) = Duration::try_from_secs_f64(source_seconds - source_anchor)
                && let Some(mapped) = mapped_anchor.checked_add(elapsed)
                && mapped
                    .saturating_duration_since(observed)
                    .max(observed.saturating_duration_since(mapped))
                    <= MAX_CAPTURE_CLOCK_SKEW
            {
                return Timestamp::Instant(mapped);
            }
        } else if (source_seconds - observed_seconds).abs() <= MAX_CAPTURE_CLOCK_SKEW.as_secs_f64()
        {
            return captured;
        } else {
            tracing::warn!(
                source_seconds,
                observed_seconds,
                "Device audio clock is outside the capture window; rebasing its timestamps"
            );
        }

        let mapped = observed.checked_sub(buffer_duration).unwrap_or(observed);
        self.anchor = Some((source_seconds, mapped));
        Timestamp::Instant(mapped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_before(reference: Timestamps, seconds: u64) -> Timestamp {
        Timestamp::SystemTime(
            reference
                .system_time()
                .checked_sub(Duration::from_secs(seconds))
                .unwrap(),
        )
    }

    fn elapsed(timestamp: Timestamp, reference: Timestamps) -> Duration {
        timestamp.checked_duration_since(reference).unwrap()
    }

    #[test]
    fn valid_capture_latency_is_preserved() {
        let reference = Timestamps::now();
        let mut clock = CaptureClock::new(reference);
        let captured = Timestamp::Instant(reference.instant() + Duration::from_millis(20));
        let result = clock.timestamp(
            captured,
            reference.instant() + Duration::from_millis(80),
            Duration::from_millis(10),
        );

        assert_eq!(elapsed(result, reference), Duration::from_millis(20));
        assert!(clock.anchor.is_none());
    }

    #[test]
    fn invalid_device_epoch_preserves_a_continuous_audio_timeline() {
        let reference = Timestamps::now();
        let mut clock = CaptureClock::new(reference);
        let source = source_before(reference, 2_223_687_539);

        for packet in 0..1_000 {
            let offset = Duration::from_millis(packet * 10);
            let result = clock.timestamp(
                source + offset,
                reference.instant() + Duration::from_millis(100) + offset,
                Duration::from_millis(10),
            );
            let expected = Duration::from_millis(90) + offset;
            let actual = elapsed(result, reference);
            assert!(actual.abs_diff(expected) < Duration::from_micros(2));
        }
        assert!(clock.anchor.is_some());
    }

    #[test]
    fn rebased_clock_preserves_delayed_packets_and_capture_gaps() {
        let reference = Timestamps::now();
        let mut clock = CaptureClock::new(reference);
        let source = source_before(reference, 60);
        let first = clock.timestamp(
            source,
            reference.instant() + Duration::from_millis(100),
            Duration::from_millis(10),
        );
        let delayed = clock.timestamp(
            source + Duration::from_millis(10),
            reference.instant() + Duration::from_millis(600),
            Duration::from_millis(10),
        );
        let resumed = clock.timestamp(
            source + Duration::from_secs(10),
            reference.instant() + Duration::from_millis(10_100),
            Duration::from_millis(10),
        );

        assert_eq!(elapsed(first, reference), Duration::from_millis(90));
        assert!(
            elapsed(delayed, reference).abs_diff(Duration::from_millis(100))
                < Duration::from_micros(1)
        );
        assert!(
            elapsed(resumed, reference).abs_diff(Duration::from_millis(10_090))
                < Duration::from_micros(1)
        );
    }

    #[test]
    fn a_clock_reset_reanchors_without_retaining_an_invalid_epoch() {
        let reference = Timestamps::now();
        let mut clock = CaptureClock::new(reference);
        let _ = clock.timestamp(
            source_before(reference, 60),
            reference.instant() + Duration::from_millis(100),
            Duration::from_millis(10),
        );
        let reset = clock.timestamp(
            source_before(reference, 120),
            reference.instant() + Duration::from_millis(200),
            Duration::from_millis(10),
        );

        assert_eq!(elapsed(reset, reference), Duration::from_millis(190));
    }

    #[test]
    fn future_device_epoch_is_rebased() {
        let reference = Timestamps::now();
        let mut clock = CaptureClock::new(reference);
        let result = clock.timestamp(
            Timestamp::SystemTime(reference.system_time() + Duration::from_secs(60)),
            reference.instant() + Duration::from_millis(100),
            Duration::from_millis(10),
        );

        assert_eq!(elapsed(result, reference), Duration::from_millis(90));
    }
}
