use std::path::Path;

use ::md5::{Digest as _, Md5};
use image::ImageEncoder as _;

pub fn md5(bytes: &[u8]) -> [u8; 16] {
    let digest = Md5::digest(bytes);
    let mut output = [0; 16];
    output.copy_from_slice(&digest);
    output
}

pub fn read_cursor_events(
    reader: &mut dyn std::io::Read,
) -> Result<cap_project::CursorEvents, String> {
    cap_project::CursorEvents::load_from_reader(std::io::BufReader::new(reader))
}

pub fn rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
    let len = rgba.len() / 4 * 3;
    let mut rgb = vec![0u8; len];
    for (src, dst) in rgba.chunks_exact(4).zip(rgb.chunks_exact_mut(3)) {
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
    }
    rgb
}

pub fn flatten_rgba_to_rgb_over_white(rgba: &[u8]) -> Vec<u8> {
    let mut dst = vec![0u8; rgba.len() / 4 * 3];
    let mut i = 0;
    for px in rgba.chunks_exact(4) {
        let alpha = px[3];
        let out = &mut dst[i..i + 3];
        if alpha == 255 {
            out[0] = px[0];
            out[1] = px[1];
            out[2] = px[2];
        } else if alpha == 0 {
            out[0] = 255;
            out[1] = 255;
            out[2] = 255;
        } else {
            let a = u32::from(alpha);
            let inv = 255 - a;
            out[0] = ((u32::from(px[0]) * a + 255 * inv + 127) / 255) as u8;
            out[1] = ((u32::from(px[1]) * a + 255 * inv + 127) / 255) as u8;
            out[2] = ((u32::from(px[2]) * a + 255 * inv + 127) / 255) as u8;
        }
        i += 3;
    }
    dst
}

pub fn encode_png_rgba(rgba: &[u8], width: u32, height: u32) -> image::ImageResult<Vec<u8>> {
    crate::png::encode(rgba, width, height, image::ExtendedColorType::Rgba8)
}

pub fn write_png_file(
    file: std::fs::File,
    data: &[u8],
    width: u32,
    height: u32,
    color: image::ExtendedColorType,
    compression: image::codecs::png::CompressionType,
    filter: image::codecs::png::FilterType,
) -> image::ImageResult<()> {
    if compression == image::codecs::png::CompressionType::Default
        && filter == image::codecs::png::FilterType::Adaptive
    {
        return crate::png::write(std::io::BufWriter::new(file), data, width, height, color);
    }
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        compression,
        filter,
    );
    encoder.write_image(data, width, height, color)
}

pub fn encode_jpeg_rgb(
    rgb: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> image::ImageResult<Vec<u8>> {
    let mut buffer = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality).encode(
        rgb,
        width,
        height,
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(buffer)
}

pub fn encode_jpeg_rgba_as_rgb(
    rgba: &image::RgbaImage,
    quality: u8,
) -> image::ImageResult<Vec<u8>> {
    use image::buffer::ConvertBuffer as _;
    let rgb: image::RgbImage = rgba.convert();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality).encode_image(&rgb)?;
    Ok(encoded)
}

pub fn save_rgb_image(
    rgb: &image::RgbImage,
    path: &Path,
    format: image::ImageFormat,
) -> image::ImageResult<()> {
    rgb.save_with_format(path, format)
}

pub fn open_image(path: &Path) -> image::ImageResult<image::DynamicImage> {
    image::open(path)
}

pub fn decode_image_file(path: &Path) -> Result<image::DynamicImage, String> {
    image::ImageReader::open(path)
        .map_err(|e| format!("Failed to open image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to detect image format: {e}"))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {e}"))
}

pub fn inspect_overlay_image(encoded: &[u8]) -> Result<(&'static str, u32, u32), String> {
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
    let decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Cannot decode image: {error}"))?;
    use image::metadata::Orientation;
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (decoded.height(), decoded.width()),
        _ => (decoded.width(), decoded.height()),
    };
    Ok((extension, width, height))
}

pub fn decode_jpeg_to_bgra(bytes: &[u8]) -> Option<image::RgbaImage> {
    let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
    let mut rgba = decoded.into_rgba8();
    crate::frame::swap_red_blue(&mut rgba);
    Some(rgba)
}

pub fn compress_image_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let img = image::ImageReader::open(path)
        .map_err(|error| format!("Failed to open image: {error}"))?
        .decode()
        .map_err(|error| format!("Failed to decode image: {error}"))?;
    let resized = img.resize(
        img.width() / 2,
        img.height() / 2,
        image::imageops::FilterType::Nearest,
    );
    let mut buffer = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 30);
    encoder
        .encode(
            resized.as_bytes(),
            resized.width(),
            resized.height(),
            resized.color().into(),
        )
        .map_err(|error| format!("Failed to compress image: {error}"))?;
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_matches_the_reference_digest() {
        assert_eq!(
            md5(b""),
            [
                0xd4, 0x1d, 0x8c, 0xd9, 0x8f, 0x00, 0xb2, 0x04, 0xe9, 0x80, 0x09, 0x98, 0xec, 0xf8,
                0x42, 0x7e
            ]
        );
    }

    #[test]
    fn rgba_to_rgb_drops_alpha() {
        assert_eq!(
            rgba_to_rgb(&[1, 2, 3, 4, 5, 6, 7, 8]),
            vec![1, 2, 3, 5, 6, 7]
        );
    }

    #[test]
    fn fused_flatten_to_rgb_matches_two_step() {
        let rgba: Vec<u8> = (0..=255u8)
            .flat_map(|alpha| {
                (0..=255u8).flat_map(move |channel| {
                    [channel, 255 - channel, channel.wrapping_mul(17), alpha]
                })
            })
            .collect();
        assert_eq!(
            flatten_rgba_to_rgb_over_white(&rgba),
            rgba_to_rgb(&crate::screenshot::flatten_onto_white(&rgba))
        );
        assert_eq!(flatten_rgba_to_rgb_over_white(&[]), Vec::<u8>::new());
        let trailing: [u8; 7] = [10, 20, 30, 40, 50, 60, 70];
        assert_eq!(
            flatten_rgba_to_rgb_over_white(&trailing),
            rgba_to_rgb(&crate::screenshot::flatten_onto_white(&trailing))
        );
    }

    fn extend_flatten_rgba_to_rgb_over_white(rgba: &[u8]) -> Vec<u8> {
        let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
        for px in rgba.chunks_exact(4) {
            let alpha = px[3];
            if alpha == 255 {
                rgb.extend_from_slice(&[px[0], px[1], px[2]]);
            } else if alpha == 0 {
                rgb.extend_from_slice(&[255, 255, 255]);
            } else {
                let a = u32::from(alpha);
                let inv = 255 - a;
                rgb.extend_from_slice(&[
                    ((u32::from(px[0]) * a + 255 * inv + 127) / 255) as u8,
                    ((u32::from(px[1]) * a + 255 * inv + 127) / 255) as u8,
                    ((u32::from(px[2]) * a + 255 * inv + 127) / 255) as u8,
                ]);
            }
        }
        rgb
    }

    fn rgba_with_alpha(pixels: usize, alpha_of: impl Fn(usize) -> u8) -> Vec<u8> {
        let mut rgba = Vec::with_capacity(pixels * 4);
        for i in 0..pixels {
            rgba.extend_from_slice(&[
                (i & 0xff) as u8,
                ((i >> 4) & 0xff) as u8,
                i.wrapping_mul(17) as u8,
                alpha_of(i),
            ]);
        }
        rgba
    }

    #[test]
    fn flatten_rgba_to_rgb_over_white_matches_extend_formula() {
        assert_eq!(flatten_rgba_to_rgb_over_white(&[1, 2, 3, 255]), [1, 2, 3]);
        assert_eq!(
            flatten_rgba_to_rgb_over_white(&[1, 2, 3, 0]),
            [255, 255, 255]
        );
        assert_eq!(
            flatten_rgba_to_rgb_over_white(&[10, 0, 255, 128]),
            [132, 127, 255]
        );

        let opaque = rgba_with_alpha(256, |_| 255);
        let transparent = rgba_with_alpha(256, |_| 0);
        let mixed = rgba_with_alpha(256, |i| match i % 3 {
            0 => 0,
            1 => 255,
            _ => (i * 17) as u8,
        });
        for rgba in [&opaque[..], &transparent[..], &mixed[..]] {
            assert_eq!(
                flatten_rgba_to_rgb_over_white(rgba),
                extend_flatten_rgba_to_rgb_over_white(rgba)
            );
        }
    }

    #[test]
    fn png_round_trips_rgba() {
        use image::ImageEncoder as _;

        let samples = [
            vec![10, 20, 30, 40, 50, 60, 70, 255],
            (0..=255u8)
                .flat_map(|value| [value, 255 - value, value.wrapping_mul(17), value])
                .collect(),
        ];
        for (rgba, (width, height)) in samples.into_iter().zip([(2, 1), (16, 16)]) {
            let png = encode_png_rgba(&rgba, width, height).unwrap();
            let parallel =
                crate::png::encode(&rgba, width, height, image::ExtendedColorType::Rgba8).unwrap();
            assert_eq!(png, parallel);
            let decoded = image::load_from_memory(&png).unwrap().to_rgba8();
            assert_eq!(decoded.dimensions(), (width, height));
            assert_eq!(decoded.as_raw(), &rgba);

            let mut reference = Vec::new();
            image::codecs::png::PngEncoder::new(&mut reference)
                .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
                .unwrap();
            let reference = image::load_from_memory(&reference).unwrap().to_rgba8();
            assert_eq!(decoded.as_raw(), reference.as_raw());
        }
        assert!(encode_png_rgba(&[0, 0, 0, 0], 2, 1).is_err());
    }

    #[test]
    fn jpeg_paths_agree_on_the_same_pixels() {
        let rgba = image::RgbaImage::from_fn(9, 7, |x, y| {
            image::Rgba([(x * 20) as u8, (y * 30) as u8, 90, 128])
        });
        let from_slice = encode_jpeg_rgb(&rgba_to_rgb(rgba.as_raw()), 9, 7, 80).unwrap();
        let from_image = encode_jpeg_rgba_as_rgb(&rgba, 80).unwrap();
        assert_eq!(from_slice, from_image);
        let bgra = decode_jpeg_to_bgra(&from_slice).unwrap();
        assert_eq!(bgra.dimensions(), (9, 7));
    }

    #[test]
    fn reads_cursor_events_and_reports_errors() {
        let events = read_cursor_events(&mut &br#"{"clicks":[],"moves":[]}"#[..]).unwrap();
        assert!(events.clicks.is_empty() && events.moves.is_empty());
        assert!(
            read_cursor_events(&mut &b"{"[..])
                .unwrap_err()
                .starts_with("Failed to parse cursor data: ")
        );
    }
}

#[cfg(test)]
#[path = "codec_overlay_tests.rs"]
mod overlay_inspection_tests;
