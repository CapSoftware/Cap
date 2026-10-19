use super::inspect_overlay_image;
use image::{ImageDecoder as _, ImageEncoder as _, ImageFormat, metadata::Orientation};

fn inspect_with_pixel_orientation(encoded: &[u8]) -> Result<(&'static str, u32, u32), String> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(encoded))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let extension = match reader.format() {
        Some(ImageFormat::Png) => "png",
        Some(ImageFormat::Jpeg) => "jpg",
        Some(ImageFormat::WebP) => "webp",
        Some(ImageFormat::Gif) => "gif",
        Some(ImageFormat::Bmp) => "bmp",
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

fn assert_matches_original(encoded: &[u8]) -> Result<(&'static str, u32, u32), String> {
    let unchanged = encoded.to_vec();
    let expected = inspect_with_pixel_orientation(encoded);
    let actual = inspect_overlay_image(encoded);
    assert_eq!(actual, expected);
    assert_eq!(encoded, unchanged.as_slice());
    actual
}

fn exif(orientation: u8, big_endian: bool) -> Vec<u8> {
    if big_endian {
        vec![
            b'M',
            b'M',
            0,
            42,
            0,
            0,
            0,
            8,
            0,
            1,
            1,
            0x12,
            0,
            3,
            0,
            0,
            0,
            1,
            0,
            orientation,
            0,
            0,
            0,
            0,
            0,
            0,
        ]
    } else {
        vec![
            b'I',
            b'I',
            42,
            0,
            8,
            0,
            0,
            0,
            1,
            0,
            0x12,
            1,
            3,
            0,
            1,
            0,
            0,
            0,
            orientation,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ]
    }
}

fn encoded_image(format: ImageFormat, width: u32, height: u32, exif: Option<Vec<u8>>) -> Vec<u8> {
    let rgba = image::RgbaImage::from_fn(width, height, |x, y| {
        image::Rgba([
            (x * 19 + y * 3) as u8,
            (y * 23 + x * 7) as u8,
            211,
            (x * 13 + y * 17) as u8,
        ])
    });
    let mut encoded = Vec::new();
    match format {
        ImageFormat::Jpeg => {
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 80);
            if let Some(exif) = exif {
                encoder.set_exif_metadata(exif).unwrap();
            }
            encoder.encode_image(&rgba).unwrap();
        }
        ImageFormat::Png => {
            let mut encoder = image::codecs::png::PngEncoder::new(&mut encoded);
            if let Some(exif) = exif {
                encoder.set_exif_metadata(exif).unwrap();
            }
            encoder
                .write_image(
                    rgba.as_raw(),
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .unwrap();
        }
        _ => unreachable!(),
    }
    encoded
}

fn decoded_orientation(encoded: &[u8]) -> Orientation {
    image::ImageReader::new(std::io::Cursor::new(encoded))
        .with_guessed_format()
        .unwrap()
        .into_decoder()
        .unwrap()
        .orientation()
        .unwrap()
}

#[test]
fn all_exif_orientations_match_rotated_pixels_for_jpeg_and_png() {
    for format in [ImageFormat::Jpeg, ImageFormat::Png] {
        for (width, height) in [(7, 11), (11, 7), (9, 9)] {
            for big_endian in [false, true] {
                for value in 1..=8 {
                    let encoded =
                        encoded_image(format, width, height, Some(exif(value, big_endian)));
                    assert_eq!(
                        decoded_orientation(&encoded),
                        Orientation::from_exif(value).unwrap()
                    );
                    let dimensions = if value >= 5 {
                        (height, width)
                    } else {
                        (width, height)
                    };
                    let extension = if format == ImageFormat::Jpeg {
                        "jpg"
                    } else {
                        "png"
                    };
                    assert_eq!(
                        assert_matches_original(&encoded).unwrap(),
                        (extension, dimensions.0, dimensions.1),
                        "{format:?}, EXIF {value}, big endian {big_endian}"
                    );
                }
            }
        }
    }
}

#[test]
fn absent_and_malformed_exif_keep_untransformed_dimensions() {
    let truncated_exif = exif(6, false)[..10].to_vec();
    for format in [ImageFormat::Jpeg, ImageFormat::Png] {
        for metadata in [
            None,
            Some(b"not EXIF".to_vec()),
            Some(truncated_exif.clone()),
            Some(exif(0, false)),
            Some(exif(9, true)),
            Some(exif(255, false)),
        ] {
            let encoded = encoded_image(format, 7, 11, metadata);
            assert_eq!(decoded_orientation(&encoded), Orientation::NoTransforms);
            let (_, width, height) = assert_matches_original(&encoded).unwrap();
            assert_eq!((width, height), (7, 11));
        }
    }
}

#[test]
fn corrupt_and_truncated_images_keep_decode_errors() {
    for encoded in [b"".as_slice(), b"invalid image".as_slice()] {
        assert!(assert_matches_original(encoded).is_err());
    }
    for format in [ImageFormat::Jpeg, ImageFormat::Png] {
        let encoded = encoded_image(format, 17, 11, Some(exif(6, false)));
        for end in [2, encoded.len() / 2] {
            assert!(assert_matches_original(&encoded[..end]).is_err());
        }
    }
    let encoded = encoded_image(ImageFormat::Png, 17, 11, Some(exif(6, true)));
    let data_start = encoded
        .windows(4)
        .position(|bytes| bytes == b"IDAT")
        .unwrap()
        + 4;
    let mut corrupt = encoded.clone();
    corrupt[data_start] = 0;
    for invalid in [corrupt, encoded[..data_start + 2].to_vec()] {
        assert_eq!(decoded_orientation(&invalid), Orientation::Rotate90);
        assert!(
            assert_matches_original(&invalid)
                .unwrap_err()
                .starts_with("Cannot decode image: ")
        );
    }
}

fn png_with_dimensions(width: u32, height: u32) -> Vec<u8> {
    let mut encoded = encoded_image(ImageFormat::Png, 1, 1, None);
    assert_eq!(&encoded[12..16], b"IHDR");
    encoded[16..20].copy_from_slice(&width.to_be_bytes());
    encoded[20..24].copy_from_slice(&height.to_be_bytes());
    let mut crc = u32::MAX;
    for byte in &encoded[12..29] {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    encoded[29..33].copy_from_slice(&(!crc).to_be_bytes());
    encoded
}

#[test]
fn invalid_and_oversized_dimensions_keep_validation_errors() {
    for (width, height) in [(0, 1), (1, 0), (32_769, 1), (1, 32_769), (4_097, 4_096)] {
        let error = assert_matches_original(&png_with_dimensions(width, height)).unwrap_err();
        if width > 32_768 || height > 32_768 {
            assert!(error.starts_with("Cannot decode image (maximum 32,768 pixels per side): "));
        } else if u64::from(width) * u64::from(height) > 16_777_216 {
            assert!(error.starts_with("Images must have at most 16,777,216 pixels"));
        }
    }
}
