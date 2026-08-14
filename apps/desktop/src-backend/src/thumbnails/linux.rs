use cap_recording::screenshot::capture_screenshot;
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use image::{ImageEncoder, codecs::png::PngEncoder};
use std::io::Cursor;

use super::*;

pub async fn capture_display_thumbnail(display: &scap_targets::Display) -> Option<String> {
    capture_target_thumbnail(ScreenCaptureTarget::Display { id: display.id() }).await
}

pub async fn capture_window_thumbnail(window: &scap_targets::Window) -> Option<String> {
    capture_target_thumbnail(ScreenCaptureTarget::Window { id: window.id() }).await
}

async fn capture_target_thumbnail(target: ScreenCaptureTarget) -> Option<String> {
    let image = match capture_screenshot(target).await {
        Ok(image) => image,
        Err(error) => {
            warn!(error = %error, "Failed to capture thumbnail on Linux");
            return None;
        }
    };

    let rgba = image.to_rgba8();
    if rgba.width() == 0 || rgba.height() == 0 {
        return None;
    }

    let thumbnail = normalize_thumbnail_dimensions(&rgba);
    let mut png_data = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut png_data);
    if let Err(error) = encoder.write_image(
        thumbnail.as_raw(),
        thumbnail.width(),
        thumbnail.height(),
        image::ColorType::Rgba8.into(),
    ) {
        warn!(error = %error, "Failed to encode Linux thumbnail as PNG");
        return None;
    }

    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        png_data.into_inner(),
    ))
}
