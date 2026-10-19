use image::ImageEncoder as _;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use std::{hint::black_box, time::Instant};

fn main() {
    println!("image,path,size_before,size_after,median_before_ms,median_after_ms");
    for path in std::env::args().skip(1).filter(|arg| !arg.starts_with('-')) {
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
