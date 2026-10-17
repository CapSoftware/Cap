use std::{hint::black_box, time::Instant};

use cap_gpui_kernels::codec::rgba_to_rgb;

fn baseline_rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|px| [px[0], px[1], px[2]])
        .collect()
}

fn main() {
    println!("workload,pixels,sample,before_ns,after_ns");
    for (name, width, height) in [
        ("thumbnail-320x180", 320u32, 180u32),
        ("preset-216x122", 216, 122),
        ("screen-720p", 1280, 720),
        ("screen-1080p", 1920, 1080),
        ("screen-retina", 3024, 1964),
        ("screen-4k", 3840, 2160),
    ] {
        let num_pixels = (width * height) as usize;
        let mut rgba = Vec::with_capacity(num_pixels * 4);
        for i in 0..num_pixels {
            rgba.push((i * 7) as u8);
            rgba.push((i * 13) as u8);
            rgba.push((i * 31) as u8);
            rgba.push(255);
        }

        let before = baseline_rgba_to_rgb(&rgba);
        let after = rgba_to_rgb(&rgba);
        assert_eq!(before, after, "mismatch on {name}");

        for sample in 0..25 {
            let (old_time, new_time) = if sample % 2 == 0 {
                let start_o = Instant::now();
                black_box(baseline_rgba_to_rgb(black_box(&rgba)));
                let o = start_o.elapsed().as_nanos();

                let start_n = Instant::now();
                black_box(rgba_to_rgb(black_box(&rgba)));
                let n = start_n.elapsed().as_nanos();
                (o, n)
            } else {
                let start_n = Instant::now();
                black_box(rgba_to_rgb(black_box(&rgba)));
                let n = start_n.elapsed().as_nanos();

                let start_o = Instant::now();
                black_box(baseline_rgba_to_rgb(black_box(&rgba)));
                let o = start_o.elapsed().as_nanos();
                (o, n)
            };

            if sample >= 5 {
                println!("{name},{num_pixels},{},{old_time},{new_time}", sample - 5);
            }
        }
    }
}
