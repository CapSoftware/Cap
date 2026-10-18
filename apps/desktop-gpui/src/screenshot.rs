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
    pub source: LoadedSource,
}

pub fn take_screenshot(target: ScreenCaptureTarget, cx: &mut App) {
    if matches!(target, ScreenCaptureTarget::CameraOnly) {
        // `capture_screenshot` rejects it too; failing here keeps the pickers
        // up instead of tearing them down for nothing.
        tracing::error!("camera-only is not a screenshot target");
        return;
    }
    tracing::info!(kind = target.kind_str(), "taking a screenshot");
    if crate::store::GeneralSettings::load()
        .post_screenshot_behaviour
        .opens_editor()
    {
        app_windows::prewarm_shared_wgpu_device(cx);
    }

    let settle = app_windows::prepare_for_screenshot_capture(cx);
    // GPUI's X11 backend maps windows even when WindowOptions.show is false.
    let prepare_window = cfg!(any(target_os = "windows", target_os = "macos"))
        && std::env::var("CAP_GPUI_SCREENSHOT_PREPARE_WINDOW").as_deref() == Ok("1")
        && crate::store::GeneralSettings::load()
            .post_screenshot_behaviour
            .opens_editor();
    let (prepared_tx, prepared_rx) = flume::bounded(1);
    let prepared_tx = prepare_window.then_some(prepared_tx);
    if std::env::var("CAP_GPUI_SCREENSHOT_WARM_LAYERS").as_deref() == Ok("1")
        && crate::store::GeneralSettings::load()
            .post_screenshot_behaviour
            .opens_editor()
    {
        crate::screenshot_editor::prewarm_screenshot_layers(cx);
    }

    let task = gpui_tokio::Tokio::spawn_result(cx, async move {
        if settle {
            // The 150ms the Tauri command sleeps after hiding overlays
            // (`recording.rs:2893-2895`): the windows close synchronously but
            // the compositor needs a beat to actually drop them from screen.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        capture_and_write(target, prepared_tx).await
    });

    cx.spawn(async move |cx| {
        let prepared_window = if prepare_window {
            match prepared_rx.recv_async().await {
                Ok(path) => cx.update(|cx| app_windows::prepare_screenshot_editor_window(path, cx)),
                Err(_) => None,
            }
        } else {
            None
        };
        let captured = match task.await {
            Ok((png, source)) => Some(CapturedScreenshot { png, source }),
            Err(error) => {
                tracing::error!("screenshot capture failed: {error:#}");
                None
            }
        };
        cx.update(|cx| {
            if let Some(handle) = prepared_window
                && (captured.is_none()
                    || !crate::store::GeneralSettings::load()
                        .post_screenshot_behaviour
                        .opens_editor())
            {
                app_windows::discard_prepared_screenshot_editor(handle, cx);
            }
            app_windows::screenshot_finished(captured, cx);
        });
    })
    .detach();
}

fn prepare_capture_project(
    target: &ScreenCaptureTarget,
    exclusive: bool,
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
    (if exclusive {
        std::fs::create_dir(&bundle)
    } else {
        std::fs::create_dir_all(&bundle)
    })
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
    if let Err(error) = meta.save_for_project() {
        if exclusive {
            discard_capture_project(&meta.project_path);
        }
        return Err(anyhow!("saving screenshot meta: {error}"));
    }

    let mut config = cap_project::ProjectConfiguration::default();
    config.background.source = cap_project::BackgroundSource::Color {
        value: [255, 255, 255],
        alpha: 0,
    };
    config.background.shadow = 0.0;
    if let Err(error) = config.write(&bundle) {
        if exclusive {
            discard_capture_project(&meta.project_path);
        }
        return Err(anyhow!("saving screenshot project config: {error}"));
    }

    Ok((meta, config))
}

fn discard_capture_project(bundle: &std::path::Path) {
    for name in ["original.png", "recording-meta.json", "project-config.json"] {
        if let Err(error) = std::fs::remove_file(bundle.join(name))
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "could not remove failed experimental screenshot file");
        }
    }
    if let Err(error) = std::fs::remove_dir(bundle) {
        tracing::warn!(%error, "could not remove failed experimental screenshot directory");
    }
}

async fn capture_and_write(
    target: ScreenCaptureTarget,
    prepared_tx: Option<flume::Sender<PathBuf>>,
) -> anyhow::Result<(PathBuf, LoadedSource)> {
    let prepared = if let Some(sender) = prepared_tx {
        let project = prepare_capture_project(&target, true)?;
        let _ = sender.send_async(project.0.project_path.clone()).await;
        Some(project)
    } else {
        None
    };
    let image = match cap_recording::screenshot::capture_screenshot(target.clone()).await {
        Ok(image)
            if image.width() <= crate::screenshot_editor::MAX_DIMENSION
                && image.height() <= crate::screenshot_editor::MAX_DIMENSION =>
        {
            image
        }
        result => {
            if let Some((meta, _)) = &prepared {
                discard_capture_project(&meta.project_path);
            }
            return Err(match result {
                Ok(image) => anyhow!(
                    "Image dimensions exceed maximum: {}x{}",
                    image.width(),
                    image.height()
                ),
                Err(error) => error.context("capturing the screenshot"),
            });
        }
    };
    crate::app_sounds::AppSound::Notification.play();
    let experimental = prepared.is_some();
    let (meta, config) = match prepared {
        Some(project) => project,
        None => prepare_capture_project(&target, false)?,
    };
    let png = meta.project_path.join("original.png");
    let width = image.width();
    let height = image.height();
    let rgba = match write_png(png.clone(), image).await {
        Ok(rgba) => rgba,
        Err(error) => {
            if experimental {
                discard_capture_project(&meta.project_path);
            }
            return Err(error);
        }
    };
    tracing::info!(path = %png.display(), "screenshot captured");
    let cap_project::RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return Err(anyhow!("screenshot metadata is not a studio project"));
    };
    let source = LoadedSource {
        rgba: std::sync::Arc::new(rgba),
        width,
        height,
        pretty_name: meta.pretty_name.clone(),
        config,
        studio_meta: (**studio_meta).clone(),
        meta,
    };
    Ok((png, source))
}

/// The Tauri encode settings (`recording.rs:2987-3016`): RGB stays RGB, a
/// capture past 8MP trades compression for speed, adaptive filtering either
/// way. Blocking work, so off the runtime workers.
async fn write_png(path: PathBuf, image: image::DynamicImage) -> anyhow::Result<Vec<u8>> {
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
        let rgba = image.to_rgba8().into_raw();
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

    #[test]
    fn failed_preparation_cleanup_keeps_unrelated_files() {
        let directory = tempfile::tempdir().unwrap();
        let bundle = directory.path().join("failed.cap");
        std::fs::create_dir(&bundle).unwrap();
        for name in [
            "original.png",
            "recording-meta.json",
            "project-config.json",
            "keep.txt",
        ] {
            std::fs::write(bundle.join(name), b"test").unwrap();
        }
        discard_capture_project(&bundle);
        assert!(bundle.join("keep.txt").exists());
        for name in ["original.png", "recording-meta.json", "project-config.json"] {
            assert!(!bundle.join(name).exists());
        }
        std::fs::remove_file(bundle.join("keep.txt")).unwrap();
        discard_capture_project(&bundle);
        assert!(!bundle.exists());
    }

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
            let retained = write_png(path.clone(), image).await.unwrap();
            let saved = image::open(path).unwrap().to_rgba8().into_raw();
            assert_eq!(retained, expected);
            assert_eq!(saved, retained);
        }
    }

    #[tokio::test]
    async fn failed_capture_save_does_not_deliver_pixels() {
        let directory = tempfile::tempdir().unwrap();
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(4, 2));
        let result = write_png(directory.path().to_path_buf(), image).await;
        assert!(result.is_err());
    }
}
