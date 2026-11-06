use cap_gpui_kernels::frame as candidate;
use std::{hint::black_box, time::Instant};

fn main() {
    println!("workload,sample,before_ns,after_ns");
    for (name, width, height) in [
        ("thumbnail-4k", 3840usize, 2160usize),
        ("thumbnail-1440p", 2560, 1440),
        ("editor-crop-1248x702", 1248, 702),
        ("library-card-320x180", 320, 180),
    ] {
        let stride = width * 4;
        let source: Vec<u8> = (0..stride * height)
            .map(|i| (i * 31 + i / 7) as u8)
            .collect();
        let mut before_pixels = source.clone();
        baseline::swap_red_blue(&mut before_pixels);
        let mut after_pixels = source.clone();
        candidate::swap_red_blue(&mut after_pixels);
        assert_eq!(before_pixels, after_pixels, "{name}");
        for sample in 0..35 {
            let run = |f: fn(&mut [u8])| {
                let mut pixels = source.clone();
                let start = Instant::now();
                f(black_box(&mut pixels));
                let elapsed = start.elapsed().as_nanos();
                black_box(pixels);
                elapsed
            };
            let (old, new) = if sample % 2 == 0 {
                let old = run(baseline::swap_red_blue);
                (old, run(candidate::swap_red_blue))
            } else {
                let new = run(candidate::swap_red_blue);
                (run(baseline::swap_red_blue), new)
            };
            if sample >= 5 {
                println!("{name},{},{old},{new}", sample - 5);
            }
        }
    }
}

// Inlined from main so before/after share one build and the same inputs.
mod baseline {
    pub fn swap_red_blue(pixels: &mut [u8]) {
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
    }
}
