use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

/// FFmpeg 7.1 `amfenc.c` keeps `hwsurfaces_in_queue_max` at 16 when the D3D11
/// frames context has `initial_pool_size == 0`, and each input texture stays
/// referenced until `QueryOutput`. AMF only waits for that output once 16
/// surfaces are queued. A smaller ring fills first, the submitter stops, and
/// nothing is ever drained.
pub(crate) const AMF_HW_SURFACE_QUEUE: u32 = 16;
pub(crate) const TEXTURE_RING_CAPACITY: u32 = AMF_HW_SURFACE_QUEUE + 16;

/// How many encoder frames still reference each copied texture.
///
/// The encode thread is the only caller of `try_acquire` and `hold`. The
/// frame's release callback may run on another thread, and it only calls
/// `release`.
pub(crate) struct TextureSlots {
    holds: [AtomicU32; TEXTURE_RING_CAPACITY as usize],
    busy: AtomicU32,
    peak: AtomicU32,
}

impl TextureSlots {
    pub(crate) fn new() -> Self {
        Self {
            holds: std::array::from_fn(|_| AtomicU32::new(0)),
            busy: AtomicU32::new(0),
            peak: AtomicU32::new(0),
        }
    }

    pub(crate) fn high_water(&self) -> u32 {
        self.peak.load(Ordering::Acquire)
    }

    /// The first slot no frame still references. The caller must `hold` it
    /// before the next acquire, or this returns the same slot again.
    pub(crate) fn try_acquire(&self) -> Option<u32> {
        (0..TEXTURE_RING_CAPACITY)
            .find(|&slot| self.holds[slot as usize].load(Ordering::Acquire) == 0)
    }

    pub(crate) fn hold(&self, slot: u32) {
        let previous = self.holds[slot as usize].fetch_add(1, Ordering::AcqRel);
        if previous == 0 {
            let busy = self.busy.fetch_add(1, Ordering::AcqRel) + 1;
            self.peak.fetch_max(busy, Ordering::AcqRel);
        }
    }

    pub(crate) fn release(&self, slot: u32) {
        let previous = self.holds[slot as usize].fetch_sub(1, Ordering::AcqRel);
        if previous == 1 {
            self.busy.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

pub(crate) fn offset_from_first(ts: Duration, first: &mut Option<Duration>) -> Duration {
    if let Some(first_ts) = *first {
        ts.checked_sub(first_ts).unwrap_or(Duration::ZERO)
    } else {
        *first = Some(ts);
        Duration::ZERO
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_skips_held_slots_and_reuses_a_released_one() {
        let slots = TextureSlots::new();
        assert_eq!(slots.try_acquire(), Some(0));
        slots.hold(0);
        assert_eq!(slots.try_acquire(), Some(1));
        slots.hold(1);
        slots.release(0);
        assert_eq!(slots.try_acquire(), Some(0));
    }

    #[test]
    fn a_slot_with_two_holds_stays_busy_until_both_release() {
        let slots = TextureSlots::new();
        for slot in 0..3 {
            slots.hold(slot);
        }
        slots.hold(3);
        slots.hold(3);
        assert_ne!(slots.try_acquire(), Some(3));
        slots.release(3);
        assert_ne!(slots.try_acquire(), Some(3));
        slots.release(3);
        assert_eq!(slots.try_acquire(), Some(3));
    }

    #[test]
    fn a_full_ring_has_no_free_slot() {
        let slots = TextureSlots::new();
        for slot in 0..TEXTURE_RING_CAPACITY {
            slots.hold(slot);
        }
        assert_eq!(slots.try_acquire(), None);
        slots.release(5);
        assert_eq!(slots.try_acquire(), Some(5));
    }

    #[test]
    fn the_ring_outlasts_amf_inflight_and_reuses_a_released_slot() {
        let slots = TextureSlots::new();
        for _ in 0..AMF_HW_SURFACE_QUEUE {
            let slot = slots.try_acquire().expect("free slot");
            slots.hold(slot);
        }
        assert!(slots.try_acquire().is_some());
        assert_eq!(slots.high_water(), AMF_HW_SURFACE_QUEUE);

        let mut filled = AMF_HW_SURFACE_QUEUE;
        while let Some(slot) = slots.try_acquire() {
            slots.hold(slot);
            filled += 1;
            assert!(filled <= TEXTURE_RING_CAPACITY);
        }
        assert_eq!(filled, TEXTURE_RING_CAPACITY);
        assert!(slots.try_acquire().is_none());
        assert_eq!(slots.high_water(), TEXTURE_RING_CAPACITY);

        slots.release(3);
        assert_eq!(slots.try_acquire(), Some(3));
        assert_eq!(slots.high_water(), TEXTURE_RING_CAPACITY);
    }

    #[test]
    fn a_second_hold_does_not_raise_the_high_water_mark() {
        let slots = TextureSlots::new();
        slots.hold(0);
        slots.hold(0);
        assert_eq!(slots.high_water(), 1);
        assert_ne!(slots.try_acquire(), Some(0));
        slots.release(0);
        assert_ne!(slots.try_acquire(), Some(0));
        slots.release(0);
        assert_eq!(slots.try_acquire(), Some(0));
        assert_eq!(slots.high_water(), 1);
    }

    #[test]
    fn timestamps_start_at_zero_and_keep_later_offsets() {
        let mut first = None;
        let start = Duration::from_millis(5_000);
        assert_eq!(offset_from_first(start, &mut first), Duration::ZERO);
        assert_eq!(
            offset_from_first(start + Duration::from_millis(16), &mut first),
            Duration::from_millis(16)
        );
        assert_eq!(
            offset_from_first(start - Duration::from_millis(1), &mut first),
            Duration::ZERO
        );
        assert_eq!(first, Some(start));
    }
}
