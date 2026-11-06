use cap_project::{KeyPressEvent, KeyboardEvents, KeyboardEventsEncoder};
use std::{error::Error, hint::black_box, time::Instant};

const FLUSHES: usize = 720;
const PRESSES_PER_FLUSH: usize = 100;

fn press(index: usize) -> KeyPressEvent {
    KeyPressEvent {
        key: ["a", "文字🖱", "Space", "LControl"][index % 4].into(),
        key_code: "KeyA".into(),
        time_ms: index as f64 * 50.25,
        down: index % 2 == 0,
    }
}

fn batch(flush: usize) -> Vec<KeyPressEvent> {
    (flush * PRESSES_PER_FLUSH..(flush + 1) * PRESSES_PER_FLUSH)
        .map(press)
        .collect()
}

fn whole(batches: &[Vec<KeyPressEvent>]) -> Result<(f64, f64, Vec<u8>), Box<dyn Error>> {
    let mut events = KeyboardEvents::default();
    let mut total = 0.0;
    let mut last_flush = 0.0;
    let mut bytes = Vec::new();
    for batch in batches {
        let started = Instant::now();
        events.presses.extend(batch.iter().cloned());
        bytes = black_box(events.to_bytes()?);
        last_flush = started.elapsed().as_secs_f64() * 1000.0;
        total += last_flush;
    }
    Ok((total, last_flush, bytes))
}

fn incremental(batches: &[Vec<KeyPressEvent>]) -> Result<(f64, f64, Vec<u8>), Box<dyn Error>> {
    let mut encoder = KeyboardEventsEncoder::default();
    let mut total = 0.0;
    let mut last_flush = 0.0;
    for batch in batches {
        let started = Instant::now();
        for press in batch {
            encoder.push(press)?;
        }
        black_box(encoder.header()?);
        black_box(encoder.presses());
        last_flush = started.elapsed().as_secs_f64() * 1000.0;
        total += last_flush;
    }
    let mut bytes = encoder.header()?;
    bytes.extend_from_slice(encoder.presses());
    Ok((total, last_flush, bytes))
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let samples: usize = arguments.next().unwrap_or_else(|| "5".into()).parse()?;
    if samples == 0 || arguments.next().is_some() {
        return Err("expected one positive sample count".into());
    }
    let batches: Vec<_> = (0..FLUSHES).map(batch).collect();
    let expected = KeyboardEvents {
        presses: batches.iter().flatten().cloned().collect(),
    }
    .to_bytes()?;
    println!("sample,mode,events,flushes,total_ms,last_flush_ms,bytes");
    for sample in 0..samples {
        let mut modes = [
            ("whole", whole as fn(&[Vec<KeyPressEvent>]) -> _),
            ("incremental", incremental),
        ];
        if sample % 2 == 1 {
            modes.reverse();
        }
        for (mode, run) in modes {
            let (total, last_flush, bytes) = run(&batches)?;
            assert_eq!(bytes, expected);
            println!(
                "{sample},{mode},{},{FLUSHES},{total:.3},{last_flush:.4},{}",
                FLUSHES * PRESSES_PER_FLUSH,
                bytes.len()
            );
        }
    }
    Ok(())
}
