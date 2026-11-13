use std::{
    ops::{Add, Sub},
    sync::OnceLock,
    time::Duration,
};

use cidre::mach;
use serde::{Deserialize, Serialize};

// Raw mach_absolute_time ticks
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachAbsoluteTimestamp(u64);

static TIMEBASE_RATIO: OnceLock<(u128, u128)> = OnceLock::new();

fn timebase_ratio() -> (u128, u128) {
    *TIMEBASE_RATIO.get_or_init(|| {
        let info = TimeBaseInfo::new();
        (u128::from(info.0.numer), u128::from(info.0.denom.max(1)))
    })
}

fn ticks_to_nanos_with_ratio(ticks: u64, numer: u128, denom: u128) -> u128 {
    let denom = denom.max(1);
    (u128::from(ticks) * numer + denom / 2) / denom
}

fn nanos_to_ticks_with_ratio(nanos: u128, numer: u128, denom: u128) -> u64 {
    let numer = numer.max(1);
    let ticks = (nanos * denom + numer / 2) / numer;
    u64::try_from(ticks).unwrap_or(u64::MAX)
}

fn ticks_to_nanos(ticks: u64) -> u128 {
    let (numer, denom) = timebase_ratio();
    ticks_to_nanos_with_ratio(ticks, numer, denom)
}

fn duration_to_ticks(duration: Duration) -> u64 {
    let (numer, denom) = timebase_ratio();
    nanos_to_ticks_with_ratio(duration.as_nanos(), numer, denom)
}

impl MachAbsoluteTimestamp {
    pub fn now() -> Self {
        Self(unsafe { mach::time::mach_absolute_time() })
    }

    pub fn new(ticks: u64) -> Self {
        Self(ticks)
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        self.checked_duration_since(other)
            .expect("supplied instant is later than self")
    }

    pub fn duration_since_unix_epoch(&self) -> Duration {
        let nanos = u64::try_from(ticks_to_nanos(self.0)).unwrap_or(u64::MAX);
        Duration::from_nanos(nanos)
    }

    pub fn checked_duration_since(&self, earlier: Self) -> Option<Duration> {
        let diff = self.0.checked_sub(earlier.0)?;
        let nanos = u64::try_from(ticks_to_nanos(diff)).unwrap_or(u64::MAX);
        Some(Duration::from_nanos(nanos))
    }

    pub fn signed_duration_since_nanos(&self, other: Self) -> i128 {
        if self.0 >= other.0 {
            ticks_to_nanos(self.0 - other.0) as i128
        } else {
            -(ticks_to_nanos(other.0 - self.0) as i128)
        }
    }

    pub fn signed_duration_since_secs(&self, other: Self) -> f64 {
        self.signed_duration_since_nanos(other) as f64 / 1_000_000_000.0
    }
}

impl Add<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self::Output {
        let ticks = duration_to_ticks(rhs);
        Self(self.0.saturating_add(ticks))
    }
}

impl Sub<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let ticks = duration_to_ticks(rhs);
        Self(self.0.saturating_sub(ticks))
    }
}

struct TimeBaseInfo(mach::time::TimeBaseInfo);

impl TimeBaseInfo {
    pub fn new() -> Self {
        let mut info = mach::time::TimeBaseInfo::default();
        unsafe { mach::time::mach_timebase_info(&mut info) };
        Self(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_uptime_zero_duration_roundtrip_is_exact() {
        let base = MachAbsoluteTimestamp::new((1u64 << 53) + 1);
        assert_eq!(base + Duration::ZERO, base);
        assert_eq!(base - Duration::ZERO, base);
    }

    #[test]
    fn high_uptime_duration_arithmetic_avoids_f64_precision_loss() {
        let base = MachAbsoluteTimestamp::new((1u64 << 53) + 1);
        let delta = Duration::from_nanos(16_666_667);

        let advanced = base + delta;
        let elapsed = advanced.duration_since(base);

        let (numer, denom) = timebase_ratio();
        let expected_ticks = nanos_to_ticks_with_ratio(delta.as_nanos(), numer, denom);
        let expected_nanos = ticks_to_nanos_with_ratio(expected_ticks, numer, denom) as u64;

        assert_eq!(elapsed, Duration::from_nanos(expected_nanos));
        assert_eq!(advanced - delta, base);
    }

    #[test]
    fn apple_silicon_ratio_rounds_nearest_tick_and_nanos() {
        let numer = 125u128;
        let denom = 3u128;
        let ticks = nanos_to_ticks_with_ratio(1_000_000_000, numer, denom);
        assert_eq!(ticks, 24_000_000);
        let nanos = ticks_to_nanos_with_ratio(ticks, numer, denom);
        assert_eq!(nanos, 1_000_000_000);
    }

    #[test]
    fn signed_duration_since_nanos_and_secs_handle_both_directions() {
        let earlier = MachAbsoluteTimestamp::new(24_000_000);
        let delta = Duration::from_millis(250);
        let later = earlier + delta;

        assert!(later.signed_duration_since_nanos(earlier) > 0);
        assert_eq!(
            earlier.signed_duration_since_nanos(later),
            -later.signed_duration_since_nanos(earlier)
        );
        assert!((later.signed_duration_since_secs(earlier) - 0.25).abs() < 1e-6);
        assert!((earlier.signed_duration_since_secs(later) + 0.25).abs() < 1e-6);
    }
}
