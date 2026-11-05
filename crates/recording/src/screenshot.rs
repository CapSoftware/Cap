use crate::sources::screen_capture::ScreenCaptureTarget;
#[cfg(target_os = "linux")]
use crate::sources::screen_capture::{
    X11Grabber, X11InputConfig, prefers_wayland_portal, x11_capture_rect,
};
#[cfg(target_os = "macos")]
use anyhow::Context;
#[cfg(target_os = "linux")]
use anyhow::Context;
use anyhow::anyhow;
use image::{DynamicImage, RgbImage, RgbaImage};
#[cfg(target_os = "macos")]
use scap_ffmpeg::AsFFmpeg;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::cell::RefCell;
#[cfg(not(target_os = "linux"))]
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "linux"))]
use std::time::Duration;
#[cfg(not(target_os = "linux"))]
use tokio::sync::oneshot;
#[cfg(not(target_os = "linux"))]
use tracing::debug;
#[cfg(target_os = "macos")]
use tracing::error;

#[cfg(target_os = "macos")]
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
#[cfg(target_os = "windows")]
use scap_direct3d::{Capturer, Frame, NewCapturerError, PixelFormat, Settings};
#[cfg(target_os = "macos")]
use scap_screencapturekit::{Capturer, StreamCfgBuilder};
#[cfg(target_os = "windows")]
use std::sync::OnceLock;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HMODULE, HWND};
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

#[cfg(any(target_os = "macos", target_os = "windows", test))]
#[derive(Clone, Copy, Debug)]
enum ChannelOrder {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Rgba,
    Bgra,
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
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

    #[cfg(target_arch = "aarch64")]
    {
        // SAFETY: reorder_rgb_row_neon initializes every element of each destination row.
        let rgb = unsafe {
            pack_rows_uninit(
                data,
                height,
                bytes_per_row,
                row_bytes,
                width_stride,
                |src_row, dst_row| reorder_rgb_row_neon(src_row, dst_row, order),
            )?
        };
        RgbImage::from_raw(width as u32, height as u32, rgb)
    }

    #[cfg(not(target_arch = "aarch64"))]
    {
        let rgb_len = height.checked_mul(width_stride)?;
        let mut rgb = vec![0u8; rgb_len];

        #[cfg(target_arch = "x86_64")]
        {
            if std::is_x86_feature_detected!("ssse3") {
                for y in 0..height {
                    let (src_row, dst_row) =
                        rgb_row_pair(data, &mut rgb, y, bytes_per_row, row_bytes, width_stride)?;
                    unsafe {
                        reorder_rgb_row_ssse3(src_row, dst_row, order);
                    }
                }
                return RgbImage::from_raw(width as u32, height as u32, rgb);
            }
        }

        for y in 0..height {
            let (src_row, dst_row) =
                rgb_row_pair(data, &mut rgb, y, bytes_per_row, row_bytes, width_stride)?;
            reorder_rgb_row_scalar(src_row, dst_row, order);
        }

        RgbImage::from_raw(width as u32, height as u32, rgb)
    }
}

/// # Safety
///
/// `write_row` must initialize every element of the destination slice it receives.
#[cfg(all(target_arch = "aarch64", any(not(target_os = "linux"), test)))]
unsafe fn pack_rows_uninit(
    data: &[u8],
    height: usize,
    bytes_per_row: usize,
    row_bytes: usize,
    dst_stride: usize,
    mut write_row: impl FnMut(&[u8], &mut [std::mem::MaybeUninit<u8>]),
) -> Option<Vec<u8>> {
    let dst_len = height.checked_mul(dst_stride)?;
    let mut out = Vec::<u8>::with_capacity(dst_len);
    let spare = out.spare_capacity_mut().get_mut(..dst_len)?;

    for y in 0..height {
        let src_start = y.checked_mul(bytes_per_row)?;
        let src_row = data.get(src_start..src_start.checked_add(row_bytes)?)?;
        let dst_start = y.checked_mul(dst_stride)?;
        let dst_row = spare.get_mut(dst_start..dst_start.checked_add(dst_stride)?)?;
        write_row(src_row, dst_row);
    }

    // SAFETY: the rows 0..height tile 0..dst_len exactly, and the caller guarantees write_row
    // initialized every byte of each row. dst_len <= capacity.
    unsafe { out.set_len(dst_len) };
    Some(out)
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", test),
    target_arch = "aarch64"
))]
fn reorder_rgb_row_neon(src: &[u8], dst: &mut [std::mem::MaybeUninit<u8>], order: ChannelOrder) {
    use std::arch::aarch64::*;

    assert_eq!(
        dst.len() % 3,
        0,
        "rgb row length must be a whole number of pixels"
    );
    let pixels = dst.len() / 3;
    let src = &src[..pixels * 4];
    let swap = matches!(order, ChannelOrder::Bgra);
    let simd_pixels = pixels & !15;

    for i in (0..simd_pixels).step_by(16) {
        // SAFETY: i + 16 <= simd_pixels <= pixels, so the 64 byte load at i * 4 is inside src
        // (pixels * 4 bytes) and the 48 byte store at i * 3 is inside dst (pixels * 3 bytes).
        // NEON is part of the aarch64 baseline, and both intrinsics accept unaligned pointers.
        unsafe {
            let px = vld4q_u8(src.as_ptr().add(i * 4));
            let rgb = if swap {
                uint8x16x3_t(px.2, px.1, px.0)
            } else {
                uint8x16x3_t(px.0, px.1, px.2)
            };
            vst3q_u8(dst.as_mut_ptr().add(i * 3).cast::<u8>(), rgb);
        }
    }

    for (s, d) in src[simd_pixels * 4..]
        .chunks_exact(4)
        .zip(dst[simd_pixels * 3..].chunks_exact_mut(3))
    {
        let (r, b) = if swap { (s[2], s[0]) } else { (s[0], s[2]) };
        d[0].write(r);
        d[1].write(s[1]);
        d[2].write(b);
    }
}

#[cfg(all(not(target_os = "linux"), target_arch = "aarch64"))]
fn reorder_rgba_row_neon(src: &[u8], dst: &mut [std::mem::MaybeUninit<u8>], order: ChannelOrder) {
    use std::arch::aarch64::*;

    assert_eq!(
        dst.len() % 4,
        0,
        "rgba row length must be a whole number of pixels"
    );
    let pixels = dst.len() / 4;
    let src = &src[..pixels * 4];
    let swap = matches!(order, ChannelOrder::Bgra);
    let simd_pixels = pixels & !15;

    for i in (0..simd_pixels).step_by(16) {
        // SAFETY: i + 16 <= simd_pixels <= pixels, so the 64 byte load and the 64 byte store at
        // i * 4 are inside src and dst (both pixels * 4 bytes). NEON is part of the aarch64
        // baseline, and both intrinsics accept unaligned pointers.
        unsafe {
            let px = vld4q_u8(src.as_ptr().add(i * 4));
            let rgba = if swap {
                uint8x16x4_t(px.2, px.1, px.0, px.3)
            } else {
                px
            };
            vst4q_u8(dst.as_mut_ptr().add(i * 4).cast::<u8>(), rgba);
        }
    }

    for (s, d) in src[simd_pixels * 4..]
        .chunks_exact(4)
        .zip(dst[simd_pixels * 4..].chunks_exact_mut(4))
    {
        let (r, b) = if swap { (s[2], s[0]) } else { (s[0], s[2]) };
        d[0].write(r);
        d[1].write(s[1]);
        d[2].write(b);
        d[3].write(s[3]);
    }
}

#[cfg(any(
    all(
        any(target_os = "macos", target_os = "windows"),
        not(target_arch = "aarch64")
    ),
    test
))]
fn rgb_row_pair<'a>(
    data: &'a [u8],
    rgb: &'a mut [u8],
    y: usize,
    bytes_per_row: usize,
    row_bytes: usize,
    width_stride: usize,
) -> Option<(&'a [u8], &'a mut [u8])> {
    let src_start = y.checked_mul(bytes_per_row)?;
    let src_end = src_start.checked_add(row_bytes)?;
    let dst_start = y.checked_mul(width_stride)?;
    let dst_end = dst_start.checked_add(width_stride)?;
    let src_row = data.get(src_start..src_end)?;
    let dst_row = rgb.get_mut(dst_start..dst_end)?;
    Some((src_row, dst_row))
}

#[cfg(any(
    all(
        any(target_os = "macos", target_os = "windows"),
        not(target_arch = "aarch64")
    ),
    test
))]
fn reorder_rgb_row_scalar(src: &[u8], dst: &mut [u8], order: ChannelOrder) {
    match order {
        ChannelOrder::Rgba => rgba_to_rgb_scalar(src, dst),
        ChannelOrder::Bgra => bgra_to_rgb_scalar(src, dst),
    }
}

#[cfg(any(
    all(
        any(target_os = "macos", target_os = "windows"),
        not(target_arch = "aarch64")
    ),
    test
))]
fn rgba_to_rgb_scalar(src: &[u8], dst: &mut [u8]) {
    for (src, dst) in src.chunks_exact(4).zip(dst.chunks_exact_mut(3)) {
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
    }
}

#[cfg(any(
    all(
        any(target_os = "macos", target_os = "windows"),
        not(target_arch = "aarch64")
    ),
    test
))]
fn bgra_to_rgb_scalar(src: &[u8], dst: &mut [u8]) {
    for (src, dst) in src.chunks_exact(4).zip(dst.chunks_exact_mut(3)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
    }
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", test),
    target_arch = "x86_64"
))]
#[target_feature(enable = "ssse3")]
unsafe fn reorder_rgb_row_ssse3(src: &[u8], dst: &mut [u8], order: ChannelOrder) {
    use std::arch::x86_64::*;

    unsafe {
        let mask = match order {
            ChannelOrder::Rgba => {
                _mm_setr_epi8(0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, -1, -1, -1, -1)
            }
            ChannelOrder::Bgra => {
                _mm_setr_epi8(2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, -1, -1, -1, -1)
            }
        };

        let pixels = (src.len() / 4).min(dst.len() / 3);
        let simd_pixels = pixels & !3;
        for i in (0..simd_pixels).step_by(4) {
            let v = _mm_loadu_si128(src.as_ptr().add(i * 4) as *const __m128i);
            let shuffled = _mm_shuffle_epi8(v, mask);
            let dst_ptr = dst.as_mut_ptr().add(i * 3);
            let lo = _mm_cvtsi128_si64(shuffled);
            let hi = _mm_cvtsi128_si32(_mm_srli_si128(shuffled, 8));
            std::ptr::write_unaligned(dst_ptr.cast::<i64>(), lo);
            std::ptr::write_unaligned(dst_ptr.add(8).cast::<i32>(), hi);
        }

        reorder_rgb_row_scalar(&src[simd_pixels * 4..], &mut dst[simd_pixels * 3..], order);
    }
}

#[cfg(not(target_os = "linux"))]
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

    #[cfg(target_arch = "aarch64")]
    {
        // SAFETY: reorder_rgba_row_neon initializes every element of each destination row.
        let rgba = unsafe {
            pack_rows_uninit(
                data,
                height,
                bytes_per_row,
                row_bytes,
                width_stride,
                |src_row, dst_row| reorder_rgba_row_neon(src_row, dst_row, order),
            )?
        };
        RgbaImage::from_raw(width as u32, height as u32, rgba)
    }

    #[cfg(not(target_arch = "aarch64"))]
    {
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
}

fn apply_window_rounded_corners(image: RgbImage, target: &ScreenCaptureTarget) -> RgbaImage {
    round_rgb_corners(image, window_corner_radius_px(target))
}

fn round_rgb_corners(image: RgbImage, corner_radius: f32) -> RgbaImage {
    let width = image.width();
    let height = image.height();

    if corner_radius <= 0.0 {
        return image::buffer::ConvertBuffer::convert(&image);
    }

    let geom = CornerGeom {
        fw: width as f32,
        fh: height as f32,
        radius: corner_radius,
    };
    let corner_x = corner_band_px(corner_radius, width) as usize;
    let corner_y = corner_band_px(corner_radius, height) as usize;
    let width_us = width as usize;
    let height_us = height as usize;
    let src = image.into_raw();
    let mut rgba = RgbaImage::new(width, height);
    let dst = rgba.as_mut();
    let src_stride = width_us * 3;
    let dst_stride = width_us * 4;
    let right = width_us.saturating_sub(corner_x);
    let x_covers_row = corner_x >= right;

    for y in 0..height_us {
        let src_off = y * src_stride;
        let dst_off = y * dst_stride;
        let src_row = &src[src_off..src_off + src_stride];
        let dst_row = &mut dst[dst_off..dst_off + dst_stride];
        let y_in_band = y < corner_y || y.saturating_add(corner_y) >= height_us;

        if !y_in_band || corner_x == 0 {
            copy_rgb_opaque(src_row, dst_row);
            continue;
        }

        if x_covers_row {
            fill_corner_span(src_row, dst_row, 0, width_us, y, geom);
            continue;
        }

        fill_corner_span(src_row, dst_row, 0, corner_x, y, geom);
        copy_rgb_opaque(
            &src_row[corner_x * 3..right * 3],
            &mut dst_row[corner_x * 4..right * 4],
        );
        fill_corner_span(src_row, dst_row, right, width_us, y, geom);
    }

    rgba
}

#[derive(Clone, Copy)]
struct CornerGeom {
    fw: f32,
    fh: f32,
    radius: f32,
}

fn corner_band_px(radius: f32, extent: u32) -> u32 {
    if extent == 0 {
        return 0;
    }

    let rounded = radius.ceil();
    if !rounded.is_finite() || rounded >= extent as f32 {
        extent
    } else if rounded <= 0.0 {
        0
    } else {
        rounded as u32
    }
}

fn copy_rgb_opaque(src: &[u8], dst: &mut [u8]) {
    for (src_px, dst_px) in src.chunks_exact(3).zip(dst.chunks_exact_mut(4)) {
        dst_px[0] = src_px[0];
        dst_px[1] = src_px[1];
        dst_px[2] = src_px[2];
        dst_px[3] = 255;
    }
}

fn fill_corner_span(
    src_row: &[u8],
    dst_row: &mut [u8],
    x_start: usize,
    x_end: usize,
    y: usize,
    geom: CornerGeom,
) {
    let y_center = y as f32 + 0.5;
    for x in x_start..x_end {
        let src_i = x * 3;
        let dst_i = x * 4;
        let alpha = rounded_corner_alpha(x as f32 + 0.5, y_center, geom.fw, geom.fh, geom.radius);
        dst_row[dst_i] = src_row[src_i];
        dst_row[dst_i + 1] = src_row[src_i + 1];
        dst_row[dst_i + 2] = src_row[src_i + 2];
        dst_row[dst_i + 3] = alpha;
    }
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
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;

    static DEVICE: OnceLock<Option<ID3D11Device>> = OnceLock::new();

    let device = DEVICE.get_or_init(|| {
        let selected = match cap_d3d_adapter::select_capture_adapter(None) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "screenshot: no physical hardware adapter, fast path disabled");
                return None;
            }
        };

        let mut device = None;
        let result = unsafe {
            D3D11CreateDevice(
                Some(&selected.adapter),
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                Default::default(),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        };

        if let Err(e) = result {
            tracing::warn!(
                adapter = %selected.description,
                error = ?e,
                "screenshot: D3D11CreateDevice failed on pinned adapter, fast path disabled"
            );
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

#[cfg(target_os = "linux")]
pub async fn capture_screenshot(target: ScreenCaptureTarget) -> anyhow::Result<DynamicImage> {
    if uses_wayland_portal() {
        let image = capture_screenshot_wayland(&target).await?;
        return Ok(finalize_screenshot(image, &target));
    }

    let image = capture_screenshot_x11(&target).await?;
    Ok(finalize_screenshot(image, &target))
}

#[cfg(target_os = "linux")]
pub fn uses_wayland_portal() -> bool {
    prefers_wayland_portal()
}

/// Asks the screenshot portal for one screenshot and throws it away. Before
/// an app's first non-interactive screenshot the portal asks the user whether
/// to allow it, and GNOME Shell only shows that question for the focused app,
/// so this runs while Cap's picker still has focus, before it hides for the
/// real capture.
#[cfg(target_os = "linux")]
pub async fn request_wayland_screenshot_permission() -> anyhow::Result<()> {
    let screenshot = ashpd::desktop::screenshot::Screenshot::request()
        .interactive(false)
        .send()
        .await
        .context("Request Wayland screenshot from desktop portal")?
        .response()
        .context("The desktop did not allow Cap to take screenshots")?;
    let uri = screenshot.uri();
    if is_local_wayland_screenshot_uri(uri.scheme(), uri.host_str())
        && let Ok(path) = uri.to_file_path()
        && std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_file())
        && let Err(error) = std::fs::remove_file(&path)
    {
        tracing::warn!(path = %path.display(), %error, "Could not remove the permission screenshot");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn capture_screenshot_wayland(target: &ScreenCaptureTarget) -> anyhow::Result<RgbImage> {
    let display_id = wayland_screenshot_display_id(target)?;

    let displays = scap_targets::Display::list();
    let [display] = displays.as_slice() else {
        return Err(anyhow!(
            "Wayland screenshot portal cannot safely isolate the selected display"
        ));
    };

    if display.id() != *display_id {
        return Err(anyhow!(
            "Wayland screenshot portal cannot safely isolate the selected display"
        ));
    }

    let display_size = display
        .physical_size()
        .ok_or_else(|| anyhow!("Selected Wayland display size unavailable"))?;
    let (width, height) =
        checked_wayland_display_size(display_size.width(), display_size.height())?;
    let logical_size = display
        .logical_size()
        .ok_or_else(|| anyhow!("Selected Wayland display logical size unavailable"))?;
    let crop = checked_wayland_screenshot_crop(target, width, height, logical_size)?;

    let screenshot = ashpd::desktop::screenshot::Screenshot::request()
        .interactive(false)
        .send()
        .await
        .context("Request Wayland screenshot from desktop portal")?
        .response()
        .context("Wayland screenshot portal request was cancelled or rejected")?;

    let uri = screenshot.uri();
    if !is_local_wayland_screenshot_uri(uri.scheme(), uri.host_str()) {
        return Err(anyhow!(
            "Wayland screenshot portal returned a non-local file URI"
        ));
    }

    let path = uri
        .to_file_path()
        .map_err(|()| anyhow!("Wayland screenshot portal returned a non-local file URI"))?;

    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .context("Read Wayland screenshot portal file metadata")?;
    if !metadata.file_type().is_file() {
        return Err(anyhow!(
            "Wayland screenshot portal returned a non-regular file"
        ));
    }

    let image = tokio::task::spawn_blocking(move || {
        use std::os::unix::fs::MetadataExt;

        let file = std::fs::File::open(&path).context("Open Wayland screenshot portal image")?;
        let opened_metadata = file
            .metadata()
            .context("Read opened Wayland screenshot portal file metadata")?;
        if !opened_metadata.file_type().is_file()
            || opened_metadata.dev() != metadata.dev()
            || opened_metadata.ino() != metadata.ino()
        {
            return Err(anyhow!(
                "Wayland screenshot portal image changed before it could be read"
            ));
        }

        image::ImageReader::new(std::io::BufReader::new(file))
            .with_guessed_format()
            .context("Identify Wayland screenshot portal image format")?
            .decode()
            .map(DynamicImage::into_rgb8)
            .context("Decode Wayland screenshot portal image")
    })
    .await
    .context("Wayland screenshot image task failed")??;

    if !wayland_screenshot_matches_display(image.width(), image.height(), width, height) {
        return Err(anyhow!(
            "Wayland screenshot contains content outside the selected display"
        ));
    }

    match crop {
        Some((x, y, width, height)) => {
            Ok(image::imageops::crop_imm(&image, x, y, width, height).to_image())
        }
        None => Ok(image),
    }
}

#[cfg(target_os = "linux")]
fn wayland_screenshot_display_id(
    target: &ScreenCaptureTarget,
) -> anyhow::Result<&scap_targets::DisplayId> {
    match target {
        ScreenCaptureTarget::Display { id } => Ok(id),
        ScreenCaptureTarget::Area { screen, .. } => Ok(screen),
        ScreenCaptureTarget::Window { .. } => Err(anyhow!(
            "Wayland screenshot portal cannot safely isolate the selected window"
        )),
        ScreenCaptureTarget::CameraOnly => {
            Err(anyhow!("Camera-only not supported for screenshots"))
        }
    }
}

#[cfg(target_os = "linux")]
fn is_local_wayland_screenshot_uri(scheme: &str, host: Option<&str>) -> bool {
    scheme == "file" && (host.is_none() || host == Some("localhost"))
}

#[cfg(target_os = "linux")]
fn wayland_screenshot_matches_display(
    image_width: u32,
    image_height: u32,
    display_width: u32,
    display_height: u32,
) -> bool {
    image_width == display_width && image_height == display_height
}

#[cfg(target_os = "linux")]
fn checked_wayland_display_size(width: f64, height: f64) -> anyhow::Result<(u32, u32)> {
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width.fract() != 0.0
        || height.fract() != 0.0
        || width > f64::from(u32::MAX)
        || height > f64::from(u32::MAX)
    {
        return Err(anyhow!("Selected Wayland display size is invalid"));
    }

    Ok((width as u32, height as u32))
}

#[cfg(target_os = "linux")]
fn checked_wayland_screenshot_crop(
    target: &ScreenCaptureTarget,
    image_width: u32,
    image_height: u32,
    logical_size: scap_targets::bounds::LogicalSize,
) -> anyhow::Result<Option<(u32, u32, u32, u32)>> {
    let ScreenCaptureTarget::Area { bounds, .. } = target else {
        return Ok(None);
    };

    let x = bounds.position().x();
    let y = bounds.position().y();
    let width = bounds.size().width();
    let height = bounds.size().height();
    let right = x + width;
    let bottom = y + height;

    if !logical_size.width().is_finite()
        || !logical_size.height().is_finite()
        || logical_size.width() <= 0.0
        || logical_size.height() <= 0.0
        || image_width == 0
        || image_height == 0
    {
        return Err(anyhow!("Selected Wayland display scale is invalid"));
    }

    if ![x, y, width, height, right, bottom]
        .iter()
        .all(|value| value.is_finite())
        || x < 0.0
        || y < 0.0
        || width <= 0.0
        || height <= 0.0
        || right > logical_size.width()
        || bottom > logical_size.height()
    {
        return Err(anyhow!(
            "Selected Wayland screenshot area exceeds the selected display"
        ));
    }

    let scale_x = f64::from(image_width) / logical_size.width();
    let scale_y = f64::from(image_height) / logical_size.height();
    let x = (x * scale_x).ceil() as u32;
    let y = (y * scale_y).ceil() as u32;
    let right = (right * scale_x).floor() as u32;
    let bottom = (bottom * scale_y).floor() as u32;

    if right <= x || bottom <= y {
        return Err(anyhow!("Selected Wayland screenshot area is empty"));
    }

    Ok(Some((x, y, right - x, bottom - y)))
}

#[cfg(not(target_os = "linux"))]
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
                    .map_err(|e| anyhow!("Failed to get capture item: {e:?}"))
            }
            ScreenCaptureTarget::Window { id } => {
                let window = scap_targets::Window::from_id(&id)
                    .ok_or_else(|| anyhow!("Window not found"))?;
                window
                    .raw_handle()
                    .try_as_capture_item()
                    .map_err(|e| anyhow!("Failed to get capture item: {e:?}"))
            }
            ScreenCaptureTarget::Area { screen, .. } => {
                let display = scap_targets::Display::from_id(&screen)
                    .ok_or_else(|| anyhow!("Display not found"))?;
                display
                    .raw_handle()
                    .try_as_capture_item()
                    .map_err(|e| anyhow!("Failed to get capture item: {e:?}"))
            }
            ScreenCaptureTarget::CameraOnly => {
                return Err(anyhow!("Camera-only not supported for screenshots"));
            }
        };

        let item = match item {
            Ok(item) => item,
            Err(error) => {
                let fallback_image = gdi_or_error(&target, error)?;
                return crop_area_if_needed(fallback_image, &target, false)
                    .map(|image| finalize_screenshot(image, &target));
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

#[cfg(not(target_os = "linux"))]
fn crop_area_if_needed(
    image: RgbImage,
    target: &ScreenCaptureTarget,
    skip_crop: bool,
) -> anyhow::Result<RgbImage> {
    if let ScreenCaptureTarget::Area { bounds, screen } = target {
        if skip_crop {
            return Ok(image);
        }

        #[cfg(target_os = "linux")]
        let _ = screen;

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
        let scale = 1.0;

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

/// `Video::alloc` asks swscale for 32-byte lines. A row that is already a multiple
/// of that is tightly packed, matching the buffer swscale would allocate itself.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const SCREENSHOT_RGB_STRIDE_ALIGN: usize = 32;

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct ScreenshotScaler {
    context: ffmpeg::software::scaling::context::Context,
    src_format: ffmpeg::format::Pixel,
    src_width: u32,
    src_height: u32,
    dst_format: ffmpeg::format::Pixel,
    dst_width: u32,
    dst_height: u32,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl ScreenshotScaler {
    fn matches(&self, frame: &ffmpeg::frame::Video) -> bool {
        self.src_format == frame.format()
            && self.src_width == frame.width()
            && self.src_height == frame.height()
            && self.dst_format == ffmpeg::format::Pixel::RGB24
            && self.dst_width == frame.width()
            && self.dst_height == frame.height()
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct ScreenshotScalerSlot {
    scaler: Option<ScreenshotScaler>,
    #[cfg(test)]
    builds: u64,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
thread_local! {
    static SCREENSHOT_SCALER: RefCell<ScreenshotScalerSlot> = const {
        RefCell::new(ScreenshotScalerSlot {
            scaler: None,
            #[cfg(test)]
            builds: 0,
        })
    };
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn with_screenshot_scaler<R>(
    frame: &ffmpeg::frame::Video,
    body: impl FnOnce(&mut ffmpeg::software::scaling::context::Context) -> R,
) -> anyhow::Result<R> {
    SCREENSHOT_SCALER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .scaler
            .as_ref()
            .is_none_or(|scaler| !scaler.matches(frame))
        {
            let context = ffmpeg::software::scaling::context::Context::get(
                frame.format(),
                frame.width(),
                frame.height(),
                ffmpeg::format::Pixel::RGB24,
                frame.width(),
                frame.height(),
                ffmpeg::software::scaling::flag::Flags::BILINEAR,
            )
            .context("Failed to create scaler")?;
            slot.scaler = Some(ScreenshotScaler {
                context,
                src_format: frame.format(),
                src_width: frame.width(),
                src_height: frame.height(),
                dst_format: ffmpeg::format::Pixel::RGB24,
                dst_width: frame.width(),
                dst_height: frame.height(),
            });
            #[cfg(test)]
            {
                slot.builds = slot.builds.saturating_add(1);
            }
        }
        let scaler = slot
            .scaler
            .as_mut()
            .expect("screenshot scaler is inserted before use");
        Ok(body(&mut scaler.context))
    })
}

#[cfg(test)]
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn clear_screenshot_scaler_cache() {
    SCREENSHOT_SCALER.with(|slot| {
        *slot.borrow_mut() = ScreenshotScalerSlot {
            scaler: None,
            builds: 0,
        };
    });
}

#[cfg(test)]
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn screenshot_scaler_builds() -> u64 {
    SCREENSHOT_SCALER.with(|slot| slot.borrow().builds)
}

/// Returns `None` when the geometry is unusable or SSSE3 is unavailable, so the
/// caller can fall back to swscale.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn bgrx_plane_to_rgb24(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 {
        return None;
    }
    let row_bytes = width.checked_mul(4)?;
    let dst_stride = width.checked_mul(3)?;
    if src_stride < row_bytes {
        return None;
    }
    let src_needed = (height - 1)
        .checked_mul(src_stride)?
        .checked_add(row_bytes)?;
    if src.len() < src_needed {
        return None;
    }
    if !std::is_x86_feature_detected!("ssse3") {
        return None;
    }
    let dst_len = height.checked_mul(dst_stride)?;
    let mut dst = vec![0u8; dst_len];
    // SAFETY: the checks above keep every source row's `width * 4` bytes and every
    // destination row's `width * 3` bytes inside the two buffers, and SSSE3 is present.
    unsafe { bgrx_plane_to_rgb24_ssse3(src, src_stride, &mut dst, width, height) };
    Some(dst)
}

/// # Safety
///
/// `src` holds at least `(height - 1) * src_stride + width * 4` bytes, `src_stride >= width * 4`,
/// and `dst` holds `height * width * 3` bytes. Those products do not overflow. SSSE3 is enabled.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[target_feature(enable = "ssse3")]
unsafe fn bgrx_plane_to_rgb24_ssse3(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    width: usize,
    height: usize,
) {
    use std::arch::x86_64::*;

    unsafe {
        // B,G,R,x → R,G,B. The control bytes with the high bit set zero the hole
        // after each group of four pixels (12 RGB bytes in a 16-byte register).
        let mask = _mm_setr_epi8(2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, -1, -1, -1, -1);
        let dst_stride = width * 3;
        for y in 0..height {
            let srow = src.as_ptr().add(y * src_stride);
            let drow = dst.as_mut_ptr().add(y * dst_stride);
            let simd = width & !15;
            let mut x = 0;
            while x < simd {
                let s0 = _mm_shuffle_epi8(_mm_loadu_si128(srow.add(x * 4) as *const __m128i), mask);
                let s1 = _mm_shuffle_epi8(
                    _mm_loadu_si128(srow.add(x * 4 + 16) as *const __m128i),
                    mask,
                );
                let s2 = _mm_shuffle_epi8(
                    _mm_loadu_si128(srow.add(x * 4 + 32) as *const __m128i),
                    mask,
                );
                let s3 = _mm_shuffle_epi8(
                    _mm_loadu_si128(srow.add(x * 4 + 48) as *const __m128i),
                    mask,
                );
                // Each shuffle leaves a 4-byte hole. Slide the next group's bytes
                // into that hole so the store is 16 packed RGB bytes, not 12.
                let out = drow.add(x * 3);
                let out0 = _mm_or_si128(s0, _mm_slli_si128(s1, 12));
                let out1 = _mm_or_si128(_mm_srli_si128(s1, 4), _mm_slli_si128(s2, 8));
                let out2 = _mm_or_si128(_mm_srli_si128(s2, 8), _mm_slli_si128(s3, 4));
                _mm_storeu_si128(out as *mut __m128i, out0);
                _mm_storeu_si128(out.add(16) as *mut __m128i, out1);
                _mm_storeu_si128(out.add(32) as *mut __m128i, out2);
                x += 16;
            }
            for i in simd..width {
                let s = srow.add(i * 4);
                let d = drow.add(i * 3);
                *d = *s.add(2);
                *d.add(1) = *s.add(1);
                *d.add(2) = *s;
            }
        }
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn try_convert_bgrx_screenshot_ssse3(
    frame: &ffmpeg::frame::Video,
) -> anyhow::Result<Option<RgbImage>> {
    if !matches!(
        frame.format(),
        ffmpeg::format::Pixel::BGRZ | ffmpeg::format::Pixel::BGRA
    ) {
        return Ok(None);
    }
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    if width == 0 || height == 0 {
        return Ok(None);
    }
    // `Video::stride` casts linesize to usize. A bottom-up (negative) stride would
    // wrap and `data()` would build a slice past the plane, so read the sign first.
    // SAFETY: `frame` points at a live AVFrame for this call.
    let (linesize, data_ptr) = unsafe {
        let raw = frame.as_ptr();
        ((*raw).linesize[0], (*raw).data[0])
    };
    if linesize <= 0 || data_ptr.is_null() {
        return Ok(None);
    }
    let src_stride = linesize as usize;
    if src_stride.checked_mul(height).is_none() {
        return Ok(None);
    }
    let Some(rgb) = bgrx_plane_to_rgb24(frame.data(0), src_stride, width, height) else {
        return Ok(None);
    };
    RgbImage::from_raw(frame.width(), frame.height(), rgb)
        .map(Some)
        .ok_or_else(|| anyhow!("Failed to create image buffer"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn convert_ffmpeg_frame_to_image(frame: &ffmpeg::frame::Video) -> anyhow::Result<RgbImage> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    if let Some(image) = try_convert_bgrx_screenshot_ssse3(frame)? {
        return Ok(image);
    }
    convert_ffmpeg_frame_via_swscale(frame)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn convert_ffmpeg_frame_via_swscale(frame: &ffmpeg::frame::Video) -> anyhow::Result<RgbImage> {
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    let row_bytes = width
        .checked_mul(3)
        .context("screenshot dimensions overflow")?;
    let image_bytes = height
        .checked_mul(row_bytes)
        .context("screenshot dimensions overflow")?;
    if width == 0 || height == 0 {
        return RgbImage::from_raw(frame.width(), frame.height(), Vec::new())
            .ok_or_else(|| anyhow!("Failed to create image buffer"));
    }

    if row_bytes % SCREENSHOT_RGB_STRIDE_ALIGN == 0
        && let Some(image) = scale_screenshot_into_tight_rgb(frame, row_bytes, image_bytes)?
    {
        return Ok(image);
    }

    let mut rgb_frame = ffmpeg::frame::Video::empty();
    with_screenshot_scaler(frame, |scaler| scaler.run(frame, &mut rgb_frame))?
        .context("Failed to scale frame")?;
    pack_rgb_frame(&rgb_frame)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn scale_screenshot_into_tight_rgb(
    frame: &ffmpeg::frame::Video,
    row_bytes: usize,
    image_bytes: usize,
) -> anyhow::Result<Option<RgbImage>> {
    let mut image = vec![0u8; image_bytes];
    let mut rgb_frame = ffmpeg::frame::Video::empty();
    rgb_frame.set_format(ffmpeg::format::Pixel::RGB24);
    rgb_frame.set_width(frame.width());
    rgb_frame.set_height(frame.height());
    let linesize = libc::c_int::try_from(row_bytes).context("screenshot stride exceeds c_int")?;
    // SAFETY: plane 0 aliases `image` and the frame does not own it (`buf[0]` stays
    // null, so av_frame_free will not release it). `image` outlives `rgb_frame`.
    // The stride equals width*3 and is a multiple of Video::alloc's 32-byte
    // alignment, so this is the same layout swscale uses for its own buffer.
    unsafe {
        let raw = rgb_frame.as_mut_ptr();
        (*raw).data[0] = image.as_mut_ptr();
        (*raw).linesize[0] = linesize;
    }

    with_screenshot_scaler(frame, |scaler| scaler.run(frame, &mut rgb_frame))?
        .context("Failed to scale frame")?;

    let stride = rgb_frame.stride(0);
    let same_buffer = std::ptr::eq(rgb_frame.data(0).as_ptr(), image.as_ptr());
    drop(rgb_frame);
    if stride != row_bytes || !same_buffer {
        return Ok(None);
    }

    RgbImage::from_raw(frame.width(), frame.height(), image)
        .map(Some)
        .ok_or_else(|| anyhow!("Failed to create image buffer"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn pack_rgb_frame(rgb_frame: &ffmpeg::frame::Video) -> anyhow::Result<RgbImage> {
    let width = rgb_frame.width() as usize;
    let height = rgb_frame.height() as usize;
    let dst_stride = width
        .checked_mul(3)
        .context("screenshot dimensions overflow")?;
    let src_stride = rgb_frame.stride(0);

    if src_stride < dst_stride {
        return Err(anyhow!(
            "Source stride ({src_stride}) is less than destination stride ({dst_stride}); width={width}, height={height}"
        ));
    }

    let buf_len = height
        .checked_mul(dst_stride)
        .context("screenshot dimensions overflow")?;
    let mut img_buffer = vec![0u8; buf_len];
    let src = rgb_frame.data(0);
    if src_stride == dst_stride {
        let copy_len = height
            .checked_mul(src_stride)
            .context("screenshot dimensions overflow")?;
        let src = src
            .get(..copy_len)
            .ok_or_else(|| anyhow!("Failed to create image buffer"))?;
        img_buffer.copy_from_slice(src);
    } else {
        for y in 0..height {
            let start = y * src_stride;
            let end = start + dst_stride;
            let dst_start = y * dst_stride;
            let src_row = src
                .get(start..end)
                .ok_or_else(|| anyhow!("Failed to create image buffer"))?;
            img_buffer[dst_start..dst_start + dst_stride].copy_from_slice(src_row);
        }
    }

    RgbImage::from_raw(rgb_frame.width(), rgb_frame.height(), img_buffer)
        .ok_or_else(|| anyhow!("Failed to create image buffer"))
}

#[cfg(target_os = "linux")]
async fn capture_screenshot_x11(target: &ScreenCaptureTarget) -> anyhow::Result<RgbImage> {
    let target = target.clone();
    tokio::task::spawn_blocking(move || capture_screenshot_x11_blocking(&target))
        .await
        .context("Linux screenshot task failed")?
}

#[cfg(target_os = "linux")]
fn capture_screenshot_x11_blocking(target: &ScreenCaptureTarget) -> anyhow::Result<RgbImage> {
    let (display_name, x, y, width, height) = linux_capture_geometry(target)?;
    let config = X11InputConfig {
        display_name,
        window_id: match target {
            ScreenCaptureTarget::Window { id } => {
                Some(id.to_string().parse().context("Invalid X11 window ID")?)
            }
            _ => None,
        },
        x,
        y,
        width,
        height,
        fps: 1,
        show_cursor: false,
    };
    let mut grabber = X11Grabber::new(&config)?;
    let frame = grabber.grab()?;
    convert_ffmpeg_frame_to_image(&frame)
}

#[cfg(target_os = "linux")]
fn linux_capture_geometry(
    target: &ScreenCaptureTarget,
) -> anyhow::Result<(String, i32, i32, u32, u32)> {
    let display_name = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string());
    match target {
        ScreenCaptureTarget::Display { id } => {
            let display =
                scap_targets::Display::from_id(id).ok_or_else(|| anyhow!("Display not found"))?;
            let position = display
                .raw_handle()
                .physical_position()
                .ok_or_else(|| anyhow!("Display position unavailable"))?;
            let size = display
                .physical_size()
                .ok_or_else(|| anyhow!("Display size unavailable"))?;
            let (x, y, width, height) = x11_capture_rect(
                position.x(),
                position.y(),
                size.width(),
                size.height(),
                None,
            )?;
            Ok((display_name, x, y, width, height))
        }
        ScreenCaptureTarget::Window { id } => {
            let window =
                scap_targets::Window::from_id(id).ok_or_else(|| anyhow!("Window not found"))?;
            let bounds = window
                .raw_handle()
                .physical_bounds()
                .ok_or_else(|| anyhow!("Window bounds unavailable"))?;
            Ok((
                display_name,
                0,
                0,
                bounds.size().width() as u32,
                bounds.size().height() as u32,
            ))
        }
        ScreenCaptureTarget::Area { screen, bounds } => {
            let display = scap_targets::Display::from_id(screen)
                .ok_or_else(|| anyhow!("Display not found"))?;
            let position = display
                .raw_handle()
                .physical_position()
                .ok_or_else(|| anyhow!("Display position unavailable"))?;
            let size = display
                .physical_size()
                .ok_or_else(|| anyhow!("Display size unavailable"))?;
            let crop = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );
            let (x, y, width, height) = x11_capture_rect(
                position.x(),
                position.y(),
                size.width(),
                size.height(),
                Some(crop),
            )?;
            Ok((display_name, x, y, width, height))
        }
        ScreenCaptureTarget::CameraOnly => {
            Err(anyhow!("Camera-only not supported for screenshots"))
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod wayland_screenshot_tests {
    use super::*;
    use scap_targets::bounds::{LogicalBounds, LogicalPosition, LogicalSize};

    fn area_target(x: f64, y: f64, width: f64, height: f64) -> ScreenCaptureTarget {
        ScreenCaptureTarget::Area {
            screen: "0".parse().expect("valid display id"),
            bounds: LogicalBounds::new(LogicalPosition::new(x, y), LogicalSize::new(width, height)),
        }
    }

    #[test]
    fn only_local_file_screenshot_uris_are_accepted() {
        assert!(is_local_wayland_screenshot_uri("file", None));
        assert!(is_local_wayland_screenshot_uri("file", Some("localhost")));
        assert!(!is_local_wayland_screenshot_uri("https", None));
        assert!(!is_local_wayland_screenshot_uri("https", Some("localhost")));
        assert!(!is_local_wayland_screenshot_uri("file", Some("remote")));
    }

    #[test]
    fn valid_wayland_display_dimensions_must_be_exact_positive_pixels() {
        assert_eq!(
            checked_wayland_display_size(1920.0, 1080.0).expect("valid display"),
            (1920, 1080)
        );

        for (width, height) in [
            (0.0, 1080.0),
            (1920.0, -1.0),
            (1920.5, 1080.0),
            (f64::NAN, 1080.0),
            (1920.0, f64::INFINITY),
            (f64::from(u32::MAX) + 1.0, 1080.0),
        ] {
            assert!(checked_wayland_display_size(width, height).is_err());
        }
    }

    #[test]
    fn screenshot_must_match_the_selected_display_exactly() {
        assert!(wayland_screenshot_matches_display(1920, 1080, 1920, 1080));
        assert!(!wayland_screenshot_matches_display(3840, 1080, 1920, 1080));
        assert!(!wayland_screenshot_matches_display(1920, 2160, 1920, 1080));
        assert!(!wayland_screenshot_matches_display(1280, 720, 1920, 1080));
    }

    #[test]
    fn selected_wayland_area_is_cropped_exactly() {
        let target = area_target(100.0, 120.0, 640.0, 360.0);
        assert_eq!(
            checked_wayland_screenshot_crop(&target, 1920, 1080, LogicalSize::new(1920.0, 1080.0))
                .expect("valid crop"),
            Some((100, 120, 640, 360))
        );
    }

    #[test]
    fn scaled_wayland_area_uses_physical_screenshot_pixels() {
        let target = area_target(100.0, 120.0, 400.0, 200.0);
        assert_eq!(
            checked_wayland_screenshot_crop(&target, 1920, 1080, LogicalSize::new(960.0, 540.0),)
                .unwrap(),
            Some((200, 240, 800, 400))
        );
        assert_eq!(
            checked_wayland_screenshot_crop(&target, 1920, 1080, LogicalSize::new(1280.0, 720.0),)
                .unwrap(),
            Some((150, 180, 600, 300))
        );
    }

    #[test]
    fn scaled_wayland_area_rejects_bounds_outside_logical_display() {
        let target = area_target(950.0, 0.0, 20.0, 10.0);
        assert!(
            checked_wayland_screenshot_crop(&target, 1920, 1080, LogicalSize::new(960.0, 540.0),)
                .is_err()
        );
    }

    #[test]
    fn fractional_wayland_areas_never_include_pixels_outside_selection() {
        let target = area_target(10.25, 20.25, 30.75, 40.75);
        assert_eq!(
            checked_wayland_screenshot_crop(&target, 1920, 1080, LogicalSize::new(1920.0, 1080.0))
                .expect("valid crop"),
            Some((11, 21, 30, 40))
        );
    }

    #[test]
    fn out_of_bounds_or_non_finite_wayland_areas_are_rejected() {
        for (x, y, width, height) in [
            (-1.0, 0.0, 10.0, 10.0),
            (0.0, -1.0, 10.0, 10.0),
            (1915.0, 0.0, 10.0, 10.0),
            (0.0, 1075.0, 10.0, 10.0),
            (0.0, 0.0, 0.0, 10.0),
            (0.0, 0.0, 10.0, -1.0),
            (f64::NAN, 0.0, 10.0, 10.0),
            (0.0, 0.0, f64::INFINITY, 10.0),
            (f64::MAX, 0.0, f64::MAX, 10.0),
        ] {
            let target = area_target(x, y, width, height);
            assert!(
                checked_wayland_screenshot_crop(
                    &target,
                    1920,
                    1080,
                    LogicalSize::new(1920.0, 1080.0)
                )
                .is_err()
            );
        }
    }

    #[test]
    fn too_small_fractional_wayland_areas_are_rejected() {
        let target = area_target(10.25, 20.25, 0.25, 0.25);
        assert!(
            checked_wayland_screenshot_crop(&target, 1920, 1080, LogicalSize::new(1920.0, 1080.0))
                .is_err()
        );
    }

    #[test]
    fn wayland_window_screenshots_are_rejected_before_portal_capture() {
        let target = ScreenCaptureTarget::Window {
            id: "0".parse().expect("valid window id"),
        };
        assert!(wayland_screenshot_display_id(&target).is_err());
    }

    #[test]
    fn wayland_camera_only_screenshots_are_rejected_before_portal_capture() {
        assert!(wayland_screenshot_display_id(&ScreenCaptureTarget::CameraOnly).is_err());
    }
}

#[cfg(test)]
mod screenshot_pixel_tests {
    use super::*;

    fn paint(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        let mut out = vec![0u8; len];
        for byte in &mut out {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            *byte = (state >> 16) as u8;
        }
        out
    }

    fn assert_bytes_eq(got: &[u8], expected: &[u8], label: &str) {
        assert_eq!(got.len(), expected.len(), "{label} length");
        let mismatch = got
            .iter()
            .zip(expected.iter())
            .position(|(got_byte, expected_byte)| got_byte != expected_byte);
        if let Some(index) = mismatch {
            panic!(
                "{label} mismatch at {index}: got {:02x} expected {:02x}",
                got[index], expected[index]
            );
        }
    }

    fn reference_rgb(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
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

        Some(rgb)
    }

    fn scalar_rgb(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
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
            let (src_row, dst_row) =
                rgb_row_pair(data, &mut rgb, y, bytes_per_row, row_bytes, width_stride)?;
            reorder_rgb_row_scalar(src_row, dst_row, order);
        }
        Some(rgb)
    }

    fn rgb_cases() -> Vec<(usize, usize, usize)> {
        let mut cases = Vec::new();
        let widths = [
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 47, 48, 49, 63, 64, 65, 191,
            1920, 1921, 2879,
        ];
        let heights = [0, 1, 2, 3, 5, 7];
        let pads = [0usize, 1, 7, 32];
        for width in widths {
            for height in heights {
                for pad in pads {
                    cases.push((width, height, pad));
                }
            }
        }
        cases.push((1920, 1080, 0));
        cases.push((1920, 1080, 64));
        cases.push((1919, 17, 3));
        cases.push((1, 1080, 0));
        cases
    }

    fn assert_rgb_path_matches_original(
        path: &str,
        packed: Option<Vec<u8>>,
        expected: &Option<Vec<u8>>,
        label: &str,
    ) {
        match (packed.as_deref(), expected.as_deref()) {
            (Some(got), Some(expected)) => {
                assert_bytes_eq(got, expected, &format!("{path} {label}"));
            }
            (None, None) => {}
            _ => panic!(
                "{path} {label} presence got {} expected {}",
                packed.is_some(),
                expected.is_some()
            ),
        }
    }

    #[test]
    fn rgb_dispatch_matches_original_for_both_channel_orders() {
        for (width, height, pad) in rgb_cases() {
            let stride = width * 4 + pad;
            let data = paint(
                height * stride + 8,
                (width as u32).wrapping_mul(19).wrapping_add(height as u32),
            );
            for order in [ChannelOrder::Rgba, ChannelOrder::Bgra] {
                let label = format!("{width}x{height} stride {stride} {order:?}");
                let expected = reference_rgb(&data, width, height, stride, order);
                let got = rgb_from_rgba(&data, width, height, stride, order)
                    .map(|image| image.into_raw());
                assert_rgb_path_matches_original("dispatch", got, &expected, &label);
            }
        }
    }

    #[test]
    fn rgb_scalar_fallback_matches_original_for_both_channel_orders() {
        for (width, height, pad) in rgb_cases() {
            let stride = width * 4 + pad;
            let data = paint(
                height * stride + 8,
                (width as u32).wrapping_mul(23).wrapping_add(pad as u32),
            );
            for order in [ChannelOrder::Rgba, ChannelOrder::Bgra] {
                let label = format!("{width}x{height} stride {stride} {order:?}");
                let expected = reference_rgb(&data, width, height, stride, order);
                let got = scalar_rgb(&data, width, height, stride, order);
                assert_rgb_path_matches_original("scalar", got, &expected, &label);
            }
        }
    }

    #[cfg(target_arch = "x86_64")]
    fn ssse3_rgb(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
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
            let (src_row, dst_row) =
                rgb_row_pair(data, &mut rgb, y, bytes_per_row, row_bytes, width_stride)?;
            unsafe {
                reorder_rgb_row_ssse3(src_row, dst_row, order);
            }
        }
        Some(rgb)
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn rgb_ssse3_matches_original_including_scalar_tail() {
        if !std::is_x86_feature_detected!("ssse3") {
            eprintln!("ssse3 unavailable, skipping shuffled rgb path");
            return;
        }
        for (width, height, pad) in rgb_cases() {
            let stride = width * 4 + pad;
            let data = paint(
                height * stride + 8,
                (width as u32).wrapping_mul(29).wrapping_add(height as u32),
            );
            for order in [ChannelOrder::Rgba, ChannelOrder::Bgra] {
                let label = format!("{width}x{height} stride {stride} {order:?}");
                let expected = reference_rgb(&data, width, height, stride, order);
                let got = ssse3_rgb(&data, width, height, stride, order);
                assert_rgb_path_matches_original("ssse3", got, &expected, &label);
            }
        }
    }

    #[test]
    fn rgb_packing_rejects_undersized_input() {
        assert!(rgb_from_rgba(&[0, 1, 2, 3], 2, 1, 4, ChannelOrder::Rgba).is_none());
        assert!(rgb_from_rgba(&[0, 1, 2, 3], 1, 2, 4, ChannelOrder::Bgra).is_none());
        assert!(rgb_from_rgba(&[0, 1, 2, 3, 4, 5, 6], 1, 1, 8, ChannelOrder::Rgba).is_none());
        let image = rgb_from_rgba(&[10, 20, 30, 40, 1, 2, 3, 4], 1, 1, 8, ChannelOrder::Bgra)
            .expect("padded row");
        assert_eq!(image.as_raw(), &[30, 20, 10]);
    }

    #[cfg(target_arch = "aarch64")]
    #[test]
    fn rgb_neon_matches_scalar_including_tail() {
        for (width, height, pad) in rgb_cases() {
            let stride = width * 4 + pad;
            let data = paint(
                height * stride + 8,
                (width as u32).wrapping_mul(31).wrapping_add(pad as u32),
            );
            for order in [ChannelOrder::Rgba, ChannelOrder::Bgra] {
                let label = format!("{width}x{height} stride {stride} {order:?}");
                let expected = scalar_rgb(&data, width, height, stride, order);
                let got = rgb_from_rgba(&data, width, height, stride, order)
                    .map(|image| image.into_raw());
                assert_rgb_path_matches_original("neon", got, &expected, &label);
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn reference_rgba(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        if bytes_per_row < row_bytes {
            return None;
        }
        let required_len = height.checked_mul(bytes_per_row)?;
        if data.len() < required_len {
            return None;
        }
        let mut rgba = vec![0u8; height.checked_mul(row_bytes)?];
        for y in 0..height {
            let src_row = data.get(y * bytes_per_row..y * bytes_per_row + row_bytes)?;
            let dst_row = rgba.get_mut(y * row_bytes..(y + 1) * row_bytes)?;
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
        Some(rgba)
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn rgba_dispatch_matches_original_for_both_channel_orders() {
        for (width, height, pad) in rgb_cases() {
            let stride = width * 4 + pad;
            let data = paint(
                height * stride + 8,
                (width as u32).wrapping_mul(37).wrapping_add(height as u32),
            );
            for order in [ChannelOrder::Rgba, ChannelOrder::Bgra] {
                let label = format!("{width}x{height} stride {stride} {order:?}");
                let expected = reference_rgba(&data, width, height, stride, order);
                let got = rgba_from_raw(&data, width, height, stride, order)
                    .map(|image| image.into_raw());
                assert_rgb_path_matches_original("rgba", got, &expected, &label);
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn rgba_packing_rejects_undersized_input() {
        assert!(rgba_from_raw(&[0, 1, 2, 3], 2, 1, 4, ChannelOrder::Rgba).is_none());
        assert!(rgba_from_raw(&[0, 1, 2, 3], 1, 2, 4, ChannelOrder::Bgra).is_none());
        assert!(rgba_from_raw(&[0, 1, 2, 3, 4, 5, 6], 1, 1, 8, ChannelOrder::Rgba).is_none());
        let image = rgba_from_raw(&[10, 20, 30, 40, 1, 2, 3, 4], 1, 1, 8, ChannelOrder::Bgra)
            .expect("padded row");
        assert_eq!(image.as_raw(), &[30, 20, 10, 40]);
        let empty = rgba_from_raw(&[], 0, 0, 0, ChannelOrder::Bgra).expect("empty image");
        assert!(empty.as_raw().is_empty());
    }

    fn rgb_image(width: u32, height: u32, seed: u32) -> RgbImage {
        let buf = paint((width as usize) * (height as usize) * 3, seed);
        RgbImage::from_raw(width, height, buf).expect("rgb image")
    }

    fn reference_round(image: &RgbImage, radius: f32) -> RgbaImage {
        if radius <= 0.0 {
            return image::buffer::ConvertBuffer::convert(image);
        }

        let width = image.width();
        let height = image.height();
        let fw = width as f32;
        let fh = height as f32;
        let mut rgba = RgbaImage::new(width, height);
        for (x, y, rgb_pixel) in image.enumerate_pixels() {
            let alpha = rounded_corner_alpha(x as f32 + 0.5, y as f32 + 0.5, fw, fh, radius);
            rgba.put_pixel(
                x,
                y,
                image::Rgba([rgb_pixel[0], rgb_pixel[1], rgb_pixel[2], alpha]),
            );
        }
        rgba
    }

    fn assert_corners(width: u32, height: u32, radius: f32) {
        let image = rgb_image(width, height, width.wrapping_mul(17).wrapping_add(height));
        let expected = reference_round(&image, radius);
        let got = round_rgb_corners(image, radius);
        assert_bytes_eq(
            got.as_raw(),
            expected.as_raw(),
            &format!("corners {width}x{height} radius {radius}"),
        );
    }

    #[test]
    fn rounded_corners_match_original_for_varied_sizes() {
        let sizes = [
            (0, 0),
            (0, 4),
            (4, 0),
            (1, 1),
            (1, 2),
            (2, 1),
            (2, 2),
            (3, 3),
            (3, 5),
            (5, 3),
            (7, 9),
            (8, 8),
            (15, 17),
            (16, 9),
            (31, 20),
            (64, 63),
            (100, 50),
            (127, 13),
            (320, 180),
        ];
        let base_radii = [-1.0, 0.0, 0.25, 0.5, 1.0, 1.5, 2.2, 8.0, 10.5, 12.0];
        for (width, height) in sizes {
            for radius in base_radii {
                assert_corners(width, height, radius);
            }
            let min_dim = width.min(height) as f32;
            let max_dim = width.max(height) as f32;
            assert_corners(width, height, min_dim / 2.0);
            assert_corners(width, height, min_dim / 2.0 + 0.5);
            assert_corners(width, height, max_dim + 10.0);
        }
        assert_corners(1920, 1080, 0.0);
        assert_corners(1920, 1080, 12.0);
        assert_corners(1919, 17, 6.5);
    }

    #[test]
    fn rounded_corners_match_original_for_non_finite_radius() {
        for (width, height) in [(1, 1), (2, 3), (8, 5), (17, 9)] {
            assert_corners(width, height, f32::INFINITY);
            assert_corners(width, height, f32::NAN);
            assert_corners(width, height, f32::MIN_POSITIVE);
        }
    }

    #[test]
    fn non_window_screenshot_keeps_opaque_alpha() {
        let image = rgb_image(13, 9, 99);
        let expected: RgbaImage = image::buffer::ConvertBuffer::convert(&image);
        let got = apply_window_rounded_corners(image, &ScreenCaptureTarget::CameraOnly);
        assert_bytes_eq(got.as_raw(), expected.as_raw(), "camera only");
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod screenshot_swscale_cache_tests {
    use super::{
        clear_screenshot_scaler_cache, convert_ffmpeg_frame_to_image,
        convert_ffmpeg_frame_via_swscale, screenshot_scaler_builds,
    };
    use anyhow::Context;
    use image::RgbImage;
    use std::time::{Duration, Instant};

    fn filled_bgrx(format: ffmpeg::format::Pixel, width: u32, height: u32) -> ffmpeg::frame::Video {
        let mut frame = ffmpeg::frame::Video::new(format, width, height);
        let stride = frame.stride(0);
        let data = frame.data_mut(0);
        for y in 0..height as usize {
            for x in 0..width as usize {
                let i = y * stride + x * 4;
                data[i] = (x.wrapping_mul(3).wrapping_add(y)) as u8;
                data[i + 1] = (x.wrapping_mul(5).wrapping_add(7)) as u8;
                data[i + 2] = (x.wrapping_mul(11).wrapping_add(y.wrapping_mul(2))) as u8;
                data[i + 3] = 0xA5;
            }
        }
        frame
    }

    fn shift_bgrx_pixels(frame: &mut ffmpeg::frame::Video, bias: u8) {
        let width = frame.width() as usize;
        let height = frame.height() as usize;
        let stride = frame.stride(0);
        let data = frame.data_mut(0);
        for row in data.chunks_mut(stride).take(height) {
            for pixel in row.chunks_mut(4).take(width) {
                pixel[0] = pixel[0].wrapping_add(bias);
                pixel[1] = pixel[1].wrapping_add(bias);
                pixel[2] = pixel[2].wrapping_add(bias);
            }
        }
    }

    fn expected_bgrx_rgb(frame: &ffmpeg::frame::Video) -> Vec<u8> {
        let width = frame.width() as usize;
        let height = frame.height() as usize;
        let stride = frame.stride(0);
        let src = frame.data(0);
        let mut rgb = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let s = y * stride + x * 4;
                let d = (y * width + x) * 3;
                rgb[d] = src[s + 2];
                rgb[d + 1] = src[s + 1];
                rgb[d + 2] = src[s];
            }
        }
        rgb
    }

    fn bgrx_ssse3_screenshot() -> bool {
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            std::is_x86_feature_detected!("ssse3")
        }
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        {
            false
        }
    }

    fn assert_scaler_builds(when_swscale: u64) {
        let builds = screenshot_scaler_builds();
        if bgrx_ssse3_screenshot() {
            assert_eq!(builds, 0);
        } else {
            assert_eq!(builds, when_swscale);
        }
    }

    /// The pre-cache conversion: a new swscale context and a row pack every call.
    fn uncached_packed_rgb(frame: &ffmpeg::frame::Video) -> anyhow::Result<RgbImage> {
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
        anyhow::ensure!(
            src_stride >= dst_stride,
            "Source stride ({src_stride}) is less than destination stride ({dst_stride})"
        );
        let mut img_buffer = vec![0u8; height * dst_stride];
        for y in 0..height {
            let src_slice = &rgb_frame.data(0)[y * src_stride..y * src_stride + dst_stride];
            img_buffer[y * dst_stride..(y + 1) * dst_stride].copy_from_slice(src_slice);
        }
        RgbImage::from_raw(rgb_frame.width(), rgb_frame.height(), img_buffer)
            .ok_or_else(|| anyhow::anyhow!("Failed to create image buffer"))
    }

    #[test]
    fn bgrx_screenshot_matches_channel_swap() {
        ffmpeg::init().expect("ffmpeg");
        clear_screenshot_scaler_cache();

        let aligned = filled_bgrx(ffmpeg::format::Pixel::BGRZ, 3840, 2);
        let image = convert_ffmpeg_frame_to_image(&aligned).expect("aligned convert");
        assert_eq!(image.as_raw(), expected_bgrx_rgb(&aligned).as_slice());
        assert_eq!(
            image.as_raw(),
            uncached_packed_rgb(&aligned)
                .expect("aligned reference")
                .as_raw()
        );
        assert_scaler_builds(1);
        let again = convert_ffmpeg_frame_to_image(&aligned).expect("aligned reuse");
        assert_eq!(again.as_raw(), image.as_raw());
        assert_scaler_builds(1);

        let mut aligned_changed = filled_bgrx(ffmpeg::format::Pixel::BGRZ, 3840, 2);
        shift_bgrx_pixels(&mut aligned_changed, 17);
        let aligned_changed_image =
            convert_ffmpeg_frame_to_image(&aligned_changed).expect("aligned pixel change");
        assert_eq!(
            aligned_changed_image.as_raw(),
            uncached_packed_rgb(&aligned_changed)
                .expect("aligned pixel change reference")
                .as_raw()
        );
        assert_ne!(aligned_changed_image.as_raw(), image.as_raw());
        assert_scaler_builds(1);

        let padded = filled_bgrx(ffmpeg::format::Pixel::BGRZ, 17, 3);
        let padded_image = convert_ffmpeg_frame_to_image(&padded).expect("padded convert");
        assert_eq!(padded_image.as_raw(), expected_bgrx_rgb(&padded).as_slice());
        assert_eq!(
            padded_image.as_raw(),
            uncached_packed_rgb(&padded)
                .expect("padded reference")
                .as_raw()
        );
        assert_scaler_builds(2);
        convert_ffmpeg_frame_to_image(&padded).expect("padded reuse");
        assert_scaler_builds(2);

        let mut padded_changed = filled_bgrx(ffmpeg::format::Pixel::BGRZ, 17, 3);
        shift_bgrx_pixels(&mut padded_changed, 17);
        let padded_changed_image =
            convert_ffmpeg_frame_to_image(&padded_changed).expect("padded pixel change");
        assert_eq!(
            padded_changed_image.as_raw(),
            uncached_packed_rgb(&padded_changed)
                .expect("padded pixel change reference")
                .as_raw()
        );
        assert_ne!(padded_changed_image.as_raw(), padded_image.as_raw());
        assert_scaler_builds(2);

        let bgra = filled_bgrx(ffmpeg::format::Pixel::BGRA, 32, 2);
        let bgra_image = convert_ffmpeg_frame_to_image(&bgra).expect("bgra convert");
        assert_eq!(bgra_image.as_raw(), expected_bgrx_rgb(&bgra).as_slice());
        assert_scaler_builds(3);

        convert_ffmpeg_frame_to_image(&aligned).expect("return to aligned");
        assert_scaler_builds(4);

        let tiny = filled_bgrx(ffmpeg::format::Pixel::BGRZ, 1, 1);
        let tiny_image = convert_ffmpeg_frame_to_image(&tiny).expect("tiny convert");
        assert_eq!(
            tiny_image.as_raw(),
            &[tiny.data(0)[2], tiny.data(0)[1], tiny.data(0)[0]]
        );
    }

    #[test]
    fn rgbz_screenshot_keeps_byte_order_and_uses_swscale() {
        ffmpeg::init().expect("ffmpeg");
        clear_screenshot_scaler_cache();
        let frame = filled_bgrx(ffmpeg::format::Pixel::RGBZ, 32, 2);
        let image = convert_ffmpeg_frame_to_image(&frame).expect("rgbz convert");
        assert_eq!(screenshot_scaler_builds(), 1);
        let src = frame.data(0);
        assert_eq!(image.as_raw()[..3], [src[0], src[1], src[2]]);
        assert_eq!(
            image.as_raw(),
            uncached_packed_rgb(&frame)
                .expect("rgbz reference")
                .as_raw()
        );
        convert_ffmpeg_frame_to_image(&frame).expect("rgbz reuse");
        assert_eq!(screenshot_scaler_builds(), 1);
    }

    #[test]
    fn bgrx_fast_path_leaves_swscale_cache_intact() {
        ffmpeg::init().expect("ffmpeg");
        clear_screenshot_scaler_cache();
        let rgba = filled_bgrx(ffmpeg::format::Pixel::RGBA, 64, 2);
        let first = convert_ffmpeg_frame_to_image(&rgba).expect("rgba convert");
        assert_eq!(screenshot_scaler_builds(), 1);
        assert_eq!(
            first.as_raw(),
            uncached_packed_rgb(&rgba).expect("rgba reference").as_raw()
        );

        let bgrz = filled_bgrx(ffmpeg::format::Pixel::BGRZ, 64, 2);
        let bgrz_image = convert_ffmpeg_frame_to_image(&bgrz).expect("bgrz convert");
        assert_eq!(bgrz_image.as_raw(), expected_bgrx_rgb(&bgrz).as_slice());
        if bgrx_ssse3_screenshot() {
            assert_eq!(screenshot_scaler_builds(), 1);
        } else {
            assert_eq!(screenshot_scaler_builds(), 2);
        }

        let again = convert_ffmpeg_frame_to_image(&rgba).expect("rgba reuse");
        assert_eq!(again.as_raw(), first.as_raw());
        if bgrx_ssse3_screenshot() {
            assert_eq!(screenshot_scaler_builds(), 1);
        } else {
            assert_eq!(screenshot_scaler_builds(), 3);
        }
    }

    fn thread_cpu_time() -> Duration {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        assert_eq!(rc, 0);
        Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
    }

    fn summarize(samples: &mut [Duration]) -> (Duration, Duration, Duration) {
        samples.sort_unstable();
        let min = samples[0];
        let sum = samples.iter().copied().sum::<Duration>();
        let mean = sum / u32::try_from(samples.len()).expect("sample count");
        let mid = samples.len() / 2;
        let median = if samples.len().is_multiple_of(2) {
            (samples[mid - 1] + samples[mid]) / 2
        } else {
            samples[mid]
        };
        (min, median, mean)
    }

    fn time_convert(
        frame: &ffmpeg::frame::Video,
        runs: usize,
        convert: impl Fn(&ffmpeg::frame::Video) -> RgbImage,
    ) -> (Vec<Duration>, Vec<Duration>) {
        let mut wall = Vec::with_capacity(runs);
        let mut cpu = Vec::with_capacity(runs);
        for _ in 0..runs {
            let cpu_start = thread_cpu_time();
            let start = Instant::now();
            let image = convert(std::hint::black_box(frame));
            std::hint::black_box(&image);
            let elapsed = start.elapsed();
            let cpu_elapsed = thread_cpu_time().saturating_sub(cpu_start);
            wall.push(elapsed);
            cpu.push(cpu_elapsed);
        }
        (wall, cpu)
    }

    fn host_model() -> String {
        let Ok(cpuinfo) = std::fs::read_to_string("/proc/cpuinfo") else {
            return "unknown".to_string();
        };
        cpuinfo
            .lines()
            .find_map(|line| {
                let rest = line.strip_prefix("model name")?;
                Some(rest.trim_start_matches(['\t', ':', ' ']).to_string())
            })
            .unwrap_or_else(|| "unknown".to_string())
    }

    #[test]
    #[ignore = "manual 4K BGRZ screenshot conversion benchmark"]
    fn bench_bgrz_screenshot_conversion() {
        ffmpeg::init().expect("ffmpeg");
        const WARMUP: usize = 10;
        const RUNS: usize = 51;
        println!(
            "host={} ssse3_path={} warmup={WARMUP} runs={RUNS} profile=release opt-level=s lto=thin codegen-units=1",
            host_model(),
            bgrx_ssse3_screenshot()
        );
        for (width, height) in [(3840, 2160), (1920, 1080), (1366, 768)] {
            let frame = filled_bgrx(ffmpeg::format::Pixel::BGRZ, width, height);
            let scalar = expected_bgrx_rgb(&frame);
            let uncached = uncached_packed_rgb(&frame).expect("uncached");
            clear_screenshot_scaler_cache();
            let swscale = convert_ffmpeg_frame_via_swscale(&frame).expect("swscale");
            let screenshot = convert_ffmpeg_frame_to_image(&frame).expect("screenshot");
            assert_eq!(scalar.as_slice(), swscale.as_raw());
            assert_eq!(swscale.as_raw(), screenshot.as_raw());
            assert_eq!(uncached.as_raw(), screenshot.as_raw());

            for _ in 0..WARMUP {
                std::hint::black_box(uncached_packed_rgb(&frame).expect("warmup uncached"));
            }
            let (mut uncached_wall, mut uncached_cpu) = time_convert(&frame, RUNS, |frame| {
                uncached_packed_rgb(frame).expect("uncached")
            });

            clear_screenshot_scaler_cache();
            for _ in 0..WARMUP {
                std::hint::black_box(
                    convert_ffmpeg_frame_via_swscale(&frame).expect("warmup swscale"),
                );
            }
            let (mut swscale_wall, mut swscale_cpu) = time_convert(&frame, RUNS, |frame| {
                convert_ffmpeg_frame_via_swscale(frame).expect("swscale")
            });

            for _ in 0..WARMUP {
                std::hint::black_box(
                    convert_ffmpeg_frame_to_image(&frame).expect("warmup screenshot"),
                );
            }
            let builds_before = screenshot_scaler_builds();
            let (mut screenshot_wall, mut screenshot_cpu) = time_convert(&frame, RUNS, |frame| {
                convert_ffmpeg_frame_to_image(frame).expect("screenshot")
            });
            let builds_during = screenshot_scaler_builds() - builds_before;

            let (uncached_wall_min, uncached_wall_med, uncached_wall_mean) =
                summarize(&mut uncached_wall);
            let (uncached_cpu_min, uncached_cpu_med, uncached_cpu_mean) =
                summarize(&mut uncached_cpu);
            let (swscale_wall_min, swscale_wall_med, swscale_wall_mean) =
                summarize(&mut swscale_wall);
            let (swscale_cpu_min, swscale_cpu_med, swscale_cpu_mean) = summarize(&mut swscale_cpu);
            let (screenshot_wall_min, screenshot_wall_med, screenshot_wall_mean) =
                summarize(&mut screenshot_wall);
            let (screenshot_cpu_min, screenshot_cpu_med, screenshot_cpu_mean) =
                summarize(&mut screenshot_cpu);
            println!(
                "size={width}x{height} screenshot_scaler_builds_during_timed_runs={builds_during}"
            );
            println!(
                "swscale_uncached wall min={uncached_wall_min:?} median={uncached_wall_med:?} mean={uncached_wall_mean:?} cpu min={uncached_cpu_min:?} median={uncached_cpu_med:?} mean={uncached_cpu_mean:?}"
            );
            println!(
                "swscale_cached   wall min={swscale_wall_min:?} median={swscale_wall_med:?} mean={swscale_wall_mean:?} cpu min={swscale_cpu_min:?} median={swscale_cpu_med:?} mean={swscale_cpu_mean:?}"
            );
            println!(
                "screenshot       wall min={screenshot_wall_min:?} median={screenshot_wall_med:?} mean={screenshot_wall_mean:?} cpu min={screenshot_cpu_min:?} median={screenshot_cpu_med:?} mean={screenshot_cpu_mean:?}"
            );
        }
    }
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod bgrx_ssse3_tests {
    use super::bgrx_plane_to_rgb24;

    fn scalar_bgrx(src: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
        let mut rgb = vec![0u8; width * height * 3];
        for (src_row, dst_row) in src
            .chunks(stride)
            .zip(rgb.chunks_mut(width * 3))
            .take(height)
        {
            for (src_px, dst_px) in src_row
                .chunks_exact(4)
                .take(width)
                .zip(dst_row.chunks_exact_mut(3))
            {
                dst_px[0] = src_px[2];
                dst_px[1] = src_px[1];
                dst_px[2] = src_px[0];
            }
        }
        rgb
    }

    fn fill_bgrx(width: usize, height: usize, stride: usize) -> Vec<u8> {
        let mut src = vec![0x5Au8; stride * height];
        for y in 0..height {
            for x in 0..width {
                let i = y * stride + x * 4;
                src[i] = x.wrapping_mul(3).wrapping_add(y) as u8;
                src[i + 1] = x.wrapping_mul(5).wrapping_add(7) as u8;
                src[i + 2] = x.wrapping_mul(11).wrapping_add(y.wrapping_mul(2)) as u8;
                src[i + 3] = 0xA5;
            }
        }
        src
    }

    #[test]
    fn rejects_empty_and_short_planes() {
        assert!(bgrx_plane_to_rgb24(&[], 0, 0, 1).is_none());
        assert!(bgrx_plane_to_rgb24(&[0; 4], 4, 1, 0).is_none());
        assert!(bgrx_plane_to_rgb24(&[0; 3], 3, 1, 1).is_none());
        assert!(bgrx_plane_to_rgb24(&[0; 4], 8, 1, 2).is_none());
    }

    #[test]
    fn matches_scalar_reference_including_tails_and_padding() {
        if !std::is_x86_feature_detected!("ssse3") {
            eprintln!("ssse3 unavailable, skipping bgrx plane check");
            return;
        }
        let widths = [
            1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33, 47, 48, 63, 64, 127, 128, 191, 192, 1366,
            1919, 1920, 3839, 3840,
        ];
        for width in widths {
            for height in [1usize, 2, 3] {
                for pad in [0usize, 3, 17] {
                    if width >= 1366 && !(height == 2 && pad == 0) {
                        continue;
                    }
                    let stride = width * 4 + pad;
                    let src = fill_bgrx(width, height, stride);
                    let got = bgrx_plane_to_rgb24(&src, stride, width, height)
                        .expect("ssse3 plane conversion");
                    let expected = scalar_bgrx(&src, stride, width, height);
                    assert_eq!(got, expected, "w={width} h={height} pad={pad}");
                }
            }
        }

        let stride = 80;
        let width = 16;
        let height = 2;
        let mut exact = fill_bgrx(width, height, stride);
        exact.truncate((height - 1) * stride + width * 4);
        let got = bgrx_plane_to_rgb24(&exact, stride, width, height).expect("exact tail");
        assert_eq!(got, scalar_bgrx(&exact, stride, width, height));

        let mut unaligned = vec![0x5Au8; 1 + stride * height];
        unaligned[1..].copy_from_slice(&fill_bgrx(width, height, stride));
        let got = bgrx_plane_to_rgb24(&unaligned[1..], stride, width, height).expect("unaligned");
        assert_eq!(got, scalar_bgrx(&unaligned[1..], stride, width, height));
    }
}
