use cap_gpui_kernels::{codec as candidate_codec, screenshot as candidate};
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

fn transparent_rgba(pixels: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(pixels * 4);
    for i in 0..pixels {
        rgba.extend_from_slice(&[
            (i & 0xFF) as u8,
            ((i >> 8) & 0xFF) as u8,
            (i.wrapping_mul(17) & 0xFF) as u8,
            0,
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

fn run_presized(name: &str, rgba: &[u8]) {
    assert_eq!(
        baseline::flatten_rgba_to_rgb_over_white(rgba),
        candidate_codec::flatten_rgba_to_rgb_over_white(rgba),
        "{name}"
    );
    emit(
        name,
        baseline::flatten_rgba_to_rgb_over_white,
        candidate_codec::flatten_rgba_to_rgb_over_white,
        rgba,
    );
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
    let uhd_transparent = transparent_rgba(3840 * 2160);
    let uhd_mixed = mixed_rgba(3840 * 2160);
    println!("workload,sample,before_ns,after_ns");
    run_flatten("flatten-opaque-1080p", &hd);
    run_flatten("flatten-opaque-4k", &uhd_opaque);
    run_flatten("flatten-mixed-4k", &uhd_mixed);
    run_strip("rgba-strip-4k", &uhd_opaque);
    run_fused("export-fused-4k", &uhd_mixed);
    run_presized("flatten-rgb-opaque-4k", &uhd_opaque);
    run_presized("flatten-rgb-transparent-4k", &uhd_transparent);
    run_presized("flatten-rgb-mixed-4k", &uhd_mixed);
}

mod baseline {
    pub fn rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
        rgba.chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect()
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

    pub fn flatten_rgba_to_rgb_over_white(rgba: &[u8]) -> Vec<u8> {
        let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
        for px in rgba.chunks_exact(4) {
            let alpha = px[3];
            if alpha == 255 {
                rgb.extend_from_slice(&[px[0], px[1], px[2]]);
            } else if alpha == 0 {
                rgb.extend_from_slice(&[255, 255, 255]);
            } else {
                let a = u32::from(alpha);
                let inv = 255 - a;
                rgb.extend_from_slice(&[
                    ((u32::from(px[0]) * a + 255 * inv + 127) / 255) as u8,
                    ((u32::from(px[1]) * a + 255 * inv + 127) / 255) as u8,
                    ((u32::from(px[2]) * a + 255 * inv + 127) / 255) as u8,
                ]);
            }
        }
        rgb
    }
}
