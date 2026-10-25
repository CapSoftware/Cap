use rxing::{DecodeHintValue, DecodeHints};

pub fn decode_barcode(image: &image::DynamicImage) -> Option<String> {
    let luma = image.to_luma8();
    let width = luma.width();
    let height = luma.height();
    let mut hints = DecodeHints::default().with(DecodeHintValue::TryHarder(true));

    rxing::helpers::detect_in_luma_with_hints(luma.into_raw(), width, height, None, &mut hints)
        .ok()
        .map(|result| result.getText().to_string())
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, GrayImage, Luma};
    use rxing::Writer;

    fn encoded_image(
        payload: &str,
        format: &rxing::BarcodeFormat,
        width: i32,
        height: i32,
    ) -> DynamicImage {
        let matrix = rxing::MultiFormatWriter::default()
            .encode(payload, format, width, height)
            .unwrap();
        let quiet_zone = 40;
        let mut image = GrayImage::from_pixel(
            matrix.width() + quiet_zone * 2,
            matrix.height() + quiet_zone * 2,
            Luma([255]),
        );
        for y in 0..matrix.height() {
            for x in 0..matrix.width() {
                if matrix.get(x, y) {
                    image.put_pixel(x + quiet_zone, y + quiet_zone, Luma([0]));
                }
            }
        }
        DynamicImage::ImageLuma8(image)
    }

    #[test]
    fn blank_image_has_no_barcode() {
        let image = image::DynamicImage::ImageLuma8(image::GrayImage::new(32, 32));
        assert_eq!(super::decode_barcode(&image), None);
    }

    #[test]
    fn decodes_qr_payload_with_exact_whitespace() {
        let payload = "  secret pass \n";
        let image = encoded_image(payload, &rxing::BarcodeFormat::QR_CODE, 240, 240);
        assert_eq!(super::decode_barcode(&image).as_deref(), Some(payload));
    }

    #[test]
    fn decodes_code_128_payload() {
        let payload = "CAP-2025-ABC";
        let image = encoded_image(payload, &rxing::BarcodeFormat::CODE_128, 400, 100);
        assert_eq!(super::decode_barcode(&image).as_deref(), Some(payload));
    }
}
