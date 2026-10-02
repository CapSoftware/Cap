use std::sync::LazyLock;

use cap_project::{RecordingMetaInner, StudioRecordingMeta};
use tokio::sync::Semaphore;

use crate::editor_window::WindowEditorInstance;

#[path = "../../../../crates/editor/src/clip_thumbnails_shared.rs"]
mod clip_thumbnails_shared;

use clip_thumbnails_shared::decode_clip_thumbnail;
#[cfg(test)]
use clip_thumbnails_shared::{
    SEEK_DECODE_PACKET_LIMIT, decode_clip_thumbnail_with_budget, persist_clip_thumbnail,
    thumbnail_frame_reaches_target,
};

static THUMBNAIL_SEMAPHORE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(editor_instance))]
pub async fn get_clip_thumbnail(
    editor_instance: WindowEditorInstance,
    recording_segment: u32,
    time: f64,
) -> Result<String, String> {
    let project_path = editor_instance.project_path.clone();
    let meta = editor_instance.meta();

    let RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Err("Clip thumbnails are only available for studio recordings".to_string());
    };

    let display_path = match studio.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => meta.path(&segment.display.path),
        StudioRecordingMeta::MultipleSegments { inner } => {
            let segment = inner
                .segments
                .get(recording_segment as usize)
                .ok_or_else(|| format!("Recording segment {recording_segment} not found"))?;
            meta.path(&segment.display.path)
        }
    };

    let time = time.max(0.0);
    let cache_path = project_path
        .join("thumbnails")
        .join("clips-v2")
        .join(format!(
            "seg{recording_segment}_{}.jpg",
            (time * 1000.0).round() as i64
        ));

    if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let permit = THUMBNAIL_SEMAPHORE
        .acquire()
        .await
        .map_err(|e| format!("Failed to acquire thumbnail permit: {e}"))?;

    if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let output = cache_path.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        decode_clip_thumbnail(&display_path, time, &output)
    })
    .await
    .map_err(|e| format!("Thumbnail task failed: {e}"))??;

    Ok(cache_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn concurrent_identical_thumbnails_are_all_persisted() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("clips").join("segment.jpg");
        let barrier = Arc::new(Barrier::new(4));
        let pixels = [35; 24 * 24 * 3];
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode(&pixels, 24, 24, image::ExtendedColorType::Rgb8)
            .unwrap();

        std::thread::scope(|scope| {
            let tasks = (0..4)
                .map(|_| {
                    let output = &output;
                    let jpeg = &jpeg;
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        persist_clip_thumbnail(output, jpeg)
                    })
                })
                .collect::<Vec<_>>();

            for task in tasks {
                task.join().unwrap().unwrap();
            }
        });

        assert_eq!(std::fs::read(&output).unwrap(), jpeg);
        assert_eq!(image::open(&output).unwrap().width(), 24);
        assert_eq!(
            std::fs::read_dir(output.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn replacing_cached_thumbnail_preserves_contents() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("segment.jpg");
        persist_clip_thumbnail(&output, b"old thumbnail").unwrap();
        persist_clip_thumbnail(&output, b"replacement thumbnail").unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"replacement thumbnail");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[cfg(test)]
mod decoding_tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{Arc, Barrier},
    };

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        fixture_from_bytes(include_bytes!("../test-data/clip-thumbnail-gop.mp4"))
    }

    fn fixture_from_bytes(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        ffmpeg::init().unwrap();
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("gop.mp4");
        std::fs::write(&input, bytes).unwrap();
        (root, input)
    }

    #[test]
    fn split_thumbnails_use_requested_time_inside_keyframe_interval() {
        let (root, input) = fixture();
        for (time, expected_channel) in [(0.0, 0), (1.5, 1), (2.5, 2), (3.0, 2)] {
            let output = root.path().join(format!("{time}.jpg"));
            decode_clip_thumbnail(&input, time, &output).unwrap();
            let image = image::open(&output).unwrap().to_rgb8();
            let pixel = image.get_pixel(80, 45).0;
            assert!(
                pixel[expected_channel] > 100,
                "requested {time}s, got {pixel:?}"
            );
            for (channel, value) in pixel.iter().enumerate() {
                if channel != expected_channel {
                    assert!(*value < 20, "requested {time}s, got {pixel:?}");
                }
            }
        }
    }

    #[test]
    fn simultaneous_decodes_of_one_clip_all_produce_valid_thumbnail() {
        let (root, input) = fixture();
        let output = root.path().join("same-clip.jpg");
        let barrier = Arc::new(Barrier::new(4));

        std::thread::scope(|scope| {
            let tasks = (0..4)
                .map(|_| {
                    let input = &input;
                    let output = &output;
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        decode_clip_thumbnail(input, 1.5, output)
                    })
                })
                .collect::<Vec<_>>();
            for task in tasks {
                task.join().unwrap().unwrap();
            }
        });

        let image = image::open(output).unwrap().to_rgb8();
        let pixel = image.get_pixel(80, 45).0;
        assert!(pixel[1] > 100 && pixel[0] < 20 && pixel[2] < 20);
    }

    #[test]
    fn long_gop_thumbnails_reach_requested_time_and_preserve_eof_fallback() {
        let (root, input) =
            fixture_from_bytes(include_bytes!("../test-data/clip-thumbnail-long-gop.mp4"));
        for time in [8.5, 10.0, 11.0] {
            let output = root.path().join(format!("{time}.jpg"));
            decode_clip_thumbnail(&input, time, &output).unwrap();
            let pixel = image::open(&output).unwrap().to_rgb8().get_pixel(80, 45).0;
            assert!(
                pixel[2] > 100 && pixel[1] < 20 && pixel[0] < 20,
                "requested {time}s, got {pixel:?}"
            );
        }
    }

    #[test]
    fn exhausted_decode_budget_does_not_write_partial_thumbnail() {
        let (root, input) =
            fixture_from_bytes(include_bytes!("../test-data/clip-thumbnail-long-gop.mp4"));
        let output = root.path().join("thumbnail.jpg");
        for (packet_limit, timeout, expected_error) in [
            (240, std::time::Duration::from_secs(2), "packet budget"),
            (
                SEEK_DECODE_PACKET_LIMIT,
                std::time::Duration::ZERO,
                "time budget",
            ),
        ] {
            let result =
                decode_clip_thumbnail_with_budget(&input, 8.5, &output, packet_limit, timeout);
            assert!(result.unwrap_err().contains(expected_error));
            assert!(!output.exists());
        }
    }

    #[test]
    fn frames_without_timestamps_preserve_first_frame_fallback() {
        let mut frame = ffmpeg::frame::Video::empty();
        assert!(thumbnail_frame_reaches_target(&frame, 100));
        frame.set_pts(Some(99));
        assert!(!thumbnail_frame_reaches_target(&frame, 100));
        frame.set_pts(Some(100));
        assert!(thumbnail_frame_reaches_target(&frame, 100));
    }
}
