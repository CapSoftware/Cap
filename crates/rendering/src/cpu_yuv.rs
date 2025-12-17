pub fn nv12_to_rgba(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    let width = width as usize;
    let height = height as usize;
    let y_stride = y_stride as usize;
    let uv_stride = uv_stride as usize;

    for row in 0..height {
        let y_row_start = row * y_stride;
        let uv_row_start = (row / 2) * uv_stride;
        let out_row_start = row * width * 4;

        for col in 0..width {
            let y_idx = y_row_start + col;
            let uv_idx = uv_row_start + (col / 2) * 2;

            let y = y_data.get(y_idx).copied().unwrap_or(0) as i32;
            let u = uv_data.get(uv_idx).copied().unwrap_or(128) as i32;
            let v = uv_data.get(uv_idx + 1).copied().unwrap_or(128) as i32;

            let c = y - 16;
            let d = u - 128;
            let e = v - 128;

            let r = clamp_u8((298 * c + 409 * e + 128) >> 8);
            let g = clamp_u8((298 * c - 100 * d - 208 * e + 128) >> 8);
            let b = clamp_u8((298 * c + 516 * d + 128) >> 8);

            let out_idx = out_row_start + col * 4;
            if out_idx + 3 < output.len() {
                output[out_idx] = r;
                output[out_idx + 1] = g;
                output[out_idx + 2] = b;
                output[out_idx + 3] = 255;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn yuv420p_to_rgba(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    let width = width as usize;
    let height = height as usize;
    let y_stride = y_stride as usize;
    let uv_stride = uv_stride as usize;

    for row in 0..height {
        let y_row_start = row * y_stride;
        let uv_row_start = (row / 2) * uv_stride;
        let out_row_start = row * width * 4;

        for col in 0..width {
            let y_idx = y_row_start + col;
            let uv_idx = uv_row_start + (col / 2);

            let y = y_data.get(y_idx).copied().unwrap_or(0) as i32;
            let u = u_data.get(uv_idx).copied().unwrap_or(128) as i32;
            let v = v_data.get(uv_idx).copied().unwrap_or(128) as i32;

            let c = y - 16;
            let d = u - 128;
            let e = v - 128;

            let r = clamp_u8((298 * c + 409 * e + 128) >> 8);
            let g = clamp_u8((298 * c - 100 * d - 208 * e + 128) >> 8);
            let b = clamp_u8((298 * c + 516 * d + 128) >> 8);

            let out_idx = out_row_start + col * 4;
            if out_idx + 3 < output.len() {
                output[out_idx] = r;
                output[out_idx + 1] = g;
                output[out_idx + 2] = b;
                output[out_idx + 3] = 255;
            }
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
pub fn nv12_to_rgba_simd(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::*;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    if !is_x86_feature_detected!("sse2") {
        return nv12_to_rgba(y_data, uv_data, width, height, y_stride, uv_stride, output);
    }

    let width_usize = width as usize;
    let height_usize = height as usize;
    let y_stride_usize = y_stride as usize;
    let uv_stride_usize = uv_stride as usize;

    if width_usize == 0 || height_usize == 0 {
        return;
    }

    let y_required = (height_usize - 1)
        .saturating_mul(y_stride_usize)
        .saturating_add(width_usize);

    let uv_height = height_usize.div_ceil(2);
    let uv_width_bytes = width_usize.div_ceil(2) * 2;
    let uv_required = uv_height
        .saturating_sub(1)
        .saturating_mul(uv_stride_usize)
        .saturating_add(uv_width_bytes);

    let output_required = width_usize.saturating_mul(height_usize).saturating_mul(4);

    let strides_valid = y_stride_usize >= width_usize && uv_stride_usize >= uv_width_bytes;

    if !strides_valid
        || y_data.len() < y_required
        || uv_data.len() < uv_required
        || output.len() < output_required
    {
        return nv12_to_rgba(y_data, uv_data, width, height, y_stride, uv_stride, output);
    }

    debug_assert!(
        y_stride_usize >= width_usize,
        "Y stride ({y_stride_usize}) must be >= width ({width_usize})"
    );
    debug_assert!(
        uv_stride_usize >= uv_width_bytes,
        "UV stride ({uv_stride_usize}) must be >= UV width bytes ({uv_width_bytes})"
    );
    debug_assert!(
        y_data.len() >= y_required,
        "Y buffer too small: {} < {y_required}",
        y_data.len()
    );
    debug_assert!(
        uv_data.len() >= uv_required,
        "UV buffer too small: {} < {uv_required}",
        uv_data.len()
    );
    debug_assert!(
        output.len() >= output_required,
        "Output buffer too small: {} < {output_required}",
        output.len()
    );

    let simd_width = (width_usize / 8) * 8;

    unsafe {
        let c16 = _mm_set1_epi16(16);
        let c128 = _mm_set1_epi16(128);
        let c298 = _mm_set1_epi16(298);
        let c409 = _mm_set1_epi16(409);
        let c100 = _mm_set1_epi16(100);
        let c208 = _mm_set1_epi16(208);
        let c516 = _mm_set1_epi16(516);
        let zero = _mm_setzero_si128();

        for row in 0..height_usize {
            let y_row_start = row * y_stride_usize;
            let uv_row_start = (row / 2) * uv_stride_usize;
            let out_row_start = row * width_usize * 4;

            let mut col = 0usize;

            while col + 8 <= simd_width {
                let y_ptr = y_data.as_ptr().add(y_row_start + col);
                let uv_ptr = uv_data.as_ptr().add(uv_row_start + (col / 2) * 2);

                let y8 = _mm_loadl_epi64(y_ptr as *const __m128i);
                let y16 = _mm_unpacklo_epi8(y8, zero);
                let y_adj = _mm_sub_epi16(y16, c16);

                let uv8 = _mm_loadl_epi64(uv_ptr as *const __m128i);

                let u8_val = _mm_and_si128(uv8, _mm_set1_epi16(0x00FF));
                let v8_val = _mm_srli_epi16(uv8, 8);

                let u_dup = _mm_unpacklo_epi16(u8_val, u8_val);
                let v_dup = _mm_unpacklo_epi16(v8_val, v8_val);

                let u16 = _mm_unpacklo_epi8(u_dup, zero);
                let v16 = _mm_unpacklo_epi8(v_dup, zero);

                let d = _mm_sub_epi16(u16, c128);
                let e = _mm_sub_epi16(v16, c128);

                let c_scaled = _mm_mullo_epi16(y_adj, c298);

                let r_raw = _mm_add_epi16(c_scaled, _mm_mullo_epi16(e, c409));
                let r_raw = _mm_add_epi16(r_raw, c128);
                let r_raw = _mm_srai_epi16(r_raw, 8);

                let g_raw = _mm_sub_epi16(c_scaled, _mm_mullo_epi16(d, c100));
                let g_raw = _mm_sub_epi16(g_raw, _mm_mullo_epi16(e, c208));
                let g_raw = _mm_add_epi16(g_raw, c128);
                let g_raw = _mm_srai_epi16(g_raw, 8);

                let b_raw = _mm_add_epi16(c_scaled, _mm_mullo_epi16(d, c516));
                let b_raw = _mm_add_epi16(b_raw, c128);
                let b_raw = _mm_srai_epi16(b_raw, 8);

                let r = _mm_packus_epi16(r_raw, zero);
                let g = _mm_packus_epi16(g_raw, zero);
                let b = _mm_packus_epi16(b_raw, zero);
                let a = _mm_set1_epi8(-1i8);

                let rg_lo = _mm_unpacklo_epi8(r, g);
                let ba_lo = _mm_unpacklo_epi8(b, a);
                let rgba_lo = _mm_unpacklo_epi16(rg_lo, ba_lo);
                let rgba_hi = _mm_unpackhi_epi16(rg_lo, ba_lo);

                let out_ptr = output.as_mut_ptr().add(out_row_start + col * 4);
                _mm_storeu_si128(out_ptr as *mut __m128i, rgba_lo);
                _mm_storeu_si128(out_ptr.add(16) as *mut __m128i, rgba_hi);

                col += 8;
            }

            for col in simd_width..width_usize {
                let y_idx = y_row_start + col;
                let uv_idx = uv_row_start + (col / 2) * 2;

                let y = y_data.get(y_idx).copied().unwrap_or(0) as i32;
                let u = uv_data.get(uv_idx).copied().unwrap_or(128) as i32;
                let v = uv_data.get(uv_idx + 1).copied().unwrap_or(128) as i32;

                let c = y - 16;
                let d = u - 128;
                let e = v - 128;

                let r = clamp_u8((298 * c + 409 * e + 128) >> 8);
                let g = clamp_u8((298 * c - 100 * d - 208 * e + 128) >> 8);
                let b = clamp_u8((298 * c + 516 * d + 128) >> 8);

                let out_idx = out_row_start + col * 4;
                if out_idx + 3 < output.len() {
                    output[out_idx] = r;
                    output[out_idx + 1] = g;
                    output[out_idx + 2] = b;
                    output[out_idx + 3] = 255;
                }
            }
        }
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
pub fn nv12_to_rgba_simd(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    nv12_to_rgba(y_data, uv_data, width, height, y_stride, uv_stride, output);
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
pub fn yuv420p_to_rgba_simd(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::*;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    if !is_x86_feature_detected!("sse2") {
        return yuv420p_to_rgba(
            y_data, u_data, v_data, width, height, y_stride, uv_stride, output,
        );
    }

    let width_usize = width as usize;
    let height_usize = height as usize;
    let y_stride_usize = y_stride as usize;
    let uv_stride_usize = uv_stride as usize;

    if width_usize == 0 || height_usize == 0 {
        return;
    }

    let y_required = (height_usize - 1)
        .saturating_mul(y_stride_usize)
        .saturating_add(width_usize);

    let uv_height = height_usize.div_ceil(2);
    let uv_width = width_usize.div_ceil(2);
    let uv_required = uv_height
        .saturating_sub(1)
        .saturating_mul(uv_stride_usize)
        .saturating_add(uv_width);

    let output_required = width_usize.saturating_mul(height_usize).saturating_mul(4);

    let strides_valid = y_stride_usize >= width_usize && uv_stride_usize >= uv_width;

    if !strides_valid
        || y_data.len() < y_required
        || u_data.len() < uv_required
        || v_data.len() < uv_required
        || output.len() < output_required
    {
        return yuv420p_to_rgba(
            y_data, u_data, v_data, width, height, y_stride, uv_stride, output,
        );
    }

    debug_assert!(
        y_stride_usize >= width_usize,
        "Y stride ({y_stride_usize}) must be >= width ({width_usize})"
    );
    debug_assert!(
        uv_stride_usize >= uv_width,
        "UV stride ({uv_stride_usize}) must be >= UV width ({uv_width})"
    );
    debug_assert!(
        y_data.len() >= y_required,
        "Y buffer too small: {} < {y_required}",
        y_data.len()
    );
    debug_assert!(
        u_data.len() >= uv_required,
        "U buffer too small: {} < {uv_required}",
        u_data.len()
    );
    debug_assert!(
        v_data.len() >= uv_required,
        "V buffer too small: {} < {uv_required}",
        v_data.len()
    );
    debug_assert!(
        output.len() >= output_required,
        "Output buffer too small: {} < {output_required}",
        output.len()
    );

    let simd_width = (width_usize / 8) * 8;

    unsafe {
        let c16 = _mm_set1_epi16(16);
        let c128 = _mm_set1_epi16(128);
        let c298 = _mm_set1_epi16(298);
        let c409 = _mm_set1_epi16(409);
        let c100 = _mm_set1_epi16(100);
        let c208 = _mm_set1_epi16(208);
        let c516 = _mm_set1_epi16(516);
        let zero = _mm_setzero_si128();

        for row in 0..height_usize {
            let y_row_start = row * y_stride_usize;
            let uv_row_start = (row / 2) * uv_stride_usize;
            let out_row_start = row * width_usize * 4;

            let mut col = 0usize;

            while col + 8 <= simd_width {
                let y_ptr = y_data.as_ptr().add(y_row_start + col);
                let u_ptr = u_data.as_ptr().add(uv_row_start + col / 2);
                let v_ptr = v_data.as_ptr().add(uv_row_start + col / 2);

                let y8 = _mm_loadl_epi64(y_ptr as *const __m128i);
                let y16 = _mm_unpacklo_epi8(y8, zero);
                let y_adj = _mm_sub_epi16(y16, c16);

                let u4 = _mm_cvtsi32_si128(std::ptr::read_unaligned(u_ptr as *const i32));
                let v4 = _mm_cvtsi32_si128(std::ptr::read_unaligned(v_ptr as *const i32));

                let u_dup = _mm_unpacklo_epi8(u4, u4);
                let v_dup = _mm_unpacklo_epi8(v4, v4);

                let u16 = _mm_unpacklo_epi8(u_dup, zero);
                let v16 = _mm_unpacklo_epi8(v_dup, zero);

                let d = _mm_sub_epi16(u16, c128);
                let e = _mm_sub_epi16(v16, c128);

                let c_scaled = _mm_mullo_epi16(y_adj, c298);

                let r_raw = _mm_add_epi16(c_scaled, _mm_mullo_epi16(e, c409));
                let r_raw = _mm_add_epi16(r_raw, c128);
                let r_raw = _mm_srai_epi16(r_raw, 8);

                let g_raw = _mm_sub_epi16(c_scaled, _mm_mullo_epi16(d, c100));
                let g_raw = _mm_sub_epi16(g_raw, _mm_mullo_epi16(e, c208));
                let g_raw = _mm_add_epi16(g_raw, c128);
                let g_raw = _mm_srai_epi16(g_raw, 8);

                let b_raw = _mm_add_epi16(c_scaled, _mm_mullo_epi16(d, c516));
                let b_raw = _mm_add_epi16(b_raw, c128);
                let b_raw = _mm_srai_epi16(b_raw, 8);

                let r = _mm_packus_epi16(r_raw, zero);
                let g = _mm_packus_epi16(g_raw, zero);
                let b = _mm_packus_epi16(b_raw, zero);
                let a = _mm_set1_epi8(-1i8);

                let rg_lo = _mm_unpacklo_epi8(r, g);
                let ba_lo = _mm_unpacklo_epi8(b, a);
                let rgba_lo = _mm_unpacklo_epi16(rg_lo, ba_lo);
                let rgba_hi = _mm_unpackhi_epi16(rg_lo, ba_lo);

                let out_ptr = output.as_mut_ptr().add(out_row_start + col * 4);
                _mm_storeu_si128(out_ptr as *mut __m128i, rgba_lo);
                _mm_storeu_si128(out_ptr.add(16) as *mut __m128i, rgba_hi);

                col += 8;
            }

            for col in simd_width..width_usize {
                let y_idx = y_row_start + col;
                let uv_idx = uv_row_start + (col / 2);

                let y = y_data.get(y_idx).copied().unwrap_or(0) as i32;
                let u = u_data.get(uv_idx).copied().unwrap_or(128) as i32;
                let v = v_data.get(uv_idx).copied().unwrap_or(128) as i32;

                let c = y - 16;
                let d = u - 128;
                let e = v - 128;

                let r = clamp_u8((298 * c + 409 * e + 128) >> 8);
                let g = clamp_u8((298 * c - 100 * d - 208 * e + 128) >> 8);
                let b = clamp_u8((298 * c + 516 * d + 128) >> 8);

                let out_idx = out_row_start + col * 4;
                if out_idx + 3 < output.len() {
                    output[out_idx] = r;
                    output[out_idx + 1] = g;
                    output[out_idx + 2] = b;
                    output[out_idx + 3] = 255;
                }
            }
        }
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
#[allow(clippy::too_many_arguments)]
pub fn yuv420p_to_rgba_simd(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    yuv420p_to_rgba(
        y_data, u_data, v_data, width, height, y_stride, uv_stride, output,
    );
}

#[inline(always)]
fn clamp_u8(val: i32) -> u8 {
    val.clamp(0, 255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nv12_basic_conversion() {
        let width = 4u32;
        let height = 4u32;
        let y_stride = 4u32;
        let uv_stride = 4u32;

        let y_data: Vec<u8> = vec![
            128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
        ];
        let uv_data: Vec<u8> = vec![128, 128, 128, 128, 128, 128, 128, 128];

        let mut output = vec![0u8; (width * height * 4) as usize];
        nv12_to_rgba(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output,
        );

        for pixel in output.chunks(4) {
            assert!(pixel[0] > 100 && pixel[0] < 140);
            assert!(pixel[1] > 100 && pixel[1] < 140);
            assert!(pixel[2] > 100 && pixel[2] < 140);
            assert_eq!(pixel[3], 255);
        }
    }

    #[test]
    fn test_nv12_simd_matches_scalar() {
        let width = 16u32;
        let height = 8u32;
        let y_stride = 16u32;
        let uv_stride = 16u32;

        let y_data: Vec<u8> = (0..width * height).map(|i| ((i * 7) % 256) as u8).collect();
        let uv_data: Vec<u8> = (0..uv_stride * height / 2)
            .map(|i| ((i * 11 + 64) % 256) as u8)
            .collect();

        let mut output_scalar = vec![0u8; (width * height * 4) as usize];
        let mut output_simd = vec![0u8; (width * height * 4) as usize];

        nv12_to_rgba(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output_scalar,
        );

        nv12_to_rgba_simd(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output_simd,
        );

        for (i, (s, d)) in output_scalar.iter().zip(output_simd.iter()).enumerate() {
            let diff = (*s as i32 - *d as i32).abs();
            assert!(
                diff <= 2,
                "Mismatch at index {}: scalar={}, simd={}, diff={}",
                i,
                s,
                d,
                diff
            );
        }
    }
}
