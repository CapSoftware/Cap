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
//! Known deviations from that command: no capture sound (this app has no
//! sound assets yet), no native notification, and no `ScreenshotTaken`
//! automations (no automation runner here).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::App;

use crate::app_windows;

pub fn take_screenshot(target: ScreenCaptureTarget, cx: &mut App) {
    if matches!(target, ScreenCaptureTarget::CameraOnly) {
        // `capture_screenshot` rejects it too; failing here keeps the pickers
        // up instead of tearing them down for nothing.
        tracing::error!("camera-only is not a screenshot target");
        return;
    }
    tracing::info!(kind = target.kind_str(), "taking a screenshot");

    let settle = app_windows::prepare_for_screenshot_capture(cx);

    let task = gpui_tokio::Tokio::spawn_result(cx, async move {
        if settle {
            // The 150ms the Tauri command sleeps after hiding overlays
            // (`recording.rs:2893-2895`): the windows close synchronously but
            // the compositor needs a beat to actually drop them from screen.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        capture_and_write(target).await
    });

    cx.spawn(async move |cx| {
        let captured = match task.await {
            Ok(png) => {
                tracing::info!(path = %png.display(), "screenshot captured");
                Some(png)
            }
            Err(error) => {
                tracing::error!("screenshot capture failed: {error:#}");
                None
            }
        };
        cx.update(|cx| app_windows::screenshot_finished(captured, cx));
    })
    .detach();
}

/// Capture, then write the `.cap` bundle. Returns the PNG path, which is what
/// the Tauri command returns (`NewScreenshotAdded.path` is the PNG, not the
/// bundle).
async fn capture_and_write(target: ScreenCaptureTarget) -> anyhow::Result<PathBuf> {
    let image = cap_recording::screenshot::capture_screenshot(target.clone())
        .await
        .context("capturing the screenshot")?;

    let base = crate::library::screenshots_dir();
    std::fs::create_dir_all(&base)
        .with_context(|| format!("creating screenshots dir {}", base.display()))?;

    // The same naming chain `create_project_dir` uses for recordings: default
    // template only (the custom-template deviation recordings already have),
    // colons and slashes dotted, then uniqued against the directory.
    let target_name = target.title().unwrap_or_else(|| "Unknown".into());
    let now = chrono::Local::now();
    let pretty_name = format!(
        "{} ({}) {} {}",
        target_name,
        target.kind_str(),
        now.format("%Y-%m-%d"),
        now.format("%I.%M %p"),
    );
    let filename = format!("{}.cap", pretty_name.replace([':', '/'], "."));
    let filename = cap_utils::ensure_unique_filename(&filename, &base)
        .map_err(|e| anyhow!("unique filename: {e}"))?;
    let bundle = base.join(filename);
    std::fs::create_dir_all(&bundle)
        .with_context(|| format!("creating screenshot bundle {}", bundle.display()))?;

    let meta = cap_project::RecordingMeta {
        platform: Some(cap_project::Platform::default()),
        project_path: bundle.clone(),
        pretty_name,
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
        .map_err(|e| anyhow!("saving screenshot meta: {e}"))?;

    let mut config = cap_project::ProjectConfiguration::default();
    config.background.source = cap_project::BackgroundSource::Color {
        value: [255, 255, 255],
        alpha: 0,
    };
    config.background.shadow = 0.0;
    config
        .write(&bundle)
        .map_err(|e| anyhow!("saving screenshot project config: {e}"))?;

    let png = bundle.join("original.png");
    write_png(png.clone(), image).await?;
    Ok(png)
}

/// The Tauri encode settings (`recording.rs:2987-3016`): RGB stays RGB, a
/// capture past 8MP trades compression for speed, adaptive filtering either
/// way. Blocking work, so off the runtime workers.
async fn write_png(path: PathBuf, image: image::DynamicImage) -> anyhow::Result<()> {
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
        let data = image.into_bytes();

        let file =
            std::fs::File::create(&path).with_context(|| format!("creating {}", path.display()))?;
        let encoder = image::codecs::png::PngEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            compression,
            image::codecs::png::FilterType::Adaptive,
        );
        image::ImageEncoder::write_image(encoder, &data, width, height, color_type.into())
            .context("encoding the screenshot PNG")
    })
    .await
    .context("the PNG encode task died")?
}
