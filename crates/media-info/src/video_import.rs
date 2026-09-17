use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"];

#[derive(Clone, Debug)]
pub struct ImportedVideo {
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}

pub fn is_supported_video_path(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                VIDEO_EXTENSIONS
                    .iter()
                    .any(|candidate| extension.eq_ignore_ascii_case(candidate))
            })
}

fn probe_video(path: &Path) -> Result<(f64, u32, u32, u32, bool), String> {
    let input =
        ffmpeg::format::input(path).map_err(|error| format!("Cannot open video: {error}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "The file has no video track".to_string())?;
    let decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
        .map_err(|error| format!("Cannot inspect video: {error}"))?
        .decoder()
        .video()
        .map_err(|error| format!("Cannot decode video: {error}"))?;
    let (width, height) = (decoder.width(), decoder.height());
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || u64::from(width) * u64::from(height) > 33_554_432
    {
        return Err(
            "Videos must be at most 16,384 pixels per side and 33,554,432 pixels per frame".into(),
        );
    }
    let duration = if input.duration() > 0 {
        input.duration() as f64 / 1_000_000.0
    } else {
        let time_base = stream.time_base();
        if stream.duration() <= 0 || time_base.denominator() <= 0 {
            return Err("Cannot determine video duration".into());
        }
        stream.duration() as f64 * time_base.numerator() as f64 / time_base.denominator() as f64
    };
    if !duration.is_finite() || duration <= 0.0 {
        return Err("Cannot determine video duration".into());
    }
    let rate = stream.avg_frame_rate();
    let fps = if rate.denominator() > 0 {
        (rate.numerator() as f64 / rate.denominator() as f64).round()
    } else {
        30.0
    };
    let fps = if fps.is_finite() && (1.0..=240.0).contains(&fps) {
        fps as u32
    } else {
        30
    };
    let has_audio = input.streams().best(ffmpeg::media::Type::Audio).is_some();
    Ok((duration, fps, width, height, has_audio))
}

pub fn import_video(project_path: &Path, source: &Path) -> Result<ImportedVideo, String> {
    if !project_path.is_dir() {
        return Err("The editor project is unavailable".into());
    }
    if !is_supported_video_path(source) {
        return Err("Choose an MP4, MOV, AVI, MKV, WebM, WMV, M4V or FLV video".into());
    }
    let source_file = std::fs::File::open(source)
        .map_err(|error| format!("Cannot open source video: {error}"))?;
    let source_metadata = source_file
        .metadata()
        .map_err(|error| format!("Cannot inspect source video: {error}"))?;
    if !source_metadata.is_file() || source_metadata.len() == 0 {
        return Err("The source video is empty or unavailable".into());
    }
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("mp4")
        .to_ascii_lowercase();
    let id = uuid::Uuid::new_v4();
    let directory = project_path.join("content/videos");
    for candidate in [project_path.join("content"), directory.clone()] {
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Video assets cannot use linked project directories".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect video assets: {error}")),
        }
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create video assets: {error}"))?;
    let root = project_path
        .canonicalize()
        .map_err(|error| format!("Cannot inspect editor project: {error}"))?;
    let resolved_directory = directory
        .canonicalize()
        .map_err(|error| format!("Cannot inspect video assets: {error}"))?;
    if !resolved_directory.starts_with(&root) {
        return Err("Video assets must stay inside the editor project".into());
    }
    let temporary = directory.join(format!(".{id}.import"));
    let result = (|| {
        let copied = std::fs::copy(source, &temporary)
            .map_err(|error| format!("Cannot copy video into project: {error}"))?;
        if copied != source_metadata.len() {
            return Err("The source video changed during import. Drop it again.".into());
        }
        std::fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Cannot save video asset: {error}"))?;
        let (duration, fps, width, height, has_audio) = probe_video(&temporary)?;
        let path = format!("content/videos/{id}.{extension}");
        std::fs::rename(&temporary, project_path.join(&path))
            .map_err(|error| format!("Cannot finish video import: {error}"))?;
        Ok(ImportedVideo {
            path,
            name: source
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Video")
                .to_string(),
            duration,
            fps,
            width,
            height,
            has_audio,
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn resolved_video_path(project_path: &Path, video: &ImportedVideo) -> PathBuf {
    project_path.join(&video.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_import_keeps_source_and_creates_distinct_project_assets() {
        let directory =
            std::env::temp_dir().join(format!("cap-video-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../video-decode/tests/fixtures/h264-decoder-lifecycle.mp4");
        let original = std::fs::read(&source).unwrap();
        let first = import_video(&directory, &source).unwrap();
        let second = import_video(&directory, &source).unwrap();
        assert_ne!(first.path, second.path);
        assert!(first.duration > 0.0);
        assert!(first.width > 0 && first.height > 0 && first.fps > 0);
        assert!(!Path::new(&first.path).is_absolute());
        assert_eq!(
            std::fs::read(resolved_video_path(&directory, &first)).unwrap(),
            original
        );
        assert_eq!(std::fs::read(&source).unwrap(), original);
        let damaged = directory.join("damaged.mp4");
        std::fs::write(&damaged, b"invalid video").unwrap();
        assert!(import_video(&directory, &damaged).is_err());
        assert_eq!(
            std::fs::read_dir(directory.join("content/videos"))
                .unwrap()
                .count(),
            2
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn video_import_rejects_a_linked_asset_directory_without_writing_outside() {
        let root =
            std::env::temp_dir().join(format!("cap-video-link-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let project = root.join("project");
        let outside = root.join("outside");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, project.join("content")).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../video-decode/tests/fixtures/h264-decoder-lifecycle.mp4");

        assert!(import_video(&project, &source).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
