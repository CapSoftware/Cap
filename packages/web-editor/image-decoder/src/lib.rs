use image::{
    DynamicImage, GenericImageView, ImageDecoder, ImageReader, Limits, RgbaImage,
    imageops::FilterType,
};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MAX_ENCODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_777_216;
const MAX_DECODED_ALLOCATION: u64 = 128 * 1024 * 1024;
const MAX_OVERLAY_RGBA_BYTES: f64 = 64.0 * 1024.0 * 1024.0;

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

#[wasm_bindgen]
pub struct DecodedOverlayImage {
    levels: Vec<DecodedImage>,
}

#[wasm_bindgen]
impl DecodedOverlayImage {
    pub fn level_count(&self) -> u32 {
        self.levels.len() as u32
    }

    pub fn level_width(&self, index: usize) -> u32 {
        self.levels.get(index).map_or(0, |level| level.width)
    }

    pub fn level_height(&self, index: usize) -> u32 {
        self.levels.get(index).map_or(0, |level| level.height)
    }

    pub fn take_level_pixels(&mut self, index: usize) -> Vec<u8> {
        self.levels
            .get_mut(index)
            .map_or_else(Vec::new, |level| std::mem::take(&mut level.pixels))
    }
}

fn overlay_texture_dimensions(width: u32, height: u32, max_dimension: u32) -> (u32, u32) {
    let scale = (MAX_OVERLAY_RGBA_BYTES / (f64::from(width) * f64::from(height) * 4.0))
        .sqrt()
        .min(f64::from(max_dimension) / f64::from(width.max(height)))
        .min(1.0);
    (
        ((f64::from(width) * scale) as u32).max(1),
        ((f64::from(height) * scale) as u32).max(1),
    )
}

#[wasm_bindgen]
pub fn decode_overlay_image(
    bytes: &[u8],
    max_dimension: u32,
) -> Result<DecodedOverlayImage, JsValue> {
    if bytes.is_empty() || bytes.len() > MAX_ENCODED_BYTES || !(1..=4096).contains(&max_dimension) {
        return Err(JsValue::from_str("Editor overlay image is invalid"));
    }
    let format =
        image::guess_format(bytes).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(MAX_DECODED_ALLOCATION);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(JsValue::from_str("Editor overlay image is too large"));
    }
    let orientation = decoder
        .orientation()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let mut decoded = DynamicImage::from_decoder(decoder)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    decoded.apply_orientation(orientation);
    let mut rgba = decoded.into_rgba8();
    for pixel in rgba.pixels_mut() {
        let alpha = u16::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u16::from(*channel) * alpha + 127) / 255) as u8;
        }
    }
    let (texture_width, texture_height) =
        overlay_texture_dimensions(rgba.width(), rgba.height(), max_dimension);
    if rgba.dimensions() != (texture_width, texture_height) {
        rgba = image::imageops::resize(&rgba, texture_width, texture_height, FilterType::Triangle);
    }
    let mut levels: Vec<RgbaImage> = vec![rgba];
    while let Some(previous) = levels.last() {
        let (width, height) = previous.dimensions();
        if width == 1 && height == 1 {
            break;
        }
        levels.push(image::imageops::resize(
            previous,
            (width / 2).max(1),
            (height / 2).max(1),
            FilterType::Triangle,
        ));
    }
    Ok(DecodedOverlayImage {
        levels: levels
            .into_iter()
            .map(|image| DecodedImage {
                width: image.width(),
                height: image.height(),
                pixels: image.into_raw(),
            })
            .collect(),
    })
}
