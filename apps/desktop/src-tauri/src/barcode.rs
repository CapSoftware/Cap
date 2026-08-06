use rxing::{DecodeHintValue, DecodeHints};

/// Decodes a QR code or barcode from an image, returning its text payload.
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
