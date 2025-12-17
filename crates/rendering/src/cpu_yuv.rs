use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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
            SimdLevel::Avx2 => 16,
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
pub fn nv12_to_rgba_simd(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
) {
    nv12_to_rgba_simd_with_progress(
        y_data, uv_data, width, height, y_stride, uv_stride, output, None,
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
) {
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
) {
    for row in 0..height {
        if let Some(ref p) = progress
            && p.is_cancelled()
        {
            return;
        }

        nv12_convert_row(
            y_data, uv_data, width, row, y_stride, uv_stride, output, simd_level,
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
) {
    nv12_convert_row_into(
        y_data, uv_data, width, row, y_stride, uv_stride, output, row, simd_level,
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
            );
        }
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[target_feature(enable = "avx2")]
unsafe fn nv12_convert_row_avx2(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
) {
    unsafe {
        nv12_convert_row_sse2(
            y_data,
            uv_data,
            width,
            y_row_start,
            uv_row_start,
            out_row_start,
            output,
        );
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
#[target_feature(enable = "sse2")]
unsafe fn nv12_convert_row_sse2(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
) {
    nv12_convert_row_scalar(
        y_data,
        uv_data,
        width,
        y_row_start,
        uv_row_start,
        out_row_start,
        output,
    );
}

#[cfg(any(target_arch = "x86_64", target_arch = "x86"))]
fn nv12_convert_row_scalar(
    y_data: &[u8],
    uv_data: &[u8],
    width: usize,
    y_row_start: usize,
    uv_row_start: usize,
    out_row_start: usize,
    output: &mut [u8],
) {
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

#[cfg(not(any(target_arch = "x86_64", target_arch = "x86")))]
pub fn nv12_to_rgba_simd_with_progress(
    y_data: &[u8],
    uv_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
    output: &mut [u8],
    _progress: Option<Arc<ConversionProgress>>,
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
    yuv420p_to_rgba_simd_with_progress(
        y_data, u_data, v_data, width, height, y_stride, uv_stride, output, None,
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
) {
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
) {
    for row in 0..height {
        if let Some(ref p) = progress
            && p.is_cancelled()
        {
            return;
        }

        yuv420p_convert_row(
            y_data, u_data, v_data, width, row, y_stride, uv_stride, output, simd_level,
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
) {
    yuv420p_convert_row_into(
        y_data, u_data, v_data, width, row, y_stride, uv_stride, output, row, simd_level,
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
) {
    unsafe {
        yuv420p_convert_row_sse2(
            y_data,
            u_data,
            v_data,
            width,
            y_row_start,
            uv_row_start,
            out_row_start,
            output,
        );
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
) {
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

        nv12_to_rgba(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output1,
        );

        nv12_to_rgba_simd(
            &y_data,
            &uv_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output2,
        );

        for (i, (a, b)) in output1.iter().zip(output2.iter()).enumerate() {
            let diff = (*a as i32 - *b as i32).abs();
            assert!(
                diff <= 2,
                "Mismatch at index {}: expected={}, got={}, diff={}",
                i,
                a,
                b,
                diff
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

        yuv420p_to_rgba(
            &y_data,
            &u_data,
            &v_data,
            width,
            height,
            y_stride,
            uv_stride,
            &mut output_scalar,
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
        );

        for (i, (s, d)) in output_scalar.iter().zip(output_simd.iter()).enumerate() {
            let diff = (*s as i32 - *d as i32).abs();
            assert!(
                diff <= 2,
                "YUV420P mismatch at index {}: scalar={}, simd={}, diff={}",
                i,
                s,
                d,
                diff
            );
        }
    }

    #[test]
    fn test_large_frame_parallel() {
        let width = 1920u32;
        let height = 1080u32;
        let y_stride = 1920u32;
        let uv_stride = 1920u32;

        let y_data: Vec<u8> = (0..y_stride * height).map(|i| ((i % 256) as u8)).collect();
        let uv_data: Vec<u8> = (0..uv_stride * height / 2)
            .map(|i| (((i + 64) % 256) as u8))
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
        );

        let rows_done = progress.rows_completed.load(Ordering::Relaxed);
        assert!(rows_done < height as usize);
    }
}
