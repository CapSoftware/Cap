use cidre::mach::TimeBaseInfo;
use std::{
    ops::{Add, Sub},
    sync::OnceLock,
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MachAbsoluteTimestamp(u64);

static TIMEBASE_RATIO: OnceLock<(u128, u128)> = OnceLock::new();

fn timebase_ratio() -> (u128, u128) {
    *TIMEBASE_RATIO.get_or_init(|| {
        let info = TimeBaseInfo::new();
        let numer = u128::from(info.numer.max(1));
        let denom = u128::from(info.denom.max(1));
        (numer, denom)
    })
}

fn ticks_to_nanos_with_ratio(ticks: u64, numer: u128, denom: u128) -> u128 {
    (u128::from(ticks) * numer + denom / 2) / denom
}

fn nanos_to_ticks_with_ratio(nanos: u128, numer: u128, denom: u128) -> u64 {
    let scaled = nanos.saturating_mul(denom);
    let ticks = scaled.saturating_add(numer / 2) / numer;
    u64::try_from(ticks).unwrap_or(u64::MAX)
}

fn duration_from_nanos_u128(nanos: u128) -> Duration {
    let secs = u64::try_from(nanos / 1_000_000_000).unwrap_or(u64::MAX);
    let subsec_nanos = (nanos % 1_000_000_000) as u32;
    if secs == u64::MAX {
        Duration::MAX
    } else {
        Duration::new(secs, subsec_nanos)
    }
}

impl MachAbsoluteTimestamp {
    pub fn new(ticks: u64) -> Self {
        Self(ticks)
    }

    pub fn now() -> Self {
        Self(cidre::mach::abs_time())
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        match self.checked_duration_since(other) {
            Some(duration) => duration,
            None => Duration::ZERO,
        }
    }

    pub fn checked_duration_since(&self, other: Self) -> Option<Duration> {
        let diff = self.0.checked_sub(other.0)?;
        let (numer, denom) = timebase_ratio();
        let nanos = ticks_to_nanos_with_ratio(diff, numer, denom);
        Some(duration_from_nanos_u128(nanos))
    }

    pub fn signed_duration_since_nanos(&self, other: Self) -> i128 {
        let (numer, denom) = timebase_ratio();
        if self.0 >= other.0 {
            let nanos = ticks_to_nanos_with_ratio(self.0 - other.0, numer, denom);
            i128::try_from(nanos).unwrap_or(i128::MAX)
        } else {
            let nanos = ticks_to_nanos_with_ratio(other.0 - self.0, numer, denom);
            let clamped = i128::try_from(nanos).unwrap_or(i128::MAX);
            -clamped
        }
    }

    pub fn signed_duration_since_secs(&self, other: Self) -> f64 {
        self.signed_duration_since_nanos(other) as f64 / 1_000_000_000.0
    }

    pub fn from_cpal(instant: cpal::StreamInstant) -> Self {
        use cpal::host::coreaudio::StreamInstantExt;

        Self(instant.as_host_time())
    }
}

impl Add<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self::Output {
        // ns = ticks * numer / denom, so ticks = ns * denom / numer.
        // On Apple Silicon (numer/denom = 125/3) multiplying by numer/denom
        // instead would add ~1736x the intended duration.
        let (numer, denom) = timebase_ratio();
        let ticks = nanos_to_ticks_with_ratio(rhs.as_nanos(), numer, denom);
        Self(self.0.saturating_add(ticks))
    }
}

impl Sub<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let (numer, denom) = timebase_ratio();
        let ticks = nanos_to_ticks_with_ratio(rhs.as_nanos(), numer, denom);
        Self(self.0.saturating_sub(ticks))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_since_returns_zero_when_earlier() {
        let base = MachAbsoluteTimestamp::new(1_000);
        let earlier = MachAbsoluteTimestamp::new(900);

        assert_eq!(earlier.duration_since(base), Duration::ZERO);
        assert_eq!(earlier.checked_duration_since(base), None);
    }

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
    fn high_uptime_arithmetic_avoids_f64_precision_loss() {
        let high_uptime = MachAbsoluteTimestamp::new((1u64 << 53) + 7);
        assert_eq!(high_uptime + Duration::ZERO, high_uptime);
        assert_eq!(high_uptime - Duration::ZERO, high_uptime);

        let step = Duration::from_millis(250);
        let advanced = high_uptime + step;
        assert!(advanced.0 > high_uptime.0);
        assert_eq!(advanced - step, high_uptime);

        let forward_ns = advanced.signed_duration_since_nanos(high_uptime);
        let backward_ns = high_uptime.signed_duration_since_nanos(advanced);
        assert_eq!(forward_ns, -backward_ns);
        assert!((forward_ns - 250_000_000).abs() <= 50);

        let ticks_6h = nanos_to_ticks_with_ratio(6 * 3_600 * 1_000_000_000, 125, 3);
        assert_eq!(ticks_6h, 518_400_000_000);
        let nanos_6h = ticks_to_nanos_with_ratio(ticks_6h, 125, 3);
        assert_eq!(nanos_6h, 6 * 3_600 * 1_000_000_000);
    }
}
