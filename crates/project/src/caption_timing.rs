use crate::caption_words::{MAX_CAPTION_WORD_DURATION, caption_text_from_words};
use crate::{
    CaptionSegment, CaptionTrackSegment, CaptionWord, LockableTimelineTrack, ProjectConfiguration,
    TimelineConfiguration,
};
use std::collections::{HashMap, HashSet};

pub(crate) fn clip_timeline_offsets(timeline: &TimelineConfiguration) -> Vec<f64> {
    let mut offset = 0.0;
    timeline
        .segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            offset -= timeline
                .effective_transition(index)
                .map_or(0.0, |transition| transition.duration);
            let start = offset;
            offset += segment.duration();
            start
        })
        .collect()
}

const CAPTION_EDL_SEPARATOR: &str = "::edl";

pub fn source_caption_id(track_id: &str) -> &str {
    track_id
        .find(CAPTION_EDL_SEPARATOR)
        .map_or(track_id, |index| &track_id[..index])
}

fn mapped_caption_segment_id(base_id: &str, index: usize, total: usize) -> String {
    if total == 1 {
        base_id.to_string()
    } else {
        format!("{base_id}{CAPTION_EDL_SEPARATOR}{index}")
    }
}

fn clamp_caption_segment_words(segment: &CaptionSegment) -> CaptionSegment {
    if segment.words.is_empty() {
        return segment.clone();
    }

    let clamped_words: Vec<CaptionWord> = segment
        .words
        .iter()
        .map(|word| CaptionWord {
            text: word.text.clone(),
            start: word.start,
            end: word.end.min(word.start + MAX_CAPTION_WORD_DURATION),
        })
        .collect();

    let last_word_end = clamped_words.last().map_or(segment.end, |word| word.end);

    CaptionSegment {
        id: segment.id.clone(),
        start: segment.start,
        end: segment.end.min(last_word_end),
        text: segment.text.clone(),
        words: clamped_words,
    }
}

struct SourceToEditedMapping {
    source_start: f64,
    source_end: f64,
    edited_start: f64,
    timescale: f64,
}

fn build_source_to_edited_mappings(
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
) -> Vec<SourceToEditedMapping> {
    let mut recording_offsets = Vec::with_capacity(recording_durations.len());
    let mut cumulative = 0.0;
    for duration in recording_durations {
        recording_offsets.push(cumulative);
        cumulative += duration;
    }

    let edited_offsets = clip_timeline_offsets(timeline);

    timeline
        .segments
        .iter()
        .zip(edited_offsets)
        .map(|(segment, edited_start)| {
            let recording_offset = recording_offsets
                .get(segment.recording_clip as usize)
                .copied()
                .unwrap_or(0.0);
            SourceToEditedMapping {
                source_start: recording_offset + segment.start,
                source_end: recording_offset + segment.end,
                edited_start,
                timescale: segment.timescale,
            }
        })
        .collect()
}

pub fn transcription_source_ranges(
    timeline: Option<&TimelineConfiguration>,
    recording_durations: &[f64],
) -> Vec<std::ops::Range<f64>> {
    let Some(timeline) = timeline else {
        let duration = recording_durations.iter().sum();
        return if duration > 0.0 {
            vec![0.0..duration]
        } else {
            Vec::new()
        };
    };
    let mut ranges: Vec<_> = build_source_to_edited_mappings(timeline, recording_durations)
        .into_iter()
        .zip(&timeline.segments)
        .filter_map(|(mapping, segment)| {
            let duration = *recording_durations.get(segment.recording_clip as usize)?;
            let offset = mapping.source_start - segment.start;
            let start = segment.start.max(0.0);
            let end = segment.end.min(duration);
            (start < end).then_some(offset + start..offset + end)
        })
        .collect();
    ranges.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<std::ops::Range<f64>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

pub fn transcription_ranges_cover(
    transcribed: &[std::ops::Range<f64>],
    required: &[std::ops::Range<f64>],
) -> bool {
    required.iter().all(|range| {
        transcribed
            .iter()
            .any(|source| source.start <= range.start && source.end >= range.end)
    })
}

fn map_time_range_within_mapping(
    start: f64,
    end: f64,
    mapping: &SourceToEditedMapping,
) -> Option<(f64, f64)> {
    let overlap_start = start.max(mapping.source_start);
    let overlap_end = end.min(mapping.source_end);
    if overlap_start >= overlap_end {
        return None;
    }
    Some((
        mapping.edited_start + (overlap_start - mapping.source_start) / mapping.timescale,
        mapping.edited_start + (overlap_end - mapping.source_start) / mapping.timescale,
    ))
}

fn effective_to_output(holds: &[(f64, f64)], effective: f64) -> f64 {
    let mut output = effective;
    for (start, end) in holds {
        if output >= *start {
            output += end - start;
        } else {
            break;
        }
    }
    output
}

fn effective_to_output_end(holds: &[(f64, f64)], effective: f64) -> f64 {
    let mut output = effective;
    for (start, end) in holds {
        if output > *start {
            output += end - start;
        } else {
            break;
        }
    }
    output
}

struct MappedCaption {
    id: String,
    start: f64,
    end: f64,
    text: String,
    words: Vec<CaptionWord>,
}

fn map_captions_to_edited_timeline(
    raw_segments: &[CaptionSegment],
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
) -> Vec<MappedCaption> {
    if timeline.segments.is_empty() || recording_durations.is_empty() {
        return raw_segments
            .iter()
            .map(clamp_caption_segment_words)
            .map(|segment| MappedCaption {
                id: segment.id,
                start: f64::from(segment.start),
                end: f64::from(segment.end),
                text: segment.text,
                words: segment.words,
            })
            .collect();
    }

    let mappings = build_source_to_edited_mappings(timeline, recording_durations);
    let mappings_ordered = mappings
        .iter()
        .all(|mapping| mapping.source_start.is_finite() && mapping.source_end.is_finite())
        && mappings.windows(2).all(|pair| {
            pair[0].source_start <= pair[1].source_start && pair[0].source_end <= pair[1].source_end
        });
    let holds = timeline.hold_windows();
    let hold_adjusted = |start: f64, end: f64| {
        if holds.is_empty() {
            (start, end)
        } else {
            (
                effective_to_output(&holds, start),
                effective_to_output_end(&holds, end),
            )
        }
    };

    let mut result = Vec::new();

    for caption in raw_segments {
        let mut mapped_caption_segments: Vec<MappedCaption> = Vec::new();
        let word_bounds = if caption.words.is_empty() {
            None
        } else {
            caption.words.iter().try_fold(
                (f64::INFINITY, f64::NEG_INFINITY),
                |(start, end), word| {
                    let word_start = f64::from(word.start);
                    let word_end = f64::from(word.end.min(word.start + MAX_CAPTION_WORD_DURATION));
                    if word_start.is_nan() || word_end.is_nan() {
                        None
                    } else {
                        Some((start.min(word_start), end.max(word_end)))
                    }
                },
            )
        };

        let bounds = if caption.words.is_empty() {
            Some((f64::from(caption.start), f64::from(caption.end)))
        } else {
            word_bounds
        };
        let caption_mappings = match bounds {
            Some((start, end)) if mappings_ordered && start.is_finite() && end.is_finite() => {
                let first = mappings.partition_point(|mapping| mapping.source_end <= start);
                let count = mappings[first..].partition_point(|mapping| mapping.source_start < end);
                &mappings[first..first + count]
            }
            _ => &mappings,
        };

        for mapping in caption_mappings {
            if !caption.words.is_empty() {
                if let Some((word_start, word_end)) = word_bounds
                    && (word_end <= mapping.source_start || word_start >= mapping.source_end)
                {
                    continue;
                }

                let mut mapped_words = Vec::new();
                for word in &caption.words {
                    let Some((start, end)) = map_time_range_within_mapping(
                        f64::from(word.start),
                        f64::from(word.end.min(word.start + MAX_CAPTION_WORD_DURATION)),
                        mapping,
                    ) else {
                        continue;
                    };
                    let (start, end) = hold_adjusted(start, end);
                    mapped_words.push(CaptionWord {
                        text: word.text.clone(),
                        start: start as f32,
                        end: end as f32,
                    });
                }

                if mapped_words.is_empty() {
                    continue;
                }

                let start = mapped_words
                    .first()
                    .map_or(f64::from(caption.start), |word| f64::from(word.start));
                let end = mapped_words
                    .last()
                    .map_or(f64::from(caption.end), |word| f64::from(word.end));
                mapped_caption_segments.push(MappedCaption {
                    id: caption.id.clone(),
                    start,
                    end,
                    text: caption_text_from_words(&mapped_words),
                    words: mapped_words,
                });
            } else {
                let Some((start, end)) = map_time_range_within_mapping(
                    f64::from(caption.start),
                    f64::from(caption.end),
                    mapping,
                ) else {
                    continue;
                };
                let (start, end) = hold_adjusted(start, end);
                mapped_caption_segments.push(MappedCaption {
                    id: caption.id.clone(),
                    start,
                    end,
                    text: caption.text.clone(),
                    words: Vec::new(),
                });
            }
        }

        let total = mapped_caption_segments.len();
        for (index, mut segment) in mapped_caption_segments.into_iter().enumerate() {
            segment.id = mapped_caption_segment_id(&caption.id, index, total);
            result.push(segment);
        }
    }

    result
}

pub fn derive_caption_track_segments(
    source_segments: &[CaptionSegment],
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
) -> Vec<CaptionTrackSegment> {
    let mut overrides_by_source_id = HashMap::new();
    for segment in &timeline.caption_segments {
        overrides_by_source_id
            .entry(source_caption_id(&segment.id))
            .or_insert(segment);
    }

    let mut mapped =
        map_captions_to_edited_timeline(source_segments, timeline, recording_durations);
    mapped.sort_by(|a, b| a.start.total_cmp(&b.start));

    mapped
        .into_iter()
        .map(|segment| {
            let overrides = overrides_by_source_id.get(source_caption_id(&segment.id));
            CaptionTrackSegment {
                id: segment.id,
                start: segment.start,
                end: segment.end,
                text: segment.text,
                words: segment.words,
                fade_duration_override: overrides.and_then(|o| o.fade_duration_override),
                linger_duration_override: overrides.and_then(|o| o.linger_duration_override),
                position_override: overrides.and_then(|o| o.position_override.clone()),
                color_override: overrides.and_then(|o| o.color_override.clone()),
                background_color_override: overrides
                    .and_then(|o| o.background_color_override.clone()),
                font_size_override: overrides.and_then(|o| o.font_size_override),
            }
        })
        .collect()
}

pub fn synchronize_captions(project: &mut ProjectConfiguration, recording_durations: &[f64]) {
    let locked = project
        .locked_tracks
        .contains(&LockableTimelineTrack::Caption);
    let (Some(captions), Some(timeline)) = (&mut project.captions, &mut project.timeline) else {
        return;
    };
    if recording_durations.is_empty() || timeline.segments.is_empty() {
        return;
    }
    if !captions.source_timed {
        let holds = timeline.hold_windows();
        let mappings = build_source_to_edited_mappings(timeline, recording_durations);
        let output_end = timeline.duration() as f32;
        let to_source = |output: f32| -> Option<f32> {
            if output == output_end {
                return mappings.last().map(|mapping| mapping.source_end as f32);
            }
            let output = f64::from(output);
            let effective = output
                - holds
                    .iter()
                    .map(|(start, end)| (output.min(*end) - start).max(0.0))
                    .sum::<f64>();
            mappings.iter().rev().find_map(|mapping| {
                let end = mapping.edited_start
                    + (mapping.source_end - mapping.source_start) / mapping.timescale;
                (effective >= mapping.edited_start && effective <= end).then_some({
                    (mapping.source_start + (effective - mapping.edited_start) * mapping.timescale)
                        as f32
                })
            })
        };
        captions.segments = captions
            .segments
            .iter()
            .filter_map(|caption| {
                let start = to_source(caption.start)?;
                let end = to_source(caption.end)?;
                let words = caption
                    .words
                    .iter()
                    .filter_map(|word| {
                        Some(CaptionWord {
                            text: word.text.clone(),
                            start: to_source(word.start)?,
                            end: to_source(word.end)?,
                        })
                    })
                    .collect();
                Some(CaptionSegment {
                    id: caption.id.clone(),
                    start,
                    end,
                    text: caption.text.clone(),
                    words,
                })
            })
            .collect();
        captions
            .segments
            .sort_by(|a, b| a.start.total_cmp(&b.start));
        captions.source_timed = true;
    }
    let derived = derive_caption_track_segments(&captions.segments, timeline, recording_durations);
    timeline.caption_segments = if locked {
        keep_locked_caption_positions(&timeline.caption_segments, derived, &captions.segments)
    } else {
        derived
    };
}

fn keep_locked_caption_positions(
    current: &[CaptionTrackSegment],
    derived: Vec<CaptionTrackSegment>,
    sources: &[CaptionSegment],
) -> Vec<CaptionTrackSegment> {
    let source_ids = sources
        .iter()
        .map(|source| source.id.as_str())
        .collect::<HashSet<_>>();
    let locked = current
        .iter()
        .filter(|segment| source_ids.contains(source_caption_id(&segment.id)))
        .collect::<Vec<_>>();
    let fresh_for = locked_part_sources(&locked, &derived);
    let mut kept = locked
        .iter()
        .zip(&fresh_for)
        .map(|(segment, fresh)| locked_caption_content(segment, fresh.map(|index| &derived[index])))
        .collect::<Vec<_>>();
    let placed = kept
        .iter()
        .map(|segment| source_caption_id(&segment.id).to_string())
        .collect::<HashSet<_>>();
    kept.extend(
        derived
            .into_iter()
            .filter(|segment| !placed.contains(source_caption_id(&segment.id))),
    );
    kept.sort_by(|a, b| a.start.total_cmp(&b.start));
    kept
}

fn word_texts(segment: &CaptionTrackSegment) -> Vec<&str> {
    segment
        .words
        .iter()
        .map(|word| word.text.as_str())
        .collect()
}

// A caption cut by the edit list is split into parts numbered in timeline
// order, and those numbers shift when clips are reordered or deleted, so the
// id cannot say which stretch of speech a locked part holds. The track keeps
// no source times either, so a locked part is paired with the fresh part
// carrying exactly its words. Only when none of a caption's parts match (its
// text was rewritten) and the part counts agree are they paired in order; a
// locked part left unpaired keeps its own words rather than borrow a
// neighbour's.
fn locked_part_sources(
    locked: &[&CaptionTrackSegment],
    derived: &[CaptionTrackSegment],
) -> Vec<Option<usize>> {
    let mut pairs = vec![None; locked.len()];
    let mut used = vec![false; derived.len()];
    for (slot, part) in locked.iter().enumerate() {
        let source = source_caption_id(&part.id);
        let words = word_texts(part);
        pairs[slot] = derived
            .iter()
            .enumerate()
            .filter(|(index, fresh)| {
                !used[*index]
                    && source_caption_id(&fresh.id) == source
                    && word_texts(fresh) == words
            })
            .max_by_key(|(_, fresh)| fresh.id == part.id)
            .map(|(index, _)| index);
        if let Some(index) = pairs[slot] {
            used[index] = true;
        }
    }
    let mut sources = locked
        .iter()
        .map(|part| source_caption_id(&part.id))
        .collect::<Vec<_>>();
    sources.sort_unstable();
    sources.dedup();
    for source in sources {
        let parts = (0..locked.len())
            .filter(|slot| source_caption_id(&locked[*slot].id) == source)
            .collect::<Vec<_>>();
        if parts.iter().any(|slot| pairs[*slot].is_some()) {
            continue;
        }
        let fresh = (0..derived.len())
            .filter(|index| source_caption_id(&derived[*index].id) == source)
            .collect::<Vec<_>>();
        if fresh.len() != parts.len() {
            continue;
        }
        let mut parts = parts;
        parts.sort_by(|a, b| locked[*a].start.total_cmp(&locked[*b].start));
        let mut fresh = fresh;
        fresh.sort_by(|a, b| derived[*a].start.total_cmp(&derived[*b].start));
        for (slot, index) in parts.into_iter().zip(fresh) {
            pairs[slot] = Some(index);
        }
    }
    pairs
}

fn locked_caption_content(
    locked: &CaptionTrackSegment,
    fresh: Option<&CaptionTrackSegment>,
) -> CaptionTrackSegment {
    let mut segment = locked.clone();
    let (start, end) = (locked.start as f32, locked.end.max(locked.start) as f32);
    if let Some(fresh) = fresh {
        let offset = (locked.start - fresh.start) as f32;
        segment.text.clone_from(&fresh.text);
        segment.words = fresh
            .words
            .iter()
            .map(|word| CaptionWord {
                text: word.text.clone(),
                start: (word.start + offset).clamp(start, end),
                end: (word.end + offset).clamp(start, end),
            })
            .collect();
        return segment;
    }
    let tokens = segment.text.split_whitespace().collect::<Vec<_>>();
    let matches = tokens.len() == segment.words.len()
        && tokens
            .iter()
            .zip(&segment.words)
            .all(|(token, word)| *token == word.text);
    if !matches {
        let step = (end - start) / tokens.len().max(1) as f32;
        segment.words = tokens
            .iter()
            .enumerate()
            .map(|(index, token)| CaptionWord {
                text: (*token).to_string(),
                start: start + step * index as f32,
                end: start + step * (index + 1) as f32,
            })
            .collect();
    }
    segment
}

#[cfg(test)]
mod projection_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CaptionsData;

    #[test]
    fn transcription_ranges_follow_source_cuts_independent_of_speed_and_clip_order() {
        let timeline = serde_json::from_value(serde_json::json!({
            "segments": [
                {"recordingSegment":1,"start":1.0,"end":3.0,"timescale":0.5},
                {"recordingSegment":0,"start":5.0,"end":6.0,"timescale":2.0},
                {"recordingSegment":0,"start":1.0,"end":3.0,"timescale":1.0},
                {"recordingSegment":0,"start":2.0,"end":4.0,"timescale":1.0},
                {"recordingSegment":0,"start":4.0,"end":4.5,"timescale":1.0},
                {"recordingSegment":0,"start":1.0,"end":3.0,"timescale":2.0}
            ], "zoomSegments": []
        }))
        .unwrap();
        assert_eq!(
            transcription_source_ranges(Some(&timeline), &[10.0, 4.0]),
            vec![1.0..4.5, 5.0..6.0, 11.0..13.0]
        );
    }

    #[test]
    fn transcription_ranges_preserve_empty_timelines_and_clip_to_sources() {
        let mut timeline: TimelineConfiguration =
            serde_json::from_value(serde_json::json!({"segments": [], "zoomSegments": []}))
                .unwrap();
        assert!(transcription_source_ranges(Some(&timeline), &[30.0]).is_empty());
        assert_eq!(
            transcription_source_ranges(None, &[30.0, 10.0]),
            vec![0.0..40.0]
        );
        timeline.segments = serde_json::from_value(serde_json::json!([
            {"recordingSegment":0,"start":-1.0,"end":4.0,"timescale":1.0},
            {"recordingSegment":0,"start":8.0,"end":40.0,"timescale":1.0},
            {"recordingSegment":2,"start":0.0,"end":3.0,"timescale":1.0},
            {"recordingSegment":0,"start":5.0,"end":5.0,"timescale":1.0}
        ]))
        .unwrap();
        assert_eq!(
            transcription_source_ranges(Some(&timeline), &[10.0]),
            vec![0.0..4.0, 8.0..10.0]
        );
    }

    #[test]
    fn locked_caption_track_keeps_positions_but_follows_source_deletions_and_additions() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 5.0, "end": 20.0 }],
                "zoomSegments": [],
                "captionSegments": [
                    { "id": "kept", "start": 12.0, "end": 14.0, "text": "kept" },
                    { "id": "removed", "start": 1.0, "end": 2.0, "text": "removed" }
                ]
            },
            "captions": {
                "segments": [
                    { "id": "kept", "start": 12.0, "end": 14.0, "text": "kept" },
                    { "id": "added", "start": 8.0, "end": 9.0, "text": "added" }
                ],
                "settings": {},
                "sourceTimed": true
            },
            "lockedTracks": ["caption"]
        }))
        .unwrap();

        synchronize_captions(&mut project, &[20.0]);

        let track = &project.timeline.as_ref().unwrap().caption_segments;
        assert_eq!(
            track
                .iter()
                .map(|segment| (segment.id.as_str(), segment.start, segment.end))
                .collect::<Vec<_>>(),
            vec![("added", 3.0, 4.0), ("kept", 12.0, 14.0)]
        );

        project.locked_tracks.clear();
        synchronize_captions(&mut project, &[20.0]);
        let track = &project.timeline.as_ref().unwrap().caption_segments;
        assert_eq!((track[1].start, track[1].end), (7.0, 9.0));
    }

    #[test]
    fn a_locked_caption_takes_edited_words_at_its_locked_position() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 5.0, "end": 20.0 }],
                "zoomSegments": [],
                "captionSegments": [
                    {
                        "id": "kept", "start": 12.0, "end": 14.0, "text": "old words",
                        "words": [
                            { "text": "old", "start": 12.0, "end": 13.0 },
                            { "text": "words", "start": 13.0, "end": 14.0 }
                        ]
                    },
                    { "id": "gone", "start": 30.0, "end": 32.0, "text": "two words" }
                ]
            },
            "captions": {
                "segments": [
                    {
                        "id": "kept", "start": 12.0, "end": 14.0, "text": "new text here",
                        "words": [
                            { "text": "new", "start": 12.0, "end": 12.5 },
                            { "text": "text", "start": 12.5, "end": 13.0 },
                            { "text": "here", "start": 13.0, "end": 14.0 }
                        ]
                    },
                    { "id": "gone", "start": 40.0, "end": 41.0, "text": "two words" }
                ],
                "settings": {},
                "sourceTimed": true
            },
            "lockedTracks": ["caption"]
        }))
        .unwrap();

        synchronize_captions(&mut project, &[20.0]);

        let track = &project.timeline.as_ref().unwrap().caption_segments;
        let kept = track.iter().find(|segment| segment.id == "kept").unwrap();
        assert_eq!((kept.start, kept.end), (12.0, 14.0));
        assert_eq!(kept.text, "new text here");
        assert_eq!(
            kept.words
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![
                ("new", 12.0, 12.5),
                ("text", 12.5, 13.0),
                ("here", 13.0, 14.0)
            ]
        );
        let gone = track.iter().find(|segment| segment.id == "gone").unwrap();
        assert_eq!((gone.start, gone.end), (30.0, 32.0));
        assert_eq!(
            gone.words
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![("two", 30.0, 31.0), ("words", 31.0, 32.0)]
        );
    }

    #[test]
    fn locked_parts_of_a_caption_keep_their_own_words_when_clips_swap() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 5.0 },
                    { "recordingSegment": 0, "timescale": 1.0, "start": 5.0, "end": 10.0 }
                ],
                "zoomSegments": []
            },
            "captions": {
                "segments": [{
                    "id": "c", "start": 3.0, "end": 7.0, "text": "early late",
                    "words": [
                        { "text": "early", "start": 3.0, "end": 4.0 },
                        { "text": "late", "start": 6.0, "end": 7.0 }
                    ]
                }],
                "settings": {},
                "sourceTimed": true
            },
            "lockedTracks": ["caption"]
        }))
        .unwrap();
        synchronize_captions(&mut project, &[10.0]);
        let parts = |project: &ProjectConfiguration| {
            let mut parts = project
                .timeline
                .as_ref()
                .unwrap()
                .caption_segments
                .iter()
                .map(|segment| (segment.start, segment.text.clone(), segment.words[0].start))
                .collect::<Vec<_>>();
            parts.sort_by(|a, b| a.0.total_cmp(&b.0));
            parts
        };
        let before = parts(&project);
        assert_eq!(
            before,
            vec![
                (3.0, "early".to_string(), 3.0),
                (6.0, "late".to_string(), 6.0)
            ]
        );

        project.timeline.as_mut().unwrap().segments.swap(0, 1);
        synchronize_captions(&mut project, &[10.0]);

        assert_eq!(parts(&project), before);
    }

    fn split_caption_locked(timeline_segments: serde_json::Value) -> ProjectConfiguration {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 5.0 },
                    { "recordingSegment": 0, "timescale": 1.0, "start": 5.0, "end": 10.0 }
                ],
                "zoomSegments": []
            },
            "captions": {
                "segments": [{
                    "id": "c", "start": 3.0, "end": 7.0, "text": "early late",
                    "words": [
                        { "text": "early", "start": 3.0, "end": 4.0 },
                        { "text": "late", "start": 6.0, "end": 7.0 }
                    ]
                }],
                "settings": {},
                "sourceTimed": true
            },
            "lockedTracks": ["caption"]
        }))
        .unwrap();
        synchronize_captions(&mut project, &[10.0]);
        project.timeline.as_mut().unwrap().segments =
            serde_json::from_value(timeline_segments).unwrap();
        synchronize_captions(&mut project, &[10.0]);
        project
    }

    fn locked_parts(project: &ProjectConfiguration) -> Vec<(f64, String, Vec<f32>)> {
        let mut parts = project
            .timeline
            .as_ref()
            .unwrap()
            .caption_segments
            .iter()
            .map(|segment| {
                (
                    segment.start,
                    segment.text.clone(),
                    segment.words.iter().map(|word| word.start).collect(),
                )
            })
            .collect::<Vec<_>>();
        parts.sort_by(|a, b| a.0.total_cmp(&b.0));
        parts
    }

    #[test]
    fn deleting_either_clip_keeps_each_locked_part_on_its_own_words() {
        let expected = vec![
            (3.0, "early".to_string(), vec![3.0]),
            (6.0, "late".to_string(), vec![6.0]),
        ];
        let first_deleted = split_caption_locked(serde_json::json!([
            { "recordingSegment": 0, "timescale": 1.0, "start": 5.0, "end": 10.0 }
        ]));
        assert_eq!(locked_parts(&first_deleted), expected);
        let second_deleted = split_caption_locked(serde_json::json!([
            { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 5.0 }
        ]));
        assert_eq!(locked_parts(&second_deleted), expected);
    }

    #[test]
    fn transcription_coverage_accepts_identical_ranges() {
        let ranges = [1.0..4.0, 6.0..10.0];
        assert!(transcription_ranges_cover(&ranges, &ranges));
    }

    #[test]
    fn transcription_coverage_accepts_further_trims_and_reordered_clips() {
        let timeline = serde_json::from_value(serde_json::json!({
            "segments": [
                {"start":7.0,"end":9.0,"timescale":2.0},
                {"start":2.0,"end":3.0,"timescale":0.5}
            ], "zoomSegments": []
        }))
        .unwrap();
        let current = transcription_source_ranges(Some(&timeline), &[10.0]);
        assert!(transcription_ranges_cover(&[1.0..4.0, 6.0..10.0], &current));
    }

    #[test]
    fn transcription_coverage_rejects_audio_restored_by_undo() {
        let timeline = serde_json::from_value(serde_json::json!({
            "segments": [{"start":0.0,"end":10.0,"timescale":1.0}],
            "zoomSegments": []
        }))
        .unwrap();
        let current = transcription_source_ranges(Some(&timeline), &[10.0]);
        assert!(!transcription_ranges_cover(
            &[0.0..4.0, 6.0..10.0],
            &current
        ));
        assert!(!transcription_ranges_cover(&[1.0..10.0], &current));
        assert!(!transcription_ranges_cover(&[0.0..9.0], &current));
        assert!(!transcription_ranges_cover(&[], &current));
        assert!(!transcription_ranges_cover(
            &[0.0..4.0],
            &[0.0..4.0, 6.0..10.0]
        ));
    }

    #[test]
    fn transcription_coverage_accepts_an_empty_timeline() {
        assert!(transcription_ranges_cover(&[0.0..10.0], &[]));
        assert!(transcription_ranges_cover(&[], &[]));
    }

    fn project(source_timed: bool, start: f32, end: f32) -> ProjectConfiguration {
        ProjectConfiguration {
            timeline: Some(serde_json::from_value(serde_json::json!({
                "segments":[{"start":0.0,"end":5.0,"timescale":1.0},{"start":6.0,"end":10.0,"timescale":1.0}],
                "zoomSegments":[]
            })).unwrap()),
            captions: Some(CaptionsData { source_timed, segments:vec![CaptionSegment { id:"spoken".into(),start,end,text:"hello".into(),words:vec![CaptionWord { text:"hello".into(),start,end }] }], ..Default::default() }),
            ..Default::default()
        }
    }

    #[test]
    fn source_captions_follow_a_cut_on_load_and_export() {
        let mut project = project(true, 8.0, 9.0);
        synchronize_captions(&mut project, &[10.0]);
        let track = &project.timeline.as_ref().unwrap().caption_segments;
        assert_eq!(track[0].start, 7.0);
        assert_eq!(track[0].end, 8.0);
        assert_eq!(track[0].words[0].start, 7.0);
        let saved = serde_json::to_string(&project).unwrap();
        let mut reopened: ProjectConfiguration = serde_json::from_str(&saved).unwrap();
        synchronize_captions(&mut reopened, &[10.0]);
        assert_eq!(serde_json::to_string(&reopened).unwrap(), saved);
    }

    #[test]
    fn legacy_caption_migration_accounts_for_fullscreen_holds() {
        let mut project = project(false, 9.0, 10.0);
        project.timeline.as_mut().unwrap().text_segments.push(
            serde_json::from_value(
                serde_json::json!({"start":2.0,"end":4.0,"layout":"fullscreen"}),
            )
            .unwrap(),
        );
        synchronize_captions(&mut project, &[10.0]);
        assert!(project.captions.as_ref().unwrap().source_timed);
        assert_eq!(project.captions.as_ref().unwrap().segments[0].start, 8.0);
        let track = &project.timeline.as_ref().unwrap().caption_segments;
        assert_eq!(track[0].start, 9.0);
        assert_eq!(track[0].end, 10.0);
    }

    #[test]
    fn legacy_caption_migration_preserves_rounded_timeline_end() {
        let durations = [41.0 / 15.0, 82.0 / 15.0];
        for (timescale, hold_duration) in [
            (1.0, 0.0),
            (2.0, 0.0),
            (0.5, 0.0),
            (1.0, 0.1),
            (1.0, 10000.1),
        ] {
            let mut timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
                "segments": [
                    {"recordingSegment": 0, "start": 0.0, "end": durations[0], "timescale": timescale},
                    {"recordingSegment": 1, "start": 0.0, "end": durations[1], "timescale": timescale}
                ],
                "transitions": [{"segmentIndex": 1, "type": "cross-fade", "duration": 0.2}],
                "zoomSegments": []
            }))
            .unwrap();
            if hold_duration > 0.0 {
                timeline.text_segments.push(
                    serde_json::from_value(serde_json::json!({
                        "start": 1.0, "end": 1.0 + hold_duration, "layout": "fullscreen"
                    }))
                    .unwrap(),
                );
            }
            let end = timeline.duration() as f32;
            let mut project = project(false, end - 0.5, end);
            project.timeline = Some(timeline);

            synchronize_captions(&mut project, &durations);

            let captions = project.captions.as_ref().unwrap();
            assert_eq!(captions.segments.len(), 1, "{timescale}, {hold_duration}");
            let source_end = durations.iter().sum::<f64>() as f32;
            assert_eq!(captions.segments[0].end, source_end);
            assert_eq!(captions.segments[0].words[0].end, source_end);
            let track = &project.timeline.as_ref().unwrap().caption_segments;
            assert_eq!(track.len(), 1);
            assert!((track[0].end - f64::from(end)).abs() <= f64::from(end * f32::EPSILON));
            let saved = serde_json::to_string(&project).unwrap();
            synchronize_captions(&mut project, &durations);
            assert_eq!(serde_json::to_string(&project).unwrap(), saved);
        }
    }

    #[test]
    fn legacy_caption_migration_rejects_times_beyond_rounded_timeline_end() {
        let mut project = project(false, 8.0, 9.0_f32.next_up());
        synchronize_captions(&mut project, &[10.0]);
        assert!(project.captions.as_ref().unwrap().segments.is_empty());
        assert!(
            project
                .timeline
                .as_ref()
                .unwrap()
                .caption_segments
                .is_empty()
        );
    }

    #[test]
    fn stale_caption_tracks_are_replaced_and_styles_preserved() {
        let mut project = project(true, 8.0, 9.0);
        project.timeline.as_mut().unwrap().caption_segments.push(serde_json::from_value(serde_json::json!({"id":"spoken::edl0","start":100.0,"end":101.0,"text":"hello","colorOverride":"#123456"})).unwrap());
        synchronize_captions(&mut project, &[10.0]);
        let track = &project.timeline.as_ref().unwrap().caption_segments;
        assert_eq!(track.len(), 1);
        assert_eq!(track[0].start, 7.0);
        assert_eq!(track[0].color_override.as_deref(), Some("#123456"));
        project.captions.as_mut().unwrap().segments.clear();
        synchronize_captions(&mut project, &[10.0]);
        assert!(
            project
                .timeline
                .as_ref()
                .unwrap()
                .caption_segments
                .is_empty()
        );
    }

    #[test]
    fn source_captions_keep_display_offsets_across_silent_takes() {
        let mut project = project(true, 6.0, 7.0);
        project.timeline=Some(serde_json::from_value(serde_json::json!({"segments":[{"recordingSegment":1,"start":0.0,"end":5.0,"timescale":2.0}],"zoomSegments":[]})).unwrap());
        synchronize_captions(&mut project, &[5.0, 5.0]);
        assert_eq!(
            project.timeline.as_ref().unwrap().caption_segments[0].start,
            0.5
        );
        assert_eq!(
            project.timeline.as_ref().unwrap().caption_segments[0].end,
            1.0
        );
    }

    #[test]
    fn unsorted_words_outside_caption_bounds_keep_both_clip_projections() {
        let timeline = project(true, 0.0, 0.5).timeline.unwrap();
        let captions = [CaptionSegment {
            id: "unsorted".into(),
            start: 0.0,
            end: 0.5,
            text: "parent".into(),
            words: vec![
                CaptionWord {
                    text: "late-first".into(),
                    start: 4.0,
                    end: 4.5,
                },
                CaptionWord {
                    text: "second-clip".into(),
                    start: 7.0,
                    end: 7.5,
                },
                CaptionWord {
                    text: "early-last".into(),
                    start: 1.0,
                    end: 1.5,
                },
            ],
        }];

        let track = derive_caption_track_segments(&captions, &timeline, &[10.0]);
        assert_eq!(track.len(), 2);
        assert_eq!(track[0].id, "unsorted::edl0");
        assert_eq!(track[0].start, 4.0);
        assert_eq!(track[0].end, 1.5);
        assert_eq!(track[0].text, "late-first early-last");
        assert_eq!(
            track[0]
                .words
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![("late-first", 4.0, 4.5), ("early-last", 1.0, 1.5)]
        );
        assert_eq!(track[1].id, "unsorted::edl1");
        assert_eq!(track[1].start, 6.0);
        assert_eq!(track[1].end, 6.5);
        assert_eq!(track[1].text, "second-clip");
        assert_eq!(
            track[1]
                .words
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![("second-clip", 6.0, 6.5)]
        );
    }

    #[test]
    fn nan_word_timestamp_keeps_the_existing_mapping_path() {
        let timeline = project(true, 0.0, 0.5).timeline.unwrap();
        let captions = [CaptionSegment {
            id: "nan".into(),
            start: 0.0,
            end: 0.5,
            text: "parent".into(),
            words: vec![
                CaptionWord {
                    text: "nan-start".into(),
                    start: f32::NAN,
                    end: 1.0,
                },
                CaptionWord {
                    text: "second-clip".into(),
                    start: 7.0,
                    end: 7.5,
                },
            ],
        }];

        let track = derive_caption_track_segments(&captions, &timeline, &[10.0]);
        assert_eq!(track.len(), 2);
        assert_eq!(track[0].id, "nan::edl0");
        assert_eq!(track[0].start, 0.0);
        assert_eq!(track[0].end, 1.0);
        assert_eq!(track[0].text, "nan-start");
        assert_eq!(
            track[0]
                .words
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![("nan-start", 0.0, 1.0)]
        );
        assert_eq!(track[1].id, "nan::edl1");
        assert_eq!(track[1].start, 6.0);
        assert_eq!(track[1].end, 6.5);
        assert_eq!(track[1].text, "second-clip");
        assert_eq!(
            track[1]
                .words
                .iter()
                .map(|word| (word.text.as_str(), word.start, word.end))
                .collect::<Vec<_>>(),
            vec![("second-clip", 6.0, 6.5)]
        );
    }
}
