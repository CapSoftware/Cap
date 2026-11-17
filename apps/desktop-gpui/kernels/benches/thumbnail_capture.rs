use cap_gpui_kernels::thumbnail::{fit_centered, fit_centered_capture};
use image::{DynamicImage, RgbImage, RgbaImage};
use std::{hint::black_box, time::Instant};

fn timed(image: &DynamicImage, fit: fn(DynamicImage) -> RgbaImage) -> u128 {
    let input = image.clone();
    let start = Instant::now();
    black_box(fit(black_box(input)));
    start.elapsed().as_nanos()
}

fn before(image: DynamicImage) -> RgbaImage {
    fit_centered(&image.into_rgba8(), 320, 180)
}

fn after(image: DynamicImage) -> RgbaImage {
    fit_centered_capture(image, 320, 180)
}

fn main() {
    println!("workload,width,height,sample,before_ns,after_ns");
    for (name, width, height, alpha) in [
        ("display-1080p", 1920, 1080, false),
        ("display-1440p", 2560, 1440, false),
        ("display-ultrawide", 3440, 1440, false),
        ("display-4k", 3840, 2160, false),
        ("display-5k", 5120, 2880, false),
        ("window-4k-rounded", 3840, 2160, true),
    ] {
        let image = if alpha {
            DynamicImage::ImageRgba8(RgbaImage::from_fn(width, height, |x, y| {
                image::Rgba([
                    (x * 17 + y) as u8,
                    (x + y * 11) as u8,
                    (x * 3 + y * 5) as u8,
                    if x < 12 && y < 12 { 0 } else { 255 },
                ])
            }))
        } else {
            DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
                image::Rgb([
                    (x * 17 + y) as u8,
                    (x + y * 11) as u8,
                    (x * 3 + y * 5) as u8,
                ])
            }))
        };
        for sample in 0..25 {
            let (before_ns, after_ns) = if sample % 2 == 0 {
                let before_ns = timed(&image, before);
                (before_ns, timed(&image, after))
            } else {
                let after_ns = timed(&image, after);
                (timed(&image, before), after_ns)
            };
            if sample >= 5 {
                println!(
                    "{name},{width},{height},{},{before_ns},{after_ns}",
                    sample - 5
                );
            }
        }
    }
}
