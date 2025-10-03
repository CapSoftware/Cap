use cpal::StreamInstant;
use std::{
    ops::{Add, Sub},
    sync::OnceLock,
    time::Duration,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

#[derive(Clone, Copy, Debug)]
pub struct PerformanceCounterTimestamp(i64);

static PERF_FREQ: OnceLock<i64> = OnceLock::new();

#[inline]
fn perf_freq() -> i64 {
    *PERF_FREQ.get_or_init(|| {
        let mut freq: i64 = 0;
        // SAFETY: According to the Windows API docs, QueryPerformanceFrequency
        // will succeed on all Windows XP and later systems.
        unsafe { QueryPerformanceFrequency(&mut freq) }.unwrap();
        freq
    })
}

impl PerformanceCounterTimestamp {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        let freq = perf_freq() as i128;
        debug_assert!(freq > 0);

        let diff = self.0 as i128 - other.0 as i128;

        if diff <= 0 {
            Duration::ZERO
        } else {
            let diff = diff as u128;
            let freq = freq as u128;

            let secs = diff / freq;
            let nanos = ((diff % freq) * 1_000_000_000u128) / freq;

            Duration::new(secs as u64, nanos as u32)
        }
    }

    pub fn now() -> Self {
        let mut value = 0;
        unsafe { QueryPerformanceCounter(&mut value).unwrap() };
        Self(value)
    }

    pub fn from_cpal(instant: StreamInstant) -> Self {
        use cpal::host::wasapi::StreamInstantExt;

        Self(instant.as_performance_counter())
    }
}

impl Add<Duration> for PerformanceCounterTimestamp {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self::Output {
        let freq = perf_freq();
        Self(self.0 + (rhs.as_secs_f64() * freq as f64) as i64)
    }
}

impl Sub<Duration> for PerformanceCounterTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let freq = perf_freq();
        Self(self.0 - (rhs.as_secs_f64() * freq as f64) as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_since_returns_zero_when_earlier() {
        let freq = perf_freq();
        let base = PerformanceCounterTimestamp::new(10 * freq);
        let earlier = PerformanceCounterTimestamp::new(9 * freq);

        assert_eq!(earlier.duration_since(base), Duration::ZERO);
    }

    #[test]
    fn duration_since_handles_positive_diff() {
        let freq = perf_freq();
        let base = PerformanceCounterTimestamp::new(10 * freq);
        let later = PerformanceCounterTimestamp::new(11 * freq);

        assert_eq!(later.duration_since(base), Duration::from_secs(1));
    }
}
