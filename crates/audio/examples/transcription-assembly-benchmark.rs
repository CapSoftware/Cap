use cap_audio::{TranscriptionAudioSource, TranscriptionAudioTake, append_transcription_audio};
use std::{error::Error, hint::black_box, io, time::Instant};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let seconds: usize = args
        .next()
        .ok_or_else(|| {
            io::Error::other("Expected duration in seconds and mic, system or mic-system")
        })?
        .parse()?;
    let mode = args.next().unwrap_or_else(|| "mic".to_string());
    let repetitions: usize = args.next().unwrap_or_else(|| "25".into()).parse()?;
    if seconds == 0
        || seconds > 3600
        || !matches!(mode.as_str(), "mic" | "system" | "mic-system")
        || repetitions == 0
        || args.next().is_some()
    {
        return Err(io::Error::other(
            "Expected seconds (1..=3600), mic/system/mic-system, repetitions (>0)",
        )
        .into());
    }
    let rate = 48_000;
    let frames = seconds * rate;
    let samples = |channels| {
        (0..frames * channels)
            .map(|index| ((index % 4096) as f32 - 2048.0) / 2048.0)
            .collect()
    };
    let mut sources = Vec::new();
    if mode == "mic-system" || mode == "system" {
        sources.push(TranscriptionAudioSource {
            samples: samples(2),
            channels: 2,
            offset_secs: 0.0,
        });
    }
    if mode != "system" {
        sources.push(TranscriptionAudioSource {
            samples: samples(1),
            channels: 1,
            offset_secs: if mode == "mic-system" { -0.125 } else { 0.0 },
        });
    }
    let take = TranscriptionAudioTake {
        display_duration_secs: seconds as f64,
        sources,
    };
    println!("mode,seconds,sample,assembly_ms,frames,fingerprint");
    let mut expected_checksum = None;
    for sample in 0..repetitions + 3 {
        let mut output = Vec::new();
        let started = Instant::now();
        append_transcription_audio(black_box(&mut output), black_box(&take), rate as u32)
            .map_err(io::Error::other)?;
        let elapsed = started.elapsed();
        assert_eq!(output.len(), frames);
        let checksum = black_box(&output).iter().fold(0_u64, |hash, sample| {
            hash.wrapping_mul(31)
                .wrapping_add(u64::from(sample.to_bits()))
        });
        if let Some(expected) = expected_checksum {
            assert_eq!(checksum, expected);
        } else {
            expected_checksum = Some(checksum);
        }
        if sample >= 3 {
            println!(
                "{mode},{seconds},{},{:.6},{},{checksum:016x}",
                sample - 3,
                elapsed.as_secs_f64() * 1000.0,
                output.len(),
            );
        }
    }
    Ok(())
}
