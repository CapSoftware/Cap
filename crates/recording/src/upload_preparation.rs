use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    Video,
    Audio,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Segment {
    pub track: Track,
    pub index: u32,
}

#[derive(Default)]
pub struct Preparation {
    attempts: BTreeMap<Segment, u8>,
    acknowledged: BTreeSet<Segment>,
    consecutive_failures: u32,
}

impl Preparation {
    pub fn next_batch(
        &mut self,
        video: impl IntoIterator<Item = u32>,
        audio: impl IntoIterator<Item = u32>,
    ) -> Vec<Segment> {
        let mut available: Vec<_> = video
            .into_iter()
            .map(|index| Segment {
                track: Track::Video,
                index,
            })
            .chain(audio.into_iter().map(|index| Segment {
                track: Track::Audio,
                index,
            }))
            .filter(|segment| {
                (1..=50_000).contains(&segment.index)
                    && !self.acknowledged.contains(segment)
                    && self.attempts.get(segment).copied().unwrap_or(0) < 2
            })
            .collect();
        available.sort_by_key(|segment| (segment.index, segment.track));
        available.truncate(32);
        for segment in &available {
            *self.attempts.entry(*segment).or_default() += 1;
        }
        available
    }

    pub fn acknowledge(&mut self, requested: &[Segment], prepared: &[Segment]) {
        let before = self.acknowledged.len();
        self.acknowledged.extend(
            prepared
                .iter()
                .filter(|segment| requested.contains(segment))
                .copied(),
        );
        if self.acknowledged.len() > before {
            self.consecutive_failures = 0;
        } else {
            self.request_failed();
        }
    }

    pub fn request_failed(&mut self) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
    }

    pub fn retry_delay(&self) -> Duration {
        if self.consecutive_failures == 0 {
            return Duration::ZERO;
        }
        Duration::from_secs((30u64 << self.consecutive_failures.min(4)).min(300))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_only_uploaded_fragments_with_equal_track_priority() {
        let batch = Preparation::default().next_batch((1..=40).filter(|index| *index != 3), 1..=40);
        assert_eq!(batch.len(), 32);
        assert!(batch.contains(&Segment {
            track: Track::Audio,
            index: 3
        }));
        assert!(!batch.contains(&Segment {
            track: Track::Video,
            index: 3
        }));
        assert!(
            batch
                .iter()
                .filter(|item| item.track == Track::Video)
                .count()
                >= 15
        );
        assert!(
            Preparation::default()
                .next_batch([0, 50_001], [])
                .is_empty()
        );
    }

    #[test]
    fn bounds_lost_responses_and_does_not_repeat_acknowledged_fragments() {
        let mut preparation = Preparation::default();
        let batch = preparation.next_batch([1, 2], [1]);
        preparation.acknowledge(
            &batch,
            &[
                Segment {
                    track: Track::Audio,
                    index: 1,
                },
                Segment {
                    track: Track::Video,
                    index: 99,
                },
            ],
        );
        let retry = preparation.next_batch([1, 2, 99], [1]);
        assert_eq!(retry.len(), 3);
        preparation.acknowledge(&retry, &retry);
        assert!(preparation.next_batch([1, 2, 99], [1]).is_empty());
    }

    #[test]
    fn an_exhausted_fragment_does_not_disable_later_uploads() {
        let mut preparation = Preparation::default();
        assert_eq!(preparation.next_batch([1], []).len(), 1);
        assert_eq!(preparation.next_batch([1], []).len(), 1);
        assert_eq!(
            preparation.next_batch([1, 2], []),
            vec![Segment {
                track: Track::Video,
                index: 2
            }]
        );
    }

    #[test]
    fn backs_off_outages_and_resets_after_real_progress() {
        let mut preparation = Preparation::default();
        let batch = preparation.next_batch([1], []);
        preparation.acknowledge(&batch, &[]);
        assert_eq!(preparation.retry_delay(), Duration::from_secs(60));
        preparation.request_failed();
        assert_eq!(preparation.retry_delay(), Duration::from_secs(120));
        for _ in 0..10 {
            preparation.request_failed();
        }
        assert_eq!(preparation.retry_delay(), Duration::from_secs(300));
        preparation.acknowledge(&batch, &batch);
        assert_eq!(preparation.retry_delay(), Duration::ZERO);
    }

    #[test]
    fn preserves_wire_format_without_initialization_fragments() {
        let batch = Preparation::default().next_batch([0, 1], []);
        assert_eq!(
            serde_json::to_value(batch).unwrap(),
            serde_json::json!([{"track": "video", "index": 1}])
        );
    }
}
