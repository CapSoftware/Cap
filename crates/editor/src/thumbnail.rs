use crate::{EditorInstance, editor::RendererTransitionInput};
use cap_project::{ProjectConfiguration, XY};
use cap_rendering::{ProjectUniforms, RenderedFrame, ZoomTransformTimeline};
use std::{io::Write, path::Path};

const THUMBNAIL_SIZE: XY<u32> = XY { x: 640, y: 640 };
const THUMBNAIL_FPS: u32 = 30;
static THUMBNAIL_RENDER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

impl EditorInstance {
    pub(super) async fn refresh_thumbnail(&self) -> Result<bool, String> {
        let _permit = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            THUMBNAIL_RENDER.acquire(),
        )
        .await
        .map_err(|_| "Thumbnail renderer is busy".to_string())?
        .map_err(|e| e.to_string())?;
        let pending = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.render_pending_thumbnail(),
        )
        .await
        .map_err(|_| "Recording thumbnail render timed out".to_string())??;
        let Some((signature, frame)) = pending else {
            return Ok(false);
        };
        let project_path = self.project_path.clone();
        tokio::task::spawn_blocking(move || save_thumbnail(&project_path, &signature, &frame))
            .await
            .map_err(|e| e.to_string())?
    }

    async fn render_pending_thumbnail(&self) -> Result<Option<(Vec<u8>, RenderedFrame)>, String> {
        let project_path = self.project_path.clone();
        let pending = tokio::task::spawn_blocking(move || {
            let project = ProjectConfiguration::load(&project_path)?;
            let signature = serde_json::to_vec(&project)?;
            let screenshots = project_path.join("screenshots");
            if screenshots.join("preview.jpg").is_file()
                && std::fs::read(screenshots.join("preview-config.json"))
                    .ok()
                    .as_ref()
                    == Some(&signature)
            {
                return Ok::<_, std::io::Error>(None);
            }
            Ok(Some((project, signature)))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let Some((project, signature)) = pending else {
            return Ok(None);
        };
        let (source_time, segment) = project
            .get_segment_time(0.0)
            .ok_or("No first frame in the edited timeline")?;
        let media = self
            .segment_medias
            .get(segment.recording_clip as usize)
            .ok_or("First thumbnail clip is unavailable")?;
        let offsets = project
            .clips
            .iter()
            .find(|clip| clip.index == segment.recording_clip)
            .map(|clip| clip.offsets)
            .unwrap_or_default();
        let frames = media
            .decoders
            .get_frames_initial(source_time as f32, project.requires_camera(), true, offsets)
            .await
            .ok_or("Could not decode the first thumbnail frame")?;
        let duration = project
            .timeline
            .as_ref()
            .map(|timeline| timeline.duration())
            .unwrap_or(0.0);
        let mut zoom = ZoomTransformTimeline::from_project_for_clip(
            &project,
            &media.cursor,
            duration,
            self.render_constants.options.screen_size,
            segment.recording_clip,
        );
        zoom.ensure_precomputed_until(1.0 / THUMBNAIL_FPS as f32);
        let uniforms = ProjectUniforms::new(
            &self.render_constants,
            &project,
            0,
            THUMBNAIL_FPS,
            THUMBNAIL_SIZE,
            &media.cursor,
            &frames,
            duration,
            &zoom,
        );
        let frame = self
            .renderer
            .render_thumbnail(RendererTransitionInput {
                segment_frames: frames,
                uniforms,
                cursor: media.cursor.clone(),
            })
            .await?;
        Ok(Some((signature, frame)))
    }
}

fn save_thumbnail(
    project_path: &Path,
    signature: &[u8],
    frame: &RenderedFrame,
) -> Result<bool, String> {
    let current = ProjectConfiguration::load(project_path).map_err(|e| e.to_string())?;
    if serde_json::to_vec(&current).map_err(|e| e.to_string())? != signature {
        return Ok(false);
    }
    let width = frame.width as usize;
    let height = frame.height as usize;
    let stride = frame.padded_bytes_per_row as usize;
    if width == 0
        || height == 0
        || width > 640
        || height > 640
        || stride < width * 4
        || frame.data.len() < stride * height
    {
        return Err("Invalid recording thumbnail dimensions".into());
    }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in frame.data.chunks_exact(stride).take(height) {
        for pixel in row[..width * 4].chunks_exact(4) {
            rgb.extend_from_slice(&pixel[..3]);
        }
    }
    let screenshots = project_path.join("screenshots");
    if !screenshots.is_dir() {
        std::fs::create_dir(&screenshots).map_err(|e| e.to_string())?;
    }
    let mut image = tempfile::NamedTempFile::new_in(&screenshots).map_err(|e| e.to_string())?;
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut image, 75)
        .encode(
            &rgb,
            frame.width,
            frame.height,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;
    let mut config = tempfile::NamedTempFile::new_in(&screenshots).map_err(|e| e.to_string())?;
    config.write_all(signature).map_err(|e| e.to_string())?;
    let current = ProjectConfiguration::load(project_path).map_err(|e| e.to_string())?;
    if serde_json::to_vec(&current).map_err(|e| e.to_string())? != signature {
        return Ok(false);
    }
    image
        .persist(screenshots.join("preview.jpg"))
        .map_err(|e| e.to_string())?;
    config
        .persist(screenshots.join("preview-config.json"))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn project() -> (tempfile::TempDir, Vec<u8>) {
        let root = tempfile::tempdir().unwrap();
        ProjectConfiguration::default().write(root.path()).unwrap();
        let project = ProjectConfiguration::load(root.path()).unwrap();
        (root, serde_json::to_vec(&project).unwrap())
    }

    fn frame() -> RenderedFrame {
        let mut data = vec![0; 256 * 8];
        for row in data.chunks_exact_mut(256) {
            for pixel in row[..16 * 4].chunks_exact_mut(4) {
                pixel.copy_from_slice(&[220, 40, 20, 255]);
            }
        }
        RenderedFrame {
            data: Arc::new(data),
            width: 16,
            height: 8,
            padded_bytes_per_row: 256,
            frame_number: 0,
            target_time_ns: 0,
        }
    }

    #[test]
    fn saves_padded_rgba_without_replacing_the_original_capture() {
        let (root, signature) = project();
        let screenshots = root.path().join("screenshots");
        std::fs::create_dir(&screenshots).unwrap();
        let original = screenshots.join("display.jpg");
        std::fs::write(&original, b"original capture").unwrap();
        assert!(save_thumbnail(root.path(), &signature, &frame()).unwrap());
        let image = image::open(screenshots.join("preview.jpg"))
            .unwrap()
            .into_rgb8();
        assert_eq!(image.dimensions(), (16, 8));
        let pixel = image.get_pixel(8, 4).0;
        assert!(pixel[0] > 210 && pixel[1] < 50 && pixel[2] < 30);
        assert_eq!(std::fs::read(original).unwrap(), b"original capture");
        assert_eq!(
            std::fs::read(screenshots.join("preview-config.json")).unwrap(),
            signature
        );
        assert_eq!(std::fs::read_dir(screenshots).unwrap().count(), 3);
    }

    #[test]
    fn superseded_edits_cannot_publish_an_old_thumbnail() {
        let (root, signature) = project();
        let mut changed = ProjectConfiguration::load(root.path()).unwrap();
        changed.background.padding = 42.0;
        changed.write(root.path()).unwrap();
        assert!(!save_thumbnail(root.path(), &signature, &frame()).unwrap());
        assert!(!root.path().join("screenshots").exists());
    }

    #[test]
    fn invalid_frames_preserve_an_existing_thumbnail() {
        let (root, signature) = project();
        assert!(save_thumbnail(root.path(), &signature, &frame()).unwrap());
        let path = root.path().join("screenshots/preview.jpg");
        let before = std::fs::read(&path).unwrap();
        let mut invalid = frame();
        invalid.data = Arc::new(vec![0; 4]);
        assert!(save_thumbnail(root.path(), &signature, &invalid).is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn deleted_projects_are_not_recreated() {
        let (root, signature) = project();
        let missing = root.path().join("deleted.cap");
        assert!(save_thumbnail(&missing, &signature, &frame()).is_err());
        assert!(!missing.exists());
    }

    #[tokio::test]
    #[ignore = "Requires CAP_THUMBNAIL_TEST_PROJECT pointing to the synthetic red then blue video fixture and a GPU"]
    async fn native_thumbnail_tracks_edits_and_reuses_unchanged_projects() {
        let source = std::path::PathBuf::from(std::env::var("CAP_THUMBNAIL_TEST_PROJECT").unwrap());
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().to_path_buf();
        std::fs::create_dir(path.join("content")).unwrap();
        std::fs::copy(
            source.join("content/display.mp4"),
            path.join("content/display.mp4"),
        )
        .unwrap();
        std::fs::write(path.join("recording-meta.json"), serde_json::to_vec(&serde_json::json!({
            "platform": "MacOS",
            "pretty_name": "Thumbnail verification",
            "segments": [{"display": {"path": "content/display.mp4", "fps": 30, "start_time": 0}}],
            "status": {"status": "Complete"}
        })).unwrap()).unwrap();
        ffmpeg::init().unwrap();
        for format in [
            crate::EditorFrameFormat::Rgba,
            #[cfg(target_os = "macos")]
            crate::EditorFrameFormat::BgraSurface,
        ] {
            let mut project = ProjectConfiguration::default();
            project.background.source = cap_project::BackgroundSource::Color {
                value: [20, 200, 40],
                alpha: 255,
            };
            project.write(&path).unwrap();
            let (frames, mut rendered) = tokio::sync::mpsc::unbounded_channel();
            let editor = EditorInstance::new_with_frame_format(
                path.clone(),
                |_| {},
                Box::new(move |_, _| {
                    let _ = frames.send(());
                }),
                None,
                format,
            )
            .await
            .unwrap();
            editor
                .preview_tx
                .send(Some((0, 30, THUMBNAIL_SIZE)))
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(20), rendered.recv())
                .await
                .unwrap()
                .unwrap();
            let start = std::time::Instant::now();
            assert!(editor.refresh_thumbnail().await.unwrap());
            let image_path = path.join("screenshots/preview.jpg");
            let first = std::fs::read(&image_path).unwrap();
            println!(
                "initial thumbnail: {:?}, {} bytes",
                start.elapsed(),
                first.len()
            );
            let before = std::fs::metadata(&image_path).unwrap().modified().unwrap();
            assert!(!editor.refresh_thumbnail().await.unwrap());
            assert_eq!(
                std::fs::metadata(&image_path).unwrap().modified().unwrap(),
                before
            );
            project = ProjectConfiguration::load(&path).unwrap();
            let first_clip = &mut project.timeline.as_mut().unwrap().segments[0];
            first_clip.start = 1.2;
            first_clip.end = 1.9;
            project.write(&path).unwrap();
            let start = std::time::Instant::now();
            assert!(editor.dispose_with_thumbnail().await);
            let image = image::open(&image_path).unwrap().into_rgb8();
            let pixel = image.get_pixel(image.width() / 2, image.height() / 2).0;
            assert!(
                pixel[2] > 180 && pixel[0] < 80,
                "trimmed first frame must be blue: {pixel:?}"
            );
            assert!(image.width() <= 640 && image.height() <= 640);
            assert_ne!(std::fs::read(&image_path).unwrap(), first);
            println!(
                "close and trimmed thumbnail: {:?}, {}x{}, {} bytes",
                start.elapsed(),
                image.width(),
                image.height(),
                std::fs::metadata(image_path).unwrap().len()
            );
        }
    }
}
