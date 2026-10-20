use cap_gpui_kernels::thumbnail::fit_centered;
use image::RgbaImage;
use std::{hint::black_box, time::Instant};

type Fit = fn(&RgbaImage, u32, u32) -> RgbaImage;
const FITS_PER_SAMPLE: u128 = 8;

fn timed(fit: Fit, rgba: &RgbaImage) -> u128 {
    let start = Instant::now();
    for _ in 0..FITS_PER_SAMPLE {
        black_box(fit(black_box(rgba), black_box(320), black_box(180)));
    }
    start.elapsed().as_nanos() / FITS_PER_SAMPLE
}

fn main() {
    println!("workload,width,height,fits_per_sample,sample,before_ns,after_ns");
    for (name, width, height, mixed_alpha) in [
        ("fitted-tall", 218, 180, false),
        ("fitted-wide", 320, 134, false),
        ("fitted-square", 180, 180, false),
        ("fitted-near-full", 320, 175, false),
        ("fitted-alpha", 218, 180, true),
        ("exact-target", 320, 180, false),
        ("upscale", 160, 90, false),
        ("downscale", 640, 360, false),
        ("downscale-1080p", 1920, 1080, false),
        ("window-1600x1000", 1600, 1000, false),
        ("display-1440p", 2560, 1440, false),
        ("display-ultrawide", 3440, 1440, false),
        ("display-4k", 3840, 2160, false),
        ("display-4k-alpha", 3840, 2160, true),
    ] {
        let rgba = RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([
                (x * 17 + y) as u8,
                (x + y * 11) as u8,
                (x * 3 + y * 5) as u8,
                if mixed_alpha { (x + y * 7) as u8 } else { 255 },
            ])
        });
        assert_eq!(
            baseline(&rgba, 320, 180),
            fit_centered(&rgba, 320, 180),
            "{name}"
        );
        for sample in 0..35 {
            let (before, after) = if sample % 2 == 0 {
                let before = timed(baseline, &rgba);
                (before, timed(fit_centered, &rgba))
            } else {
                let after = timed(fit_centered, &rgba);
                (timed(baseline, &rgba), after)
            };
            if sample >= 5 {
                println!(
                    "{name},{width},{height},{FITS_PER_SAMPLE},{},{before},{after}",
                    sample - 5
                );
            }
        }
    }
}

fn baseline(image: &RgbaImage, target_width: u32, target_height: u32) -> RgbaImage {
    let width = image.width();
    let height = image.height();
    if width == target_width && height == target_height {
        return image.clone();
    }
    if width == 0 || height == 0 {
        return RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
    }
    let scale = (target_width as f32 / width as f32)
        .min(target_height as f32 / height as f32)
        .max(f32::MIN_POSITIVE);
    let scaled_width = (width as f32 * scale)
        .round()
        .clamp(1.0, target_width as f32) as u32;
    let scaled_height = (height as f32 * scale)
        .round()
        .clamp(1.0, target_height as f32) as u32;
    let resized = image::imageops::resize(
        image,
        scaled_width.max(1),
        scaled_height.max(1),
        image::imageops::FilterType::Lanczos3,
    );
    let mut canvas = RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
    let offset_x = (target_width - scaled_width) / 2;
    let offset_y = (target_height - scaled_height) / 2;
    image::imageops::overlay(&mut canvas, &resized, offset_x as i64, offset_y as i64);
    canvas
}
