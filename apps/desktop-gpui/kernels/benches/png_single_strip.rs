use cap_gpui_kernels::{codec::md5, png::encode};
use image::ExtendedColorType;
use std::{hint::black_box, time::Instant};

fn main() {
    println!("width,height,channels,bytes,md5,median_us");
    for (width, height) in [(128, 64), (320, 180), (640, 480), (1024, 768)] {
        for (channels, color) in [(3, ExtendedColorType::Rgb8), (4, ExtendedColorType::Rgba8)] {
            let mut data = Vec::with_capacity(width as usize * height as usize * channels);
            for y in 0..height {
                for x in 0..width {
                    let band = ((x / 37 + y / 23) % 7) as u8 * 30;
                    data.extend_from_slice(&[band, (x ^ y) as u8, (x / 3) as u8, 255][..channels]);
                }
            }
            let reference = encode(&data, width, height, color).unwrap();
            if let Some(directory) = std::env::var_os("CAP_PNG_BENCH_OUTPUT") {
                let directory = std::path::PathBuf::from(directory);
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(
                    directory.join(format!("{width}-{height}-{channels}.png")),
                    &reference,
                )
                .unwrap();
            }
            let decoded = image::load_from_memory(&reference).unwrap();
            assert_eq!(decoded.as_bytes(), data);
            let mut samples = Vec::new();
            for batch in 0..11 {
                let start = Instant::now();
                for _ in 0..20 {
                    let png = black_box(encode(black_box(&data), width, height, color).unwrap());
                    assert_eq!(png, reference);
                }
                if batch >= 2 {
                    samples.push(start.elapsed().as_secs_f64() * 1_000_000.0 / 20.0);
                }
            }
            samples.sort_by(f64::total_cmp);
            let digest: String = md5(&reference)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            println!(
                "{width},{height},{channels},{},{digest},{:.1}",
                reference.len(),
                samples[samples.len() / 2]
            );
        }
    }
}
