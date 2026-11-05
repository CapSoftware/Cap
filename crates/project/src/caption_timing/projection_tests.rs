use super::*;

fn assert_projection_matches(
    captions: &[CaptionSegment],
    timeline: &TimelineConfiguration,
    durations: &[f64],
) {
    let expected = baseline_projection(captions, timeline, durations);
    let actual = map_captions_to_edited_timeline(captions, timeline, durations);
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(&expected) {
        assert_eq!(actual.id, expected.id);
        assert_eq!(actual.start.to_bits(), expected.start.to_bits());
        assert_eq!(actual.end.to_bits(), expected.end.to_bits());
        assert_eq!(actual.text, expected.text);
        assert_eq!(actual.words.len(), expected.words.len());
        for (actual, expected) in actual.words.iter().zip(&expected.words) {
            assert_eq!(actual.text, expected.text);
            assert_eq!(actual.start.to_bits(), expected.start.to_bits());
            assert_eq!(actual.end.to_bits(), expected.end.to_bits());
        }
    }
}

fn timeline(ranges: &[(f64, f64)]) -> TimelineConfiguration {
    serde_json::from_value(serde_json::json!({
        "segments": ranges.iter().enumerate().map(|(index, (start, end))| {
            serde_json::json!({"start": start, "end": end, "timescale": ([0.5, 1.0, 2.0][index % 3])})
        }).collect::<Vec<_>>(),
        "zoomSegments": [],
        "transitions": [{"segmentIndex": 1, "type": "cross-fade", "duration": 0.2}],
        "textSegments": [{"start": 1.0, "end": 2.0, "layout": "fullscreen"}]
    }))
    .unwrap()
}

#[test]
fn borrowed_caption_projection_matches_sanitized_copy() {
    let times = [
        -1.0,
        -0.0,
        0.0,
        1.0,
        2.0,
        3.0,
        4.0,
        5.0,
        6.0,
        8.0,
        10.0,
        f32::NAN,
        f32::NEG_INFINITY,
        f32::INFINITY,
    ];
    let captions: Vec<_> = times
        .iter()
        .enumerate()
        .flat_map(|(index, start)| {
            times.iter().enumerate().flat_map(move |(other, end)| {
                [false, true].map(|with_words| CaptionSegment {
                    id: format!("caption-{index}-{other}-{with_words}"),
                    start: *start,
                    end: *end,
                    text: "parent".into(),
                    words: if with_words {
                        vec![
                            CaptionWord {
                                text: "late".into(),
                                start: *end,
                                end: *end + 0.5,
                            },
                            CaptionWord {
                                text: "early".into(),
                                start: *start,
                                end: *start + 0.5,
                            },
                            CaptionWord {
                                text: ",".into(),
                                start: 4.0,
                                end: 10.0,
                            },
                        ]
                    } else {
                        Vec::new()
                    },
                })
            })
        })
        .collect();
    for ranges in [
        vec![(0.0, 2.0), (2.0, 4.0), (6.0, 10.0)],
        vec![(0.0, 4.0), (2.0, 6.0), (2.0, 6.0), (6.0, 10.0)],
        vec![(0.0, 10.0), (2.0, 4.0)],
        vec![(6.0, 10.0), (0.0, 4.0), (0.0, 4.0)],
        vec![(0.0, 0.0), (2.0, 1.0), (6.0, 10.0)],
        vec![(0.0, 10.0)],
        Vec::new(),
    ] {
        let timeline = timeline(&ranges);
        assert_projection_matches(&captions, &timeline, &[10.0]);
        assert_projection_matches(&captions, &timeline, &[]);
    }
}

#[test]
fn borrowed_projection_preserves_take_offsets_and_nonfinite_timestamps() {
    let captions: Vec<_> = (0..40)
        .map(|index| {
            let start = index as f32 * 0.5;
            CaptionSegment {
                id: format!("caption-{index}"),
                start,
                end: start + 0.75,
                text: "word".into(),
                words: vec![CaptionWord {
                    text: "word".into(),
                    start,
                    end: start + 0.75,
                }],
            }
        })
        .collect();
    let mut timeline = timeline(&[(0.0, 4.0), (0.0, 6.0), (6.0, 10.0)]);
    timeline.segments[1].recording_clip = 1;
    timeline.segments[2].recording_clip = 1;
    assert_projection_matches(&captions, &timeline, &[4.0, 10.0]);
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut changed = timeline.clone();
        changed.segments[1].start = invalid;
        assert_projection_matches(&captions, &changed, &[4.0, 10.0]);
        changed.segments[1].start = 0.0;
        changed.segments[1].end = invalid;
        assert_projection_matches(&captions, &changed, &[4.0, 10.0]);
        assert_projection_matches(&captions, &timeline, &[invalid, 10.0]);
    }
}

#[test]
#[ignore]
fn benchmark_caption_projection_allocations() {
    use std::{hint::black_box, time::Instant};
    let captions: Vec<_> = (0..900)
        .map(|index| {
            let start = index as f32 * 4.0;
            CaptionSegment {
                id: format!("caption-{index}"),
                start,
                end: start + 4.0,
                text: "spoken words".into(),
                words: (0..10)
                    .map(|word| {
                        let start = start + word as f32 * 0.4;
                        CaptionWord {
                            text: "word".into(),
                            start,
                            end: start + 0.3,
                        }
                    })
                    .collect(),
            }
        })
        .collect();
    for clips in [1, 20, 60, 500] {
        let ranges: Vec<_> = (0..clips)
            .map(|index| {
                let start = (index * 3600 / clips) as f64;
                (start, if clips == 1 { 3600.0 } else { start + 4.0 })
            })
            .collect();
        for reversed in [false, true] {
            let mut timeline = timeline(&ranges);
            timeline.transitions.clear();
            timeline.text_segments.clear();
            if reversed {
                timeline.segments.reverse();
            }
            assert_projection_matches(&captions, &timeline, &[3600.0]);
            let run = |baseline: bool, iterations| {
                let started = Instant::now();
                for _ in 0..iterations {
                    let output = if baseline {
                        baseline_projection(
                            black_box(&captions),
                            black_box(&timeline),
                            black_box(&[3600.0]),
                        )
                    } else {
                        map_captions_to_edited_timeline(
                            black_box(&captions),
                            black_box(&timeline),
                            black_box(&[3600.0]),
                        )
                    };
                    black_box(output);
                }
                started.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations)
            };
            run(true, 3);
            run(false, 3);
            let mut baseline = Vec::new();
            let mut borrowed = Vec::new();
            for sample in 0..7 {
                if sample % 2 == 0 {
                    baseline.push(run(true, 20));
                    borrowed.push(run(false, 20));
                } else {
                    borrowed.push(run(false, 20));
                    baseline.push(run(true, 20));
                }
            }
            baseline.sort_by(f64::total_cmp);
            borrowed.sort_by(f64::total_cmp);
            println!(
                "clips={clips} reversed={reversed} baseline_ms={:.6} borrowed_ms={:.6} speedup={:.2}",
                baseline[3],
                borrowed[3],
                baseline[3] / borrowed[3]
            );
        }
    }
}

fn baseline_projection(
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
        let word_bounds = if caption.words.is_empty() {
            None
        } else {
            caption.words.iter().try_fold(
                (f64::INFINITY, f64::NEG_INFINITY),
                |(start, end), word| {
                    let word_start = f64::from(word.start);
                    let word_end = f64::from(word.end);
                    if word_start.is_nan() || word_end.is_nan() {
                        None
                    } else {
                        Some((start.min(word_start), end.max(word_end)))
                    }
                },
            )
        };

        for mapping in &mappings {
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

fn baseline_derivation(
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

#[test]
fn caption_overrides_match_owned_map_for_repeated_source_ids() {
    let captions: Vec<_> = ["shared", "plain", "", "shared::edlcustom"]
        .into_iter()
        .map(|id| CaptionSegment {
            id: id.into(),
            start: 0.0,
            end: 8.0,
            text: "spoken text".into(),
            words: Vec::new(),
        })
        .collect();
    for ranges in [
        vec![(0.0, 8.0)],
        vec![(0.0, 4.0), (4.0, 8.0), (0.0, 8.0)],
        Vec::new(),
    ] {
        let mut timeline = timeline(&ranges);
        let saved: Vec<CaptionTrackSegment> = serde_json::from_value(serde_json::json!([
            {"id":"shared::edl0", "start":0.0, "end":1.0, "text":"first",
             "fadeDurationOverride":0.25, "lingerDurationOverride":0.5,
             "positionOverride":"top", "colorOverride":"#abcdef",
             "backgroundColorOverride":"#123456", "fontSizeOverride":32},
            {"id":"shared::edl1", "start":1.0, "end":2.0, "text":"later",
             "fadeDurationOverride":0.75, "positionOverride":"bottom", "fontSizeOverride":64},
            {"id":"plain", "start":0.0, "end":1.0, "text":"no overrides"},
            {"id":"plain::edl1", "start":1.0, "end":2.0, "text":"ignored later override",
             "colorOverride":"#ffffff"},
            {"id":"::edl0", "start":0.0, "end":1.0, "text":"empty source ID",
             "positionOverride":"", "colorOverride":"", "fontSizeOverride":0},
            {"id":"removed", "start":0.0, "end":1.0, "text":"not in source"}
        ]))
        .unwrap();
        for saved_track in [Vec::new(), saved.clone(), saved.into_iter().rev().collect()] {
            timeline.caption_segments = saved_track;
            let before = serde_json::to_vec(&timeline).unwrap();
            for durations in [&[8.0][..], &[][..]] {
                let expected = baseline_derivation(&captions, &timeline, durations);
                let actual = derive_caption_track_segments(&captions, &timeline, durations);
                assert_eq!(
                    serde_json::to_vec(&actual).unwrap(),
                    serde_json::to_vec(&expected).unwrap()
                );
                assert_eq!(serde_json::to_vec(&timeline).unwrap(), before);
                if !timeline.caption_segments.is_empty() {
                    let first = &timeline.caption_segments[0];
                    for caption in actual.iter().filter(|caption| {
                        source_caption_id(&caption.id) == source_caption_id(&first.id)
                    }) {
                        assert_eq!(caption.position_override, first.position_override);
                        assert_eq!(caption.color_override, first.color_override);
                        assert_eq!(caption.font_size_override, first.font_size_override);
                    }
                }
            }
        }
    }
}

#[test]
fn caption_overrides_preserve_nonfinite_float_bits() {
    let captions = [CaptionSegment {
        id: "spoken".into(),
        start: 0.0,
        end: 4.0,
        text: "hello".into(),
        words: Vec::new(),
    }];
    let mut timeline = timeline(&[(0.0, 4.0)]);
    timeline.caption_segments = derive_caption_track_segments(&captions, &timeline, &[4.0]);
    for value in [
        f32::from_bits(0x7fc01234),
        f32::INFINITY,
        f32::NEG_INFINITY,
        -0.0,
    ] {
        timeline.caption_segments[0].fade_duration_override = Some(value);
        timeline.caption_segments[0].linger_duration_override = Some(value);
        let actual = derive_caption_track_segments(&captions, &timeline, &[4.0]);
        let expected = baseline_derivation(&captions, &timeline, &[4.0]);
        assert_eq!(
            actual[0].fade_duration_override.unwrap().to_bits(),
            expected[0].fade_duration_override.unwrap().to_bits()
        );
        assert_eq!(
            actual[0].linger_duration_override.unwrap().to_bits(),
            expected[0].linger_duration_override.unwrap().to_bits()
        );
        assert_eq!(
            actual[0].fade_duration_override.unwrap().to_bits(),
            value.to_bits()
        );
    }
}

#[test]
fn mapping_bounds_preserve_shared_edges_overlaps_duplicates_and_fallbacks() {
    let sequential: Vec<_> = (0..64)
        .map(|index| (index as f64, index as f64 + 1.0))
        .collect();
    let overlapping: Vec<_> = (0..64)
        .map(|index| (index as f64 * 0.5, index as f64 * 0.5 + 2.0))
        .collect();
    let duplicated: Vec<_> = sequential.iter().flat_map(|range| [*range; 2]).collect();
    let mut nested = sequential.clone();
    nested[0].1 = 100.0;
    let mut reversed = sequential.clone();
    reversed.reverse();
    for with_words in [false, true] {
        let captions: Vec<_> = [
            -1.0,
            -0.0,
            0.0,
            f32::from_bits(1.0_f32.to_bits() - 1),
            1.0,
            f32::from_bits(1.0_f32.to_bits() + 1),
            30.0,
            63.0,
            64.0,
            100.0,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, start)| CaptionSegment {
            id: format!("edge-{index}"),
            start: if with_words { -100.0 } else { start },
            end: if with_words { -99.0 } else { start + 2.5 },
            text: "parent".into(),
            words: if with_words {
                vec![
                    CaptionWord {
                        text: "later".into(),
                        start: start + 2.0,
                        end: start + 2.5,
                    },
                    CaptionWord {
                        text: "earlier".into(),
                        start,
                        end: start + 0.5,
                    },
                ]
            } else {
                Vec::new()
            },
        })
        .collect();
        for ranges in [&sequential, &overlapping, &duplicated, &nested, &reversed] {
            assert_projection_matches(&captions, &timeline(ranges), &[100.0]);
        }
        assert_projection_matches(&[], &timeline(&sequential), &[100.0]);
    }
}
