use cidre::mach::TimeBaseInfo;
use std::{
    ops::{Add, Sub},
    time::Duration,
};

#[derive(Clone, Copy, Debug)]
pub struct MachAbsoluteTimestamp(
    // Nanoseconds
    u64,
);

impl MachAbsoluteTimestamp {
    pub fn new(nanos: u64) -> Self {
        Self(nanos)
    }

    pub fn now() -> Self {
        Self(cidre::mach::abs_time())
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        let info = TimeBaseInfo::new();
        let freq = info.numer as f64 / info.denom as f64;

        let Some(diff) = self.0.checked_sub(other.0) else {
            return Duration::ZERO;
        };

        Duration::from_nanos((diff as f64 * freq) as u64)
    }

    pub fn checked_duration_since(&self, other: Self) -> Option<Duration> {
        let info = TimeBaseInfo::new();
        let freq = info.numer as f64 / info.denom as f64;

        let diff = self.0.checked_sub(other.0)?;

        Some(Duration::from_nanos((diff as f64 * freq) as u64))
    }

    pub fn signed_duration_since_secs(&self, other: Self) -> f64 {
        let info = TimeBaseInfo::new();
        let freq = info.numer as f64 / info.denom as f64;

        let nanos = if self.0 >= other.0 {
            ((self.0 - other.0) as f64 * freq) as i64
        } else {
            -(((other.0 - self.0) as f64 * freq) as i64)
        };

        nanos as f64 / 1_000_000_000.0
    }

    pub fn from_cpal(instant: cpal::StreamInstant) -> Self {
        use cpal::host::coreaudio::StreamInstantExt;

        Self(instant.as_host_time())
    }
}

impl Add<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self::Output {
        let info = TimeBaseInfo::new();
        // ns = ticks * numer / denom, so ticks = ns * denom / numer.
        // On Apple Silicon (numer/denom = 125/3) multiplying by numer/denom
        // instead would add ~1736x the intended duration.
        let ticks = rhs.as_nanos() as f64 * info.denom as f64 / info.numer as f64;

        Self((self.0 as f64 + ticks) as u64)
    }
}

impl Sub<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let info = TimeBaseInfo::new();
        let ticks = rhs.as_nanos() as f64 * info.denom as f64 / info.numer as f64;

        Self((self.0 as f64 - ticks).max(0.0) as u64)
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

        let drift = roundtrip.duration_since(base).max(base.duration_since(roundtrip));
        assert!(
            drift < Duration::from_micros(10),
            "add/sub of the same duration must cancel out, drifted {drift:?}"
        );
    }
}
