#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod win;

mod master_clock;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(target_os = "macos")]
pub use macos::*;
pub use master_clock::*;
#[cfg(target_os = "windows")]
pub use win::*;

/// Captures anchor timestamps at the same instant, allowing later
/// conversions from any timestamp type.
#[derive(Debug, Clone, Copy)]
pub struct Timestamps {
    instant: Instant,
    system_time: SystemTime,
    #[cfg(target_os = "macos")]
    mach_absolute_time: MachAbsoluteTimestamp,
    #[cfg(target_os = "windows")]
    performance_counter: PerformanceCounterTimestamp,
}

impl Timestamps {
    pub fn now() -> Self {
        Self {
            instant: Instant::now(),
            system_time: SystemTime::now(),
            #[cfg(target_os = "macos")]
            mach_absolute_time: MachAbsoluteTimestamp::now(),
            #[cfg(target_os = "windows")]
            performance_counter: PerformanceCounterTimestamp::now(),
        }
    }

    pub fn from_wall_and_instant(system_time: SystemTime, instant: Instant) -> Self {
        Self {
            instant,
            system_time,
            #[cfg(target_os = "macos")]
            mach_absolute_time: MachAbsoluteTimestamp::now(),
            #[cfg(target_os = "windows")]
            performance_counter: PerformanceCounterTimestamp::now(),
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

    #[cfg(target_os = "windows")]
    pub fn performance_counter(&self) -> PerformanceCounterTimestamp {
        self.performance_counter
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Type)]
pub struct SystemTimeStamp {
    value: Duration,
}

#[derive(Debug, Clone, Copy)]
pub enum Timestamp {
    Instant(Instant),
    SystemTime(SystemTime),
    #[cfg(target_os = "windows")]
    PerformanceCounter(PerformanceCounterTimestamp),
    #[cfg(target_os = "macos")]
    MachAbsoluteTime(MachAbsoluteTimestamp),
}

impl Timestamp {
    pub fn duration_since(&self, start: Timestamps) -> Option<Duration> {
        Some(match self {
            Timestamp::Instant(t) => t.checked_duration_since(start.instant())?,
            Timestamp::SystemTime(t) => t.duration_since(start.system_time()).ok()?,
            #[cfg(target_os = "windows")]
            Timestamp::PerformanceCounter(t) => {
                t.checked_duration_since(start.performance_counter())?
            }
            #[cfg(target_os = "macos")]
            Timestamp::MachAbsoluteTime(t) => {
                t.checked_duration_since(start.mach_absolute_time())?
            }
        })
    }

    /// Returns the signed elapsed duration in nanoseconds since `start`.
    /// Negative if `self` is earlier than `start`.
    pub fn signed_duration_since_nanos(&self, start: Timestamps) -> i128 {
        match self {
            Timestamp::Instant(t) => {
                if let Some(d) = t.checked_duration_since(start.instant()) {
                    d.as_nanos() as i128
                } else if let Some(d) = start.instant().checked_duration_since(*t) {
                    -(d.as_nanos() as i128)
                } else {
                    0
                }
            }
            Timestamp::SystemTime(t) => match t.duration_since(start.system_time()) {
                Ok(d) => d.as_nanos() as i128,
                Err(e) => -(e.duration().as_nanos() as i128),
            },
            #[cfg(target_os = "windows")]
            Timestamp::PerformanceCounter(t) => {
                t.signed_duration_since_nanos(start.performance_counter())
            }
            #[cfg(target_os = "macos")]
            Timestamp::MachAbsoluteTime(t) => {
                t.signed_duration_since_nanos(start.mach_absolute_time())
            }
        }
    }

    /// Returns the signed elapsed duration in seconds since `start`.
    /// Negative if `self` is earlier than `start`.
    pub fn signed_duration_since_secs(&self, start: Timestamps) -> f64 {
        match self {
            Timestamp::Instant(_) | Timestamp::SystemTime(_) => {
                self.signed_duration_since_nanos(start) as f64 / 1_000_000_000.0
            }
            #[cfg(target_os = "windows")]
            Timestamp::PerformanceCounter(t) => {
                t.signed_duration_since_secs(start.performance_counter())
            }
            #[cfg(target_os = "macos")]
            Timestamp::MachAbsoluteTime(t) => {
                t.signed_duration_since_secs(start.mach_absolute_time())
            }
        }
    }

    pub fn duration_since_unix_epoch(&self) -> Duration {
        match self {
            Timestamp::Instant(t) => {
                let now = Timestamps::now();
                let duration_since = now.instant().duration_since(*t);
                let system_time = now.system_time() - duration_since;
                system_time
                    .duration_since(UNIX_EPOCH)
                    .expect("insight into the past is not supported")
            }
            Timestamp::SystemTime(t) => t
                .duration_since(UNIX_EPOCH)
                .expect("insight into the past is not supported"),
            #[cfg(target_os = "windows")]
            Timestamp::PerformanceCounter(t) => t.duration_since_unix_epoch(),
            #[cfg(target_os = "macos")]
            Timestamp::MachAbsoluteTime(t) => t.duration_since_unix_epoch(),
        }
    }
}

impl From<Instant> for Timestamp {
    fn from(instant: Instant) -> Self {
        Timestamp::Instant(instant)
    }
}

impl From<SystemTime> for Timestamp {
    fn from(system_time: SystemTime) -> Self {
        Timestamp::SystemTime(system_time)
    }
}

#[cfg(target_os = "windows")]
impl From<PerformanceCounterTimestamp> for Timestamp {
    fn from(performance_counter: PerformanceCounterTimestamp) -> Self {
        Timestamp::PerformanceCounter(performance_counter)
    }
}

#[cfg(target_os = "macos")]
impl From<MachAbsoluteTimestamp> for Timestamp {
    fn from(mach_absolute_time: MachAbsoluteTimestamp) -> Self {
        Timestamp::MachAbsoluteTime(mach_absolute_time)
    }
}
