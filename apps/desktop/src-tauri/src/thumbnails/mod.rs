use cap_recording::sources::screen_capture::{list_displays, list_windows};
use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(target_os = "linux")]
async fn capture_display_thumbnail(_display: &scap_targets::Display) -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
async fn capture_window_thumbnail(_window: &scap_targets::Window) -> Option<String> {
    None
}

const THUMBNAIL_WIDTH: u32 = 320;
const THUMBNAIL_HEIGHT: u32 = 180;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureDisplayWithThumbnail {
    pub id: scap_targets::DisplayId,
    pub name: String,
    pub refresh_rate: u32,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureWindowWithThumbnail {
    pub id: scap_targets::WindowId,
    pub owner_name: String,
    pub name: String,
    pub bounds: scap_targets::bounds::LogicalBounds,
    pub refresh_rate: u32,
    pub thumbnail: Option<String>,
    pub app_icon: Option<String>,
    pub bundle_identifier: Option<String>,
}

pub fn normalize_thumbnail_dimensions(image: &image::RgbaImage) -> image::RgbaImage {
    let width = image.width();
    let height = image.height();

    if width == THUMBNAIL_WIDTH && height == THUMBNAIL_HEIGHT {
        return image.clone();
    }

    if width == 0 || height == 0 {
        return image::RgbaImage::from_pixel(
            THUMBNAIL_WIDTH,
            THUMBNAIL_HEIGHT,
            image::Rgba([0, 0, 0, 0]),
        );
    }

    let scale = (THUMBNAIL_WIDTH as f32 / width as f32)
        .min(THUMBNAIL_HEIGHT as f32 / height as f32)
        .max(f32::MIN_POSITIVE);

    let scaled_width = (width as f32 * scale)
        .round()
        .clamp(1.0, THUMBNAIL_WIDTH as f32) as u32;
    let scaled_height = (height as f32 * scale)
        .round()
        .clamp(1.0, THUMBNAIL_HEIGHT as f32) as u32;

    let resized = image::imageops::resize(
        image,
        scaled_width.max(1),
        scaled_height.max(1),
        image::imageops::FilterType::Lanczos3,
    );

    let mut canvas =
        image::RgbaImage::from_pixel(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, image::Rgba([0, 0, 0, 0]));

    let offset_x = (THUMBNAIL_WIDTH - scaled_width) / 2;
    let offset_y = (THUMBNAIL_HEIGHT - scaled_height) / 2;

    image::imageops::overlay(&mut canvas, &resized, offset_x as i64, offset_y as i64);

    canvas
}

pub async fn collect_displays_with_thumbnails() -> Result<Vec<CaptureDisplayWithThumbnail>, String>
{
    let displays = list_displays();

    let mut results = Vec::new();
    for (capture_display, display) in displays {
        let thumbnail = capture_display_thumbnail(&display).await;
        results.push(CaptureDisplayWithThumbnail {
            id: capture_display.id,
            name: capture_display.name,
            refresh_rate: capture_display.refresh_rate,
            thumbnail,
        });
    }

    Ok(results)
}

pub async fn collect_windows_with_thumbnails() -> Result<Vec<CaptureWindowWithThumbnail>, String> {
    let windows = list_windows();

    let mut results = Vec::new();
    for (capture_window, window) in windows {
        let thumbnail = capture_window_thumbnail(&window).await;
        let app_icon = window.app_icon().and_then(|bytes| {
            if bytes.is_empty() {
                None
            } else {
                Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    bytes,
                ))
            }
        });

        results.push(CaptureWindowWithThumbnail {
            id: capture_window.id,
            name: capture_window.name,
            owner_name: capture_window.owner_name,
            bounds: capture_window.bounds,
            refresh_rate: capture_window.refresh_rate,
            thumbnail,
            app_icon,
            bundle_identifier: capture_window.bundle_identifier,
        });
    }

    Ok(results)
}
