use cap_project::{KeyPressEvent, KeyboardEvents};
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn fixture(count: usize, unicode: bool) -> KeyboardEvents {
    KeyboardEvents {
        presses: (0..count)
            .map(|index| KeyPressEvent {
                key: if unicode {
                    ["a", "文字🖱", "Space", "LControl"][index % 4]
                } else {
                    "a"
                }
                .into(),
                key_code: "KeyA".into(),
                time_ms: index as f64 * 50.25,
                down: index % 2 == 0,
            })
            .collect(),
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let iterations: usize = arguments.next().unwrap_or_else(|| "10".into()).parse()?;
    if iterations == 0 || arguments.next().is_some() {
        return Err("expected one positive iteration count".into());
    }
    println!("case,events,unicode,sample,elapsed_ms,bytes,capacity,fingerprint");
    for (case, (count, unicode)) in [
        (0, false),
        (1_000, false),
        (1_000, true),
        (72_000, false),
        (72_000, true),
    ]
    .into_iter()
    .enumerate()
    {
        let events = fixture(count, unicode);
        let expected = events.to_bytes()?;
        let decoded = KeyboardEvents::from_bytes(&expected, std::path::Path::new("keyboard.bin"))?;
        assert_eq!(decoded.presses, events.presses);
        let mut hasher = DefaultHasher::new();
        expected.hash(&mut hasher);
        let fingerprint = hasher.finish();
        for _ in 0..3 {
            black_box(events.to_bytes()?);
        }
        for sample in 0..25 {
            let started = Instant::now();
            for _ in 0..iterations {
                black_box(black_box(&events).to_bytes()?);
            }
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0 / iterations as f64;
            let output = events.to_bytes()?;
            assert_eq!(output, expected);
            println!(
                "{case},{count},{unicode},{sample},{elapsed_ms:.6},{},{},{fingerprint}",
                output.len(),
                output.capacity()
            );
        }
    }
    Ok(())
}
