use super::*;
use crate::CaptionsData;
use std::{hint::black_box, time::Instant};

fn fixture(clips: usize, words_per_clip: usize) -> (ProjectConfiguration, Vec<f64>) {
    let duration = words_per_clip as f64 * 0.4;
    let timeline = serde_json::from_value(serde_json::json!({
        "segments": (0..clips).map(|index| {
            let start = index as f64 * (duration + 3.0);
            serde_json::json!({"start": start, "end": start + duration, "timescale": 1.0})
        }).collect::<Vec<_>>(),
        "zoomSegments": [],
        "captionSegments": [{"id": "caption-0", "start": 0.0, "end": 1.0, "text": "old", "colorOverride": "#abcdef"}]
    })).unwrap();
    let words: Vec<_> = (0..clips * words_per_clip)
        .map(|index| CaptionWord {
            text: format!("word{index}"),
            start: (index as f64 * 0.4) as f32,
            end: (index as f64 * 0.4 + 0.3) as f32,
        })
        .collect();
    let segments = words
        .chunks(6)
        .enumerate()
        .map(|(index, words)| CaptionSegment {
            id: format!("caption-{index}"),
            start: words[0].start,
            end: words.last().unwrap().end,
            text: caption_text_from_words(words),
            words: words.to_vec(),
        })
        .collect();
    (
        ProjectConfiguration {
            timeline: Some(timeline),
            captions: Some(CaptionsData {
                segments,
                source_timed: false,
                ..Default::default()
            }),
            ..Default::default()
        },
        vec![clips as f64 * (duration + 3.0)],
    )
}

#[test]
fn indexed_migration_preserves_complete_projects_and_repeated_sync() {
    for clips in [1, 2, 32, 60, 128, 200] {
        for transitions in [false, true] {
            for holds in [false, true] {
                let (mut project, durations) = fixture(clips, 10);
                let timeline = project.timeline.as_mut().unwrap();
                if transitions && clips > 1 {
                    timeline.transitions = serde_json::from_value(serde_json::json!([
                        {"segmentIndex": 1, "type": "cross-fade", "duration": 0.4}
                    ]))
                    .unwrap();
                }
                if holds {
                    timeline.text_segments = serde_json::from_value(serde_json::json!([
                        {"start": 1.0, "end": 2.0, "layout": "fullscreen"},
                        {"start": 1.5, "end": 3.0, "layout": "fullscreen"}
                    ]))
                    .unwrap();
                }
                timeline.segments.reverse();
                let mut expected = project.clone();
                for _ in 0..2 {
                    baseline_synchronize(&mut expected, &durations);
                    synchronize_captions(&mut project, &durations);
                    assert_eq!(
                        serde_json::to_value(&project).unwrap(),
                        serde_json::to_value(&expected).unwrap()
                    );
                }
            }
        }
    }
}

#[test]
fn indexed_lookup_matches_reverse_scan_at_shared_edges_and_gaps() {
    let mappings: Vec<_> = [(0.0, 2.0), (1.5, 3.0), (3.0, 3.0), (3.0, 4.0), (5.0, 6.0)]
        .into_iter()
        .enumerate()
        .map(|(index, (start, end))| SourceToEditedMapping {
            source_start: index as f64 * 10.0,
            source_end: index as f64 * 10.0 + end - start,
            edited_start: start,
            timescale: 1.0,
        })
        .collect();
    let mut times = vec![f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0, 0.0, 4.5];
    for mapping in &mappings {
        for time in [mapping.edited_start, mapping.edited_end()] {
            times.extend([time.next_down(), time, time.next_up()]);
        }
    }
    for time in times {
        let expected = mappings.iter().rev().find_map(|mapping| {
            let end = mapping.edited_start
                + (mapping.source_end - mapping.source_start) / mapping.timescale;
            (time >= mapping.edited_start && time <= end).then_some(
                (mapping.source_start + (time - mapping.edited_start) * mapping.timescale) as f32,
            )
        });
        assert_eq!(
            source_time_at(&mappings, time).map(f32::to_bits),
            expected.map(f32::to_bits)
        );
    }
}

#[test]
fn migration_falls_back_for_nonmonotonic_and_nonfinite_clips() {
    for value in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for field in 0..3 {
            let (mut project, durations) = fixture(128, 10);
            let clip = &mut project.timeline.as_mut().unwrap().segments[1];
            match field {
                0 => clip.start = value,
                1 => clip.end = value,
                _ => clip.timescale = value,
            }
            let mut expected = project.clone();
            baseline_synchronize(&mut expected, &durations);
            synchronize_captions(&mut project, &durations);
            let actual = &project.captions.as_ref().unwrap().segments;
            let expected = &expected.captions.as_ref().unwrap().segments;
            assert_eq!(actual.len(), expected.len());
            for (actual, expected) in actual.iter().zip(expected) {
                assert_eq!(actual.id, expected.id);
                assert_eq!(actual.start.to_bits(), expected.start.to_bits());
                assert_eq!(actual.end.to_bits(), expected.end.to_bits());
                for (actual, expected) in actual.words.iter().zip(&expected.words) {
                    assert_eq!(actual.start.to_bits(), expected.start.to_bits());
                    assert_eq!(actual.end.to_bits(), expected.end.to_bits());
                }
            }
        }
    }
}

fn measure(
    project: &ProjectConfiguration,
    durations: &[f64],
    migrate: fn(&mut ProjectConfiguration, &[f64]),
) -> f64 {
    let mut projects: Vec<_> = (0..5).map(|_| project.clone()).collect();
    let started = Instant::now();
    for project in &mut projects {
        migrate(black_box(project), black_box(durations));
        black_box(&project.captions);
        black_box(&project.timeline);
    }
    started.elapsed().as_secs_f64() * 1e3 / projects.len() as f64
}

#[test]
#[ignore]
fn benchmark_caption_migration_lookup() {
    println!("clips,words,before_ms,after_ms,speedup");
    for (clips, words_per_clip) in [(1, 9_000), (60, 25), (500, 20), (2_000, 10)] {
        let (project, durations) = fixture(clips, words_per_clip);
        let mut expected = project.clone();
        let mut actual = project.clone();
        baseline_synchronize(&mut expected, &durations);
        synchronize_captions(&mut actual, &durations);
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        for _ in 0..2 {
            black_box(measure(&project, &durations, baseline_synchronize));
            black_box(measure(&project, &durations, synchronize_captions));
        }
        let mut before = Vec::new();
        let mut after = Vec::new();
        for run in 0..7 {
            if run % 2 == 0 {
                before.push(measure(&project, &durations, baseline_synchronize));
                after.push(measure(&project, &durations, synchronize_captions));
            } else {
                after.push(measure(&project, &durations, synchronize_captions));
                before.push(measure(&project, &durations, baseline_synchronize));
            }
        }
        before.sort_by(f64::total_cmp);
        after.sort_by(f64::total_cmp);
        println!(
            "{clips},{},{:.4},{:.4},{:.2}",
            clips * words_per_clip,
            before[3],
            after[3],
            before[3] / after[3]
        );
    }
}
fn baseline_synchronize(project: &mut ProjectConfiguration, recording_durations: &[f64]) {
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
