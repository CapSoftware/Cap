use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

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
            Self::Instant(instant) => instant.duration_since(start.instant),
            Self::SystemTime(time) => time.duration_since(start.system_time).unwrap(),
            #[cfg(windows)]
            Self::PerformanceCounter(counter) => counter.duration_since(start.performance_counter),
            #[cfg(target_os = "macos")]
            Self::MachAbsoluteTime(time) => time.duration_since(start.mach_absolute_time),
        }
    }

    pub fn from_cpal(instant: cpal::StreamInstant) -> Self {
        #[cfg(windows)]
        Self::PerformanceCounter(PerformanceCounterTimestamp::from_cpal(instant));
        #[cfg(target_os = "macos")]
        Self::MachAbsoluteTime(MachAbsoluteTimestamp::from_cpal(instant))
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
