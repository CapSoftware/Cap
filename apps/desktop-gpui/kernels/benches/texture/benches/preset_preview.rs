use cap_gpui_texture_bench::{PRESETS, Preset, candidate_preview, reference_preview};
use std::{hint::black_box, time::Instant};

fn measure(presets: &[Preset<'_>], preview: fn(&Preset<'_>, u32, u32) -> image::RgbaImage) -> f64 {
    let start = Instant::now();
    for preset in black_box(presets) {
        black_box(preview(black_box(preset), black_box(216), black_box(122)));
    }
    start.elapsed().as_secs_f64() * 1000.
}

fn percentile(samples: &[f64], percentile: usize) -> f64 {
    samples[(samples.len() - 1) * percentile / 100]
}

fn main() {
    for preset in PRESETS {
        assert_eq!(
            reference_preview(preset, 216, 122),
            candidate_preview(preset, 216, 122),
            "{}",
            preset.name
        );
    }
    println!("workload,samples,before_p50_ms,after_p50_ms,before_p95_ms,after_p95_ms,speedup");
    benchmark("nine_216x122_presets", PRESETS);
    for preset in PRESETS {
        benchmark(preset.name, std::slice::from_ref(preset));
    }
}

fn benchmark(name: &str, presets: &[Preset<'_>]) {
    for _ in 0..10 {
        black_box(measure(presets, reference_preview));
        black_box(measure(presets, candidate_preview));
    }
    let mut before = Vec::with_capacity(101);
    let mut after = Vec::with_capacity(101);
    for sample in 0..101 {
        if sample % 2 == 0 {
            before.push(measure(presets, reference_preview));
            after.push(measure(presets, candidate_preview));
        } else {
            after.push(measure(presets, candidate_preview));
            before.push(measure(presets, reference_preview));
        }
    }
    before.sort_by(f64::total_cmp);
    after.sort_by(f64::total_cmp);
    println!(
        "{name},101,{:.3},{:.3},{:.3},{:.3},{:.2}",
        percentile(&before, 50),
        percentile(&after, 50),
        percentile(&before, 95),
        percentile(&after, 95),
        percentile(&before, 50) / percentile(&after, 50)
    );
}
