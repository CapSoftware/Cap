use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

pub(crate) const TEXTURE_RING_CAPACITY: u32 = 8;

/// How many encoder frames still reference each copied texture.
///
/// The encode thread is the only caller of `try_acquire` and `hold`. The
/// frame's release callback may run on another thread, and it only calls
/// `release`.
pub(crate) struct TextureSlots {
    holds: [AtomicU32; TEXTURE_RING_CAPACITY as usize],
}

impl TextureSlots {
    pub(crate) fn new() -> Self {
        Self {
            holds: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }

    /// The first slot no frame still references. The caller must `hold` it
    /// before the next acquire, or this returns the same slot again.
    pub(crate) fn try_acquire(&self) -> Option<u32> {
        (0..TEXTURE_RING_CAPACITY)
            .find(|&slot| self.holds[slot as usize].load(Ordering::Acquire) == 0)
    }

    pub(crate) fn hold(&self, slot: u32) {
        self.holds[slot as usize].fetch_add(1, Ordering::AcqRel);
    }

    pub(crate) fn release(&self, slot: u32) {
        self.holds[slot as usize].fetch_sub(1, Ordering::AcqRel);
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
