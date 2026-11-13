use cap_gpui_kernels::screenshot as candidate;
use std::{hint::black_box, time::Instant};

type MaskFilter = fn(&[u8], u32, u32, (u32, u32, u32, u32), bool, f64) -> Option<image::RgbaImage>;

fn main() {
    println!("workload,sample,before_ns,after_ns");
    for (name, frame, region, level) in [
        (
            "1080p-400x300-default",
            (1920u32, 1080u32),
            (200, 150, 400, 300),
            16.,
        ),
        ("1080p-400x300-fine", (1920, 1080), (200, 150, 400, 300), 4.),
        (
            "4k-1200x800-default",
            (3840, 2160),
            (600, 400, 1200, 800),
            16.,
        ),
        (
            "4k-1200x800-coarse",
            (3840, 2160),
            (600, 400, 1200, 800),
            50.,
        ),
        ("4k-full-default", (3840, 2160), (0, 0, 3840, 2160), 16.),
    ] {
        let rgba: Vec<u8> = (0..frame.0 as usize * frame.1 as usize * 4)
            .map(|i| (i.wrapping_mul(31) % 251) as u8)
            .collect();
        let run = |f: MaskFilter| {
            let start = Instant::now();
            let image = f(
                black_box(&rgba),
                black_box(frame.0),
                black_box(frame.1),
                black_box(region),
                black_box(true),
                black_box(level),
            );
            (start.elapsed().as_nanos(), black_box(image))
        };
        assert_eq!(
            run(baseline::mask_filter).1.unwrap().into_raw(),
            run(candidate::mask_filter).1.unwrap().into_raw(),
            "{name}"
        );
        for sample in 0..25 {
            let (old, new) = if sample % 2 == 0 {
                let old = run(baseline::mask_filter).0;
                (old, run(candidate::mask_filter).0)
            } else {
                let new = run(candidate::mask_filter).0;
                (run(baseline::mask_filter).0, new)
            };
            if sample >= 5 {
                println!("{name},{},{old},{new}", sample - 5);
            }
        }
    }
}

mod baseline {
    pub fn mask_filter(
        rgba: &[u8],
        frame_width: u32,
        _frame_height: u32,
        (x0, y0, width, height): (u32, u32, u32, u32),
        _pixelate: bool,
        level: f64,
    ) -> Option<image::RgbaImage> {
        let stride = frame_width as usize * 4;
        let mut copied = Vec::with_capacity(width as usize * height as usize * 4);
        for row in 0..height {
            let start = (y0 + row) as usize * stride + x0 as usize * 4;
            copied.extend_from_slice(&rgba[start..start + width as usize * 4]);
        }
        let source = image::RgbaImage::from_raw(width, height, copied)?;
        let block = (level.round() as u32).max(2);
        let small = image::imageops::resize(
            &source,
            (width / block).max(1),
            (height / block).max(1),
            image::imageops::FilterType::Nearest,
        );
        Some(image::imageops::resize(
            &small,
            width,
            height,
            image::imageops::FilterType::Nearest,
        ))
    }
}
