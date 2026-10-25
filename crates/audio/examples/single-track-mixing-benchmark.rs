use cap_audio::{
    AudioData, AudioRendererTrack, AudioSampleSource, DecodedAudio, StereoMode, render_audio,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    hint::black_box,
    sync::Arc,
    time::Instant,
};

struct Indexed(DecodedAudio);
impl AudioSampleSource for Indexed {
    fn channels(&self) -> u16 {
        self.0.channels()
    }
    fn sample_count(&self) -> usize {
        self.0.sample_count()
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        self.0.sample(index)
    }
}

fn source(channels: u16, seed: usize) -> DecodedAudio {
    DecodedAudio::from(Arc::new(AudioData::from_samples(
        (0..192_000 * usize::from(channels))
            .map(|index| (((index * 97 + seed) % 1009) as f32 - 504.0) / 600.0)
            .collect(),
        channels,
    )))
}

fn measure<T: AudioSampleSource>(name: &str, data: &[T], gain: f32, offset: isize, mode: u8) {
    let tracks = data
        .iter()
        .map(|data| AudioRendererTrack {
            data,
            gain,
            offset,
            stereo_mode: match mode {
                1 => StereoMode::MonoL,
                2 => StereoMode::MonoR,
                _ => StereoMode::Stereo,
            },
        })
        .collect::<Vec<_>>();
    for (frames, iterations) in [(64, 4000), (1024, 500), (4096, 200)] {
        let mut output = vec![13.0_f32; frames * 2 + 4];
        for sample in 0..18 {
            let start = Instant::now();
            let mut rendered = 0;
            for call in 0..iterations {
                let cursor = 256 + (call * frames) % (192_000 - frames - 512);
                rendered += black_box(render_audio(
                    black_box(&tracks),
                    black_box(cursor),
                    black_box(frames),
                    2,
                    black_box(&mut output),
                ));
            }
            let elapsed = start.elapsed().as_nanos();
            assert_eq!(rendered, iterations * frames);
            assert_eq!(&output[..2], &[13.0; 2]);
            assert_eq!(&output[output.len() - 2..], &[13.0; 2]);
            if sample >= 3 {
                let mut hash = DefaultHasher::new();
                for value in &output {
                    value.to_bits().hash(&mut hash);
                }
                println!(
                    "MIX_BENCH {}",
                    serde_json::json!({
                        "case": name, "frames": frames, "sample": sample-3,
                        "ns_per_call": elapsed as f64 / iterations as f64,
                        "fingerprint": hash.finish(),
                    })
                );
            }
        }
    }
}

fn main() {
    let stereo = [source(2, 0), source(2, 7)];
    let mono = [source(1, 0)];
    measure("one_stereo_unity", &stereo[..1], 0.0, 0, 0);
    measure("one_stereo_gain", &stereo[..1], 6.0, 0, 0);
    measure("two_stereo", &stereo, -6.0, 0, 0);
    measure("mono", &mono, -6.0, 0, 0);
    measure("offset", &stereo[..1], -6.0, -64, 0);
    measure("left", &stereo[..1], -6.0, 0, 1);
    measure("muted", &stereo[..1], -30.0, 0, 0);
    let indexed = [Indexed(source(2, 0))];
    measure("indexed", &indexed, -6.0, 0, 0);
}
