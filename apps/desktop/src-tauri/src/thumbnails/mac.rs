use cidre::{arc, sc};

use crate::platform::get_shareable_content;

use super::*;

pub async fn capture_display_thumbnail(display: &scap_targets::Display) -> Option<String> {
    let content = get_shareable_content().await.ok()??;

    let filter = display.raw_handle().as_content_filter(content).await?;
    capture_thumbnail_from_filter(filter).await
}

pub async fn capture_window_thumbnail(window: &scap_targets::Window) -> Option<String> {
    let content = get_shareable_content().await.ok()??;

    let sc_window = window.raw_handle().as_sc(content).await?;
    let filter = cidre::sc::ContentFilter::with_desktop_independent_window(&sc_window);
    capture_thumbnail_from_filter(filter).await
}

async fn capture_thumbnail_from_filter(filter: arc::R<sc::ContentFilter>) -> Option<String> {
    use cidre::{cv, sc};
    use image::{ImageEncoder, RgbaImage, codecs::png::PngEncoder};
    use std::io::Cursor;

    let mut config = sc::StreamCfg::new();
    config.set_width(THUMBNAIL_WIDTH as usize);
    config.set_height(THUMBNAIL_HEIGHT as usize);
    config.set_shows_cursor(false);

    let sample_buf = match unsafe {
        sc::ScreenshotManager::capture_sample_buf(filter.as_ref(), &config)
    }
    .await
    {
        Ok(buf) => buf,
        Err(err) => {
            warn!(error = ?err, "Failed to capture sample buffer for thumbnail");
            return None;
        }
    };

    let Some(image_buf) = sample_buf.image_buf() else {
        warn!("Sample buffer missing image data");
        return None;
    };
    let mut image_buf = image_buf.retained();

    let width = image_buf.width();
    let height = image_buf.height();
    if width == 0 || height == 0 {
        warn!(
            width = width,
            height = height,
            "Captured thumbnail had empty dimensions"
        );
        return None;
    }

    let pixel_format = image_buf.pixel_format();

    let lock =
        match PixelBufferLock::new(image_buf.as_mut(), cv::pixel_buffer::LockFlags::READ_ONLY) {
            Ok(lock) => lock,
            Err(err) => {
                warn!(error = ?err, "Failed to lock pixel buffer for thumbnail");
                return None;
            }
        };

    let rgba_data = match pixel_format {
        cv::PixelFormat::_32_BGRA
        | cv::PixelFormat::_32_RGBA
        | cv::PixelFormat::_32_ARGB
        | cv::PixelFormat::_32_ABGR => {
            convert_32bit_pixel_buffer(&lock, width, height, pixel_format)?
        }
        cv::PixelFormat::_420V => {
            convert_nv12_pixel_buffer(&lock, width, height, Nv12Range::Video)?
        }
        other => {
            warn!(?other, "Unsupported pixel format for thumbnail capture");
            return None;
        }
    };

    let Some(img) = RgbaImage::from_raw(width as u32, height as u32, rgba_data) else {
        warn!("Failed to construct RGBA image for thumbnail");
        return None;
    };
    let thumbnail = normalize_thumbnail_dimensions(&img);
    let mut png_data = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut png_data);
    if let Err(err) = encoder.write_image(
        thumbnail.as_raw(),
        thumbnail.width(),
        thumbnail.height(),
        image::ColorType::Rgba8.into(),
    ) {
        warn!(error = ?err, "Failed to encode thumbnail as PNG");
        return None;
    }

    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        png_data.into_inner(),
    ))
}

fn convert_32bit_pixel_buffer(
    lock: &PixelBufferLock<'_>,
    width: usize,
    height: usize,
    pixel_format: cidre::cv::PixelFormat,
) -> Option<Vec<u8>> {
    let base_ptr = lock.base_address();
    if base_ptr.is_null() {
        warn!("Pixel buffer base address was null");
        return None;
    }

    let bytes_per_row = lock.bytes_per_row();
    let total_len = bytes_per_row.checked_mul(height)?;
    let raw_data = unsafe { std::slice::from_raw_parts(base_ptr, total_len) };

    let mut rgba_data = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row_start = y * bytes_per_row;
        let row_end = row_start + width * 4;
        if row_end > raw_data.len() {
            warn!(
                row_start = row_start,
                row_end = row_end,
                raw_len = raw_data.len(),
                "Row bounds exceeded raw data length during thumbnail capture",
            );
            return None;
        }

        let row = &raw_data[row_start..row_end];
        for chunk in row.chunks_exact(4) {
            match pixel_format {
                cidre::cv::PixelFormat::_32_BGRA => {
                    rgba_data.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]])
                }
                cidre::cv::PixelFormat::_32_RGBA => rgba_data.extend_from_slice(chunk),
                cidre::cv::PixelFormat::_32_ARGB => {
                    rgba_data.extend_from_slice(&[chunk[1], chunk[2], chunk[3], chunk[0]])
                }
                cidre::cv::PixelFormat::_32_ABGR => {
                    rgba_data.extend_from_slice(&[chunk[3], chunk[2], chunk[1], chunk[0]])
                }
                _ => unreachable!(),
            }
        }
    }

    Some(rgba_data)
}

#[derive(Copy, Clone)]
enum Nv12Range {
    Video,
    Full,
}

fn convert_nv12_pixel_buffer(
    lock: &PixelBufferLock<'_>,
    width: usize,
    height: usize,
    range: Nv12Range,
) -> Option<Vec<u8>> {
    let y_base = lock.base_address_of_plane(0);
    let uv_base = lock.base_address_of_plane(1);
    if y_base.is_null() || uv_base.is_null() {
        warn!("NV12 plane base address was null");
        return None;
    }

    let y_stride = lock.bytes_per_row_of_plane(0);
    let uv_stride = lock.bytes_per_row_of_plane(1);
    if y_stride == 0 || uv_stride == 0 {
        warn!(y_stride, uv_stride, "NV12 plane bytes per row was zero");
        return None;
    }

    let y_plane_height = lock.height_of_plane(0);
    let uv_plane_height = lock.height_of_plane(1);
    if y_plane_height < height || uv_plane_height < height.div_ceil(2) {
        warn!(
            y_plane_height,
            uv_plane_height,
            expected_y = height,
            expected_uv = height.div_ceil(2),
            "NV12 plane height smaller than expected",
        );
        return None;
    }

    let y_plane = unsafe { std::slice::from_raw_parts(y_base, y_stride * y_plane_height) };
    let uv_plane = unsafe { std::slice::from_raw_parts(uv_base, uv_stride * uv_plane_height) };

    let mut rgba_data = vec![0u8; width * height * 4];

    for y_idx in 0..height {
        let y_row_start = y_idx * y_stride;
        if y_row_start + width > y_plane.len() {
            warn!(
                y_row_start,
                width,
                y_plane_len = y_plane.len(),
                "Y row exceeded plane length during conversion",
            );
            return None;
        }
        let y_row = &y_plane[y_row_start..y_row_start + width];

        let uv_row_start = (y_idx / 2) * uv_stride;
        if uv_row_start + width > uv_plane.len() {
            warn!(
                uv_row_start,
                width,
                uv_plane_len = uv_plane.len(),
                "UV row exceeded plane length during conversion",
            );
            return None;
        }
        let uv_row = &uv_plane[uv_row_start..uv_row_start + width];

        for x in 0..width {
            let uv_index = (x / 2) * 2;
            if uv_index + 1 >= uv_row.len() {
                warn!(
                    uv_index,
                    uv_row_len = uv_row.len(),
                    "UV index out of bounds during conversion",
                );
                return None;
            }

            let y_val = y_row[x];
            let cb = uv_row[uv_index];
            let cr = uv_row[uv_index + 1];
            let (r, g, b) = ycbcr_to_rgb(y_val, cb, cr, range);
            let out = (y_idx * width + x) * 4;
            rgba_data[out] = r;
            rgba_data[out + 1] = g;
            rgba_data[out + 2] = b;
            rgba_data[out + 3] = 255;
        }
    }

    Some(rgba_data)
}

fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8, range: Nv12Range) -> (u8, u8, u8) {
    let y = y as f32;
    let cb = cb as f32 - 128.0;
    let cr = cr as f32 - 128.0;

    let (y_value, scale) = match range {
        Nv12Range::Video => ((y - 16.0).max(0.0), 1.164383_f32),
        Nv12Range::Full => (y, 1.0_f32),
    };

    let r = scale * y_value + 1.596027_f32 * cr;
    let g = scale * y_value - 0.391762_f32 * cb - 0.812968_f32 * cr;
    let b = scale * y_value + 2.017232_f32 * cb;

    (clamp_channel(r), clamp_channel(g), clamp_channel(b))
}

fn clamp_channel(value: f32) -> u8 {
    value.max(0.0).min(255.0) as u8
}

struct PixelBufferLock<'a> {
    buffer: &'a mut cidre::cv::PixelBuf,
    flags: cidre::cv::pixel_buffer::LockFlags,
}

impl<'a> PixelBufferLock<'a> {
    fn new(
        buffer: &'a mut cidre::cv::PixelBuf,
        flags: cidre::cv::pixel_buffer::LockFlags,
    ) -> cidre::os::Result<Self> {
        unsafe { buffer.lock_base_addr(flags) }.result()?;
        Ok(Self { buffer, flags })
    }

    fn base_address(&self) -> *const u8 {
        unsafe { cv_pixel_buffer_get_base_address(self.buffer) as *const u8 }
    }

    fn bytes_per_row(&self) -> usize {
        unsafe { cv_pixel_buffer_get_bytes_per_row(self.buffer) }
    }

    fn base_address_of_plane(&self, plane_index: usize) -> *const u8 {
        unsafe { cv_pixel_buffer_get_base_address_of_plane(self.buffer, plane_index) as *const u8 }
    }

    fn bytes_per_row_of_plane(&self, plane_index: usize) -> usize {
        unsafe { cv_pixel_buffer_get_bytes_per_row_of_plane(self.buffer, plane_index) }
    }

    fn height_of_plane(&self, plane_index: usize) -> usize {
        unsafe { cv_pixel_buffer_get_height_of_plane(self.buffer, plane_index) }
    }
}

impl Drop for PixelBufferLock<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = self.buffer.unlock_lock_base_addr(self.flags);
        }
    }
}

unsafe fn cv_pixel_buffer_get_base_address(buffer: &cidre::cv::PixelBuf) -> *mut std::ffi::c_void {
    unsafe extern "C" {
        fn CVPixelBufferGetBaseAddress(pixel_buffer: &cidre::cv::PixelBuf)
        -> *mut std::ffi::c_void;
    }

    unsafe { CVPixelBufferGetBaseAddress(buffer) }
}

unsafe fn cv_pixel_buffer_get_bytes_per_row(buffer: &cidre::cv::PixelBuf) -> usize {
    unsafe extern "C" {
        fn CVPixelBufferGetBytesPerRow(pixel_buffer: &cidre::cv::PixelBuf) -> usize;
    }

    unsafe { CVPixelBufferGetBytesPerRow(buffer) }
}

unsafe fn cv_pixel_buffer_get_base_address_of_plane(
    buffer: &cidre::cv::PixelBuf,
    plane_index: usize,
) -> *mut std::ffi::c_void {
    unsafe extern "C" {
        fn CVPixelBufferGetBaseAddressOfPlane(
            pixel_buffer: &cidre::cv::PixelBuf,
            plane_index: usize,
        ) -> *mut std::ffi::c_void;
    }

    unsafe { CVPixelBufferGetBaseAddressOfPlane(buffer, plane_index) }
}

unsafe fn cv_pixel_buffer_get_bytes_per_row_of_plane(
    buffer: &cidre::cv::PixelBuf,
    plane_index: usize,
) -> usize {
    unsafe extern "C" {
        fn CVPixelBufferGetBytesPerRowOfPlane(
            pixel_buffer: &cidre::cv::PixelBuf,
            plane_index: usize,
        ) -> usize;
    }

    unsafe { CVPixelBufferGetBytesPerRowOfPlane(buffer, plane_index) }
}

unsafe fn cv_pixel_buffer_get_height_of_plane(
    buffer: &cidre::cv::PixelBuf,
    plane_index: usize,
) -> usize {
    unsafe extern "C" {
        fn CVPixelBufferGetHeightOfPlane(
            pixel_buffer: &cidre::cv::PixelBuf,
            plane_index: usize,
        ) -> usize;
    }

    unsafe { CVPixelBufferGetHeightOfPlane(buffer, plane_index) }
}
