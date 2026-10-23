#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Packed422 {
    Uyvy,
    Yuyv,
}

pub(crate) struct Nv12Mut<'a> {
    pub y: &'a mut [u8],
    pub y_stride: usize,
    pub uv: &'a mut [u8],
    pub uv_stride: usize,
}

struct PackedView<'a> {
    kind: Packed422,
    src: &'a [u8],
    stride: usize,
    width: usize,
    height: usize,
}

pub(crate) fn convert_packed422_to_nv12(
    kind: Packed422,
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut Nv12Mut<'_>,
) -> bool {
    if width == 0 || height == 0 {
        return true;
    }
    let view = PackedView {
        kind,
        src,
        stride: src_stride,
        width,
        height,
    };
    if !buffers_fit(&view, dst) {
        return false;
    }
    if avx2_available() {
        unsafe {
            avx_convert(&view, dst);
        }
    } else {
        scalar_rows(&view, dst);
    }
    true
}

#[cfg(test)]
pub(crate) fn convert_packed422_scalar(
    kind: Packed422,
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut Nv12Mut<'_>,
) -> bool {
    if width == 0 || height == 0 {
        return true;
    }
    let view = PackedView {
        kind,
        src,
        stride: src_stride,
        width,
        height,
    };
    if !buffers_fit(&view, dst) {
        return false;
    }
    scalar_rows(&view, dst);
    true
}

fn avx2_available() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

fn chroma_row_bytes(width: usize) -> usize {
    width.div_ceil(2) * 2
}

fn buffers_fit(src: &PackedView<'_>, dst: &Nv12Mut<'_>) -> bool {
    let Some(packed) = src.width.checked_mul(2) else {
        return false;
    };
    let chroma = chroma_row_bytes(src.width);
    if src.stride < packed || dst.y_stride < src.width || dst.uv_stride < chroma {
        return false;
    }
    let Some(src_need) = src.stride.checked_mul(src.height) else {
        return false;
    };
    let Some(y_need) = dst.y_stride.checked_mul(src.height) else {
        return false;
    };
    let Some(uv_need) = dst.uv_stride.checked_mul(src.height.div_ceil(2)) else {
        return false;
    };
    src.src.len() >= src_need && dst.y.len() >= y_need && dst.uv.len() >= uv_need
}

fn scalar_rows(src: &PackedView<'_>, dst: &mut Nv12Mut<'_>) {
    let uv_rows = src.height.div_ceil(2);
    for row in 0..uv_rows {
        write_pixels(src, dst, row, 0);
    }
}

fn sample(row: &[u8], packed_len: usize, index: usize) -> u8 {
    if index < packed_len { row[index] } else { 128 }
}

fn avg_u8(a: u8, b: u8) -> u8 {
    ((u16::from(a) + u16::from(b) + 1) >> 1) as u8
}

// (y_left, y_right, u, v). A short last macropixel reads missing bytes as 128.
fn load_macro(kind: Packed422, row: &[u8], pair: usize, packed_len: usize) -> (u8, u8, u8, u8) {
    let off = pair * 4;
    match kind {
        Packed422::Uyvy => (
            sample(row, packed_len, off + 1),
            sample(row, packed_len, off + 3),
            sample(row, packed_len, off),
            sample(row, packed_len, off + 2),
        ),
        Packed422::Yuyv => (
            sample(row, packed_len, off),
            sample(row, packed_len, off + 2),
            sample(row, packed_len, off + 1),
            sample(row, packed_len, off + 3),
        ),
    }
}

fn write_pixels(src: &PackedView<'_>, dst: &mut Nv12Mut<'_>, row: usize, x_start: usize) {
    debug_assert!(x_start.is_multiple_of(2));
    let width = src.width;
    let height = src.height;
    let src_stride = src.stride;
    let y_stride = dst.y_stride;
    let uv_stride = dst.uv_stride;
    let top = row * 2;
    let bot = top + 1;
    let average = bot < height;
    let packed_len = width * 2;
    let src0 = top * src_stride;
    let src1 = bot * src_stride;
    let y0 = top * y_stride;
    let y1 = bot * y_stride;
    let uv_base = row * uv_stride;
    let mut x = x_start;
    while x < width {
        let pair = x / 2;
        let (left, right, u0, v0) = load_macro(
            src.kind,
            &src.src[src0..src0 + src_stride],
            pair,
            packed_len,
        );
        dst.y[y0 + x] = left;
        if x + 1 < width {
            dst.y[y0 + x + 1] = right;
        }
        let (u, v) = if average {
            let (left1, right1, u1, v1) = load_macro(
                src.kind,
                &src.src[src1..src1 + src_stride],
                pair,
                packed_len,
            );
            dst.y[y1 + x] = left1;
            if x + 1 < width {
                dst.y[y1 + x + 1] = right1;
            }
            (avg_u8(u0, u1), avg_u8(v0, v1))
        } else {
            (u0, v0)
        };
        let uv_at = uv_base + pair * 2;
        dst.uv[uv_at] = u;
        dst.uv[uv_at + 1] = v;
        x += 2;
    }
}

#[cfg(target_arch = "x86_64")]
struct RowPtrs {
    src0: *const u8,
    src1: *const u8,
    y0: *mut u8,
    y1: *mut u8,
    uv: *mut u8,
    average: bool,
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn avx_convert(src: &PackedView<'_>, dst: &mut Nv12Mut<'_>) {
    let masks = match src.kind {
        Packed422::Uyvy => Masks {
            y: unsafe { uyvy_y_mask() },
            u: unsafe { uyvy_u_mask() },
            v: unsafe { uyvy_v_mask() },
        },
        Packed422::Yuyv => Masks {
            y: unsafe { yuyv_y_mask() },
            u: unsafe { yuyv_u_mask() },
            v: unsafe { yuyv_v_mask() },
        },
    };
    let width = src.width;
    let height = src.height;
    let src_stride = src.stride;
    let y_stride = dst.y_stride;
    let uv_stride = dst.uv_stride;
    let uv_rows = height.div_ceil(2);
    for row in 0..uv_rows {
        let top = row * 2;
        let bot = top + 1;
        let average = bot < height;
        let src0 = src.src.as_ptr().wrapping_add(top * src_stride);
        let src1 = if average {
            src.src.as_ptr().wrapping_add(bot * src_stride)
        } else {
            std::ptr::null()
        };
        let y0 = dst.y.as_mut_ptr().wrapping_add(top * y_stride);
        let y1 = if average {
            dst.y.as_mut_ptr().wrapping_add(bot * y_stride)
        } else {
            std::ptr::null_mut()
        };
        let uv = dst.uv.as_mut_ptr().wrapping_add(row * uv_stride);
        let ptrs = RowPtrs {
            src0,
            src1,
            y0,
            y1,
            uv,
            average,
        };
        let mut x = 0usize;
        while x + 32 <= width {
            unsafe {
                convert16(&masks, &ptrs, x);
                convert16(&masks, &ptrs, x + 16);
            }
            x += 32;
        }
        while x + 16 <= width {
            unsafe {
                convert16(&masks, &ptrs, x);
            }
            x += 16;
        }
        if x < width {
            write_pixels(src, dst, row, x);
        }
    }
}

#[cfg(not(target_arch = "x86_64"))]
unsafe fn avx_convert(src: &PackedView<'_>, dst: &mut Nv12Mut<'_>) {
    scalar_rows(src, dst);
}

#[cfg(target_arch = "x86_64")]
struct Masks {
    y: std::arch::x86_64::__m256i,
    u: std::arch::x86_64::__m256i,
    v: std::arch::x86_64::__m256i,
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn convert16(masks: &Masks, row: &RowPtrs, x: usize) {
    use std::arch::x86_64::*;

    let packed0 = unsafe { _mm256_loadu_si256(row.src0.add(x * 2).cast()) };
    unsafe { store_luma(packed0, masks.y, row.y0.add(x)) };
    let u0 = unsafe { pack_chroma8(packed0, masks.u) };
    let v0 = unsafe { pack_chroma8(packed0, masks.v) };
    let (u, v) = if row.average {
        let packed1 = unsafe { _mm256_loadu_si256(row.src1.add(x * 2).cast()) };
        unsafe { store_luma(packed1, masks.y, row.y1.add(x)) };
        let u1 = unsafe { pack_chroma8(packed1, masks.u) };
        let v1 = unsafe { pack_chroma8(packed1, masks.v) };
        // avg_epu8 is (a + b + 1) >> 1 for each byte.
        (_mm_avg_epu8(u0, u1), _mm_avg_epu8(v0, v1))
    } else {
        (u0, v0)
    };
    let interleaved = _mm_unpacklo_epi8(u, v);
    unsafe { _mm_storeu_si128(row.uv.add(x).cast(), interleaved) };
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn store_luma(
    packed: std::arch::x86_64::__m256i,
    mask: std::arch::x86_64::__m256i,
    dst: *mut u8,
) {
    use std::arch::x86_64::*;
    let shuffled = _mm256_shuffle_epi8(packed, mask);
    let lo = _mm256_castsi256_si128(shuffled);
    let hi = _mm256_extracti128_si256(shuffled, 1);
    let y = _mm_unpacklo_epi64(lo, hi);
    unsafe { _mm_storeu_si128(dst.cast(), y) };
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn pack_chroma8(
    packed: std::arch::x86_64::__m256i,
    mask: std::arch::x86_64::__m256i,
) -> std::arch::x86_64::__m128i {
    use std::arch::x86_64::*;
    let shuffled = _mm256_shuffle_epi8(packed, mask);
    let lo = _mm256_castsi256_si128(shuffled);
    let hi = _mm256_extracti128_si256(shuffled, 1);
    _mm_unpacklo_epi32(lo, hi)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn uyvy_y_mask() -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;
    _mm256_setr_epi8(
        1, 3, 5, 7, 9, 11, 13, 15, -1, -1, -1, -1, -1, -1, -1, -1, 1, 3, 5, 7, 9, 11, 13, 15, -1,
        -1, -1, -1, -1, -1, -1, -1,
    )
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn uyvy_u_mask() -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;
    _mm256_setr_epi8(
        0, 4, 8, 12, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 4, 8, 12, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1,
    )
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn uyvy_v_mask() -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;
    _mm256_setr_epi8(
        2, 6, 10, 14, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, 6, 10, 14, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1,
    )
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn yuyv_y_mask() -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;
    _mm256_setr_epi8(
        0, 2, 4, 6, 8, 10, 12, 14, -1, -1, -1, -1, -1, -1, -1, -1, 0, 2, 4, 6, 8, 10, 12, 14, -1,
        -1, -1, -1, -1, -1, -1, -1,
    )
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn yuyv_u_mask() -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;
    _mm256_setr_epi8(
        1, 5, 9, 13, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 5, 9, 13, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1,
    )
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn yuyv_v_mask() -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;
    _mm256_setr_epi8(
        3, 7, 11, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3, 7, 11, 15, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fill(buf: &mut [u8], mut seed: u32) {
        for byte in buf.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *byte = (seed >> 24) as u8;
        }
    }

    fn ref_byte(row: &[u8], packed_len: usize, index: usize) -> u8 {
        if index < packed_len { row[index] } else { 128 }
    }

    fn ref_sample(kind: Packed422, row: &[u8], packed_len: usize, x: usize) -> (u8, u8, u8) {
        let off = (x / 2) * 4;
        let (y, u, v) = match kind {
            Packed422::Uyvy => {
                let y = if x.is_multiple_of(2) {
                    ref_byte(row, packed_len, off + 1)
                } else {
                    ref_byte(row, packed_len, off + 3)
                };
                (
                    y,
                    ref_byte(row, packed_len, off),
                    ref_byte(row, packed_len, off + 2),
                )
            }
            Packed422::Yuyv => {
                let y = if x.is_multiple_of(2) {
                    ref_byte(row, packed_len, off)
                } else {
                    ref_byte(row, packed_len, off + 2)
                };
                (
                    y,
                    ref_byte(row, packed_len, off + 1),
                    ref_byte(row, packed_len, off + 3),
                )
            }
        };
        (y, u, v)
    }

    fn reference(
        src: &PackedView<'_>,
        y: &mut [u8],
        y_stride: usize,
        uv: &mut [u8],
        uv_stride: usize,
    ) {
        let packed_len = src.width * 2;
        for row in 0..src.height {
            let src_row = &src.src[row * src.stride..row * src.stride + src.stride];
            for x in 0..src.width {
                let (sample_y, _, _) = ref_sample(src.kind, src_row, packed_len, x);
                y[row * y_stride + x] = sample_y;
            }
        }
        let chroma_pairs = src.width.div_ceil(2);
        for row in 0..src.height.div_ceil(2) {
            let top = row * 2;
            let src_top = &src.src[top * src.stride..top * src.stride + src.stride];
            let bot = top + 1;
            let src_bot = (bot < src.height)
                .then(|| &src.src[bot * src.stride..bot * src.stride + src.stride]);
            for pair in 0..chroma_pairs {
                let x = pair * 2;
                let (_, u0, v0) = ref_sample(src.kind, src_top, packed_len, x);
                let (u, v) = if let Some(src_bot) = src_bot {
                    let (_, u1, v1) = ref_sample(src.kind, src_bot, packed_len, x);
                    (
                        ((u16::from(u0) + u16::from(u1) + 1) >> 1) as u8,
                        ((u16::from(v0) + u16::from(v1) + 1) >> 1) as u8,
                    )
                } else {
                    (u0, v0)
                };
                uv[row * uv_stride + pair * 2] = u;
                uv[row * uv_stride + pair * 2 + 1] = v;
            }
        }
    }

    fn run_scalar(
        kind: Packed422,
        width: usize,
        height: usize,
        src_pad: usize,
        y_pad: usize,
        uv_pad: usize,
        seed: u32,
    ) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
        let src_stride = width * 2 + src_pad;
        let y_stride = width + y_pad;
        let uv_stride = chroma_row_bytes(width) + uv_pad;
        let mut src = vec![0u8; src_stride * height];
        fill(&mut src, seed);
        let mut y = vec![0x5Au8; y_stride * height];
        let mut uv = vec![0x5Au8; uv_stride * height.div_ceil(2)];
        let mut y_ref = y.clone();
        let mut uv_ref = uv.clone();
        let mut dst = Nv12Mut {
            y: &mut y,
            y_stride,
            uv: &mut uv,
            uv_stride,
        };
        let view = PackedView {
            kind,
            src: &src,
            stride: src_stride,
            width,
            height,
        };
        assert!(convert_rows_scalar(&view, &mut dst));
        reference(&view, &mut y_ref, y_stride, &mut uv_ref, uv_stride);
        (y, uv, y_ref, uv_ref)
    }

    fn convert_rows_scalar(src: &PackedView<'_>, dst: &mut Nv12Mut<'_>) -> bool {
        if !buffers_fit(src, dst) {
            return false;
        }
        scalar_rows(src, dst);
        true
    }

    fn case(
        kind: Packed422,
        width: usize,
        height: usize,
        src_pad: usize,
        y_pad: usize,
        uv_pad: usize,
    ) {
        let seed = (width as u32)
            .wrapping_mul(1000)
            .wrapping_add(height as u32 * 17)
            .wrapping_add(src_pad as u32 * 3)
            .wrapping_add(y_pad as u32 * 5)
            .wrapping_add(uv_pad as u32 * 9)
            .wrapping_add(match kind {
                Packed422::Uyvy => 1,
                Packed422::Yuyv => 2,
            });
        let (y, uv, y_ref, uv_ref) = run_scalar(kind, width, height, src_pad, y_pad, uv_pad, seed);
        assert_eq!(
            y, y_ref,
            "{kind:?} {width}x{height} y pad {src_pad}/{y_pad}/{uv_pad}"
        );
        assert_eq!(
            uv, uv_ref,
            "{kind:?} {width}x{height} uv pad {src_pad}/{y_pad}/{uv_pad}"
        );
    }

    #[test]
    fn scalar_matches_reference_across_shapes() {
        let widths = [
            1usize, 2, 3, 7, 8, 15, 16, 17, 31, 32, 33, 47, 63, 64, 65, 100, 127, 128,
        ];
        let heights = [1usize, 2, 3, 4, 5, 27];
        let src_pads = [0usize, 7, 32];
        let y_pads = [0usize, 13];
        let uv_pads = [0usize, 15];
        for kind in [Packed422::Uyvy, Packed422::Yuyv] {
            for &width in &widths {
                for &height in &heights {
                    for &src_pad in &src_pads {
                        for &y_pad in &y_pads {
                            for &uv_pad in &uv_pads {
                                case(kind, width, height, src_pad, y_pad, uv_pad);
                            }
                        }
                    }
                }
            }
            case(kind, 1920, 2, 16, 8, 24);
            case(kind, 1919, 3, 1, 0, 5);
            case(kind, 1280, 4, 0, 0, 0);
        }
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn avx2_matches_scalar_across_shapes() {
        if !is_x86_feature_detected!("avx2") {
            return;
        }
        let widths = [
            1usize, 2, 3, 7, 8, 15, 16, 17, 31, 32, 33, 47, 63, 64, 65, 100, 127, 128,
        ];
        let heights = [1usize, 2, 3, 5, 27];
        let src_pads = [0usize, 7, 32];
        let y_pads = [0usize, 13];
        let uv_pads = [0usize, 15];
        for kind in [Packed422::Uyvy, Packed422::Yuyv] {
            for &width in &widths {
                for &height in &heights {
                    for &src_pad in &src_pads {
                        for &y_pad in &y_pads {
                            for &uv_pad in &uv_pads {
                                compare_avx(kind, width, height, src_pad, y_pad, uv_pad);
                            }
                        }
                    }
                }
            }
            compare_avx(kind, 1920, 2, 16, 8, 24);
            compare_avx(kind, 1919, 3, 3, 1, 9);
            compare_avx(kind, 3840, 2, 0, 0, 0);
        }
    }

    #[cfg(target_arch = "x86_64")]
    fn compare_avx(
        kind: Packed422,
        width: usize,
        height: usize,
        src_pad: usize,
        y_pad: usize,
        uv_pad: usize,
    ) {
        let src_stride = width * 2 + src_pad;
        let y_stride = width + y_pad;
        let uv_stride = chroma_row_bytes(width) + uv_pad;
        let mut src = vec![0u8; src_stride * height];
        fill(&mut src, width as u32 * 13 + height as u32);
        let mut y_avx = vec![0x5Au8; y_stride * height];
        let mut uv_avx = vec![0x5Au8; uv_stride * height.div_ceil(2)];
        let mut y_scalar = y_avx.clone();
        let mut uv_scalar = uv_avx.clone();
        {
            let mut dst = Nv12Mut {
                y: &mut y_avx,
                y_stride,
                uv: &mut uv_avx,
                uv_stride,
            };
            assert!(convert_packed422_to_nv12(
                kind, &src, src_stride, width, height, &mut dst
            ));
        }
        {
            let mut dst = Nv12Mut {
                y: &mut y_scalar,
                y_stride,
                uv: &mut uv_scalar,
                uv_stride,
            };
            assert!(convert_rows_scalar(
                &PackedView {
                    kind,
                    src: &src,
                    stride: src_stride,
                    width,
                    height,
                },
                &mut dst
            ));
        }
        assert_eq!(y_avx, y_scalar, "{kind:?} {width}x{height} avx y");
        assert_eq!(uv_avx, uv_scalar, "{kind:?} {width}x{height} avx uv");
    }
}
