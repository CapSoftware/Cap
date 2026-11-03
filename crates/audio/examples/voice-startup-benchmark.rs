use cap_audio::{AudioSampleSource, VoiceEnhancer, VoiceProfile};
use std::{
    collections::hash_map::DefaultHasher,
    error::Error,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

struct Source {
    samples: Vec<f32>,
    channels: u16,
}
impl AudioSampleSource for Source {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_count(&self) -> usize {
        self.samples.len() / usize::from(self.channels)
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        self.samples.get(index)
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    ffmpeg::init()?;
    println!("channels,profile,case,frames,sample,elapsed_ms,fingerprint");
    for channels in [1, 2] {
        let source = Source {
            channels,
            samples: (0..96_000 * usize::from(channels))
                .map(|index| {
                    let seed = (index as u32)
                        .wrapping_mul(1_664_525)
                        .wrapping_add(1_013_904_223);
                    let time = (index / usize::from(channels)) as f32 / 48_000.0;
                    (std::f32::consts::TAU * 180.0 * time).sin() * 0.12
                        + (seed as f64 / u32::MAX as f64 * 0.04 - 0.02) as f32
                })
                .collect(),
        };
        for profile in [false, true] {
            let create = || {
                if profile {
                    VoiceEnhancer::with_settings(channels, 0.9, VoiceProfile::default())
                } else {
                    VoiceEnhancer::new(channels)
                }
            };
            for (case, frames) in [
                ("startup", 1),
                ("startup", 1_024),
                ("startup", 4_096),
                ("startup", 24_000),
                ("seek", 4_096),
                ("fresh-seek", 4_096),
            ] {
                for sample in 0..28 {
                    let mut prepared = (case == "seek").then(|| {
                        let mut enhancer = create();
                        black_box(enhancer.render(&source, 0, 4_096));
                        enhancer
                    });
                    let started = Instant::now();
                    let mut enhancer = prepared.take().unwrap_or_else(create);
                    let audio = black_box(enhancer.render(
                        black_box(&source),
                        if case.ends_with("seek") { 48_000 } else { 0 },
                        frames,
                    ));
                    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
                    assert_eq!(audio.samples().len(), frames * usize::from(channels));
                    let mut hash = DefaultHasher::new();
                    for value in audio.samples() {
                        value.to_bits().hash(&mut hash);
                    }
                    enhancer.speech_frames().hash(&mut hash);
                    if sample >= 3 {
                        println!(
                            "{channels},{profile},{case},{frames},{},{elapsed_ms:.6},{}",
                            sample - 3,
                            hash.finish()
                        );
                    }
                }
            }
        }
    }
    Ok(())
}
