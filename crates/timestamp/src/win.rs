use cpal::StreamInstant;
use std::{
    ops::{Add, Sub},
    sync::OnceLock,
    time::Duration,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

#[derive(Clone, Copy, Debug)]
pub struct PerformanceCounterTimestamp(i128);

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
        Self(i128::from(value))
    }

    pub fn from_100ns(value: i64) -> Self {
        Self(performance_counter_from_100ns(value, perf_freq()))
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        let freq = perf_freq() as i128;
        debug_assert!(freq > 0);

        let diff = self.0 - other.0;

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

    pub fn checked_duration_since(&self, other: Self) -> Option<Duration> {
        let freq = perf_freq() as i128;
        debug_assert!(freq > 0);

        let diff = self.0 - other.0;

        if diff < 0 {
            None
        } else {
            let diff = diff as u128;
            let freq = freq as u128;

            let secs = diff / freq;
            let nanos = ((diff % freq) * 1_000_000_000u128) / freq;

            Some(Duration::new(secs as u64, nanos as u32))
        }
    }

    pub fn signed_duration_since_secs(&self, other: Self) -> f64 {
        let freq = perf_freq() as f64;
        (self.0 - other.0) as f64 / freq
    }

    pub fn now() -> Self {
        let mut value = 0;
        unsafe { QueryPerformanceCounter(&mut value).unwrap() };
        Self::new(value)
    }

    pub fn from_cpal(instant: StreamInstant) -> Self {
        use cpal::host::wasapi::StreamInstantExt;

        Self::from_100ns(instant.as_performance_counter())
    }
}

fn performance_counter_from_100ns(timestamp: i64, frequency: i64) -> i128 {
    (i128::from(timestamp) * i128::from(frequency)) / 10_000_000
}

impl Add<Duration> for PerformanceCounterTimestamp {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self::Output {
        let freq = perf_freq();
        Self(self.0 + (rhs.as_secs_f64() * freq as f64) as i128)
    }
}

impl Sub<Duration> for PerformanceCounterTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let freq = perf_freq();
        Self(self.0 - (rhs.as_secs_f64() * freq as f64) as i128)
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

    #[test]
    fn wasapi_timestamps_use_the_machine_counter_frequency() {
        for frequency in [3_000_000, 10_000_000, 24_000_000, 1_000_000_000] {
            assert_eq!(
                performance_counter_from_100ns(123_450_000, frequency),
                i128::from(frequency * 12 + frequency * 345 / 1_000)
            );
        }
    }

    #[test]
    fn invalid_device_epochs_preserve_packet_spacing_at_all_counter_frequencies() {
        assert_eq!(performance_counter_from_100ns(0, 24_000_000), 0);
        for frequency in [3_000_000, 10_000_000, 24_000_000, 5_000_000_000] {
            for epoch in [i64::MIN, -22_236_875_390_000_000, i64::MAX - 100_000] {
                let first = performance_counter_from_100ns(epoch, frequency);
                let next = performance_counter_from_100ns(epoch + 100_000, frequency);
                assert_eq!(next - first, i128::from(frequency / 100));
            }
        }
    }

    #[test]
    fn screen_audio_and_native_counter_timestamps_share_one_timebase() {
        let raw_counter = 12 * perf_freq();
        let native = PerformanceCounterTimestamp::new(raw_counter);
        let screen_or_audio = PerformanceCounterTimestamp::from_100ns(120_000_000);

        assert_eq!(screen_or_audio.signed_duration_since_secs(native), 0.0);
        assert_eq!(
            (screen_or_audio + Duration::from_millis(10)).duration_since(native),
            Duration::from_millis(10)
        );
    }
}
