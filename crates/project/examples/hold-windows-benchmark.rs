use cap_project::TimelineConfiguration;
use serde_json::json;
use std::{error::Error, hint::black_box, time::Instant};

fn main() -> Result<(), Box<dyn Error>> {
    let iterations = std::env::args()
        .nth(1)
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(100_000);
    if iterations == 0 {
        return Err("iterations must be positive".into());
    }
    println!("segments,overlapping,operation,sample,ns_per_call");
    for count in [0_usize, 1, 8, 32, 128] {
        for overlapping in [false, true] {
            let text_segments: Vec<_> = (0..count)
                .map(|index| {
                    let start = if overlapping {
                        (index / 2) as f64 * 3.0 + (index % 2) as f64 * 0.25
                    } else {
                        index as f64 * 3.0
                    };
                    json!({"start": start, "end": start + 0.5, "layout": "fullscreen"})
                })
                .collect();
            let timeline: TimelineConfiguration = serde_json::from_value(json!({
                "segments": [{"start": 0.0, "end": 3600.0, "timescale": 1.0, "recordingSegment": 0}],
                "zoomSegments": [],
                "textSegments": text_segments
            }))?;
            let expected_count = if overlapping {
                count.div_ceil(2)
            } else {
                count
            };
            assert_eq!(timeline.hold_windows().len(), expected_count);
            let frame_time = count as f64 * 3.0 + 1.0;
            assert!(timeline.get_frame_mapping(frame_time).is_some());
            for sample in 0..5 {
                for _ in 0..1000 {
                    black_box(black_box(&timeline).hold_windows());
                    black_box(black_box(&timeline).get_frame_mapping(black_box(frame_time)));
                }
                let start = Instant::now();
                for _ in 0..iterations {
                    black_box(black_box(&timeline).hold_windows());
                }
                let elapsed = start.elapsed().as_nanos() as f64 / iterations as f64;
                println!("{count},{overlapping},hold_windows,{sample},{elapsed:.3}");
                let start = Instant::now();
                for _ in 0..iterations {
                    black_box(black_box(&timeline).get_frame_mapping(black_box(frame_time)));
                }
                let elapsed = start.elapsed().as_nanos() as f64 / iterations as f64;
                println!("{count},{overlapping},frame_mapping,{sample},{elapsed:.3}");
            }
        }
    }
    Ok(())
}
