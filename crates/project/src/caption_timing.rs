use crate::{
    CaptionSegment, CaptionTrackSegment, CaptionWord, CaptionsData, ProjectConfiguration,
    TimelineConfiguration, TranscriptCut, TranscriptCutKind,
};
use std::collections::HashMap;

const MAX_CAPTION_WORD_DURATION: f32 = 2.5;

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

fn caption_char_attaches_to_previous(value: char) -> bool {
    matches!(
        value,
        ',' | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | '%'
            | ')'
            | ']'
            | '}'
            | '\''
            | '’'
            | '、'
            | '。'
            | '！'
            | '？'
            | '；'
            | '：'
            | '，'
    )
}

fn caption_token_attaches_to_previous(text: &str) -> bool {
    text.trim()
        .chars()
        .next()
        .is_some_and(caption_char_attaches_to_previous)
}

fn caption_text_from_words<'a>(words: impl IntoIterator<Item = &'a CaptionWord>) -> String {
    let mut text = String::new();

    for word in words {
        let word_text = word.text.trim();
        if word_text.is_empty() {
            continue;
        }

        if !text.is_empty() && !caption_token_attaches_to_previous(word_text) {
            text.push(' ');
        }
        text.push_str(word_text);
    }

    text
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
    let sanitized: Vec<CaptionSegment> = raw_segments
        .iter()
        .map(clamp_caption_segment_words)
        .collect();

    if timeline.segments.is_empty() || recording_durations.is_empty() {
        return sanitized
            .into_iter()
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

    for caption in &sanitized {
        let mut mapped_caption_segments: Vec<MappedCaption> = Vec::new();

        for mapping in &mappings {
            if !caption.words.is_empty() {
                let mut mapped_words = Vec::new();
                for word in &caption.words {
                    let Some((start, end)) = map_time_range_within_mapping(
                        f64::from(word.start),
                        f64::from(word.end),
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
    struct TrackOverrides {
        fade_duration: Option<f32>,
        linger_duration: Option<f32>,
        position: Option<String>,
        color: Option<String>,
        background_color: Option<String>,
        font_size: Option<u32>,
    }

    let mut overrides_by_source_id: HashMap<String, TrackOverrides> = HashMap::new();
    for segment in &timeline.caption_segments {
        overrides_by_source_id
            .entry(source_caption_id(&segment.id).to_string())
            .or_insert_with(|| TrackOverrides {
                fade_duration: segment.fade_duration_override,
                linger_duration: segment.linger_duration_override,
                position: segment.position_override.clone(),
                color: segment.color_override.clone(),
                background_color: segment.background_color_override.clone(),
                font_size: segment.font_size_override,
            });
    }

    let mut mapped =
        map_captions_to_edited_timeline(source_segments, timeline, recording_durations);
    mapped.sort_by(|a, b| a.start.total_cmp(&b.start));

    mapped
        .into_iter()
        .map(|segment| {
            let overrides = overrides_by_source_id.get(source_caption_id(&segment.id));
            CaptionTrackSegment {
                id: segment.id.clone(),
                start: segment.start,
                end: segment.end,
                text: segment.text,
                words: segment.words,
                fade_duration_override: overrides.and_then(|o| o.fade_duration),
                linger_duration_override: overrides.and_then(|o| o.linger_duration),
                position_override: overrides.and_then(|o| o.position.clone()),
                color_override: overrides.and_then(|o| o.color.clone()),
                background_color_override: overrides.and_then(|o| o.background_color.clone()),
                font_size_override: overrides.and_then(|o| o.font_size),
            }
        })
        .collect()
}

pub fn synchronize_captions(project: &mut ProjectConfiguration, recording_durations: &[f64]) {
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
    timeline.caption_segments =
        derive_caption_track_segments(&captions.segments, timeline, recording_durations);
}

/// `reconcileTranscriptCuts` (`captions.ts`): a fresh transcription covers
/// footage the transcript editor already cut, so words inside
/// `transcript_removed` go back to being cut words instead of live captions.
pub fn reconcile_transcript_cuts(captions: &mut CaptionsData) {
    if captions.transcript_removed.is_empty() {
        return;
    }
    let mut added: Vec<TranscriptCut> = Vec::new();
    let mut segments = Vec::with_capacity(captions.segments.len());
    for segment in std::mem::take(&mut captions.segments) {
        let mut kept = Vec::with_capacity(segment.words.len());
        for word in &segment.words {
            let (start, end) = (f64::from(word.start), f64::from(word.end));
            let midpoint = (start + end) / 2.0;
            if !captions
                .transcript_removed
                .iter()
                .any(|range| midpoint > range.start && midpoint < range.end)
            {
                kept.push(word.clone());
                continue;
            }
            let already_cut = captions.transcript_cuts.iter().chain(&added).any(|cut| {
                cut.kind == TranscriptCutKind::Word && cut.start < end && start < cut.end
            });
            if !already_cut {
                added.push(TranscriptCut {
                    id: format!("cut-{}", uuid::Uuid::new_v4()),
                    kind: TranscriptCutKind::Word,
                    text: word.text.clone(),
                    start,
                    end,
                    buffer_start: 0.0,
                    buffer_end: 0.0,
                    segment_id: Some(segment.id.clone()),
                    ..Default::default()
                });
            }
        }
        if kept.len() == segment.words.len() {
            segments.push(segment);
        } else if let (Some(first), Some(last)) = (kept.first(), kept.last()) {
            segments.push(CaptionSegment {
                id: segment.id.clone(),
                start: first.start,
                end: last.end,
                text: caption_text_from_words(&kept),
                words: kept,
            });
        }
    }
    captions.segments = segments;
    captions.transcript_cuts.extend(added);
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn regenerated_captions_keep_cut_words_cut() {
        let word = |text: &str, start: f32, end: f32| CaptionWord {
            text: text.into(),
            start,
            end,
        };
        let mut captions: CaptionsData = serde_json::from_value(serde_json::json!({
            "segments": [],
            "settings": {},
            "transcriptCuts": [{ "id": "old", "kind": "word", "text": "um", "start": 1.6, "end": 1.9 }],
            "transcriptRemoved": [{ "start": 1.6, "end": 1.9 }, { "start": 3.0, "end": 3.6 }]
        }))
        .unwrap();
        captions.segments = vec![
            CaptionSegment {
                id: "segment-0".into(),
                start: 1.0,
                end: 2.5,
                text: "hello um world".into(),
                words: vec![
                    word("hello", 1.0, 1.4),
                    word("um", 1.6, 1.9),
                    word("world", 2.0, 2.5),
                ],
            },
            CaptionSegment {
                id: "segment-1".into(),
                start: 3.1,
                end: 3.5,
                text: "gone".into(),
                words: vec![word("gone", 3.1, 3.5)],
            },
        ];

        reconcile_transcript_cuts(&mut captions);

        assert_eq!(captions.segments.len(), 1);
        assert_eq!(captions.segments[0].text, "hello world");
        assert_eq!(captions.segments[0].end, 2.5);
        let cut_text: Vec<_> = captions
            .transcript_cuts
            .iter()
            .map(|cut| cut.text.as_str())
            .collect();
        assert_eq!(cut_text, ["um", "gone"]);
        assert_eq!(
            captions.transcript_cuts[1].segment_id.as_deref(),
            Some("segment-1")
        );
    }
}
