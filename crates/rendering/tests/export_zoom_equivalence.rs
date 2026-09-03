use cap_project::{CursorClickEvent, CursorEvents, CursorMoveEvent, ProjectConfiguration, XY};
use cap_rendering::ZoomTransformTimeline;

fn project() -> ProjectConfiguration {
    ProjectConfiguration {
        timeline: Some(
        serde_json::from_value(serde_json::json!({
            "segments": [
                {"recordingClip": 0, "start": 2.0, "end": 14.0, "timescale": 1.5},
                {"recordingClip": 1, "start": 1.0, "end": 10.0, "timescale": 0.5},
                {"recordingClip": 0, "start": 0.0, "end": 4.0, "timescale": 1.0}
            ],
            "transitions": [
                {"segmentIndex": 0, "type": "cross-fade", "duration": 0.6},
                {"segmentIndex": 1, "type": "fade-through-black", "duration": 0.4}
            ],
            "zoomSegments": [
                {"start": 0.0, "end": 6.0, "amount": 2.0, "mode": "auto"},
                {"start": 6.0, "end": 9.0, "amount": 3.0, "mode": {"manual": {"x": 0.2, "y": 0.8}}},
                {"start": 11.0, "end": 14.0, "amount": 1.6, "mode": "auto", "instantAnimation": true},
                {"start": 18.0, "end": 25.0, "amount": 2.2, "mode": {"manual": {"x": 0.9, "y": 0.1}}}
            ]
        }))
        .unwrap(),
        ),
        ..ProjectConfiguration::default()
    }
}

fn cursor(clip: u32) -> CursorEvents {
    CursorEvents {
        moves: (0..250)
            .map(|i| CursorMoveEvent {
                time_ms: f64::from(i) * 60.0,
                x: f64::from((i * 7 + clip * 17) % 100) / 100.0,
                y: f64::from((i * 3 + clip * 23) % 100) / 100.0,
                cursor_id: "default".into(),
                active_modifiers: Vec::new(),
            })
            .collect(),
        clicks: (0..20)
            .map(|i| CursorClickEvent {
                time_ms: f64::from(i) * 630.0,
                cursor_num: 0,
                cursor_id: "default".into(),
                down: true,
                active_modifiers: Vec::new(),
            })
            .collect(),
    }
}

#[test]
fn incremental_export_zoom_matches_eager_across_clips_transitions_and_seeks() {
    let project = project();
    for clip in 0..2 {
        let cursor = cursor(clip);
        for outgoing in [false, true] {
            let make = || {
                if outgoing {
                    ZoomTransformTimeline::from_project_for_outgoing_clip(
                        &project,
                        &cursor,
                        30.0,
                        XY::new(1920, 1080),
                        clip,
                    )
                } else {
                    ZoomTransformTimeline::from_project_for_clip(
                        &project,
                        &cursor,
                        30.0,
                        XY::new(1920, 1080),
                        clip,
                    )
                }
            };
            let mut eager = make();
            eager.precompute();
            for fps in [24, 30, 60] {
                let mut incremental = make();
                for frame in 0..30 * fps {
                    let time = frame as f32 / fps as f32;
                    incremental.ensure_precomputed_until((frame + 1) as f32 / fps as f32);
                    let previous = (time - 1.0 / fps as f32).max(0.0);
                    assert_eq!(
                        eager.snapped_within(previous, time),
                        incremental.snapped_within(previous, time),
                    );
                    for query in [time, previous] {
                        let before = eager.sample(query);
                        let after = incremental.sample(query);
                        assert_eq!(before.t.to_bits(), after.t.to_bits());
                        for (a, b) in [
                            (before.bounds.top_left.x, after.bounds.top_left.x),
                            (before.bounds.top_left.y, after.bounds.top_left.y),
                            (before.bounds.bottom_right.x, after.bounds.bottom_right.x),
                            (before.bounds.bottom_right.y, after.bounds.bottom_right.y),
                        ] {
                            assert_eq!(
                                a.to_bits(),
                                b.to_bits(),
                                "clip={clip} outgoing={outgoing} fps={fps} frame={frame}"
                            );
                        }
                    }
                }
                for time in [0.0, 24.5, 6.0, 11.01, 0.0, 29.9] {
                    let mut seeked = make();
                    seeked.ensure_precomputed_until(time + 1.0 / fps as f32);
                    assert_eq!(eager.sample(time).bounds, seeked.sample(time).bounds);
                    assert_eq!(eager.sample(time).bounds, incremental.sample(time).bounds);
                }
            }
        }
    }
}

#[test]
#[ignore]
fn benchmark_long_recording_zoom_startup() {
    use std::{hint::black_box, time::Instant};
    let project = project();
    let cursor = cursor(0);
    for duration in [60.0, 8640.0, 72000.0] {
        let start = Instant::now();
        let mut eager = ZoomTransformTimeline::from_project_for_clip(
            &project,
            &cursor,
            duration,
            XY::new(1920, 1080),
            0,
        );
        eager.precompute();
        let eager_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        let mut incremental = ZoomTransformTimeline::from_project_for_clip(
            &project,
            &cursor,
            duration,
            XY::new(1920, 1080),
            0,
        );
        incremental.ensure_precomputed_until(1.0 / 60.0);
        let incremental_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(eager.sample(0.0).bounds, incremental.sample(0.0).bounds);
        black_box((eager, incremental));
        println!(
            "{}",
            serde_json::json!({"duration_seconds":duration,"eager_ms":eager_ms,"incremental_ms":incremental_ms,"scope":"zoom construction and first-frame simulation"})
        );
    }
}
