use cap_project::{ClipTransition, ClipTransitionType, TimelineConfiguration};
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    println!("clips,stride,sample,ns_per_mapping,fingerprint");
    for (clips, stride) in [(20, 0), (20, 1), (20, 4), (100, 1), (100, 4), (1_000, 1)] {
        let segments: Vec<_> = (0..clips)
            .map(|index| {
                let start = (index % 3) as f64 * 0.125;
                serde_json::json!({
                    "start": start,
                    "end": start + 2.0 + (index % 7) as f64 * 0.5,
                    "timescale": ([1.0, 0.5, 2.0][index % 3]),
                    "recordingSegment": index % 3,
                })
            })
            .collect();
        let mut timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": segments,
            "zoomSegments": [],
        }))?;
        if stride != 0 {
            timeline.transitions = (1..clips)
                .filter(|index| index % stride == 0)
                .map(|index| ClipTransition {
                    segment_index: index as u32,
                    kind: if index % 2 == 0 {
                        ClipTransitionType::CrossFade
                    } else {
                        ClipTransitionType::FadeThroughBlack
                    },
                    duration: 0.25,
                })
                .collect();
        }
        let duration = timeline.duration();
        let times: Vec<_> = (0..1_024)
            .map(|index| duration * index as f64 / 1_024.0)
            .collect();
        let mut output = vec![None; times.len()];
        for iteration in 0..28 {
            let started = Instant::now();
            for (result, time) in output.iter_mut().zip(&times) {
                *result = black_box(black_box(&timeline).get_frame_mapping(black_box(*time)));
            }
            let elapsed_ns = started.elapsed().as_nanos() as f64 / times.len() as f64;
            let mut hash = DefaultHasher::new();
            format!("{output:?}").hash(&mut hash);
            assert!(output.iter().all(Option::is_some));
            if iteration >= 3 {
                println!(
                    "{clips},{stride},{},{elapsed_ns:.6},{}",
                    iteration - 3,
                    hash.finish()
                );
            }
        }
    }
    Ok(())
}
