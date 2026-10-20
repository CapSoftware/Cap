use cap_gpui_kernels::codec::inspect_overlay_image;
use image::{ImageDecoder as _, ImageEncoder as _, metadata::Orientation};
use std::{hint::black_box, time::Instant};

type Inspect = fn(&[u8]) -> Result<(&'static str, u32, u32), String>;

struct Fixture {
    name: String,
    encoded: Vec<u8>,
    dimensions: (u32, u32),
    orientation: Orientation,
    extension: &'static str,
}

fn exif(orientation: u8) -> Vec<u8> {
    let mut tiff = b"MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x01\0\0\0\0\0\0".to_vec();
    tiff[19] = orientation;
    tiff
}

fn pixel(x: u32, y: u32) -> [u8; 3] {
    let detail = (x.wrapping_mul(1_664_525) ^ y.wrapping_mul(1_013_904_223)) >> 24;
    [
        (x / 17 + y / 11 + detail) as u8,
        (x / 29 + y / 7 + detail) as u8,
        (x / 13 + y / 31 + detail) as u8,
    ]
}

fn fixtures() -> Vec<Fixture> {
    let mut fixtures = Vec::new();
    for (width, height) in [(640, 480), (4032, 3024)] {
        let rgb = image::RgbImage::from_fn(width, height, |x, y| image::Rgb(pixel(x, y)));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85)
            .encode_image(&rgb)
            .unwrap();
        for orientation in [None, Some(1), Some(2), Some(3), Some(6), Some(8)] {
            let encoded = if let Some(orientation) = orientation {
                let tiff = exif(orientation);
                let mut encoded = jpeg[..2].to_vec();
                encoded.extend_from_slice(&[0xff, 0xe1]);
                encoded.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
                encoded.extend_from_slice(b"Exif\0\0");
                encoded.extend_from_slice(&tiff);
                encoded.extend_from_slice(&jpeg[2..]);
                encoded
            } else {
                jpeg.clone()
            };
            fixtures.push(Fixture {
                name: format!(
                    "jpeg-{width}x{height}-{}",
                    orientation.map_or_else(|| "no-exif".into(), |value| format!("exif{value}"))
                ),
                encoded,
                dimensions: (width, height),
                orientation: Orientation::from_exif(orientation.unwrap_or(1)).unwrap(),
                extension: "jpg",
            });
        }
    }
    let (width, height) = (1600, 900);
    let rgba = image::RgbaImage::from_fn(width, height, |x, y| {
        let [r, g, b] = pixel(x, y);
        image::Rgba([r, g, b, (x + y * 7) as u8])
    });
    for orientation in [1, 6] {
        let mut encoded = Vec::new();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut encoded);
        encoder.set_exif_metadata(exif(orientation)).unwrap();
        encoder
            .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
            .unwrap();
        fixtures.push(Fixture {
            name: format!("png-{width}x{height}-exif{orientation}"),
            encoded,
            dimensions: (width, height),
            orientation: Orientation::from_exif(orientation).unwrap(),
            extension: "png",
        });
    }
    fixtures
}

fn timed(inspect: Inspect, encoded: &[u8]) -> u128 {
    let start = Instant::now();
    drop(black_box(inspect(black_box(encoded))));
    start.elapsed().as_nanos()
}

fn main() {
    let fixtures = fixtures();
    println!("workload,width,height,encoded_bytes,sample,before_ns,after_ns");
    for fixture in fixtures {
        let reader = image::ImageReader::new(std::io::Cursor::new(&fixture.encoded))
            .with_guessed_format()
            .unwrap();
        let mut decoder = reader.into_decoder().unwrap();
        assert_eq!(decoder.dimensions(), fixture.dimensions, "{}", fixture.name);
        assert_eq!(
            decoder.orientation().unwrap(),
            fixture.orientation,
            "{}",
            fixture.name
        );
        drop(decoder);
        let (width, height) = fixture.dimensions;
        let expected = if matches!(
            fixture.orientation,
            Orientation::Rotate90 | Orientation::Rotate270
        ) {
            (fixture.extension, height, width)
        } else {
            (fixture.extension, width, height)
        };
        assert_eq!(baseline(&fixture.encoded), Ok(expected), "{}", fixture.name);
        assert_eq!(
            inspect_overlay_image(&fixture.encoded),
            Ok(expected),
            "{}",
            fixture.name
        );
        for sample in 0..35 {
            let (before, after) = if sample % 2 == 0 {
                let before = timed(baseline, &fixture.encoded);
                (before, timed(inspect_overlay_image, &fixture.encoded))
            } else {
                let after = timed(inspect_overlay_image, &fixture.encoded);
                (timed(baseline, &fixture.encoded), after)
            };
            if sample >= 5 {
                println!(
                    "{},{width},{height},{},{},{before},{after}",
                    fixture.name,
                    fixture.encoded.len(),
                    sample - 5
                );
            }
        }
    }
}

fn baseline(encoded: &[u8]) -> Result<(&'static str, u32, u32), String> {
    use image::ImageDecoder as _;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(encoded))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let extension = match reader.format() {
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::Jpeg) => "jpg",
        Some(image::ImageFormat::WebP) => "webp",
        Some(image::ImageFormat::Gif) => "gif",
        Some(image::ImageFormat::Bmp) => "bmp",
        _ => return Err("Choose a PNG, JPEG, WebP, GIF or BMP image".into()),
    };
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits.max_image_width = Some(32_768);
    limits.max_image_height = Some(32_768);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|error| {
        format!("Cannot decode image (maximum 32,768 pixels per side): {error}")
    })?;
    let (source_width, source_height) = decoder.dimensions();
    if source_width == 0
        || source_height == 0
        || u64::from(source_width) * u64::from(source_height) > 16_777_216
        || decoder.total_bytes() > 128 * 1024 * 1024
    {
        return Err("Images must have at most 16,777,216 pixels (32,768 per side) and decode to at most 128 MiB".into());
    }
    let orientation = decoder.orientation().map_err(|error| error.to_string())?;
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Cannot decode image: {error}"))?;
    decoded.apply_orientation(orientation);
    Ok((extension, decoded.width(), decoded.height()))
}
