use crate::sources::screen_capture::ScreenCaptureTarget;
use anyhow::{Context, anyhow};
use image::RgbImage;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use scap_ffmpeg::AsFFmpeg;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tracing::error;

#[cfg(target_os = "macos")]
use scap_screencapturekit::{Capturer, StreamCfgBuilder};

#[cfg(target_os = "windows")]
use scap_direct3d::{Capturer, PixelFormat, Settings};

pub async fn capture_screenshot(target: ScreenCaptureTarget) -> anyhow::Result<RgbImage> {
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
                    .await
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
                    .await
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
                    .await
                    .ok_or_else(|| anyhow!("Failed to get content filter"))?
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
        } as usize;

        let config = StreamCfgBuilder::default()
            .with_fps(60.0) // High FPS to get the first frame quickly
            .with_width(width)
            .with_height(height)
            .with_shows_cursor(true)
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
        // Windows implementation
        // TODO: Implement Windows support similar to above
        // For now return error on Windows
        return Err(anyhow!("Windows screenshot not yet implemented"));
    };

    #[cfg(target_os = "macos")]
    capturer
        .start()
        .await
        .map_err(|e| anyhow!("Failed to start capturer: {e:?}"))?;

    // Wait for frame or timeout
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

    let image = result?;

    // Handle Area cropping
    if let ScreenCaptureTarget::Area { bounds, screen } = target {
        // We need to calculate crop bounds relative to the captured image.
        // The captured image is the full display.
        // bounds are LogicalBounds.

        // On macOS, physical size is logical * scale.
        #[cfg(target_os = "macos")]
        let scale = {
            let display = scap_targets::Display::from_id(&screen)
                .ok_or_else(|| anyhow!("Display not found"))?;
            display.raw_handle().scale().unwrap_or(1.0)
        };

        #[cfg(target_os = "windows")]
        let scale = 1.0; // TODO: Windows scale

        let x = (bounds.position().x() * scale) as u32;
        let y = (bounds.position().y() * scale) as u32;
        let width = (bounds.size().width() * scale) as u32;
        let height = (bounds.size().height() * scale) as u32;

        // Ensure we don't crop out of bounds
        let img_width = image.width();
        let img_height = image.height();

        let x = x.min(img_width);
        let y = y.min(img_height);
        let width = width.min(img_width - x);
        let height = height.min(img_height - y);

        let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
        return Ok(cropped);
    }

    Ok(image)
}

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

    let mut img_buffer = vec![0u8; height * dst_stride];

    for y in 0..height {
        let src_slice = &rgb_frame.data(0)[y * src_stride..y * src_stride + dst_stride];
        let dst_slice = &mut img_buffer[y * dst_stride..(y + 1) * dst_stride];
        dst_slice.copy_from_slice(src_slice);
    }

    RgbImage::from_raw(width as u32, height as u32, img_buffer)
        .ok_or_else(|| anyhow!("Failed to create image buffer"))
}
