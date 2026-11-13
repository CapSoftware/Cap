use super::*;
use std::{hint::black_box, time::Instant};

fn fixture(
    clips: usize,
    captions: usize,
    order: &str,
) -> (Vec<CaptionSegment>, TimelineConfiguration, Vec<f64>) {
    let mut segments: Vec<_> = (0..clips)
        .map(|index| {
            let start = match order {
                "repeated" => 0,
                _ => index * 12,
            };
            serde_json::json!({"start": start, "end": start + 4, "timescale": 1.0})
        })
        .collect();
    match order {
        "reversed" => segments.reverse(),
        "shuffled" => {
            segments.reverse();
            segments.rotate_left(clips / 3);
        }
        "repeated" => {
            if clips > 1 {
                segments[clips - 1] = serde_json::json!({"start": 12, "end": 16, "timescale": 1.0});
                segments.reverse();
            }
        }
        _ => {}
    }
    let timeline = serde_json::from_value(serde_json::json!({
        "segments": segments, "zoomSegments": [],
        "captionSegments": [{"id": "caption-0", "start": 0.0, "end": 1.0, "text": "old", "positionOverride": "top", "fontSizeOverride": 36}]
    })).unwrap();
    let source = (0..captions)
        .map(|index| {
            let start = index as f32 * 4.0;
            CaptionSegment {
                id: format!("caption-{index}"),
                start,
                end: start + 3.9,
                text: "spoken words".into(),
                words: (0..10)
                    .map(|word| CaptionWord {
                        text: format!("word{word}"),
                        start: start + word as f32 * 0.4,
                        end: start + word as f32 * 0.4 + 0.3,
                    })
                    .collect(),
            }
        })
        .collect();
    (
        source,
        timeline,
        vec![(clips * 12 + 16).max(captions * 4 + 4) as f64],
    )
}

fn assert_projection(
    source: &[CaptionSegment],
    timeline: &TimelineConfiguration,
    durations: &[f64],
) {
    let actual = map_captions_to_edited_timeline(source, timeline, durations);
    let expected = baseline_projection(source, timeline, durations);
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_eq!(actual.id, expected.id);
        assert_eq!(actual.text, expected.text);
        assert_eq!(actual.start.to_bits(), expected.start.to_bits());
        assert_eq!(actual.end.to_bits(), expected.end.to_bits());
        assert_eq!(actual.words.len(), expected.words.len());
        for (actual, expected) in actual.words.iter().zip(expected.words) {
            assert_eq!(actual.text, expected.text);
            assert_eq!(actual.start.to_bits(), expected.start.to_bits());
            assert_eq!(actual.end.to_bits(), expected.end.to_bits());
        }
    }
    assert_eq!(
        serde_json::to_value(derive_caption_track_segments(source, timeline, durations)).unwrap(),
        serde_json::to_value(baseline_derivation(source, timeline, durations)).unwrap()
    );
}

#[test]
fn indexed_unordered_projection_preserves_clip_order_ids_and_styles() {
    for clips in [1, 20, 32, 60, 128] {
        for order in ["ordered", "reversed", "shuffled", "repeated"] {
            let (mut source, mut timeline, durations) = fixture(clips, 96, order);
            for (index, caption) in source.iter_mut().enumerate() {
                if index % 3 == 0 {
                    caption.words.clear();
                }
                if index % 7 == 0 {
                    caption.words.reverse();
                }
            }
            assert_projection(&source, &timeline, &durations);
            timeline.text_segments = serde_json::from_value(serde_json::json!([
                {"start": 1.0, "end": 2.0, "layout": "fullscreen"},
                {"start": 1.5, "end": 3.0, "layout": "fullscreen"}
            ]))
            .unwrap();
            if clips > 1 {
                timeline.transitions = serde_json::from_value(serde_json::json!([
                    {"segmentIndex": 1, "type": "cross-fade", "duration": 0.4}
                ]))
                .unwrap();
            }
            assert_projection(&source, &timeline, &durations);
            timeline.segments[0].recording_clip = 1;
            timeline.segments[0].timescale = 2.0;
            assert_projection(&source, &timeline, &[5.0, durations[0]]);
        }
    }
}

#[test]
fn indexed_projection_handles_nested_ranges_shared_edges_and_invalid_inputs() {
    let (mut source, mut timeline, durations) = fixture(64, 96, "shuffled");
    for (index, segment) in timeline.segments.iter_mut().enumerate() {
        segment.start = (index % 8) as f64;
        segment.end = 16.0 - segment.start;
    }
    assert_projection(&source, &timeline, &durations);
    for (index, segment) in timeline.segments.iter_mut().enumerate() {
        segment.start = index as f64 * 2.0;
        segment.end = segment.start + 0.5;
    }
    timeline.segments[32].start = 0.0;
    timeline.segments[32].end = 100.0;
    assert_projection(&source, &timeline, &durations);
    for value in [-0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut changed = timeline.clone();
        changed.segments[1].start = value;
        assert_projection(&source, &changed, &durations);
        changed.segments[1].start = 0.0;
        changed.segments[1].end = value;
        assert_projection(&source, &changed, &durations);
    }
    for caption in &mut source {
        caption.words[0].start = f32::NAN;
        caption.words[1].end = f32::INFINITY;
        caption.words[2].end = caption.words[2].start + 10.0;
    }
    assert_projection(&source, &timeline, &durations);
    assert_projection(&source, &timeline, &[]);
}

fn measure(
    source: &[CaptionSegment],
    timeline: &TimelineConfiguration,
    durations: &[f64],
    derive: fn(&[CaptionSegment], &TimelineConfiguration, &[f64]) -> Vec<CaptionTrackSegment>,
) -> f64 {
    let iterations = 10;
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(derive(
            black_box(source),
            black_box(timeline),
            black_box(durations),
        ));
    }
    started.elapsed().as_secs_f64() * 1e3 / iterations as f64
}

#[test]
#[ignore]
fn benchmark_unordered_caption_projection() {
    println!("clips,captions,order,before_ms,after_ms,speedup");
    for (clips, captions) in [(20, 150), (60, 900), (500, 1_500), (2_000, 6_000)] {
        for order in ["ordered", "reversed", "shuffled"] {
            let (source, timeline, durations) = fixture(clips, captions, order);
            assert_projection(&source, &timeline, &durations);
            for _ in 0..2 {
                black_box(measure(&source, &timeline, &durations, baseline_derivation));
                black_box(measure(
                    &source,
                    &timeline,
                    &durations,
                    derive_caption_track_segments,
                ));
            }
            let mut before = Vec::new();
            let mut after = Vec::new();
            for run in 0..7 {
                if run % 2 == 0 {
                    before.push(measure(&source, &timeline, &durations, baseline_derivation));
                    after.push(measure(
                        &source,
                        &timeline,
                        &durations,
                        derive_caption_track_segments,
                    ));
                } else {
                    after.push(measure(
                        &source,
                        &timeline,
                        &durations,
                        derive_caption_track_segments,
                    ));
                    before.push(measure(&source, &timeline, &durations, baseline_derivation));
                }
            }
            before.sort_by(f64::total_cmp);
            after.sort_by(f64::total_cmp);
            println!(
                "{clips},{captions},{order},{:.4},{:.4},{:.2}",
                before[3],
                after[3],
                before[3] / after[3]
            );
        }
    }
}

fn baseline_projection(
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

fn baseline_derivation(
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

    let mut mapped = baseline_projection(source_segments, timeline, recording_durations);
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
