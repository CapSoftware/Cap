use serde::{Deserialize, Deserializer, Serialize, de::IgnoredAny};
use specta::Type;

use super::{TimelineConfiguration, effective_to_output, held_time_before};

/// Within this distance of a clip's end, a source instant still counts as
/// inside the clip. A marker pressed while paused sits exactly on its
/// recording segment's end, which no half-open clip range contains.
const CLIP_END_TOLERANCE: f64 = 1e-6;

/// A named point in the recording, anchored to source time so it follows its
/// footage through cuts, splits, speed changes and clip reorders. A marker
/// whose instant no clip plays is hidden, not deleted, and comes back when
/// that footage returns to the timeline.
#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMarker {
    pub id: String,
    #[serde(rename = "recordingSegment")]
    pub recording_clip: u32,
    /// Seconds from the start of the recording segment, in the same source
    /// clock as [`super::TimelineSegment::start`].
    pub time: f64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// `#rrggbb`, or `None` for the default marker colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl TimelineMarker {
    pub fn new(recording_clip: u32, time: f64) -> Self {
        Self {
            id: uuid::Uuid::new_v4().simple().to_string(),
            recording_clip,
            time: if time.is_finite() { time.max(0.0) } else { 0.0 },
            label: String::new(),
            color: None,
        }
    }
}

/// Loads `markers` leniently: one damaged entry is dropped rather than
/// failing the whole project file, which would stop the project opening.
pub(super) fn deserialize_markers<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<TimelineMarker>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Entry {
        Marker(TimelineMarker),
        Damaged(IgnoredAny),
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum List {
        Entries(Vec<Entry>),
        Damaged(IgnoredAny),
    }

    Ok(match List::deserialize(deserializer)? {
        List::Entries(entries) => entries
            .into_iter()
            .filter_map(|entry| match entry {
                Entry::Marker(marker) if marker.time.is_finite() => Some(TimelineMarker {
                    time: marker.time.max(0.0),
                    ..marker
                }),
                _ => None,
            })
            .collect(),
        List::Damaged(_) => Vec::new(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacedMarker {
    pub index: usize,
    pub time: f64,
}

struct ClipSpan {
    recording_clip: u32,
    start: f64,
    end: f64,
    timescale: f64,
    offset: f64,
}

impl TimelineConfiguration {
    fn clip_spans(&self) -> Vec<ClipSpan> {
        let mut spans = Vec::with_capacity(self.segments.len());
        let mut offset = 0.0;
        for (index, segment) in self.segments.iter().enumerate() {
            offset -= self
                .effective_transition(index)
                .map_or(0.0, |transition| transition.duration);
            spans.push(ClipSpan {
                recording_clip: segment.recording_clip,
                start: segment.start,
                end: segment.end,
                timescale: segment.timescale,
                offset,
            });
            offset += segment.duration();
        }
        spans
    }

    /// Where a source instant plays in output time: the first clip that
    /// contains it, or a clip ending exactly on it when none does. `None`
    /// when the instant was cut out.
    pub fn output_time_for_source(&self, recording_clip: u32, source_time: f64) -> Option<f64> {
        let spans = self.clip_spans();
        let holds = self.hold_windows();
        output_time_in(&spans, &holds, recording_clip, source_time)
    }

    /// The source instant playing at an output time, as `(recording clip,
    /// source seconds)`. Inside a crossfade it is the incoming clip's, inside
    /// a fullscreen text hold it is the held frame's, and at the very end it
    /// is the last clip's end.
    pub fn source_for_output_time(&self, output_time: f64) -> Option<(u32, f64)> {
        if !output_time.is_finite() {
            return None;
        }
        if let Some((source_time, segment)) = self.get_segment_time(output_time.max(0.0)) {
            return Some((segment.recording_clip, source_time));
        }
        let holds = self.hold_windows();
        let effective = output_time - held_time_before(&holds, output_time);
        if (effective - self.clips_duration()).abs() > CLIP_END_TOLERANCE {
            return None;
        }
        self.segments
            .iter()
            .rfind(|segment| segment.duration() > 0.0)
            .map(|segment| (segment.recording_clip, segment.end))
    }

    pub fn place_markers(&self, markers: &[TimelineMarker]) -> Vec<PlacedMarker> {
        if markers.is_empty() {
            return Vec::new();
        }
        let spans = self.clip_spans();
        let holds = self.hold_windows();
        let mut placed: Vec<PlacedMarker> = markers
            .iter()
            .enumerate()
            .filter_map(|(index, marker)| {
                output_time_in(&spans, &holds, marker.recording_clip, marker.time)
                    .map(|time| PlacedMarker { index, time })
            })
            .collect();
        placed.sort_by(|a, b| a.time.total_cmp(&b.time).then(a.index.cmp(&b.index)));
        placed
    }
}

fn output_time_in(
    spans: &[ClipSpan],
    holds: &[(f64, f64)],
    recording_clip: u32,
    source_time: f64,
) -> Option<f64> {
    if !source_time.is_finite() {
        return None;
    }
    let playable =
        |span: &&ClipSpan| span.recording_clip == recording_clip && span.end > span.start;
    let span = spans
        .iter()
        .filter(playable)
        .find(|span| source_time >= span.start && source_time < span.end)
        .or_else(|| {
            spans
                .iter()
                .filter(playable)
                .find(|span| (source_time - span.end).abs() <= CLIP_END_TOLERANCE)
        })?;
    let gapless = span.offset + (source_time.min(span.end) - span.start) / span.timescale;
    Some(effective_to_output(holds, gapless.max(0.0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ClipTransition, ClipTransitionType, ProjectConfiguration, TextSegment, TimelineSegment,
    };

    fn clip(recording_clip: u32, start: f64, end: f64) -> TimelineSegment {
        TimelineSegment {
            recording_clip,
            timescale: 1.0,
            start,
            end,
            ..Default::default()
        }
    }

    fn timeline(segments: Vec<TimelineSegment>) -> TimelineConfiguration {
        let mut config: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": [],
            "zoomSegments": [],
        }))
        .unwrap();
        config.segments = segments;
        config
    }

    fn marker(recording_clip: u32, time: f64) -> TimelineMarker {
        TimelineMarker {
            id: format!("{recording_clip}-{time}"),
            ..TimelineMarker::new(recording_clip, time)
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn an_unedited_recording_places_markers_at_their_source_time() {
        let timeline = timeline(vec![clip(0, 0.0, 10.0)]);
        assert_eq!(timeline.output_time_for_source(0, 3.25), Some(3.25));
        assert_eq!(timeline.output_time_for_source(0, 0.0), Some(0.0));
        assert_eq!(timeline.output_time_for_source(1, 3.0), None);
    }

    #[test]
    fn multi_segment_recordings_lay_segments_end_to_end() {
        let timeline = timeline(vec![clip(0, 0.0, 4.0), clip(1, 0.0, 6.0)]);
        assert_eq!(timeline.output_time_for_source(1, 2.0), Some(6.0));
        assert_eq!(timeline.output_time_for_source(0, 4.0), Some(4.0));
    }

    #[test]
    fn a_marker_on_a_pause_point_sits_on_the_boundary() {
        let timeline = timeline(vec![clip(0, 0.0, 4.0), clip(1, 0.0, 6.0)]);
        let placed = timeline.place_markers(&[marker(0, 4.0), marker(1, 0.0)]);
        assert_eq!(placed.len(), 2);
        assert!(placed.iter().all(|placed| close(placed.time, 4.0)));
    }

    #[test]
    fn cut_footage_hides_its_markers() {
        let timeline = timeline(vec![clip(0, 0.0, 2.0), clip(0, 5.0, 10.0)]);
        assert_eq!(timeline.output_time_for_source(0, 3.0), None);
        assert_eq!(timeline.output_time_for_source(0, 6.0), Some(3.0));
        let placed = timeline.place_markers(&[marker(0, 3.0), marker(0, 6.0)]);
        assert_eq!(
            placed,
            vec![PlacedMarker {
                index: 1,
                time: 3.0
            }]
        );
    }

    #[test]
    fn a_split_keeps_every_marker_where_it_was() {
        let markers = [marker(0, 1.0), marker(0, 5.0), marker(0, 9.0)];
        let whole = timeline(vec![clip(0, 0.0, 10.0)]).place_markers(&markers);
        let split = timeline(vec![clip(0, 0.0, 5.0), clip(0, 5.0, 10.0)]).place_markers(&markers);
        assert_eq!(whole, split);
    }

    #[test]
    fn reordered_clips_carry_their_markers() {
        let timeline = timeline(vec![clip(0, 5.0, 10.0), clip(0, 0.0, 5.0)]);
        assert_eq!(timeline.output_time_for_source(0, 1.0), Some(6.0));
        assert_eq!(timeline.output_time_for_source(0, 7.0), Some(2.0));
    }

    #[test]
    fn speed_changes_scale_marker_positions() {
        let mut fast = clip(0, 0.0, 10.0);
        fast.timescale = 2.0;
        let timeline = timeline(vec![clip(1, 0.0, 3.0), fast]);
        assert_eq!(timeline.output_time_for_source(0, 4.0), Some(5.0));
    }

    #[test]
    fn crossfades_overlap_the_clips_they_join() {
        let mut timeline = timeline(vec![clip(0, 0.0, 10.0), clip(1, 0.0, 10.0)]);
        timeline.transitions = vec![ClipTransition {
            segment_index: 1,
            kind: ClipTransitionType::CrossFade,
            duration: 1.0,
        }];
        assert_eq!(timeline.output_time_for_source(1, 0.0), Some(9.0));
        assert_eq!(timeline.output_time_for_source(1, 2.0), Some(11.0));
        let (clip_index, source) = timeline.source_for_output_time(9.5).unwrap();
        assert_eq!(clip_index, 1);
        assert!(close(source, 0.5));
    }

    #[test]
    fn fullscreen_text_holds_push_later_markers_out() {
        let mut timeline = timeline(vec![clip(0, 0.0, 10.0)]);
        let text: TextSegment = serde_json::from_value(serde_json::json!({
            "start": 2.0,
            "end": 5.0,
            "layout": "fullscreen",
        }))
        .unwrap();
        assert!(text.enabled);
        timeline.text_segments = vec![text];
        assert_eq!(timeline.output_time_for_source(0, 1.0), Some(1.0));
        assert_eq!(timeline.output_time_for_source(0, 4.0), Some(7.0));
        let (_, source) = timeline.source_for_output_time(7.0).unwrap();
        assert!(close(source, 4.0));
    }

    #[test]
    fn output_and_source_round_trip_away_from_holds() {
        let mut fast = clip(1, 2.0, 8.0);
        fast.timescale = 1.5;
        let timeline = timeline(vec![clip(0, 3.0, 9.0), fast, clip(0, 0.0, 3.0)]);
        let total = timeline.duration();
        let mut time = 0.0;
        while time < total {
            let (recording_clip, source) = timeline.source_for_output_time(time).unwrap();
            let back = timeline
                .output_time_for_source(recording_clip, source)
                .unwrap();
            assert!(close(back, time), "{time} -> {back}");
            time += 0.37;
        }
    }

    #[test]
    fn the_timeline_end_maps_to_the_last_clip_end() {
        let timeline = timeline(vec![clip(0, 0.0, 4.0), clip(1, 1.0, 3.0)]);
        assert_eq!(timeline.source_for_output_time(6.0), Some((1, 3.0)));
        assert_eq!(timeline.source_for_output_time(6.5), None);
        assert_eq!(timeline.source_for_output_time(f64::NAN), None);
    }

    #[test]
    fn long_recordings_keep_sub_frame_precision() {
        let timeline = timeline(vec![clip(0, 0.0, 3.0 * 3600.0), clip(1, 0.0, 3600.0)]);
        let source = 3600.0 * 2.0 + 59.0 * 60.0 + 59.983333;
        let output = timeline.output_time_for_source(0, source).unwrap();
        assert!((output - source).abs() < 1e-9);
        let late = timeline.output_time_for_source(1, 1799.016666).unwrap();
        assert!((late - (3.0 * 3600.0 + 1799.016666)).abs() < 1e-9);
    }

    #[test]
    fn zero_length_clips_and_empty_timelines_place_nothing() {
        let empty = timeline(Vec::new());
        assert!(empty.place_markers(&[marker(0, 0.0)]).is_empty());
        assert_eq!(empty.source_for_output_time(0.0), None);
        let zero = timeline(vec![clip(0, 2.0, 2.0)]);
        assert_eq!(zero.output_time_for_source(0, 2.0), None);
    }

    #[test]
    fn markers_sort_by_output_time_then_list_order() {
        let timeline = timeline(vec![clip(1, 0.0, 5.0), clip(0, 0.0, 5.0)]);
        let placed = timeline.place_markers(&[marker(0, 1.0), marker(1, 1.0), marker(1, 1.0)]);
        assert_eq!(
            placed.iter().map(|placed| placed.index).collect::<Vec<_>>(),
            vec![1, 2, 0]
        );
    }

    #[test]
    fn projects_without_markers_load_and_save_unchanged() {
        let config: ProjectConfiguration = serde_json::from_str("{}").unwrap();
        assert!(config.markers.is_empty());
        let saved = serde_json::to_value(&config).unwrap();
        assert!(saved.get("markers").is_none());
    }

    #[test]
    fn markers_round_trip_through_the_project_file() {
        let config = ProjectConfiguration {
            markers: vec![TimelineMarker {
                id: "a".into(),
                recording_clip: 2,
                time: 1.5,
                label: "Intro".into(),
                color: Some("#ff8800".into()),
            }],
            ..Default::default()
        };
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(
            json["markers"],
            serde_json::json!([{
                "id": "a",
                "recordingSegment": 2,
                "time": 1.5,
                "label": "Intro",
                "color": "#ff8800",
            }])
        );
        let back: ProjectConfiguration = serde_json::from_value(json).unwrap();
        assert_eq!(back.markers, config.markers);
    }

    #[test]
    fn damaged_markers_never_stop_a_project_loading() {
        let config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "markers": [
                { "id": "ok", "recordingSegment": 0, "time": 2.0 },
                { "id": "no-time", "recordingSegment": 0 },
                "garbage",
                { "id": "negative", "recordingSegment": 1, "time": -4.0 },
            ],
        }))
        .unwrap();
        assert_eq!(
            config
                .markers
                .iter()
                .map(|marker| (marker.id.as_str(), marker.time))
                .collect::<Vec<_>>(),
            vec![("ok", 2.0), ("negative", 0.0)]
        );
        let config: ProjectConfiguration =
            serde_json::from_value(serde_json::json!({ "markers": { "not": "a list" } })).unwrap();
        assert!(config.markers.is_empty());
    }

    #[test]
    fn presets_never_carry_or_replace_markers() {
        let current = ProjectConfiguration {
            markers: vec![marker(0, 1.0)],
            ..Default::default()
        };
        let preset = ProjectConfiguration {
            markers: vec![marker(3, 9.0)],
            ..Default::default()
        };
        assert_eq!(current.with_preset(preset).markers, current.markers);
    }
}
