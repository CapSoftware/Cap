use ffmpeg::format::Pixel;
use ffmpeg::frame;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Packed422 {
    Uyvy,
    Yuyv,
}

#[cfg(target_arch = "x86_64")]
struct Job {
    src: *const u8,
    src_stride: usize,
    width: usize,
    height: usize,
    kind: Packed422,
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

#[cfg(target_arch = "x86_64")]
fn positive_linesize(frame: &frame::Video, plane: usize) -> Option<usize> {
    if plane >= frame.planes() {
        return None;
    }
    let raw = unsafe { (*frame.as_ptr()).linesize[plane] };
    if raw <= 0 { None } else { Some(raw as usize) }
}

#[cfg(target_arch = "x86_64")]
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

/// Same-size UYVY422 or YUYV422 into `dst` when both dimensions are even,
/// AVX2 is available at runtime, and `dst` is YUV420P or NV12. Any other
/// input returns false so the caller keeps swscale.
pub(crate) fn try_convert(src: &frame::Video, dst: &mut frame::Video) -> bool {
    if src.width() != dst.width() || src.height() != dst.height() {
        return false;
    }
    let kind = match src.format() {
        Pixel::UYVY422 => Packed422::Uyvy,
        Pixel::YUYV422 => Packed422::Yuyv,
        _ => return false,
    };
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
    #[cfg(not(target_arch = "x86_64"))]
    {
        let _ = (kind, nv12);
        false
    }
    #[cfg(target_arch = "x86_64")]
    {
        if !std::arch::is_x86_feature_detected!("avx2") {
            return false;
        }
        let Some(src_stride) = positive_linesize(src, 0) else {
            return false;
        };
        let Some(y_stride) = positive_linesize(dst, 0) else {
            return false;
        };
        if !covers(src_stride, width * 2, height, src.data(0).len())
            || !covers(y_stride, width, height, dst.data(0).len())
        {
            return false;
        }
        let chroma_w = width / 2;
        let chroma_h = height / 2;
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

        let job = Job {
            src: src_ptr,
            src_stride,
            width,
            height,
            kind,
            y: y_ptr,
            y_stride,
            u: u_ptr,
            u_stride,
            v: v_ptr,
            v_stride,
            uv: uv_ptr,
            uv_stride,
            nv12,
        };
        // SAFETY: AVX2 was detected, and `covers` checked every active plane.
        unsafe { avx2::execute(&job) };
        true
    }
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

    use super::{Job, Packed422};

    #[target_feature(enable = "avx2")]
    pub(super) unsafe fn execute(job: &Job) {
        unsafe {
            let masks = match job.kind {
                Packed422::Uyvy => Masks {
                    y: uyvy_y_mask(),
                    u: uyvy_u_mask(),
                    v: uyvy_v_mask(),
                },
                Packed422::Yuyv => Masks {
                    y: yuyv_y_mask(),
                    u: yuyv_u_mask(),
                    v: yuyv_v_mask(),
                },
            };
            if job.nv12 {
                convert_frame::<true>(job, &masks);
            } else {
                convert_frame::<false>(job, &masks);
            }
        }
    }

    struct Masks {
        y: __m256i,
        u: __m256i,
        v: __m256i,
    }

    #[target_feature(enable = "avx2")]
    unsafe fn convert_frame<const NV12: bool>(job: &Job, masks: &Masks) {
        unsafe {
            let mut top = 0;
            while top < job.height {
                let row = Row16 {
                    src0: job.src.add(top * job.src_stride),
                    src1: job.src.add((top + 1) * job.src_stride),
                    y0: job.y.add(top * job.y_stride),
                    y1: job.y.add((top + 1) * job.y_stride),
                    top,
                };
                let mut x = 0;
                while x + 32 <= job.width {
                    convert16::<NV12>(job, masks, &row, x);
                    convert16::<NV12>(job, masks, &row, x + 16);
                    x += 32;
                }
                while x + 16 <= job.width {
                    convert16::<NV12>(job, masks, &row, x);
                    x += 16;
                }
                if x < job.width {
                    scalar_tail::<NV12>(job, top, x);
                }
                top += 2;
            }
        }
    }

    struct Row16 {
        src0: *const u8,
        src1: *const u8,
        y0: *mut u8,
        y1: *mut u8,
        top: usize,
    }

    #[target_feature(enable = "avx2")]
    unsafe fn convert16<const NV12: bool>(job: &Job, masks: &Masks, row: &Row16, x: usize) {
        unsafe {
            let packed0 = _mm256_loadu_si256(row.src0.add(x * 2).cast());
            store_luma(packed0, masks.y, row.y0.add(x));
            let u0 = pack_chroma8(packed0, masks.u);
            let v0 = pack_chroma8(packed0, masks.v);
            let packed1 = _mm256_loadu_si256(row.src1.add(x * 2).cast());
            store_luma(packed1, masks.y, row.y1.add(x));
            let u1 = pack_chroma8(packed1, masks.u);
            let v1 = pack_chroma8(packed1, masks.v);
            let u = _mm_avg_epu8(u0, u1);
            let v = _mm_avg_epu8(v0, v1);
            store_chroma8::<NV12>(job, row.top / 2, x / 2, u, v);
        }
    }

    #[target_feature(enable = "avx2")]
    unsafe fn store_luma(packed: __m256i, mask: __m256i, dst: *mut u8) {
        unsafe {
            let shuffled = _mm256_shuffle_epi8(packed, mask);
            let lo = _mm256_castsi256_si128(shuffled);
            let hi = _mm256_extracti128_si256(shuffled, 1);
            let y = _mm_unpacklo_epi64(lo, hi);
            _mm_storeu_si128(dst.cast(), y);
        }
    }

    #[target_feature(enable = "avx2")]
    unsafe fn pack_chroma8(packed: __m256i, mask: __m256i) -> __m128i {
        let shuffled = _mm256_shuffle_epi8(packed, mask);
        let lo = _mm256_castsi256_si128(shuffled);
        let hi = _mm256_extracti128_si256(shuffled, 1);
        _mm_unpacklo_epi32(lo, hi)
    }

    #[target_feature(enable = "avx2")]
    unsafe fn store_chroma8<const NV12: bool>(
        job: &Job,
        row: usize,
        x: usize,
        u: __m128i,
        v: __m128i,
    ) {
        unsafe {
            if NV12 {
                let interleaved = _mm_unpacklo_epi8(u, v);
                _mm_storeu_si128(job.uv.add(row * job.uv_stride + x * 2).cast(), interleaved);
            } else {
                _mm_storel_epi64(job.u.add(row * job.u_stride + x).cast(), u);
                _mm_storel_epi64(job.v.add(row * job.v_stride + x).cast(), v);
            }
        }
    }

    #[target_feature(enable = "avx2")]
    unsafe fn uyvy_y_mask() -> __m256i {
        _mm256_setr_epi8(
            1, 3, 5, 7, 9, 11, 13, 15, -1, -1, -1, -1, -1, -1, -1, -1, 1, 3, 5, 7, 9, 11, 13, 15,
            -1, -1, -1, -1, -1, -1, -1, -1,
        )
    }

    #[target_feature(enable = "avx2")]
    unsafe fn uyvy_u_mask() -> __m256i {
        _mm256_setr_epi8(
            0, 4, 8, 12, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 4, 8, 12, -1, -1, -1,
            -1, -1, -1, -1, -1, -1, -1, -1, -1,
        )
    }

    #[target_feature(enable = "avx2")]
    unsafe fn uyvy_v_mask() -> __m256i {
        _mm256_setr_epi8(
            2, 6, 10, 14, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, 6, 10, 14, -1, -1, -1,
            -1, -1, -1, -1, -1, -1, -1, -1, -1,
        )
    }

    #[target_feature(enable = "avx2")]
    unsafe fn yuyv_y_mask() -> __m256i {
        _mm256_setr_epi8(
            0, 2, 4, 6, 8, 10, 12, 14, -1, -1, -1, -1, -1, -1, -1, -1, 0, 2, 4, 6, 8, 10, 12, 14,
            -1, -1, -1, -1, -1, -1, -1, -1,
        )
    }

    #[target_feature(enable = "avx2")]
    unsafe fn yuyv_u_mask() -> __m256i {
        _mm256_setr_epi8(
            1, 5, 9, 13, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 5, 9, 13, -1, -1, -1,
            -1, -1, -1, -1, -1, -1, -1, -1, -1,
        )
    }

    #[target_feature(enable = "avx2")]
    unsafe fn yuyv_v_mask() -> __m256i {
        _mm256_setr_epi8(
            3, 7, 11, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3, 7, 11, 15, -1, -1, -1,
            -1, -1, -1, -1, -1, -1, -1, -1, -1,
        )
    }

    unsafe fn scalar_tail<const NV12: bool>(job: &Job, top: usize, x_start: usize) {
        let mut x = x_start;
        while x < job.width {
            unsafe {
                let (y0, y1, u0, v0) = load_macro(job, top, x);
                let (y2, y3, u1, v1) = load_macro(job, top + 1, x);
                *job.y.add(top * job.y_stride + x) = y0;
                *job.y.add(top * job.y_stride + x + 1) = y1;
                *job.y.add((top + 1) * job.y_stride + x) = y2;
                *job.y.add((top + 1) * job.y_stride + x + 1) = y3;
                let cx = x / 2;
                let cy = top / 2;
                let u = avg(u0, u1);
                let v = avg(v0, v1);
                if NV12 {
                    let dst = job.uv.add(cy * job.uv_stride + cx * 2);
                    *dst = u;
                    *dst.add(1) = v;
                } else {
                    *job.u.add(cy * job.u_stride + cx) = u;
                    *job.v.add(cy * job.v_stride + cx) = v;
                }
            }
            x += 2;
        }
    }

    unsafe fn load_macro(job: &Job, row: usize, x: usize) -> (u8, u8, u8, u8) {
        unsafe {
            let pixel = job.src.add(row * job.src_stride + x * 2);
            let b0 = *pixel;
            let b1 = *pixel.add(1);
            let b2 = *pixel.add(2);
            let b3 = *pixel.add(3);
            match job.kind {
                Packed422::Uyvy => (b1, b3, b0, b2),
                Packed422::Yuyv => (b0, b2, b1, b3),
            }
        }
    }

    fn avg(a: u8, b: u8) -> u8 {
        ((u16::from(a) + u16::from(b) + 1) >> 1) as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ffmpeg::software::scaling::{self, flag::Flags};

    fn avx2_ready() -> bool {
        #[cfg(target_arch = "x86_64")]
        {
            std::arch::is_x86_feature_detected!("avx2")
        }
        #[cfg(not(target_arch = "x86_64"))]
        {
            false
        }
    }

    fn fast_scaler(src: Pixel, dst: Pixel, width: u32, height: u32) -> scaling::Context {
        scaling::Context::get(src, width, height, dst, width, height, Flags::FAST_BILINEAR).unwrap()
    }

    fn zero_frame(frame: &mut frame::Video) {
        for plane in 0..frame.planes() {
            frame.data_mut(plane).fill(0);
        }
    }

    fn fill_packed(frame: &mut frame::Video) {
        let uyvy = frame.format() == Pixel::UYVY422;
        let width = frame.width() as usize;
        let height = frame.height() as usize;
        let stride = frame.stride(0);
        let data = frame.data_mut(0);
        for y in 0..height {
            let mut x = 0;
            while x + 1 < width {
                let y0 = ((x * 17 + y * 3) % 256) as u8;
                let y1 = ((x * 13 + y * 11 + 40) % 256) as u8;
                let u = ((x * 5 + y * 7 + 16) % 256) as u8;
                let v = ((x * 9 + y * 2 + 80) % 256) as u8;
                let off = y * stride + x * 2;
                if uyvy {
                    data[off..off + 4].copy_from_slice(&[u, y0, v, y1]);
                } else {
                    data[off..off + 4].copy_from_slice(&[y0, u, y1, v]);
                }
                x += 2;
            }
        }
    }

    fn reference(src: &frame::Video) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let width = src.width() as usize;
        let height = src.height() as usize;
        let stride = src.stride(0);
        let data = src.data(0);
        let uyvy = src.format() == Pixel::UYVY422;
        let cw = width / 2;
        let ch = height / 2;
        let mut y_plane = vec![0u8; width * height];
        let mut u_plane = vec![0u8; cw * ch];
        let mut v_plane = vec![0u8; cw * ch];
        let mut row = 0;
        while row < height {
            let mut x = 0;
            while x < width {
                let (y0, y1, u0, v0) = macro_at(data, stride, row, x, uyvy);
                let (y2, y3, u1, v1) = macro_at(data, stride, row + 1, x, uyvy);
                y_plane[row * width + x] = y0;
                y_plane[row * width + x + 1] = y1;
                y_plane[(row + 1) * width + x] = y2;
                y_plane[(row + 1) * width + x + 1] = y3;
                let cx = x / 2;
                let cy = row / 2;
                u_plane[cy * cw + cx] = ((u16::from(u0) + u16::from(u1) + 1) >> 1) as u8;
                v_plane[cy * cw + cx] = ((u16::from(v0) + u16::from(v1) + 1) >> 1) as u8;
                x += 2;
            }
            row += 2;
        }
        (y_plane, u_plane, v_plane)
    }

    fn macro_at(data: &[u8], stride: usize, row: usize, x: usize, uyvy: bool) -> (u8, u8, u8, u8) {
        let off = row * stride + x * 2;
        let b0 = data[off];
        let b1 = data[off + 1];
        let b2 = data[off + 2];
        let b3 = data[off + 3];
        if uyvy {
            (b1, b3, b0, b2)
        } else {
            (b0, b2, b1, b3)
        }
    }

    fn assert_matches_reference(actual: &frame::Video, y: &[u8], u: &[u8], v: &[u8]) {
        let width = actual.width() as usize;
        let height = actual.height() as usize;
        let cw = width / 2;
        let ch = height / 2;
        for row in 0..height {
            let got = &actual.data(0)[row * actual.stride(0)..][..width];
            assert_eq!(got, &y[row * width..][..width], "y row {row}");
        }
        if actual.format() == Pixel::NV12 {
            for row in 0..ch {
                let got = &actual.data(1)[row * actual.stride(1)..][..cw * 2];
                for cx in 0..cw {
                    assert_eq!(got[cx * 2], u[row * cw + cx], "nv12 u {cx},{row}");
                    assert_eq!(got[cx * 2 + 1], v[row * cw + cx], "nv12 v {cx},{row}");
                }
            }
        } else {
            for row in 0..ch {
                let got_u = &actual.data(1)[row * actual.stride(1)..][..cw];
                let got_v = &actual.data(2)[row * actual.stride(2)..][..cw];
                assert_eq!(got_u, &u[row * cw..][..cw], "u row {row}");
                assert_eq!(got_v, &v[row * cw..][..cw], "v row {row}");
            }
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
        let mut row_at = 0;
        for row in 0..height {
            let actual_row = &actual.data(plane)[row * actual.stride(plane)..];
            let expected_row = &expected.data(plane)[row * expected.stride(plane)..];
            for x in 0..width {
                let diff = actual_row[x].abs_diff(expected_row[x]);
                sum += u64::from(diff);
                count += 1;
                if diff > max_diff {
                    max_diff = diff;
                    col = x;
                    row_at = row;
                }
            }
        }
        PlaneStats {
            max_diff,
            mean: sum as f64 / count as f64,
            col,
            row: row_at,
        }
    }

    fn assert_within_swscale(actual: &frame::Video, expected: &frame::Video) {
        let width = actual.width() as usize;
        let height = actual.height() as usize;
        let y_stats = plane_delta(actual, expected, 0, width, height);
        let y_limit = if actual.format() == Pixel::NV12 { 4 } else { 2 };
        assert!(
            y_stats.max_diff <= y_limit && y_stats.mean < 1.0,
            "{width}x{height} luma max {} mean {:.3} at {},{}",
            y_stats.max_diff,
            y_stats.mean,
            y_stats.col,
            y_stats.row
        );
        let cw = width / 2;
        let ch = height / 2;
        if actual.format() == Pixel::NV12 {
            let uv_stats = plane_delta(actual, expected, 1, cw * 2, ch);
            assert!(
                uv_stats.max_diff <= 3 && uv_stats.mean < 1.5,
                "{width}x{height} nv12 max {} mean {:.3} at {},{}",
                uv_stats.max_diff,
                uv_stats.mean,
                uv_stats.col,
                uv_stats.row
            );
        } else {
            let u_stats = plane_delta(actual, expected, 1, cw, ch);
            let v_stats = plane_delta(actual, expected, 2, cw, ch);
            assert!(
                u_stats.max_diff <= 3
                    && v_stats.max_diff <= 3
                    && u_stats.mean < 1.5
                    && v_stats.mean < 1.5,
                "{width}x{height} chroma u max {} mean {:.3} at {},{} v max {} mean {:.3} at {},{}",
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

    fn assert_active_eq(actual: &frame::Video, expected: &frame::Video) {
        for plane in 0..expected.planes() {
            let row_bytes = if expected.format() == Pixel::NV12 && plane == 1 {
                expected.width() as usize
            } else {
                expected.plane_width(plane) as usize
            };
            for row in 0..expected.plane_height(plane) as usize {
                let got = &actual.data(plane)[row * actual.stride(plane)..][..row_bytes];
                let want = &expected.data(plane)[row * expected.stride(plane)..][..row_bytes];
                assert_eq!(got, want, "plane {plane} row {row}");
            }
        }
    }

    fn check_even(format: Pixel, width: u32, height: u32, dst_format: Pixel) {
        let mut src = frame::Video::new(format, width, height);
        fill_packed(&mut src);
        let (y, u, v) = reference(&src);
        let mut kernel = frame::Video::new(dst_format, width, height);
        let mut sws = frame::Video::new(dst_format, width, height);
        let mut scaler = fast_scaler(format, dst_format, width, height);
        scaler.run(&src, &mut sws).unwrap();
        if avx2_ready() {
            assert!(
                try_convert(&src, &mut kernel),
                "{format:?} {width}x{height} -> {dst_format:?}"
            );
            assert_matches_reference(&kernel, &y, &u, &v);
            assert_within_swscale(&kernel, &sws);
            let mut via = frame::Video::new(dst_format, width, height);
            let mut via_scaler = fast_scaler(format, dst_format, width, height);
            convert_or_scale(&src, &mut via, &mut via_scaler).unwrap();
            assert_active_eq(&via, &kernel);
        } else {
            assert!(!try_convert(&src, &mut kernel));
            let mut via = frame::Video::new(dst_format, width, height);
            let mut via_scaler = fast_scaler(format, dst_format, width, height);
            convert_or_scale(&src, &mut via, &mut via_scaler).unwrap();
            assert_active_eq(&via, &sws);
        }
    }

    #[test]
    fn even_uyvy_and_yuyv_match_reference_and_swscale() {
        ffmpeg::init().unwrap();
        let sizes = [
            (2u32, 2u32),
            (16, 2),
            (18, 4),
            (32, 8),
            (48, 6),
            (64, 48),
            (66, 40),
            (320, 180),
        ];
        for format in [Pixel::UYVY422, Pixel::YUYV422] {
            for (width, height) in sizes {
                check_even(format, width, height, Pixel::YUV420P);
            }
        }
    }

    #[test]
    fn even_nv12_matches_where_the_encoder_outputs_nv12() {
        ffmpeg::init().unwrap();
        for format in [Pixel::UYVY422, Pixel::YUYV422] {
            for (width, height) in [(16u32, 2u32), (18, 4), (64, 48), (66, 40)] {
                check_even(format, width, height, Pixel::NV12);
            }
        }
    }

    #[test]
    fn odd_sizes_fall_back_to_swscale() {
        ffmpeg::init().unwrap();
        let mut compared = 0u32;
        for format in [Pixel::UYVY422, Pixel::YUYV422] {
            for (width, height) in [
                (2u32, 1u32),
                (64, 63),
                (32, 15),
                (1, 2),
                (65, 64),
                (31, 17),
                (65, 63),
            ] {
                let mut src = frame::Video::new(format, width, height);
                fill_packed(&mut src);
                let mut probe = frame::Video::new(Pixel::YUV420P, width, height);
                assert!(
                    !try_convert(&src, &mut probe),
                    "{format:?} {width}x{height} should stay on swscale"
                );
                let Ok(mut via_scaler) = scaling::Context::get(
                    format,
                    width,
                    height,
                    Pixel::YUV420P,
                    width,
                    height,
                    Flags::FAST_BILINEAR,
                ) else {
                    continue;
                };
                let Ok(mut direct_scaler) = scaling::Context::get(
                    format,
                    width,
                    height,
                    Pixel::YUV420P,
                    width,
                    height,
                    Flags::FAST_BILINEAR,
                ) else {
                    continue;
                };
                let mut via = frame::Video::new(Pixel::YUV420P, width, height);
                let mut direct = frame::Video::new(Pixel::YUV420P, width, height);
                // av_frame_get_buffer does not clear memory, and swscale can
                // leave the odd-height chroma tail untouched.
                zero_frame(&mut via);
                zero_frame(&mut direct);
                convert_or_scale(&src, &mut via, &mut via_scaler).unwrap();
                direct_scaler.run(&src, &mut direct).unwrap();
                assert_active_eq(&via, &direct);
                compared += 1;
            }
        }
        assert!(compared > 0, "swscale rejected every odd size");
    }

    #[test]
    fn scaling_and_other_formats_stay_on_swscale() {
        ffmpeg::init().unwrap();
        let src = frame::Video::new(Pixel::UYVY422, 64, 48);
        let mut scaled = frame::Video::new(Pixel::YUV420P, 32, 24);
        assert!(!try_convert(&src, &mut scaled));
        let mut yuv422 = frame::Video::new(Pixel::YUV422P, 64, 48);
        assert!(!try_convert(&src, &mut yuv422));
        for format in [Pixel::BGRA, Pixel::YUV422P, Pixel::NV12, Pixel::RGB24] {
            let other = frame::Video::new(format, 32, 16);
            let mut yuv = frame::Video::new(Pixel::YUV420P, 32, 16);
            assert!(!try_convert(&other, &mut yuv), "{format:?}");
        }

        let mut packed = frame::Video::new(Pixel::YUYV422, 64, 48);
        fill_packed(&mut packed);
        let mut scaler = scaling::Context::get(
            Pixel::YUYV422,
            64,
            48,
            Pixel::YUV420P,
            32,
            24,
            Flags::BICUBIC,
        )
        .unwrap();
        let mut direct_scaler = scaling::Context::get(
            Pixel::YUYV422,
            64,
            48,
            Pixel::YUV420P,
            32,
            24,
            Flags::BICUBIC,
        )
        .unwrap();
        let mut via = frame::Video::new(Pixel::YUV420P, 32, 24);
        let mut direct = frame::Video::new(Pixel::YUV420P, 32, 24);
        convert_or_scale(&packed, &mut via, &mut scaler).unwrap();
        direct_scaler.run(&packed, &mut direct).unwrap();
        assert_active_eq(&via, &direct);
    }

    #[test]
    fn libx264_queue_accepts_packed_yuv() {
        ffmpeg::init().unwrap();
        queue_one(Pixel::UYVY422);
        encode_one(Pixel::YUYV422);
    }

    fn queue_one(format: Pixel) {
        if ffmpeg::codec::encoder::find_by_name("libx264").is_none() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("packed.mp4");
        let mut output = ffmpeg::format::output_as(&path, "mp4").unwrap();
        let info = cap_media_info::VideoInfo::from_raw_ffmpeg(format, 64, 48, 30);
        let mut encoder = super::super::h264::H264Encoder::builder(info)
            .with_preset(super::super::h264::H264Preset::Ultrafast)
            .with_crf(18)
            .with_encoder_priority_override(&["libx264"])
            .build(&mut output)
            .unwrap();
        let requirements = encoder.conversion_requirements();
        assert_eq!(requirements.output_format, Pixel::YUV420P);
        assert!(requirements.needs_conversion);
        let mut frame = frame::Video::new(format, 64, 48);
        fill_packed(&mut frame);
        let mut sink = crate::PacketQueue::new(ffmpeg::Rational(1, 90_000));
        encoder
            .queue_frame_to(frame, std::time::Duration::ZERO, &mut sink)
            .unwrap();
        encoder.flush_to(&mut sink).unwrap();
        assert!(!sink.take().is_empty());
    }

    fn encode_one(format: Pixel) {
        if ffmpeg::codec::encoder::find_by_name("libx264").is_none() {
            return;
        }
        let info = cap_media_info::VideoInfo::from_raw_ffmpeg(format, 64, 48, 30);
        let mut encoder = super::super::h264::H264Encoder::builder(info)
            .with_preset(super::super::h264::H264Preset::Ultrafast)
            .with_crf(18)
            .with_encoder_priority_override(&["libx264"])
            .build_standalone()
            .unwrap();
        assert_eq!(encoder.output_format(), Pixel::YUV420P);
        assert!(encoder.needs_conversion());
        let mut frame = frame::Video::new(format, 64, 48);
        fill_packed(&mut frame);
        let mut packets = Vec::new();
        encoder
            .encode_frame(frame, std::time::Duration::ZERO, |packet| {
                packets.push(packet.data);
                Ok(())
            })
            .unwrap();
        encoder
            .flush(|packet| {
                packets.push(packet.data);
                Ok(())
            })
            .unwrap();
        assert!(!packets.is_empty());
    }

    #[test]
    #[ignore = "release timing bench, run with --ignored --nocapture"]
    fn bench_packed_yuv_conversion() {
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
        println!("warmup 5 excluded; median is the middle of 31 sorted samples");
        for format in [Pixel::UYVY422, Pixel::YUYV422] {
            for (width, height) in [(1280u32, 720u32), (1920, 1080), (3840, 2160)] {
                bench_conversion(format, width, height);
            }
        }
    }

    fn bench_conversion(format: Pixel, width: u32, height: u32) {
        let mut src = frame::Video::new(format, width, height);
        fill_packed(&mut src);
        let mut kernel_dst = frame::Video::new(Pixel::YUV420P, width, height);
        let mut sws_dst = frame::Video::new(Pixel::YUV420P, width, height);
        let mut kernel_scaler = fast_scaler(format, Pixel::YUV420P, width, height);
        let mut sws_scaler = fast_scaler(format, Pixel::YUV420P, width, height);
        let sws = time_median(5, 31, || {
            sws_scaler.run(&src, &mut sws_dst).unwrap();
            let _ = std::hint::black_box(sws_dst.data(0));
            let _ = std::hint::black_box(sws_dst.data(1));
            let _ = std::hint::black_box(sws_dst.data(2));
        });
        let kernel = time_median(5, 31, || {
            convert_or_scale(&src, &mut kernel_dst, &mut kernel_scaler).unwrap();
            let _ = std::hint::black_box(kernel_dst.data(0));
            let _ = std::hint::black_box(kernel_dst.data(1));
            let _ = std::hint::black_box(kernel_dst.data(2));
        });
        println!(
            "{format:?} {width}x{height} swscale_fast_bilinear median {:.3} ms n=31",
            sws / 1_000_000.0
        );
        println!(
            "{format:?} {width}x{height} convert_or_scale median {:.3} ms n=31 speedup {:.2}x",
            kernel / 1_000_000.0,
            sws / kernel
        );
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
        samples[runs / 2] as f64
    }
}
