use cidre::mach::TimeBaseInfo;
use std::{
    ops::{Add, Sub},
    time::Duration,
};

#[derive(Clone, Copy, Debug)]
pub struct MachAbsoluteTimestamp(u64);

impl MachAbsoluteTimestamp {
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn now() -> Self {
        Self(cidre::mach::abs_time())
    }

    pub fn duration_since(&self, other: Self) -> Duration {
        let info = TimeBaseInfo::new();
        let freq = info.numer as f64 / info.denom as f64;

        Duration::from_nanos(((self.0 - other.0) as f64 * freq) as u64)
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
        let freq = info.numer as f64 / info.denom as f64;

        Self((self.0 as f64 * rhs.as_secs_f64() * freq) as u64)
    }
}

impl Sub<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let info = TimeBaseInfo::new();
        let freq = info.numer as f64 / info.denom as f64;

        Self((self.0 as f64 / freq - rhs.as_millis() as f64) as u64)
    }
}
