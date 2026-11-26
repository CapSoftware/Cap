#![allow(dead_code)]

use std::sync::{Arc, Mutex, PoisonError};

use ffmpeg::{format, frame, software};

use crate::cpu_yuv::YuvMatrix;

/// Spare packed YUV and RGBA planes for one software decoder.
///
/// A seek drops the whole cache at once; the cap keeps that from retaining
/// every frame's buffer.
pub(crate) struct PlanePool {
    spare: Mutex<Vec<Vec<u8>>>,
}

const MAX_SPARE_PACKED_PLANES: usize = 2;
const MAX_SPARE_PLANE_BYTES: usize = super::FULL_CHROMA_MAX_PIXELS * 4;

impl PlanePool {
    pub(crate) fn new() -> Self {
        Self {
            spare: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn take(&self, min_capacity: usize) -> Vec<u8> {
        if min_capacity == 0 {
            return Vec::new();
        }
        let mut spare = self.spare.lock().unwrap_or_else(PoisonError::into_inner);
        let index = spare
            .iter()
            .enumerate()
            .filter(|(_, buf)| buf.capacity() >= min_capacity)
            .min_by_key(|(_, buf)| buf.capacity())
            .map(|(index, _)| index);
        if let Some(index) = index {
            let mut buf = spare.swap_remove(index);
            buf.clear();
            buf
        } else {
            drop(spare);
            Vec::with_capacity(min_capacity)
        }
    }

    pub(crate) fn recycle(&self, mut buf: Vec<u8>) {
        if buf.capacity() == 0 || buf.capacity() > MAX_SPARE_PLANE_BYTES {
            return;
        }
        buf.clear();
        let mut spare = self.spare.lock().unwrap_or_else(PoisonError::into_inner);
        if spare.len() < MAX_SPARE_PACKED_PLANES {
            spare.push(buf);
            return;
        }
        let Some(index) = spare
            .iter()
            .enumerate()
            .min_by_key(|(_, existing)| existing.capacity())
            .map(|(index, _)| index)
        else {
            return;
        };
        if spare[index].capacity() < buf.capacity() {
            spare.swap_remove(index);
            spare.push(buf);
        }
    }

    #[cfg(test)]
    pub(crate) fn spare_count(&self) -> usize {
        self.spare
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

pub struct FrameConverter {
    scaler: Option<ScalerState>,
    rgba_frame: frame::Video,
    planes: Arc<PlanePool>,
}

struct ScalerState {
    context: software::scaling::Context,
    input_format: format::Pixel,
    matrix: YuvMatrix,
    width: u32,
    height: u32,
}

impl FrameConverter {
    pub fn new() -> Self {
        Self {
            scaler: None,
            rgba_frame: frame::Video::empty(),
            planes: Arc::new(PlanePool::new()),
        }
    }

    pub(crate) fn plane_pool(&self) -> &Arc<PlanePool> {
        &self.planes
    }

    pub fn convert(&mut self, frame: &mut frame::Video) -> Vec<u8> {
        if frame.format() == format::Pixel::RGBA {
            let width = frame.width() as usize;
            let height = frame.height() as usize;
            let stride = frame.stride(0);

            return copy_rgba_plane_pooled(&self.planes, frame.data(0), stride, width, height);
        }

        // swscale's exact 4:4:4 path took more time than decoding the frame.
        if frame.format() == format::Pixel::YUV444P
            && frame.color_range() != ffmpeg::color::Range::JPEG
            && within_full_chroma_limit(frame.width(), frame.height())
        {
            let (width, height) = (frame.width() as usize, frame.height() as usize);
            let mut output = self.planes.take(width * height * 4);
            output.resize(width * height * 4, 0);
            crate::cpu_yuv::yuv444p_to_rgba_with_matrix(
                [0, 1, 2].map(|plane| (frame.data(plane), frame.stride(plane))),
                width,
                height,
                &mut output,
                YuvMatrix::from_color_space(frame.color_space()),
            );
            return output;
        }

        let width = frame.width();
        let height = frame.height();

        self.ensure_scaler(
            frame.format(),
            YuvMatrix::from_color_space(frame.color_space()),
            width,
            height,
        );
        self.ensure_rgba_frame(width, height);

        {
            let rgba_frame = &mut self.rgba_frame;
            self.scaler
                .as_mut()
                .expect("scaler must be initialised")
                .context
                .run(frame, rgba_frame)
                .expect("frame conversion should succeed");
        }

        let rgba_frame = &self.rgba_frame;
        copy_rgba_plane_pooled(
            &self.planes,
            rgba_frame.data(0),
            rgba_frame.stride(0),
            rgba_frame.width() as usize,
            rgba_frame.height() as usize,
        )
    }

    fn ensure_scaler(
        &mut self,
        input_format: format::Pixel,
        matrix: YuvMatrix,
        width: u32,
        height: u32,
    ) {
        let needs_new = self.scaler.as_ref().is_none_or(|state| {
            state.input_format != input_format
                || state.matrix != matrix
                || state.width != width
                || state.height != height
        });

        if needs_new {
            // FAST_BILINEAR makes swscale skip work on chroma it treats as
            // subsampled, which blurs and shifts full-resolution chroma
            // (a 4:4:4 import drops from 53.9 to 35.8 dB against its source).
            // BILINEAR converts it exactly; other layouts, and frames above
            // the full-chroma limit, keep the flags they always had.
            let flags = scaler_flags(input_format, width, height);
            let mut context = software::scaling::Context::get(
                input_format,
                width,
                height,
                format::Pixel::RGBA,
                width,
                height,
                flags,
            )
            .expect("failed to create frame scaler");
            if matrix == YuvMatrix::Bt709 {
                use_bt709_source(&mut context);
            }
            self.scaler = Some(ScalerState {
                context,
                input_format,
                matrix,
                width,
                height,
            });
            self.ensure_rgba_frame(width, height);
        }
    }

    fn ensure_rgba_frame(&mut self, width: u32, height: u32) {
        if self.rgba_frame.width() != width || self.rgba_frame.height() != height {
            self.rgba_frame = frame::Video::new(format::Pixel::RGBA, width, height);
        }
    }
}

fn within_full_chroma_limit(width: u32, height: u32) -> bool {
    width as usize * height as usize <= super::FULL_CHROMA_MAX_PIXELS
}

fn scaler_flags(input_format: format::Pixel, width: u32, height: u32) -> software::scaling::Flags {
    if format_has_full_chroma(input_format) && within_full_chroma_limit(width, height) {
        software::scaling::Flags::BILINEAR
    } else {
        software::scaling::Flags::FAST_BILINEAR
    }
}

fn format_has_full_chroma(input_format: format::Pixel) -> bool {
    input_format.descriptor().is_some_and(|descriptor| {
        descriptor.nb_components() >= 3
            && descriptor.log2_chroma_w() == 0
            && descriptor.log2_chroma_h() == 0
            && !is_rgb(input_format)
    })
}

fn is_rgb(input_format: format::Pixel) -> bool {
    input_format.descriptor().is_some_and(|descriptor| unsafe {
        (*descriptor.as_ptr()).flags & ffmpeg::ffi::AV_PIX_FMT_FLAG_RGB as u64 != 0
    })
}

/// swscale converts YUV with BT.601 unless told otherwise: switch the source
/// matrix to BT.709 and keep the ranges and adjustments it chose.
fn use_bt709_source(context: &mut software::scaling::Context) {
    unsafe {
        let mut inv_table = std::ptr::null_mut();
        let mut table = std::ptr::null_mut();
        let (mut src_range, mut dst_range) = (0, 0);
        let (mut brightness, mut contrast, mut saturation) = (0, 0, 0);
        if ffmpeg::ffi::sws_getColorspaceDetails(
            context.as_mut_ptr(),
            &mut inv_table,
            &mut src_range,
            &mut table,
            &mut dst_range,
            &mut brightness,
            &mut contrast,
            &mut saturation,
        ) < 0
        {
            return;
        }
        let bt709 = ffmpeg::ffi::sws_getCoefficients(ffmpeg::ffi::SWS_CS_ITU709);
        ffmpeg::ffi::sws_setColorspaceDetails(
            context.as_mut_ptr(),
            bt709,
            src_range,
            table,
            dst_range,
            brightness,
            contrast,
            saturation,
        );
    }
}

pub fn copy_rgba_plane(data: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
    let mut frame_buffer = Vec::with_capacity(width * 4 * height);
    fill_rgba_plane(&mut frame_buffer, data, stride, width, height);
    frame_buffer
}

fn copy_rgba_plane_pooled(
    pool: &PlanePool,
    data: &[u8],
    stride: usize,
    width: usize,
    height: usize,
) -> Vec<u8> {
    let mut frame_buffer = pool.take(width * 4 * height);
    fill_rgba_plane(&mut frame_buffer, data, stride, width, height);
    frame_buffer
}

fn fill_rgba_plane(
    frame_buffer: &mut Vec<u8>,
    data: &[u8],
    stride: usize,
    width: usize,
    height: usize,
) {
    debug_assert!(stride >= width * 4, "stride too small for RGBA frame");

    let row_len = width * 4;
    let total = row_len * height;
    frame_buffer.clear();

    if stride == row_len && data.len() >= total {
        frame_buffer.extend_from_slice(&data[..total]);
        return;
    }

    for row in data.chunks(stride).take(height) {
        frame_buffer.extend_from_slice(&row[..row_len]);
    }
}

#[cfg(target_os = "macos")]
pub fn copy_bgra_to_rgba(data: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
    debug_assert!(stride >= width * 4, "stride too small for BGRA frame");

    let row_len = width * 4;
    let total = row_len * height;
    let mut frame_buffer = vec![0u8; total];

    let mut dst_offset = 0;
    for row in data.chunks(stride).take(height) {
        let src = &row[..row_len];
        let dst = &mut frame_buffer[dst_offset..dst_offset + row_len];

        for (d, s) in dst.chunks_exact_mut(32).zip(src.chunks_exact(32)) {
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
            d[3] = s[3];
            d[4] = s[6];
            d[5] = s[5];
            d[6] = s[4];
            d[7] = s[7];
            d[8] = s[10];
            d[9] = s[9];
            d[10] = s[8];
            d[11] = s[11];
            d[12] = s[14];
            d[13] = s[13];
            d[14] = s[12];
            d[15] = s[15];
            d[16] = s[18];
            d[17] = s[17];
            d[18] = s[16];
            d[19] = s[19];
            d[20] = s[22];
            d[21] = s[21];
            d[22] = s[20];
            d[23] = s[23];
            d[24] = s[26];
            d[25] = s[25];
            d[26] = s[24];
            d[27] = s[27];
            d[28] = s[30];
            d[29] = s[29];
            d[30] = s[28];
            d[31] = s[31];
        }

        let processed = (row_len / 32) * 32;
        for (d, s) in dst[processed..]
            .chunks_exact_mut(4)
            .zip(src[processed..].chunks_exact(4))
        {
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
            d[3] = s[3];
        }

        dst_offset += row_len;
    }

    frame_buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_copy_drops_stride_padding() {
        let mut data = vec![0u8; 24];
        data[..8].fill(1);
        data[12..20].fill(2);
        let out = copy_rgba_plane(&data, 12, 2, 2);
        assert_eq!(out.len(), 16);
        assert_eq!(&out[..8], &[1; 8]);
        assert_eq!(&out[8..], &[2; 8]);
    }

    #[test]
    fn pooled_rgba_copy_reuses_the_released_buffer() {
        let pool = PlanePool::new();
        let pixels = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let first = copy_rgba_plane_pooled(&pool, &pixels, 8, 2, 1);
        let ptr = first.as_ptr();
        let capacity = first.capacity();
        pool.recycle(first);
        let second = copy_rgba_plane_pooled(&pool, &pixels, 8, 2, 1);
        assert_eq!(second.as_ptr(), ptr);
        assert_eq!(second.capacity(), capacity);
        assert_eq!(second, pixels);
    }

    #[test]
    fn live_rgba_buffer_is_not_handed_out_again() {
        let pool = PlanePool::new();
        let pixels = [9u8; 8];
        let first = copy_rgba_plane_pooled(&pool, &pixels, 8, 2, 1);
        let ptr = first.as_ptr();
        let second = copy_rgba_plane_pooled(&pool, &pixels, 8, 2, 1);
        assert_ne!(second.as_ptr(), ptr);
        assert_eq!(first, pixels);
    }

    #[test]
    fn full_chroma_frames_keep_every_column_of_chroma() {
        ffmpeg::init().unwrap();
        let (width, height) = (64u32, 8u32);
        let mut source = frame::Video::new(format::Pixel::YUV444P, width, height);
        let chroma = |x: usize| -> (u8, u8) { if x % 2 == 0 { (60, 200) } else { (200, 60) } };
        for plane in 0..3 {
            let stride = source.stride(plane);
            let data = source.data_mut(plane);
            for y in 0..height as usize {
                for x in 0..width as usize {
                    data[y * stride + x] = match plane {
                        0 => 120,
                        1 => chroma(x).0,
                        _ => chroma(x).1,
                    };
                }
            }
        }
        let rgba = FrameConverter::new().convert(&mut source);
        for x in 0..width as usize {
            let (cb, cr) = chroma(x);
            let expected =
                YuvMatrix::Bt601.ycbcr_to_rgb(120 - 16, i32::from(cb) - 128, i32::from(cr) - 128);
            let actual = &rgba[x * 4..x * 4 + 3];
            for channel in 0..3 {
                assert!(
                    actual[channel].abs_diff(expected[channel]) <= 2,
                    "column {x}: {actual:?} vs {expected:?}"
                );
            }
        }
    }

    #[test]
    fn spare_planes_are_capped_and_prefer_a_fit() {
        let pool = PlanePool::new();
        for size in [32, 64, 128, 256] {
            pool.recycle(Vec::with_capacity(size));
        }
        assert_eq!(pool.spare_count(), MAX_SPARE_PACKED_PLANES);
        let taken = pool.take(200);
        assert!(taken.capacity() >= 200);
        assert_eq!(pool.spare_count(), 1);
    }

    #[test]
    fn full_chroma_frames_above_the_limit_convert_as_before() {
        ffmpeg::init().unwrap();
        use software::scaling::Flags;
        assert_eq!(
            scaler_flags(format::Pixel::YUV444P, 8000, 5000),
            Flags::BILINEAR
        );
        assert_eq!(
            scaler_flags(format::Pixel::YUV444P, 8002, 5000),
            Flags::FAST_BILINEAR
        );
        assert_eq!(
            scaler_flags(format::Pixel::YUV420P, 8000, 5000),
            Flags::FAST_BILINEAR
        );
        for ((width, height), fast_path) in [((8000, 5000), true), ((8002, 5000), false)] {
            let mut converter = FrameConverter::new();
            let mut source = frame::Video::new(format::Pixel::YUV444P, width, height);
            source.set_color_range(ffmpeg::color::Range::MPEG);
            for plane in 0..3 {
                source
                    .data_mut(plane)
                    .fill(if plane == 0 { 120 } else { 128 });
            }
            let rgba = converter.convert(&mut source);
            assert_eq!(rgba.len(), width as usize * height as usize * 4);
            assert_eq!(converter.scaler.is_none(), fast_path, "{width}x{height}");
        }
    }

    #[test]
    fn spare_planes_never_keep_a_buffer_above_the_frame_limit() {
        let limit = MAX_SPARE_PLANE_BYTES;
        let pool = PlanePool::new();
        pool.recycle(Vec::with_capacity(limit + 1));
        assert_eq!(pool.spare_count(), 0);
        pool.recycle(Vec::with_capacity(limit));
        assert_eq!(pool.spare_count(), 1);
    }
}
