use cap_project::{CursorClickEvent, CursorEvents, CursorMoveEvent};
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    println!("case,moves,bytes,mode,sample,elapsed_ms,fingerprint");
    for (case, count) in [0, 3_600, 36_000, 216_000].into_iter().enumerate() {
        let events = CursorEvents {
            moves: (0..count)
                .map(|index| CursorMoveEvent {
                    active_modifiers: if index % 71 == 0 {
                        vec!["Shift".into()]
                    } else {
                        Vec::new()
                    },
                    cursor_id: (index / 3_600 % 3).to_string(),
                    time_ms: index as f64 * 1_000.0 / 60.0,
                    x: (index % 1_920) as f64 / 1_920.0,
                    y: (index % 1_080) as f64 / 1_080.0,
                })
                .collect(),
            clicks: (0..count / 300)
                .map(|index| CursorClickEvent {
                    active_modifiers: Vec::new(),
                    cursor_num: 0,
                    cursor_id: (index / 12 % 3).to_string(),
                    time_ms: index as f64 * 5_000.0,
                    down: index % 2 == 0,
                })
                .collect(),
        };
        let path = directory.path().join("cursor.json");
        let json = serde_json::to_vec(&events)?;
        std::fs::write(&path, &json)?;
        for mode in ["full", "clicks"] {
            let load = || -> Result<Vec<u8>, Box<dyn Error>> {
                if mode == "full" {
                    Ok(serde_json::to_vec(&CursorEvents::load_from_file(&path)?)?)
                } else {
                    Ok(serde_json::to_vec(&CursorEvents::load_clicks_from_file(
                        &path,
                    )?)?)
                }
            };
            for _ in 0..3 {
                black_box(load()?);
            }
            for sample in 0..25 {
                let start = Instant::now();
                let loaded = if mode == "full" {
                    let events = black_box(CursorEvents::load_from_file(black_box(&path))?);
                    let elapsed = start.elapsed();
                    (elapsed, serde_json::to_vec(&events)?)
                } else {
                    let clicks = black_box(CursorEvents::load_clicks_from_file(black_box(&path))?);
                    let elapsed = start.elapsed();
                    (elapsed, serde_json::to_vec(&clicks)?)
                };
                let mut hash = DefaultHasher::new();
                loaded.1.hash(&mut hash);
                println!(
                    "{case},{count},{},{mode},{sample},{:.6},{}",
                    json.len(),
                    loaded.0.as_secs_f64() * 1_000.0,
                    hash.finish()
                );
            }
        }
    }
    Ok(())
}
