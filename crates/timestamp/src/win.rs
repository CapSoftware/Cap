use std::{
    ops::{Add, Sub},
    sync::OnceLock,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

// Raw value of the performance counter
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerformanceCounterTimestamp(i64);

fn counter_diff_to_nanos(diff: i128, frequency: i64) -> i128 {
    let freq = i128::from(frequency.max(1));
    if diff >= 0 {
        (diff * 1_000_000_000 + freq / 2) / freq
    } else {
        -((-diff * 1_000_000_000 + freq / 2) / freq)
    }
}

fn duration_to_counter_ticks(duration: Duration, frequency: i64) -> i128 {
    let freq = u128::from(frequency.max(1) as u64);
    let nanos = duration.as_nanos();
    let ticks = (nanos * freq + 500_000_000) / 1_000_000_000;
    i128::try_from(ticks).unwrap_or(i128::MAX)
}

impl PerformanceCounterTimestamp {
    pub fn now() -> Self {
        let mut value = 0;
        let _ = unsafe { QueryPerformanceCounter(&mut value) };
        Self(value)
    }

    pub fn new(ticks: i64) -> Self {
        Self(ticks)
    }

    pub fn ticks(&self) -> i64 {
        self.0
    }

    pub fn duration_since_unix_epoch(&self) -> Duration {
        let nanos = counter_diff_to_nanos(i128::from(self.0.max(0)), perf_freq()).max(0) as u64;
        Duration::from_nanos(nanos)
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        self.checked_duration_since(other)
            .expect("supplied instant is later than self")
    }

    pub fn checked_duration_since(&self, earlier: Self) -> Option<Duration> {
        let diff = i128::from(self.0) - i128::from(earlier.0);
        if diff < 0 {
            return None;
        }
        let nanos = u64::try_from(counter_diff_to_nanos(diff, perf_freq())).unwrap_or(u64::MAX);
        Some(Duration::from_nanos(nanos))
    }

    pub fn signed_duration_since_nanos(&self, other: Self) -> i128 {
        let diff = i128::from(self.0) - i128::from(other.0);
        counter_diff_to_nanos(diff, perf_freq())
    }

    pub fn signed_duration_since_secs(&self, other: Self) -> f64 {
        self.signed_duration_since_nanos(other) as f64 / 1_000_000_000.0
    }
}

impl Add<Duration> for PerformanceCounterTimestamp {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self::Output {
        let ticks = duration_to_counter_ticks(rhs, perf_freq());
        let next = (i128::from(self.0) + ticks).clamp(i128::from(i64::MIN), i128::from(i64::MAX));
        Self(next as i64)
    }
}

impl Sub<Duration> for PerformanceCounterTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let ticks = duration_to_counter_ticks(rhs, perf_freq());
        let next = (i128::from(self.0) - ticks).clamp(i128::from(i64::MIN), i128::from(i64::MAX));
        Self(next as i64)
    }
}

static PERF_FREQ: OnceLock<i64> = OnceLock::new();

fn perf_freq() -> i64 {
    *PERF_FREQ.get_or_init(|| {
        let mut freq = 0;
        let _ = unsafe { QueryPerformanceFrequency(&mut freq) };
        freq
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_uptime_zero_duration_roundtrip_is_exact() {
        let base = PerformanceCounterTimestamp::new((1i64 << 53) + 1);
        assert_eq!(base + Duration::ZERO, base);
        assert_eq!(base - Duration::ZERO, base);
    }

    #[test]
    fn high_uptime_fractional_duration_avoids_f64_precision_loss() {
        let base = PerformanceCounterTimestamp::new((1i64 << 53) + 1);
        let delta = Duration::from_nanos(16_666_667);

        let advanced = base + delta;
        let expected_ticks = duration_to_counter_ticks(delta, perf_freq()) as i64;
        assert_eq!(advanced.ticks() - base.ticks(), expected_ticks);
        assert_eq!(advanced - delta, base);
    }

    #[test]
    fn signed_duration_since_nanos_and_secs_are_consistent() {
        let base = PerformanceCounterTimestamp::new((1i64 << 53) + 1);
        let delta = Duration::from_millis(500);
        let later = base + delta;

        let nanos = later.signed_duration_since_nanos(base);
        assert_eq!(nanos, 500_000_000);
        assert_eq!(base.signed_duration_since_nanos(later), -500_000_000);
        assert!((later.signed_duration_since_secs(base) - 0.5).abs() < 1e-6);
    }
}
