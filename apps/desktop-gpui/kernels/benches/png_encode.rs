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

fn main() {
    println!("image,path,size_before,size_after,median_before_ms,median_after_ms");
    let cli_paths: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .collect();

    let targets: Vec<BenchmarkTarget> = if cli_paths.is_empty() {
        vec![
            BenchmarkTarget {
                name: "1080p".into(),
                width: 1920,
                height: 1080,
                data: screen_like(1920, 1080, 4),
                color: image::ExtendedColorType::Rgba8,
            },
            BenchmarkTarget {
                name: "retina".into(),
                width: 3024,
                height: 1964,
                data: screen_like(3024, 1964, 4),
                color: image::ExtendedColorType::Rgba8,
            },
            BenchmarkTarget {
                name: "4k".into(),
                width: 3840,
                height: 2160,
                data: screen_like(3840, 2160, 4),
                color: image::ExtendedColorType::Rgba8,
            },
        ]
    } else {
        cli_paths
            .into_iter()
            .map(|path| {
                let decoded = image::open(&path).expect("open image");
                let (width, height) = (decoded.width(), decoded.height());
                let name = std::path::Path::new(&path)
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
                BenchmarkTarget {
                    name,
                    width,
                    height,
                    data,
                    color,
                }
            })
            .collect()
    };

    for target in targets {
        let (name, width, height, data, color) = (
            target.name,
            target.width,
            target.height,
            target.data,
            target.color,
        );
        let paths = [("default", CompressionType::Default)];
        for (label, compression) in paths {
            let before_encode = || {
                let mut png = Vec::new();
                PngEncoder::new_with_quality(&mut png, compression, FilterType::Adaptive)
                    .write_image(&data, width, height, color)
                    .unwrap();
                png
            };
            let after_encode =
                || cap_gpui_kernels::png::encode(&data, width, height, color).unwrap();
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
}
