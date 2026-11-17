use image::DynamicImage;

pub fn decode_jpeg_thumbnail(
    bytes: &[u8],
    request: impl FnOnce(u32, u32) -> (u32, u32),
) -> Option<(DynamicImage, u32, u32)> {
    let mut decoder = jpeg_decoder::Decoder::new(bytes);
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 | jpeg_decoder::PixelFormat::L8 => {}
        _ => return None,
    }
    let (requested_width, requested_height) =
        request(u32::from(info.width), u32::from(info.height));
    let requested_width = requested_width.clamp(1, u32::from(u16::MAX)) as u16;
    let requested_height = requested_height.clamp(1, u32::from(u16::MAX)) as u16;
    let (width, height) = decoder.scale(requested_width, requested_height).ok()?;
    let pixels = decoder.decode().ok()?;
    let decoded = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => DynamicImage::ImageRgb8(image::RgbImage::from_raw(
            u32::from(width),
            u32::from(height),
            pixels,
        )?),
        jpeg_decoder::PixelFormat::L8 => DynamicImage::ImageLuma8(image::GrayImage::from_raw(
            u32::from(width),
            u32::from(height),
            pixels,
        )?),
        _ => return None,
    };
    Some((decoded, u32::from(info.width), u32::from(info.height)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThumbnailResize {
    Box,
    Triangle,
    Identity,
}

pub fn thumbnail_resize(
    decoded_width: u32,
    decoded_height: u32,
    target_width: u32,
    target_height: u32,
) -> ThumbnailResize {
    let decoded_width = decoded_width.max(1);
    let decoded_height = decoded_height.max(1);
    let target_width = target_width.max(1);
    let target_height = target_height.max(1);
    if decoded_width <= target_width && decoded_height <= target_height {
        return ThumbnailResize::Identity;
    }
    let scale = (target_width as f32 / decoded_width as f32)
        .min(target_height as f32 / decoded_height as f32);
    if scale <= 0.5 {
        ThumbnailResize::Box
    } else {
        ThumbnailResize::Triangle
    }
}

pub fn cover_target(width: u32, height: u32, card_width: u32, card_height: u32) -> (f32, u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    let scale = (card_width as f32 / width as f32)
        .max(card_height as f32 / height as f32)
        .min(1.0);
    let target_width = ((width as f32 * scale).round() as u32).max(1);
    let target_height = ((height as f32 * scale).round() as u32).max(1);
    (scale, target_width, target_height)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD_WIDTH: u32 = 392;
    const CARD_HEIGHT: u32 = 224;

    fn encode_rgb(width: u32, height: u32, pixel: [u8; 3]) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb(pixel));
        let mut encoded = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 75)
            .encode_image(&image)
            .unwrap();
        encoded
    }

    #[test]
    fn square_request_downsamples_before_the_full_frame() {
        let encoded = encode_rgb(1024, 512, [40, 120, 200]);
        let (decoded, width, height) = decode_jpeg_thumbnail(&encoded, |_, _| (128, 128)).unwrap();
        assert_eq!((width, height), (1024, 512));
        assert!(decoded.width() <= 256);
        assert!(decoded.height() <= 128);
        let pixel = decoded.to_rgb8().get_pixel(0, 0).0;
        assert!(pixel[0].abs_diff(40) <= 3);
        assert!(pixel[1].abs_diff(120) <= 3);
        assert!(pixel[2].abs_diff(200) <= 3);
    }

    #[test]
    fn library_cover_targets_match_the_card() {
        assert_eq!(
            cover_dims(800, 600),
            (392, 294),
            "800x600 covering the card"
        );
        assert_eq!(cover_dims(600, 600), (392, 392));
        assert_eq!(cover_dims(1920, 1080), (398, 224));
        assert_eq!(cover_dims(1512, 982), (392, 255));
    }

    #[test]
    fn resize_uses_the_decoded_buffer_not_the_original_scale() {
        let (_, target_width, target_height) = cover_target(1920, 1080, CARD_WIDTH, CARD_HEIGHT);
        assert_eq!((target_width, target_height), (398, 224));
        assert_eq!(
            thumbnail_resize(1920, 1080, target_width, target_height),
            ThumbnailResize::Box
        );
        assert_eq!(
            thumbnail_resize(480, 270, target_width, target_height),
            ThumbnailResize::Triangle
        );
        assert_eq!(
            thumbnail_resize(target_width, target_height, target_width, target_height),
            ThumbnailResize::Identity
        );
    }

    #[test]
    fn library_cover_idct_scales_1080p_to_a_quarter() {
        let encoded = encode_rgb(1920, 1080, [40, 120, 200]);
        let (decoded, width, height) = decode_jpeg_thumbnail(&encoded, |w, h| {
            let (_, target_width, target_height) = cover_target(w, h, CARD_WIDTH, CARD_HEIGHT);
            (target_width, target_height)
        })
        .unwrap();
        assert_eq!((width, height), (1920, 1080));
        assert_eq!((decoded.width(), decoded.height()), (480, 270));
        let (_, target_width, target_height) = cover_target(width, height, CARD_WIDTH, CARD_HEIGHT);
        assert_eq!(
            thumbnail_resize(
                decoded.width(),
                decoded.height(),
                target_width,
                target_height
            ),
            ThumbnailResize::Triangle
        );
    }

    #[test]
    fn cmyk_frame_returns_none() {
        let bytes = cmyk_jpeg();
        let mut decoder = jpeg_decoder::Decoder::new(bytes.as_slice());
        let pixels = decoder.decode().expect("cmyk fixture decodes");
        assert_eq!(
            decoder.info().map(|info| info.pixel_format),
            Some(jpeg_decoder::PixelFormat::CMYK32)
        );
        assert_eq!(pixels.len(), 8 * 8 * 4);
        assert!(decode_jpeg_thumbnail(&bytes, |w, h| (w, h)).is_none());
    }

    fn cmyk_jpeg() -> Vec<u8> {
        fn marker(out: &mut Vec<u8>, tag: u8, payload: &[u8]) {
            out.extend_from_slice(&[0xFF, tag]);
            let len = u16::try_from(payload.len() + 2).unwrap();
            out.extend_from_slice(&len.to_be_bytes());
            out.extend_from_slice(payload);
        }
        fn huffman(class: u8) -> Vec<u8> {
            let mut table = vec![class, 0x01];
            table.extend(std::iter::repeat_n(0x00, 15));
            table.push(0x00);
            table
        }
        let mut quant = vec![0x00];
        quant.extend(std::iter::repeat_n(0x01, 64));
        let mut frame = vec![0x08, 0x00, 0x08, 0x00, 0x08, 0x04];
        for id in 1..=4u8 {
            frame.extend_from_slice(&[id, 0x11, 0x00]);
        }
        let mut scan = vec![0x04];
        for id in 1..=4u8 {
            scan.extend_from_slice(&[id, 0x00]);
        }
        scan.extend_from_slice(&[0x00, 0x3F, 0x00]);

        let mut bytes = vec![0xFF, 0xD8];
        marker(&mut bytes, 0xDB, &quant);
        marker(&mut bytes, 0xC0, &frame);
        marker(&mut bytes, 0xC4, &huffman(0x00));
        marker(&mut bytes, 0xC4, &huffman(0x10));
        marker(&mut bytes, 0xDA, &scan);
        bytes.push(0x00);
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        bytes
    }

    fn cover_dims(width: u32, height: u32) -> (u32, u32) {
        let (_, target_width, target_height) = cover_target(width, height, CARD_WIDTH, CARD_HEIGHT);
        (target_width, target_height)
    }
}
