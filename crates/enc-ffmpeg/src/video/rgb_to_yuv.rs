use ffmpeg::format::Pixel;
use ffmpeg::frame;

// 16.16 BT.709, full range RGB to limited YUV. The luma row sums to 56284
// (219/255) and each chroma row sums to 0, so a grey pixel stays on the
// limited-range axis (black 16/128/128, white 235/128/128).
#[cfg(any(target_arch = "x86_64", test))]
const Y_R: i32 = 11_966;
#[cfg(any(target_arch = "x86_64", test))]
const Y_G: i32 = 40_254;
#[cfg(any(target_arch = "x86_64", test))]
const Y_B: i32 = 4_064;
#[cfg(any(target_arch = "x86_64", test))]
const CB_R: i32 = -6_596;
#[cfg(any(target_arch = "x86_64", test))]
const CB_G: i32 = -22_189;
#[cfg(any(target_arch = "x86_64", test))]
const CB_B: i32 = 28_785;
#[cfg(any(target_arch = "x86_64", test))]
const CR_R: i32 = 28_785;
#[cfg(any(target_arch = "x86_64", test))]
const CR_G: i32 = -26_145;
#[cfg(any(target_arch = "x86_64", test))]
const CR_B: i32 = -2_640;
#[cfg(any(target_arch = "x86_64", test))]
const ROUND: i32 = 1 << 15;

#[cfg(any(target_arch = "x86_64", test))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum ChannelOrder {
    Bgr,
    Rgb,
}

#[cfg(any(target_arch = "x86_64", test))]
struct Job {
    src: *const u8,
    src_stride: usize,
    #[cfg(target_arch = "x86_64")]
    width: usize,
    #[cfg(target_arch = "x86_64")]
    height: usize,
    order: ChannelOrder,
    y: *mut u8,
    y_stride: usize,
    u: *mut u8,
    u_stride: usize,
    v: *mut u8,
    v_stride: usize,
    uv: *mut u8,
    uv_stride: usize,
    nv12: bool,
}

#[cfg(any(target_arch = "x86_64", test))]
fn luma(r: i32, g: i32, b: i32) -> u8 {
    let y = (Y_R * r + Y_G * g + Y_B * b + ROUND) >> 16;
    (16 + y).clamp(16, 235) as u8
}

#[cfg(any(target_arch = "x86_64", test))]
fn chroma_from_sum(r_sum: i32, g_sum: i32, b_sum: i32, n: i32) -> (u8, u8) {
    let shift = 16 + n.trailing_zeros();
    let bias = n << 15;
    let cb = (CB_R * r_sum + CB_G * g_sum + CB_B * b_sum + bias) >> shift;
    let cr = (CR_R * r_sum + CR_G * g_sum + CR_B * b_sum + bias) >> shift;
    (
        (128 + cb).clamp(16, 240) as u8,
        (128 + cr).clamp(16, 240) as u8,
    )
}

#[cfg(any(target_arch = "x86_64", test))]
unsafe fn load_rgb(job: &Job, x: usize, y: usize) -> (i32, i32, i32) {
    unsafe {
        let pixel = job.src.add(y * job.src_stride + x * 4);
        let c0 = i32::from(*pixel);
        let c1 = i32::from(*pixel.add(1));
        let c2 = i32::from(*pixel.add(2));
        match job.order {
            ChannelOrder::Bgr => (c2, c1, c0),
            ChannelOrder::Rgb => (c0, c1, c2),
        }
    }
}

#[cfg(any(target_arch = "x86_64", test))]
unsafe fn store_chroma(job: &Job, cx: usize, cy: usize, cb: u8, cr: u8) {
    unsafe {
        if job.nv12 {
            let offset = cy * job.uv_stride + cx * 2;
            *job.uv.add(offset) = cb;
            *job.uv.add(offset + 1) = cr;
        } else {
            *job.u.add(cy * job.u_stride + cx) = cb;
            *job.v.add(cy * job.v_stride + cx) = cr;
        }
    }
}

/// `x0` and `y0` are even. `x1` and `y1` are exclusive.
#[cfg(any(target_arch = "x86_64", test))]
unsafe fn convert_range(job: &Job, x0: usize, x1: usize, y0: usize, y1: usize) {
    unsafe {
        let mut y = y0;
        while y < y1 {
            let rows = if y + 1 < y1 { 2 } else { 1 };
            let mut x = x0;
            while x < x1 {
                let cols = if x + 1 < x1 { 2 } else { 1 };
                let mut r_sum = 0;
                let mut g_sum = 0;
                let mut b_sum = 0;
                let mut row = 0;
                while row < rows {
                    let mut col = 0;
                    while col < cols {
                        let (r, g, b) = load_rgb(job, x + col, y + row);
                        r_sum += r;
                        g_sum += g;
                        b_sum += b;
                        *job.y.add((y + row) * job.y_stride + (x + col)) = luma(r, g, b);
                        col += 1;
                    }
                    row += 1;
                }
                let (cb, cr) = chroma_from_sum(r_sum, g_sum, b_sum, (rows * cols) as i32);
                store_chroma(job, x / 2, y / 2, cb, cr);
                x += cols;
            }
            y += rows;
        }
    }
}

fn avx2_runtime() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

#[cfg(any(target_arch = "x86_64", test))]
fn execute(job: &Job) {
    #[cfg(target_arch = "x86_64")]
    {
        // SAFETY: `try_convert` calls this only after `avx2_runtime`, and each
        // plane covers the active rectangle.
        unsafe { avx2::execute(job) };
    }
    #[cfg(not(target_arch = "x86_64"))]
    let _ = job;
}

fn positive_linesize(frame: &frame::Video, plane: usize) -> Option<usize> {
    if plane >= frame.planes() {
        return None;
    }
    let raw = unsafe { (*frame.as_ptr()).linesize[plane] };
    if raw <= 0 { None } else { Some(raw as usize) }
}

fn covers(stride: usize, row_bytes: usize, height: usize, len: usize) -> bool {
    if row_bytes == 0 || height == 0 {
        return true;
    }
    if stride < row_bytes {
        return false;
    }
    stride
        .checked_mul(height - 1)
        .and_then(|last| last.checked_add(row_bytes))
        .is_some_and(|need| need <= len)
}

pub(crate) fn try_convert(src: &frame::Video, dst: &mut frame::Video) -> bool {
    if src.width() != dst.width() || src.height() != dst.height() {
        return false;
    }
    #[cfg(any(target_arch = "x86_64", test))]
    let order = match src.format() {
        Pixel::BGRA | Pixel::BGRZ => ChannelOrder::Bgr,
        Pixel::RGBA | Pixel::RGBZ => ChannelOrder::Rgb,
        _ => return false,
    };
    #[cfg(not(any(target_arch = "x86_64", test)))]
    if !matches!(
        src.format(),
        Pixel::BGRA | Pixel::BGRZ | Pixel::RGBA | Pixel::RGBZ
    ) {
        return false;
    }
    let nv12 = match dst.format() {
        Pixel::YUV420P => false,
        Pixel::NV12 => true,
        _ => return false,
    };
    let width = src.width() as usize;
    let height = src.height() as usize;
    if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return false;
    }
    if width == 0 || height == 0 {
        return true;
    }
    if !avx2_runtime() {
        return false;
    }
    let Some(src_stride) = positive_linesize(src, 0) else {
        return false;
    };
    let Some(y_stride) = positive_linesize(dst, 0) else {
        return false;
    };
    if !covers(src_stride, width * 4, height, src.data(0).len())
        || !covers(y_stride, width, height, dst.data(0).len())
    {
        return false;
    }

    let chroma_w = width.div_ceil(2);
    let chroma_h = height.div_ceil(2);
    let (u_stride, v_stride, uv_stride) = if nv12 {
        let Some(uv_stride) = positive_linesize(dst, 1) else {
            return false;
        };
        if !covers(uv_stride, chroma_w * 2, chroma_h, dst.data(1).len()) {
            return false;
        }
        (0, 0, uv_stride)
    } else {
        let Some(u_stride) = positive_linesize(dst, 1) else {
            return false;
        };
        let Some(v_stride) = positive_linesize(dst, 2) else {
            return false;
        };
        if !covers(u_stride, chroma_w, chroma_h, dst.data(1).len())
            || !covers(v_stride, chroma_w, chroma_h, dst.data(2).len())
        {
            return false;
        }
        (u_stride, v_stride, 0)
    };
    #[cfg(not(any(target_arch = "x86_64", test)))]
    let _ = (u_stride, v_stride, uv_stride);

    #[cfg(any(target_arch = "x86_64", test))]
    {
        let src_ptr = src.data(0).as_ptr();
        let y_ptr = dst.data_mut(0).as_mut_ptr();
        let (u_ptr, v_ptr, uv_ptr) = if nv12 {
            (
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dst.data_mut(1).as_mut_ptr(),
            )
        } else {
            let u_ptr = dst.data_mut(1).as_mut_ptr();
            let v_ptr = dst.data_mut(2).as_mut_ptr();
            (u_ptr, v_ptr, std::ptr::null_mut())
        };

        execute(&Job {
            src: src_ptr,
            src_stride,
            #[cfg(target_arch = "x86_64")]
            width,
            #[cfg(target_arch = "x86_64")]
            height,
            order,
            y: y_ptr,
            y_stride,
            u: u_ptr,
            u_stride,
            v: v_ptr,
            v_stride,
            uv: uv_ptr,
            uv_stride,
            nv12,
        });
    }
    true
}

#[cfg(test)]
pub(crate) fn convert_or_scale(
    src: &frame::Video,
    dst: &mut frame::Video,
    scaler: &mut ffmpeg::software::scaling::Context,
) -> Result<(), ffmpeg::Error> {
    super::convert_or_scale(src, dst, scaler)
}

#[cfg(target_arch = "x86_64")]
mod avx2 {
    use std::arch::x86_64::*;

    use super::{Job, ROUND, convert_range};

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
        chroma_round: __m256i,
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
                y_r: _mm256_set1_epi32(super::Y_R),
                y_g: _mm256_set1_epi32(super::Y_G),
                y_b: _mm256_set1_epi32(super::Y_B),
                cb_r: _mm256_set1_epi32(super::CB_R),
                cb_g: _mm256_set1_epi32(super::CB_G),
                cb_b: _mm256_set1_epi32(super::CB_B),
                cr_r: _mm256_set1_epi32(super::CR_R),
                cr_g: _mm256_set1_epi32(super::CR_G),
                cr_b: _mm256_set1_epi32(super::CR_B),
                round: _mm256_set1_epi32(ROUND),
                chroma_round: _mm256_set1_epi32(4 * ROUND),
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

    pub(super) unsafe fn execute(job: &Job) {
        unsafe {
            match (job.order, job.nv12) {
                (super::ChannelOrder::Bgr, false) => convert::<true, false>(job),
                (super::ChannelOrder::Bgr, true) => convert::<true, true>(job),
                (super::ChannelOrder::Rgb, false) => convert::<false, false>(job),
                (super::ChannelOrder::Rgb, true) => convert::<false, true>(job),
            }
        }
    }

    #[target_feature(enable = "avx2")]
    unsafe fn convert<const BGR: bool, const NV12: bool>(job: &Job) {
        unsafe {
            let coeffs = Coeffs::new();
            let mut y = 0;
            while y + 1 < job.height {
                let mut x = 0;
                while x + 16 <= job.width {
                    kernel8::<BGR, NV12>(job, &coeffs, x, y);
                    kernel8::<BGR, NV12>(job, &coeffs, x + 8, y);
                    x += 16;
                }
                if x + 8 <= job.width {
                    kernel8::<BGR, NV12>(job, &coeffs, x, y);
                    x += 8;
                }
                if x < job.width {
                    convert_range(job, x, job.width, y, y + 2);
                }
                y += 2;
            }
            if y < job.height {
                convert_range(job, 0, job.width, y, y + 1);
            }
        }
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn kernel8<const BGR: bool, const NV12: bool>(
        job: &Job,
        coeffs: &Coeffs,
        x: usize,
        y: usize,
    ) {
        unsafe {
            let row0 = job.src.add(y * job.src_stride + x * 4);
            let row1 = job.src.add((y + 1) * job.src_stride + x * 4);
            let (r0, g0, b0) =
                unpack8::<BGR>(_mm256_loadu_si256(row0 as *const __m256i), coeffs.mask);
            let (r1, g1, b1) =
                unpack8::<BGR>(_mm256_loadu_si256(row1 as *const __m256i), coeffs.mask);
            store_y8(job.y.add(y * job.y_stride + x), luma8(r0, g0, b0, coeffs));
            store_y8(
                job.y.add((y + 1) * job.y_stride + x),
                luma8(r1, g1, b1, coeffs),
            );
            let r_sum = _mm256_add_epi32(
                pair_sum(r0, coeffs.pair_mask),
                pair_sum(r1, coeffs.pair_mask),
            );
            let g_sum = _mm256_add_epi32(
                pair_sum(g0, coeffs.pair_mask),
                pair_sum(g1, coeffs.pair_mask),
            );
            let b_sum = _mm256_add_epi32(
                pair_sum(b0, coeffs.pair_mask),
                pair_sum(b1, coeffs.pair_mask),
            );
            let cb = chroma8(
                r_sum,
                g_sum,
                b_sum,
                coeffs.cb_r,
                coeffs.cb_g,
                coeffs.cb_b,
                coeffs,
            );
            let cr = chroma8(
                r_sum,
                g_sum,
                b_sum,
                coeffs.cr_r,
                coeffs.cr_g,
                coeffs.cr_b,
                coeffs,
            );
            store_chroma8::<NV12>(job, x, y / 2, cb, cr, coeffs.gather);
        }
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn unpack8<const BGR: bool>(pix: __m256i, mask: __m256i) -> (__m256i, __m256i, __m256i) {
        let c0 = _mm256_and_si256(pix, mask);
        let c1 = _mm256_and_si256(_mm256_srli_epi32(pix, 8), mask);
        let c2 = _mm256_and_si256(_mm256_srli_epi32(pix, 16), mask);
        if BGR { (c2, c1, c0) } else { (c0, c1, c2) }
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
    unsafe fn pair_sum(v: __m256i, pair_mask: __m256i) -> __m256i {
        let shifted = _mm256_srli_epi64(v, 32);
        let sum = _mm256_add_epi32(v, shifted);
        _mm256_and_si256(sum, pair_mask)
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn chroma8(
        r_sum: __m256i,
        g_sum: __m256i,
        b_sum: __m256i,
        c_r: __m256i,
        c_g: __m256i,
        c_b: __m256i,
        coeffs: &Coeffs,
    ) -> __m256i {
        let mut acc = _mm256_mullo_epi32(r_sum, c_r);
        acc = _mm256_add_epi32(acc, _mm256_mullo_epi32(g_sum, c_g));
        acc = _mm256_add_epi32(acc, _mm256_mullo_epi32(b_sum, c_b));
        acc = _mm256_srai_epi32(_mm256_add_epi32(acc, coeffs.chroma_round), 18);
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
            _mm_storel_epi64(ptr as *mut __m128i, bytes);
        }
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn store_chroma8<const NV12: bool>(
        job: &Job,
        x: usize,
        cy: usize,
        cb: __m256i,
        cr: __m256i,
        gather: __m256i,
    ) {
        unsafe {
            let cb = _mm256_permutevar8x32_epi32(_mm256_shuffle_epi32(cb, 0xD8), gather);
            let cr = _mm256_permutevar8x32_epi32(_mm256_shuffle_epi32(cr, 0xD8), gather);
            if NV12 {
                let cb128 = _mm256_castsi256_si128(cb);
                let cr128 = _mm256_castsi256_si128(cr);
                let lo = _mm_unpacklo_epi32(cb128, cr128);
                let hi = _mm_unpackhi_epi32(cb128, cr128);
                let bytes = _mm_packus_epi16(_mm_packs_epi32(lo, hi), _mm_setzero_si128());
                _mm_storel_epi64(job.uv.add(cy * job.uv_stride + x) as *mut __m128i, bytes);
            } else {
                store_u32(job.u.add(cy * job.u_stride + x / 2), cb);
                store_u32(job.v.add(cy * job.v_stride + x / 2), cr);
            }
        }
    }

    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn store_u32(ptr: *mut u8, v: __m256i) {
        unsafe {
            let low = _mm256_castsi256_si128(v);
            let bytes = _mm_packus_epi16(
                _mm_packs_epi32(low, _mm_setzero_si128()),
                _mm_setzero_si128(),
            );
            _mm_storeu_si32(ptr, bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy)]
    enum Kernel {
        Scalar,
        Avx2,
    }

    struct Plane {
        data: Vec<u8>,
        stride: usize,
        row_bytes: usize,
    }

    fn plane(row_bytes: usize, pad: usize, height: usize) -> Plane {
        let stride = row_bytes + pad;
        Plane {
            data: vec![0xA5; stride * height],
            stride,
            row_bytes,
        }
    }

    fn swizzle(order: ChannelOrder, r: u8, g: u8, b: u8) -> [u8; 4] {
        match order {
            ChannelOrder::Bgr => [b, g, r, 255],
            ChannelOrder::Rgb => [r, g, b, 255],
        }
    }

    fn run_kernel(
        kernel: Kernel,
        order: ChannelOrder,
        nv12: bool,
        width: usize,
        height: usize,
        pad: usize,
        rgb: impl Fn(usize, usize) -> (u8, u8, u8),
    ) -> (Plane, Plane, Plane, Plane) {
        let mut src = plane(width * 4, pad, height);
        for y in 0..height {
            for x in 0..width {
                let (r, g, b) = rgb(x, y);
                let pixel = swizzle(order, r, g, b);
                let offset = y * src.stride + x * 4;
                src.data[offset..offset + 4].copy_from_slice(&pixel);
            }
        }
        let chroma_w = width.div_ceil(2);
        let chroma_h = height.div_ceil(2);
        let mut y_plane = plane(width, pad, height);
        let mut u_plane = plane(chroma_w, pad, chroma_h);
        let mut v_plane = plane(chroma_w, pad, chroma_h);
        let mut uv_plane = plane(chroma_w * 2, pad, chroma_h);
        let job = Job {
            src: src.data.as_ptr(),
            src_stride: src.stride,
            #[cfg(target_arch = "x86_64")]
            width,
            #[cfg(target_arch = "x86_64")]
            height,
            order,
            y: y_plane.data.as_mut_ptr(),
            y_stride: y_plane.stride,
            u: u_plane.data.as_mut_ptr(),
            u_stride: u_plane.stride,
            v: v_plane.data.as_mut_ptr(),
            v_stride: v_plane.stride,
            uv: uv_plane.data.as_mut_ptr(),
            uv_stride: uv_plane.stride,
            nv12,
        };
        match kernel {
            Kernel::Scalar => unsafe { convert_range(&job, 0, width, 0, height) },
            Kernel::Avx2 => {
                #[cfg(target_arch = "x86_64")]
                unsafe {
                    avx2::execute(&job);
                }
                #[cfg(not(target_arch = "x86_64"))]
                let _ = job;
            }
        }
        (y_plane, u_plane, v_plane, uv_plane)
    }

    fn assert_plane_eq(actual: &Plane, expected: &Plane) {
        assert_eq!(actual.data.len(), expected.data.len());
        assert_eq!(actual.stride, expected.stride);
        assert_eq!(actual.data, expected.data);
    }

    fn avx2_ready() -> bool {
        avx2_runtime()
    }

    #[test]
    fn avx2_matches_scalar_on_odd_sizes_and_padding() {
        if !avx2_ready() {
            return;
        }
        let widths = [
            1, 2, 3, 7, 8, 9, 15, 16, 17, 31, 32, 33, 47, 63, 64, 65, 127, 128, 160, 1919,
        ];
        let heights = [1, 2, 3, 5, 8, 15, 16, 17, 31, 33];
        let pads = [0, 1, 7, 16, 63];
        for width in widths {
            for height in heights {
                for pad in pads {
                    let rgb = |x: usize, y: usize| {
                        (
                            (x.wrapping_mul(17).wrapping_add(y.wrapping_mul(31))) as u8,
                            (x.wrapping_mul(13)
                                .wrapping_add(y.wrapping_mul(7))
                                .wrapping_add(40)) as u8,
                            (x.wrapping_mul(3)
                                .wrapping_add(y.wrapping_mul(19))
                                .wrapping_add(90)) as u8,
                        )
                    };
                    for (order, nv12) in [
                        (ChannelOrder::Bgr, false),
                        (ChannelOrder::Bgr, true),
                        (ChannelOrder::Rgb, false),
                        (ChannelOrder::Rgb, true),
                    ] {
                        let scalar =
                            run_kernel(Kernel::Scalar, order, nv12, width, height, pad, rgb);
                        let vector = run_kernel(Kernel::Avx2, order, nv12, width, height, pad, rgb);
                        assert_plane_eq(&vector.0, &scalar.0);
                        assert_plane_eq(&vector.1, &scalar.1);
                        assert_plane_eq(&vector.2, &scalar.2);
                        assert_plane_eq(&vector.3, &scalar.3);
                    }
                }
            }
        }
    }

    fn assert_flat(width: usize, height: usize, pad: usize, nv12: bool) {
        let rgb = |_: usize, _: usize| (220u8, 40u8, 40u8);
        for order in [ChannelOrder::Bgr, ChannelOrder::Rgb] {
            for kernel in [Kernel::Scalar, Kernel::Avx2] {
                if matches!(kernel, Kernel::Avx2) && !avx2_ready() {
                    continue;
                }
                let (y_plane, u_plane, v_plane, uv_plane) =
                    run_kernel(kernel, order, nv12, width, height, pad, rgb);
                assert_active(&y_plane, height, 83);
                if nv12 {
                    assert_nv12(&uv_plane, height.div_ceil(2), 110, 207);
                } else {
                    assert_active(&u_plane, height.div_ceil(2), 110);
                    assert_active(&v_plane, height.div_ceil(2), 207);
                }
            }
        }
    }

    fn assert_active(plane: &Plane, rows: usize, value: u8) {
        for row in 0..rows {
            let start = row * plane.stride;
            assert!(
                plane.data[start..start + plane.row_bytes]
                    .iter()
                    .all(|byte| *byte == value),
                "row {row} expected {value}, got {:?}",
                &plane.data[start..start + plane.row_bytes.min(8)]
            );
            assert!(
                plane.data[start + plane.row_bytes..start + plane.stride]
                    .iter()
                    .all(|byte| *byte == 0xA5)
            );
        }
    }

    fn assert_nv12(plane: &Plane, rows: usize, cb: u8, cr: u8) {
        for row in 0..rows {
            let start = row * plane.stride;
            for (index, byte) in plane.data[start..start + plane.row_bytes]
                .iter()
                .enumerate()
            {
                let expected = if index % 2 == 0 { cb } else { cr };
                assert_eq!(*byte, expected, "uv {row}:{index}");
            }
            assert!(
                plane.data[start + plane.row_bytes..start + plane.stride]
                    .iter()
                    .all(|byte| *byte == 0xA5)
            );
        }
    }

    #[test]
    fn flat_220_40_40_is_yuv_83_110_207() {
        for nv12 in [false, true] {
            for (width, height, pad) in [
                (1, 1, 0),
                (2, 2, 0),
                (3, 3, 5),
                (7, 5, 1),
                (8, 2, 0),
                (8, 8, 16),
                (15, 9, 3),
                (31, 17, 7),
                (32, 16, 0),
                (33, 17, 13),
                (64, 18, 63),
            ] {
                assert_flat(width, height, pad, nv12);
            }
        }
    }

    #[test]
    fn two_by_two_box_average_matches_reference() {
        let sample = |x: usize, y: usize| match (x, y) {
            (0, 0) => (10, 20, 30),
            (1, 0) => (40, 50, 60),
            (0, 1) => (70, 80, 90),
            (1, 1) => (100, 110, 120),
            _ => (0, 0, 0),
        };
        let (y_plane, u_plane, v_plane, _) =
            run_kernel(Kernel::Scalar, ChannelOrder::Bgr, false, 2, 2, 4, sample);
        assert_eq!(y_plane.data[0], 32);
        assert_eq!(y_plane.data[1], 58);
        assert_eq!(y_plane.data[y_plane.stride], 84);
        assert_eq!(y_plane.data[y_plane.stride + 1], 109);
        assert_eq!(u_plane.data[0], 133);
        assert_eq!(v_plane.data[0], 123);
        assert_eq!(y_plane.data[2], 0xA5);

        if !avx2_ready() {
            return;
        }
        let (vector_y, vector_u, vector_v, _) =
            run_kernel(Kernel::Avx2, ChannelOrder::Rgb, false, 8, 2, 8, sample);
        assert_eq!(vector_y.data[0], 32);
        assert_eq!(vector_y.data[1], 58);
        assert_eq!(vector_y.data[vector_y.stride], 84);
        assert_eq!(vector_y.data[vector_y.stride + 1], 109);
        assert_eq!(vector_u.data[0], 133);
        assert_eq!(vector_v.data[0], 123);
        let scalar = run_kernel(Kernel::Scalar, ChannelOrder::Rgb, false, 8, 2, 8, sample);
        assert_plane_eq(&vector_y, &scalar.0);
        assert_plane_eq(&vector_u, &scalar.1);
        assert_plane_eq(&vector_v, &scalar.2);
    }

    #[test]
    fn color_bars_match_expected_luma() {
        let colors = [
            (255, 0, 0, 63u8, 102u8, 240u8),
            (0, 255, 0, 173, 42, 26),
            (0, 0, 255, 32, 240, 118),
            (0, 0, 0, 16, 128, 128),
            (255, 255, 255, 235, 128, 128),
            (128, 128, 128, 126, 128, 128),
        ];
        let rgb = |x: usize, _: usize| {
            let (r, g, b, _, _, _) = colors[x / 32];
            (r, g, b)
        };
        for order in [ChannelOrder::Bgr, ChannelOrder::Rgb] {
            for nv12 in [false, true] {
                let (y_plane, u_plane, v_plane, uv_plane) =
                    run_kernel(Kernel::Scalar, order, nv12, 192, 32, 8, rgb);
                check_bars(&y_plane, &u_plane, &v_plane, &uv_plane, nv12, &colors);
                if avx2_ready() {
                    let (y_plane, u_plane, v_plane, uv_plane) =
                        run_kernel(Kernel::Avx2, order, nv12, 192, 32, 8, rgb);
                    check_bars(&y_plane, &u_plane, &v_plane, &uv_plane, nv12, &colors);
                }
            }
        }
    }

    fn check_bars(
        y_plane: &Plane,
        u_plane: &Plane,
        v_plane: &Plane,
        uv_plane: &Plane,
        nv12: bool,
        colors: &[(u8, u8, u8, u8, u8, u8)],
    ) {
        for (index, (_, _, _, ey, eu, ev)) in colors.iter().enumerate() {
            let x = index * 32 + 16;
            let actual = y_plane.data[16 * y_plane.stride + x];
            assert!(
                actual.abs_diff(*ey) <= 1,
                "luma bar {index}: {actual} vs {ey}"
            );
            let (cb, cr) = if nv12 {
                let offset = 8 * uv_plane.stride + x;
                (uv_plane.data[offset], uv_plane.data[offset + 1])
            } else {
                let cx = x / 2;
                (
                    u_plane.data[8 * u_plane.stride + cx],
                    v_plane.data[8 * v_plane.stride + cx],
                )
            };
            assert!(cb.abs_diff(*eu) <= 1, "cb bar {index}: {cb} vs {eu}");
            assert!(cr.abs_diff(*ev) <= 1, "cr bar {index}: {cr} vs {ev}");
        }
    }

    #[test]
    fn swscale_fast_bilinear_stays_within_tolerance() {
        ffmpeg::init().unwrap();
        let gradient = |x: usize, y: usize, width: usize, height: usize| {
            let width = width.max(1);
            let height = height.max(1);
            (
                (x * 255 / width) as u8,
                (y * 255 / height) as u8,
                ((x + y) * 255 / (width + height)) as u8,
            )
        };
        for (width, height) in [(32u32, 32u32), (64, 48), (320, 180)] {
            compare_swscale(Pixel::YUV420P, width, height, gradient);
        }
        compare_swscale(Pixel::YUV420P, 48, 24, |_, _, _, _| (220, 40, 40));
        compare_swscale(Pixel::NV12, 320, 180, gradient);
    }

    fn compare_swscale(
        format: Pixel,
        width: u32,
        height: u32,
        rgb: impl Fn(usize, usize, usize, usize) -> (u8, u8, u8),
    ) {
        let width_px = width as usize;
        let height_px = height as usize;
        let mut src = frame::Video::new(Pixel::BGRZ, width, height);
        if !avx2_ready() {
            let mut dst = frame::Video::new(format, width, height);
            assert!(!try_convert(&src, &mut dst), "{format:?} {width}x{height}");
            return;
        }
        let stride = src.stride(0);
        for y in 0..height_px {
            for x in 0..width_px {
                let (r, g, b) = rgb(x, y, width_px, height_px);
                let offset = y * stride + x * 4;
                src.data_mut(0)[offset..offset + 4].copy_from_slice(&[b, g, r, 255]);
            }
        }
        let mut scaler = bt709_scaler(format, width, height);
        let mut sws = frame::Video::new(format, width, height);
        scaler.run(&src, &mut sws).unwrap();
        let mut ours = frame::Video::new(format, width, height);
        assert!(try_convert(&src, &mut ours), "{format:?} {width}x{height}");
        let y_stats = plane_delta(&ours, &sws, 0, width as usize, height as usize);
        let chroma_h = (height as usize).div_ceil(2);
        assert!(
            y_stats.max_diff <= 2 && y_stats.mean < 1.0,
            "{format:?} {width}x{height} luma max {} mean {:.3} at {},{}",
            y_stats.max_diff,
            y_stats.mean,
            y_stats.col,
            y_stats.row
        );
        if format == Pixel::NV12 {
            let uv_stats = plane_delta(&ours, &sws, 1, width as usize, chroma_h);
            assert!(
                uv_stats.max_diff <= 3 && uv_stats.mean < 1.5,
                "{format:?} {width}x{height} chroma max {} mean {:.3} at {},{}",
                uv_stats.max_diff,
                uv_stats.mean,
                uv_stats.col,
                uv_stats.row
            );
        } else {
            let chroma_w = (width as usize).div_ceil(2);
            let u_stats = plane_delta(&ours, &sws, 1, chroma_w, chroma_h);
            let v_stats = plane_delta(&ours, &sws, 2, chroma_w, chroma_h);
            assert!(
                u_stats.max_diff <= 3
                    && v_stats.max_diff <= 3
                    && u_stats.mean < 1.5
                    && v_stats.mean < 1.5,
                "{format:?} {width}x{height} chroma u max {} mean {:.3} at {},{} v max {} mean {:.3} at {},{}",
                u_stats.max_diff,
                u_stats.mean,
                u_stats.col,
                u_stats.row,
                v_stats.max_diff,
                v_stats.mean,
                v_stats.col,
                v_stats.row
            );
        }
    }

    struct PlaneStats {
        max_diff: u8,
        mean: f64,
        col: usize,
        row: usize,
    }

    fn plane_delta(
        actual: &frame::Video,
        expected: &frame::Video,
        plane: usize,
        width: usize,
        height: usize,
    ) -> PlaneStats {
        let mut max_diff = 0u8;
        let mut sum = 0u64;
        let mut count = 0u64;
        let mut col = 0;
        let mut row = 0;
        for y in 0..height {
            let actual_row = &actual.data(plane)[y * actual.stride(plane)..];
            let expected_row = &expected.data(plane)[y * expected.stride(plane)..];
            for x in 0..width {
                let diff = actual_row[x].abs_diff(expected_row[x]);
                sum += u64::from(diff);
                count += 1;
                if diff > max_diff {
                    max_diff = diff;
                    col = x;
                    row = y;
                }
            }
        }
        PlaneStats {
            max_diff,
            mean: sum as f64 / count as f64,
            col,
            row,
        }
    }

    #[test]
    fn odd_sizes_convert_or_scale_matches_swscale() {
        ffmpeg::init().unwrap();
        for (width, height) in [(1u32, 2), (2, 1), (65, 64), (64, 63), (65, 63), (31, 17)] {
            let mut src = frame::Video::new(Pixel::BGRZ, width, height);
            let stride = src.stride(0);
            for y in 0..height as usize {
                for x in 0..width as usize {
                    let offset = y * stride + x * 4;
                    src.data_mut(0)[offset..offset + 4].copy_from_slice(&[
                        (x.wrapping_mul(3).wrapping_add(y)) as u8,
                        (y.wrapping_mul(5).wrapping_add(40)) as u8,
                        (x.wrapping_mul(7).wrapping_add(90)) as u8,
                        255,
                    ]);
                }
            }
            let mut probe = frame::Video::new(Pixel::YUV420P, width, height);
            assert!(!try_convert(&src, &mut probe), "{width}x{height} yuv420p");
            let mut nv12 = frame::Video::new(Pixel::NV12, width, height);
            assert!(!try_convert(&src, &mut nv12), "{width}x{height} nv12");

            let mut via_scaler = bt709_scaler(Pixel::YUV420P, width, height);
            let mut via = frame::Video::new(Pixel::YUV420P, width, height);
            convert_or_scale(&src, &mut via, &mut via_scaler).unwrap();
            let mut direct_scaler = bt709_scaler(Pixel::YUV420P, width, height);
            let mut direct = frame::Video::new(Pixel::YUV420P, width, height);
            direct_scaler.run(&src, &mut direct).unwrap();
            assert_frames_eq(&via, &direct, width, height);
        }
    }

    fn bt709_scaler(format: Pixel, width: u32, height: u32) -> ffmpeg::software::scaling::Context {
        let mut scaler = ffmpeg::software::scaling::Context::get(
            Pixel::BGRZ,
            width,
            height,
            format,
            width,
            height,
            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
        )
        .unwrap();
        super::super::colour::use_bt709_for_rgb_input(&mut scaler, Pixel::BGRZ, format).unwrap();
        scaler
    }

    fn assert_frames_eq(actual: &frame::Video, expected: &frame::Video, width: u32, height: u32) {
        for plane in 0..expected.planes() {
            let row_bytes = expected.plane_width(plane) as usize;
            for row in 0..expected.plane_height(plane) as usize {
                let got = &actual.data(plane)[row * actual.stride(plane)..][..row_bytes];
                let want = &expected.data(plane)[row * expected.stride(plane)..][..row_bytes];
                assert_eq!(got, want, "{width}x{height} plane {plane} row {row}");
            }
        }
    }

    #[test]
    fn other_formats_and_scaling_stay_on_swscale() {
        ffmpeg::init().unwrap();
        let src = frame::Video::new(Pixel::BGRZ, 32, 16);
        let mut scaled = frame::Video::new(Pixel::YUV420P, 16, 16);
        assert!(!try_convert(&src, &mut scaled));
        let rgb24 = frame::Video::new(Pixel::RGB24, 32, 16);
        let mut yuv = frame::Video::new(Pixel::YUV420P, 32, 16);
        assert!(!try_convert(&rgb24, &mut yuv));
        let yuv_src = frame::Video::new(Pixel::YUV420P, 32, 16);
        assert!(!try_convert(&yuv_src, &mut yuv));

        let mut scaler = ffmpeg::software::scaling::Context::get(
            Pixel::BGRA,
            32,
            16,
            Pixel::YUV420P,
            16,
            8,
            ffmpeg::software::scaling::flag::Flags::BICUBIC,
        )
        .unwrap();
        super::super::colour::use_bt709_for_rgb_input(&mut scaler, Pixel::BGRA, Pixel::YUV420P)
            .unwrap();
        let mut bgra = frame::Video::new(Pixel::BGRA, 32, 16);
        for (index, byte) in bgra.data_mut(0).iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        let mut via_helper = frame::Video::empty();
        let mut direct = frame::Video::empty();
        convert_or_scale(&bgra, &mut via_helper, &mut scaler).unwrap();
        scaler.run(&bgra, &mut direct).unwrap();
        for plane in 0..direct.planes() {
            let width = direct.plane_width(plane) as usize;
            for row in 0..direct.plane_height(plane) as usize {
                let got = &via_helper.data(plane)[row * via_helper.stride(plane)..][..width];
                let expect = &direct.data(plane)[row * direct.stride(plane)..][..width];
                assert_eq!(got, expect);
            }
        }
    }

    #[test]
    #[ignore = "release timing bench, run with --ignored --nocapture"]
    fn bench_bgrz_to_yuv420p() {
        ffmpeg::init().unwrap();
        let model = std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|text| {
                text.lines()
                    .find(|line| line.starts_with("model name"))
                    .and_then(|line| line.split(':').nth(1))
                    .map(|value| value.trim().to_string())
            })
            .unwrap_or_else(|| "unknown".into());
        println!("cpu: {model}");
        println!("avx2: {}", avx2_ready());
        println!("warmup excluded from n; median is the middle sorted sample");
        for (width, height) in [(1280, 720), (1920, 1080), (3840, 2160)] {
            bench_conversion(width, height);
        }
        for (width, height) in [(1280, 720), (1920, 1080), (3840, 2160)] {
            bench_queue_frame(width, height);
        }
    }

    fn bench_conversion(width: u32, height: u32) {
        let mut src = frame::Video::new(Pixel::BGRZ, width, height);
        fill_gradient(&mut src);
        let mut kernel_dst = frame::Video::new(Pixel::YUV420P, width, height);
        let mut sws_dst = frame::Video::new(Pixel::YUV420P, width, height);
        let mut scaler = ffmpeg::software::scaling::Context::get(
            Pixel::BGRZ,
            width,
            height,
            Pixel::YUV420P,
            width,
            height,
            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
        )
        .unwrap();
        super::super::colour::use_bt709_for_rgb_input(&mut scaler, Pixel::BGRZ, Pixel::YUV420P)
            .unwrap();
        let sws = time_median(5, 31, || {
            scaler.run(&src, &mut sws_dst).unwrap();
            std::hint::black_box(sws_dst.data(0).as_ptr());
        });
        let kernel = time_median(5, 31, || {
            assert!(try_convert(&src, &mut kernel_dst));
            std::hint::black_box(kernel_dst.data(0).as_ptr());
            std::hint::black_box(kernel_dst.data(1).as_ptr());
        });
        println!(
            "{width}x{height} swscale_fast_bilinear_bt709 median {:.3} ms n=31",
            sws / 1_000_000.0
        );
        println!(
            "{width}x{height} bt709_kernel median {:.3} ms n=31 speedup {:.2}x",
            kernel / 1_000_000.0,
            sws / kernel
        );
    }

    fn bench_queue_frame(width: u32, height: u32) {
        let info = cap_media_info::VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, width, height, 30);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bench.mp4");
        let mut output = ffmpeg::format::output_as(&path, "mp4").unwrap();
        let mut encoder = super::super::h264::H264Encoder::builder(info)
            .with_preset(super::super::h264::H264Preset::Ultrafast)
            .with_encoder_priority_override(&["libx264"])
            .build(&mut output)
            .unwrap();
        let mut sink = crate::PacketQueue::new(ffmpeg::Rational(1, 90_000));
        let mut frames = Vec::new();
        for _ in 0..11 {
            let mut frame = frame::Video::new(Pixel::BGRZ, width, height);
            fill_gradient(&mut frame);
            frames.push(frame);
        }
        for index in 0..2 {
            encoder
                .queue_frame_to(
                    frames.pop().unwrap(),
                    std::time::Duration::from_millis(index * 33),
                    &mut sink,
                )
                .unwrap();
            sink.take();
        }
        let mut samples = Vec::with_capacity(9);
        for index in 0..9 {
            let frame = frames.pop().unwrap();
            let started = std::time::Instant::now();
            encoder
                .queue_frame_to(
                    frame,
                    std::time::Duration::from_millis((index + 2) * 33),
                    &mut sink,
                )
                .unwrap();
            samples.push(started.elapsed().as_nanos());
            sink.take();
        }
        samples.sort_unstable();
        println!(
            "{width}x{height} queue_frame_to_libx264_ultrafast median {:.3} ms n=9",
            samples[samples.len() / 2] as f64 / 1_000_000.0
        );
    }

    fn fill_gradient(frame: &mut frame::Video) {
        let width = frame.width() as usize;
        let height = frame.height() as usize;
        let stride = frame.stride(0);
        let data = frame.data_mut(0);
        for y in 0..height {
            for x in 0..width {
                let offset = y * stride + x * 4;
                data[offset] = (x * 255 / width.max(1)) as u8;
                data[offset + 1] = (y * 255 / height.max(1)) as u8;
                data[offset + 2] = ((x + y) % 256) as u8;
                data[offset + 3] = 255;
            }
        }
    }

    fn time_median(warmup: usize, runs: usize, mut body: impl FnMut()) -> f64 {
        for _ in 0..warmup {
            body();
        }
        let mut samples = Vec::with_capacity(runs);
        for _ in 0..runs {
            let started = std::time::Instant::now();
            body();
            samples.push(started.elapsed().as_nanos());
        }
        samples.sort_unstable();
        samples[samples.len() / 2] as f64
    }
}
