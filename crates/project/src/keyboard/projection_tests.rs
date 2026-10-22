use super::*;
use crate::{KeyboardSettings, TimelineConfiguration};

fn event(key: &str, time_ms: f64, down: bool) -> KeyPressEvent {
    KeyPressEvent {
        key: key.to_string(),
        key_code: key.to_string(),
        time_ms,
        down,
    }
}

fn baseline_clip<'a>(
    ordered: &[&'a KeyPressEvent],
    start: f64,
    end: f64,
) -> Vec<(&'a KeyPressEvent, bool)> {
    let mut modifiers: Vec<&KeyPressEvent> = Vec::new();
    let mut presses = Vec::new();
    for &event in ordered {
        let source = event.time_ms / 1000.0;
        if source < start {
            if is_modifier_key(&event.key) {
                modifiers.retain(|key| key.key != event.key);
                if event.down {
                    modifiers.push(event);
                }
            }
            continue;
        }
        if source >= end {
            break;
        }
        if presses.is_empty() {
            presses.extend(modifiers.drain(..).map(|event| (event, true)));
        }
        presses.push((event, false));
    }
    presses
}

#[test]
fn indexed_clip_preserves_modifier_order_and_boundaries() {
    let events = KeyboardEvents {
        presses: vec![
            event("LMeta", 100.0, true),
            event("LShift", 100.0, true),
            event("LMeta", 200.0, true),
            event("a", 200.0, true),
            event("LShift", 200.0, false),
            event("LControl", 300.0, true),
            event("LMeta", 300.0, false),
            event("b", 400.0, true),
        ],
    };
    let mut index = PreparedKeyboardEvents::new(&events);
    let selected: Vec<_> = index.for_clip(0.25, 0.5).collect();
    assert_eq!(
        selected,
        vec![
            (&events.presses[2], true),
            (&events.presses[5], false),
            (&events.presses[6], false),
            (&events.presses[7], false),
        ]
    );
    let selected: Vec<_> = index.for_clip(0.15, 0.2).collect();
    assert!(selected.is_empty());
    let selected: Vec<_> = index.for_clip(0.2, 0.3).collect();
    assert_eq!(selected[0], (&events.presses[0], true));
    assert_eq!(selected[1], (&events.presses[1], true));
    assert_eq!(selected.last().unwrap(), &(&events.presses[4], false));
}

#[test]
fn indexed_clips_match_prefix_scans_for_reordered_and_invalid_events() {
    let mut presses = Vec::new();
    for index in 0..256 {
        let key = MODIFIER_KEYS
            .get(index % (MODIFIER_KEYS.len() + 3))
            .copied()
            .unwrap_or("a");
        presses.push(event(key, (index / 3) as f64 * 37.0, index % 4 != 0));
    }
    presses.extend([
        event("LMeta", f64::NAN, true),
        event("RMeta", f64::INFINITY, true),
        event("LAlt", f64::NEG_INFINITY, false),
        event("a", -0.0, true),
    ]);
    presses.rotate_left(79);
    presses.reverse();
    let events = KeyboardEvents { presses };
    let baseline = PreparedKeyboardEvents::new(&events);
    let mut indexed = PreparedKeyboardEvents::new(&events);
    for step in (0..180).rev().chain(0..180) {
        let start = step as f64 * 0.019 - 0.1;
        for end in [start, start + 0.001, start + 0.5, f64::INFINITY] {
            assert_eq!(
                indexed.for_clip(start, end).collect::<Vec<_>>(),
                baseline_clip(&baseline.ordered, start, end),
                "clip [{start}, {end})"
            );
        }
    }
    assert!(
        indexed
            .for_clip(f64::INFINITY, f64::INFINITY)
            .next()
            .is_none()
    );
    assert_eq!(
        indexed.for_clip(f64::NEG_INFINITY, 1.0).collect::<Vec<_>>(),
        baseline_clip(&baseline.ordered, f64::NEG_INFINITY, 1.0)
    );
}

#[test]
fn untrimmed_and_empty_clips_do_not_build_modifier_history() {
    let events = KeyboardEvents {
        presses: vec![event("LMeta", 0.0, true), event("a", 1000.0, true)],
    };
    let mut indexed = PreparedKeyboardEvents::new(&events);
    assert_eq!(indexed.for_clip(0.0, 2.0).count(), 2);
    assert!(indexed.modifiers.is_none());
    assert_eq!(indexed.for_clip(2.0, 3.0).count(), 0);
    assert!(indexed.modifiers.is_none());
    let empty = KeyboardEvents::default();
    assert_eq!(
        PreparedKeyboardEvents::new(&empty)
            .for_clip(0.0, 2.0)
            .count(),
        0
    );
}

#[test]
fn indexed_clip_keeps_seconds_based_boundary_rounding() {
    let events = KeyboardEvents {
        presses: vec![event("a", 2007.0, true), event("b", 2008.0, true)],
    };
    let baseline = PreparedKeyboardEvents::new(&events);
    let mut indexed = PreparedKeyboardEvents::new(&events);
    for event in &events.presses {
        let boundary = event.time_ms / 1000.0;
        for (start, end) in [(boundary, 3.0), (0.0, boundary)] {
            assert_eq!(
                indexed.for_clip(start, end).collect::<Vec<_>>(),
                baseline_clip(&baseline.ordered, start, end)
            );
        }
    }
}

#[test]
fn modifier_history_only_advances_to_requested_nonempty_clips() {
    let events = KeyboardEvents {
        presses: vec![
            event("LMeta", 0.0, true),
            event("a", 1000.0, true),
            event("LMeta", 2000.0, false),
            event("b", 3000.0, true),
        ],
    };
    let mut indexed = PreparedKeyboardEvents::new(&events);
    assert_eq!(indexed.for_clip(0.5, 1.5).count(), 2);
    assert_eq!(indexed.indexed_until, 1);
    assert_eq!(indexed.for_clip(2.5, 3.5).count(), 1);
    assert_eq!(indexed.indexed_until, 3);
    assert_eq!(indexed.for_clip(0.5, 1.5).count(), 2);
    assert_eq!(indexed.indexed_until, 3);
    assert_eq!(indexed.for_clip(4.0, 5.0).count(), 0);
    assert_eq!(indexed.indexed_until, 3);
}

fn fixture(count: usize, clips: usize, reverse: bool) -> (KeyboardEvents, TimelineConfiguration) {
    let presses = (0..count)
        .map(|index| {
            let key = match index % 100 {
                0 | 10 => "LControl".to_string(),
                _ => char::from(b'a' + ((index / 2) % 26) as u8).to_string(),
            };
            event(
                &key,
                index as f64 * 100.0,
                index % 2 == 0 && index % 100 != 10,
            )
        })
        .collect();
    let duration = count as f64 / 10.0;
    let mut segments: Vec<_> = (0..clips)
        .map(|index| {
            let start = if clips == 1 {
                0.0
            } else {
                index as f64 * (duration - 2.0).max(0.0) / clips as f64
            };
            serde_json::json!({
                "start": start,
                "end": if clips == 1 { duration } else { start + 2.0 },
                "timescale": 1.0,
            })
        })
        .collect();
    if reverse {
        segments.reverse();
    }
    let timeline = serde_json::from_value(serde_json::json!({
        "segments": segments,
        "zoomSegments": [],
    }))
    .unwrap();
    (KeyboardEvents { presses }, timeline)
}

#[test]
fn indexed_projection_matches_baseline_with_offsets_speed_transitions_and_holds() {
    let (mut events, mut timeline) = fixture(500, 12, true);
    events.presses.reverse();
    events.presses.push(event("LMeta", f64::NAN, true));
    timeline.segments[0].timescale = 2.0;
    timeline.segments[1].recording_clip = 1;
    timeline.segments[2].timescale = 0.5;
    timeline.segments[3].recording_clip = 9;
    timeline.segments[4].timescale = 0.0;
    timeline.transitions = serde_json::from_value(serde_json::json!([
        {"segmentIndex":1, "type":"cross-fade", "duration":0.2}
    ]))
    .unwrap();
    timeline.text_segments.push(
        serde_json::from_value(serde_json::json!({
            "start":2.0, "end":4.0, "layout":"fullscreen"
        }))
        .unwrap(),
    );
    let takes = [(events.clone(), 0.037), (events, -0.137)];
    for show_modifiers in [false, true] {
        let settings = KeyboardSettings {
            show_modifiers,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(project_keyboard_events(&takes, &timeline, &settings)).unwrap(),
            serde_json::to_value(baseline_project_keyboard_events(
                &takes, &timeline, &settings
            ))
            .unwrap()
        );
    }
}

#[test]
#[ignore = "release-mode keyboard projection benchmark"]
fn benchmark_keyboard_projection() {
    use std::{hint::black_box, time::Instant};

    type Project = fn(
        &[(KeyboardEvents, f64)],
        &TimelineConfiguration,
        &KeyboardSettings,
    ) -> Vec<KeyboardTrackSegment>;

    fn measure(
        project: Project,
        takes: &[(KeyboardEvents, f64)],
        timeline: &TimelineConfiguration,
        settings: &KeyboardSettings,
    ) -> f64 {
        let iterations = if takes.iter().map(|take| take.0.presses.len()).sum::<usize>() < 1000 {
            100
        } else {
            3
        };
        let start = Instant::now();
        for _ in 0..iterations {
            black_box(project(
                black_box(takes),
                black_box(timeline),
                black_box(settings),
            ));
        }
        start.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations)
    }

    for (events, clips, reverse, trim_start) in [
        (300, 1, false, None),
        (300, 10, false, None),
        (36_000, 1, false, None),
        (36_000, 1, false, Some(0.1)),
        (36_000, 1, false, Some(3598.0)),
        (36_000, 10, false, None),
        (36_000, 100, false, None),
        (36_000, 100, true, None),
        (36_000, 500, false, None),
    ] {
        let (events, mut timeline) = fixture(events, clips, reverse);
        if let Some(start) = trim_start {
            timeline.segments[0].start = start;
            timeline.segments[0].end = start + 2.0;
        }
        let takes = [(events, 0.0)];
        let settings = KeyboardSettings::default();
        let expected = baseline_project_keyboard_events(&takes, &timeline, &settings);
        let actual = project_keyboard_events(&takes, &timeline, &settings);
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        black_box(measure(
            baseline_project_keyboard_events,
            &takes,
            &timeline,
            &settings,
        ));
        black_box(measure(
            project_keyboard_events,
            &takes,
            &timeline,
            &settings,
        ));
        let mut baseline = Vec::new();
        let mut indexed = Vec::new();
        for round in 0..7 {
            if round % 2 == 0 {
                baseline.push(measure(
                    baseline_project_keyboard_events,
                    &takes,
                    &timeline,
                    &settings,
                ));
                indexed.push(measure(
                    project_keyboard_events,
                    &takes,
                    &timeline,
                    &settings,
                ));
            } else {
                indexed.push(measure(
                    project_keyboard_events,
                    &takes,
                    &timeline,
                    &settings,
                ));
                baseline.push(measure(
                    baseline_project_keyboard_events,
                    &takes,
                    &timeline,
                    &settings,
                ));
            }
        }
        baseline.sort_by(f64::total_cmp);
        indexed.sort_by(f64::total_cmp);
        println!(
            "events={}, clips={clips}, reversed={reverse}, trim_start={trim_start:?}: baseline={:.3} ms, indexed={:.3} ms, speedup={:.2}x",
            takes[0].0.presses.len(),
            baseline[3],
            indexed[3],
            baseline[3] / indexed[3]
        );
    }
}

fn baseline_project_keyboard_events(
    takes: &[(KeyboardEvents, f64)],
    timeline: &crate::TimelineConfiguration,
    settings: &crate::KeyboardSettings,
) -> Vec<KeyboardTrackSegment> {
    let holds = timeline.hold_windows();
    let output_time = |time: f64, end: bool| {
        let mut output = time;
        for (start, finish) in &holds {
            if output > *start || (!end && output == *start) {
                output += finish - start;
            } else {
                break;
            }
        }
        output
    };
    let mut edited_start = 0.0;
    let mut result = Vec::new();
    let mut prepared: Vec<Option<Vec<&KeyPressEvent>>> = (0..takes.len()).map(|_| None).collect();
    for (index, clip) in timeline.segments.iter().enumerate() {
        if !clip.start.is_finite()
            || !clip.end.is_finite()
            || !clip.timescale.is_finite()
            || clip.timescale <= 0.0
            || clip.end <= clip.start
        {
            continue;
        }
        edited_start -= timeline
            .effective_transition(index)
            .map_or(0.0, |transition| transition.duration);
        let edited_end = edited_start + clip.duration();
        if let Some((events, capture_offset)) = takes.get(clip.recording_clip as usize)
            && capture_offset.is_finite()
        {
            let source_start = clip.start + capture_offset;
            let source_end = clip.end + capture_offset;
            let mut presses = Vec::new();
            let mut modifiers = Vec::new();
            let ordered = prepared[clip.recording_clip as usize].get_or_insert_with(|| {
                let mut ordered: Vec<_> = events
                    .presses
                    .iter()
                    .filter(|event| event.time_ms.is_finite())
                    .collect();
                ordered.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
                ordered
            });
            for event in ordered {
                let source = event.time_ms / 1000.0;
                if source < source_start {
                    if is_modifier_key(&event.key) {
                        modifiers.retain(|key: &KeyPressEvent| key.key != event.key);
                        if event.down {
                            modifiers.push(event.clone());
                        }
                    }
                    continue;
                }
                if source >= source_end {
                    break;
                }
                if presses.is_empty() {
                    for mut modifier in modifiers.drain(..) {
                        modifier.time_ms = output_time(edited_start, false) * 1000.0;
                        presses.push(modifier);
                    }
                }
                let mut projected = event.clone();
                projected.time_ms = output_time(
                    edited_start + (source - source_start) / clip.timescale,
                    false,
                ) * 1000.0;
                presses.push(projected);
            }
            let mut grouped = group_key_events(
                &KeyboardEvents { presses },
                settings.grouping_threshold_ms,
                f64::from(settings.linger_duration) * 1000.0,
                settings.show_modifiers,
                settings.show_special_keys,
            );
            for segment in &mut grouped {
                segment.id = format!("kb-edit-{index}-{}", segment.id);
                segment.end = segment.end.min(output_time(edited_end, true));
            }
            result.extend(
                grouped
                    .into_iter()
                    .filter(|segment| segment.end > segment.start),
            );
        }
        edited_start = edited_end;
    }
    result.sort_by(|a, b| a.start.total_cmp(&b.start));
    result
}
