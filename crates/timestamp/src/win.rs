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
        let freq = perf_freq();
        Duration::from_secs_f64((self.0 - other.0) as f64 / freq as f64)
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
