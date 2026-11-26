//! The still picture a project shows where its camera would be, for a
//! recording made without one (`ProjectConfiguration::camera_picture`).
//!
//! It is decoded once per renderer and handed to the camera layer as one
//! shared RGBA frame, so the layer's storage-identity check uploads it to the
//! GPU once rather than every frame.

use std::{
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::DecodedFrame;

/// Larger pictures are scaled down on load. The camera never covers more
/// than part of the output, and the app already saves pictures at 1024px.
pub const MAX_CAMERA_PICTURE_EDGE: u32 = 2048;

#[derive(Default)]
pub struct CameraPictureCache {
    loaded: Mutex<Option<(String, Option<DecodedFrame>)>>,
}

impl CameraPictureCache {
    /// The decoded picture at `relative` inside `project_path`. A missing or
    /// unreadable file yields `None` and is not retried until the project
    /// names a different picture.
    pub fn frame(&self, project_path: &Path, relative: &str) -> Option<DecodedFrame> {
        let mut loaded = self
            .loaded
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((cached, frame)) = loaded.as_ref()
            && cached == relative
        {
            return frame.clone();
        }
        let path = project_path.join(relative);
        let frame = match inside_project(project_path, relative)
            .and_then(|path| decode_camera_picture(&path))
        {
            Ok(frame) => Some(frame),
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "Camera picture is unavailable");
                None
            }
        };
        *loaded = Some((relative.to_string(), frame.clone()));
        frame
    }
}

/// `relative` resolved inside `project_path`. The field comes from a project
/// file, which can be shared, so a path that leaves the project (absolute,
/// `..`, or a link pointing out) is refused rather than drawn into exports.
fn inside_project(project_path: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if !relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err("Camera picture path must stay inside the project".into());
    }
    let project = project_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let path = project
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(&project) {
        return Err("Camera picture path must stay inside the project".into());
    }
    Ok(path)
}

pub fn decode_camera_picture(path: &Path) -> Result<DecodedFrame, String> {
    let image = image::ImageReader::open(path)
        .map_err(|error| error.to_string())?
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .decode()
        .map_err(|error| error.to_string())?;
    let image = if image.width().max(image.height()) > MAX_CAMERA_PICTURE_EDGE {
        image.resize(
            MAX_CAMERA_PICTURE_EDGE,
            MAX_CAMERA_PICTURE_EDGE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let mut rgba = image.into_rgba8();
    // The camera layer draws opaque frames; a transparent pixel would show
    // whatever its colour channels hold. The app flattens on import, this
    // covers a picture placed in the project some other way.
    for pixel in rgba.pixels_mut() {
        let alpha = u16::from(pixel[3]);
        if alpha < 255 {
            for channel in 0..3 {
                pixel[channel] =
                    ((u16::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
            }
            pixel[3] = 255;
        }
    }
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return Err("Camera picture is empty".into());
    }
    Ok(DecodedFrame::new_with_arc(
        Arc::new(rgba.into_raw()),
        width,
        height,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-camera-picture-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("content/images")).unwrap();
        dir
    }

    #[test]
    fn decodes_once_and_shares_one_frame() {
        let dir = temp_dir("shared");
        image::RgbaImage::from_pixel(40, 30, image::Rgba([10, 20, 30, 255]))
            .save(dir.join("content/images/me.png"))
            .unwrap();
        let cache = CameraPictureCache::default();
        let first = cache.frame(&dir, "content/images/me.png").unwrap();
        let second = cache.frame(&dir, "content/images/me.png").unwrap();
        assert_eq!((first.width(), first.height()), (40, 30));
        assert_eq!(first.data().as_ptr(), second.data().as_ptr());
        assert_eq!(&first.data()[..4], &[10, 20, 30, 255]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn missing_pictures_are_none_and_a_new_name_loads() {
        let dir = temp_dir("missing");
        let cache = CameraPictureCache::default();
        assert!(cache.frame(&dir, "content/images/gone.png").is_none());
        image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 255]))
            .save(dir.join("content/images/next.png"))
            .unwrap();
        assert!(cache.frame(&dir, "content/images/next.png").is_some());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn pictures_outside_the_project_are_refused() {
        let root = temp_dir("outside");
        let project = root.join("rec.cap");
        std::fs::create_dir_all(project.join("content/images")).unwrap();
        let outside = root.join("secret.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]))
            .save(&outside)
            .unwrap();
        let cache = CameraPictureCache::default();
        assert!(cache.frame(&project, "../secret.png").is_none());
        assert!(cache.frame(&project, outside.to_str().unwrap()).is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, project.join("content/images/link.png")).unwrap();
            assert!(cache.frame(&project, "content/images/link.png").is_none());
        }
        image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]))
            .save(project.join("content/images/inside.png"))
            .unwrap();
        assert!(cache.frame(&project, "content/images/inside.png").is_some());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn transparency_is_flattened_onto_white_and_large_pictures_shrink() {
        let dir = temp_dir("flatten");
        let path = dir.join("content/images/big.png");
        let mut image = image::RgbaImage::from_pixel(4096, 1024, image::Rgba([0, 0, 0, 0]));
        image.put_pixel(4095, 1023, image::Rgba([0, 0, 0, 255]));
        image.save(&path).unwrap();
        let frame = decode_camera_picture(&path).unwrap();
        assert_eq!((frame.width(), frame.height()), (2048, 512));
        assert_eq!(&frame.data()[..4], &[255, 255, 255, 255]);
        std::fs::remove_dir_all(dir).ok();
    }
}
