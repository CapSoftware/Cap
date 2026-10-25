use cap_audio::waveform_peaks;
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

#[inline(never)]
fn peaks(blocks: &[&[f32]], channels: u16) -> Vec<f32> {
    waveform_peaks(blocks.iter().copied(), channels)
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let seconds: usize = arguments.next().unwrap_or_else(|| "600".into()).parse()?;
    let channels: u16 = arguments.next().unwrap_or_else(|| "1".into()).parse()?;
    let samples: usize = arguments.next().unwrap_or_else(|| "25".into()).parse()?;
    if seconds == 0
        || seconds > 3600
        || !(1..=2).contains(&channels)
        || samples == 0
        || arguments.next().is_some()
    {
        return Err("expected seconds (1..=3600), channels (1..=2), samples (>0)".into());
    }
    let mut state = 0x1234_5678_u32;
    let source: Vec<f32> = (0..seconds * 48_000 * usize::from(channels))
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as f32 / u32::MAX as f32 * 2.0 - 1.0
        })
        .collect();
    let window = 4800 * usize::from(channels);
    let expected: Vec<f32> = source
        .chunks(window)
        .map(|chunk| {
            let average =
                chunk.iter().fold(0.0_f32, |sum, value| sum + value.abs()) / chunk.len() as f32;
            if average > 0.0 {
                20.0 * average.log10()
            } else {
                -60.0
            }
        })
        .collect();
    let expected_bits: Vec<_> = expected.iter().map(|value| value.to_bits()).collect();
    println!("seconds,channels,layout,sample,elapsed_ms,fingerprint");
    for layout in ["contiguous", "decoded-blocks"] {
        let owned: Vec<Vec<f32>> = if layout == "decoded-blocks" {
            source
                .chunks(32768 * usize::from(channels))
                .map(<[f32]>::to_vec)
                .collect()
        } else {
            Vec::new()
        };
        let blocks: Vec<&[f32]> = if layout == "decoded-blocks" {
            owned.iter().map(Vec::as_slice).collect()
        } else {
            vec![&source]
        };
        for sample in 0..samples + 3 {
            let started = Instant::now();
            let actual = black_box(peaks(black_box(&blocks), black_box(channels)));
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            let bits: Vec<_> = actual.iter().map(|value| value.to_bits()).collect();
            assert_eq!(bits, expected_bits);
            let mut hash = DefaultHasher::new();
            bits.hash(&mut hash);
            if sample >= 3 {
                println!(
                    "{seconds},{channels},{layout},{},{elapsed_ms:.6},{}",
                    sample - 3,
                    hash.finish()
                );
            }
        }
    }
    Ok(())
}
