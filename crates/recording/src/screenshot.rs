use crate::sources::screen_capture::ScreenCaptureTarget;
#[cfg(target_os = "macos")]
use anyhow::Context;
use anyhow::anyhow;
use image::{DynamicImage, RgbImage, RgbaImage};
#[cfg(target_os = "macos")]
use scap_ffmpeg::AsFFmpeg;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tracing::debug;
#[cfg(target_os = "macos")]
use tracing::error;

#[cfg(target_os = "macos")]
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
#[cfg(target_os = "macos")]
use scap_screencapturekit::{Capturer, StreamCfgBuilder};

#[cfg(target_os = "windows")]
use scap_direct3d::{Capturer, Frame, NewCapturerError, PixelFormat, Settings};
#[cfg(target_os = "windows")]
use std::sync::OnceLock;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HMODULE, HWND};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HDC, ReleaseDC, SRCCOPY, SelectObject,
};
#[cfg(target_os = "windows")]
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};

#[cfg(target_os = "windows")]
const WINDOWS_CAPTURE_UNSUPPORTED: &str =
    "Screen capture not supported on this device/driver. Update graphics drivers or OS.";

#[cfg(target_os = "windows")]
fn unsupported_error() -> anyhow::Error {
    anyhow!(WINDOWS_CAPTURE_UNSUPPORTED)
}

#[derive(Clone, Copy)]
enum ChannelOrder {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Rgba,
    Bgra,
}

fn rgb_from_rgba(
    data: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    order: ChannelOrder,
) -> Option<RgbImage> {
    let row_bytes = width.checked_mul(4)?;
    if bytes_per_row < row_bytes {
        return None;
    }

    let required_len = height.checked_mul(bytes_per_row)?;
    if data.len() < required_len {
        return None;
    }

    let width_stride = width.checked_mul(3)?;
    let rgb_len = height.checked_mul(width_stride)?;
    let mut rgb = vec![0u8; rgb_len];

    for y in 0..height {
        let src_start = y.checked_mul(bytes_per_row)?;
        let src_end = src_start.checked_add(row_bytes)?;
        let dst_start = y.checked_mul(width_stride)?;
        let dst_end = dst_start.checked_add(width_stride)?;

        let src_row = data.get(src_start..src_end)?;
        let dst_row = rgb.get_mut(dst_start..dst_end)?;

        for (src, dst) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(3)) {
            let (r, b) = match order {
                ChannelOrder::Rgba => (src[0], src[2]),
                ChannelOrder::Bgra => (src[2], src[0]),
            };

            dst[0] = r;
            dst[1] = src[1];
            dst[2] = b;
        }
    }

    RgbImage::from_raw(width as u32, height as u32, rgb)
}

fn rgba_from_raw(
    data: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    order: ChannelOrder,
) -> Option<RgbaImage> {
    let row_bytes = width.checked_mul(4)?;
    if bytes_per_row < row_bytes {
        return None;
    }

    let required_len = height.checked_mul(bytes_per_row)?;
    if data.len() < required_len {
        return None;
    }

    let width_stride = width.checked_mul(4)?;
    let rgba_len = height.checked_mul(width_stride)?;
    let mut rgba = vec![0u8; rgba_len];

    for y in 0..height {
        let src_start = y.checked_mul(bytes_per_row)?;
        let src_end = src_start.checked_add(row_bytes)?;
        let dst_start = y.checked_mul(width_stride)?;
        let dst_end = dst_start.checked_add(width_stride)?;

        let src_row = data.get(src_start..src_end)?;
        let dst_row = rgba.get_mut(dst_start..dst_end)?;

        for (src, dst) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
            let (r, b) = match order {
                ChannelOrder::Rgba => (src[0], src[2]),
                ChannelOrder::Bgra => (src[2], src[0]),
            };

            dst[0] = r;
            dst[1] = src[1];
            dst[2] = b;
            dst[3] = src[3];
        }
    }

    RgbaImage::from_raw(width as u32, height as u32, rgba)
}

fn apply_window_rounded_corners(image: RgbImage, target: &ScreenCaptureTarget) -> RgbaImage {
    let width = image.width();
    let height = image.height();

    let corner_radius = window_corner_radius_px(target);

    if corner_radius <= 0.0 {
        return image::buffer::ConvertBuffer::convert(&image);
    }

    let fw = width as f32;
    let fh = height as f32;
    let mut rgba = RgbaImage::new(width, height);

    for (x, y, rgb_pixel) in image.enumerate_pixels() {
        let alpha = rounded_corner_alpha(x as f32 + 0.5, y as f32 + 0.5, fw, fh, corner_radius);
        rgba.put_pixel(
            x,
            y,
            image::Rgba([rgb_pixel[0], rgb_pixel[1], rgb_pixel[2], alpha]),
        );
    }

    rgba
}

fn window_corner_radius_px(target: &ScreenCaptureTarget) -> f32 {
    match target {
        ScreenCaptureTarget::Window { id } => {
            let scale = scap_targets::Window::from_id(id)
                .and_then(|w| w.display())
                .and_then(|d| {
                    let physical = d.physical_size()?.width();
                    let logical = d.logical_size()?.width();
                    if logical > 0.0 {
                        Some(physical / logical)
                    } else {
                        None
                    }
                })
                .unwrap_or(1.0);

            #[cfg(target_os = "macos")]
            {
                (10.0 * scale) as f32
            }
            #[cfg(target_os = "windows")]
            {
                (8.0 * scale) as f32
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = scale;
                0.0
            }
        }
        _ => 0.0,
    }
}

fn rounded_corner_alpha(fx: f32, fy: f32, fw: f32, fh: f32, radius: f32) -> u8 {
    let dx = if fx < radius {
        radius - fx
    } else if fx > fw - radius {
        fx - (fw - radius)
    } else {
        return 255;
    };

    let dy = if fy < radius {
        radius - fy
    } else if fy > fh - radius {
        fy - (fh - radius)
    } else {
        return 255;
    };

    let dist = (dx * dx + dy * dy).sqrt();

    if dist <= radius - 0.5 {
        255
    } else if dist >= radius + 0.5 {
        0
    } else {
        ((radius + 0.5 - dist).clamp(0.0, 1.0) * 255.0) as u8
    }
}

#[cfg(target_os = "macos")]
fn try_fast_capture(target: &ScreenCaptureTarget) -> Option<DynamicImage> {
    use core_graphics::display::{
        CGDisplayCreateImage, CGDisplayCreateImageForRect, kCGWindowImageBoundsIgnoreFraming,
    };
    use core_graphics::window::CGWindowID;
    use foreign_types_shared::ForeignType;

    let start = std::time::Instant::now();

    let cg_image = match target {
        ScreenCaptureTarget::Display { id } => {
            let display = scap_targets::Display::from_id(id)?;
            let display_id = display.raw_handle().inner().id;
            let image = unsafe { CGDisplayCreateImage(display_id) };
            if image.is_null() {
                return None;
            }
            unsafe { core_graphics::image::CGImage::from_ptr(image) }
        }
        ScreenCaptureTarget::Window { id } => {
            use core_graphics::display::CGRectNull;

            let window = scap_targets::Window::from_id(id)?;
            let window_id: CGWindowID = window.id().to_string().parse().ok()?;

            unsafe extern "C" {
                fn CGWindowListCreateImage(
                    screenBounds: core_graphics::display::CGRect,
                    windowOption: u32,
                    windowID: CGWindowID,
                    imageOption: u32,
                ) -> core_graphics::sys::CGImageRef;
            }

            let image = unsafe {
                CGWindowListCreateImage(
                    CGRectNull,
                    0x00000008,
                    window_id,
                    kCGWindowImageBoundsIgnoreFraming,
                )
            };

            if image.is_null() {
                return None;
            }
            unsafe { core_graphics::image::CGImage::from_ptr(image) }
        }
        ScreenCaptureTarget::Area { screen, bounds } => {
            let display = scap_targets::Display::from_id(screen)?;
            let display_id = display.raw_handle().inner().id;
            let scale = display.raw_handle().scale().unwrap_or(1.0);
            let display_bounds = display.raw_handle().logical_bounds();
            let display_physical = display.physical_size();

            tracing::info!(
                "Area screenshot debug: display_id={}, display_logical_bounds={:?}, display_physical={:?}",
                display_id,
                display_bounds,
                display_physical,
            );
            tracing::info!(
                "Area screenshot: input logical bounds=({}, {}, {}x{}), scale={}",
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
                scale,
            );

            let rect = CGRect::new(
                &CGPoint::new(bounds.position().x(), bounds.position().y()),
                &CGSize::new(bounds.size().width(), bounds.size().height()),
            );

            tracing::info!(
                "Area screenshot: CGRect for capture (logical/points) = origin({}, {}), size({}x{})",
                rect.origin.x,
                rect.origin.y,
                rect.size.width,
                rect.size.height,
            );

            let image = unsafe { CGDisplayCreateImageForRect(display_id, rect) };
            if image.is_null() {
                return None;
            }
            unsafe { core_graphics::image::CGImage::from_ptr(image) }
        }
        ScreenCaptureTarget::CameraOnly => {
            return None;
        }
    };

    let width = cg_image.width();
    let height = cg_image.height();
    let bytes_per_row = cg_image.bytes_per_row();

    tracing::info!(
        "Fast capture result: image dimensions = {}x{}",
        width,
        height,
    );

    use core_foundation::data::CFData;
    let cf_data: CFData = cg_image.data();
    let data = cf_data.bytes();

    let is_window = matches!(target, ScreenCaptureTarget::Window { .. });

    let result = if is_window {
        let rgba = rgba_from_raw(data, width, height, bytes_per_row, ChannelOrder::Bgra)?;
        DynamicImage::ImageRgba8(rgba)
    } else {
        let rgb = rgb_from_rgba(data, width, height, bytes_per_row, ChannelOrder::Bgra)?;
        DynamicImage::ImageRgb8(rgb)
    };

    debug!("Fast capture completed in {:?}", start.elapsed());
    Some(result)
}

#[cfg(target_os = "windows")]
fn shared_d3d_device() -> anyhow::Result<&'static ID3D11Device> {
    static DEVICE: OnceLock<Option<ID3D11Device>> = OnceLock::new();

    let device = DEVICE.get_or_init(|| {
        let mut device = None;
        let result = unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                Default::default(),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        };

        if result.is_err() {
            return None;
        }

        device
    });

    device
        .as_ref()
        .ok_or_else(|| anyhow!("D3D11 device unavailable"))
}

#[cfg(target_os = "windows")]
fn windows_fast_path_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();

    *AVAILABLE.get_or_init(|| match scap_direct3d::is_supported() {
        Ok(true) => shared_d3d_device().is_ok(),
        _ => false,
    })
}

#[cfg(target_os = "windows")]
fn frame_to_rgb(frame: &Frame) -> anyhow::Result<RgbImage> {
    let buffer = frame
        .as_buffer()
        .map_err(|e| anyhow!("Failed to get buffer: {e:?}"))?;

    let order = match buffer.pixel_format() {
        PixelFormat::R8G8B8A8Unorm => ChannelOrder::Rgba,
        PixelFormat::B8G8R8A8Unorm => ChannelOrder::Bgra,
    };

    rgb_from_rgba(
        buffer.data(),
        buffer.width() as usize,
        buffer.height() as usize,
        buffer.stride() as usize,
        order,
    )
    .ok_or_else(|| anyhow!("Failed to create RgbImage"))
}

#[cfg(target_os = "windows")]
fn frame_to_rgba(frame: &Frame) -> anyhow::Result<RgbaImage> {
    let buffer = frame
        .as_buffer()
        .map_err(|e| anyhow!("Failed to get buffer: {e:?}"))?;

    let order = match buffer.pixel_format() {
        PixelFormat::R8G8B8A8Unorm => ChannelOrder::Rgba,
        PixelFormat::B8G8R8A8Unorm => ChannelOrder::Bgra,
    };

    rgba_from_raw(
        buffer.data(),
        buffer.width() as usize,
        buffer.height() as usize,
        buffer.stride() as usize,
        order,
    )
    .ok_or_else(|| anyhow!("Failed to create RgbaImage"))
}

#[cfg(target_os = "windows")]
fn windows_capture_settings(target: &ScreenCaptureTarget) -> anyhow::Result<(Settings, bool)> {
    if matches!(target, ScreenCaptureTarget::CameraOnly) {
        return Err(anyhow!("Camera-only not supported for screenshots"));
    }

    let mut settings = Settings {
        is_cursor_capture_enabled: Some(false),
        pixel_format: PixelFormat::B8G8R8A8Unorm,
        ..Default::default()
    };

    if let Ok(true) = Settings::can_is_border_required() {
        settings.is_border_required = Some(false);
    }

    if let Ok(true) = Settings::can_is_cursor_capture_enabled() {
        settings.is_cursor_capture_enabled = Some(false);
    }

    let mut cropped = false;

    if let ScreenCaptureTarget::Area { bounds, screen } = target {
        let display =
            scap_targets::Display::from_id(screen).ok_or_else(|| anyhow!("Display not found"))?;
        let physical = display
            .physical_size()
            .ok_or_else(|| anyhow!("Physical size not found"))?;
        let logical = display
            .logical_size()
            .ok_or_else(|| anyhow!("Logical size not found"))?;

        if logical.width() <= 0.0 || logical.height() <= 0.0 {
            return Err(anyhow!("Display logical size invalid"));
        }

        let scale = physical.width() / logical.width();
        let left = (bounds.position().x() * scale).floor();
        let top = (bounds.position().y() * scale).floor();
        let right = (left + bounds.size().width() * scale).ceil();
        let bottom = (top + bounds.size().height() * scale).ceil();

        let clamped_right = right.min(physical.width()).min(u32::MAX as f64).max(left);
        let clamped_bottom = bottom.min(physical.height()).min(u32::MAX as f64).max(top);

        if clamped_right > left && clamped_bottom > top {
            settings.crop = Some(D3D11_BOX {
                left: left.max(0.0) as u32,
                top: top.max(0.0) as u32,
                right: clamped_right as u32,
                bottom: clamped_bottom as u32,
                front: 0,
                back: 1,
            });
            cropped = true;
        }
    }

    Ok((settings, cropped))
}

#[cfg(target_os = "windows")]
fn capture_bitmap_with(
    base_dc: HDC,
    width: i32,
    height: i32,
    mut fill: impl FnMut(HDC) -> anyhow::Result<()>,
) -> anyhow::Result<Vec<u8>> {
    if width <= 0 || height <= 0 {
        return Err(unsupported_error());
    }

    if base_dc.0.is_null() {
        return Err(unsupported_error());
    }

    let mem_dc = unsafe { CreateCompatibleDC(Some(base_dc)) };
    if mem_dc.0.is_null() {
        return Err(unsupported_error());
    }

    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default(); 1],
    };

    let mut data = std::ptr::null_mut();
    let bitmap =
        unsafe { CreateDIBSection(Some(mem_dc), &info, DIB_RGB_COLORS, &mut data, None, 0) };
    let bitmap = match bitmap {
        Ok(b) if !b.0.is_null() && !data.is_null() => b,
        _ => {
            unsafe {
                let _ = DeleteDC(mem_dc);
            }
            return Err(unsupported_error());
        }
    };

    let old_obj = unsafe { SelectObject(mem_dc, bitmap.into()) };

    let result = (|| {
        fill(mem_dc)?;

        let width = usize::try_from(width).map_err(|_| unsupported_error())?;
        let height = usize::try_from(height).map_err(|_| unsupported_error())?;
        let row_bytes = width.checked_mul(4).ok_or_else(unsupported_error)?;
        let len = height
            .checked_mul(row_bytes)
            .ok_or_else(unsupported_error)?;
        let slice = unsafe { std::slice::from_raw_parts(data as *const u8, len) };

        let mut buffer = vec![0u8; len];
        buffer.copy_from_slice(slice);
        Ok(buffer)
    })();

    unsafe {
        SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
    }

    result
}

#[cfg(target_os = "windows")]
fn bgra_to_rgb(buffer: Vec<u8>, width: usize, height: usize) -> anyhow::Result<RgbImage> {
    let stride = width.checked_mul(4).ok_or_else(unsupported_error)?;
    rgb_from_rgba(&buffer, width, height, stride, ChannelOrder::Bgra).ok_or_else(unsupported_error)
}

#[cfg(target_os = "windows")]
fn capture_display_bounds(
    bounds: scap_targets::bounds::PhysicalBounds,
) -> anyhow::Result<RgbImage> {
    let width = bounds.size().width().round() as i32;
    let height = bounds.size().height().round() as i32;
    if width <= 0 || height <= 0 {
        return Err(unsupported_error());
    }
    let src_x = bounds.position().x().round() as i32;
    let src_y = bounds.position().y().round() as i32;

    let screen_dc = unsafe { GetDC(None) };
    let result = capture_bitmap_with(screen_dc, width, height, |mem_dc| {
        unsafe {
            BitBlt(
                mem_dc,
                0,
                0,
                width,
                height,
                Some(screen_dc),
                src_x,
                src_y,
                SRCCOPY | CAPTUREBLT,
            )
        }
        .map_err(|_| unsupported_error())
    });
    unsafe {
        ReleaseDC(None, screen_dc);
    }

    let buffer = result?;
    let width = usize::try_from(width).map_err(|_| unsupported_error())?;
    let height = usize::try_from(height).map_err(|_| unsupported_error())?;
    bgra_to_rgb(buffer, width, height)
}

#[cfg(target_os = "windows")]
fn capture_window_bitmap(hwnd: HWND, width: i32, height: i32) -> anyhow::Result<Vec<u8>> {
    let window_dc = unsafe { GetDC(Some(hwnd)) };
    let result = capture_bitmap_with(window_dc, width, height, |mem_dc| {
        unsafe {
            BitBlt(
                mem_dc,
                0,
                0,
                width,
                height,
                Some(window_dc),
                0,
                0,
                SRCCOPY | CAPTUREBLT,
            )
        }
        .map_err(|_| unsupported_error())
    });
    unsafe {
        ReleaseDC(Some(hwnd), window_dc);
    }
    result
}

#[cfg(target_os = "windows")]
fn capture_window_print(hwnd: HWND, width: i32, height: i32) -> anyhow::Result<Vec<u8>> {
    let window_dc = unsafe { GetDC(Some(hwnd)) };
    let result = capture_bitmap_with(window_dc, width, height, |mem_dc| {
        let res = unsafe { PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(2)) };

        if res.as_bool() {
            Ok(())
        } else {
            Err(unsupported_error())
        }
    });
    unsafe {
        ReleaseDC(Some(hwnd), window_dc);
    }
    result
}

#[cfg(target_os = "windows")]
fn capture_screenshot_fallback(target: ScreenCaptureTarget) -> anyhow::Result<RgbImage> {
    match target {
        ScreenCaptureTarget::Display { id } => {
            let display = scap_targets::Display::from_id(&id).ok_or_else(unsupported_error)?;
            let bounds = display
                .raw_handle()
                .physical_bounds()
                .ok_or_else(unsupported_error)?;

            let image = capture_display_bounds(bounds)?;
            debug!("Windows GDI display capture");
            Ok(image)
        }
        ScreenCaptureTarget::Window { id } => {
            let window = scap_targets::Window::from_id(&id).ok_or_else(unsupported_error)?;
            let bounds = window
                .raw_handle()
                .physical_bounds()
                .ok_or_else(unsupported_error)?;

            let width = bounds.size().width().round() as i32;
            let height = bounds.size().height().round() as i32;
            let hwnd = window.raw_handle().inner();

            let mut buffer = capture_window_bitmap(hwnd, width, height)?;
            let has_data = buffer.iter().any(|b| *b != 0);
            if !has_data {
                buffer = capture_window_print(hwnd, width, height)?;
            }

            let width = usize::try_from(width).map_err(|_| unsupported_error())?;
            let height = usize::try_from(height).map_err(|_| unsupported_error())?;
            let image = bgra_to_rgb(buffer, width, height)?;
            debug!("Windows GDI window capture");
            Ok(image)
        }
        ScreenCaptureTarget::Area { screen, .. } => {
            let display = scap_targets::Display::from_id(&screen).ok_or_else(unsupported_error)?;
            let bounds = display
                .raw_handle()
                .physical_bounds()
                .ok_or_else(unsupported_error)?;

            let image = capture_display_bounds(bounds)?;
            debug!("Windows GDI area capture");
            Ok(image)
        }
        ScreenCaptureTarget::CameraOnly => Err(unsupported_error()),
    }
}

#[cfg(target_os = "windows")]
fn gdi_or_error(
    target: &ScreenCaptureTarget,
    base_error: anyhow::Error,
) -> anyhow::Result<RgbImage> {
    match capture_screenshot_fallback(target.clone()) {
        Ok(image) => Ok(image),
        Err(fallback_err) => Err(base_error
            .context(fallback_err)
            .context(WINDOWS_CAPTURE_UNSUPPORTED)),
    }
}

#[cfg(target_os = "windows")]
fn try_fast_capture(target: &ScreenCaptureTarget) -> Option<DynamicImage> {
    use std::sync::mpsc::sync_channel;

    if !windows_fast_path_available() {
        return None;
    }

    let start = std::time::Instant::now();
    let is_window = matches!(target, ScreenCaptureTarget::Window { .. });

    let item = match target.clone() {
        ScreenCaptureTarget::Display { id } => {
            let display = scap_targets::Display::from_id(&id)?;
            display.raw_handle().try_as_capture_item().ok()?
        }
        ScreenCaptureTarget::Window { id } => {
            let window = scap_targets::Window::from_id(&id)?;
            window.raw_handle().try_as_capture_item().ok()?
        }
        ScreenCaptureTarget::Area { screen, .. } => {
            let display = scap_targets::Display::from_id(&screen)?;
            display.raw_handle().try_as_capture_item().ok()?
        }
        ScreenCaptureTarget::CameraOnly => {
            return None;
        }
    };

    let (settings, _) = windows_capture_settings(target).ok()?;
    let device = shared_d3d_device().ok().cloned();

    let (tx, rx) = sync_channel(1);

    let mut capturer = Capturer::new(
        item,
        settings,
        {
            move |frame| {
                if is_window {
                    let res = frame_to_rgba(&frame);
                    let _ = tx.try_send(res.map(DynamicImage::ImageRgba8));
                } else {
                    let res = frame_to_rgb(&frame);
                    let _ = tx.try_send(res.map(DynamicImage::ImageRgb8));
                }
                Ok(())
            }
        },
        || Ok(()),
        device,
    )
    .ok()?;

    capturer.start().ok()?;

    let res = rx.recv_timeout(Duration::from_millis(500));
    let _ = capturer.stop();

    let image = res.ok()?.ok()?;
    debug!("Windows fast capture completed in {:?}", start.elapsed());
    Some(image)
}

pub async fn capture_screenshot(target: ScreenCaptureTarget) -> anyhow::Result<DynamicImage> {
    #[cfg(target_os = "macos")]
    {
        if let Some(image) = try_fast_capture(&target) {
            return Ok(image);
        }
        debug!("Fast capture failed, falling back to SCStream");
    }

    #[cfg(target_os = "windows")]
    {
        if !windows_fast_path_available() {
            let fallback_image = gdi_or_error(
                &target,
                anyhow!("Windows.Graphics.Capture not supported on this system"),
            )?;
            return crop_area_if_needed(fallback_image, &target, false)
                .map(|img| finalize_screenshot(img, &target));
        }

        if let Some(image) = try_fast_capture(&target) {
            return Ok(image);
        }
        debug!("Fast capture failed, falling back to Windows.Graphics.Capture");
    }

    #[cfg(target_os = "windows")]
    let cropped_in_capture;

    let (tx, rx) = oneshot::channel::<anyhow::Result<RgbImage>>();
    let tx = Arc::new(Mutex::new(Some(tx)));

    #[cfg(target_os = "macos")]
    let capturer = {
        use cidre::sc;

        let content_filter = match target.clone() {
            ScreenCaptureTarget::Display { id } => {
                let display = scap_targets::Display::from_id(&id)
                    .ok_or_else(|| anyhow!("Display not found"))?;

                display
                    .raw_handle()
                    .as_content_filter(
                        sc::ShareableContent::current()
                            .await
                            .map_err(|e| anyhow!("Failed to get shareable content: {e}"))?,
                    )
                    .ok_or_else(|| anyhow!("Failed to get content filter"))?
            }
            ScreenCaptureTarget::Window { id } => {
                let window = scap_targets::Window::from_id(&id)
                    .ok_or_else(|| anyhow!("Window not found"))?;

                let sc_content = sc::ShareableContent::current()
                    .await
                    .map_err(|e| anyhow!("Failed to get shareable content: {e}"))?;
                let sc_window = window
                    .raw_handle()
                    .as_sc(sc_content)
                    .ok_or_else(|| anyhow!("Failed to get SCWindow"))?;

                sc::ContentFilter::with_desktop_independent_window(sc_window.as_ref())
            }
            ScreenCaptureTarget::Area { screen, .. } => {
                let display = scap_targets::Display::from_id(&screen)
                    .ok_or_else(|| anyhow!("Display not found"))?;

                display
                    .raw_handle()
                    .as_content_filter(
                        sc::ShareableContent::current()
                            .await
                            .map_err(|e| anyhow!("Failed to get shareable content: {e}"))?,
                    )
                    .ok_or_else(|| anyhow!("Failed to get content filter"))?
            }
            ScreenCaptureTarget::CameraOnly => {
                return Err(anyhow!("Camera-only not supported for screenshots"));
            }
        };

        let width = match target.clone() {
            ScreenCaptureTarget::Display { id } => scap_targets::Display::from_id(&id)
                .and_then(|d| d.physical_size())
                .map(|s| s.width())
                .unwrap_or(1920.0),
            ScreenCaptureTarget::Window { id } => scap_targets::Window::from_id(&id)
                .and_then(|w| w.physical_size())
                .map(|s| s.width())
                .unwrap_or(1920.0),
            ScreenCaptureTarget::Area { screen, .. } => scap_targets::Display::from_id(&screen)
                .and_then(|d| d.physical_size())
                .map(|s| s.width())
                .unwrap_or(1920.0),
            ScreenCaptureTarget::CameraOnly => {
                return Err(anyhow!("Camera-only not supported for screenshots"));
            }
        } as usize;

        let height = match target.clone() {
            ScreenCaptureTarget::Display { id } => scap_targets::Display::from_id(&id)
                .and_then(|d| d.physical_size())
                .map(|s| s.height())
                .unwrap_or(1080.0),
            ScreenCaptureTarget::Window { id } => scap_targets::Window::from_id(&id)
                .and_then(|w| w.physical_size())
                .map(|s| s.height())
                .unwrap_or(1080.0),
            ScreenCaptureTarget::Area { screen, .. } => scap_targets::Display::from_id(&screen)
                .and_then(|d| d.physical_size())
                .map(|s| s.height())
                .unwrap_or(1080.0),
            ScreenCaptureTarget::CameraOnly => {
                return Err(anyhow!("Camera-only not supported for screenshots"));
            }
        } as usize;

        let config = StreamCfgBuilder::default()
            .with_fps(60.0) // High FPS to get the first frame quickly
            .with_width(width)
            .with_height(height)
            .with_shows_cursor(false)
            .build();

        Capturer::builder(content_filter, config)
            .with_output_sample_buf_cb({
                let tx = tx.clone();
                move |frame| {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let res = (|| {
                            use scap_screencapturekit::Frame;
                            let Frame::Screen(video_frame) = frame else {
                                return Err(anyhow!("Not a screen frame"));
                            };
                            // Note: This requires VideoFrame to implement AsFFmpeg trait or similar logic.
                            // Since scap_screencapturekit::VideoFrame doesn't directly implement it in all contexts,
                            // we might need to ensure we are using the correct types or traits.
                            // Assuming scap_ffmpeg::AsFFmpeg is implemented for it if imported.
                            let ff_frame = video_frame
                                .as_ffmpeg()
                                .map_err(|e| anyhow!("Failed to convert to ffmpeg: {e:?}"))?;
                            convert_ffmpeg_frame_to_image(&ff_frame)
                        })();
                        let _ = tx.send(res);
                    }
                }
            })
            .with_stop_with_err_cb(|_, err| {
                error!("Screenshot capture error: {err:?}");
            })
            .build()
            .map_err(|e| anyhow!("Failed to build capturer: {e:?}"))?
    };

    #[cfg(target_os = "windows")]
    let mut capturer = {
        let item = match target.clone() {
            ScreenCaptureTarget::Display { id } => {
                let display = scap_targets::Display::from_id(&id)
                    .ok_or_else(|| anyhow!("Display not found"))?;
                display
                    .raw_handle()
                    .try_as_capture_item()
                    .map_err(|e| anyhow!("Failed to get capture item: {e:?}"))?
            }
            ScreenCaptureTarget::Window { id } => {
                let window = scap_targets::Window::from_id(&id)
                    .ok_or_else(|| anyhow!("Window not found"))?;
                window
                    .raw_handle()
                    .try_as_capture_item()
                    .map_err(|e| anyhow!("Failed to get capture item: {e:?}"))?
            }
            ScreenCaptureTarget::Area { screen, .. } => {
                let display = scap_targets::Display::from_id(&screen)
                    .ok_or_else(|| anyhow!("Display not found"))?;
                display
                    .raw_handle()
                    .try_as_capture_item()
                    .map_err(|e| anyhow!("Failed to get capture item: {e:?}"))?
            }
            ScreenCaptureTarget::CameraOnly => {
                return Err(anyhow!("Camera-only not supported for screenshots"));
            }
        };

        let (settings, cropped) = windows_capture_settings(&target)?;
        cropped_in_capture = cropped;

        match Capturer::new(
            item,
            settings,
            {
                let tx = tx.clone();
                move |frame| {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let res = frame_to_rgb(&frame);
                        let _ = tx.send(res);
                    }
                    Ok(())
                }
            },
            || Ok(()),
            shared_d3d_device().ok().cloned(),
        ) {
            Ok(capturer) => capturer,
            Err(
                e @ NewCapturerError::NotSupported
                | e @ NewCapturerError::CreateDevice(_)
                | e @ NewCapturerError::Direct3DDevice(_)
                | e @ NewCapturerError::Context(_),
            ) => {
                let fallback_image =
                    gdi_or_error(&target, anyhow!("Failed to create capturer: {e:?}"))?;
                return crop_area_if_needed(fallback_image, &target, false)
                    .map(|img| finalize_screenshot(img, &target));
            }
            Err(e) => return Err(anyhow!("Failed to create capturer: {e:?}")),
        }
    };

    #[cfg(target_os = "macos")]
    capturer
        .start()
        .await
        .map_err(|e| anyhow!("Failed to start capturer: {e:?}"))?;

    #[cfg(target_os = "windows")]
    if let Err(e) = capturer.start() {
        let fallback_image = gdi_or_error(&target, anyhow!("Failed to start capturer: {e:?}"))?;
        return crop_area_if_needed(fallback_image, &target, false)
            .map(|img| finalize_screenshot(img, &target));
    }

    let result = match tokio::time::timeout(Duration::from_secs(2), rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err(anyhow!("Channel closed")),
        Err(_) => Err(anyhow!("Timeout waiting for screenshot")),
    };

    #[cfg(target_os = "macos")]
    capturer
        .stop()
        .await
        .map_err(|e| anyhow!("Failed to stop capturer: {e:?}"))?;

    #[cfg(target_os = "windows")]
    capturer
        .stop()
        .map_err(|e| anyhow!("Failed to stop capturer: {e:?}"))?;

    #[cfg(target_os = "windows")]
    let image = match result {
        Ok(img) => img,
        Err(err) => {
            let fallback_image = gdi_or_error(&target, err)?;
            return crop_area_if_needed(fallback_image, &target, false)
                .map(|img| finalize_screenshot(img, &target));
        }
    };

    #[cfg(not(target_os = "windows"))]
    let image = result?;

    #[cfg(target_os = "windows")]
    let skip_crop = cropped_in_capture;

    #[cfg(not(target_os = "windows"))]
    let skip_crop = false;

    let final_image = crop_area_if_needed(image, &target, skip_crop)?;

    Ok(finalize_screenshot(final_image, &target))
}

fn finalize_screenshot(image: RgbImage, target: &ScreenCaptureTarget) -> DynamicImage {
    if matches!(target, ScreenCaptureTarget::Window { .. }) {
        DynamicImage::ImageRgba8(apply_window_rounded_corners(image, target))
    } else {
        DynamicImage::ImageRgb8(image)
    }
}

fn crop_area_if_needed(
    image: RgbImage,
    target: &ScreenCaptureTarget,
    skip_crop: bool,
) -> anyhow::Result<RgbImage> {
    if let ScreenCaptureTarget::Area { bounds, screen } = target {
        if skip_crop {
            return Ok(image);
        }

        #[cfg(target_os = "macos")]
        let scale = {
            let display = scap_targets::Display::from_id(screen)
                .ok_or_else(|| anyhow!("Display not found"))?;
            display.raw_handle().scale().unwrap_or(1.0)
        };

        #[cfg(target_os = "windows")]
        let scale = {
            let display = scap_targets::Display::from_id(screen)
                .ok_or_else(|| anyhow!("Display not found"))?;
            let physical_width = display.physical_size().map(|s| s.width()).unwrap_or(1.0);
            let logical_width = display.logical_size().map(|s| s.width()).unwrap_or(1.0);
            physical_width / logical_width
        };

        #[cfg(target_os = "linux")]
        let scale = 1.0f64;

        let x = (bounds.position().x() * scale) as u32;
        let y = (bounds.position().y() * scale) as u32;
        let width = (bounds.size().width() * scale) as u32;
        let height = (bounds.size().height() * scale) as u32;

        let img_width = image.width();
        let img_height = image.height();

        let x = x.min(img_width);
        let y = y.min(img_height);
        let width = width.min(img_width - x);
        let height = height.min(img_height - y);

        if width == 0 || height == 0 {
            return Ok(image);
        }

        let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
        return Ok(cropped);
    }

    Ok(image)
}

#[cfg(target_os = "macos")]
fn convert_ffmpeg_frame_to_image(frame: &ffmpeg::frame::Video) -> anyhow::Result<RgbImage> {
    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        frame.format(),
        frame.width(),
        frame.height(),
        ffmpeg::format::Pixel::RGB24,
        frame.width(),
        frame.height(),
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .context("Failed to create scaler")?;

    let mut rgb_frame = ffmpeg::frame::Video::empty();
    scaler
        .run(frame, &mut rgb_frame)
        .context("Failed to scale frame")?;

    let width = rgb_frame.width() as usize;
    let height = rgb_frame.height() as usize;
    let dst_stride = width * 3;
    let src_stride = rgb_frame.stride(0);

    if src_stride < dst_stride {
        return Err(anyhow!(
            "Source stride ({}) is less than destination stride ({}); width={}, height={}",
            src_stride,
            dst_stride,
            width,
            height
        ));
    }

    let mut img_buffer = vec![0u8; height * dst_stride];

    for y in 0..height {
        let src_slice = &rgb_frame.data(0)[y * src_stride..y * src_stride + dst_stride];
        let dst_slice = &mut img_buffer[y * dst_stride..(y + 1) * dst_stride];
        dst_slice.copy_from_slice(src_slice);
    }

    RgbImage::from_raw(width as u32, height as u32, img_buffer)
        .ok_or_else(|| anyhow!("Failed to create image buffer"))
}
