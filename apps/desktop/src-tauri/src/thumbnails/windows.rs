use super::*;

pub async fn capture_display_thumbnail(display: &scap_targets::Display) -> Option<String> {
    use image::{ColorType, ImageEncoder, codecs::png::PngEncoder};
    use scap_direct3d::{Capturer, Settings};
    use std::io::Cursor;
    use std::panic::{AssertUnwindSafe, catch_unwind};

    // Wrap in catch_unwind to handle C++ exceptions from CreateForMonitor
    // in case the display is disconnected between enumeration and capture
    let item = catch_unwind(AssertUnwindSafe(|| {
        display.raw_handle().try_as_capture_item()
    }))
    .ok()
    .and_then(|result| result.ok())?;

    let (tx, rx) = std::sync::mpsc::channel();

    let settings = Settings {
        is_cursor_capture_enabled: Some(false),
        pixel_format: scap_direct3d::PixelFormat::R8G8B8A8Unorm,
        ..Default::default()
    };

    let mut capturer = Capturer::new(
        item,
        settings.clone(),
        move |frame| {
            let _ = tx.send(frame);
            Ok(())
        },
        || Ok(()),
        None,
    )
    .ok()?;

    capturer.start().ok()?;

    let frame = rx.recv_timeout(std::time::Duration::from_secs(2)).ok()?;
    let _ = capturer.stop();

    let width = frame.width();
    let height = frame.height();

    if width == 0 || height == 0 {
        return None;
    }

    let frame_buffer = frame.as_buffer().ok()?;
    let data = frame_buffer.data();
    let stride = frame_buffer.stride() as usize;

    let width_usize = width as usize;
    let height_usize = height as usize;

    let Some(row_bytes) = width_usize.checked_mul(4) else {
        warn!(
            frame_width = width,
            "Windows display thumbnail row size overflowed"
        );
        return None;
    };

    if stride < row_bytes {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            expected_row_bytes = row_bytes,
            "Windows display thumbnail stride smaller than row size"
        );
        return None;
    }

    let rows_before_last = height_usize.saturating_sub(1);
    let Some(last_row_start) = rows_before_last.checked_mul(stride) else {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            "Windows display thumbnail row offset overflowed"
        );
        return None;
    };

    let Some(required_len) = last_row_start.checked_add(row_bytes) else {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            required_row_bytes = row_bytes,
            "Windows display thumbnail required length overflowed"
        );
        return None;
    };

    if data.len() < required_len {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            frame_data_len = data.len(),
            expected_len = required_len,
            "Windows display thumbnail frame buffer missing pixel data"
        );
        return None;
    }

    let Some(rgba_capacity) = height_usize.checked_mul(row_bytes) else {
        warn!(
            frame_width = width,
            frame_height = height,
            total_row_bytes = row_bytes,
            "Windows display thumbnail RGBA capacity overflowed"
        );
        return None;
    };

    let mut rgba_data = Vec::with_capacity(rgba_capacity);
    for y in 0..height_usize {
        let row_start = y * stride;
        let row_end = row_start + row_bytes;
        rgba_data.extend_from_slice(&data[row_start..row_end]);
    }

    let Some(img) = image::RgbaImage::from_raw(width, height, rgba_data) else {
        warn!("Windows display thumbnail failed to construct RGBA image");
        return None;
    };
    let thumbnail = normalize_thumbnail_dimensions(&img);

    let mut png_data = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut png_data);
    encoder
        .write_image(
            thumbnail.as_raw(),
            thumbnail.width(),
            thumbnail.height(),
            ColorType::Rgba8.into(),
        )
        .ok()?;

    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        png_data.into_inner(),
    ))
}

pub async fn capture_window_thumbnail(window: &scap_targets::Window) -> Option<String> {
    use image::{ColorType, ImageEncoder, codecs::png::PngEncoder};
    use scap_direct3d::{Capturer, Settings};
    use std::io::Cursor;
    use std::panic::{AssertUnwindSafe, catch_unwind};

    // Wrap in catch_unwind to handle C++ exceptions from CreateForWindow
    // when the window is destroyed between enumeration and capture
    let item = catch_unwind(AssertUnwindSafe(|| {
        window.raw_handle().try_as_capture_item()
    }))
    .ok()
    .and_then(|result| result.ok())?;

    let (tx, rx) = std::sync::mpsc::channel();

    let settings = Settings {
        is_cursor_capture_enabled: Some(false),
        pixel_format: scap_direct3d::PixelFormat::R8G8B8A8Unorm,
        ..Default::default()
    };

    let mut capturer = Capturer::new(
        item,
        settings.clone(),
        move |frame| {
            let _ = tx.send(frame);
            Ok(())
        },
        || Ok(()),
        None,
    )
    .ok()?;

    capturer.start().ok()?;

    let frame = rx.recv_timeout(std::time::Duration::from_secs(2)).ok()?;
    let _ = capturer.stop();

    let width = frame.width();
    let height = frame.height();

    if width == 0 || height == 0 {
        return None;
    }

    let frame_buffer = frame.as_buffer().ok()?;
    let data = frame_buffer.data();
    let stride = frame_buffer.stride() as usize;

    let width_usize = width as usize;
    let height_usize = height as usize;

    let Some(row_bytes) = width_usize.checked_mul(4) else {
        warn!(
            frame_width = width,
            "Windows window thumbnail row size overflowed"
        );
        return None;
    };

    if stride < row_bytes {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            expected_row_bytes = row_bytes,
            "Windows window thumbnail stride smaller than row size"
        );
        return None;
    }

    let rows_before_last = height_usize.saturating_sub(1);
    let Some(last_row_start) = rows_before_last.checked_mul(stride) else {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            "Windows window thumbnail row offset overflowed"
        );
        return None;
    };

    let Some(required_len) = last_row_start.checked_add(row_bytes) else {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            required_row_bytes = row_bytes,
            "Windows window thumbnail required length overflowed"
        );
        return None;
    };

    if data.len() < required_len {
        warn!(
            frame_width = width,
            frame_height = height,
            stride,
            frame_data_len = data.len(),
            expected_len = required_len,
            "Windows window thumbnail frame buffer missing pixel data"
        );
        return None;
    }

    let Some(rgba_capacity) = height_usize.checked_mul(row_bytes) else {
        warn!(
            frame_width = width,
            frame_height = height,
            total_row_bytes = row_bytes,
            "Windows window thumbnail RGBA capacity overflowed"
        );
        return None;
    };

    let mut rgba_data = Vec::with_capacity(rgba_capacity);
    for y in 0..height_usize {
        let row_start = y * stride;
        let row_end = row_start + row_bytes;
        rgba_data.extend_from_slice(&data[row_start..row_end]);
    }

    let Some(img) = image::RgbaImage::from_raw(width, height, rgba_data) else {
        warn!("Windows window thumbnail failed to construct RGBA image");
        return None;
    };
    let thumbnail = normalize_thumbnail_dimensions(&img);

    let mut png_data = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut png_data);
    encoder
        .write_image(
            thumbnail.as_raw(),
            thumbnail.width(),
            thumbnail.height(),
            ColorType::Rgba8.into(),
        )
        .ok()?;

    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        png_data.into_inner(),
    ))
}
