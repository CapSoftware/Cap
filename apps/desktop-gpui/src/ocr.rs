#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{App, ClipboardItem};

use crate::app_windows;

pub fn capture_text(target: ScreenCaptureTarget, cx: &mut App) {
    app_windows::ocr_capture_started(cx);
    if matches!(target, ScreenCaptureTarget::CameraOnly) {
        let error = anyhow!("camera-only is not an OCR target");
        finish_error(error, cx);
        return;
    }

    let settings = crate::store::GeneralSettings::load();
    let keep_screenshot = settings.ocr_keep_screenshot;
    let show_notification = settings.enable_notifications && settings.ocr_show_notification;
    let notifications_enabled = settings.enable_notifications;
    let no_text_error = crate::i18n::tr::ocr::notification::no_text_found().to_string();
    let settle = app_windows::prepare_for_screenshot_capture(cx);

    let task = gpui_tokio::Tokio::spawn_result(cx, async move {
        if settle {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let image = cap_recording::screenshot::capture_screenshot(target.clone())
            .await
            .context("capturing the selected area")?;
        let recognition_image = image.clone();
        let text = tokio::task::spawn_blocking(move || recognize_text(recognition_image))
            .await
            .context("the OCR task failed")??;
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(anyhow!(no_text_error));
        }
        Ok((text, image, target))
    });

    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| match result {
            Ok((text, image, target)) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                crate::app_sounds::AppSound::Notification.play();
                if show_notification {
                    let preview = text.chars().take(120).collect::<String>();
                    post_notification(
                        crate::i18n::tr::ocr::notification::text_copied_title(),
                        &preview,
                    );
                }
                app_windows::ocr_finished(cx);
                if keep_screenshot {
                    let save = gpui_tokio::Tokio::spawn_result(cx, async move {
                        crate::screenshot::write_screenshot_bundle(image, &target).await
                    });
                    cx.spawn(async move |cx| {
                        match save.await {
                            Ok(_) => cx.update(app_windows::refresh_screenshot_listings),
                            Err(error) => {
                                tracing::error!("OCR screenshot save failed: {error:#}");
                                if notifications_enabled {
                                    post_notification(
                                        crate::i18n::tr::ocr::notification::screenshot_save_failed_title(),
                                        crate::i18n::tr::ocr::notification::screenshot_save_failed_body(),
                                    );
                                }
                            }
                        }
                    })
                    .detach();
                }
            }
            Err(error) => finish_error(error, cx),
        });
    })
    .detach();
}

fn finish_error(error: anyhow::Error, cx: &mut App) {
    tracing::error!("OCR text capture failed: {error:#}");
    if crate::store::GeneralSettings::load().enable_notifications {
        post_notification(
            crate::i18n::tr::ocr::notification::copy_failed_title(),
            &format!("{error:#}"),
        );
    }
    app_windows::ocr_finished(cx);
}

fn recognize_text(image: image::DynamicImage) -> anyhow::Result<String> {
    let rgba = image.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();
    if width == 0 || height == 0 {
        return Err(anyhow!("Image is empty"));
    }
    let rgba = rgba.into_raw();
    let mut bgra = vec![0; rgba.len()];
    for (source, target) in rgba.chunks_exact(4).zip(bgra.chunks_exact_mut(4)) {
        target[0] = source[2];
        target[1] = source[1];
        target[2] = source[0];
        target[3] = source[3];
    }
    recognize_bgra(bgra, width, height)
}

#[cfg(target_os = "macos")]
fn recognize_bgra(bgra: Vec<u8>, width: u32, height: u32) -> anyhow::Result<String> {
    cidre::objc::ar_pool(|| {
        let result = (|| -> anyhow::Result<String> {
            use cidre::{cv, ns, vn};

            extern "C" fn release_pixel_buffer_data(
                release_ref_con: *mut c_void,
                _base_address: *const *const c_void,
            ) {
                if !release_ref_con.is_null() {
                    unsafe {
                        drop(Box::from_raw(release_ref_con.cast::<Vec<u8>>()));
                    }
                }
            }

            let width_usize =
                usize::try_from(width).map_err(|_| anyhow!("OCR image width is too large"))?;
            let height_usize =
                usize::try_from(height).map_err(|_| anyhow!("OCR image height is too large"))?;
            let bytes_per_row = width_usize
                .checked_mul(4)
                .ok_or_else(|| anyhow!("OCR image row is too large"))?;
            let mut data = Box::new(bgra);
            let base_address = data.as_mut_ptr().cast::<c_void>();
            let release_ref_con = Box::into_raw(data).cast::<c_void>();
            let pixel_buffer = match cv::PixelBuf::with_bytes(
                width_usize,
                height_usize,
                base_address,
                bytes_per_row,
                release_pixel_buffer_data,
                release_ref_con,
                cv::PixelFormat::_32_BGRA,
                None,
            ) {
                Ok(pixel_buffer) => pixel_buffer,
                Err(error) => {
                    unsafe {
                        drop(Box::from_raw(release_ref_con.cast::<Vec<u8>>()));
                    }
                    return Err(anyhow!("Failed to create OCR image: {error}"));
                }
            };
            let mut request = vn::RecognizeTextRequest::new();
            request.set_recognition_level(vn::RequestTextRecognitionLevel::Accurate);
            request.set_uses_lang_correction(true);
            if cidre::version!(macos = 13.0) {
                request.set_revision(vn::RecognizeTextRequest::REVISION_3);
                unsafe {
                    request.set_automatically_detects_lang(true);
                }
            } else {
                request.set_revision(vn::RecognizeTextRequest::REVISION_2);
            }
            let handler = vn::ImageRequestHandler::with_cv_pixel_buf(&pixel_buffer, None)
                .ok_or_else(|| anyhow!("Failed to initialize OCR image handler"))?;
            let requests = ns::Array::<vn::Request>::from_slice(&[&request]);
            handler
                .perform(&requests)
                .map_err(|error| anyhow!("macOS OCR failed: {error}"))?;
            let observations = request.results().unwrap_or_else(ns::Array::new);
            let mut lines = Vec::new();
            for observation in observations.iter() {
                if let Some(candidate) = observation.top_candidates(1).first() {
                    let text = candidate.string().to_string();
                    if !text.trim().is_empty() {
                        lines.push(text);
                    }
                }
            }
            Ok(lines.join("\n"))
        })();
        result.map_err(|error| format!("{error:#}"))
    })
    .map_err(anyhow::Error::msg)
}

#[cfg(target_os = "windows")]
struct WindowsRuntimeGuard;

#[cfg(target_os = "windows")]
impl Drop for WindowsRuntimeGuard {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::WinRT::RoUninitialize();
        }
    }
}

#[cfg(target_os = "windows")]
fn recognize_bgra(bgra: Vec<u8>, width: u32, height: u32) -> anyhow::Result<String> {
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};

    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(|error| anyhow!("Windows OCR runtime failed: {error}"))?;
    let _runtime = WindowsRuntimeGuard;
    let max_dimension =
        OcrEngine::MaxImageDimension().map_err(|error| anyhow!("Windows OCR failed: {error}"))?;
    if width > max_dimension || height > max_dimension {
        return Err(anyhow!(
            "Select a smaller text area. Windows OCR supports up to {max_dimension}px per side"
        ));
    }
    let width = i32::try_from(width).context("OCR image width is too large")?;
    let height = i32::try_from(height).context("OCR image height is too large")?;
    let writer = DataWriter::new().map_err(|error| anyhow!("Windows OCR failed: {error}"))?;
    writer
        .WriteBytes(&bgra)
        .map_err(|error| anyhow!("Windows OCR failed: {error}"))?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|error| anyhow!("Windows OCR failed: {error}"))?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width,
        height,
        BitmapAlphaMode::Premultiplied,
    )
    .map_err(|error| anyhow!("Windows OCR failed: {error}"))?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|error| anyhow!("Windows OCR is not available: {error}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| anyhow!("Windows OCR failed: {error}"))?
        .get()
        .map_err(|error| anyhow!("Windows OCR failed: {error}"))?;
    result
        .Text()
        .map(|text| text.to_string_lossy())
        .map_err(|error| anyhow!("Windows OCR failed: {error}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn recognize_bgra(_bgra: Vec<u8>, _width: u32, _height: u32) -> anyhow::Result<String> {
    Err(anyhow!("OCR is only available on macOS and Windows"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn post_notification(title: &str, body: &str) {
    if let Err(error) = notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .show()
    {
        tracing::warn!("posting OCR notification failed: {error}");
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn post_notification(_title: &str, _body: &str) {}
