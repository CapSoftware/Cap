use std::path::Path;

use cap_project::{
    ImageSegment, ProjectConfiguration, StudioRecordingMeta, TimelineConfiguration, XY,
};

use crate::Video;

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
        && let Ok(source) = Video::new(project_path.join(&video.path), 0.0)
    {
        return XY::new(source.width, source.height);
    }
    XY::new(1920, 1080)
}
