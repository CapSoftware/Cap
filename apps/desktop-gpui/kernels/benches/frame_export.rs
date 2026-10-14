//! Run: cargo bench -p cap-gpui-kernels --bench frame_export --release

use cap_gpui_kernels::{
    codec as candidate_codec, frame as candidate_frame, screenshot as candidate,
};
use std::{hint::black_box, time::Instant};

fn opaque_rgba(pixels: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(pixels * 4);
    for i in 0..pixels {
        rgba.extend_from_slice(&[
            (i & 0xFF) as u8,
            ((i >> 8) & 0xFF) as u8,
            (i.wrapping_mul(17) & 0xFF) as u8,
            255,
        ]);
    }
    rgba
}

fn mixed_rgba(pixels: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(pixels * 4);
    for i in 0..pixels {
        rgba.extend_from_slice(&[
            (i & 0xFF) as u8,
            ((i >> 8) & 0xFF) as u8,
            (i.wrapping_mul(17) & 0xFF) as u8,
            if i % 7 == 0 { (i % 200) as u8 } else { 255 },
        ]);
    }
    rgba
}

fn fused_two_step(rgba: &[u8]) -> Vec<u8> {
    baseline::rgba_to_rgb(&baseline::flatten_onto_white(rgba))
}

fn run_flatten(name: &str, rgba: &[u8]) {
    assert_eq!(
        baseline::flatten_onto_white(rgba),
        candidate::flatten_onto_white(rgba),
        "{name}"
    );
    emit(
        name,
        baseline::flatten_onto_white,
        candidate::flatten_onto_white,
        rgba,
    );
}

fn run_strip(name: &str, rgba: &[u8]) {
    assert_eq!(
        baseline::rgba_to_rgb(rgba),
        candidate_codec::rgba_to_rgb(rgba),
        "{name}"
    );
    emit(
        name,
        baseline::rgba_to_rgb,
        candidate_codec::rgba_to_rgb,
        rgba,
    );
}

fn run_swap(name: &str, rgba: &[u8]) {
    let mut before = rgba.to_vec();
    let mut after = rgba.to_vec();
    baseline::swap_red_blue(&mut before);
    candidate_frame::swap_red_blue(&mut after);
    assert_eq!(before, after, "{name}");
    for sample in 0..30 {
        let (old, new) = if sample % 2 == 0 {
            (
                timed_swap(baseline::swap_red_blue, rgba),
                timed_swap(candidate_frame::swap_red_blue, rgba),
            )
        } else {
            let new = timed_swap(candidate_frame::swap_red_blue, rgba);
            let old = timed_swap(baseline::swap_red_blue, rgba);
            (old, new)
        };
        if sample >= 5 {
            println!("{name},{},{old},{new}", sample - 5);
        }
    }
}

fn run_fused(name: &str, rgba: &[u8]) {
    assert_eq!(
        fused_two_step(rgba),
        candidate_codec::flatten_rgba_to_rgb_over_white(rgba),
        "{name}"
    );
    emit(
        name,
        fused_two_step,
        candidate_codec::flatten_rgba_to_rgb_over_white,
        rgba,
    );
}

fn timed_swap(f: fn(&mut [u8]), rgba: &[u8]) -> u128 {
    let mut work = rgba.to_vec();
    let start = Instant::now();
    f(black_box(&mut work));
    black_box(work);
    start.elapsed().as_nanos()
}

fn emit<T>(name: &str, before: fn(T) -> Vec<u8>, after: fn(T) -> Vec<u8>, input: T)
where
    T: Copy,
{
    for sample in 0..30 {
        let (old, new) = if sample % 2 == 0 {
            (timed(before, input), timed(after, input))
        } else {
            let new = timed(after, input);
            let old = timed(before, input);
            (old, new)
        };
        if sample >= 5 {
            println!("{name},{},{old},{new}", sample - 5);
        }
    }
}

fn timed<T>(f: fn(T) -> Vec<u8>, input: T) -> u128
where
    T: Copy,
{
    let start = Instant::now();
    black_box(f(black_box(input)));
    start.elapsed().as_nanos()
}

fn main() {
    let hd = opaque_rgba(1920 * 1080);
    let uhd_opaque = opaque_rgba(3840 * 2160);
    let uhd_mixed = mixed_rgba(3840 * 2160);
    println!("workload,sample,before_ns,after_ns");
    run_flatten("flatten-opaque-1080p", &hd);
    run_flatten("flatten-opaque-4k", &uhd_opaque);
    run_flatten("flatten-mixed-4k", &uhd_mixed);
    run_strip("rgba-strip-4k", &uhd_opaque);
    run_swap("swap-4k", &uhd_opaque);
    run_fused("export-fused-4k", &uhd_mixed);
}

mod baseline {
    pub fn rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
        rgba.chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect()
    }

    pub fn swap_red_blue(pixels: &mut [u8]) {
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
    }

    pub fn flatten_onto_white(rgba: &[u8]) -> Vec<u8> {
        let mut rgba = rgba.to_vec();
        for pixel in rgba.chunks_exact_mut(4) {
            let alpha = u32::from(pixel[3]);
            for channel in &mut pixel[..3] {
                *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
            }
            pixel[3] = 255;
        }
        rgba
    }
}
