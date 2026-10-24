use image::ImageEncoder as _;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use std::{hint::black_box, time::Instant};

fn screen_like(width: u32, height: u32, channels: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_u32;
    let mut data = Vec::with_capacity(width as usize * height as usize * channels);
    for y in 0..height {
        for x in 0..width {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let band = ((x / 37 + y / 23) % 7) as u8 * 30;
            let noise = if (x + y) % 11 == 0 { state as u8 } else { 0 };
            let px = [
                band,
                band.wrapping_add(noise),
                (x ^ y) as u8,
                (y % 256) as u8,
            ];
            data.extend_from_slice(&px[..channels]);
        }
    }
    data
}

struct BenchmarkTarget {
    name: String,
    width: u32,
    height: u32,
    data: Vec<u8>,
    color: image::ExtendedColorType,
}

impl BenchmarkTarget {
    fn synthetic(name: &str, width: u32, height: u32) -> Self {
        Self {
            name: name.into(),
            width,
            height,
            data: screen_like(width, height, 4),
            color: image::ExtendedColorType::Rgba8,
        }
    }

    // Decoding is deliberately done per path inside the benchmark loop rather
    // than collected up front: a large screenshot batch would otherwise hold
    // every decoded image in memory at once, which can swap, distort the
    // timings, or OOM the run.
    fn from_path(path: &str) -> Self {
        let decoded = image::open(path).expect("open image");
        let (width, height) = (decoded.width(), decoded.height());
        let name = std::path::Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let (data, color) = if decoded.color().has_alpha() {
            (
                decoded.to_rgba8().into_raw(),
                image::ExtendedColorType::Rgba8,
            )
        } else {
            (decoded.to_rgb8().into_raw(), image::ExtendedColorType::Rgb8)
        };
        Self {
            name,
            width,
            height,
            data,
            color,
        }
    }
}

fn run_target(target: BenchmarkTarget) {
    let BenchmarkTarget {
        name,
        width,
        height,
        data,
        color,
    } = target;
    let paths = [("default", CompressionType::Default)];
    for (label, compression) in paths {
        let before_encode = || {
            let mut png = Vec::new();
            PngEncoder::new_with_quality(&mut png, compression, FilterType::Adaptive)
                .write_image(&data, width, height, color)
                .unwrap();
            png
        };
        let after_encode = || cap_gpui_kernels::png::encode(&data, width, height, color).unwrap();
        let after = after_encode();
        let roundtrip = image::load_from_memory(&after).unwrap();
        let pixels = match color {
            image::ExtendedColorType::Rgba8 => roundtrip.to_rgba8().into_raw(),
            _ => roundtrip.to_rgb8().into_raw(),
        };
        assert!(pixels == data, "{name} did not round-trip");
        let (mut old, mut new) = (Vec::new(), Vec::new());
        let mut size_before = 0;
        for sample in 0..12 {
            let time = |f: &dyn Fn() -> Vec<u8>| {
                let start = Instant::now();
                let png = black_box(f());
                (start.elapsed().as_secs_f64() * 1e3, png.len())
            };
            let (o, n) = if sample % 2 == 0 {
                let o = time(&before_encode);
                (o, time(&after_encode))
            } else {
                let n = time(&after_encode);
                (time(&before_encode), n)
            };
            size_before = o.1;
            if sample >= 2 {
                old.push(o.0);
                new.push(n.0);
            }
        }
        old.sort_by(f64::total_cmp);
        new.sort_by(f64::total_cmp);
        println!(
            "{name},{label},{size_before},{},{:.1},{:.1}",
            after.len(),
            old[old.len() / 2],
            new[new.len() / 2]
        );
    }
}

fn main() {
    println!("image,path,size_before,size_after,median_before_ms,median_after_ms");
    let cli_paths: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .collect();

    if cli_paths.is_empty() {
        for target in [
            BenchmarkTarget::synthetic("1080p", 1920, 1080),
            BenchmarkTarget::synthetic("retina", 3024, 1964),
            BenchmarkTarget::synthetic("4k", 3840, 2160),
        ] {
            run_target(target);
        }
    } else {
        for path in cli_paths {
            run_target(BenchmarkTarget::from_path(&path));
        }
    }
}
