use super::*;
use std::{hint::black_box, time::Instant};

fn timeline(count: usize, mode: usize, transitions: bool, holds: bool) -> TimelineConfiguration {
    let segments: Vec<_> = (0..count)
        .map(|index| {
            serde_json::json!({
                "start": index as f64 * 4.0,
                "end": index as f64 * 4.0 + 4.0,
                "timescale": ([0.5, 1.0, 2.0][index % 3]),
                "hideCursor": match mode {
                    0 => false,
                    1 => true,
                    _ => index % 4 >= 1 && index % 4 <= 2,
                }
            })
        })
        .collect();
    let transitions: Vec<_> = (1..count)
        .filter(|index| transitions && index % 2 == 1)
        .map(|index| serde_json::json!({"segmentIndex": index, "type": "cross-fade", "duration": 0.4}))
        .collect();
    let text = if holds {
        vec![
            serde_json::json!({"start": 1.0, "end": 2.0, "layout": "fullscreen"}),
            serde_json::json!({"start": 1.5, "end": 3.0, "layout": "fullscreen"}),
            serde_json::json!({"start": 9.0, "end": 10.0, "layout": "fullscreen"}),
        ]
    } else {
        Vec::new()
    };
    serde_json::from_value(serde_json::json!({
        "segments": segments, "zoomSegments": [], "transitions": transitions, "textSegments": text
    }))
    .unwrap()
}

fn assert_visibility(timeline: &TimelineConfiguration, time: f64) {
    let expected = baseline_visibility(timeline, time);
    let actual = timeline.cursor_visibility_at(time);
    assert_eq!(
        actual.to_bits(),
        expected.to_bits(),
        "time {time}, clips {:?}",
        timeline.segments
    );
}

#[test]
fn cursor_visibility_matches_allocated_windows_at_boundaries_and_holds() {
    for count in 0..=6 {
        for mask in 0..1_usize << count {
            for transitions in [false, true] {
                for holds in [false, true] {
                    let mut timeline = timeline(count, 0, transitions, holds);
                    for (index, segment) in timeline.segments.iter_mut().enumerate() {
                        segment.hide_cursor = Some(mask & (1 << index) != 0);
                    }
                    let (windows, total) = baseline_windows(&timeline);
                    let mut times = vec![
                        -1.0,
                        -0.0,
                        0.0,
                        total,
                        total + 1.0,
                        f64::NAN,
                        f64::INFINITY,
                        f64::NEG_INFINITY,
                    ];
                    for (start, end) in windows.into_iter().chain(timeline.hold_windows()) {
                        for edge in [start, end] {
                            times.extend([
                                edge.next_down(),
                                edge,
                                edge.next_up(),
                                edge - 0.15,
                                edge + 0.15,
                                edge - 0.3,
                                edge + 0.3,
                            ]);
                        }
                    }
                    for time in times {
                        assert_visibility(&timeline, time);
                    }
                }
            }
        }
    }
}

#[test]
fn cursor_visibility_preserves_degenerate_clip_arithmetic() {
    let values = [
        0.0,
        -0.0,
        -1.0,
        1e-12,
        f64::MAX,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
    ];
    for value in values {
        for field in 0..3 {
            let mut timeline = timeline(5, 2, false, false);
            match field {
                0 => timeline.segments[2].start = value,
                1 => timeline.segments[2].end = value,
                _ => timeline.segments[2].timescale = value,
            }
            for time in values
                .into_iter()
                .chain([0.1, 4.0, 7.9, 8.0, 10.0, 20.0, 30.0])
            {
                assert_visibility(&timeline, time);
            }
        }
    }
}

fn measure(
    timeline: &TimelineConfiguration,
    visibility: fn(&TimelineConfiguration, f64) -> f64,
) -> f64 {
    let iterations = 10_000;
    let duration = timeline.duration();
    let started = Instant::now();
    for index in 0..iterations {
        let time = (index % 97) as f64 / 97.0 * duration;
        black_box(visibility(black_box(timeline), black_box(time)));
    }
    started.elapsed().as_secs_f64() * 1e9 / iterations as f64
}

#[test]
#[ignore]
fn benchmark_cursor_visibility() {
    println!("clips,mode,transitions,holds,before_ns,after_ns,speedup");
    for count in [2, 20, 200, 1_000] {
        for (mode, transitions, holds) in [
            (0, false, false),
            (1, false, false),
            (2, false, false),
            (2, true, false),
            (2, true, true),
        ] {
            let timeline = timeline(count, mode, transitions, holds);
            for index in 0..97 {
                assert_visibility(&timeline, index as f64 / 97.0 * timeline.duration());
            }
            for _ in 0..2 {
                black_box(measure(&timeline, baseline_visibility));
                black_box(measure(
                    &timeline,
                    TimelineConfiguration::cursor_visibility_at,
                ));
            }
            let mut before = Vec::new();
            let mut after = Vec::new();
            for run in 0..9 {
                if run % 2 == 0 {
                    before.push(measure(&timeline, baseline_visibility));
                    after.push(measure(
                        &timeline,
                        TimelineConfiguration::cursor_visibility_at,
                    ));
                } else {
                    after.push(measure(
                        &timeline,
                        TimelineConfiguration::cursor_visibility_at,
                    ));
                    before.push(measure(&timeline, baseline_visibility));
                }
            }
            before.sort_by(f64::total_cmp);
            after.sort_by(f64::total_cmp);
            println!(
                "{count},{mode},{transitions},{holds},{:.3},{:.3},{:.2}",
                before[4],
                after[4],
                before[4] / after[4]
            );
        }
    }
}

fn baseline_windows(timeline: &TimelineConfiguration) -> (Vec<(f64, f64)>, f64) {
    let mut windows: Vec<(f64, f64)> = Vec::new();
    let mut segment_start = 0.0;
    for (index, segment) in timeline.segments.iter().enumerate() {
        let next_duration = timeline
            .effective_transition(index + 1)
            .map_or(0.0, |transition| transition.duration);
        let end = segment_start + segment.duration() - next_duration;
        if segment.hides_cursor() {
            match windows.last_mut() {
                Some(last) if (last.1 - segment_start).abs() < 1e-9 => last.1 = end,
                _ => windows.push((segment_start, end)),
            }
        }
        segment_start = end;
    }
    (windows, segment_start)
}

fn baseline_visibility(timeline: &TimelineConfiguration, output_time: f64) -> f64 {
    if !timeline.segments.iter().any(TimelineSegment::hides_cursor) {
        return 1.0;
    }
    let holds = timeline.hold_windows();
    let time = output_time - held_time_before(&holds, output_time);
    let (windows, total) = baseline_windows(timeline);
    for (start, end) in windows {
        if time < start || time >= end {
            continue;
        }
        let from_start = if start <= 1e-9 {
            f64::INFINITY
        } else {
            time - start
        };
        let from_end = if end >= total - 1e-9 {
            f64::INFINITY
        } else {
            end - time
        };
        let edge = from_start.min(from_end);
        if edge >= CLIP_CURSOR_FADE_SECS {
            return 0.0;
        }
        let t = (edge / CLIP_CURSOR_FADE_SECS).clamp(0.0, 1.0);
        return 1.0 - t * t * (3.0 - 2.0 * t);
    }
    1.0
}
