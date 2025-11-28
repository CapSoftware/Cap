use crate::sources::screen_capture::ScreenCaptureTarget;
use anyhow::{Context, anyhow};
use image::RgbImage;
#[cfg(target_os = "macos")]
use scap_ffmpeg::AsFFmpeg;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
#[cfg(target_os = "macos")]
use tracing::{debug, error};

#[cfg(target_os = "macos")]
use scap_screencapturekit::{Capturer, StreamCfgBuilder};

#[cfg(target_os = "windows")]
use scap_direct3d::{Capturer, PixelFormat, Settings};

#[cfg(target_os = "macos")]
fn try_fast_capture(target: &ScreenCaptureTarget) -> Option<RgbImage> {
    use core_graphics::display::{CGDisplayCreateImage, kCGWindowImageBoundsIgnoreFraming};
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
        ScreenCaptureTarget::Area { screen, .. } => {
            let display = scap_targets::Display::from_id(screen)?;
            let display_id = display.raw_handle().inner().id;
            let image = unsafe { CGDisplayCreateImage(display_id) };
            if image.is_null() {
                return None;
            }
            unsafe { core_graphics::image::CGImage::from_ptr(image) }
        }
    };

    let width = cg_image.width();
    let height = cg_image.height();
    let bytes_per_row = cg_image.bytes_per_row();

    use core_foundation::data::CFData;
    let cf_data: CFData = cg_image.data();
    let data = cf_data.bytes();

    let mut rgb = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let i = y * bytes_per_row + x * 4;
            if i + 2 < data.len() {
                rgb.push(data[i + 2]);
                rgb.push(data[i + 1]);
                rgb.push(data[i]);
            }
        }
    }

    let image = RgbImage::from_raw(width as u32, height as u32, rgb)?;

    if let ScreenCaptureTarget::Area { bounds, screen } = target {
        let scale = scap_targets::Display::from_id(screen)
            .and_then(|d| d.raw_handle().scale())
            .unwrap_or(1.0);

        let x = (bounds.position().x() * scale) as u32;
        let y = (bounds.position().y() * scale) as u32;
        let crop_width = (bounds.size().width() * scale) as u32;
        let crop_height = (bounds.size().height() * scale) as u32;

        let x = x.min(image.width());
        let y = y.min(image.height());
        let crop_width = crop_width.min(image.width() - x);
        let crop_height = crop_height.min(image.height() - y);

        let cropped = image::imageops::crop_imm(&image, x, y, crop_width, crop_height).to_image();
        debug!("Fast capture completed in {:?}", start.elapsed());
        return Some(cropped);
    }

    debug!("Fast capture completed in {:?}", start.elapsed());
    Some(image)
}

pub async fn capture_screenshot(target: ScreenCaptureTarget) -> anyhow::Result<RgbImage> {
    #[cfg(target_os = "macos")]
    {
        if let Some(image) = try_fast_capture(&target) {
            return Ok(image);
        }
        debug!("Fast capture failed, falling back to SCStream");
    }

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
        };

        let settings = Settings {
            is_cursor_capture_enabled: Some(false),
            pixel_format: scap_direct3d::PixelFormat::R8G8B8A8Unorm,
            ..Default::default()
        };

        Capturer::new(
            item,
            settings,
            {
                let tx = tx.clone();
                move |frame| {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let res = (|| {
                            let width = frame.width();
                            let height = frame.height();
                            let buffer = frame
                                .as_buffer()
                                .map_err(|e| anyhow!("Failed to get buffer: {e:?}"))?;
                            let data = buffer.data();
                            let stride = buffer.stride() as usize;
                            let row_bytes = width as usize * 4;

                            // R8G8B8A8Unorm is RGBA.
                            // We need to convert to RgbImage (3 channels).
                            let mut rgb_data = Vec::with_capacity((width * height * 3) as usize);
                            for y in 0..height as usize {
                                let row_start = y * stride;
                                let row_end = row_start + row_bytes;
                                if row_end > data.len() {
                                    break;
                                }
                                let row = &data[row_start..row_end];
                                for chunk in row.chunks_exact(4) {
                                    rgb_data.push(chunk[0]);
                                    rgb_data.push(chunk[1]);
                                    rgb_data.push(chunk[2]);
                                }
                            }

                            RgbImage::from_raw(width, height, rgb_data)
                                .ok_or_else(|| anyhow!("Failed to create RgbImage"))
                        })();
                        let _ = tx.send(res);
                    }
                    Ok(())
                }
            },
            || Ok(()),
            None,
        )
        .map_err(|e| anyhow!("Failed to create capturer: {e:?}"))?
    };

    #[cfg(target_os = "macos")]
    capturer
        .start()
        .await
        .map_err(|e| anyhow!("Failed to start capturer: {e:?}"))?;

    #[cfg(target_os = "windows")]
    capturer
        .start()
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

    #[cfg(target_os = "windows")]
    capturer
        .stop()
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
        let scale = {
            let display = scap_targets::Display::from_id(&screen)
                .ok_or_else(|| anyhow!("Display not found"))?;
            let physical_width = display.physical_size().map(|s| s.width()).unwrap_or(1.0);
            let logical_width = display.logical_size().map(|s| s.width()).unwrap_or(1.0);
            physical_width / logical_width
        };

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
