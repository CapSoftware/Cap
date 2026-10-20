//! Screenshot capture -- `take_screenshot` (`recording.rs:2852-3057` in the
//! Tauri app), the path Screenshot mode takes instead of the recording
//! actors.
//!
//! The Tauri command hides the picker overlays, waits 150ms for the fade,
//! captures through `cap_recording::screenshot::capture_screenshot`, and
//! writes the same bundle shape image import writes: `<app data>/screenshots/
//! {name}.cap/` holding `original.png`, a Studio `SingleSegment` meta whose
//! display track is the PNG at `fps: 0`, and a project config whose
//! background is transparent white with no shadow (`recording.rs:2963-2985`).
//! Known deviations from that command: no native notification and no `ScreenshotTaken`
//! automations (no automation runner here).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::App;

use crate::{app_windows, screenshot_editor::LoadedSource};

pub struct CapturedScreenshot {
    pub png: PathBuf,
    pub source: Option<LoadedSource>,
    pub behaviour: crate::store::PostScreenshotBehaviour,
}

pub fn take_screenshot(target: ScreenCaptureTarget, cx: &mut App) {
    if matches!(target, ScreenCaptureTarget::CameraOnly) {
        // `capture_screenshot` rejects it too; failing here keeps the pickers
        // up instead of tearing them down for nothing.
        tracing::error!("camera-only is not a screenshot target");
        return;
    }
    tracing::info!(kind = target.kind_str(), "taking a screenshot");
    let behaviour = crate::store::GeneralSettings::load().post_screenshot_behaviour;
    if behaviour.opens_editor() {
        app_windows::prewarm_shared_wgpu_device(cx);
    }
    let settle = app_windows::prepare_for_screenshot_capture(cx);

    let task = gpui_tokio::Tokio::spawn_result(cx, async move {
        if settle {
            // The 150ms the Tauri command sleeps after hiding overlays
            // (`recording.rs:2893-2895`): the windows close synchronously but
            // the compositor needs a beat to actually drop them from screen.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        capture_and_write(target, behaviour.opens_editor()).await
    });

    cx.spawn(async move |cx| {
        let captured = match task.await {
            Ok((png, source)) => Some(CapturedScreenshot {
                png,
                source,
                behaviour,
            }),
            Err(error) => {
                tracing::error!("screenshot capture failed: {error:#}");
                None
            }
        };
        cx.update(|cx| app_windows::screenshot_finished(captured, cx));
    })
    .detach();
}

fn create_capture_project(
    target: &ScreenCaptureTarget,
) -> anyhow::Result<(
    cap_project::RecordingMeta,
    cap_project::ProjectConfiguration,
)> {
    let base = crate::library::screenshots_dir();
    std::fs::create_dir_all(&base)
        .with_context(|| format!("creating screenshots dir {}", base.display()))?;

    // The same naming chain `create_project_dir` uses for recordings: default
    // template only (the custom-template deviation recordings already have),
    // then sanitized and uniqued against the directory.
    let target_name = target.title().unwrap_or_else(|| "Unknown".into());
    let now = chrono::Local::now();
    let pretty_name = format!(
        "{} ({}) {} {}",
        target_name,
        target.kind_str(),
        now.format("%Y-%m-%d"),
        now.format("%I.%M %p"),
    );
    let filename = crate::recording::project_bundle_filename(&pretty_name);
    let filename = cap_utils::ensure_unique_filename(&filename, &base)
        .map_err(|e| anyhow!("unique filename: {e}"))?;
    let bundle = base.join(filename);
    std::fs::create_dir_all(&bundle)
        .with_context(|| format!("creating screenshot bundle {}", bundle.display()))?;

    let meta = cap_project::RecordingMeta {
        platform: Some(cap_project::Platform::default()),
        project_path: bundle.clone(),
        pretty_name: pretty_name.clone(),
        sharing: None,
        inner: cap_project::RecordingMetaInner::Studio(Box::new(
            cap_project::StudioRecordingMeta::SingleSegment {
                segment: cap_project::SingleSegment {
                    display: cap_project::VideoMeta {
                        path: "original.png".into(),
                        fps: 0,
                        start_time: Some(0.0),
                        device_id: None,
                    },
                    camera: None,
                    audio: None,
                    cursor: None,
                },
            },
        )),
        upload: None,
    };
    meta.save_for_project()
        .map_err(|error| anyhow!("saving screenshot meta: {error}"))?;

    let mut config = cap_project::ProjectConfiguration::default();
    config.background.source = cap_project::BackgroundSource::Color {
        value: [255, 255, 255],
        alpha: 0,
    };
    config.background.shadow = 0.0;
    config
        .write(&bundle)
        .map_err(|error| anyhow!("saving screenshot project config: {error}"))?;

    Ok((meta, config))
}

async fn capture_and_write(
    target: ScreenCaptureTarget,
    retain_rgba: bool,
) -> anyhow::Result<(PathBuf, Option<LoadedSource>)> {
    let image = cap_recording::screenshot::capture_screenshot(target.clone())
        .await
        .context("capturing the screenshot")?;
    crate::app_sounds::AppSound::Notification.play();
    let (meta, config) = create_capture_project(&target)?;
    let png = meta.project_path.join("original.png");
    let width = image.width();
    let height = image.height();
    let rgba = write_png(png.clone(), image, retain_rgba).await?;
    tracing::info!(path = %png.display(), "screenshot captured");
    let source = if let Some(rgba) = rgba {
        let cap_project::RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
            return Err(anyhow!("screenshot metadata is not a studio project"));
        };
        Some(LoadedSource {
            rgba: std::sync::Arc::new(rgba),
            width,
            height,
            pretty_name: meta.pretty_name.clone(),
            config,
            studio_meta: (**studio_meta).clone(),
            meta,
        })
    } else {
        None
    };
    Ok((png, source))
}

/// The Tauri encode settings (`recording.rs:2987-3016`): RGB stays RGB, a
/// capture past 8MP trades compression for speed, adaptive filtering either
/// way. Blocking work, so off the runtime workers.
async fn write_png(
    path: PathBuf,
    image: image::DynamicImage,
    retain_rgba: bool,
) -> anyhow::Result<Option<Vec<u8>>> {
    tokio::task::spawn_blocking(move || {
        let width = image.width();
        let height = image.height();
        let color_type = match &image {
            image::DynamicImage::ImageRgba8(_) => image::ColorType::Rgba8,
            _ => image::ColorType::Rgb8,
        };
        let compression = if (width as u64).saturating_mul(height as u64) > 8_000_000 {
            image::codecs::png::CompressionType::Fast
        } else {
            image::codecs::png::CompressionType::Default
        };
        let rgba = retain_rgba.then(|| image.to_rgba8().into_raw());
        let data = image.into_bytes();

        let file =
            std::fs::File::create(&path).with_context(|| format!("creating {}", path.display()))?;
        cap_gpui_kernels::codec::write_png_file(
            file,
            &data,
            width,
            height,
            color_type.into(),
            compression,
            image::codecs::png::FilterType::Adaptive,
        )
        .context("encoding the screenshot PNG")?;
        Ok(rgba)
    })
    .await
    .context("the PNG encode task died")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retained_capture_pixels_match_saved_rgb_and_alpha() {
        let directory = tempfile::tempdir().unwrap();
        let images = [
            image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(4, 2, |x, y| {
                image::Rgb([x as u8 * 40, y as u8 * 80, 173])
            })),
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(4, 2, |x, y| {
                image::Rgba([x as u8 * 40, y as u8 * 80, 173, x as u8 * 70])
            })),
        ];
        for (index, image) in images.into_iter().enumerate() {
            let path = directory.path().join(format!("{index}.png"));
            let expected = image.to_rgba8().into_raw();
            let retained = write_png(path.clone(), image, true).await.unwrap().unwrap();
            let saved = image::open(path).unwrap().to_rgba8().into_raw();
            assert_eq!(retained, expected);
            assert_eq!(saved, retained);
        }
    }

    #[tokio::test]
    async fn oversized_capture_pixels_can_still_be_saved() {
        let directory = tempfile::tempdir().unwrap();
        for (width, height) in [(16_385, 2), (4, 16_385)] {
            let path = directory.path().join("original.png");
            let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                width,
                height,
                image::Rgba([13, 71, 129, 255]),
            ));
            let retained = write_png(path.clone(), image, true).await.unwrap().unwrap();
            let saved = image::open(&path).unwrap().to_rgba8();
            assert_eq!(saved.dimensions(), (width, height));
            assert_eq!(saved.as_raw(), &retained);
            assert!(matches!(
                crate::screenshot_editor::load_source(directory.path()),
                Err(message) if message == format!("Image dimensions exceed maximum: {width}x{height}")
            ));
            assert!(path.exists());
        }
    }

    #[tokio::test]
    async fn copy_and_save_only_encode_without_retaining_pixels() {
        let directory = tempfile::tempdir().unwrap();
        for (index, image) in [
            image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                4,
                2,
                image::Rgb([13, 71, 129]),
            )),
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                4,
                2,
                image::Rgba([13, 71, 129, 83]),
            )),
        ]
        .into_iter()
        .enumerate()
        {
            let path = directory.path().join(format!("{index}.png"));
            let expected = image.to_rgba8();
            assert!(
                write_png(path.clone(), image, false)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(image::open(path).unwrap().to_rgba8(), expected);
        }
    }

    #[tokio::test]
    async fn failed_capture_save_does_not_deliver_pixels() {
        let directory = tempfile::tempdir().unwrap();
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(4, 2));
        let result = write_png(directory.path().to_path_buf(), image, true).await;
        assert!(result.is_err());
    }
}
