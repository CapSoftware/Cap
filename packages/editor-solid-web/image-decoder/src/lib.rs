use image::{GenericImageView, ImageReader, Limits, imageops::FilterType};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MAX_ENCODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_777_216;
const MAX_DECODED_ALLOCATION: u64 = 128 * 1024 * 1024;

#[wasm_bindgen]
pub struct DecodedImage {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedImage {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn pixels(self) -> Vec<u8> {
        self.pixels
    }
}

#[wasm_bindgen]
pub fn decode_image(bytes: &[u8], max_dimension: u32) -> Result<DecodedImage, JsValue> {
    if bytes.is_empty() || bytes.len() > MAX_ENCODED_BYTES || !(1..=2560).contains(&max_dimension) {
        return Err(JsValue::from_str("Editor background image is invalid"));
    }
    let format =
        image::guess_format(bytes).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(MAX_DECODED_ALLOCATION);
    reader.limits(limits.clone());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(JsValue::from_str("Editor background image is too large"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let image = if width > max_dimension || height > max_dimension {
        image.resize(max_dimension, max_dimension, FilterType::Triangle)
    } else {
        image
    };
    let (width, height) = image.dimensions();
    Ok(DecodedImage {
        width,
        height,
        pixels: image.to_rgba8().into_raw(),
    })
}
