use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

mod master_clock;
pub use master_clock::*;

#[derive(Clone, Copy, Debug)]
pub enum Timestamp {
    Instant(Instant),
    SystemTime(SystemTime),
    #[cfg(windows)]
    PerformanceCounter(PerformanceCounterTimestamp),
    #[cfg(target_os = "macos")]
    MachAbsoluteTime(MachAbsoluteTimestamp),
}

impl Timestamp {
    pub fn duration_since(&self, start: Timestamps) -> Duration {
        match self {
            Self::Instant(instant) => instant
                .checked_duration_since(start.instant)
                .unwrap_or(Duration::ZERO),
            Self::SystemTime(time) => time
                .duration_since(start.system_time)
                .unwrap_or(Duration::ZERO),
            #[cfg(windows)]
            Self::PerformanceCounter(counter) => counter.duration_since(start.performance_counter),
            #[cfg(target_os = "macos")]
            Self::MachAbsoluteTime(time) => time.duration_since(start.mach_absolute_time),
        }
    }

    pub fn checked_duration_since(&self, start: Timestamps) -> Option<Duration> {
        match self {
            Self::Instant(instant) => instant.checked_duration_since(start.instant),
            Self::SystemTime(time) => time.duration_since(start.system_time).ok(),
            #[cfg(windows)]
            Self::PerformanceCounter(counter) => {
                counter.checked_duration_since(start.performance_counter)
            }
            #[cfg(target_os = "macos")]
            Self::MachAbsoluteTime(time) => time.checked_duration_since(start.mach_absolute_time),
        }
    }

    pub fn signed_duration_since_secs(&self, start: Timestamps) -> f64 {
        match self {
            Self::Instant(instant) => {
                if let Some(duration) = instant.checked_duration_since(start.instant) {
                    duration.as_secs_f64()
                } else {
                    let reverse = start.instant.duration_since(*instant);
                    -(reverse.as_secs_f64())
                }
            }
            Self::SystemTime(time) => match time.duration_since(start.system_time) {
                Ok(duration) => duration.as_secs_f64(),
                Err(e) => -(e.duration().as_secs_f64()),
            },
            #[cfg(windows)]
            Self::PerformanceCounter(counter) => {
                counter.signed_duration_since_secs(start.performance_counter)
            }
            #[cfg(target_os = "macos")]
            Self::MachAbsoluteTime(time) => {
                time.signed_duration_since_secs(start.mach_absolute_time)
            }
        }
    }

    pub fn from_cpal(instant: cpal::StreamInstant) -> Self {
        #[cfg(windows)]
        {
            Self::PerformanceCounter(PerformanceCounterTimestamp::from_cpal(instant))
        }
        #[cfg(target_os = "macos")]
        {
            Self::MachAbsoluteTime(MachAbsoluteTimestamp::from_cpal(instant))
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = instant;
            Self::Instant(Instant::now())
        }
    }
}

impl std::ops::Add<Duration> for &Timestamp {
    type Output = Timestamp;

    fn add(self, rhs: Duration) -> Self::Output {
        match *self {
            Timestamp::Instant(i) => Timestamp::Instant(i + rhs),
            Timestamp::SystemTime(t) => Timestamp::SystemTime(t + rhs),
            #[cfg(windows)]
            Timestamp::PerformanceCounter(c) => Timestamp::PerformanceCounter(c + rhs),
            #[cfg(target_os = "macos")]
            Timestamp::MachAbsoluteTime(c) => Timestamp::MachAbsoluteTime(c + rhs),
        }
    }
}

impl std::ops::Add<Duration> for Timestamp {
    type Output = Timestamp;

    fn add(self, rhs: Duration) -> Self::Output {
        match self {
            Timestamp::Instant(i) => Timestamp::Instant(i + rhs),
            Timestamp::SystemTime(t) => Timestamp::SystemTime(t + rhs),
            #[cfg(windows)]
            Timestamp::PerformanceCounter(c) => Timestamp::PerformanceCounter(c + rhs),
            #[cfg(target_os = "macos")]
            Timestamp::MachAbsoluteTime(c) => Timestamp::MachAbsoluteTime(c + rhs),
        }
    }
}

impl std::ops::Sub<Duration> for Timestamp {
    type Output = Timestamp;

    fn sub(self, rhs: Duration) -> Self::Output {
        match self {
            Timestamp::Instant(i) => Timestamp::Instant(i.checked_sub(rhs).unwrap_or(i)),
            Timestamp::SystemTime(t) => Timestamp::SystemTime(t - rhs),
            #[cfg(windows)]
            Timestamp::PerformanceCounter(c) => Timestamp::PerformanceCounter(c - rhs),
            #[cfg(target_os = "macos")]
            Timestamp::MachAbsoluteTime(c) => Timestamp::MachAbsoluteTime(c - rhs),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Timestamps {
    instant: Instant,
    system_time: SystemTime,
    #[cfg(windows)]
    performance_counter: PerformanceCounterTimestamp,
    #[cfg(target_os = "macos")]
    mach_absolute_time: MachAbsoluteTimestamp,
}

impl Timestamps {
    pub fn now() -> Self {
        Self {
            instant: Instant::now(),
            system_time: SystemTime::now(),
            #[cfg(windows)]
            performance_counter: PerformanceCounterTimestamp::now(),
            #[cfg(target_os = "macos")]
            mach_absolute_time: MachAbsoluteTimestamp::now(),
        }
    }

    pub fn instant(&self) -> Instant {
        self.instant
    }

    pub fn system_time(&self) -> SystemTime {
        self.system_time
    }

    #[cfg(target_os = "macos")]
    pub fn mach_absolute_time(&self) -> MachAbsoluteTimestamp {
        self.mach_absolute_time
    }
}

impl std::ops::Add<Duration> for Timestamps {
    type Output = Timestamps;

    fn add(self, rhs: Duration) -> Self::Output {
        Self {
            instant: self.instant + rhs,
            system_time: self.system_time + rhs,
            #[cfg(windows)]
            performance_counter: self.performance_counter + rhs,
            #[cfg(target_os = "macos")]
            mach_absolute_time: self.mach_absolute_time + rhs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> Timestamps {
        Timestamps {
            instant: Instant::now(),
            system_time: SystemTime::now(),
            #[cfg(windows)]
            performance_counter: PerformanceCounterTimestamp::new(1_000_000_000),
            #[cfg(target_os = "macos")]
            mach_absolute_time: MachAbsoluteTimestamp::new(1_000_000_000),
        }
    }

    #[test]
    fn duration_since_saturates_to_zero_when_the_clock_stepped_backwards() {
        let reference = reference();
        let instant = Timestamp::Instant(
            reference
                .instant
                .checked_sub(Duration::from_secs(1))
                .expect("reference supports subtraction"),
        );
        let system_time = Timestamp::SystemTime(
            reference
                .system_time
                .checked_sub(Duration::from_secs(1))
                .expect("reference supports subtraction"),
        );

        assert_eq!(instant.duration_since(reference), Duration::ZERO);
        assert_eq!(system_time.duration_since(reference), Duration::ZERO);
    }

    #[test]
    fn duration_since_still_measures_forward_time() {
        let reference = reference();
        let instant = Timestamp::Instant(reference.instant + Duration::from_secs(2));
        let system_time = Timestamp::SystemTime(reference.system_time + Duration::from_secs(2));

        assert_eq!(instant.duration_since(reference), Duration::from_secs(2));
        assert_eq!(
            system_time.duration_since(reference),
            Duration::from_secs(2)
        );
    }
}
