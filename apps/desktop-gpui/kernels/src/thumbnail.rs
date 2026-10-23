use image::{DynamicImage, RgbaImage};
use std::borrow::Cow;

const PRESCALE_HEADROOM: u32 = 4;
const MAX_PRESCALE_FACTOR: u32 = u8::MAX as u32;

pub fn fit_centered(image: &RgbaImage, target_width: u32, target_height: u32) -> RgbaImage {
    let width = image.width();
    let height = image.height();

    if width == target_width && height == target_height {
        return image.clone();
    }

    if width == 0 || height == 0 {
        return RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
    }

    let (scaled_width, scaled_height) = fitted_size(width, height, target_width, target_height);

    let resized = if (scaled_width, scaled_height) == image.dimensions() {
        Cow::Borrowed(image)
    } else {
        Cow::Owned(resize_lanczos3(
            image,
            scaled_width.max(1),
            scaled_height.max(1),
        ))
    };

    place_centered(&resized, target_width, target_height)
}

/// [`fit_centered`] for a full-resolution RGB or RGBA capture. A source more
/// than `2 * PRESCALE_HEADROOM` times the fitted size is box-averaged by a
/// whole factor first, leaving Lanczos3 at least `PRESCALE_HEADROOM` times the
/// fitted size to filter; anything smaller takes [`fit_centered`] unchanged.
pub fn fit_centered_capture(
    image: DynamicImage,
    target_width: u32,
    target_height: u32,
) -> RgbaImage {
    let (width, height) = (image.width(), image.height());
    let channels = match &image {
        DynamicImage::ImageRgb8(_) => 3,
        DynamicImage::ImageRgba8(_) => 4,
        _ => 0,
    };
    let factor =
        if channels == 0 || width == 0 || height == 0 || target_width == 0 || target_height == 0 {
            1
        } else {
            prescale_factor(width, height, target_width, target_height)
        };
    if factor < 2 {
        return fit_centered(&image.into_rgba8(), target_width, target_height);
    }

    let (scaled_width, scaled_height) = fitted_size(width, height, target_width, target_height);
    let reduced = match channels {
        3 => box_downscale::<3>(image.as_bytes(), width, height, factor),
        _ => box_downscale::<4>(image.as_bytes(), width, height, factor),
    };
    let resized = resize_lanczos3_at(
        &reduced,
        scaled_width,
        scaled_height,
        width as f32 / (factor * scaled_width) as f32,
        height as f32 / (factor * scaled_height) as f32,
    );
    place_centered(&resized, target_width, target_height)
}

fn prescale_factor(width: u32, height: u32, target_width: u32, target_height: u32) -> u32 {
    let (scaled_width, scaled_height) = fitted_size(width, height, target_width, target_height);
    (width / (scaled_width * PRESCALE_HEADROOM))
        .min(height / (scaled_height * PRESCALE_HEADROOM))
        .min(MAX_PRESCALE_FACTOR)
}

fn fitted_size(width: u32, height: u32, target_width: u32, target_height: u32) -> (u32, u32) {
    let scale = (target_width as f32 / width as f32)
        .min(target_height as f32 / height as f32)
        .max(f32::MIN_POSITIVE);

    let scaled_width = (width as f32 * scale)
        .round()
        .clamp(1.0, target_width as f32) as u32;
    let scaled_height = (height as f32 * scale)
        .round()
        .clamp(1.0, target_height as f32) as u32;
    (scaled_width, scaled_height)
}

fn place_centered(resized: &RgbaImage, target_width: u32, target_height: u32) -> RgbaImage {
    let (scaled_width, scaled_height) = resized.dimensions();
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
        image::imageops::overlay(&mut canvas, resized, offset_x as i64, offset_y as i64);
    }

    canvas
}

/// Average `factor` x `factor` blocks of packed `CHANNELS`-byte pixels into
/// RGBA, rounding to nearest. The last row and column of blocks average only
/// the pixels they cover, so no edge pixels are lost.
fn box_downscale<const CHANNELS: usize>(
    pixels: &[u8],
    width: u32,
    height: u32,
    factor: u32,
) -> RgbaImage {
    let (width, height, factor) = (width as usize, height as usize, factor as usize);
    let stride = width * CHANNELS;
    let reduced_width = width.div_ceil(factor);
    let reduced_height = height.div_ceil(factor);
    let mut reduced = RgbaImage::new(reduced_width as u32, reduced_height as u32);
    let mut columns = vec![0u16; stride];
    for (output, band) in reduced
        .chunks_exact_mut(reduced_width * 4)
        .zip(pixels[..stride * height].chunks(stride * factor))
    {
        columns.fill(0);
        accumulate_rows(&mut columns, band);
        let band_rows = band.len() / stride;
        let full = BlockDivisor::new((band_rows * factor) as u32);
        let last = BlockDivisor::new((band_rows * (width - (reduced_width - 1) * factor)) as u32);
        for (index, (pixel, block)) in output
            .chunks_exact_mut(4)
            .zip(columns.chunks(factor * CHANNELS))
            .enumerate()
        {
            let divisor = if index + 1 == reduced_width {
                &last
            } else {
                &full
            };
            let mut sums = [0u32; CHANNELS];
            for source in block.chunks_exact(CHANNELS) {
                for (sum, &value) in sums.iter_mut().zip(source) {
                    *sum += u32::from(value);
                }
            }
            for (channel, sum) in pixel.iter_mut().zip(sums) {
                *channel = divisor.rounded(sum);
            }
            if CHANNELS == 3 {
                pixel[3] = u8::MAX;
            }
        }
    }
    reduced
}

/// `(sum + count / 2) / count` by a reciprocal multiply. Exact while
/// `256 * count^2 < 2^40`, which `MAX_PRESCALE_FACTOR` keeps.
struct BlockDivisor {
    half: u32,
    multiplier: u64,
}

impl BlockDivisor {
    fn new(count: u32) -> Self {
        Self {
            half: count / 2,
            multiplier: (1u64 << 40) / u64::from(count) + 1,
        }
    }

    fn rounded(&self, sum: u32) -> u8 {
        ((u64::from(sum + self.half) * self.multiplier) >> 40) as u8
    }
}

fn accumulate_rows(columns: &mut [u16], band: &[u8]) {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("avx2") {
        unsafe { accumulate_rows_avx2(columns, band) };
        return;
    }
    accumulate_rows_portable(columns, band);
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
fn accumulate_rows_avx2(columns: &mut [u16], band: &[u8]) {
    accumulate_rows_portable(columns, band);
}

#[inline(always)]
fn accumulate_rows_portable(columns: &mut [u16], band: &[u8]) {
    for row in band.chunks_exact(columns.len()) {
        for (sum, &value) in columns.iter_mut().zip(row) {
            *sum += u16::from(value);
        }
    }
}

// Same weights and per-pixel f32 accumulation order as
// `image::imageops::resize(.., FilterType::Lanczos3)`, so the output is
// byte-identical; only the loop order changes, so whole blocks of a row stay in
// registers and vectorize instead of one generic `get_pixel` per tap.
// Kept out of line so inlining it doesn't slow `fit_centered`'s no-resize paths.
#[inline(never)]
fn resize_lanczos3(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    resize_lanczos3_at(
        image,
        width,
        height,
        image.width() as f32 / width as f32,
        image.height() as f32 / height as f32,
    )
}

fn resize_lanczos3_at(
    image: &RgbaImage,
    width: u32,
    height: u32,
    ratio_x: f32,
    ratio_y: f32,
) -> RgbaImage {
    let source_row = image.width() as usize * 4;
    let mut vertical = vec![0f32; source_row * height as usize];
    vertical_pass(
        &mut vertical,
        image.as_raw(),
        &lanczos3_taps_at(image.height(), height, ratio_y),
        source_row,
    );

    let columns = lanczos3_taps_at(image.width(), width, ratio_x);
    let mut resized = RgbaImage::new(width, height);
    let output_row = width as usize * 4;
    let mut outputs = resized.chunks_exact_mut(output_row * HORIZONTAL_ROWS);
    let mut inputs = vertical.chunks_exact(source_row * HORIZONTAL_ROWS);
    for (output, input) in outputs.by_ref().zip(inputs.by_ref()) {
        horizontal_pass::<HORIZONTAL_ROWS>(output, input, &columns);
    }
    for (output, input) in outputs
        .into_remainder()
        .chunks_exact_mut(output_row)
        .zip(inputs.remainder().chunks_exact(source_row))
    {
        horizontal_pass::<1>(output, input, &columns);
    }
    resized
}

// Each pixel's sum is one chain of dependent additions, so ROWS rows that
// share the same taps run side by side to keep the adders busy.
fn horizontal_pass<const ROWS: usize>(output: &mut [u8], input: &[f32], columns: &[Taps]) {
    let output_row = output.len() / ROWS;
    let source_row = input.len() / ROWS;
    let rows: [&[[f32; 4]]; ROWS] =
        std::array::from_fn(|row| input[row * source_row..][..source_row].as_chunks().0);
    for (column, taps) in columns.iter().enumerate() {
        let windows = rows.map(|row| &row[taps.start..taps.start + taps.weights.len()]);
        let mut sums = [[0f32; 4]; ROWS];
        for (index, &weight) in taps.weights.iter().enumerate() {
            for (sum, window) in sums.iter_mut().zip(&windows) {
                for (channel, &value) in sum.iter_mut().zip(&window[index]) {
                    *channel += value * weight;
                }
            }
        }
        for (row, sum) in sums.iter().enumerate() {
            let pixel = &mut output[row * output_row + column * 4..][..4];
            for (channel, value) in pixel.iter_mut().zip(sum) {
                *channel = value.clamp(0.0, 255.0).round() as u8;
            }
        }
    }
}

const HORIZONTAL_ROWS: usize = 8;

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

#[cfg(test)]
fn lanczos3_taps(source: u32, target: u32) -> Vec<Taps> {
    lanczos3_taps_at(source, target, source as f32 / target as f32)
}

fn lanczos3_taps_at(source: u32, target: u32, ratio: f32) -> Vec<Taps> {
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
            (1920, 1080, 319, 179),
            (2560, 1440, 320, 13),
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

    fn rgb(image: &RgbaImage) -> DynamicImage {
        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(image.clone()).into_rgb8())
    }

    fn opaque_noise(width: u32, height: u32) -> RgbaImage {
        let mut image = noise(width, height);
        for pixel in image.pixels_mut() {
            pixel[3] = 255;
        }
        image
    }

    fn interface(width: u32, height: u32) -> RgbaImage {
        let mut image = RgbaImage::from_pixel(width, height, image::Rgba([236, 236, 236, 255]));
        for x in (0..width).step_by(97) {
            for y in 0..height {
                image.put_pixel(x, y, image::Rgba([40, 40, 40, 255]));
            }
        }
        for top in (0..height.saturating_sub(12)).step_by(23) {
            let left = (top * 7) % (width / 2);
            for y in top..top + 12 {
                for x in left..(left + width / 3).min(width) {
                    image.put_pixel(x, y, image::Rgba([30, 90, 200, 255]));
                }
            }
        }
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        for _ in 0..4000 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let x = (state >> 33) as u32 % (width - 8);
            let y = (state >> 13) as u32 % (height - 14);
            for dy in 0..12 {
                image.put_pixel(x, y + dy, image::Rgba([20, 20, 20, 255]));
            }
            for dx in 0..6 {
                image.put_pixel(x + dx, y, image::Rgba([20, 20, 20, 255]));
            }
        }
        image
    }

    fn checker(width: u32, height: u32, period: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let value = if (x / period + y / period) % 2 == 0 {
                0
            } else {
                255
            };
            image::Rgba([value, value, value, 255])
        })
    }

    fn gradient(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([
                (x * 255 / width) as u8,
                (y * 255 / height) as u8,
                ((x + y) * 255 / (width + height)) as u8,
                255,
            ])
        })
    }

    fn psnr(reference: &RgbaImage, actual: &RgbaImage) -> f64 {
        let squared: f64 = reference
            .as_raw()
            .iter()
            .zip(actual.as_raw())
            .map(|(&a, &b)| (f64::from(a) - f64::from(b)).powi(2))
            .sum();
        let mse = squared / reference.as_raw().len() as f64;
        if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255.0 * 255.0 / mse).log10()
        }
    }

    fn ssim(reference: &RgbaImage, actual: &RgbaImage) -> (f64, f64) {
        let luma = |image: &RgbaImage| -> Vec<f64> {
            image
                .pixels()
                .map(|p| (f64::from(p[0]) + f64::from(p[1]) + f64::from(p[2])) / 3.0)
                .collect()
        };
        let (a, b) = (luma(reference), luma(actual));
        let (width, height) = (reference.width() as usize, reference.height() as usize);
        let (c1, c2) = ((0.01 * 255.0f64).powi(2), (0.03 * 255.0f64).powi(2));
        let (mut total, mut count, mut worst) = (0.0, 0, f64::INFINITY);
        for top in (0..=height - 8).step_by(4) {
            for left in (0..=width - 8).step_by(4) {
                let window = |values: &[f64]| -> Vec<f64> {
                    (top..top + 8)
                        .flat_map(|y| (left..left + 8).map(move |x| y * width + x))
                        .map(|index| values[index])
                        .collect()
                };
                let (wa, wb) = (window(&a), window(&b));
                let mean = |w: &[f64]| w.iter().sum::<f64>() / 64.0;
                let (ma, mb) = (mean(&wa), mean(&wb));
                let (mut va, mut vb, mut cov) = (0.0, 0.0, 0.0);
                for (x, y) in wa.iter().zip(&wb) {
                    va += (x - ma).powi(2) / 64.0;
                    vb += (y - mb).powi(2) / 64.0;
                    cov += (x - ma) * (y - mb) / 64.0;
                }
                let value = ((2.0 * ma * mb + c1) * (2.0 * cov + c2))
                    / ((ma * ma + mb * mb + c1) * (va + vb + c2));
                total += value;
                count += 1;
                worst = worst.min(value);
            }
        }
        (total / f64::from(count), worst)
    }

    #[test]
    fn box_downscale_averages_blocks_and_keeps_partial_edges() {
        let pixels: Vec<u8> = (0..5 * 3 * 3).map(|value| value as u8 * 5).collect();
        let reduced = box_downscale::<3>(&pixels, 5, 3, 2);
        assert_eq!(reduced.dimensions(), (3, 2));
        let expected = |x: u32, y: u32| -> [u8; 4] {
            let mut rgba = [0u8, 0, 0, 255];
            for (channel, value) in rgba.iter_mut().take(3).enumerate() {
                let mut sum = 0u32;
                let mut count = 0u32;
                for sy in y * 2..(y * 2 + 2).min(3) {
                    for sx in x * 2..(x * 2 + 2).min(5) {
                        sum += u32::from(pixels[((sy * 5 + sx) * 3) as usize + channel]);
                        count += 1;
                    }
                }
                *value = ((sum + count / 2) / count) as u8;
            }
            rgba
        };
        for (x, y, pixel) in reduced.enumerate_pixels() {
            assert_eq!(pixel.0, expected(x, y), "{x},{y}");
        }

        let rgba = noise(7, 5);
        let reduced = box_downscale::<4>(rgba.as_raw(), 7, 5, 3);
        assert_eq!(reduced.dimensions(), (3, 2));
        let corner = rgba.get_pixel(6, 3).0;
        let below = rgba.get_pixel(6, 4).0;
        for channel in 0..4 {
            let sum = u32::from(corner[channel]) + u32::from(below[channel]);
            assert_eq!(u32::from(reduced.get_pixel(2, 1)[channel]), (sum + 1) / 2);
        }
    }

    #[test]
    fn block_divisor_rounds_like_integer_division() {
        let check = |count: u32, sum: u32| {
            assert_eq!(
                u32::from(BlockDivisor::new(count).rounded(sum)),
                (sum + count / 2) / count,
                "{sum} / {count}"
            );
        };
        for count in 1..=64 {
            for sum in 0..=255 * count {
                check(count, sum);
            }
        }
        let max = MAX_PRESCALE_FACTOR * MAX_PRESCALE_FACTOR;
        for count in (65..=max).step_by(97).chain([max - 1, max]) {
            for quotient in [0, 1, 127, 128, 254, 255] {
                for offset in [0, 1, count / 2 - 1, count / 2, count / 2 + 1, count - 1] {
                    let sum = quotient * count + offset;
                    if sum <= 255 * count {
                        check(count, sum);
                    }
                }
            }
        }
    }

    #[test]
    fn box_downscale_does_not_overflow_at_the_largest_factor() {
        let side = MAX_PRESCALE_FACTOR;
        for value in [255u8, 254, 1] {
            let pixels = vec![value; (side * side * 3) as usize];
            let reduced = box_downscale::<3>(&pixels, side, side, side);
            assert_eq!(reduced.get_pixel(0, 0).0, [value, value, value, 255]);
        }
        assert_eq!(
            prescale_factor(400_000, 225_000, 320, 180),
            MAX_PRESCALE_FACTOR
        );
    }

    #[test]
    fn capture_fit_is_exact_below_the_prescale_threshold() {
        for (width, height) in [
            (1920, 1080),
            (1366, 768),
            (2001, 1201),
            (2559, 1439),
            (640, 360),
            (320, 180),
            (160, 90),
            (1, 1),
            (0, 0),
        ] {
            let source = noise(width, height);
            let expected = fit_centered(&source, 320, 180);
            assert!(
                fit_centered_capture(DynamicImage::ImageRgba8(source.clone()), 320, 180)
                    == expected,
                "rgba {width}x{height}"
            );
            let opaque = rgb(&source);
            let expected = fit_centered(&opaque.to_rgba8(), 320, 180);
            assert!(
                fit_centered_capture(opaque, 320, 180) == expected,
                "rgb {width}x{height}"
            );
        }
    }

    #[test]
    fn capture_fit_stays_within_tight_bounds_of_the_exact_fit() {
        for (width, height) in [
            (3840, 2160),
            (2560, 1440),
            (2561, 1441),
            (3440, 1440),
            (5120, 2880),
            (1440, 2560),
        ] {
            assert!(prescale_factor(width, height, 320, 180) >= 2);
            let sources: [(&str, RgbaImage); 9] = [
                ("noise", opaque_noise(width, height)),
                ("noise-alpha", noise(width, height)),
                ("interface", interface(width, height)),
                ("gradient", gradient(width, height)),
                ("checker-2", checker(width, height, 2)),
                ("checker-3", checker(width, height, 3)),
                ("checker-5", checker(width, height, 5)),
                ("checker-7", checker(width, height, 7)),
                ("checker-1", checker(width, height, 1)),
            ];
            for (name, source) in sources {
                let expected = fit_centered(&source, 320, 180);
                let input = if source.pixels().all(|pixel| pixel[3] == 255) {
                    rgb(&source)
                } else {
                    DynamicImage::ImageRgba8(source)
                };
                let actual = fit_centered_capture(input, 320, 180);
                assert_eq!(actual.dimensions(), expected.dimensions());
                for (a, b) in actual.pixels().zip(expected.pixels()) {
                    assert_eq!(a[3] == 0, b[3] == 0, "{name} {width}x{height} padding");
                }
                let psnr = psnr(&expected, &actual);
                let (ssim_mean, ssim_min) = ssim(&expected, &actual);
                println!(
                    "{name} {width}x{height}: psnr {psnr:.2} dB, ssim mean {ssim_mean:.5}, min {ssim_min:.5}"
                );
                assert!(psnr >= 44.0, "{name} {width}x{height}: psnr {psnr:.2}");
                assert!(
                    ssim_mean >= 0.99 && ssim_min >= 0.98,
                    "{name} {width}x{height}: ssim {ssim_mean:.5} min {ssim_min:.5}"
                );
            }
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
