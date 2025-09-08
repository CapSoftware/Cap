use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

use super::*;

#[derive(Clone, Copy, Debug)]
pub struct PerformanceCounterTimestamp(i64);

impl PerformanceCounterTimestamp {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        let mut freq = 0;
        unsafe { QueryPerformanceFrequency(&mut freq).unwrap() };

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
        let mut freq = 0;
        unsafe { QueryPerformanceFrequency(&mut freq) }.unwrap();
        Self(self.0 + (rhs.as_secs_f64() * freq as f64) as i64)
    }
}
