use cap_enc_gif::GifEncoderWrapper;
use std::{error::Error, hint::black_box, io, path::PathBuf, time::Instant};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let fixture = args.next().unwrap_or_default();
    let path = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("usage: benchmark <texture|ui> <output.gif>"))?;
    if !matches!(fixture.as_str(), "texture" | "ui") || args.next().is_some() {
        return Err(io::Error::other("usage: benchmark <texture|ui> <output.gif>").into());
    }

    let (width, height, count) = (960usize, 540usize, 60usize);
    let frames: Vec<Vec<u8>> = (0..count)
        .map(|frame| {
            let mut bytes = vec![0; width * height * 4];
            for y in 0..height {
                for x in 0..width {
                    let value = if fixture == "ui" {
                        if y < 45 {
                            5
                        } else if x < 160 {
                            10
                        } else {
                            let sx = x - 160;
                            let sy = y + frame * 3;
                            if sy % 54 < 20 && sx % 340 < 240 {
                                20 + ((sy / 54) % 7) as u8 * 4
                            } else if sy % 54 < 23 && sx % 340 < 280 {
                                9
                            } else {
                                63
                            }
                        }
                    } else {
                        let hash = ((x / 2 + frame * 7) as u32).wrapping_mul(747796405)
                            ^ (y as u32 / 2).wrapping_mul(2891336453);
                        ((hash ^ (hash >> 16)) % 64) as u8
                    };
                    let offset = (y * width + x) * 4;
                    bytes[offset..offset + 4].copy_from_slice(&[
                        (value & 3) * 85,
                        ((value >> 2) & 3) * 85,
                        ((value >> 4) & 3) * 85,
                        255,
                    ]);
                }
            }
            bytes
        })
        .collect();

    let start = Instant::now();
    let mut encoder = GifEncoderWrapper::new(&path, width as u32, height as u32, 30)?;
    for frame in &frames {
        encoder.add_frame(black_box(frame), width * 4)?;
    }
    encoder.finish()?;
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    println!("{elapsed:.3},{}", std::fs::metadata(path)?.len());
    Ok(())
}
