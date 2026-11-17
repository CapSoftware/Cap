use cap_project::{CursorClickEvent, CursorEvents, CursorMoveEvent};
use std::{
    collections::{HashSet, hash_map::DefaultHasher},
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn fixture(count: usize, pointer: &str, other: &str, brief: bool) -> CursorEvents {
    let id = |index: usize| {
        if index % 240 < if brief { 225 } else { 120 } {
            pointer
        } else {
            other
        }
    };
    CursorEvents {
        moves: (0..count)
            .map(|index| CursorMoveEvent {
                active_modifiers: Vec::new(),
                cursor_id: id(index).into(),
                time_ms: index as f64 * 1000.0 / 60.0,
                x: (index % 1920) as f64 / 1920.0,
                y: (index % 1080) as f64 / 1080.0,
            })
            .collect(),
        clicks: (0..count)
            .step_by(30)
            .map(|index| CursorClickEvent {
                active_modifiers: Vec::new(),
                cursor_id: id(index).into(),
                time_ms: index as f64 * 1000.0 / 60.0,
                cursor_num: 0,
                down: (index / 30) % 2 == 0,
            })
            .collect(),
    }
}

fn fingerprint(events: &CursorEvents) -> Result<u64, Box<dyn Error>> {
    let mut hash = DefaultHasher::new();
    bincode::serde::encode_to_vec(events, bincode::config::standard())?.hash(&mut hash);
    Ok(hash.finish())
}

fn main() -> Result<(), Box<dyn Error>> {
    println!("case,moves,clicks,sample,elapsed_ms,fingerprint");
    for (case, (count, pointer, other, brief, metadata)) in [
        (3_600, "0", "0", true, true),
        (36_000, "0", "1", false, true),
        (36_000, "0", "1", true, true),
        (216_000, "0", "1", true, true),
        (36_000, "0", "1", true, false),
        (36_000, "123", "0", true, true),
        (36_000, "pointer", "ibeam", true, true),
    ]
    .into_iter()
    .enumerate()
    {
        let source = fixture(count, pointer, other, brief);
        let pointers = HashSet::from([pointer.to_string()]);
        let pointers = metadata.then_some(&pointers);
        let mut expected = source.clone();
        expected.stabilize_short_lived_cursor_shapes(pointers, 1_000.0);
        let expected = fingerprint(&expected)?;
        for _ in 0..3 {
            let mut input = source.clone();
            input.stabilize_short_lived_cursor_shapes(pointers, 1_000.0);
            black_box(input);
        }
        for sample in 0..25 {
            let mut input = source.clone();
            let started = Instant::now();
            black_box(&mut input).stabilize_short_lived_cursor_shapes(pointers, 1_000.0);
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(fingerprint(&input)?, expected);
            println!(
                "{case},{},{},{sample},{elapsed_ms:.6},{expected}",
                input.moves.len(),
                input.clicks.len()
            );
        }
    }
    Ok(())
}
