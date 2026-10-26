use cap_media_info::AudioInfo;
use ffmpeg::format::{Sample, sample::Type};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    hint::black_box,
    time::Instant,
};

fn main() {
    println!("format,channels,frames,sample,ns_per_call,fingerprint");
    for (format, channels) in [
        (Sample::F32(Type::Packed), 1),
        (Sample::F32(Type::Packed), 2),
        (Sample::F32(Type::Packed), 8),
        (Sample::F32(Type::Packed), 16),
        (Sample::F32(Type::Packed), 32),
        (Sample::I16(Type::Packed), 16),
        (Sample::F64(Type::Packed), 16),
    ] {
        let info = AudioInfo::new_raw(format, 48_000, channels);
        for (frames, iterations) in [(64, 1000), (480, 500), (4096, 100)] {
            let bytes = (0..frames * usize::from(channels) * info.sample_size())
                .map(|index| (index * 97 + 31) as u8)
                .collect::<Vec<_>>();
            let wrap = || info.wrap_frame_with_max_channels(black_box(&bytes), black_box(8));
            let frame = wrap();
            assert_eq!(frame.samples(), frames);
            assert_eq!(frame.channels(), channels.min(8));
            let mut hash = DefaultHasher::new();
            let used = frames * usize::from(channels.min(8)) * info.sample_size();
            frame.data(0)[..used].hash(&mut hash);
            let fingerprint = hash.finish();
            for sample in 0..18 {
                let start = Instant::now();
                for _ in 0..iterations {
                    black_box(wrap());
                }
                let elapsed = start.elapsed().as_nanos() as f64 / iterations as f64;
                if sample >= 3 {
                    println!(
                        "{format:?},{channels},{frames},{},{elapsed:.3},{fingerprint}",
                        sample - 3
                    );
                }
            }
        }
    }
}
