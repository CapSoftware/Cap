use cpal::StreamInstant;
use std::{
    ops::{Add, Sub},
    sync::OnceLock,
    time::Duration,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

fn counter_diff_to_nanos(diff: i128, frequency: i64) -> i128 {
    let freq = i128::from(frequency.max(1));
    let whole_secs = diff / freq;
    let rem = diff % freq;
    let rem_nanos = if rem >= 0 {
        (rem * 1_000_000_000 + freq / 2) / freq
    } else {
        (rem * 1_000_000_000 - freq / 2) / freq
    };
    let base_nanos = whole_secs.saturating_mul(1_000_000_000);
    base_nanos.saturating_add(rem_nanos)
}

fn duration_to_counter_ticks(duration: Duration, frequency: i64) -> i128 {
    let freq = i128::from(frequency.max(1));
    let whole_ticks = i128::from(duration.as_secs()).saturating_mul(freq);
    let subsec_ticks = (i128::from(duration.subsec_nanos()) * freq + 500_000_000) / 1_000_000_000;
    whole_ticks.saturating_add(subsec_ticks)
}

impl PerformanceCounterTimestamp {
    pub fn new(value: i64) -> Self {
        Self(i128::from(value))
    }

    pub fn from_100ns(value: i64) -> Self {
        Self(performance_counter_from_100ns(value, perf_freq()))
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        match self.checked_duration_since(other) {
            Some(duration) => duration,
            None => Duration::ZERO,
        }
    }

    pub fn checked_duration_since(&self, other: Self) -> Option<Duration> {
        let freq = i128::from(perf_freq());
        debug_assert!(freq > 0);

        let diff = self.0 - other.0;
        if diff < 0 {
            return None;
        }

        let diff = diff as u128;
        let freq = freq.max(1) as u128;
        let mut secs = diff / freq;
        let mut nanos = ((diff % freq) * 1_000_000_000u128 + freq / 2) / freq;
        if nanos >= 1_000_000_000 {
            secs += 1;
            nanos -= 1_000_000_000;
        }

        let clamped_secs = u64::try_from(secs).unwrap_or(u64::MAX);
        if clamped_secs == u64::MAX {
            Some(Duration::MAX)
        } else {
            Some(Duration::new(clamped_secs, nanos as u32))
        }
    }

    pub fn signed_duration_since_nanos(&self, other: Self) -> i128 {
        counter_diff_to_nanos(self.0 - other.0, perf_freq())
    }

    pub fn signed_duration_since_secs(&self, other: Self) -> f64 {
        self.signed_duration_since_nanos(other) as f64 / 1_000_000_000.0
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
        let ticks = duration_to_counter_ticks(rhs, perf_freq());
        Self(self.0.saturating_add(ticks))
    }
}

impl Sub<Duration> for PerformanceCounterTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let ticks = duration_to_counter_ticks(rhs, perf_freq());
        Self(self.0.saturating_sub(ticks))
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

    #[test]
    fn high_uptime_duration_arithmetic_avoids_f64_precision_loss() {
        let base = PerformanceCounterTimestamp::new((1i64 << 53) + 1);
        assert_eq!(base + Duration::ZERO, base);
        assert_eq!(base - Duration::ZERO, base);

        let delta = Duration::from_nanos(16_666_667);
        let advanced = base + delta;
        let expected_ticks = duration_to_counter_ticks(delta, perf_freq());
        assert_eq!(advanced.0 - base.0, expected_ticks);
        assert_eq!(advanced - delta, base);

        let later = base + Duration::from_millis(500);
        assert_eq!(later.signed_duration_since_nanos(base), 500_000_000);
        assert_eq!(base.signed_duration_since_nanos(later), -500_000_000);
    }
}
