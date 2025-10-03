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

        Self((self.0 as f64 + rhs.as_nanos() as f64 * freq) as u64)
    }
}

impl Sub<Duration> for MachAbsoluteTimestamp {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self::Output {
        let info = TimeBaseInfo::new();
        let freq = info.numer as f64 / info.denom as f64;

        Self((self.0 as f64 - rhs.as_nanos() as f64 * freq) as u64)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test() {
        let a = MachAbsoluteTimestamp::new(0);

        dbg!(MachAbsoluteTimestamp::now());
        dbg!(a + Duration::from_secs(1));
    }
}
