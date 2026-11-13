use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use std::time::Duration;

use crate::{Timestamp, Timestamps};

/// Shared monotonic master clock for an entire recording session.
///
/// Anchors every capture source (display, camera, microphone, system audio,
/// cursor) to one common t=0 and tracks cumulative pause duration so that
/// pause/resume is handled identically across all tracks without restarting
/// hardware pipelines.
#[derive(Debug, Clone)]
pub struct MasterClock {
    timestamps: Timestamps,
    inner: Arc<MasterClockInner>,
}

#[derive(Debug)]
struct MasterClockInner {
    paused_offset_ns: AtomicI64,
    pause_started_raw_ns: AtomicI64,
}

const NOT_PAUSED: i64 = i64::MIN;

impl MasterClock {
    pub fn new() -> Self {
        Self::from_timestamps(Timestamps::now())
    }

    pub fn from_timestamps(timestamps: Timestamps) -> Self {
        Self {
            timestamps,
            inner: Arc::new(MasterClockInner {
                paused_offset_ns: AtomicI64::new(0),
                pause_started_raw_ns: AtomicI64::new(NOT_PAUSED),
            }),
        }
    }

    pub fn timestamps(&self) -> Timestamps {
        self.timestamps
    }

    pub fn pause(&self) {
        let now_ns = self.raw_elapsed_ns_now();
        let _ = self.inner.pause_started_raw_ns.compare_exchange(
            NOT_PAUSED,
            now_ns,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub fn resume(&self) {
        let now_ns = self.raw_elapsed_ns_now();
        let started = self
            .inner
            .pause_started_raw_ns
            .swap(NOT_PAUSED, Ordering::AcqRel);
        if started != NOT_PAUSED && now_ns > started {
            self.inner
                .paused_offset_ns
                .fetch_add(now_ns - started, Ordering::AcqRel);
        }
    }

    pub fn is_paused(&self) -> bool {
        self.inner.pause_started_raw_ns.load(Ordering::Acquire) != NOT_PAUSED
    }

    pub fn paused_offset_ns(&self) -> i64 {
        let base = self.inner.paused_offset_ns.load(Ordering::Acquire);
        let pause_start = self.inner.pause_started_raw_ns.load(Ordering::Acquire);
        if pause_start == NOT_PAUSED {
            base
        } else {
            let now = self.raw_elapsed_ns_now();
            base + (now - pause_start).max(0)
        }
    }

    pub fn paused_offset(&self) -> Duration {
        Duration::from_nanos(self.paused_offset_ns().max(0) as u64)
    }

    /// Remaps a source-native `Timestamp` into the master timeline (seconds
    /// since recording start, minus any paused duration). Returns `None` if
    /// the clock is currently paused or if the resulting timestamp precedes
    /// recording start (`t < 0`).
    pub fn remap(&self, source_ts: Timestamp) -> Option<Duration> {
        if self.is_paused() {
            return None;
        }
        let raw_ns = self.remap_raw_ns(source_ts);
        let paused_ns = self.inner.paused_offset_ns.load(Ordering::Acquire);
        let net_ns = raw_ns - paused_ns;
        if net_ns < 0 {
            return None;
        }
        Some(Duration::from_nanos(net_ns as u64))
    }

    /// Remaps a source-native `Timestamp` into raw signed nanoseconds since
    /// the master clock's t=0, ignoring pause state. Useful for drift
    /// trackers and diagnostics that need a signed offset before clamping.
    pub fn remap_raw_ns(&self, source_ts: Timestamp) -> i64 {
        let nanos = source_ts.signed_duration_since_nanos(self.timestamps);
        nanos_to_i64_saturating(nanos)
    }

    /// Returns the current active timeline position (`now - t0 - paused`).
    pub fn elapsed_active(&self) -> Duration {
        let raw = self.raw_elapsed_ns_now();
        let paused = self.paused_offset_ns();
        Duration::from_nanos((raw - paused).max(0) as u64)
    }

    fn raw_elapsed_ns_now(&self) -> i64 {
        let elapsed = self.timestamps.instant().elapsed();
        nanos_to_i64_saturating(elapsed.as_nanos() as i128)
    }
}

impl Default for MasterClock {
    fn default() -> Self {
        Self::new()
    }
}

fn nanos_to_i64_saturating(nanos: i128) -> i64 {
    nanos.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remap_raw_ns_preserves_exact_nanosecond_precision_over_multi_hour_recordings() {
        let clock = MasterClock::new();
        let offset = Duration::from_secs(3 * 3600) + Duration::from_nanos(123_456_789);
        let future_instant = clock.timestamps().instant() + offset;

        let remapped = clock.remap_raw_ns(Timestamp::Instant(future_instant));
        assert_eq!(remapped, offset.as_nanos() as i64);
    }

    #[test]
    fn remap_raw_ns_handles_negative_offsets_exactly() {
        let clock = MasterClock::new();
        let offset = Duration::from_millis(250) + Duration::from_nanos(7);
        let earlier_system = clock.timestamps().system_time() - offset;

        let remapped = clock.remap_raw_ns(Timestamp::SystemTime(earlier_system));
        assert_eq!(remapped, -(offset.as_nanos() as i64));
    }
}
