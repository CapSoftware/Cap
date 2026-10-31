//! Limited-range BT.601 YUYV422 (`Y0 U Y1 V`) to tight BGRA.
//!
//! Coefficients match the integer reference used for untagged YUV:
//! `298*(Y-16)`, chroma `(409, 100, 208, 516)`, bias `+128`, arithmetic
//! `>> 8`, then clamp to `0..=255`. Alpha is 255. `mirrored` reverses each
//! row while storing.

pub fn to_bgra(
    data: &[u8],
    width: usize,
    stride: usize,
    height: usize,
    mirrored: bool,
) -> Option<Vec<u8>> {
    convert(data, width, stride, height, mirrored, Dispatch::Fast)
}

#[doc(hidden)]
pub fn to_bgra_scalar(
    data: &[u8],
    width: usize,
    stride: usize,
    height: usize,
    mirrored: bool,
) -> Option<Vec<u8>> {
    convert(data, width, stride, height, mirrored, Dispatch::Scalar)
}

enum Dispatch {
    Fast,
    Scalar,
}

fn convert(
    data: &[u8],
    width: usize,
    stride: usize,
    height: usize,
    mirrored: bool,
    dispatch: Dispatch,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 {
        return Some(Vec::new());
    }
    if !width.is_multiple_of(2) {
        return None;
    }
    let row_bytes = width.checked_mul(2)?;
    let output_len = width.checked_mul(4)?.checked_mul(height)?;
    if stride < row_bytes || !covers(stride, row_bytes, height, data.len()) {
        return None;
    }

    let mut pixels = Vec::with_capacity(output_len);
    let src = data.as_ptr();
    // SAFETY: `covers` makes every row's `row_bytes` readable. `pixels` has
    // `output_len` bytes of spare capacity. Both writers initialize that range
    // through raw pointers before `set_len`. The AVX2 writer runs only after a
    // runtime check.
    unsafe {
        let dst = pixels.spare_capacity_mut().as_mut_ptr().cast::<u8>();
        match dispatch {
            Dispatch::Scalar => convert_scalar(src, dst, width, stride, height, mirrored),
            Dispatch::Fast => {
                #[cfg(target_arch = "x86_64")]
                if std::arch::is_x86_feature_detected!("avx2") {
                    avx2::convert(src, dst, width, stride, height, mirrored);
                } else {
                    convert_scalar(src, dst, width, stride, height, mirrored);
                }
                #[cfg(not(target_arch = "x86_64"))]
                convert_scalar(src, dst, width, stride, height, mirrored);
            }
        }
        pixels.set_len(output_len);
    }
    Some(pixels)
}

fn covers(stride: usize, row_bytes: usize, height: usize, len: usize) -> bool {
    stride
        .checked_mul(height - 1)
        .and_then(|last| last.checked_add(row_bytes))
        .is_some_and(|need| need <= len)
}

fn convert_scalar(
    src: *const u8,
    dst: *mut u8,
    width: usize,
    stride: usize,
    height: usize,
    mirrored: bool,
) {
    let row_bytes = width * 2;
    let out_row = width * 4;
    for row in 0..height {
        // SAFETY: caller checked `covers` and reserved `width * height * 4`
        // writable bytes. `convert_tail` initializes every output pixel.
        unsafe {
            let input = std::slice::from_raw_parts(src.add(row * stride), row_bytes);
            convert_tail(input, dst.add(row * out_row), width, 0, mirrored);
        }
    }
}

/// # Safety
/// `src` holds `width * 2` initialized bytes. `dst` can store `width` BGRA
/// pixels and may be uninitialized. `width` is even, `x_start` is even, and
/// `x_start <= width`. Pixels before `x_start` are left untouched.
unsafe fn convert_tail(src: &[u8], dst: *mut u8, width: usize, x_start: usize, mirrored: bool) {
    let mut x = x_start;
    while x + 1 < width {
        let offset = x * 2;
        let u = src[offset + 1];
        let v = src[offset + 3];
        unsafe {
            put(dst, width, x, bt601(src[offset], u, v), mirrored);
            put(dst, width, x + 1, bt601(src[offset + 2], u, v), mirrored);
        }
        x += 2;
    }
}

/// # Safety
/// `dst` can store `width` BGRA pixels. `x < width`.
unsafe fn put(dst: *mut u8, width: usize, x: usize, pixel: [u8; 4], mirrored: bool) {
    let index = if mirrored { width - 1 - x } else { x };
    unsafe {
        dst.add(index * 4).cast::<[u8; 4]>().write(pixel);
    }
}

#[inline(always)]
fn bt601(y: u8, u: u8, v: u8) -> [u8; 4] {
    let c = i32::from(y) - 16;
    let d = i32::from(u) - 128;
    let e = i32::from(v) - 128;
    let luma = 298 * c;
    [
        sat((luma + 516 * d + 128) >> 8),
        sat((luma - 100 * d - 208 * e + 128) >> 8),
        sat((luma + 409 * e + 128) >> 8),
        255,
    ]
}

#[inline(always)]
fn sat(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

#[cfg(target_arch = "x86_64")]
mod avx2 {
    use std::arch::x86_64::*;

    use super::convert_tail;

    #[target_feature(enable = "avx2")]
    pub(super) unsafe fn convert(
        src: *const u8,
        dst: *mut u8,
        width: usize,
        stride: usize,
        height: usize,
        mirrored: bool,
    ) {
        unsafe {
            let coeffs = Coeffs::new();
            if mirrored {
                convert_frame::<true>(src, dst, width, stride, height, &coeffs);
            } else {
                convert_frame::<false>(src, dst, width, stride, height, &coeffs);
            }
        }
    }

    struct Coeffs {
        y_shuf: __m128i,
        u_shuf: __m128i,
        v_shuf: __m128i,
        sixteen: __m256i,
        cx128: __m256i,
        bias: __m256i,
        k298: __m256i,
        k516: __m256i,
        k100: __m256i,
        k208: __m256i,
        k409: __m256i,
        alpha: __m256i,
        zero: __m256i,
        max: __m256i,
        rev: __m256i,
    }

    impl Coeffs {
        #[target_feature(enable = "avx2")]
        fn new() -> Self {
            Self {
                y_shuf: _mm_setr_epi8(0, 2, 4, 6, 8, 10, 12, 14, -1, -1, -1, -1, -1, -1, -1, -1),
                u_shuf: _mm_setr_epi8(1, 1, 5, 5, 9, 9, 13, 13, -1, -1, -1, -1, -1, -1, -1, -1),
                v_shuf: _mm_setr_epi8(3, 3, 7, 7, 11, 11, 15, 15, -1, -1, -1, -1, -1, -1, -1, -1),
                sixteen: _mm256_set1_epi32(16),
                cx128: _mm256_set1_epi32(128),
                bias: _mm256_set1_epi32(128),
                k298: _mm256_set1_epi32(298),
                k516: _mm256_set1_epi32(516),
                k100: _mm256_set1_epi32(100),
                k208: _mm256_set1_epi32(208),
                k409: _mm256_set1_epi32(409),
                alpha: _mm256_set1_epi32(0xFF00_0000u32 as i32),
                zero: _mm256_setzero_si256(),
                max: _mm256_set1_epi32(255),
                rev: _mm256_setr_epi32(7, 6, 5, 4, 3, 2, 1, 0),
            }
        }
    }

    #[target_feature(enable = "avx2")]
    unsafe fn convert_frame<const MIRROR: bool>(
        src: *const u8,
        dst: *mut u8,
        width: usize,
        stride: usize,
        height: usize,
        coeffs: &Coeffs,
    ) {
        unsafe {
            let simd = width & !7;
            let row_bytes = width * 2;
            let out_row = width * 4;
            for row in 0..height {
                let s = src.add(row * stride);
                let d = dst.add(row * out_row);
                let mut x = 0;
                while x + 16 <= simd {
                    let packed = _mm256_loadu_si256(s.add(x * 2).cast());
                    convert8::<MIRROR>(_mm256_castsi256_si128(packed), d, x, width, coeffs);
                    convert8::<MIRROR>(
                        _mm256_extracti128_si256(packed, 1),
                        d,
                        x + 8,
                        width,
                        coeffs,
                    );
                    x += 16;
                }
                if x + 8 <= simd {
                    convert8::<MIRROR>(_mm_loadu_si128(s.add(x * 2).cast()), d, x, width, coeffs);
                    x += 8;
                }
                if x < width {
                    let input = std::slice::from_raw_parts(s, row_bytes);
                    convert_tail(input, d, width, x, MIRROR);
                }
            }
        }
    }

    #[target_feature(enable = "avx2")]
    unsafe fn convert8<const MIRROR: bool>(
        packed: __m128i,
        dst: *mut u8,
        x: usize,
        width: usize,
        c: &Coeffs,
    ) {
        unsafe {
            let y = _mm256_cvtepu8_epi32(_mm_shuffle_epi8(packed, c.y_shuf));
            let u = _mm256_cvtepu8_epi32(_mm_shuffle_epi8(packed, c.u_shuf));
            let v = _mm256_cvtepu8_epi32(_mm_shuffle_epi8(packed, c.v_shuf));
            let luma_c = _mm256_sub_epi32(y, c.sixteen);
            let d = _mm256_sub_epi32(u, c.cx128);
            let e = _mm256_sub_epi32(v, c.cx128);
            let luma = _mm256_mullo_epi32(luma_c, c.k298);
            let biased = _mm256_add_epi32(luma, c.bias);
            let b = sat8(
                _mm256_srai_epi32(_mm256_add_epi32(biased, _mm256_mullo_epi32(d, c.k516)), 8),
                c,
            );
            let g = sat8(
                _mm256_srai_epi32(
                    _mm256_sub_epi32(
                        biased,
                        _mm256_add_epi32(
                            _mm256_mullo_epi32(d, c.k100),
                            _mm256_mullo_epi32(e, c.k208),
                        ),
                    ),
                    8,
                ),
                c,
            );
            let r = sat8(
                _mm256_srai_epi32(_mm256_add_epi32(biased, _mm256_mullo_epi32(e, c.k409)), 8),
                c,
            );
            let px = _mm256_or_si256(
                _mm256_or_si256(b, _mm256_slli_epi32(g, 8)),
                _mm256_or_si256(_mm256_slli_epi32(r, 16), c.alpha),
            );
            let (px, at) = if MIRROR {
                (_mm256_permutevar8x32_epi32(px, c.rev), (width - x - 8) * 4)
            } else {
                (px, x * 4)
            };
            _mm256_storeu_si256(dst.add(at).cast(), px);
        }
    }

    #[target_feature(enable = "avx2")]
    fn sat8(value: __m256i, c: &Coeffs) -> __m256i {
        _mm256_min_epi32(_mm256_max_epi32(value, c.zero), c.max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scalar(
        data: &[u8],
        width: usize,
        stride: usize,
        height: usize,
        mirrored: bool,
    ) -> Option<Vec<u8>> {
        to_bgra_scalar(data, width, stride, height, mirrored)
    }

    fn assert_match(data: &[u8], width: usize, stride: usize, height: usize, mirrored: bool) {
        assert_eq!(
            to_bgra(data, width, stride, height, mirrored).unwrap(),
            scalar(data, width, stride, height, mirrored).unwrap(),
            "w={width} stride={stride} h={height} mirror={mirrored}"
        );
    }

    #[test]
    fn known_pixels_match_the_integer_formula() {
        // (Y, U, V, B, G, R)
        let cases = [
            (16u8, 128u8, 128u8, 0u8, 0u8, 0u8),
            (235, 128, 128, 255, 255, 255),
            (128, 128, 128, 130, 130, 130),
            (81, 90, 240, 0, 0, 255),
            (235, 90, 240, 178, 179, 255),
            (16, 128, 255, 0, 0, 203),
            (16, 0, 128, 0, 50, 0),
        ];
        for (y, u, v, b, g, r) in cases {
            let src = [y, u, y, v];
            let expected = [b, g, r, 255, b, g, r, 255];
            assert_eq!(
                scalar(&src, 2, 4, 1, false).unwrap(),
                expected,
                "{y} {u} {v}"
            );
            assert_eq!(
                to_bgra(&src, 2, 4, 1, false).unwrap(),
                expected,
                "{y} {u} {v}"
            );
            assert_eq!(bt601(y, u, v), [b, g, r, 255], "{y} {u} {v}");
        }
    }

    #[test]
    fn mirror_is_a_per_row_pixel_reverse() {
        for (width, height, pad) in [
            (2usize, 1usize, 0usize),
            (8, 3, 16),
            (10, 2, 4),
            (1920, 2, 32),
        ] {
            let stride = width * 2 + pad;
            let data: Vec<u8> = (0..stride * height).map(|i| (i * 17 + 3) as u8).collect();
            for mirrored in [false, true] {
                assert_match(&data, width, stride, height, mirrored);
            }
            let forward = scalar(&data, width, stride, height, false).unwrap();
            let reversed = scalar(&data, width, stride, height, true).unwrap();
            let mut expect = Vec::with_capacity(forward.len());
            for row in forward.chunks(width * 4) {
                for pixel in row.chunks(4).rev() {
                    expect.extend_from_slice(pixel);
                }
            }
            assert_eq!(reversed, expect, "{width}x{height}");
        }
    }

    #[test]
    fn every_yuv_triple_matches_on_the_simd_body_and_the_tail() {
        for v in 0..=255u8 {
            let mut src = vec![0u8; 256 * 256 * 4];
            for u in 0..=255u8 {
                for y in 0..=255u8 {
                    let i = (u as usize * 256 + y as usize) * 4;
                    src[i] = y;
                    src[i + 1] = u;
                    src[i + 2] = y ^ 0xff;
                    src[i + 3] = v;
                }
            }
            let width = 256 * 256 * 2;
            assert_match(&src, width, width * 2, 1, false);
        }

        let mut tail = vec![0u8; 28 * 3];
        for (i, byte) in tail.iter_mut().enumerate() {
            *byte = (i * 19 + 7) as u8;
        }
        assert_match(&tail, 14, 28, 3, false);
        assert_match(&tail, 14, 28, 3, true);
    }

    #[test]
    fn rejects_odd_widths_and_short_buffers() {
        assert_eq!(to_bgra(&[0; 8], 3, 6, 1, false), None);
        assert_eq!(to_bgra(&[0; 6], 2, 4, 2, false), None);
        assert_eq!(to_bgra(&[0; 8], 4, 2, 1, false), None);
        assert_eq!(to_bgra(&[], 0, 0, 4, true), Some(Vec::new()));
        assert_eq!(to_bgra(&[0; 8], 4, 8, 0, false), Some(Vec::new()));
    }

    #[test]
    fn padding_bytes_are_not_read() {
        let mut data = vec![0xA5u8; 32 * 2];
        data[0..8].copy_from_slice(&[16, 128, 235, 128, 81, 90, 81, 240]);
        data[32..40].copy_from_slice(&[128, 128, 128, 128, 16, 0, 16, 128]);
        let got = to_bgra(&data, 4, 32, 2, false).unwrap();
        let tight = [
            16u8, 128, 235, 128, 81, 90, 81, 240, 128, 128, 128, 128, 16, 0, 16, 128,
        ];
        assert_eq!(got, scalar(&tight, 4, 8, 2, false).unwrap());
        assert!(!got.contains(&0xA5));
    }
}
