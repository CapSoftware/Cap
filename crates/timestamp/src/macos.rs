use cidre::mach::TimeBaseInfo;
use std::{
    ops::{Add, Sub},
    sync::OnceLock,
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MachAbsoluteTimestamp(
    // Raw mach_absolute_time ticks
    u64,
);

static TIMEBASE_RATIO: OnceLock<(u128, u128)> = OnceLock::new();

#[inline]
fn timebase_ratio() -> (u128, u128) {
    *TIMEBASE_RATIO.get_or_init(|| {
        let info = TimeBaseInfo::new();
        (u128::from(info.numer.max(1)), u128::from(info.denom.max(1)))
    })
}

#[inline]
fn ticks_to_nanos_with_ratio(ticks: u64, numer: u128, denom: u128) -> u64 {
    let scaled = u128::from(ticks) * numer + (denom / 2);
    (scaled / denom) as u64
}

#[inline]
fn nanos_to_ticks_with_ratio(nanos: u128, numer: u128, denom: u128) -> u64 {
    let scaled = nanos * denom + (numer / 2);
    (scaled / numer) as u64
}

impl MachAbsoluteTimestamp {
    pub fn new(ticks: u64) -> Self {
        Self(ticks)
    }

    pub fn now() -> Self {
        Self(cidre::mach::abs_time())
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        self.checked_duration_since(other).unwrap_or(Duration::ZERO)
    }

    pub fn checked_duration_since(&self, other: Self) -> Option<Duration> {
        let diff = self.0.checked_sub(other.0)?;
        let (numer, denom) = timebase_ratio();
        Some(Duration::from_nanos(ticks_to_nanos_with_ratio(
            diff, numer, denom,
        )))
    }

    pub fn signed_duration_since_secs(&self, other: Self) -> f64 {
        let (numer, denom) = timebase_ratio();
        if self.0 >= other.0 {
            let nanos = ticks_to_nanos_with_ratio(self.0 - other.0, numer, denom);
            nanos as f64 / 1_000_000_000.0
        } else {
            let nanos = ticks_to_nanos_with_ratio(other.0 - self.0, numer, denom);
            -(nanos as f64 / 1_000_000_000.0)
        }
    }

    pub fn from_cpal(instant: cpal::StreamInstant) -> Self {
        use cpal::host::coreaudio::StreamInstantExt;

        Self(instant.as_host_time())
    }
}

impl Add<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self::Output {
        let (numer, denom) = timebase_ratio();
        let delta_ticks = nanos_to_ticks_with_ratio(rhs.as_nanos(), numer, denom);
        Self(self.0.saturating_add(delta_ticks))
    }
}

impl Sub<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let (numer, denom) = timebase_ratio();
        let delta_ticks = nanos_to_ticks_with_ratio(rhs.as_nanos(), numer, denom);
        Self(self.0.saturating_sub(delta_ticks))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_duration_roundtrips_through_duration_since() {
        let base = MachAbsoluteTimestamp::now();
        let added = base + Duration::from_millis(35);

        let roundtrip = added.duration_since(base);
        let error_us = (roundtrip.as_micros() as i128 - 35_000).abs();
        assert!(
            error_us < 10,
            "35ms add must survive the tick conversion roundtrip, got {roundtrip:?}"
        );
    }

    #[test]
    fn sub_duration_roundtrips_through_duration_since() {
        let base = MachAbsoluteTimestamp::now();
        let subtracted = base - Duration::from_millis(120);

        let roundtrip = base.duration_since(subtracted);
        let error_us = (roundtrip.as_micros() as i128 - 120_000).abs();
        assert!(
            error_us < 10,
            "120ms sub must survive the tick conversion roundtrip, got {roundtrip:?}"
        );
    }

    #[test]
    fn add_then_sub_is_identity() {
        let base = MachAbsoluteTimestamp::now();
        let d = Duration::from_millis(500);
        let roundtrip = (base + d) - d;

        let drift = roundtrip
            .duration_since(base)
            .max(base.duration_since(roundtrip));
        assert!(
            drift < Duration::from_micros(10),
            "add/sub of the same duration must cancel out, drifted {drift:?}"
        );
    }

    #[test]
    fn apple_silicon_timebase_preserves_precision_over_long_recordings() {
        let numer = 125u128;
        let denom = 3u128;
        let target_ns: u128 = 3_600_000_123_456;
        let step_ticks = nanos_to_ticks_with_ratio(target_ns, numer, denom);
        let high_uptime = MachAbsoluteTimestamp::new((1u64 << 53) + 1);
        assert_eq!(high_uptime + Duration::ZERO, high_uptime);
        assert_eq!(high_uptime - Duration::ZERO, high_uptime);

        let later = MachAbsoluteTimestamp::new(high_uptime.0 + step_ticks);
        let elapsed_ns = ticks_to_nanos_with_ratio(later.0 - high_uptime.0, numer, denom);
        assert!((elapsed_ns as i128 - target_ns as i128).abs() <= 42);

        let delta = Duration::from_nanos(3_600_000_123_456);
        let roundtrip = (high_uptime + delta).duration_since(high_uptime);
        let err_ns = (roundtrip.as_nanos() as i128 - delta.as_nanos() as i128).abs();
        assert!(err_ns <= 100, "unexpected operator drift: {err_ns}ns");
    }
}
