use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// The Y'CbCr matrix a limited-range picture was encoded with, which decides
/// how it converts back to RGB. Decoders take it from the source's colour tag:
/// BT.709 when the stream says so, BT.601 otherwise (untagged sources keep the
/// BT.601 decode they always had).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum YuvMatrix {
    #[default]
    Bt601,
    Bt709,
}

impl YuvMatrix {
    pub fn from_color_space(space: ffmpeg::util::color::Space) -> Self {
        match space {
            ffmpeg::util::color::Space::BT709 => Self::Bt709,
            _ => Self::Bt601,
        }
    }

    /// Limited-range Y'CbCr to RGB in 8.8 fixed point: `c = Y - 16`,
    /// `d = Cb - 128`, `e = Cr - 128`. Luma gain 255/219, chroma gains from
    /// the matrix's Kr and Kb (BT.601 0.299/0.114, BT.709 0.2126/0.0722).
    #[inline(always)]
    pub(crate) fn ycbcr_to_rgb(self, c: i32, d: i32, e: i32) -> [u8; 3] {
        let [red, green, blue] = self.chroma_contributions(d, e);
        let luma = 298 * c;
        [
            clamp_u8((luma + red) >> 8),
            clamp_u8((luma + green) >> 8),
            clamp_u8((luma + blue) >> 8),
        ]
    }

    /// `(rv, gu, gv, bu)` in 8.8 fixed point. Shared with the AVX2 kernel so
    /// the two paths cannot drift.
    #[inline(always)]
    fn chroma_gains(self) -> (i32, i32, i32, i32) {
        match self {
            Self::Bt601 => (409, 100, 208, 516),
            Self::Bt709 => (459, 55, 136, 541),
        }
    }

    #[inline(always)]
    fn chroma_contributions(self, d: i32, e: i32) -> [i32; 3] {
        let (rv, gu, gv, bu) = self.chroma_gains();
        [rv * e + 128, -gu * d - gv * e + 128, bu * d + 128]
    }

    /// Floating-point coefficients for the GPU conversion shaders (pipeline
    /// override constants of nv12_to_rgba.wgsl and yuv420p_to_rgba.wgsl):
    /// R = Y + rv*V, G = Y - gu*U - gv*V, B = Y + bu*U.
    pub(crate) fn shader_constants(self) -> [(&'static str, f64); 4] {
        let (rv, gu, gv, bu) = match self {
            Self::Bt601 => (1.596027, 0.391762, 0.812968, 2.017232),
            Self::Bt709 => (1.792741, 0.213249, 0.532909, 2.112402),
        };
        [("RV", rv), ("GU", gu), ("GV", gv), ("BU", bu)]
    }
}

pub struct ConversionProgress {
    pub rows_completed: AtomicUsize,
    pub total_rows: usize,
    pub cancelled: AtomicBool,
}

impl ConversionProgress {
    pub fn new(total_rows: usize) -> Self {
        Self {
            rows_completed: AtomicUsize::new(0),
            total_rows,
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn progress_fraction(&self) -> f32 {
        if self.total_rows == 0 {
            return 1.0;
        }
        self.rows_completed.load(Ordering::Relaxed) as f32 / self.total_rows as f32
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

// RGB to limited-range BT.709 Y'CbCr in 16.16 fixed point, rounded to the
// nearest code value: the matrix and range every export is tagged with. The
// luma row sums to 219/255 and each chroma row to 0, so the grey axis is
// exact (black 16/128/128, white 235/128/128).
const BT709_Y: [i32; 3] = [11966, 40254, 4064];
const BT709_CB: [i32; 3] = [-6596, -22189, 28785];
const BT709_CR: [i32; 3] = [28785, -26145, -2640];

#[inline(always)]
fn fixed_16(row: [i32; 3], r: i32, g: i32, b: i32) -> i32 {
    (row[0] * r + row[1] * g + row[2] * b + (1 << 15)) >> 16
}

/// BT.709 limited-range luma of an 8-bit RGB pixel.
#[inline(always)]
pub(crate) fn bt709_luma(r: i32, g: i32, b: i32) -> u8 {
    (16 + fixed_16(BT709_Y, r, g, b)).clamp(16, 235) as u8
}

/// BT.709 limited-range (Cb, Cr) of an 8-bit RGB pixel (for 4:2:0, the mean
/// of the 2x2 block).
#[inline(always)]
pub(crate) fn bt709_chroma(r: i32, g: i32, b: i32) -> [u8; 2] {
    [
        (128 + fixed_16(BT709_CB, r, g, b)).clamp(16, 240) as u8,
        (128 + fixed_16(BT709_CR, r, g, b)).clamp(16, 240) as u8,
    ]
}

/// Limited-range BT.709 RGBA8 to tightly packed NV12.
///
/// Luma is one sample per pixel. Chroma is the mean of each complete 2×2
/// block, `(sum + 2) / 4`, then [`bt709_chroma`]. A trailing odd column or row
/// keeps its luma and does not contribute a chroma sample. Rows may be padded;
/// `src_stride` is the byte distance between RGBA rows and must be at least
/// `width * 4` for the vector path.
pub(crate) fn rgba_to_nv12(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut [u8],
) {
    #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
    if is_x86_feature_detected!("avx2")
        && rgba_nv12_bounds_ok(src.len(), src_stride, width, height, dst.len())
    {
        // SAFETY: AVX2 is enabled on this CPU, and the bounds check covers every
        // byte the kernel reads or writes, including the width%8 scalar tail.
        unsafe {
            rgba_to_nv12_avx2(src, src_stride, width, height, dst);
        }
        return;
    }
    rgba_to_nv12_scalar(src, src_stride, width, height, dst);
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
unsafe fn rgba_to_nv12_avx2(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut [u8],
) {
    unsafe {
        rgba_nv12_avx2::convert(src, src_stride, width, height, dst);
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
fn rgba_nv12_bounds_ok(
    src_len: usize,
    src_stride: usize,
    width: usize,
    height: usize,
    dst_len: usize,
) -> bool {
    if width == 0 || height == 0 {
        return false;
    }
    let Some(row_bytes) = width.checked_mul(4) else {
        return false;
    };
    if src_stride < row_bytes {
        return false;
    }
    let Some(src_need) = (height - 1)
        .checked_mul(src_stride)
        .and_then(|offset| offset.checked_add(row_bytes))
    else {
        return false;
    };
    if src_need > src_len {
        return false;
    }
    let Some(y_bytes) = width.checked_mul(height) else {
        return false;
    };
    let Some(uv_bytes) = width.checked_mul(height / 2) else {
        return false;
    };
    y_bytes
        .checked_add(uv_bytes)
        .is_some_and(|dst_need| dst_need <= dst_len)
}

fn rgba_to_nv12_scalar(src: &[u8], src_stride: usize, width: usize, height: usize, dst: &mut [u8]) {
    rgba_to_nv12_rect(src, src_stride, width, height, 0, width, 0, height, dst);
}

#[allow(clippy::too_many_arguments)]
fn rgba_to_nv12_rect(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
    dst: &mut [u8],
) {
    for row in y0..y1 {
        let src_off = row * src_stride + x0 * 4;
        let src_row = &src[src_off..src_off + (x1 - x0) * 4];
        let y_off = row * width + x0;
        let y_row = &mut dst[y_off..y_off + (x1 - x0)];
        for (pixel, y) in src_row.chunks_exact(4).zip(y_row.iter_mut()) {
            *y = bt709_luma(
                i32::from(pixel[0]),
                i32::from(pixel[1]),
                i32::from(pixel[2]),
            );
        }
    }

    let uv_offset = width * height;
    let col_start = x0 / 2;
    let col_end = x1 / 2;
    for row in y0.div_ceil(2)..(y1 / 2) {
        let src0 = row * 2 * src_stride;
        let src1 = src0 + src_stride;
        let uv_off = uv_offset + row * width;
        let uv_row = &mut dst[uv_off..uv_off + width];
        for col in col_start..col_end {
            let r = (i32::from(src[src0 + col * 8])
                + i32::from(src[src0 + col * 8 + 4])
                + i32::from(src[src1 + col * 8])
                + i32::from(src[src1 + col * 8 + 4])
                + 2)
                / 4;
            let g = (i32::from(src[src0 + col * 8 + 1])
                + i32::from(src[src0 + col * 8 + 5])
                + i32::from(src[src1 + col * 8 + 1])
                + i32::from(src[src1 + col * 8 + 5])
                + 2)
                / 4;
            let b = (i32::from(src[src0 + col * 8 + 2])
                + i32::from(src[src0 + col * 8 + 6])
                + i32::from(src[src1 + col * 8 + 2])
                + i32::from(src[src1 + col * 8 + 6])
                + 2)
                / 4;
            [uv_row[col * 2], uv_row[col * 2 + 1]] = bt709_chroma(r, g, b);
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
mod rgba_nv12_avx2 {
    #[cfg(target_arch = "x86")]
    use std::arch::x86::*;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    use super::{BT709_CB, BT709_CR, BT709_Y};

    struct Job {
        src: *const u8,
        src_stride: usize,
        y: *mut u8,
        uv: *mut u8,
        stride: usize,
    }

    struct Coeffs {
        y_r: __m256i,
        y_g: __m256i,
        y_b: __m256i,
        cb_r: __m256i,
        cb_g: __m256i,
        cb_b: __m256i,
        cr_r: __m256i,
        cr_g: __m256i,
        cr_b: __m256i,
        round: __m256i,
        two: __m256i,
        y_bias: __m256i,
        c_bias: __m256i,
        y_lo: __m256i,
        y_hi: __m256i,
        c_lo: __m256i,
        c_hi: __m256i,
        mask: __m256i,
        pair_mask: __m256i,
        gather: __m256i,
    }

    impl Coeffs {
        #[target_feature(enable = "avx2")]
        unsafe fn new() -> Self {
            Self {
                y_r: _mm256_set1_epi32(BT709_Y[0]),
                y_g: _mm256_set1_epi32(BT709_Y[1]),
                y_b: _mm256_set1_epi32(BT709_Y[2]),
                cb_r: _mm256_set1_epi32(BT709_CB[0]),
                cb_g: _mm256_set1_epi32(BT709_CB[1]),
                cb_b: _mm256_set1_epi32(BT709_CB[2]),
                cr_r: _mm256_set1_epi32(BT709_CR[0]),
                cr_g: _mm256_set1_epi32(BT709_CR[1]),
                cr_b: _mm256_set1_epi32(BT709_CR[2]),
                round: _mm256_set1_epi32(1 << 15),
                two: _mm256_set1_epi32(2),
                y_bias: _mm256_set1_epi32(16),
                c_bias: _mm256_set1_epi32(128),
                y_lo: _mm256_set1_epi32(16),
                y_hi: _mm256_set1_epi32(235),
                c_lo: _mm256_set1_epi32(16),
                c_hi: _mm256_set1_epi32(240),
                mask: _mm256_set1_epi32(0x00FF),
                pair_mask: _mm256_set1_epi64x(0xFFFF_FFFF),
                gather: _mm256_setr_epi32(0, 1, 4, 5, 2, 3, 6, 7),
            }
        }
    }

    pub(super) unsafe fn convert(
        src: &[u8],
        src_stride: usize,
        width: usize,
        height: usize,
        dst: &mut [u8],
    ) {
        unsafe {
            convert_avx2(src, src_stride, width, height, dst);
        }
    }

    #[target_feature(enable = "avx2")]
    unsafe fn convert_avx2(
        src: &[u8],
        src_stride: usize,
        width: usize,
        height: usize,
        dst: &mut [u8],
    ) {
        unsafe {
            let vector_width = (width / 8) * 8;
            let coeffs = Coeffs::new();
            let job = Job {
                src: src.as_ptr(),
                src_stride,
                y: dst.as_mut_ptr(),
                uv: dst.as_mut_ptr().add(width * height),
                stride: width,
            };
            let mut y = 0;
            while y + 1 < height {
                let mut x = 0;
                while x + 16 <= vector_width {
                    kernel8(&job, &coeffs, x, y);
                    kernel8(&job, &coeffs, x + 8, y);
                    x += 16;
                }
                if x + 8 <= vector_width {
                    kernel8(&job, &coeffs, x, y);
                }
                y += 2;
            }
            if vector_width < width {
                let mut y = 0;
                while y + 1 < height {
                    super::rgba_to_nv12_rect(
                        src,
                        src_stride,
                        width,
                        height,
                        vector_width,
                        width,
                        y,
                        y + 2,
                        dst,
                    );
                    y += 2;
                }
            }
            if height % 2 == 1 {
                super::rgba_to_nv12_rect(
                    src,
                    src_stride,
                    width,
                    height,
                    0,
                    width,
                    height - 1,
                    height,
                    dst,
                );
            }
        }
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn kernel8(job: &Job, coeffs: &Coeffs, x: usize, y: usize) {
        unsafe {
            let row0 = job.src.add(y * job.src_stride + x * 4);
            let row1 = job.src.add((y + 1) * job.src_stride + x * 4);
            let (r0, g0, b0) = unpack8(_mm256_loadu_si256(row0.cast()), coeffs.mask);
            let (r1, g1, b1) = unpack8(_mm256_loadu_si256(row1.cast()), coeffs.mask);
            store_y8(job.y.add(y * job.stride + x), luma8(r0, g0, b0, coeffs));
            store_y8(
                job.y.add((y + 1) * job.stride + x),
                luma8(r1, g1, b1, coeffs),
            );
            // Mean the 2×2 block in pixel units before the matrix. Shifting the
            // weighted sum by 18 is a different rounding and misses `bt709_chroma`.
            let r_avg = average8(pair_sum(r0, coeffs), pair_sum(r1, coeffs), coeffs);
            let g_avg = average8(pair_sum(g0, coeffs), pair_sum(g1, coeffs), coeffs);
            let b_avg = average8(pair_sum(b0, coeffs), pair_sum(b1, coeffs), coeffs);
            let cb = chroma8(
                r_avg,
                g_avg,
                b_avg,
                coeffs.cb_r,
                coeffs.cb_g,
                coeffs.cb_b,
                coeffs,
            );
            let cr = chroma8(
                r_avg,
                g_avg,
                b_avg,
                coeffs.cr_r,
                coeffs.cr_g,
                coeffs.cr_b,
                coeffs,
            );
            store_uv8(job, x, y / 2, cb, cr, coeffs.gather);
        }
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn unpack8(pix: __m256i, mask: __m256i) -> (__m256i, __m256i, __m256i) {
        let r = _mm256_and_si256(pix, mask);
        let g = _mm256_and_si256(_mm256_srli_epi32(pix, 8), mask);
        let b = _mm256_and_si256(_mm256_srli_epi32(pix, 16), mask);
        (r, g, b)
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn luma8(r: __m256i, g: __m256i, b: __m256i, coeffs: &Coeffs) -> __m256i {
        let mut acc = _mm256_mullo_epi32(r, coeffs.y_r);
        acc = _mm256_add_epi32(acc, _mm256_mullo_epi32(g, coeffs.y_g));
        acc = _mm256_add_epi32(acc, _mm256_mullo_epi32(b, coeffs.y_b));
        acc = _mm256_srai_epi32(_mm256_add_epi32(acc, coeffs.round), 16);
        acc = _mm256_add_epi32(acc, coeffs.y_bias);
        _mm256_min_epi32(_mm256_max_epi32(acc, coeffs.y_lo), coeffs.y_hi)
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn pair_sum(v: __m256i, coeffs: &Coeffs) -> __m256i {
        let shifted = _mm256_srli_epi64(v, 32);
        let sum = _mm256_add_epi32(v, shifted);
        _mm256_and_si256(sum, coeffs.pair_mask)
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn average8(row0: __m256i, row1: __m256i, coeffs: &Coeffs) -> __m256i {
        let sum = _mm256_add_epi32(row0, row1);
        _mm256_srai_epi32(_mm256_add_epi32(sum, coeffs.two), 2)
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn chroma8(
        r: __m256i,
        g: __m256i,
        b: __m256i,
        c_r: __m256i,
        c_g: __m256i,
        c_b: __m256i,
        coeffs: &Coeffs,
    ) -> __m256i {
        let mut acc = _mm256_mullo_epi32(r, c_r);
        acc = _mm256_add_epi32(acc, _mm256_mullo_epi32(g, c_g));
        acc = _mm256_add_epi32(acc, _mm256_mullo_epi32(b, c_b));
        acc = _mm256_srai_epi32(_mm256_add_epi32(acc, coeffs.round), 16);
        acc = _mm256_add_epi32(acc, coeffs.c_bias);
        _mm256_min_epi32(_mm256_max_epi32(acc, coeffs.c_lo), coeffs.c_hi)
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn store_y8(ptr: *mut u8, v: __m256i) {
        unsafe {
            let packed = _mm256_packs_epi32(v, _mm256_setzero_si256());
            let grouped = _mm256_permute4x64_epi64(packed, 0xD8);
            let bytes = _mm_packus_epi16(_mm256_castsi256_si128(grouped), _mm_setzero_si128());
            _mm_storel_epi64(ptr.cast(), bytes);
        }
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn store_uv8(job: &Job, x: usize, cy: usize, cb: __m256i, cr: __m256i, gather: __m256i) {
        unsafe {
            let cb = _mm256_permutevar8x32_epi32(_mm256_shuffle_epi32(cb, 0xD8), gather);
            let cr = _mm256_permutevar8x32_epi32(_mm256_shuffle_epi32(cr, 0xD8), gather);
            let lo = _mm_unpacklo_epi32(_mm256_castsi256_si128(cb), _mm256_castsi256_si128(cr));
            let hi = _mm_unpackhi_epi32(_mm256_castsi256_si128(cb), _mm256_castsi256_si128(cr));
            let bytes = _mm_packus_epi16(_mm_packs_epi32(lo, hi), _mm_setzero_si128());
            _mm_storel_epi64(job.uv.add(cy * job.stride + x).cast(), bytes);
        }
    }
}

/// BT.601 [`nv12_to_rgba_with_matrix`], the conversion this module always did.
pub fn nv12_to_rgba(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    nv12_to_rgba_with_matrix(
        y_data,
        uv_data,
        width,
        height,
        y_stride,
        uv_stride,
        output,
        YuvMatrix::Bt601,
    );
}

/// BT.601 [`yuv420p_to_rgba_with_matrix`], the conversion this module always
/// did.
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
    yuv420p_to_rgba_with_matrix(
        y_data,
        u_data,
        v_data,
        width,
        height,
        y_stride,
        uv_stride,
        output,
        YuvMatrix::Bt601,
    );
}

#[allow(clippy::too_many_arguments)]
pub fn nv12_to_rgba_with_matrix(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
    if nv12_simd_inputs_fit(y_data, uv_data, output, width, height, y_stride, uv_stride) {
        return nv12_to_rgba_simd(
            y_data, uv_data, width, height, y_stride, uv_stride, output, matrix,
        );
    }
    nv12_to_rgba_scalar(
        y_data, uv_data, width, height, y_stride, uv_stride, output, matrix,
    );
}

#[allow(clippy::too_many_arguments)]
fn nv12_to_rgba_scalar(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    matrix: YuvMatrix,
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

            let [r, g, b] = matrix.ycbcr_to_rgb(c, d, e);

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
pub fn yuv420p_to_rgba_with_matrix(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
    if yuv420p_simd_inputs_fit(
        y_data, u_data, v_data, output, width, height, y_stride, uv_stride,
    ) {
        return yuv420p_to_rgba_simd(
            y_data, u_data, v_data, width, height, y_stride, uv_stride, output, matrix,
        );
    }
    yuv420p_to_rgba_scalar(
        y_data, u_data, v_data, width, height, y_stride, uv_stride, output, matrix,
    );
}

#[allow(clippy::too_many_arguments)]
fn yuv420p_to_rgba_scalar(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    matrix: YuvMatrix,
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

            let [r, g, b] = matrix.ycbcr_to_rgb(c, d, e);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimdLevel {
    Scalar,
    Sse2,
    Avx2,
}

impl SimdLevel {
    #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
    pub fn detect() -> Self {
        if is_x86_feature_detected!("avx2") {
            SimdLevel::Avx2
        } else if is_x86_feature_detected!("sse2") {
            SimdLevel::Sse2
        } else {
            SimdLevel::Scalar
        }
    }

    #[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
    pub fn detect() -> Self {
        SimdLevel::Scalar
    }

    pub fn pixels_per_iteration(self) -> usize {
        match self {
            SimdLevel::Avx2 => 8,
            SimdLevel::Sse2 => 8,
            SimdLevel::Scalar => 1,
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
const PARALLEL_THRESHOLD_PIXELS: usize = 1920 * 1080;
#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
const MIN_ROWS_PER_THREAD: usize = 16;

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
pub fn nv12_to_rgba_simd(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    nv12_to_rgba_simd_with_progress(
        y_data, uv_data, width, height, y_stride, uv_stride, output, None, matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
pub fn nv12_to_rgba_simd_with_progress(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    let width_usize = width as usize;
    let height_usize = height as usize;
    let y_stride_usize = y_stride as usize;
    let uv_stride_usize = uv_stride as usize;

    if width_usize == 0 || height_usize == 0 {
        return;
    }

    if !nv12_simd_inputs_fit(y_data, uv_data, output, width, height, y_stride, uv_stride) {
        return nv12_to_rgba_scalar(
            y_data, uv_data, width, height, y_stride, uv_stride, output, matrix,
        );
    }

    let simd_level = SimdLevel::detect();
    let total_pixels = width_usize * height_usize;
    let use_parallel = total_pixels >= PARALLEL_THRESHOLD_PIXELS;

    if use_parallel {
        nv12_convert_parallel(
            y_data,
            uv_data,
            width_usize,
            height_usize,
            y_stride_usize,
            uv_stride_usize,
            output,
            simd_level,
            progress,
            matrix,
        );
    } else {
        nv12_convert_sequential(
            y_data,
            uv_data,
            width_usize,
            height_usize,
            y_stride_usize,
            uv_stride_usize,
            output,
            simd_level,
            progress,
            matrix,
        );
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn nv12_convert_sequential(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    height: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    simd_level: SimdLevel,
    progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    for row in 0..height {
        if let Some(ref p) = progress
            && p.is_cancelled()
        {
            return;
        }

        nv12_convert_row(
            y_data, uv_data, width, row, y_stride, uv_stride, output, simd_level, matrix,
        );

        if let Some(ref p) = progress {
            p.rows_completed.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn nv12_convert_parallel(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    height: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    simd_level: SimdLevel,
    progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    use rayon::prelude::*;

    let row_bytes = width * 4;
    let num_threads = rayon::current_num_threads();
    let rows_per_band = (height / num_threads).max(MIN_ROWS_PER_THREAD);

    output
        .par_chunks_mut(row_bytes * rows_per_band)
        .enumerate()
        .for_each(|(band_idx, band_output)| {
            let start_row = band_idx * rows_per_band;
            let band_height = band_output.len() / row_bytes;

            for local_row in 0..band_height {
                if let Some(ref p) = progress
                    && p.is_cancelled()
                {
                    return;
                }

                let global_row = start_row + local_row;
                if global_row >= height {
                    break;
                }

                nv12_convert_row_into(
                    y_data,
                    uv_data,
                    width,
                    global_row,
                    y_stride,
                    uv_stride,
                    band_output,
                    local_row,
                    simd_level,
                    matrix,
                );

                if let Some(ref p) = progress {
                    p.rows_completed.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn nv12_convert_row(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    row: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    simd_level: SimdLevel,
    matrix: YuvMatrix,
) {
    nv12_convert_row_into(
        y_data, uv_data, width, row, y_stride, uv_stride, output, row, simd_level, matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn nv12_convert_row_into(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    src_row: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    dst_row: usize,
    simd_level: SimdLevel,
    matrix: YuvMatrix,
) {
    let y_row_start = src_row * y_stride;
    let uv_row_start = (src_row / 2) * uv_stride;
    let out_row_start = dst_row * width * 4;

    match simd_level {
        SimdLevel::Avx2 => unsafe {
            nv12_convert_row_avx2(
                y_data,
                uv_data,
                width,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        },
        SimdLevel::Sse2 => unsafe {
            nv12_convert_row_sse2(
                y_data,
                uv_data,
                width,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        },
        SimdLevel::Scalar => {
            nv12_convert_row_scalar(
                y_data,
                uv_data,
                width,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[target_feature(enable = "avx2")]
#[allow(clippy::too_many_arguments)]
unsafe fn nv12_convert_row_avx2(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    unsafe {
        let simd_px = width & !7;
        if simd_px != 0 {
            avx2_yuv::nv12(
                y_data,
                uv_data,
                simd_px,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        }
        if simd_px != width {
            nv12_convert_span_at(
                y_data,
                uv_data,
                width,
                simd_px,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[target_feature(enable = "sse2")]
#[allow(clippy::too_many_arguments)]
unsafe fn nv12_convert_row_sse2(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    nv12_convert_row_scalar(
        y_data,
        uv_data,
        width,
        y_row_start,
        uv_row_start,
        out_row_start,
        output,
        matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn nv12_convert_row_scalar(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    nv12_convert_span_at(
        y_data,
        uv_data,
        width,
        0,
        y_row_start,
        uv_row_start,
        out_row_start,
        output,
        matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn nv12_convert_span_at(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    start_col: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    debug_assert!(start_col.is_multiple_of(2));
    let y_row = &y_data[y_row_start + start_col..y_row_start + width];
    let uv_row = &uv_data[uv_row_start + start_col..uv_row_start + width.div_ceil(2) * 2];
    let output_row = &mut output[out_row_start + start_col * 4..out_row_start + width * 4];
    nv12_convert_span(y_row, uv_row, output_row, matrix);
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
fn nv12_convert_span(y_row: &[u8], uv_row: &[u8], output_row: &mut [u8], matrix: YuvMatrix) {
    for ((luma, chroma), pixels) in y_row
        .chunks(2)
        .zip(uv_row.chunks_exact(2))
        .zip(output_row.chunks_mut(8))
    {
        let d = i32::from(chroma[0]) - 128;
        let e = i32::from(chroma[1]) - 128;
        let [red, green, blue] = matrix.chroma_contributions(d, e);

        for (y, pixel) in luma.iter().zip(pixels.chunks_exact_mut(4)) {
            let c = 298 * (i32::from(*y) - 16);
            pixel.copy_from_slice(&[
                clamp_u8((c + red) >> 8),
                clamp_u8((c + green) >> 8),
                clamp_u8((c + blue) >> 8),
                255,
            ]);
        }
    }
    // `chunks_mut(8)` yields pairs only, so an odd width leaves its last pixel.
    if !y_row.len().is_multiple_of(2) {
        let col = y_row.len() - 1;
        let chroma = &uv_row[col..col + 2];
        let d = i32::from(chroma[0]) - 128;
        let e = i32::from(chroma[1]) - 128;
        let [red, green, blue] = matrix.chroma_contributions(d, e);
        let c = 298 * (i32::from(y_row[col]) - 16);
        output_row[col * 4..col * 4 + 4].copy_from_slice(&[
            clamp_u8((c + red) >> 8),
            clamp_u8((c + green) >> 8),
            clamp_u8((c + blue) >> 8),
            255,
        ]);
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
#[allow(clippy::too_many_arguments)]
pub fn nv12_to_rgba_simd(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    nv12_to_rgba_with_matrix(
        y_data, uv_data, width, height, y_stride, uv_stride, output, matrix,
    );
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
#[allow(clippy::too_many_arguments)]
pub fn nv12_to_rgba_simd_with_progress(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    _progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    nv12_to_rgba_with_matrix(
        y_data, uv_data, width, height, y_stride, uv_stride, output, matrix,
    );
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
    matrix: YuvMatrix,
) {
    yuv420p_to_rgba_simd_with_progress(
        y_data, u_data, v_data, width, height, y_stride, uv_stride, output, None, matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
pub fn yuv420p_to_rgba_simd_with_progress(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    let width_usize = width as usize;
    let height_usize = height as usize;
    let y_stride_usize = y_stride as usize;
    let uv_stride_usize = uv_stride as usize;

    if width_usize == 0 || height_usize == 0 {
        return;
    }

    if !yuv420p_simd_inputs_fit(
        y_data, u_data, v_data, output, width, height, y_stride, uv_stride,
    ) {
        return yuv420p_to_rgba_scalar(
            y_data, u_data, v_data, width, height, y_stride, uv_stride, output, matrix,
        );
    }

    let simd_level = SimdLevel::detect();
    let total_pixels = width_usize * height_usize;
    let use_parallel = total_pixels >= PARALLEL_THRESHOLD_PIXELS;

    if use_parallel {
        yuv420p_convert_parallel(
            y_data,
            u_data,
            v_data,
            width_usize,
            height_usize,
            y_stride_usize,
            uv_stride_usize,
            output,
            simd_level,
            progress,
            matrix,
        );
    } else {
        yuv420p_convert_sequential(
            y_data,
            u_data,
            v_data,
            width_usize,
            height_usize,
            y_stride_usize,
            uv_stride_usize,
            output,
            simd_level,
            progress,
            matrix,
        );
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn yuv420p_convert_sequential(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    height: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    simd_level: SimdLevel,
    progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    for row in 0..height {
        if let Some(ref p) = progress
            && p.is_cancelled()
        {
            return;
        }

        yuv420p_convert_row(
            y_data, u_data, v_data, width, row, y_stride, uv_stride, output, simd_level, matrix,
        );

        if let Some(ref p) = progress {
            p.rows_completed.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn yuv420p_convert_parallel(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    height: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    simd_level: SimdLevel,
    progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    use rayon::prelude::*;

    let row_bytes = width * 4;
    let num_threads = rayon::current_num_threads();
    let rows_per_band = (height / num_threads).max(MIN_ROWS_PER_THREAD);

    output
        .par_chunks_mut(row_bytes * rows_per_band)
        .enumerate()
        .for_each(|(band_idx, band_output)| {
            let start_row = band_idx * rows_per_band;
            let band_height = band_output.len() / row_bytes;

            for local_row in 0..band_height {
                if let Some(ref p) = progress
                    && p.is_cancelled()
                {
                    return;
                }

                let global_row = start_row + local_row;
                if global_row >= height {
                    break;
                }

                yuv420p_convert_row_into(
                    y_data,
                    u_data,
                    v_data,
                    width,
                    global_row,
                    y_stride,
                    uv_stride,
                    band_output,
                    local_row,
                    simd_level,
                    matrix,
                );

                if let Some(ref p) = progress {
                    p.rows_completed.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn yuv420p_convert_row(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    row: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    simd_level: SimdLevel,
    matrix: YuvMatrix,
) {
    yuv420p_convert_row_into(
        y_data, u_data, v_data, width, row, y_stride, uv_stride, output, row, simd_level, matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn yuv420p_convert_row_into(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    src_row: usize,
    y_stride: usize,
    uv_stride: usize,
    output: &mut [u8],
    dst_row: usize,
    simd_level: SimdLevel,
    matrix: YuvMatrix,
) {
    let y_row_start = src_row * y_stride;
    let uv_row_start = (src_row / 2) * uv_stride;
    let out_row_start = dst_row * width * 4;

    match simd_level {
        SimdLevel::Avx2 => unsafe {
            yuv420p_convert_row_avx2(
                y_data,
                u_data,
                v_data,
                width,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        },
        SimdLevel::Sse2 => unsafe {
            yuv420p_convert_row_sse2(
                y_data,
                u_data,
                v_data,
                width,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        },
        SimdLevel::Scalar => {
            yuv420p_convert_row_scalar(
                y_data,
                u_data,
                v_data,
                width,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[target_feature(enable = "avx2")]
#[allow(clippy::too_many_arguments)]
unsafe fn yuv420p_convert_row_avx2(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    unsafe {
        let simd_px = width & !7;
        if simd_px != 0 {
            avx2_yuv::yuv420p(
                y_data,
                u_data,
                v_data,
                simd_px,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        }
        if simd_px != width {
            yuv420p_convert_span_at(
                y_data,
                u_data,
                v_data,
                width,
                simd_px,
                y_row_start,
                uv_row_start,
                out_row_start,
                output,
                matrix,
            );
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[target_feature(enable = "sse2")]
#[allow(clippy::too_many_arguments)]
unsafe fn yuv420p_convert_row_sse2(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    yuv420p_convert_row_scalar(
        y_data,
        u_data,
        v_data,
        width,
        y_row_start,
        uv_row_start,
        out_row_start,
        output,
        matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn yuv420p_convert_row_scalar(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    yuv420p_convert_span_at(
        y_data,
        u_data,
        v_data,
        width,
        0,
        y_row_start,
        uv_row_start,
        out_row_start,
        output,
        matrix,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn yuv420p_convert_span_at(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: usize,
    start_col: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
    matrix: YuvMatrix,
) {
    debug_assert!(start_col.is_multiple_of(2));
    let chroma_width = width.div_ceil(2);
    let y_row = &y_data[y_row_start + start_col..y_row_start + width];
    let u_row = &u_data[uv_row_start + start_col / 2..uv_row_start + chroma_width];
    let v_row = &v_data[uv_row_start + start_col / 2..uv_row_start + chroma_width];
    let output_row = &mut output[out_row_start + start_col * 4..out_row_start + width * 4];
    yuv420p_convert_span(y_row, u_row, v_row, output_row, matrix);
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
fn yuv420p_convert_span(
    y_row: &[u8],
    u_row: &[u8],
    v_row: &[u8],
    output_row: &mut [u8],
    matrix: YuvMatrix,
) {
    for (((luma, u), v), pixels) in y_row
        .chunks(2)
        .zip(u_row)
        .zip(v_row)
        .zip(output_row.chunks_mut(8))
    {
        let d = i32::from(*u) - 128;
        let e = i32::from(*v) - 128;
        let [red, green, blue] = matrix.chroma_contributions(d, e);

        for (y, pixel) in luma.iter().zip(pixels.chunks_exact_mut(4)) {
            let c = 298 * (i32::from(*y) - 16);
            pixel.copy_from_slice(&[
                clamp_u8((c + red) >> 8),
                clamp_u8((c + green) >> 8),
                clamp_u8((c + blue) >> 8),
                255,
            ]);
        }
    }
    // `chunks_mut(8)` yields pairs only, so an odd width leaves its last pixel.
    if !y_row.len().is_multiple_of(2) {
        let col = y_row.len() - 1;
        let d = i32::from(u_row[col / 2]) - 128;
        let e = i32::from(v_row[col / 2]) - 128;
        let [red, green, blue] = matrix.chroma_contributions(d, e);
        let c = 298 * (i32::from(y_row[col]) - 16);
        output_row[col * 4..col * 4 + 4].copy_from_slice(&[
            clamp_u8((c + red) >> 8),
            clamp_u8((c + green) >> 8),
            clamp_u8((c + blue) >> 8),
            255,
        ]);
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
    matrix: YuvMatrix,
) {
    yuv420p_to_rgba_with_matrix(
        y_data, u_data, v_data, width, height, y_stride, uv_stride, output, matrix,
    );
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
#[allow(clippy::too_many_arguments)]
pub fn yuv420p_to_rgba_simd_with_progress(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    _progress: Option<Arc<ConversionProgress>>,
    matrix: YuvMatrix,
) {
    yuv420p_to_rgba_with_matrix(
        y_data, u_data, v_data, width, height, y_stride, uv_stride, output, matrix,
    );
}

#[inline(always)]
fn clamp_u8(val: i32) -> u8 {
    val.clamp(0, 255) as u8
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn nv12_simd_inputs_fit(
    y_data: &[u8],
    uv_data: &[u8],
    output: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
) -> bool {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 {
        return false;
    }
    let y_stride = y_stride as usize;
    let uv_stride = uv_stride as usize;
    let y_required = (height - 1).saturating_mul(y_stride).saturating_add(width);
    let uv_height = height.div_ceil(2);
    let uv_width_bytes = width.div_ceil(2) * 2;
    let uv_required = uv_height
        .saturating_sub(1)
        .saturating_mul(uv_stride)
        .saturating_add(uv_width_bytes);
    let output_required = width.saturating_mul(height).saturating_mul(4);
    y_stride >= width
        && uv_stride >= uv_width_bytes
        && y_data.len() >= y_required
        && uv_data.len() >= uv_required
        && output.len() >= output_required
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[allow(clippy::too_many_arguments)]
fn yuv420p_simd_inputs_fit(
    y_data: &[u8],
    u_data: &[u8],
    v_data: &[u8],
    output: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
) -> bool {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 {
        return false;
    }
    let y_stride = y_stride as usize;
    let uv_stride = uv_stride as usize;
    let y_required = (height - 1).saturating_mul(y_stride).saturating_add(width);
    let uv_height = height.div_ceil(2);
    let uv_width = width.div_ceil(2);
    let uv_required = uv_height
        .saturating_sub(1)
        .saturating_mul(uv_stride)
        .saturating_add(uv_width);
    let output_required = width.saturating_mul(height).saturating_mul(4);
    y_stride >= width
        && uv_stride >= uv_width
        && y_data.len() >= y_required
        && u_data.len() >= uv_required
        && v_data.len() >= uv_required
        && output.len() >= output_required
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
mod avx2_yuv {
    use super::YuvMatrix;

    #[cfg(target_arch = "x86")]
    use std::arch::x86::*;
    #[cfg(target_arch = "x86_64")]
    use std::arch::x86_64::*;

    struct Coeffs {
        rv: __m256i,
        gu: __m256i,
        gv: __m256i,
        bu: __m256i,
        bias128: __m256i,
        y16: __m256i,
        gain: __m256i,
        alpha: __m256i,
        zero: __m256i,
        max: __m256i,
        nv12_u: __m256i,
        nv12_v: __m256i,
        dup4: __m256i,
    }

    impl Coeffs {
        #[inline]
        #[target_feature(enable = "avx2")]
        unsafe fn new(matrix: YuvMatrix) -> Self {
            let (rv, gu, gv, bu) = matrix.chroma_gains();
            Self {
                rv: _mm256_set1_epi32(rv),
                gu: _mm256_set1_epi32(gu),
                gv: _mm256_set1_epi32(gv),
                bu: _mm256_set1_epi32(bu),
                bias128: _mm256_set1_epi32(128),
                y16: _mm256_set1_epi32(16),
                gain: _mm256_set1_epi32(298),
                alpha: _mm256_set1_epi32(0xFF00_0000u32 as i32),
                zero: _mm256_setzero_si256(),
                max: _mm256_set1_epi32(255),
                nv12_u: _mm256_setr_epi32(0, 0, 2, 2, 4, 4, 6, 6),
                nv12_v: _mm256_setr_epi32(1, 1, 3, 3, 5, 5, 7, 7),
                dup4: _mm256_setr_epi32(0, 0, 1, 1, 2, 2, 3, 3),
            }
        }
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    unsafe fn clamp8(sum: __m256i, coeffs: &Coeffs) -> __m256i {
        let shifted = _mm256_srai_epi32(sum, 8);
        _mm256_min_epi32(_mm256_max_epi32(shifted, coeffs.zero), coeffs.max)
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    unsafe fn store_rgba(out: *mut u8, luma: __m256i, d: __m256i, e: __m256i, coeffs: &Coeffs) {
        unsafe {
            let red = _mm256_add_epi32(_mm256_mullo_epi32(coeffs.rv, e), coeffs.bias128);
            let green = _mm256_sub_epi32(
                coeffs.bias128,
                _mm256_add_epi32(
                    _mm256_mullo_epi32(coeffs.gu, d),
                    _mm256_mullo_epi32(coeffs.gv, e),
                ),
            );
            let blue = _mm256_add_epi32(_mm256_mullo_epi32(coeffs.bu, d), coeffs.bias128);
            let r = clamp8(_mm256_add_epi32(luma, red), coeffs);
            let g = clamp8(_mm256_add_epi32(luma, green), coeffs);
            let b = clamp8(_mm256_add_epi32(luma, blue), coeffs);
            let pixels = _mm256_or_si256(
                r,
                _mm256_or_si256(
                    _mm256_slli_epi32(g, 8),
                    _mm256_or_si256(_mm256_slli_epi32(b, 16), coeffs.alpha),
                ),
            );
            _mm256_storeu_si256(out.cast(), pixels);
        }
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    unsafe fn luma8(y: *const u8, coeffs: &Coeffs) -> __m256i {
        unsafe {
            let y8 = _mm_loadl_epi64(y.cast());
            let y32 = _mm256_cvtepu8_epi32(y8);
            _mm256_mullo_epi32(_mm256_sub_epi32(y32, coeffs.y16), coeffs.gain)
        }
    }

    #[allow(clippy::too_many_arguments)]
    #[target_feature(enable = "avx2")]
    pub(super) unsafe fn nv12(
        y_data: &[u8],
        uv_data: &[u8],
        width: usize,
        y_row_start: usize,
        uv_row_start: usize,
        out_row_start: usize,
        output: &mut [u8],
        matrix: YuvMatrix,
    ) {
        unsafe {
            debug_assert!(width.is_multiple_of(8));
            let y = &y_data[y_row_start..y_row_start + width];
            let uv = &uv_data[uv_row_start..uv_row_start + width];
            let out = &mut output[out_row_start..out_row_start + width * 4];
            let coeffs = Coeffs::new(matrix);
            let mut x = 0;
            while x < width {
                let luma = luma8(y.as_ptr().add(x), &coeffs);
                let uv32 = _mm256_cvtepu8_epi32(_mm_loadl_epi64(uv.as_ptr().add(x).cast()));
                let d = _mm256_sub_epi32(
                    _mm256_permutevar8x32_epi32(uv32, coeffs.nv12_u),
                    coeffs.bias128,
                );
                let e = _mm256_sub_epi32(
                    _mm256_permutevar8x32_epi32(uv32, coeffs.nv12_v),
                    coeffs.bias128,
                );
                store_rgba(out.as_mut_ptr().add(x * 4), luma, d, e, &coeffs);
                x += 8;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    #[target_feature(enable = "avx2")]
    pub(super) unsafe fn yuv420p(
        y_data: &[u8],
        u_data: &[u8],
        v_data: &[u8],
        width: usize,
        y_row_start: usize,
        uv_row_start: usize,
        out_row_start: usize,
        output: &mut [u8],
        matrix: YuvMatrix,
    ) {
        unsafe {
            debug_assert!(width.is_multiple_of(8));
            let chroma_width = width / 2;
            let y = &y_data[y_row_start..y_row_start + width];
            let u = &u_data[uv_row_start..uv_row_start + chroma_width];
            let v = &v_data[uv_row_start..uv_row_start + chroma_width];
            let out = &mut output[out_row_start..out_row_start + width * 4];
            let coeffs = Coeffs::new(matrix);
            let mut x = 0;
            while x < width {
                let luma = luma8(y.as_ptr().add(x), &coeffs);
                let u32 = std::ptr::read_unaligned(u.as_ptr().add(x / 2).cast::<u32>());
                let v32 = std::ptr::read_unaligned(v.as_ptr().add(x / 2).cast::<u32>());
                let d = _mm256_sub_epi32(
                    _mm256_permutevar8x32_epi32(
                        _mm256_cvtepu8_epi32(_mm_cvtsi32_si128(u32 as i32)),
                        coeffs.dup4,
                    ),
                    coeffs.bias128,
                );
                let e = _mm256_sub_epi32(
                    _mm256_permutevar8x32_epi32(
                        _mm256_cvtepu8_epi32(_mm_cvtsi32_si128(v32 as i32)),
                        coeffs.dup4,
                    ),
                    coeffs.bias128,
                );
                store_rgba(out.as_mut_ptr().add(x * 4), luma, d, e, &coeffs);
                x += 8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
    use std::arch::is_x86_feature_detected;

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
        nv12_to_rgba_with_matrix(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output,
            YuvMatrix::Bt601,
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

        nv12_to_rgba_scalar(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output_scalar,
            YuvMatrix::Bt601,
        );

        nv12_to_rgba_simd(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output_simd,
            YuvMatrix::Bt601,
        );

        for (i, (s, d)) in output_scalar.iter().zip(output_simd.iter()).enumerate() {
            let diff = (*s as i32 - *d as i32).abs();
            assert!(
                diff <= 2,
                "Mismatch at index {i}: scalar={s}, simd={d}, diff={diff}"
            );
        }
    }

    #[test]
    fn test_simd_level_detection() {
        let level = SimdLevel::detect();
        let pixels = level.pixels_per_iteration();
        assert!(pixels >= 1);
        #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
        {
            assert!(pixels == 1 || pixels == 8 || pixels == 16);
        }
    }

    #[test]
    fn test_conversion_progress() {
        let progress = ConversionProgress::new(100);
        assert_eq!(progress.progress_fraction(), 0.0);
        assert!(!progress.is_cancelled());

        progress.rows_completed.store(50, Ordering::Relaxed);
        assert!((progress.progress_fraction() - 0.5).abs() < 0.001);

        progress.cancel();
        assert!(progress.is_cancelled());
    }

    #[test]
    fn test_nv12_avx2_matches_sse2() {
        let width = 32u32;
        let height = 16u32;
        let y_stride = 32u32;
        let uv_stride = 32u32;

        let y_data: Vec<u8> = (0..y_stride * height)
            .map(|i| ((i * 7 + 50) % 256) as u8)
            .collect();
        let uv_data: Vec<u8> = (0..uv_stride * height / 2)
            .map(|i| ((i * 11 + 64) % 256) as u8)
            .collect();

        let mut output1 = vec![0u8; (width * height * 4) as usize];
        let mut output2 = vec![0u8; (width * height * 4) as usize];

        nv12_to_rgba_scalar(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output1,
            YuvMatrix::Bt601,
        );

        nv12_to_rgba_simd(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output2,
            YuvMatrix::Bt601,
        );

        for (i, (a, b)) in output1.iter().zip(output2.iter()).enumerate() {
            let diff = (*a as i32 - *b as i32).abs();
            assert!(
                diff <= 2,
                "Mismatch at index {i}: expected={a}, got={b}, diff={diff}"
            );
        }
    }

    #[test]
    fn test_yuv420p_simd_matches_scalar() {
        let width = 32u32;
        let height = 16u32;
        let y_stride = 32u32;
        let uv_stride = 16u32;

        let y_data: Vec<u8> = (0..y_stride * height)
            .map(|i| ((i * 7 + 50) % 256) as u8)
            .collect();
        let u_data: Vec<u8> = (0..uv_stride * height / 2)
            .map(|i| ((i * 11 + 64) % 256) as u8)
            .collect();
        let v_data: Vec<u8> = (0..uv_stride * height / 2)
            .map(|i| ((i * 13 + 80) % 256) as u8)
            .collect();

        let mut output_scalar = vec![0u8; (width * height * 4) as usize];
        let mut output_simd = vec![0u8; (width * height * 4) as usize];

        yuv420p_to_rgba_scalar(
            &y_data,
            &u_data,
            &v_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output_scalar,
            YuvMatrix::Bt601,
        );

        yuv420p_to_rgba_simd(
            &y_data,
            &u_data,
            &v_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output_simd,
            YuvMatrix::Bt601,
        );

        for (i, (s, d)) in output_scalar.iter().zip(output_simd.iter()).enumerate() {
            let diff = (*s as i32 - *d as i32).abs();
            assert!(
                diff <= 2,
                "YUV420P mismatch at index {i}: scalar={s}, simd={d}, diff={diff}"
            );
        }
    }

    #[test]
    fn test_nv12_simd_matches_scalar_for_pair_tails_and_padded_rows() {
        for matrix in [YuvMatrix::Bt601, YuvMatrix::Bt709] {
            for (width, height, padding) in [
                (1_u32, 1_u32, 0_u32),
                (3, 5, 0),
                (3, 5, 7),
                (17, 18, 7),
                (32, 3, 7),
                (1921, 1081, 7),
            ] {
                let y_stride = width + padding;
                let uv_width = width.div_ceil(2) * 2;
                let uv_stride = uv_width + padding;
                let y_len = ((height - 1) * y_stride + width) as usize;
                let uv_len = ((height.div_ceil(2) - 1) * uv_stride + uv_width) as usize;
                let y_data: Vec<u8> = (0..y_len).map(|i| (i * 37 + 11) as u8).collect();
                let uv_data: Vec<u8> = (0..uv_len).map(|i| (i * 53 + 97) as u8).collect();
                let mut expected = vec![0; (width * height * 4) as usize];
                let mut actual = vec![0xa5; expected.len()];
                let mut dispatched = vec![0xa5; expected.len()];

                nv12_to_rgba_scalar(
                    &y_data,
                    &uv_data,
                    width,
                    height,
                    y_stride,
                    uv_stride,
                    &mut expected,
                    matrix,
                );
                nv12_to_rgba_simd(
                    &y_data,
                    &uv_data,
                    width,
                    height,
                    y_stride,
                    uv_stride,
                    &mut actual,
                    matrix,
                );
                nv12_to_rgba_with_matrix(
                    &y_data,
                    &uv_data,
                    width,
                    height,
                    y_stride,
                    uv_stride,
                    &mut dispatched,
                    matrix,
                );

                assert_eq!(
                    actual, expected,
                    "NV12 {matrix:?} {width}x{height}, y_stride={y_stride}, uv_stride={uv_stride}"
                );
                assert_eq!(
                    dispatched, expected,
                    "NV12 dispatch {matrix:?} {width}x{height}, y_stride={y_stride}, uv_stride={uv_stride}"
                );
            }
        }
    }

    #[test]
    fn test_yuv420p_simd_matches_scalar_for_pair_tails_and_padded_rows() {
        for matrix in [YuvMatrix::Bt601, YuvMatrix::Bt709] {
            for (width, height, padding) in [
                (1_u32, 1_u32, 0_u32),
                (3, 5, 0),
                (3, 5, 7),
                (17, 18, 7),
                (32, 3, 7),
                (1921, 1081, 7),
            ] {
                let y_stride = width + padding;
                let uv_width = width.div_ceil(2);
                let uv_stride = uv_width + padding;
                let y_len = ((height - 1) * y_stride + width) as usize;
                let uv_len = ((height.div_ceil(2) - 1) * uv_stride + uv_width) as usize;
                let y_data: Vec<u8> = (0..y_len).map(|i| (i * 37 + 11) as u8).collect();
                let u_data: Vec<u8> = (0..uv_len).map(|i| (i * 53 + 97) as u8).collect();
                let v_data: Vec<u8> = (0..uv_len).map(|i| (i * 71 + 193) as u8).collect();
                let mut expected = vec![0; (width * height * 4) as usize];
                let mut actual = vec![0xa5; expected.len()];
                let mut dispatched = vec![0xa5; expected.len()];

                yuv420p_to_rgba_scalar(
                    &y_data,
                    &u_data,
                    &v_data,
                    width,
                    height,
                    y_stride,
                    uv_stride,
                    &mut expected,
                    matrix,
                );
                yuv420p_to_rgba_simd(
                    &y_data,
                    &u_data,
                    &v_data,
                    width,
                    height,
                    y_stride,
                    uv_stride,
                    &mut actual,
                    matrix,
                );
                yuv420p_to_rgba_with_matrix(
                    &y_data,
                    &u_data,
                    &v_data,
                    width,
                    height,
                    y_stride,
                    uv_stride,
                    &mut dispatched,
                    matrix,
                );

                assert_eq!(
                    actual, expected,
                    "YUV420P {matrix:?} {width}x{height}, y_stride={y_stride}, uv_stride={uv_stride}"
                );
                assert_eq!(
                    dispatched, expected,
                    "YUV420P dispatch {matrix:?} {width}x{height}, y_stride={y_stride}, uv_stride={uv_stride}"
                );
            }
        }
    }

    #[test]
    fn test_large_frame_parallel() {
        let width = 1920u32;
        let height = 1080u32;
        let y_stride = 1920u32;
        let uv_stride = 1920u32;

        let y_data: Vec<u8> = (0..y_stride * height).map(|i| (i % 256) as u8).collect();
        let uv_data: Vec<u8> = (0..uv_stride * height / 2)
            .map(|i| ((i + 64) % 256) as u8)
            .collect();

        let mut output = vec![0u8; (width * height * 4) as usize];

        nv12_to_rgba_simd(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output,
            YuvMatrix::Bt601,
        );

        assert!(output.iter().any(|&x| x != 0));
    }

    #[test]
    fn test_cancellation() {
        let progress = Arc::new(ConversionProgress::new(1080));

        let width = 1920u32;
        let height = 1080u32;
        let y_stride = 1920u32;
        let uv_stride = 1920u32;

        let y_data: Vec<u8> = vec![128; (y_stride * height) as usize];
        let uv_data: Vec<u8> = vec![128; (uv_stride * height / 2) as usize];

        let mut output = vec![0u8; (width * height * 4) as usize];

        progress.cancel();

        nv12_to_rgba_simd_with_progress(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output,
            Some(progress.clone()),
            YuvMatrix::Bt601,
        );

        let rows_done = progress.rows_completed.load(Ordering::Relaxed);
        assert!(rows_done < height as usize);
    }

    /// Exact limited-range Y'CbCr of an 8-bit RGB colour for (Kr, Kb).
    fn reference_ycbcr(rgb: [u8; 3], kr: f64, kb: f64) -> [f64; 3] {
        let [r, g, b] = rgb.map(|v| f64::from(v) / 255.0);
        let y = kr * r + (1.0 - kr - kb) * g + kb * b;
        [
            16.0 + 219.0 * y,
            128.0 + 224.0 * (b - y) / (2.0 * (1.0 - kb)),
            128.0 + 224.0 * (r - y) / (2.0 * (1.0 - kr)),
        ]
    }

    fn encode_bt709(rgb: [u8; 3]) -> [u8; 3] {
        let [r, g, b] = rgb.map(i32::from);
        let [cb, cr] = bt709_chroma(r, g, b);
        [bt709_luma(r, g, b), cb, cr]
    }

    const BT709: (f64, f64) = (0.2126, 0.0722);

    #[test]
    fn bt709_encode_matches_the_colour_chart() {
        // (RGB, BT.709 limited-range Y'CbCr): primaries, secondaries, the
        // ends of the grey axis and the suite's red background.
        let chart: [([u8; 3], [u8; 3]); 9] = [
            ([0, 0, 0], [16, 128, 128]),
            ([255, 255, 255], [235, 128, 128]),
            ([255, 0, 0], [63, 102, 240]),
            ([0, 255, 0], [173, 42, 26]),
            ([0, 0, 255], [32, 240, 118]),
            ([0, 255, 255], [188, 154, 16]),
            ([255, 0, 255], [78, 214, 230]),
            ([255, 255, 0], [219, 16, 138]),
            ([220, 40, 40], [83, 110, 207]),
        ];
        for (rgb, expected) in chart {
            assert_eq!(encode_bt709(rgb), expected, "{rgb:?}");
        }
    }

    #[test]
    fn bt709_encode_rounds_to_the_nearest_code_value() {
        for r in (0..=255u8).step_by(5) {
            for g in (0..=255u8).step_by(5) {
                for b in (0..=255u8).step_by(5) {
                    let reference = reference_ycbcr([r, g, b], BT709.0, BT709.1);
                    let actual = encode_bt709([r, g, b]);
                    for k in 0..3 {
                        let error = (f64::from(actual[k]) - reference[k]).abs();
                        assert!(
                            error <= 0.5 + 1.0 / 256.0,
                            "{:?} component {k}: {} vs {:.3}",
                            [r, g, b],
                            actual[k],
                            reference[k]
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn bt709_encode_keeps_the_grey_axis_neutral_and_exact() {
        for v in 0..=255u8 {
            let expected_y = (16.0 + 219.0 * f64::from(v) / 255.0).round() as u8;
            assert_eq!(encode_bt709([v, v, v]), [expected_y, 128, 128], "grey {v}");
        }
    }

    #[test]
    fn bt709_decode_inverts_the_bt709_encode() {
        let mut worst = 0u8;
        for r in (0..=255u8).step_by(5) {
            for g in (0..=255u8).step_by(5) {
                for b in (0..=255u8).step_by(5) {
                    let [y, cb, cr] = encode_bt709([r, g, b]).map(i32::from);
                    let decoded = YuvMatrix::Bt709.ycbcr_to_rgb(y - 16, cb - 128, cr - 128);
                    for (a, e) in decoded.iter().zip([r, g, b]) {
                        worst = worst.max(a.abs_diff(e));
                    }
                }
            }
        }
        assert!(worst <= 2, "BT.709 round trip off by {worst}");
    }

    #[test]
    fn decoding_with_the_other_matrix_shifts_saturated_colours() {
        // The bug this guards: BT.709 data read back as BT.601 moves the
        // suite's red background by more than the round-trip error.
        let [y, cb, cr] = encode_bt709([220, 40, 40]).map(i32::from);
        let wrong = YuvMatrix::Bt601.ycbcr_to_rgb(y - 16, cb - 128, cr - 128);
        let right = YuvMatrix::Bt709.ycbcr_to_rgb(y - 16, cb - 128, cr - 128);
        assert!(
            right
                .iter()
                .zip([220u8, 40, 40])
                .all(|(a, e)| a.abs_diff(e) <= 1)
        );
        assert!(
            wrong
                .iter()
                .zip([220u8, 40, 40])
                .any(|(a, e)| a.abs_diff(e) > 10)
        );
    }

    #[test]
    fn bt601_decode_is_unchanged() {
        // The integer BT.601 conversion this module always used.
        let legacy = |c: i32, d: i32, e: i32| {
            [
                clamp_u8((298 * c + 409 * e + 128) >> 8),
                clamp_u8((298 * c - 100 * d - 208 * e + 128) >> 8),
                clamp_u8((298 * c + 516 * d + 128) >> 8),
            ]
        };
        for y in (0..=255).step_by(3) {
            for u in (0..=255).step_by(3) {
                for v in (0..=255).step_by(3) {
                    let (c, d, e) = (y - 16, u - 128, v - 128);
                    assert_eq!(YuvMatrix::Bt601.ycbcr_to_rgb(c, d, e), legacy(c, d, e));
                }
            }
        }
    }

    #[test]
    fn matrix_follows_the_colour_tag() {
        use ffmpeg::util::color::Space;
        assert_eq!(YuvMatrix::from_color_space(Space::BT709), YuvMatrix::Bt709);
        for space in [
            Space::Unspecified,
            Space::BT470BG,
            Space::SMPTE170M,
            Space::RGB,
        ] {
            assert_eq!(YuvMatrix::from_color_space(space), YuvMatrix::Bt601);
        }
    }

    #[test]
    fn simd_conversion_uses_the_requested_matrix() {
        let (width, height) = (64u32, 4u32);
        let y = vec![81u8; (width * height) as usize];
        let uv: Vec<u8> = (0..(width * height / 2))
            .map(|i| if i % 2 == 0 { 90 } else { 240 })
            .collect();
        for matrix in [YuvMatrix::Bt601, YuvMatrix::Bt709] {
            let mut simd = vec![0u8; (width * height * 4) as usize];
            let mut scalar = simd.clone();
            let mut dispatched = simd.clone();
            nv12_to_rgba_simd(&y, &uv, width, height, width, width, &mut simd, matrix);
            nv12_to_rgba_scalar(&y, &uv, width, height, width, width, &mut scalar, matrix);
            nv12_to_rgba_with_matrix(
                &y,
                &uv,
                width,
                height,
                width,
                width,
                &mut dispatched,
                matrix,
            );
            assert_eq!(simd, scalar);
            assert_eq!(dispatched, scalar);
            assert_eq!(
                &simd[..3],
                &matrix.ycbcr_to_rgb(81 - 16, 90 - 128, 240 - 128)
            );
        }
    }

    #[test]
    fn simd_matches_scalar_on_extremes_and_odd_tail() {
        let samples = [0u8, 1, 15, 16, 17, 128, 234, 235, 236, 254, 255];
        let (width, height) = (9u32, 3u32);
        for matrix in [YuvMatrix::Bt601, YuvMatrix::Bt709] {
            for &y0 in &samples {
                for &u0 in &samples {
                    for &v0 in &samples {
                        let y = vec![y0; (width * height) as usize];
                        let uv_rows = height.div_ceil(2);
                        let nv12_row = width.div_ceil(2) * 2;
                        let mut uv = vec![0u8; (nv12_row * uv_rows) as usize];
                        for pair in uv.chunks_exact_mut(2) {
                            pair[0] = u0;
                            pair[1] = v0;
                        }
                        let chroma = (width.div_ceil(2) * uv_rows) as usize;
                        let u = vec![u0; chroma];
                        let v = vec![v0; chroma];
                        let mut expected = vec![7u8; (width * height * 4) as usize];
                        let mut nv12 = vec![9u8; expected.len()];
                        let mut yuv = vec![9u8; expected.len()];
                        nv12_to_rgba_scalar(
                            &y,
                            &uv,
                            width,
                            height,
                            width,
                            nv12_row,
                            &mut expected,
                            matrix,
                        );
                        nv12_to_rgba_with_matrix(
                            &y, &uv, width, height, width, nv12_row, &mut nv12, matrix,
                        );
                        assert_eq!(nv12, expected, "{matrix:?} y={y0} u={u0} v={v0}");
                        yuv420p_to_rgba_scalar(
                            &y,
                            &u,
                            &v,
                            width,
                            height,
                            width,
                            width.div_ceil(2),
                            &mut expected,
                            matrix,
                        );
                        yuv420p_to_rgba_with_matrix(
                            &y,
                            &u,
                            &v,
                            width,
                            height,
                            width,
                            width.div_ceil(2),
                            &mut yuv,
                            matrix,
                        );
                        assert_eq!(yuv, expected, "420 {matrix:?} y={y0} u={u0} v={v0}");
                    }
                }
            }
        }
    }

    fn nv12_len(width: usize, height: usize) -> usize {
        width * height + width * (height / 2)
    }

    fn sample_rgba(x: usize, y: usize) -> [u8; 4] {
        [
            x.wrapping_mul(17).wrapping_add(y.wrapping_mul(31)) as u8,
            x.wrapping_mul(13)
                .wrapping_add(y.wrapping_mul(7))
                .wrapping_add(40) as u8,
            x.wrapping_mul(3)
                .wrapping_add(y.wrapping_mul(19))
                .wrapping_add(90) as u8,
            x.wrapping_mul(19).wrapping_add(y) as u8,
        ]
    }

    fn rgba_frame(width: usize, height: usize, stride: usize) -> Vec<u8> {
        let mut data = vec![0xA5; stride.saturating_mul(height)];
        for y in 0..height {
            for x in 0..width {
                let pixel = sample_rgba(x, y);
                let offset = y * stride + x * 4;
                data[offset..offset + 4].copy_from_slice(&pixel);
            }
        }
        data
    }

    fn assert_max_abs_diff(actual: &[u8], expected: &[u8], label: &str) {
        assert_eq!(actual.len(), expected.len(), "{label} length");
        let mut max_diff = 0i32;
        let mut first = None;
        for (index, (got, want)) in actual.iter().zip(expected).enumerate() {
            let diff = i32::from(*got) - i32::from(*want);
            let abs = diff.abs();
            if abs > max_diff {
                max_diff = abs;
            }
            if abs != 0 && first.is_none() {
                first = Some((index, *want, *got));
            }
        }
        assert!(
            max_diff == 0,
            "{label}: max abs diff {max_diff}, first mismatch {first:?}"
        );
    }

    #[test]
    fn rgba_to_nv12_empty_dimensions_are_a_no_op() {
        let mut dst = Vec::new();
        rgba_to_nv12(&[], 0, 0, 0, &mut dst);
        rgba_to_nv12(&[], 0, 0, 4, &mut dst);
        rgba_to_nv12(&[0; 16], 16, 4, 0, &mut dst);
    }

    #[test]
    fn rgba_to_nv12_averages_the_block_before_the_matrix() {
        // Blue 5 in one sample of the 2×2 block. The mean is (5 + 2) / 4 = 1,
        // and BT.709 chroma of that mean is neutral. A >>18 weighted sum is Cb 129.
        for (width, x) in [(2, 0), (8, 0), (10, 8), (16, 8)] {
            let height = 2;
            let mut rgba = vec![0u8; width * height * 4];
            rgba[(x * 4) + 2] = 5;
            let mut dst = vec![0u8; nv12_len(width, height)];
            rgba_to_nv12(&rgba, width * 4, width, height, &mut dst);
            let y_plane = width * height;
            assert_eq!(dst[x], bt709_luma(0, 0, 5), "width {width} x {x}");
            let chroma = bt709_chroma(0, 0, 1);
            assert_eq!(chroma, [128, 128]);
            let uv = y_plane + (x / 2) * 2;
            assert_eq!(&dst[uv..uv + 2], &chroma, "width {width} x {x}");
        }
    }

    #[test]
    fn rgba_to_nv12_matches_scalar_on_odd_sizes_and_padding() {
        let widths = [1, 2, 3, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65];
        let heights = [1, 2, 3, 5, 8, 15, 17];
        let pads = [0, 1, 7, 16, 63];
        for width in widths {
            for height in heights {
                for pad in pads {
                    assert_rgba_nv12_exact(width, height, width * 4 + pad);
                }
            }
        }
        for (width, height, pad) in [(1919, 3, 7), (1920, 2, 0), (1921, 4, 13), (160, 9, 192)] {
            assert_rgba_nv12_exact(width, height, width * 4 + pad);
        }
    }

    fn assert_rgba_nv12_exact(width: usize, height: usize, stride: usize) {
        let src = rgba_frame(width, height, stride);
        let mut expected = vec![0x5A; nv12_len(width, height)];
        let mut actual = expected.clone();
        rgba_to_nv12_scalar(&src, stride, width, height, &mut expected);
        rgba_to_nv12(&src, stride, width, height, &mut actual);
        assert_max_abs_diff(
            &actual,
            &expected,
            &format!("{width}x{height} stride {stride}"),
        );
        #[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
        if is_x86_feature_detected!("avx2") {
            let mut direct = vec![0x5A; expected.len()];
            unsafe {
                rgba_to_nv12_avx2(&src, stride, width, height, &mut direct);
            }
            assert_max_abs_diff(
                &direct,
                &expected,
                &format!("avx2 {width}x{height} stride {stride}"),
            );
        }
    }

    #[test]
    #[ignore = "benchmark; run with --release --ignored --nocapture"]
    fn benchmark_rgba_to_nv12() {
        use std::time::Instant;

        const WARMUP: usize = 8;
        const SAMPLES: usize = 31;

        fn median_ms(samples: &mut [std::time::Duration]) -> f64 {
            samples.sort_unstable();
            let mid = samples.len() / 2;
            let median = if samples.len().is_multiple_of(2) {
                (samples[mid - 1].as_secs_f64() + samples[mid].as_secs_f64()) / 2.0
            } else {
                samples[mid].as_secs_f64()
            };
            median * 1000.0
        }

        fn time_ms(mut invoke: impl FnMut()) -> f64 {
            for _ in 0..WARMUP {
                invoke();
            }
            let mut samples = Vec::with_capacity(SAMPLES);
            for _ in 0..SAMPLES {
                let start = Instant::now();
                invoke();
                samples.push(start.elapsed());
            }
            median_ms(&mut samples)
        }

        let cpu = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let model = cpu
            .lines()
            .find(|line| line.starts_with("model name"))
            .unwrap_or("model name: unknown");
        println!("cpu: {model}");
        println!("warmup: {WARMUP} samples: {SAMPLES} threads: 1");
        println!("profile: opt-level=s codegen-units=1 lto=thin target-cpu=generic");
        println!("rayon: not used by rgba_to_nv12");
        println!("| size | stride | scalar ms | avx2 ms | speedup | max abs diff |");
        println!("| --- | ---: | ---: | ---: | ---: | ---: |");

        for (width, height) in [(1920, 1080), (3024, 1964), (3840, 2160)] {
            let stride =
                crate::frame_pipeline::padded_bytes_per_row((width as u32, height as u32)) as usize;
            let src = rgba_frame(width, height, stride);
            let mut scalar_dst = vec![0u8; nv12_len(width, height)];
            let mut avx2_dst = scalar_dst.clone();
            rgba_to_nv12_scalar(&src, stride, width, height, &mut scalar_dst);
            rgba_to_nv12(&src, stride, width, height, &mut avx2_dst);
            let mut max_diff = 0i32;
            for (got, want) in avx2_dst.iter().zip(&scalar_dst) {
                max_diff = max_diff.max((i32::from(*got) - i32::from(*want)).abs());
            }
            let scalar_ms = time_ms(|| {
                rgba_to_nv12_scalar(&src, stride, width, height, &mut scalar_dst);
                std::hint::black_box(scalar_dst.as_ptr());
            });
            let avx2_ms = time_ms(|| {
                rgba_to_nv12(&src, stride, width, height, &mut avx2_dst);
                std::hint::black_box(avx2_dst.as_ptr());
            });
            let speedup = scalar_ms / avx2_ms;
            println!(
                "| {width}x{height} | {stride} | {scalar_ms:.3} | {avx2_ms:.3} | {speedup:.2}x | {max_diff} |"
            );
        }
    }
}
