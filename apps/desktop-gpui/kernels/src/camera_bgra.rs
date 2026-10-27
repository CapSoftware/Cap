//! Even-width 1:1 YUYV, UYVY, and NV12 to BGRA for the non-macOS camera preview.
//!
//! The 8.8 gains match `cap_rendering::cpu_yuv`, which this crate does not call:
//! that crate depends on the renderer, writes RGBA, and does not sample packed
//! 4:2:2 or swscale's quantized NV12 vertical filter. Odd widths return `None`
//! so the preview keeps swscale, which resamples that chroma. The pair loop is
//! autovectorized (SSE4.1 or AVX2 on x86, NEON on aarch64). x86 without SSE4.1
//! stays on swscale: its SSE2 loop loses to swscale on 720p NV12.

use std::sync::OnceLock;

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
use std::arch::is_x86_feature_detected;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Packed422 {
    Yuyv,
    Uyvy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Level {
    Portable,
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    Sse41,
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    Avx2,
    /// x86 with neither SSE4.1 nor AVX2. The public API returns `None`.
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    Swscale,
}

pub fn simd_path() -> &'static str {
    match level() {
        Level::Portable => "portable",
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Sse41 => "sse4.1",
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Avx2 => "avx2",
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Swscale => "swscale",
    }
}

pub fn packed422_to_bgra(
    data: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    format: Packed422,
    mirrored: bool,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || !width.is_multiple_of(2) {
        return None;
    }
    let sample_bytes = width * 2;
    if stride < sample_bytes {
        return None;
    }
    let plane_len = stride.checked_mul(height)?;
    if data.len() < plane_len || !kernel_enabled() {
        return None;
    }
    let output_len = width.checked_mul(4)?.checked_mul(height)?;
    Some(alloc_filled(output_len, |pixels| {
        dispatch_packed(data, pixels, width, height, stride, format, mirrored);
    }))
}

pub fn nv12_to_bgra(
    y: &[u8],
    uv: &[u8],
    width: usize,
    height: usize,
    y_stride: usize,
    uv_stride: usize,
    mirrored: bool,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || !width.is_multiple_of(2) {
        return None;
    }
    let uv_rows = height.div_ceil(2);
    if y_stride < width || uv_stride < width {
        return None;
    }
    let y_plane = y_stride.checked_mul(height)?;
    let uv_plane = uv_stride.checked_mul(uv_rows)?;
    if y.len() < y_plane || uv.len() < uv_plane || !kernel_enabled() {
        return None;
    }
    let output_len = width.checked_mul(4)?.checked_mul(height)?;
    Some(alloc_filled(output_len, |pixels| {
        dispatch_nv12(
            Nv12Planes {
                y,
                uv,
                y_stride,
                uv_stride,
            },
            pixels,
            width,
            height,
            mirrored,
        );
    }))
}

struct Nv12Planes<'a> {
    y: &'a [u8],
    uv: &'a [u8],
    y_stride: usize,
    uv_stride: usize,
}

fn dispatch_packed(
    data: &[u8],
    pixels: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    format: Packed422,
    mirrored: bool,
) {
    match level() {
        Level::Portable => write_packed_rows(data, pixels, width, height, stride, format, mirrored),
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Sse41 => unsafe {
            // SAFETY: `level` is `Sse41` only after `is_x86_feature_detected!("sse4.1")`.
            write_packed_sse41(data, pixels, width, height, stride, format, mirrored);
        },
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Avx2 => unsafe {
            // SAFETY: `level` is `Avx2` only after `is_x86_feature_detected!("avx2")`.
            write_packed_avx2(data, pixels, width, height, stride, format, mirrored);
        },
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Swscale => write_packed_rows(data, pixels, width, height, stride, format, mirrored),
    }
}

fn dispatch_nv12(
    planes: Nv12Planes<'_>,
    pixels: &mut [u8],
    width: usize,
    height: usize,
    mirrored: bool,
) {
    match level() {
        Level::Portable => write_nv12_rows(planes, pixels, width, height, mirrored),
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Sse41 => unsafe {
            // SAFETY: `level` is `Sse41` only after `is_x86_feature_detected!("sse4.1")`.
            write_nv12_sse41(planes, pixels, width, height, mirrored);
        },
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Avx2 => unsafe {
            // SAFETY: `level` is `Avx2` only after `is_x86_feature_detected!("avx2")`.
            write_nv12_avx2(planes, pixels, width, height, mirrored);
        },
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Level::Swscale => write_nv12_rows(planes, pixels, width, height, mirrored),
    }
}

fn level() -> Level {
    static LEVEL: OnceLock<Level> = OnceLock::new();
    *LEVEL.get_or_init(detect)
}

fn kernel_enabled() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        !matches!(level(), Level::Swscale)
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        true
    }
}

fn detect() -> Level {
    if let Ok(choice) = std::env::var("CAP_CAMERA_BGRA_SIMD") {
        match choice.as_str() {
            "portable" | "sse2" => return Level::Portable,
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            "sse4.1" | "sse41" if is_x86_feature_detected!("sse4.1") => return Level::Sse41,
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            "avx2" if is_x86_feature_detected!("avx2") => return Level::Avx2,
            _ => {}
        }
    }
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if is_x86_feature_detected!("avx2") {
            return Level::Avx2;
        }
        if is_x86_feature_detected!("sse4.1") {
            return Level::Sse41;
        }
        Level::Swscale
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    Level::Portable
}

fn alloc_filled(output_len: usize, fill: impl FnOnce(&mut [u8])) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(output_len);
    let spare = &mut pixels.spare_capacity_mut()[..output_len];
    // SAFETY: `MaybeUninit<u8>` has the same layout as `u8`. `fill` writes every
    // byte of `spare` before `set_len`, so the `Vec<u8>` is initialized.
    unsafe {
        fill(std::slice::from_raw_parts_mut(
            spare.as_mut_ptr().cast::<u8>(),
            output_len,
        ));
        pixels.set_len(output_len);
    }
    pixels
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "sse4.1")]
unsafe fn write_packed_sse41(
    data: &[u8],
    pixels: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    format: Packed422,
    mirrored: bool,
) {
    write_packed_rows(data, pixels, width, height, stride, format, mirrored);
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "sse4.1")]
unsafe fn write_nv12_sse41(
    planes: Nv12Planes<'_>,
    pixels: &mut [u8],
    width: usize,
    height: usize,
    mirrored: bool,
) {
    write_nv12_rows(planes, pixels, width, height, mirrored);
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn write_packed_avx2(
    data: &[u8],
    pixels: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    format: Packed422,
    mirrored: bool,
) {
    write_packed_rows(data, pixels, width, height, stride, format, mirrored);
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn write_nv12_avx2(
    planes: Nv12Planes<'_>,
    pixels: &mut [u8],
    width: usize,
    height: usize,
    mirrored: bool,
) {
    write_nv12_rows(planes, pixels, width, height, mirrored);
}

#[inline(always)]
fn write_packed_rows(
    data: &[u8],
    pixels: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    format: Packed422,
    mirrored: bool,
) {
    let sample_bytes = width * 2;
    let row_bytes = width * 4;
    for row in 0..height {
        let src = &data[row * stride..row * stride + sample_bytes];
        let dst = &mut pixels[row * row_bytes..(row + 1) * row_bytes];
        match (format, mirrored) {
            (Packed422::Yuyv, false) => packed_pairs::<true, false>(src, dst),
            (Packed422::Yuyv, true) => packed_pairs::<true, true>(src, dst),
            (Packed422::Uyvy, false) => packed_pairs::<false, false>(src, dst),
            (Packed422::Uyvy, true) => packed_pairs::<false, true>(src, dst),
        }
    }
}

#[inline(always)]
fn write_nv12_rows(
    planes: Nv12Planes<'_>,
    pixels: &mut [u8],
    width: usize,
    height: usize,
    mirrored: bool,
) {
    let row_bytes = width * 4;
    for row in 0..height {
        let (uv_index, blend) = vertical_tap(row, height);
        let y_row = &planes.y[row * planes.y_stride..row * planes.y_stride + width];
        let uv_at = uv_index * planes.uv_stride;
        let uv_row = &planes.uv[uv_at..uv_at + width];
        let uv_next = if blend {
            let next = uv_at + planes.uv_stride;
            &planes.uv[next..next + width]
        } else {
            uv_row
        };
        let dst = &mut pixels[row * row_bytes..(row + 1) * row_bytes];
        if mirrored {
            if blend {
                nv12_pairs::<true, true>(y_row, uv_row, uv_next, dst);
            } else {
                nv12_pairs::<false, true>(y_row, uv_row, uv_next, dst);
            }
        } else if blend {
            nv12_pairs::<true, false>(y_row, uv_row, uv_next, dst);
        } else {
            nv12_pairs::<false, false>(y_row, uv_row, uv_next, dst);
        }
    }
}

#[inline(always)]
fn packed_pairs<const YUYV: bool, const MIRROR: bool>(src: &[u8], dst: &mut [u8]) {
    debug_assert!(src.len().is_multiple_of(4));
    debug_assert_eq!(dst.len(), src.len() * 2);
    let (src_pairs, _) = src.as_chunks::<4>();
    let (dst_pairs, _) = dst.as_chunks_mut::<8>();
    if MIRROR {
        for (sample, pixel) in src_pairs.iter().zip(dst_pairs.iter_mut().rev()) {
            write_packed_pair::<YUYV, true>(sample, pixel);
        }
    } else {
        for (sample, pixel) in src_pairs.iter().zip(dst_pairs.iter_mut()) {
            write_packed_pair::<YUYV, false>(sample, pixel);
        }
    }
}

#[inline(always)]
fn write_packed_pair<const YUYV: bool, const MIRROR: bool>(sample: &[u8; 4], pixel: &mut [u8; 8]) {
    let (y0, cb, y1, cr) = if YUYV {
        (sample[0], sample[1], sample[2], sample[3])
    } else {
        (sample[1], sample[0], sample[3], sample[2])
    };
    let l0 = 298 * (i32::from(y0) - 16);
    let l1 = 298 * (i32::from(y1) - 16);
    let cb = i32::from(cb) - 128;
    let cr = i32::from(cr) - 128;
    if MIRROR {
        store_bgra(pixel, l1, l0, cb, cr);
    } else {
        store_bgra(pixel, l0, l1, cb, cr);
    }
}

#[inline(always)]
fn nv12_pairs<const BLEND: bool, const MIRROR: bool>(
    y: &[u8],
    uv0: &[u8],
    uv1: &[u8],
    dst: &mut [u8],
) {
    debug_assert!(y.len().is_multiple_of(2));
    debug_assert!(uv0.len() >= y.len());
    debug_assert!(!BLEND || uv1.len() >= y.len());
    debug_assert_eq!(dst.len(), y.len() * 4);
    let (lumas, _) = y.as_chunks::<2>();
    let (chroma0, _) = uv0.as_chunks::<2>();
    let (chroma1, _) = uv1.as_chunks::<2>();
    let (pixels, _) = dst.as_chunks_mut::<8>();
    if MIRROR {
        for (((luma, c0), c1), pixel) in lumas
            .iter()
            .zip(chroma0)
            .zip(chroma1)
            .zip(pixels.iter_mut().rev())
        {
            write_nv12_pair::<BLEND, true>(luma, c0, c1, pixel);
        }
    } else {
        for (((luma, c0), c1), pixel) in lumas.iter().zip(chroma0).zip(chroma1).zip(pixels) {
            write_nv12_pair::<BLEND, false>(luma, c0, c1, pixel);
        }
    }
}

#[inline(always)]
fn write_nv12_pair<const BLEND: bool, const MIRROR: bool>(
    luma: &[u8; 2],
    chroma0: &[u8; 2],
    chroma1: &[u8; 2],
    pixel: &mut [u8; 8],
) {
    let (cb, cr) = if BLEND {
        (
            i32::from(avg_u8(chroma0[0], chroma1[0])) - 128,
            i32::from(avg_u8(chroma0[1], chroma1[1])) - 128,
        )
    } else {
        (i32::from(chroma0[0]) - 128, i32::from(chroma0[1]) - 128)
    };
    let l0 = 298 * (i32::from(luma[0]) - 16);
    let l1 = 298 * (i32::from(luma[1]) - 16);
    if MIRROR {
        store_bgra(pixel, l1, l0, cb, cr);
    } else {
        store_bgra(pixel, l0, l1, cb, cr);
    }
}

#[inline(always)]
fn store_bgra(pixel: &mut [u8], l0: i32, l1: i32, cb: i32, cr: i32) {
    pixel[0] = clamp8((l0 + 516 * cb + 128) >> 8);
    pixel[1] = clamp8((l0 - 100 * cb - 208 * cr + 128) >> 8);
    pixel[2] = clamp8((l0 + 409 * cr + 128) >> 8);
    pixel[3] = 255;
    pixel[4] = clamp8((l1 + 516 * cb + 128) >> 8);
    pixel[5] = clamp8((l1 - 100 * cb - 208 * cr + 128) >> 8);
    pixel[6] = clamp8((l1 + 409 * cr + 128) >> 8);
    pixel[7] = 255;
}

#[cfg(test)]
fn bt601_bgra(y: u8, cb: u8, cr: u8) -> [u8; 4] {
    let mut pixel = [0u8; 8];
    let luma = 298 * (i32::from(y) - 16);
    store_bgra(
        &mut pixel,
        luma,
        luma,
        i32::from(cb) - 128,
        i32::from(cr) - 128,
    );
    [pixel[0], pixel[1], pixel[2], pixel[3]]
}

#[inline(always)]
fn clamp8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

#[inline(always)]
fn avg_u8(a: u8, b: u8) -> u8 {
    ((u16::from(a) + u16::from(b) + 1) >> 1) as u8
}

// swscale's packed-BGRA bilinear, collapsed to one chroma row or a rounded
// average of two. The preview parity test is what notices if this drifts.
fn vertical_tap(y: usize, height: usize) -> (usize, bool) {
    let src_h = height.div_ceil(2);
    let x_inc = (((src_h as u64) << 16) + ((height as u64) >> 1)) / (height as u64);
    let filter_size = 3.min(src_h.saturating_sub(2)).max(1);
    let x = (x_inc as i64 - 65_536) + (y as i64) * (2 * x_inc as i64);
    let mut pos = (x - (filter_size as i64 - 2) * 65_536) / (1 << 17);
    let mut coeffs = [0i64; 3];
    let mut count = 0usize;
    for sample in pos..pos + filter_size as i64 {
        let delta = sample * (1i64 << 17) - x;
        let mut coeff = (1i64 << 30) - (delta.abs() << 13);
        if coeff < 0 {
            coeff = 0;
        }
        coeffs[count] = coeff;
        count += 1;
    }
    let cutoff = (1i64 << 30) / 500;
    while count > 1 && coeffs[0] <= cutoff {
        coeffs.copy_within(1..count, 0);
        count -= 1;
        pos += 1;
    }
    while count > 1 && coeffs[count - 1] <= cutoff {
        count -= 1;
    }
    if src_h <= 3 {
        return (pos.clamp(0, src_h as i64 - 1) as usize, false);
    }
    let mut pair = [coeffs[0], if count > 1 { coeffs[1] } else { 0 }];
    if pos < 0 {
        pos = 0;
    }
    if pos + 2 > src_h as i64 {
        let shift = pos + (2 - src_h as i64).min(0);
        let mut acc = 0i64;
        let mut tmp = pair;
        for index in (0..2).rev() {
            if pos + index as i64 >= src_h as i64 {
                acc += tmp[index];
                tmp[index] = 0;
            }
        }
        let mut shifted = [0i64; 2];
        for index in (0..2).rev() {
            if index as i64 >= shift {
                shifted[index] = tmp[(index as i64 - shift) as usize];
            }
        }
        pos -= shift;
        let edge = src_h as i64 - 1 - pos;
        if (0..2).contains(&edge) {
            shifted[edge as usize] += acc;
        }
        pair = shifted;
    }
    let pos = pos.clamp(0, src_h as i64 - 1);
    let total = pair[0] + pair[1];
    let norm = ((total + 2048) / 4096).max(1);
    let second = if pair[1] > 0 {
        (pair[1] + (norm >> 1)) / norm
    } else {
        (pair[1] - (norm >> 1)) / norm
    };
    (pos as usize, second >= 2048)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 24) as u8
            })
            .collect()
    }

    fn padded_rows(sample_bytes: usize, stride: usize, height: usize, seed: u32) -> Vec<u8> {
        let mut data = vec![0xA5; stride * height];
        let samples = pattern(sample_bytes * height, seed);
        for row in 0..height {
            let start = row * stride;
            data[start..start + sample_bytes]
                .copy_from_slice(&samples[row * sample_bytes..(row + 1) * sample_bytes]);
        }
        data
    }

    fn levels() -> Vec<Level> {
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            let mut levels = vec![Level::Portable];
            if is_x86_feature_detected!("sse4.1") {
                levels.push(Level::Sse41);
            }
            if is_x86_feature_detected!("avx2") {
                levels.push(Level::Avx2);
            }
            levels
        }
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        {
            vec![Level::Portable]
        }
    }

    fn convert_packed(
        data: &[u8],
        width: usize,
        height: usize,
        stride: usize,
        format: Packed422,
        mirrored: bool,
        level: Level,
    ) -> Vec<u8> {
        let mut pixels = vec![0u8; width * 4 * height];
        match level {
            Level::Portable => {
                write_packed_rows(data, &mut pixels, width, height, stride, format, mirrored);
            }
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Level::Sse41 => unsafe {
                // SAFETY: `levels` only yields `Sse41` after `is_x86_feature_detected!("sse4.1")`.
                write_packed_sse41(data, &mut pixels, width, height, stride, format, mirrored);
            },
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Level::Avx2 => unsafe {
                // SAFETY: `levels` only yields `Avx2` after `is_x86_feature_detected!("avx2")`.
                write_packed_avx2(data, &mut pixels, width, height, stride, format, mirrored);
            },
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Level::Swscale => {
                write_packed_rows(data, &mut pixels, width, height, stride, format, mirrored);
            }
        }
        pixels
    }

    fn convert_nv12(
        y: &[u8],
        uv: &[u8],
        width: usize,
        height: usize,
        strides: (usize, usize),
        level: Level,
        mirrored: bool,
    ) -> Vec<u8> {
        let mut pixels = vec![0u8; width * 4 * height];
        let planes = Nv12Planes {
            y,
            uv,
            y_stride: strides.0,
            uv_stride: strides.1,
        };
        match level {
            Level::Portable => write_nv12_rows(planes, &mut pixels, width, height, mirrored),
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Level::Sse41 => unsafe {
                // SAFETY: `levels` only yields `Sse41` after `is_x86_feature_detected!("sse4.1")`.
                write_nv12_sse41(planes, &mut pixels, width, height, mirrored);
            },
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Level::Avx2 => unsafe {
                // SAFETY: `levels` only yields `Avx2` after `is_x86_feature_detected!("avx2")`.
                write_nv12_avx2(planes, &mut pixels, width, height, mirrored);
            },
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Level::Swscale => write_nv12_rows(planes, &mut pixels, width, height, mirrored),
        }
        pixels
    }

    fn mirror_rows(pixels: &mut [u8], width: usize) {
        let row_bytes = width * 4;
        for row in pixels.chunks_mut(row_bytes) {
            let (pixels, _) = row.as_chunks_mut::<4>();
            pixels.reverse();
        }
    }

    fn assert_packed(format: Packed422, width: usize, height: usize, stride: usize) {
        let sample_bytes = width * 2;
        let data = padded_rows(sample_bytes, stride, height, 0x1234_0000 | width as u32);
        let portable = convert_packed(&data, width, height, stride, format, false, Level::Portable);
        for level in levels() {
            let pixels = convert_packed(&data, width, height, stride, format, false, level);
            assert_eq!(pixels, portable, "{format:?} {width}x{height} {level:?}");
            let mirrored = convert_packed(&data, width, height, stride, format, true, level);
            let mut expected = portable.clone();
            mirror_rows(&mut expected, width);
            assert_eq!(mirrored, expected, "{format:?} mirrored {level:?}");
        }
        let straight = packed422_to_bgra(&data, width, height, stride, format, false).unwrap();
        assert_eq!(straight, portable);
        let mirrored = packed422_to_bgra(&data, width, height, stride, format, true).unwrap();
        let mut expected = portable;
        mirror_rows(&mut expected, width);
        assert_eq!(mirrored, expected);
    }

    fn assert_nv12(width: usize, height: usize, y_stride: usize, uv_stride: usize) {
        let uv_rows = height.div_ceil(2);
        let y = padded_rows(width, y_stride, height, 7);
        let uv = padded_rows(width, uv_stride, uv_rows, 11);
        let strides = (y_stride, uv_stride);
        let portable = convert_nv12(&y, &uv, width, height, strides, Level::Portable, false);
        for level in levels() {
            let pixels = convert_nv12(&y, &uv, width, height, strides, level, false);
            assert_eq!(pixels, portable, "nv12 {width}x{height} {level:?}");
            let mirrored = convert_nv12(&y, &uv, width, height, strides, level, true);
            let mut expected = portable.clone();
            mirror_rows(&mut expected, width);
            assert_eq!(mirrored, expected, "nv12 mirrored {level:?}");
        }
        let public = nv12_to_bgra(&y, &uv, width, height, y_stride, uv_stride, false).unwrap();
        assert_eq!(public, portable);
        let mirrored = nv12_to_bgra(&y, &uv, width, height, y_stride, uv_stride, true).unwrap();
        let mut expected = portable;
        mirror_rows(&mut expected, width);
        assert_eq!(mirrored, expected);
    }

    #[test]
    fn limited_range_grey_axis_is_exact() {
        assert_eq!(bt601_bgra(16, 128, 128), [0, 0, 0, 255]);
        assert_eq!(bt601_bgra(235, 128, 128), [255, 255, 255, 255]);
        assert_eq!(bt601_bgra(128, 128, 128), [130, 130, 130, 255]);
        assert_eq!(bt601_bgra(128, 16, 240), [0, 83, 255, 255]);
    }

    #[test]
    fn odd_widths_are_left_to_swscale() {
        let yuyv = [16u8, 128, 235, 128, 16, 128, 0, 0];
        assert!(packed422_to_bgra(&yuyv, 3, 1, 8, Packed422::Yuyv, false).is_none());
        assert!(packed422_to_bgra(&yuyv, 3, 1, 8, Packed422::Uyvy, true).is_none());
        assert!(nv12_to_bgra(&[128, 128, 128], &[128, 128], 3, 2, 3, 4, false).is_none());
    }

    #[test]
    fn packed_formats_match_across_simd_paths_and_padded_strides() {
        for format in [Packed422::Yuyv, Packed422::Uyvy] {
            for (width, height, stride) in [(2, 2, 4), (8, 1, 16), (16, 2, 40), (30, 5, 64)] {
                assert_packed(format, width, height, stride);
            }
        }
    }

    fn vstep_planes(width: usize, height: usize) -> (Vec<u8>, Vec<u8>) {
        let y = vec![128u8; width * height];
        let mut uv = vec![0u8; width * height.div_ceil(2)];
        for row in 0..height.div_ceil(2) {
            let (cb, cr) = if row.is_multiple_of(2) {
                (16, 240)
            } else {
                (240, 16)
            };
            for col in (0..width).step_by(2) {
                let index = row * width + col;
                uv[index] = cb;
                uv[index + 1] = cr;
            }
        }
        (y, uv)
    }

    fn assert_row_color(pixels: &[u8], width: usize, row: usize, expected: [u8; 4]) {
        let start = row * width * 4;
        let (row_pixels, rest) = pixels[start..start + width * 4].as_chunks::<4>();
        assert!(rest.is_empty());
        for pixel in row_pixels {
            assert_eq!(*pixel, expected, "row {row}");
        }
    }

    #[test]
    fn nv12_vertical_chroma_follows_swscale_bilinear_taps() {
        assert_eq!(
            (0..8).map(|y| vertical_tap(y, 8)).collect::<Vec<_>>(),
            vec![
                (0, false),
                (0, false),
                (0, true),
                (1, false),
                (1, true),
                (2, false),
                (2, true),
                (2, true),
            ]
        );
        assert_eq!(
            (0..6).map(|y| vertical_tap(y, 6)).collect::<Vec<_>>(),
            vec![
                (0, false),
                (0, false),
                (1, false),
                (1, false),
                (2, false),
                (2, false)
            ]
        );
        assert_eq!(vertical_tap(0, 3), (0, false));
        assert_eq!(vertical_tap(1, 3), (1, false));
        assert_eq!(vertical_tap(2, 3), (1, false));
        assert_eq!(vertical_tap(0, 1080), (0, false));
        assert_eq!(vertical_tap(1, 1080), (0, false));
        assert_eq!(vertical_tap(2, 1080), (0, true));
        assert_eq!(vertical_tap(1076, 1080), (537, true));
        assert_eq!(vertical_tap(1077, 1080), (538, false));
        assert_eq!(vertical_tap(1078, 1080), (538, true));
        assert_eq!(vertical_tap(1079, 1080), (538, true));

        let pure_a = [0, 83, 255, 255];
        let pure_b = [255, 178, 0, 255];
        let mixed = [130, 130, 130, 255];
        let (y, uv) = vstep_planes(16, 8);
        let pixels = nv12_to_bgra(&y, &uv, 16, 8, 16, 16, false).unwrap();
        for (row, color) in [pure_a, pure_a, mixed, pure_b, mixed, pure_a, mixed, mixed]
            .into_iter()
            .enumerate()
        {
            assert_row_color(&pixels, 16, row, color);
        }
        for level in levels() {
            let got = convert_nv12(&y, &uv, 16, 8, (16, 16), level, false);
            assert_eq!(got, pixels, "{level:?}");
        }

        let (y, uv) = vstep_planes(8, 6);
        let nearest = nv12_to_bgra(&y, &uv, 8, 6, 8, 8, false).unwrap();
        for (row, color) in [pure_a, pure_a, pure_b, pure_b, pure_a, pure_a]
            .into_iter()
            .enumerate()
        {
            assert_row_color(&nearest, 8, row, color);
        }

        let (y, uv) = vstep_planes(8, 9);
        let odd_height = nv12_to_bgra(&y, &uv, 8, 9, 8, 8, true).unwrap();
        let straight = nv12_to_bgra(&y, &uv, 8, 9, 8, 8, false).unwrap();
        let mut expected = straight;
        mirror_rows(&mut expected, 8);
        assert_eq!(odd_height, expected);
    }

    #[test]
    fn nv12_matches_across_simd_paths_and_padded_strides() {
        for (width, height, y_stride, uv_stride) in
            [(2, 2, 8, 8), (8, 4, 8, 8), (16, 8, 32, 16), (14, 9, 32, 32)]
        {
            assert_nv12(width, height, y_stride, uv_stride);
        }
    }

    #[test]
    fn short_or_empty_planes_are_rejected() {
        assert!(packed422_to_bgra(&[0; 8], 0, 2, 4, Packed422::Yuyv, false).is_none());
        assert!(packed422_to_bgra(&[0; 4], 2, 2, 4, Packed422::Yuyv, false).is_none());
        assert!(packed422_to_bgra(&[0; 8], 3, 1, 4, Packed422::Uyvy, false).is_none());
        assert!(nv12_to_bgra(&[0; 8], &[0; 2], 2, 4, 2, 2, false).is_none());
        assert!(nv12_to_bgra(&[16, 16], &[128, 128], 2, 1, 1, 2, false).is_none());
    }

    #[test]
    fn padding_bytes_do_not_change_active_pixels() {
        let tight =
            packed422_to_bgra(&[16, 128, 235, 128], 2, 1, 4, Packed422::Yuyv, false).unwrap();
        let mut padded = vec![0xA5; 16];
        padded[..4].copy_from_slice(&[16, 128, 235, 128]);
        let wide = packed422_to_bgra(&padded, 2, 1, 16, Packed422::Yuyv, false).unwrap();
        assert_eq!(tight, [0, 0, 0, 255, 255, 255, 255, 255]);
        assert_eq!(wide, tight);
    }
}
