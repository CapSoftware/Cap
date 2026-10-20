use image::RgbaImage;
use std::borrow::Cow;

pub fn fit_centered(image: &RgbaImage, target_width: u32, target_height: u32) -> RgbaImage {
    let width = image.width();
    let height = image.height();

    if width == target_width && height == target_height {
        return image.clone();
    }

    if width == 0 || height == 0 {
        return RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
    }

    let scale = (target_width as f32 / width as f32)
        .min(target_height as f32 / height as f32)
        .max(f32::MIN_POSITIVE);

    let scaled_width = (width as f32 * scale)
        .round()
        .clamp(1.0, target_width as f32) as u32;
    let scaled_height = (height as f32 * scale)
        .round()
        .clamp(1.0, target_height as f32) as u32;

    let resized = if (scaled_width, scaled_height) == image.dimensions() {
        Cow::Borrowed(image)
    } else {
        Cow::Owned(resize_lanczos3(
            image,
            scaled_width.max(1),
            scaled_height.max(1),
        ))
    };

    let offset_x = (target_width - scaled_width) / 2;
    let offset_y = (target_height - scaled_height) / 2;

    let mut canvas = RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));

    let target_stride = target_width as usize * 4;
    let row_bytes = scaled_width as usize * 4;
    let canvas_raw = canvas.as_mut();
    let resized_raw = resized.as_raw();

    if crate::screenshot::is_opaque(resized_raw) {
        for y in 0..scaled_height as usize {
            let canvas_start = (y + offset_y as usize) * target_stride + offset_x as usize * 4;
            let resized_start = y * row_bytes;
            canvas_raw[canvas_start..canvas_start + row_bytes]
                .copy_from_slice(&resized_raw[resized_start..resized_start + row_bytes]);
        }
    } else {
        image::imageops::overlay(&mut canvas, &*resized, offset_x as i64, offset_y as i64);
    }

    canvas
}

// Same weights and per-pixel f32 accumulation order as
// `image::imageops::resize(.., FilterType::Lanczos3)`, so the output is
// byte-identical; only the loop order changes, so whole blocks of a row stay in
// registers and vectorize instead of one generic `get_pixel` per tap.
fn resize_lanczos3(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    let source_row = image.width() as usize * 4;
    let mut vertical = vec![0f32; source_row * height as usize];
    vertical_pass(
        &mut vertical,
        image.as_raw(),
        &lanczos3_taps(image.height(), height),
        source_row,
    );

    let columns = lanczos3_taps(image.width(), width);
    let mut resized = RgbaImage::new(width, height);
    for (output, row) in resized
        .chunks_exact_mut(width as usize * 4)
        .zip(vertical.chunks_exact(source_row))
    {
        for (pixel, taps) in output.chunks_exact_mut(4).zip(&columns) {
            let mut sum = [0f32; 4];
            for (index, weight) in taps.weights.iter().enumerate() {
                let start = (taps.start + index) * 4;
                for (channel, &value) in sum.iter_mut().zip(&row[start..start + 4]) {
                    *channel += value * weight;
                }
            }
            for (channel, value) in pixel.iter_mut().zip(sum) {
                *channel = value.clamp(0.0, 255.0).round() as u8;
            }
        }
    }
    resized
}

fn vertical_pass(vertical: &mut [f32], pixels: &[u8], rows: &[Taps], source_row: usize) {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("avx2") {
        unsafe { vertical_pass_avx2(vertical, pixels, rows, source_row) };
        return;
    }
    vertical_pass_portable(vertical, pixels, rows, source_row);
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
fn vertical_pass_avx2(vertical: &mut [f32], pixels: &[u8], rows: &[Taps], source_row: usize) {
    vertical_pass_portable(vertical, pixels, rows, source_row);
}

#[inline(always)]
fn vertical_pass_portable(vertical: &mut [f32], pixels: &[u8], rows: &[Taps], source_row: usize) {
    for (row, taps) in vertical.chunks_exact_mut(source_row).zip(rows) {
        let mut blocks = row.chunks_exact_mut(VERTICAL_BLOCK);
        for (block_index, block) in blocks.by_ref().enumerate() {
            let offset = block_index * VERTICAL_BLOCK;
            let mut sums = [0f32; VERTICAL_BLOCK];
            for (index, &weight) in taps.weights.iter().enumerate() {
                let start = (taps.start + index) * source_row + offset;
                let values: &[u8; VERTICAL_BLOCK] =
                    pixels[start..start + VERTICAL_BLOCK].try_into().unwrap();
                for (sum, &value) in sums.iter_mut().zip(values) {
                    *sum += f32::from(value) * weight;
                }
            }
            block.copy_from_slice(&sums);
        }
        let remainder = blocks.into_remainder();
        let offset = source_row - remainder.len();
        for (index, &weight) in taps.weights.iter().enumerate() {
            let start = (taps.start + index) * source_row + offset;
            for (sum, &value) in remainder.iter_mut().zip(&pixels[start..]) {
                *sum += f32::from(value) * weight;
            }
        }
    }
}

const VERTICAL_BLOCK: usize = 32;

struct Taps {
    start: usize,
    weights: Vec<f32>,
}

fn lanczos3_taps(source: u32, target: u32) -> Vec<Taps> {
    let ratio = source as f32 / target as f32;
    let scale = if ratio < 1.0 { 1.0 } else { ratio };
    let support = 3.0 * scale;
    (0..target)
        .map(|index| {
            let center = (index as f32 + 0.5) * ratio;
            let start = ((center - support).floor() as i64).clamp(0, i64::from(source) - 1);
            let end = ((center + support).ceil() as i64).clamp(start + 1, i64::from(source));
            let center = center - 0.5;
            let mut weights = (start..end)
                .map(|tap| lanczos3((tap as f32 - center) / scale))
                .collect::<Vec<_>>();
            let mut total = 0.0;
            for weight in &weights {
                total += weight;
            }
            for weight in &mut weights {
                *weight /= total;
            }
            Taps {
                start: start as usize,
                weights,
            }
        })
        .collect()
}

fn lanczos3(x: f32) -> f32 {
    fn sinc(t: f32) -> f32 {
        let a = t * std::f32::consts::PI;
        if t == 0.0 { 1.0 } else { a.sin() / a }
    }

    if x.abs() < 3.0 {
        sinc(x) * sinc(x / 3.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fit_centered_with_unconditional_resize(
        image: &RgbaImage,
        target_width: u32,
        target_height: u32,
    ) -> RgbaImage {
        let width = image.width();
        let height = image.height();
        if width == target_width && height == target_height {
            return image.clone();
        }
        if width == 0 || height == 0 {
            return RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
        }
        let scale = (target_width as f32 / width as f32)
            .min(target_height as f32 / height as f32)
            .max(f32::MIN_POSITIVE);
        let scaled_width = (width as f32 * scale)
            .round()
            .clamp(1.0, target_width as f32) as u32;
        let scaled_height = (height as f32 * scale)
            .round()
            .clamp(1.0, target_height as f32) as u32;
        let resized = image::imageops::resize(
            image,
            scaled_width.max(1),
            scaled_height.max(1),
            image::imageops::FilterType::Lanczos3,
        );
        let mut canvas =
            RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
        image::imageops::overlay(
            &mut canvas,
            &resized,
            i64::from((target_width - scaled_width) / 2),
            i64::from((target_height - scaled_height) / 2),
        );
        canvas
    }

    fn source(width: u32, height: u32, alpha: Option<u8>) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([
                (x * 17 + y * 31) as u8,
                (x * 43 + y * 7) as u8,
                211,
                alpha.unwrap_or((x + y * width) as u8),
            ])
        })
    }

    fn assert_matches_reference(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
        let unchanged = image.clone();
        let expected = fit_centered_with_unconditional_resize(image, width, height);
        let actual = fit_centered(image, width, height);
        assert_eq!(actual.dimensions(), (width, height));
        assert!(
            actual == expected,
            "RGBA output changed for {:?} into {width}x{height}",
            image.dimensions()
        );
        assert_eq!(image, &unchanged);
        actual
    }

    #[test]
    fn fitted_sources_keep_exact_centering_and_transparent_padding() {
        for (width, height, target_width, target_height) in [
            (218, 180, 320, 180),
            (320, 134, 320, 180),
            (180, 180, 320, 180),
            (320, 175, 320, 180),
            (1, 1, 3, 1),
            (2, 1, 5, 1),
            (1, 2, 1, 5),
            (3, 2, 3, 3),
        ] {
            for alpha in [Some(255), None, Some(0)] {
                let source = source(width, height, alpha);
                let actual = assert_matches_reference(&source, target_width, target_height);
                let left = (target_width - width) / 2;
                let top = (target_height - height) / 2;
                for (x, y, pixel) in actual.enumerate_pixels() {
                    if x < left || y < top || x >= left + width || y >= top + height {
                        assert_eq!(*pixel, image::Rgba([0, 0, 0, 0]));
                    } else if alpha == Some(255) {
                        assert_eq!(pixel, source.get_pixel(x - left, y - top));
                    }
                }
                if alpha == Some(0) {
                    assert!(actual.as_raw().iter().all(|value| *value == 0));
                }
            }
        }
    }

    #[test]
    fn resized_sources_match_lanczos_reference() {
        for (width, height, target_width, target_height) in [
            (53, 31, 320, 180),
            (640, 360, 320, 180),
            (641, 361, 320, 180),
            (7, 9, 16, 16),
            (17, 9, 8, 8),
            (1, 7, 4, 4),
            (7, 1, 4, 4),
            (1, 1, 3, 5),
            (2, 3, 1, 1),
        ] {
            for alpha in [Some(255), None, Some(0)] {
                assert_matches_reference(
                    &source(width, height, alpha),
                    target_width,
                    target_height,
                );
            }
        }
    }

    #[test]
    fn exact_size_preserves_hidden_rgb_and_source_pixels() {
        for alpha in [Some(255), None, Some(0)] {
            let source = source(320, 180, alpha);
            let actual = assert_matches_reference(&source, 320, 180);
            assert_eq!(actual, source);
        }
    }

    #[test]
    fn empty_sources_produce_transparent_canvas() {
        for (width, height) in [(0, 0), (0, 7), (9, 0)] {
            let source = RgbaImage::new(width, height);
            for (target_width, target_height) in [(320, 180), (1, 1), (0, 5), (7, 0), (0, 0)] {
                let actual = assert_matches_reference(&source, target_width, target_height);
                assert!(actual.as_raw().iter().all(|value| *value == 0));
            }
        }
    }

    fn noise(width: u32, height: u32) -> RgbaImage {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64 ^ u64::from(width * 31 + height);
        RgbaImage::from_fn(width, height, |_, _| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            image::Rgba((state >> 32).to_le_bytes()[..4].try_into().unwrap())
        })
    }

    #[test]
    fn lanczos3_matches_image_resize_byte_for_byte() {
        for (width, height, target_width, target_height) in [
            (3840, 2160, 320, 180),
            (2560, 1600, 288, 180),
            (1920, 1080, 320, 180),
            (1366, 768, 320, 180),
            (777, 1333, 104, 180),
            (321, 181, 320, 180),
            (320, 400, 320, 180),
            (100, 60, 320, 180),
            (1, 999, 1, 180),
            (999, 1, 320, 1),
        ] {
            let source = noise(width, height);
            let expected = image::imageops::resize(
                &source,
                target_width,
                target_height,
                image::imageops::FilterType::Lanczos3,
            );
            assert!(
                resize_lanczos3(&source, target_width, target_height) == expected,
                "{width}x{height} into {target_width}x{target_height}"
            );
        }
    }

    #[test]
    fn portable_vertical_pass_matches_the_dispatched_one() {
        for (width, height, target_height) in [(3840, 2160, 180), (1001, 777, 180), (7, 9, 16)] {
            let source = noise(width, height);
            let source_row = width as usize * 4;
            let rows = lanczos3_taps(height, target_height);
            let mut dispatched = vec![0f32; source_row * target_height as usize];
            let mut portable = dispatched.clone();
            vertical_pass(&mut dispatched, source.as_raw(), &rows, source_row);
            vertical_pass_portable(&mut portable, source.as_raw(), &rows, source_row);
            assert!(
                dispatched
                    .iter()
                    .zip(&portable)
                    .all(|(a, b)| a.to_bits() == b.to_bits()),
                "{width}x{height}"
            );
        }
    }
}
