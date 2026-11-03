use cap_project::{
    KeyPressEvent, KeyboardData, KeyboardEvents, KeyboardSettings, ProjectConfiguration,
    RecordingMeta, group_key_events, synchronize_legacy_keyboard,
};
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    let trials = std::env::args()
        .nth(1)
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(11);
    println!("groups,clips,operation,sample,ms_per_call,fingerprint");
    for (groups, clips) in [(30, 1), (300, 1), (3_000, 1), (3_000, 20)] {
        let directory = tempfile::tempdir()?;
        let events = KeyboardEvents {
            presses: (0..groups)
                .flat_map(|group| {
                    (0..7).flat_map(move |key| {
                        [true, false].map(move |down| KeyPressEvent {
                            key: if key == 6 { "Space".into() } else { "a".into() },
                            key_code: if key == 6 {
                                "Space".into()
                            } else {
                                "KeyA".into()
                            },
                            time_ms: group as f64 * 1_000.0
                                + key as f64 * 60.0
                                + f64::from(!down) * 10.0,
                            down,
                        })
                    })
                })
                .collect(),
        };
        events.write_to_file(&directory.path().join("keyboard.bin"))?;
        let settings = KeyboardSettings::default();
        let mut legacy = group_key_events(
            &events,
            settings.grouping_threshold_ms,
            f64::from(settings.linger_duration) * 1000.0,
            settings.show_modifiers,
            settings.show_special_keys,
        );
        assert_eq!(legacy.len(), groups);
        for (index, group) in legacy.iter_mut().enumerate() {
            group.color_override = Some(format!("#{index:06x}"));
        }
        let segments: Vec<_> = (0..clips).map(|index| {
            let start = index as f64 * groups as f64 / clips as f64;
            serde_json::json!({"start":start,"end":start+groups as f64/clips as f64,"timescale":1.0,"recordingSegment":0})
        }).collect();
        let project = ProjectConfiguration {
            keyboard: Some(KeyboardData { settings }),
            timeline: Some(serde_json::from_value(serde_json::json!({
                "segments": segments, "zoomSegments": [], "keyboardSegments": legacy,
            }))?),
            ..Default::default()
        };
        project.write(directory.path())?;
        let mut meta: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name":"keyboard migration benchmark",
            "segments":[{"display":{"path":"unused.mp4","fps":30,"start_time":0.0},"keyboard":"keyboard.bin"}],
            "cursors":{}
        }))?;
        meta.project_path = directory.path().to_path_buf();
        for operation in ["migrate", "load_and_migrate", "current_track"] {
            let mut current = project.clone();
            synchronize_legacy_keyboard(&meta, &mut current);
            let mut fingerprint = DefaultHasher::new();
            serde_json::to_vec(&current)?.hash(&mut fingerprint);
            let fingerprint = fingerprint.finish();
            for sample in 0..trials + 3 {
                let mut input = match operation {
                    "current_track" => current.clone(),
                    "load_and_migrate" => ProjectConfiguration::default(),
                    _ => project.clone(),
                };
                let started = Instant::now();
                if operation == "load_and_migrate" {
                    input = meta.project_config();
                }
                synchronize_legacy_keyboard(black_box(&meta), black_box(&mut input));
                black_box(&input);
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                let mut actual = DefaultHasher::new();
                serde_json::to_vec(&input)?.hash(&mut actual);
                assert_eq!(actual.finish(), fingerprint);
                if sample >= 3 {
                    println!(
                        "{groups},{clips},{operation},{},{ms:.6},{fingerprint}",
                        sample - 3
                    );
                }
            }
        }
    }
    Ok(())
}
