use super::VideoInfo;
use anyhow::{bail, ensure};
use ffmpeg::format::Pixel;
use ffmpeg::frame::Video;

// Instant capture stays in packed BGRZ so the camera bubble can blend before
// encode. This scaler never calls the encoder BT.709 kernel. Exact 2× is a
// 2×2 average and exact 4:3 (2560×1440 → 1920×1080) is an area box. Every
// other ratio, and any format conversion, stays on swscale bilinear.
pub(super) struct FrameScaler {
    source_format: Pixel,
    source_width: u32,
    source_height: u32,
    output_format: Pixel,
    output_width: u32,
    output_height: u32,
    kind: Kind,
    scratch: Vec<u16>,
}

enum Kind {
    Bilinear(ffmpeg::software::scaling::Context),
    Box2x,
    Area4to3,
}

impl FrameScaler {
    pub(super) fn new(
        source_format: Pixel,
        source_width: u32,
        source_height: u32,
        output: VideoInfo,
    ) -> anyhow::Result<Self> {
        let kind = if source_format == output.pixel_format
            && packed_4byte(source_format)
            && exact_downscale(
                source_width,
                source_height,
                output.width,
                output.height,
                2,
                1,
            ) {
            Kind::Box2x
        } else if source_format == output.pixel_format
            && packed_4byte(source_format)
            && exact_downscale(
                source_width,
                source_height,
                output.width,
                output.height,
                4,
                3,
            )
        {
            Kind::Area4to3
        } else {
            Kind::Bilinear(bilinear_context(
                source_format,
                source_width,
                source_height,
                output,
            )?)
        };
        let mut scratch = Vec::new();
        if matches!(kind, Kind::Area4to3) {
            let len = usize::try_from(output.width)
                .ok()
                .and_then(|width| width.checked_mul(16))
                .ok_or_else(|| anyhow::anyhow!("frame dimensions overflow"))?;
            scratch.resize(len, 0);
        }
        Ok(Self {
            source_format,
            source_width,
            source_height,
            output_format: output.pixel_format,
            output_width: output.width,
            output_height: output.height,
            kind,
            scratch,
        })
    }

    fn matches(&self, frame: &Video, output: VideoInfo) -> bool {
        self.source_format == frame.format()
            && self.source_width == frame.width()
            && self.source_height == frame.height()
            && self.output_format == output.pixel_format
            && self.output_width == output.width
            && self.output_height == output.height
    }

    pub(super) fn scale(&mut self, frame: &Video, output: VideoInfo) -> anyhow::Result<Video> {
        if frame.format() == output.pixel_format
            && frame.width() == output.width
            && frame.height() == output.height
        {
            return Ok(frame.clone());
        }
        if !self.matches(frame, output) {
            *self = Self::new(frame.format(), frame.width(), frame.height(), output)?;
        }
        match &mut self.kind {
            Kind::Bilinear(context) => {
                let mut scaled = Video::empty();
                context.run(frame, &mut scaled)?;
                scaled.set_pts(frame.pts());
                Ok(scaled)
            }
            Kind::Box2x => scale_box2x(frame, output),
            Kind::Area4to3 => scale_area43(frame, output, &mut self.scratch),
        }
    }
}

fn bilinear_context(
    source_format: Pixel,
    source_width: u32,
    source_height: u32,
    output: VideoInfo,
) -> anyhow::Result<ffmpeg::software::scaling::Context> {
    Ok(ffmpeg::software::scaling::Context::get(
        source_format,
        source_width,
        source_height,
        output.pixel_format,
        output.width,
        output.height,
        ffmpeg::software::scaling::Flags::BILINEAR,
    )?)
}

fn packed_4byte(format: Pixel) -> bool {
    matches!(
        format,
        Pixel::BGRA
            | Pixel::BGRZ
            | Pixel::RGBA
            | Pixel::RGBZ
            | Pixel::ABGR
            | Pixel::ZBGR
            | Pixel::ARGB
            | Pixel::ZRGB
    )
}

/// `src * dst_over == dst * src_over` on both axes. 2× is (2, 1). 4:3 is (4, 3).
fn exact_downscale(
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    src_over: u32,
    dst_over: u32,
) -> bool {
    dst_w > 0
        && dst_h > 0
        && u64::from(src_w) * u64::from(dst_over) == u64::from(dst_w) * u64::from(src_over)
        && u64::from(src_h) * u64::from(dst_over) == u64::from(dst_h) * u64::from(src_over)
}

fn scale_box2x(frame: &Video, output: VideoInfo) -> anyhow::Result<Video> {
    let dw = output.width as usize;
    let dh = output.height as usize;
    ensure!(
        frame.width() as usize == dw.saturating_mul(2)
            && frame.height() as usize == dh.saturating_mul(2),
        "2× box scale expected {}x{} from {}x{}",
        output.width,
        output.height,
        frame.width(),
        frame.height()
    );
    let mut scaled = Video::new(output.pixel_format, output.width, output.height);
    scaled.set_pts(frame.pts());
    let (src, src_stride) = plane(frame)?;
    let dst_stride = scaled.stride(0);
    let dst = scaled.data_mut(0);
    ensure!(
        covers(src_stride, dw * 8, dh * 2, src.len()) && covers(dst_stride, dw * 4, dh, dst.len()),
        "2× box scale frame is shorter than its stride"
    );
    box2x(src, src_stride, dst, dst_stride, dw, dh);
    Ok(scaled)
}

fn scale_area43(frame: &Video, output: VideoInfo, scratch: &mut Vec<u16>) -> anyhow::Result<Video> {
    let dw = output.width as usize;
    let dh = output.height as usize;
    ensure!(
        exact_downscale(
            frame.width(),
            frame.height(),
            output.width,
            output.height,
            4,
            3
        ),
        "4:3 area scale expected {}x{} from {}x{}",
        output.width,
        output.height,
        frame.width(),
        frame.height()
    );
    let band = dw
        .checked_mul(16)
        .ok_or_else(|| anyhow::anyhow!("frame dimensions overflow"))?;
    if scratch.len() < band {
        scratch.resize(band, 0);
    }
    let mut scaled = Video::new(output.pixel_format, output.width, output.height);
    scaled.set_pts(frame.pts());
    let (src, src_stride) = plane(frame)?;
    let dst_stride = scaled.stride(0);
    let dst = scaled.data_mut(0);
    ensure!(
        covers(
            src_stride,
            frame.width() as usize * 4,
            frame.height() as usize,
            src.len()
        ) && covers(dst_stride, dw * 4, dh, dst.len()),
        "4:3 area scale frame is shorter than its stride"
    );
    area_4to3(
        src,
        src_stride,
        dst,
        dst_stride,
        frame.width() as usize,
        frame.height() as usize,
        &mut scratch[..band],
    );
    Ok(scaled)
}

fn plane(frame: &Video) -> anyhow::Result<(&[u8], usize)> {
    let stride = frame.stride(0);
    let row = frame.width() as usize * 4;
    if stride < row {
        bail!(
            "packed frame stride {stride} is shorter than a {}px row",
            frame.width()
        );
    }
    Ok((frame.data(0), stride))
}

fn covers(stride: usize, row_bytes: usize, height: usize, len: usize) -> bool {
    if height == 0 || row_bytes == 0 {
        return true;
    }
    if stride < row_bytes {
        return false;
    }
    stride
        .checked_mul(height - 1)
        .and_then(|start| start.checked_add(row_bytes))
        .is_some_and(|need| need <= len)
}

fn box2x(src: &[u8], src_stride: usize, dst: &mut [u8], dst_stride: usize, dw: usize, dh: usize) {
    if dw == 0 || dh == 0 {
        return;
    }
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("avx2") {
        unsafe { box2x_avx2(src, src_stride, dst, dst_stride, dw, dh) }
        return;
    }
    box2x_scalar(src, src_stride, dst, dst_stride, dw, dh);
}

fn box2x_scalar(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    dw: usize,
    dh: usize,
) {
    for y in 0..dh {
        let r0 = y * 2 * src_stride;
        let r1 = r0 + src_stride;
        let out = y * dst_stride;
        box2x_pixels(&src[r0..], &src[r1..], &mut dst[out..], 0, dw);
    }
}

fn box2x_pixels(row0: &[u8], row1: &[u8], dst: &mut [u8], x0: usize, dw: usize) {
    for x in x0..dw {
        let s = x * 8;
        let d = x * 4;
        for c in 0..4 {
            let sum = u16::from(row0[s + c])
                + u16::from(row0[s + 4 + c])
                + u16::from(row1[s + c])
                + u16::from(row1[s + 4 + c]);
            dst[d + c] = ((sum + 2) / 4) as u8;
        }
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn box2x_avx2(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    dw: usize,
    dh: usize,
) {
    use std::arch::x86_64::*;

    unsafe {
        let even = _mm256_setr_epi8(
            0, 1, 2, 3, 8, 9, 10, 11, -1, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 8, 9, 10, 11, -1,
            -1, -1, -1, -1, -1, -1, -1,
        );
        let odd = _mm256_setr_epi8(
            4, 5, 6, 7, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, 4, 5, 6, 7, 12, 13, 14, 15,
            -1, -1, -1, -1, -1, -1, -1, -1,
        );
        let round = _mm256_set1_epi16(2);
        let zero = _mm256_setzero_si256();
        for y in 0..dh {
            let mut x = 0usize;
            while x + 4 <= dw {
                let s0 = _mm256_loadu_si256(src.as_ptr().add(y * 2 * src_stride + x * 8).cast());
                let s1 =
                    _mm256_loadu_si256(src.as_ptr().add((y * 2 + 1) * src_stride + x * 8).cast());
                let sum =
                    _mm256_add_epi16(pair_sum(s0, even, odd, zero), pair_sum(s1, even, odd, zero));
                let avg = _mm256_srli_epi16(_mm256_add_epi16(sum, round), 2);
                store4(dst.as_mut_ptr().add(y * dst_stride + x * 4), avg);
                x += 4;
            }
            if x < dw {
                let r0 = y * 2 * src_stride;
                box2x_pixels(
                    &src[r0..],
                    &src[r0 + src_stride..],
                    &mut dst[y * dst_stride..],
                    x,
                    dw,
                );
            }
        }
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn pair_sum(
    pixels: std::arch::x86_64::__m256i,
    even: std::arch::x86_64::__m256i,
    odd: std::arch::x86_64::__m256i,
    zero: std::arch::x86_64::__m256i,
) -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;

    let even = _mm256_unpacklo_epi8(_mm256_shuffle_epi8(pixels, even), zero);
    let odd = _mm256_unpacklo_epi8(_mm256_shuffle_epi8(pixels, odd), zero);
    _mm256_add_epi16(even, odd)
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn store4(out: *mut u8, avg: std::arch::x86_64::__m256i) {
    use std::arch::x86_64::*;

    unsafe {
        let packed = _mm256_packus_epi16(avg, _mm256_setzero_si256());
        let ordered = _mm256_permute4x64_epi64(packed, 0b00_00_10_00);
        _mm_storeu_si128(out.cast(), _mm256_castsi256_si128(ordered));
    }
}

fn area_4to3(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    src_w: usize,
    src_h: usize,
    scratch: &mut [u16],
) {
    let dw = src_w / 4 * 3;
    let dh = src_h / 4 * 3;
    if dw == 0 || dh == 0 {
        return;
    }
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("avx2") {
        unsafe { area_4to3_avx2(src, src_stride, dst, dst_stride, src_w, src_h, scratch) }
        return;
    }
    area_4to3_scalar(src, src_stride, dst, dst_stride, src_w, src_h, scratch);
}

fn area_4to3_scalar(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    src_w: usize,
    src_h: usize,
    scratch: &mut [u16],
) {
    let dw = src_w / 4 * 3;
    let dh = src_h / 4 * 3;
    let row_elems = dw * 4;
    for band in 0..dh / 3 {
        for row in 0..4 {
            let src_row = &src[(band * 4 + row) * src_stride..];
            let numerators = &mut scratch[row * row_elems..(row + 1) * row_elems];
            horizontal_scalar(src_row, src_w, numerators);
        }
        for phase in 0..3 {
            let (r0, r1, w0, w1) = phase_taps(phase);
            let y = band * 3 + phase;
            vertical_scalar(
                &scratch[r0 * row_elems..(r0 + 1) * row_elems],
                &scratch[r1 * row_elems..(r1 + 1) * row_elems],
                &mut dst[y * dst_stride..y * dst_stride + dw * 4],
                w0,
                w1,
            );
        }
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn area_4to3_avx2(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    src_w: usize,
    src_h: usize,
    scratch: &mut [u16],
) {
    let dw = src_w / 4 * 3;
    let dh = src_h / 4 * 3;
    let row_elems = dw * 4;
    for band in 0..dh / 3 {
        for row in 0..4 {
            let src_row = &src[(band * 4 + row) * src_stride..];
            let numerators = &mut scratch[row * row_elems..(row + 1) * row_elems];
            unsafe { horizontal_avx2(src_row, src_w, numerators) }
        }
        for phase in 0..3 {
            let (r0, r1, w0, w1) = phase_taps(phase);
            let y = band * 3 + phase;
            unsafe {
                vertical_avx2(
                    &scratch[r0 * row_elems..(r0 + 1) * row_elems],
                    &scratch[r1 * row_elems..(r1 + 1) * row_elems],
                    &mut dst[y * dst_stride..y * dst_stride + dw * 4],
                    w0,
                    w1,
                )
            }
        }
    }
}

/// Coverage of a 4:3 box repeats every 3 output pixels. The source weights,
/// as numerators that sum to 4, are [3, 1], [2, 2], [1, 3]. Vertical uses the
/// same weights, so a channel is `(weighted_sum + 8) / 16`.
fn phase_taps(phase: usize) -> (usize, usize, u16, u16) {
    match phase {
        0 => (0, 1, 3, 1),
        1 => (1, 2, 2, 2),
        _ => (2, 3, 1, 3),
    }
}

fn horizontal_scalar(src: &[u8], src_w: usize, dst: &mut [u16]) {
    let mut sx = 0usize;
    let mut dx = 0usize;
    while sx + 4 <= src_w {
        for c in 0..4 {
            let a = u16::from(src[sx * 4 + c]);
            let b = u16::from(src[(sx + 1) * 4 + c]);
            let cpx = u16::from(src[(sx + 2) * 4 + c]);
            let d = u16::from(src[(sx + 3) * 4 + c]);
            dst[dx + c] = 3 * a + b;
            dst[dx + 4 + c] = 2 * b + 2 * cpx;
            dst[dx + 8 + c] = cpx + 3 * d;
        }
        sx += 4;
        dx += 12;
    }
}

fn vertical_scalar(a: &[u16], b: &[u16], dst: &mut [u8], w0: u16, w1: u16) {
    for i in 0..a.len() {
        let sum = u32::from(a[i]) * u32::from(w0) + u32::from(b[i]) * u32::from(w1);
        dst[i] = ((sum + 8) / 16) as u8;
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn horizontal_avx2(src: &[u8], src_w: usize, dst: &mut [u16]) {
    use std::arch::x86_64::*;

    unsafe {
        let mut sx = 0usize;
        let mut dx = 0usize;
        while sx + 4 <= src_w {
            let pix = _mm_loadu_si128(src.as_ptr().add(sx * 4).cast());
            let lo = _mm_cvtepu8_epi16(pix);
            let hi = _mm_cvtepu8_epi16(_mm_srli_si128(pix, 8));
            let b = _mm_srli_si128(lo, 8);
            let d = _mm_srli_si128(hi, 8);
            let n0 = _mm_add_epi16(_mm_add_epi16(_mm_slli_epi16(lo, 1), lo), b);
            let n1 = _mm_slli_epi16(_mm_add_epi16(b, hi), 1);
            let three_d = _mm_add_epi16(_mm_slli_epi16(d, 1), d);
            let n2 = _mm_add_epi16(hi, three_d);
            _mm_storel_epi64(dst.as_mut_ptr().add(dx).cast(), n0);
            _mm_storel_epi64(dst.as_mut_ptr().add(dx + 4).cast(), n1);
            _mm_storel_epi64(dst.as_mut_ptr().add(dx + 8).cast(), n2);
            sx += 4;
            dx += 12;
        }
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn vertical_avx2(a: &[u16], b: &[u16], dst: &mut [u8], w0: u16, w1: u16) {
    use std::arch::x86_64::*;

    unsafe {
        let w0v = _mm256_set1_epi16(w0 as i16);
        let w1v = _mm256_set1_epi16(w1 as i16);
        let eight = _mm256_set1_epi16(8);
        let zero = _mm256_setzero_si256();
        let mut i = 0usize;
        while i + 16 <= a.len() {
            let va = _mm256_loadu_si256(a.as_ptr().add(i).cast());
            let vb = _mm256_loadu_si256(b.as_ptr().add(i).cast());
            let sum = _mm256_add_epi16(_mm256_mullo_epi16(va, w0v), _mm256_mullo_epi16(vb, w1v));
            let avg = _mm256_srli_epi16(_mm256_add_epi16(sum, eight), 4);
            let packed = _mm256_packus_epi16(avg, zero);
            let ordered = _mm256_permute4x64_epi64(packed, 0b00_00_10_00);
            _mm_storeu_si128(
                dst.as_mut_ptr().add(i).cast(),
                _mm256_castsi256_si128(ordered),
            );
            i += 16;
        }
        if i < a.len() {
            vertical_scalar(&a[i..], &b[i..], &mut dst[i..], w0, w1);
        }
    }
}

#[cfg(test)]
fn area_reference(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    src_w: usize,
    src_h: usize,
) {
    let dw = src_w * 3 / 4;
    let dh = src_h * 3 / 4;
    for y in 0..dh {
        let phase_y = y % 3;
        let sy = (y / 3) * 4 + [0, 1, 2][phase_y];
        let wy = [[3u16, 1], [2, 2], [1, 3]][phase_y];
        for x in 0..dw {
            let phase_x = x % 3;
            let sx = (x / 3) * 4 + [0, 1, 2][phase_x];
            let wx = [[3u16, 1], [2, 2], [1, 3]][phase_x];
            for c in 0..4 {
                let mut sum = 0u32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let pixel = u32::from(src[(sy + dy) * src_stride + (sx + dx) * 4 + c]);
                        sum += pixel * u32::from(wy[dy]) * u32::from(wx[dx]);
                    }
                }
                dst[y * dst_stride + x * 4 + c] = ((sum + 8) / 16) as u8;
            }
        }
    }
}

#[cfg(test)]
fn box2x_reference(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    dw: usize,
    dh: usize,
) {
    box2x_scalar(src, src_stride, dst, dst_stride, dw, dh);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn box2x_kernels_match_reference_and_ignore_row_padding() {
        // Width 10 → 5 leaves a 1-pixel AVX tail. Stride padding is 0xFF here
        // and 0x00 on the tight buffer; both have to produce the same pixels.
        assert_box2x(10, 6, 47);
        assert_box2x(8, 4, 32);
        assert_box2x(160, 90, 160 * 4 + 16);
    }

    #[test]
    fn area43_kernels_match_the_2d_box_and_ignore_row_padding() {
        assert_area43(8, 8, 40);
        assert_area43(20, 16, 20 * 4 + 7);
        assert_area43(160, 120, 160 * 4 + 13);
    }

    #[test]
    fn exact_2x_bgrz_keeps_format_pts_and_matches_the_average() {
        ffmpeg::init().expect("FFmpeg initializes");
        let frame = painted(Pixel::BGRZ, 32, 18, Some(41), |x, y| {
            [(x * 3) as u8, (y * 5) as u8, (x + y) as u8, 0]
        });
        let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 16, 9, 60);
        let scaled = scale_twice(&frame, output);
        assert_eq!(scaled.format(), Pixel::BGRZ);
        assert_eq!((scaled.width(), scaled.height()), (16, 9));
        assert_eq!(scaled.pts(), Some(41));
        assert_eq!(
            active(&scaled),
            reference_box2x_frame(&frame),
            "2× FrameScaler drifted from the 2×2 average"
        );
    }

    #[test]
    fn exact_4to3_bgrz_keeps_format_pts_and_matches_the_area_box() {
        ffmpeg::init().expect("FFmpeg initializes");
        let frame = painted(Pixel::BGRZ, 32, 24, Some(7), |x, y| {
            [(x * 13 + y) as u8, (y * 9) as u8, (x ^ y) as u8, 0]
        });
        let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 24, 18, 60);
        let scaled = scale_twice(&frame, output);
        assert_eq!(scaled.format(), Pixel::BGRZ);
        assert_eq!((scaled.width(), scaled.height()), (24, 18));
        assert_eq!(scaled.pts(), Some(7));
        assert_eq!(active(&scaled), reference_area_frame(&frame));
    }

    #[test]
    fn checkerboard_2x_is_the_rounded_average_and_not_bilinear() {
        ffmpeg::init().expect("FFmpeg initializes");
        let frame = painted(Pixel::BGRZ, 16, 12, None, |x, y| {
            let on = u8::from((x + y) % 2 == 0).wrapping_mul(255);
            [on, on, on, 0]
        });
        let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 8, 6, 60);
        let scaled = scale_twice(&frame, output);
        let pixels = active(&scaled);
        assert!(
            pixels
                .chunks_exact(4)
                .all(|pixel| pixel == [128, 128, 128, 0]),
            "2×2 average of a checkerboard is 128, got {pixels:?}"
        );
        let bilinear = bilinear(&frame, output);
        assert_ne!(
            pixels,
            active(&bilinear),
            "checkerboard 2× matched bilinear, so the box path did not run"
        );
        let delta = bgr_delta(&scaled, &bilinear);
        assert!(
            delta.max > 0,
            "checkerboard BGR delta vs bilinear was empty"
        );
    }

    #[test]
    fn non_matching_ratio_matches_bilinear_bytes() {
        ffmpeg::init().expect("FFmpeg initializes");
        let frame = painted(Pixel::BGRZ, 18, 12, Some(3), |x, y| {
            [(x * 19) as u8, (y * 17) as u8, ((x + y) % 2) as u8 * 255, 0]
        });
        let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 12, 8, 60);
        let scaled = scale_twice(&frame, output);
        assert_eq!(scaled.format(), Pixel::BGRZ);
        assert_eq!(scaled.pts(), Some(3));
        assert_eq!(active(&scaled), active(&bilinear(&frame, output)));
    }

    #[test]
    fn format_conversion_at_an_exact_2x_ratio_stays_on_bilinear() {
        ffmpeg::init().expect("FFmpeg initializes");
        let frame = painted(Pixel::RGBZ, 16, 12, Some(11), |x, y| {
            [x as u8, y as u8, 40, 0]
        });
        let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 8, 6, 60);
        let scaled = scale_twice(&frame, output);
        assert_eq!(scaled.format(), Pixel::BGRZ);
        assert_eq!((scaled.width(), scaled.height()), (8, 6));
        assert_eq!(active(&scaled), active(&bilinear(&frame, output)));
    }

    #[test]
    fn constant_bgrz_field_matches_bilinear() {
        ffmpeg::init().expect("FFmpeg initializes");
        for (src_w, src_h, dst_w, dst_h) in [(16u32, 12, 8, 6), (16, 12, 12, 9)] {
            let frame = painted(Pixel::BGRZ, src_w, src_h, None, |_, _| [40, 80, 120, 0]);
            let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, dst_w, dst_h, 60);
            let scaled = scale_twice(&frame, output);
            assert_eq!(
                active(&scaled),
                active(&bilinear(&frame, output)),
                "{src_w}x{src_h}->{dst_w}x{dst_h} constant field diverged from bilinear"
            );
        }
    }

    #[test]
    fn ramp_bgr_delta_against_bilinear_stays_within_a_few_levels() {
        ffmpeg::init().expect("FFmpeg initializes");
        let cases = [(64u32, 36, 32, 18, "2x"), (64, 48, 48, 36, "4:3")];
        for (src_w, src_h, dst_w, dst_h, label) in cases {
            let (w, h) = (src_w as usize, src_h as usize);
            let frame = painted(Pixel::BGRZ, src_w, src_h, None, |x, y| {
                [
                    (x * 255 / w.max(1)) as u8,
                    (y * 255 / h.max(1)) as u8,
                    ((x + y) % 256) as u8,
                    0,
                ]
            });
            let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, dst_w, dst_h, 60);
            let scaled = scale_twice(&frame, output);
            let delta = bgr_delta(&scaled, &bilinear(&frame, output));
            assert!(
                delta.max <= 16,
                "{label} ramp BGR delta vs bilinear max {} mean {:.3} over {} samples",
                delta.max,
                delta.mean,
                delta.count
            );
        }
    }

    #[test]
    fn scaler_follows_a_new_output_ratio() {
        ffmpeg::init().expect("FFmpeg initializes");
        let source = painted(Pixel::BGRZ, 16, 12, Some(5), |x, y| {
            [(x * 8) as u8, (y * 8) as u8, 200, 0]
        });
        let fast = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 8, 6, 60);
        let other = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 10, 8, 30);
        let mut scaler = FrameScaler::new(source.format(), source.width(), source.height(), fast)
            .expect("scaler");
        let averaged = scaler.scale(&source, fast).unwrap();
        assert_eq!(active(&averaged), reference_box2x_frame(&source));
        let bilinear_out = scaler.scale(&source, other).unwrap();
        assert_eq!(bilinear_out.pts(), Some(5));
        assert_eq!(active(&bilinear_out), active(&bilinear(&source, other)));

        let next = painted(Pixel::BGRZ, 16, 16, Some(9), |x, y| {
            [(x + y) as u8, 10, 20, 0]
        });
        let area = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, 12, 12, 60);
        let boxed = scaler.scale(&next, area).unwrap();
        assert_eq!(boxed.pts(), Some(9));
        assert_eq!(active(&boxed), reference_area_frame(&next));
    }

    #[test]
    #[ignore = "release timing; cargo test -p cap-recording --release --lib frame_scaler -- --ignored --nocapture"]
    fn bench_box_downscale_against_bilinear() {
        ffmpeg::init().expect("FFmpeg initializes");
        let runs = 11;
        for (src_w, src_h, dst_w, dst_h, label) in [
            (3840u32, 2160, 1920, 1080, "2x"),
            (2560, 1440, 1920, 1080, "4:3"),
            (1920, 1080, 1280, 720, "bilinear"),
        ] {
            let frame = painted(Pixel::BGRZ, src_w, src_h, None, |x, y| {
                [
                    (x * 13 + y * 7) as u8,
                    (x * 3 + y) as u8,
                    (x.wrapping_mul(17) ^ y.wrapping_mul(29)) as u8,
                    0,
                ]
            });
            let (w, h) = (src_w as usize, src_h as usize);
            let ramp = painted(Pixel::BGRZ, src_w, src_h, None, |x, y| {
                [
                    (x * 255 / w.max(1)) as u8,
                    (y * 255 / h.max(1)) as u8,
                    ((x + y) % 256) as u8,
                    0,
                ]
            });
            let output = VideoInfo::from_raw_ffmpeg(Pixel::BGRZ, dst_w, dst_h, 60);
            let mut scaler =
                FrameScaler::new(frame.format(), frame.width(), frame.height(), output).unwrap();
            let box_times = time_runs(runs, || {
                let scaled = scaler.scale(&frame, output).unwrap();
                std::hint::black_box(scaled.data(0)[scaled.stride(0)]);
            });
            let bilinear_times = time_bilinear(&frame, output, runs);
            let scaled = scaler.scale(&frame, output).unwrap();
            let sw = bilinear(&frame, output);
            let noise = bgr_delta(&scaled, &sw);
            let ramp_scaled = scaler.scale(&ramp, output).unwrap();
            let ramp_sw = bilinear(&ramp, output);
            let smooth = bgr_delta(&ramp_scaled, &ramp_sw);
            println!(
                "{src_w}x{src_h} -> {dst_w}x{dst_h} {label:<10} scaler median {:6.2} ms (min {:6.2})  bilinear median {:6.2} ms (min {:6.2})  noise BGR max {} mean {:.3} changed {}/{}  ramp BGR max {} mean {:.3} changed {}/{}",
                median(&box_times),
                min_ms(&box_times),
                median(&bilinear_times),
                min_ms(&bilinear_times),
                noise.max,
                noise.mean,
                noise.changed,
                noise.count,
                smooth.max,
                smooth.mean,
                smooth.changed,
                smooth.count,
            );
        }
    }

    fn assert_box2x(src_w: usize, src_h: usize, stride: usize) {
        let (padded, tight) = paired_source(src_w, src_h, stride);
        let dw = src_w / 2;
        let dh = src_h / 2;
        let dst_stride = dw * 4 + 9;
        let mut scalar = vec![0x11u8; dst_stride * dh];
        let mut simd = vec![0x11u8; dst_stride * dh];
        let mut reference = vec![0u8; dw * dh * 4];
        let mut tight_out = vec![0u8; dw * dh * 4];
        box2x_scalar(&padded, stride, &mut scalar, dst_stride, dw, dh);
        box2x(&padded, stride, &mut simd, dst_stride, dw, dh);
        box2x_reference(&padded, stride, &mut reference, dw * 4, dw, dh);
        box2x(&tight, src_w * 4, &mut tight_out, dw * 4, dw, dh);
        assert_eq!(
            active_buf(&scalar, dst_stride, dw, dh),
            reference,
            "scalar 2× {src_w}x{src_h}"
        );
        assert_eq!(
            active_buf(&simd, dst_stride, dw, dh),
            reference,
            "dispatched 2× {src_w}x{src_h}"
        );
        assert_eq!(
            tight_out, reference,
            "padding leaked into 2× {src_w}x{src_h}"
        );
        assert!(padding_untouched(&scalar, dst_stride, dw * 4, dh, 0x11));
        assert!(padding_untouched(&simd, dst_stride, dw * 4, dh, 0x11));
    }

    fn assert_area43(src_w: usize, src_h: usize, stride: usize) {
        let (padded, tight) = paired_source(src_w, src_h, stride);
        let dw = src_w / 4 * 3;
        let dh = src_h / 4 * 3;
        let dst_stride = dw * 4 + 5;
        let mut scratch = vec![0u16; dw * 16];
        let mut scalar = vec![0x11u8; dst_stride * dh];
        let mut simd = vec![0x11u8; dst_stride * dh];
        let mut reference = vec![0u8; dw * dh * 4];
        let mut tight_out = vec![0u8; dw * dh * 4];
        area_4to3_scalar(
            &padded,
            stride,
            &mut scalar,
            dst_stride,
            src_w,
            src_h,
            &mut scratch,
        );
        area_4to3(
            &padded,
            stride,
            &mut simd,
            dst_stride,
            src_w,
            src_h,
            &mut scratch,
        );
        area_reference(&padded, stride, &mut reference, dw * 4, src_w, src_h);
        let mut scratch_tight = vec![0u16; dw * 16];
        area_4to3(
            &tight,
            src_w * 4,
            &mut tight_out,
            dw * 4,
            src_w,
            src_h,
            &mut scratch_tight,
        );
        assert_eq!(
            active_buf(&scalar, dst_stride, dw, dh),
            reference,
            "scalar 4:3 {src_w}x{src_h}"
        );
        assert_eq!(
            active_buf(&simd, dst_stride, dw, dh),
            reference,
            "dispatched 4:3 {src_w}x{src_h}"
        );
        assert_eq!(
            tight_out, reference,
            "padding leaked into 4:3 {src_w}x{src_h}"
        );
        assert!(padding_untouched(&scalar, dst_stride, dw * 4, dh, 0x11));
        assert!(padding_untouched(&simd, dst_stride, dw * 4, dh, 0x11));
    }

    fn paired_source(width: usize, height: usize, stride: usize) -> (Vec<u8>, Vec<u8>) {
        assert!(stride >= width * 4);
        let mut state = 0x1234_5678u32;
        let mut next = || {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            (state >> 24) as u8
        };
        let mut padded = vec![0xFFu8; stride * height];
        let mut tight = vec![0u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let pixel = [next(), next(), next(), next()];
                padded[y * stride + x * 4..y * stride + x * 4 + 4].copy_from_slice(&pixel);
                tight[(y * width + x) * 4..(y * width + x) * 4 + 4].copy_from_slice(&pixel);
            }
        }
        (padded, tight)
    }

    fn padding_untouched(buf: &[u8], stride: usize, row: usize, height: usize, fill: u8) -> bool {
        (0..height).all(|y| {
            buf[y * stride + row..y * stride + stride]
                .iter()
                .all(|byte| *byte == fill)
        })
    }

    fn active_buf(buf: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            out.extend_from_slice(&buf[y * stride..y * stride + width * 4]);
        }
        out
    }

    fn painted(
        format: Pixel,
        width: u32,
        height: u32,
        pts: Option<i64>,
        pixel: impl Fn(usize, usize) -> [u8; 4],
    ) -> Video {
        let mut frame = Video::new(format, width, height);
        frame.set_pts(pts);
        let stride = frame.stride(0);
        let data = frame.data_mut(0);
        for y in 0..height as usize {
            for x in 0..width as usize {
                let i = y * stride + x * 4;
                data[i..i + 4].copy_from_slice(&pixel(x, y));
            }
        }
        frame
    }

    fn scale_twice(frame: &Video, output: VideoInfo) -> Video {
        let mut scaler = FrameScaler::new(frame.format(), frame.width(), frame.height(), output)
            .expect("scaler");
        let first = scaler.scale(frame, output).expect("scale");
        let second = scaler.scale(frame, output).expect("scale again");
        assert_eq!(
            active(&first),
            active(&second),
            "reused scaler changed pixels"
        );
        second
    }

    fn bilinear(frame: &Video, output: VideoInfo) -> Video {
        let mut context = bilinear_context(frame.format(), frame.width(), frame.height(), output)
            .expect("bilinear context");
        let mut scaled = Video::empty();
        context.run(frame, &mut scaled).expect("bilinear scale");
        scaled.set_pts(frame.pts());
        scaled
    }

    fn active(frame: &Video) -> Vec<u8> {
        active_buf(
            frame.data(0),
            frame.stride(0),
            frame.width() as usize,
            frame.height() as usize,
        )
    }

    fn reference_box2x_frame(frame: &Video) -> Vec<u8> {
        let dw = frame.width() as usize / 2;
        let dh = frame.height() as usize / 2;
        let mut dst = vec![0u8; dw * dh * 4];
        box2x_reference(frame.data(0), frame.stride(0), &mut dst, dw * 4, dw, dh);
        dst
    }

    fn reference_area_frame(frame: &Video) -> Vec<u8> {
        let dw = frame.width() as usize / 4 * 3;
        let dh = frame.height() as usize / 4 * 3;
        let mut dst = vec![0u8; dw * dh * 4];
        area_reference(
            frame.data(0),
            frame.stride(0),
            &mut dst,
            dw * 4,
            frame.width() as usize,
            frame.height() as usize,
        );
        dst
    }

    struct Delta {
        max: u8,
        mean: f64,
        changed: usize,
        count: usize,
    }

    fn bgr_delta(left: &Video, right: &Video) -> Delta {
        let a = active(left);
        let b = active(right);
        assert_eq!(a.len(), b.len());
        let mut max = 0u8;
        let mut sum = 0u64;
        let mut changed = 0usize;
        let mut count = 0usize;
        for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
            for c in 0..3 {
                let diff = pa[c].abs_diff(pb[c]);
                max = max.max(diff);
                sum += u64::from(diff);
                changed += usize::from(diff != 0);
                count += 1;
            }
        }
        Delta {
            max,
            mean: if count == 0 {
                0.0
            } else {
                sum as f64 / count as f64
            },
            changed,
            count,
        }
    }

    fn time_runs(runs: usize, mut body: impl FnMut()) -> Vec<f64> {
        for _ in 0..3 {
            body();
        }
        let mut times = Vec::with_capacity(runs);
        for _ in 0..runs {
            let started = Instant::now();
            body();
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        times
    }

    fn time_bilinear(frame: &Video, output: VideoInfo, runs: usize) -> Vec<f64> {
        let mut context = bilinear_context(frame.format(), frame.width(), frame.height(), output)
            .expect("bilinear context");
        time_runs(runs, || {
            let mut scaled = Video::empty();
            context.run(frame, &mut scaled).expect("bilinear scale");
            std::hint::black_box(scaled.data(0).first().copied());
        })
    }

    fn median(times: &[f64]) -> f64 {
        let mut sorted = times.to_vec();
        sorted.sort_by(f64::total_cmp);
        sorted[sorted.len() / 2]
    }

    fn min_ms(times: &[f64]) -> f64 {
        times.iter().copied().fold(f64::INFINITY, f64::min)
    }
}
