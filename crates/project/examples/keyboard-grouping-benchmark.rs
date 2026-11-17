use cap_project::{
    KeyPressEvent, KeyboardEvents, KeyboardSettings, RecordingMeta, TimelineConfiguration,
    generate_project_keyboard_segments, group_key_events,
};
use std::{hint::black_box, time::Instant};

fn fixture(key_count: usize, shortcuts: bool) -> KeyboardEvents {
    let mut presses = Vec::new();
    for index in 0..key_count {
        let time_ms = index as f64 * 100.0;
        if shortcuts && index % 20 == 0 {
            presses.push(event("LMeta", time_ms, true));
        }
        let key = ["h", "e", "l", "l", "o", "Space"][index % 6];
        presses.push(event(key, time_ms + 10.0, true));
        presses.push(event(key, time_ms + 40.0, false));
        if shortcuts && index % 20 == 3 {
            presses.push(event("LMeta", time_ms + 50.0, false));
        }
    }
    KeyboardEvents { presses }
}

fn event(key: &str, time_ms: f64, down: bool) -> KeyPressEvent {
    KeyPressEvent {
        key: key.into(),
        key_code: key.into(),
        time_ms,
        down,
    }
}

fn measure<T>(mut operation: impl FnMut() -> T) -> (f64, f64) {
    for _ in 0..3 {
        black_box(operation());
    }
    let mut times = Vec::new();
    for _ in 0..25 {
        let started = Instant::now();
        let output = black_box(operation());
        times.push(started.elapsed().as_secs_f64() * 1000.0);
        black_box(&output);
        drop(output);
    }
    times.sort_by(f64::total_cmp);
    (times[times.len() / 2], times[times.len() * 95 / 100])
}

fn main() {
    let check_scaling = std::env::args().any(|argument| argument == "--check-scaling");
    let mut outputs = Vec::new();
    let mut scaling_times = Vec::new();
    println!("fixture,keys,events,group_p50_ms,group_p95_ms,generate_p50_ms,generate_p95_ms");
    for shortcuts in [false, true] {
        for key_count in [100, 1_000, 5_000, 10_000, 36_000] {
            let events = fixture(key_count, shortcuts);
            let directory = tempfile::tempdir().unwrap();
            events
                .write_to_file(&directory.path().join("keyboard.bin"))
                .unwrap();
            let mut meta: RecordingMeta = serde_json::from_value(serde_json::json!({
                "pretty_name": "Keyboard benchmark",
                "segments": [{
                    "display": {"path": "display.mp4", "fps": 30, "start_time": 0.0},
                    "keyboard": "keyboard.bin"
                }],
                "cursors": {}
            }))
            .unwrap();
            meta.project_path = directory.path().to_path_buf();
            let timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
                "segments": [{"start": 0.0, "end": key_count as f64 / 10.0 + 1.0, "timescale": 1.0}],
                "zoomSegments": []
            }))
            .unwrap();
            let settings = KeyboardSettings::default();
            let group = || {
                group_key_events(
                    black_box(&events),
                    settings.grouping_threshold_ms,
                    f64::from(settings.linger_duration) * 1000.0,
                    settings.show_modifiers,
                    settings.show_special_keys,
                )
            };
            let generate = || {
                generate_project_keyboard_segments(
                    black_box(&meta),
                    black_box(&timeline),
                    black_box(&settings),
                )
                .unwrap()
            };
            let (group_p50, group_p95) = measure(group);
            let (generate_p50, generate_p95) = measure(generate);
            let name = if shortcuts { "shortcuts" } else { "typing" };
            println!(
                "{name},{key_count},{},{group_p50:.6},{group_p95:.6},{generate_p50:.6},{generate_p95:.6}",
                events.presses.len()
            );
            if !shortcuts && matches!(key_count, 5_000 | 10_000) {
                scaling_times.push(group_p50);
            }
            outputs.push(serde_json::json!({
                "fixture": name,
                "keys": key_count,
                "grouped": group(),
                "generated": generate()
            }));
        }
    }
    if let Some(path) = std::env::var_os("CAP_KEYBOARD_BENCH_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&outputs).unwrap()).unwrap();
    }
    if check_scaling {
        let ratio = scaling_times[1] / scaling_times[0];
        assert!(ratio < 3.0, "doubling key events took {ratio:.2}x as long");
    }
}
