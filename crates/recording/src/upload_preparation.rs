use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

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
        self.acknowledged.extend(
            prepared
                .iter()
                .filter(|segment| requested.contains(segment))
                .copied(),
        );
    }

    pub fn exhausted(&self) -> bool {
        self.attempts
            .iter()
            .any(|(segment, attempts)| *attempts >= 2 && !self.acknowledged.contains(segment))
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
        assert!(!preparation.exhausted());
        let retry = preparation.next_batch([1, 2, 99], [1]);
        assert_eq!(retry.len(), 3);
        assert!(preparation.exhausted());
        preparation.acknowledge(&retry, &retry);
        assert!(!preparation.exhausted());
        assert!(preparation.next_batch([1, 2, 99], [1]).is_empty());
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
