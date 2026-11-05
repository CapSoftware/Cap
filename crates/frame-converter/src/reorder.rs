use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

pub struct SequenceReorderBuffer<T> {
    next_sequence: u64,
    pending: BTreeMap<u64, T>,
    max_pending: usize,
    gap_timeout: Duration,
    blocked_since: Option<Instant>,
    skipped: u64,
    discarded: u64,
}

impl<T> SequenceReorderBuffer<T> {
    pub fn new(max_pending: usize, gap_timeout: Duration) -> Self {
        Self {
            next_sequence: 0,
            pending: BTreeMap::new(),
            max_pending: max_pending.max(1),
            gap_timeout,
            blocked_since: None,
            skipped: 0,
            discarded: 0,
        }
    }

    pub fn push(&mut self, sequence: u64, item: T) -> bool {
        if sequence < self.next_sequence || self.pending.contains_key(&sequence) {
            self.discarded += 1;
            return false;
        }
        self.pending.insert(sequence, item);
        true
    }

    pub fn pop_ready(&mut self, now: Instant) -> Option<T> {
        if let Some(item) = self.pending.remove(&self.next_sequence) {
            self.next_sequence = self.next_sequence.saturating_add(1);
            self.blocked_since = None;
            return Some(item);
        }

        if self.pending.is_empty() {
            self.blocked_since = None;
            return None;
        }

        let blocked_since = *self.blocked_since.get_or_insert(now);
        if self.pending.len() > self.max_pending
            || now.saturating_duration_since(blocked_since) >= self.gap_timeout
        {
            return self.pop_next_available();
        }

        None
    }

    pub fn pop_next_available(&mut self) -> Option<T> {
        let (sequence, item) = self.pending.pop_first()?;
        self.skipped += sequence.saturating_sub(self.next_sequence);
        self.next_sequence = sequence.saturating_add(1);
        self.blocked_since = None;
        Some(item)
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn skipped(&self) -> u64 {
        self.skipped
    }

    pub fn discarded(&self) -> u64 {
        self.discarded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_millis(250);
    const JUST_UNDER_TIMEOUT: Duration = Duration::from_millis(249);

    fn buffer(max_pending: usize) -> SequenceReorderBuffer<u64> {
        SequenceReorderBuffer::new(max_pending, TIMEOUT)
    }

    fn drain_ready(buffer: &mut SequenceReorderBuffer<u64>, now: Instant) -> Vec<u64> {
        std::iter::from_fn(|| buffer.pop_ready(now)).collect()
    }

    #[test]
    fn in_order_frames_are_released_immediately_and_keep_advancing() {
        let now = Instant::now();
        let mut buffer = buffer(8);

        let mut released = Vec::new();
        for sequence in 0..50 {
            buffer.push(sequence, sequence);
            released.extend(drain_ready(&mut buffer, now));
        }

        assert_eq!(released, (0..50).collect::<Vec<_>>());
        assert!(buffer.is_empty());
        assert_eq!(buffer.skipped(), 0);
        assert_eq!(buffer.discarded(), 0);
    }

    #[test]
    fn out_of_order_arrival_is_released_in_sequence_order() {
        let now = Instant::now();
        let mut buffer = buffer(8);

        buffer.push(2, 2);
        assert_eq!(drain_ready(&mut buffer, now), Vec::<u64>::new());

        buffer.push(0, 0);
        assert_eq!(drain_ready(&mut buffer, now), vec![0]);

        buffer.push(1, 1);
        assert_eq!(drain_ready(&mut buffer, now), vec![1, 2]);

        buffer.push(4, 4);
        buffer.push(3, 3);
        buffer.push(5, 5);
        assert_eq!(drain_ready(&mut buffer, now), vec![3, 4, 5]);
        assert!(buffer.is_empty());
        assert_eq!(buffer.skipped(), 0);
    }

    #[test]
    fn missing_frame_blocks_until_the_gap_timeout_then_is_skipped() {
        let start = Instant::now();
        let mut buffer = buffer(8);

        buffer.push(0, 0);
        buffer.push(2, 2);
        buffer.push(3, 3);

        assert_eq!(drain_ready(&mut buffer, start), vec![0]);
        assert_eq!(
            drain_ready(&mut buffer, start + JUST_UNDER_TIMEOUT),
            Vec::<u64>::new()
        );
        assert_eq!(drain_ready(&mut buffer, start + TIMEOUT), vec![2, 3]);
        assert_eq!(buffer.skipped(), 1);
        assert!(buffer.is_empty());
    }

    #[test]
    fn frames_after_a_skipped_gap_keep_flowing_without_waiting() {
        let start = Instant::now();
        let mut buffer = buffer(8);

        buffer.push(1, 1);
        assert_eq!(drain_ready(&mut buffer, start), Vec::<u64>::new());
        assert_eq!(drain_ready(&mut buffer, start + TIMEOUT), vec![1]);

        let later = start + TIMEOUT;
        buffer.push(2, 2);
        buffer.push(3, 3);
        assert_eq!(drain_ready(&mut buffer, later), vec![2, 3]);
        assert_eq!(buffer.skipped(), 1);
    }

    #[test]
    fn gap_timer_restarts_after_progress() {
        let start = Instant::now();
        let mut buffer = buffer(8);

        buffer.push(0, 0);
        buffer.push(2, 2);
        assert_eq!(drain_ready(&mut buffer, start), vec![0]);

        let later = start + Duration::from_millis(240);
        buffer.push(1, 1);
        assert_eq!(drain_ready(&mut buffer, later), vec![1, 2]);

        buffer.push(4, 4);
        assert_eq!(drain_ready(&mut buffer, later), Vec::<u64>::new());
        assert_eq!(
            drain_ready(&mut buffer, later + JUST_UNDER_TIMEOUT),
            Vec::<u64>::new()
        );
        assert_eq!(drain_ready(&mut buffer, later + TIMEOUT), vec![4]);
        assert_eq!(buffer.skipped(), 1);
    }

    #[test]
    fn too_many_pending_frames_skip_the_gap_without_waiting_for_the_timeout() {
        let now = Instant::now();
        let mut buffer = buffer(3);

        for sequence in 2..=4 {
            buffer.push(sequence, sequence);
        }
        assert_eq!(drain_ready(&mut buffer, now), Vec::<u64>::new());
        assert_eq!(buffer.len(), 3);

        buffer.push(5, 5);
        assert_eq!(drain_ready(&mut buffer, now), vec![2, 3, 4, 5]);
        assert_eq!(buffer.skipped(), 2);
        assert!(buffer.is_empty());
    }

    #[test]
    fn frames_arriving_after_their_gap_was_skipped_are_discarded() {
        let start = Instant::now();
        let mut buffer = buffer(8);

        buffer.push(1, 1);
        assert_eq!(drain_ready(&mut buffer, start + TIMEOUT), Vec::<u64>::new());
        assert_eq!(drain_ready(&mut buffer, start + TIMEOUT * 2), vec![1]);

        assert!(!buffer.push(0, 0));
        assert!(!buffer.push(1, 1));
        assert_eq!(buffer.discarded(), 2);
        assert!(buffer.is_empty());

        assert!(buffer.push(2, 2));
        assert_eq!(drain_ready(&mut buffer, start + TIMEOUT * 2), vec![2]);
    }

    #[test]
    fn duplicate_pending_sequence_is_rejected() {
        let mut buffer = buffer(8);

        assert!(buffer.push(3, 3));
        assert!(!buffer.push(3, 30));
        assert_eq!(buffer.len(), 1);
        assert_eq!(buffer.discarded(), 1);
        assert_eq!(buffer.pop_next_available(), Some(3));
    }

    #[test]
    fn flush_releases_everything_in_order_across_gaps() {
        let now = Instant::now();
        let mut buffer = buffer(16);

        for sequence in [6, 2, 3, 9, 0] {
            buffer.push(sequence, sequence);
        }
        assert_eq!(drain_ready(&mut buffer, now), vec![0]);

        let mut flushed = Vec::new();
        while let Some(item) = buffer.pop_next_available() {
            flushed.push(item);
        }

        assert_eq!(flushed, vec![2, 3, 6, 9]);
        assert!(buffer.is_empty());
        assert_eq!(buffer.skipped(), 1 + 2 + 2);
        assert_eq!(buffer.pop_next_available(), None);
    }

    #[test]
    fn lost_first_frame_does_not_stall_the_stream() {
        let start = Instant::now();
        let mut buffer = buffer(8);

        for sequence in 1..=5 {
            buffer.push(sequence, sequence);
        }

        assert_eq!(drain_ready(&mut buffer, start), Vec::<u64>::new());
        assert_eq!(
            drain_ready(&mut buffer, start + TIMEOUT),
            vec![1, 2, 3, 4, 5]
        );
        assert_eq!(buffer.skipped(), 1);
    }

    #[test]
    fn failed_conversions_scattered_through_a_long_stream_never_stall_it() {
        let start = Instant::now();
        let mut buffer = buffer(16);
        let mut clock = start;
        let mut released = Vec::new();

        for sequence in 0..300u64 {
            if sequence % 7 == 3 {
                continue;
            }
            buffer.push(sequence, sequence);
            clock += Duration::from_millis(33);
            released.extend(drain_ready(&mut buffer, clock));
        }
        clock += TIMEOUT;
        released.extend(drain_ready(&mut buffer, clock));
        while let Some(item) = buffer.pop_next_available() {
            released.push(item);
        }

        let expected: Vec<u64> = (0..300).filter(|sequence| sequence % 7 != 3).collect();
        assert_eq!(released, expected);
        assert_eq!(buffer.skipped(), 300 - expected.len() as u64);
    }
}
