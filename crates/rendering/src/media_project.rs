use std::{
    io,
    path::{Path, PathBuf},
};

use cap_enc_ffmpeg::{RelocatableSource, SegmentedInput};
use cap_project::{
    ImageSegment, ProjectConfiguration, StudioRecordingMeta, TimelineConfiguration, XY,
};

use crate::Video;

pub fn checked_project_video_source(
    project_path: &Path,
    relative: &str,
) -> io::Result<(RelocatableSource, PathBuf)> {
    let source = RelocatableSource::new(project_path.to_path_buf())?;
    let relative = Path::new(relative);
    source.reader(relative)?;
    let root = project_path.canonicalize()?;
    let resolved = root.join(relative).canonicalize()?;
    if !resolved.starts_with(&root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Imported video is outside the editor project",
        ));
    }
    Ok((source, resolved))
}

pub fn still_image_path(meta: &StudioRecordingMeta) -> Option<String> {
    let StudioRecordingMeta::SingleSegment { segment } = meta else {
        return None;
    };
    (segment.display.fps == 0).then(|| segment.display.path.to_string())
}

pub fn add_still_image_to_timeline(project: &mut ProjectConfiguration, path: &str) -> bool {
    let timeline = project
        .timeline
        .get_or_insert_with(TimelineConfiguration::default);
    if timeline
        .image_segments
        .iter()
        .any(|segment| segment.path == path)
    {
        return false;
    }
    timeline.image_segments.push(ImageSegment {
        start: 0.0,
        end: 5.0,
        path: path.to_string(),
        size: XY::new(1.0, 1.0),
        ..Default::default()
    });
    true
}

pub fn media_canvas_size(
    project_path: &Path,
    project: &ProjectConfiguration,
    still_image: Option<&str>,
) -> XY<u32> {
    let image_path = still_image.or_else(|| {
        project
            .timeline
            .as_ref()?
            .image_segments
            .first()
            .map(|segment| segment.path.as_str())
    });
    if let Some(image_path) = image_path
        && let Ok((width, height)) = image::image_dimensions(project_path.join(image_path))
        && width > 0
        && height > 0
    {
        return XY::new(width, height);
    }
    if let Some(video) = project
        .timeline
        .as_ref()
        .and_then(|timeline| timeline.video_segments.first())
        && let Ok((source, _)) = checked_project_video_source(project_path, &video.path)
        && let Ok(input) = SegmentedInput::open_relocatable(&source, [Path::new(&video.path)])
        && let Ok(source) = Video::from_input(input.input(), 0.0)
    {
        return XY::new(source.width, source.height);
    }
    XY::new(1920, 1080)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::VideoSegment;

    #[test]
    fn video_source_accepts_project_files_and_rejects_escape_paths() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join("content/videos")).unwrap();
        std::fs::write(project.join("content/videos/video.mp4"), b"video").unwrap();
        std::fs::write(root.path().join("outside.mp4"), b"outside").unwrap();

        assert!(checked_project_video_source(&project, "content/videos/video.mp4").is_ok());
        assert!(checked_project_video_source(&project, "../outside.mp4").is_err());
        assert!(
            checked_project_video_source(
                &project,
                root.path().join("outside.mp4").to_str().unwrap()
            )
            .is_err()
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                root.path().join("outside.mp4"),
                project.join("content/videos/linked.mp4"),
            )
            .unwrap();
            assert!(checked_project_video_source(&project, "content/videos/linked.mp4").is_err());
        }
    }

    #[test]
    fn video_canvas_uses_imported_source_and_ignores_escape_path() {
        let _ = ffmpeg::init();
        let root = tempfile::tempdir().unwrap();
        let project_path = root.path().join("project");
        std::fs::create_dir_all(project_path.join("content/videos")).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../video-decode/tests/fixtures/h264-decoder-lifecycle.mp4");
        let imported = project_path.join("content/videos/video.mp4");
        std::fs::copy(&fixture, &imported).unwrap();
        let expected = Video::new(&fixture, 0.0).unwrap();
        let mut project = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                video_segments: vec![VideoSegment {
                    path: "content/videos/video.mp4".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };

        assert_eq!(
            media_canvas_size(&project_path, &project, None),
            XY::new(expected.width, expected.height)
        );
        project.timeline.as_mut().unwrap().video_segments[0].path = "../video.mp4".into();
        assert_eq!(
            media_canvas_size(&project_path, &project, None),
            XY::new(1920, 1080)
        );
    }
}
