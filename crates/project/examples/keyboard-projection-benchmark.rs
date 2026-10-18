use cap_project::{
    KeyPressEvent, KeyboardEvents, KeyboardSettings, RecordingMeta, TimelineConfiguration,
    generate_project_keyboard_segments,
};
use serde_json::json;
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    let iterations = std::env::args()
        .nth(1)
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(20);
    if iterations == 0 {
        return Err("iterations must be positive".into());
    }
    let selected = std::env::args()
        .nth(2)
        .map(|value| value.parse::<usize>())
        .transpose()?;
    if selected.is_some_and(|index| index > 2) {
        return Err("case must be 0, 1 or 2".into());
    }
    println!("source_seconds,clips,retained_seconds,sample,ms_per_generation");
    for (case, (duration, clip_count, clip_duration)) in
        [(600, 1, 600), (600, 20, 3), (3600, 60, 3)]
            .into_iter()
            .enumerate()
    {
        if selected.is_some_and(|index| index != case) {
            continue;
        }
        let directory = tempfile::tempdir()?;
        let presses = (0..duration * 4)
            .flat_map(|index| {
                [true, false].map(|down| KeyPressEvent {
                    key: "a".into(),
                    key_code: "KeyA".into(),
                    time_ms: (index * 250 + 170 + usize::from(!down) * 10) as f64,
                    down,
                })
            })
            .collect();
        KeyboardEvents { presses }.write_to_file(&directory.path().join("keyboard.bin"))?;
        let mut meta: RecordingMeta = serde_json::from_value(json!({
            "pretty_name": "synthetic-keyboard-projection",
            "segments": [
                {"display": {"path": "unused/display.mp4", "fps": 30, "start_time": 0.0}},
                {"display": {"path": "display.mp4", "fps": 30, "start_time": 0.07},
                 "keyboard": "keyboard.bin"}
            ],
            "cursors": {}
        }))?;
        meta.project_path = directory.path().to_path_buf();
        let clips: Vec<_> = (0..clip_count)
            .map(|index| {
                let start = if clip_count == 1 { 0 } else { (index + 1) * (duration / (clip_count + 1)) };
                json!({"recordingSegment": 1, "start": start, "end": start + clip_duration, "timescale": 1.0})
            })
            .collect();
        let timeline: TimelineConfiguration = serde_json::from_value(json!({
            "segments": clips,
            "zoomSegments": []
        }))?;
        assert!(
            timeline
                .segments
                .iter()
                .all(|clip| clip.recording_clip == 1)
        );
        let settings = KeyboardSettings::default();
        let expected_keys = clip_count * clip_duration * 4;
        let verify = || -> Result<u64, Box<dyn Error>> {
            let result = generate_project_keyboard_segments(&meta, &timeline, &settings)?;
            assert_eq!(
                result
                    .iter()
                    .map(|segment| segment.keys.len())
                    .sum::<usize>(),
                expected_keys
            );
            assert!(
                result
                    .iter()
                    .all(|segment| segment.display_text.chars().all(|key| key == 'a'))
            );
            assert!((result[0].start - 0.1).abs() < 1e-6);
            let mut fingerprint = DefaultHasher::new();
            serde_json::to_vec(&result)?.hash(&mut fingerprint);
            Ok(fingerprint.finish())
        };
        let fingerprint = verify()?;
        println!("verified,{duration},{clip_count},{expected_keys},{fingerprint}");
        for _ in 0..3 {
            black_box(generate_project_keyboard_segments(
                &meta, &timeline, &settings,
            )?);
        }
        for sample in 0..5 {
            let start = Instant::now();
            for _ in 0..iterations {
                black_box(generate_project_keyboard_segments(
                    black_box(&meta),
                    black_box(&timeline),
                    black_box(&settings),
                )?);
            }
            let elapsed = start.elapsed().as_secs_f64() * 1000.0 / iterations as f64;
            println!(
                "{duration},{clip_count},{},{sample},{elapsed:.6}",
                clip_count * clip_duration
            );
            assert_eq!(verify()?, fingerprint);
        }
    }
    Ok(())
}
