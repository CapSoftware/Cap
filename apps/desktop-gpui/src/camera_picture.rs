//! A still picture used in place of a camera: picked in the camera menu
//! before recording, or added in the editor to a recording made without a
//! camera.
//!
//! Every picture is normalized once, when it is chosen: turned upright, made
//! opaque, scaled to at most [`MAX_EDGE`] and saved as a JPEG. The bubble,
//! the recording and the renderer then only ever read that small file, and a
//! Studio recording with a picture encodes no camera track at all.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use gpui::RenderImage;
use image::{DynamicImage, ImageDecoder as _, RgbImage};

pub(crate) const EXTENSIONS: &[&str] = crate::import::OVERLAY_IMAGE_EXTENSIONS;
const MAX_EDGE: u32 = 1024;
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const JPEG_QUALITY: u8 = 90;
const RECORDING_DIR: &str = "camera-pictures";

pub struct CameraPicture {
    pub path: PathBuf,
    pub image: Arc<RenderImage>,
    pub width: u32,
    pub height: u32,
}

impl CameraPicture {
    pub fn aspect(&self) -> f32 {
        self.width as f32 / self.height.max(1) as f32
    }
}

impl std::fmt::Debug for CameraPicture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CameraPicture")
            .field("path", &self.path)
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

fn decode_upright(source: &Path) -> Result<DynamicImage, String> {
    let metadata = std::fs::metadata(source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        return Err("Pictures must be 64 MiB or smaller".into());
    }
    let mut decoder = image::ImageReader::open(source)
        .map_err(|error| error.to_string())?
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .into_decoder()
        .map_err(|error| error.to_string())?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// Flattened onto white: the camera slot is drawn opaque wherever it appears.
pub(crate) fn normalize(source: &Path) -> Result<RgbImage, String> {
    let image = decode_upright(source)?;
    if image.width() == 0 || image.height() == 0 {
        return Err("This picture is empty".into());
    }
    let image = if image.width().max(image.height()) > MAX_EDGE {
        image.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };
    let rgba = image.into_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());
    for (out, pixel) in rgb.pixels_mut().zip(rgba.pixels()) {
        let alpha = u16::from(pixel[3]);
        for channel in 0..3 {
            out[channel] =
                ((u16::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
    }
    Ok(rgb)
}

fn encode(picture: &RgbImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY)
        .encode_image(picture)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn unique_name() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("camera-picture-{millis}-{}-{count}.jpg", std::process::id())
}

fn write_new(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| error.to_string())?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(destination);
        return Err(format!("Failed to save the picture: {error}"));
    }
    Ok(())
}

pub(crate) fn save_for_recording(source: &Path) -> Result<PathBuf, String> {
    let bytes = encode(&normalize(source)?)?;
    let dir = crate::store::app_data_dir().join(RECORDING_DIR);
    let destination = dir.join(unique_name());
    write_new(&destination, &bytes)?;
    Ok(destination)
}

/// Deletes the camera menu's pictures saved before `kept`, once `kept` is in
/// use. Never the newer ones: a later choice may already have replaced
/// `kept` before this runs, and an import still in progress, or one turned
/// away because a recording began, must leave the picture in use on disk.
pub(crate) fn retire_older(kept: &Path) {
    let dir = crate::store::app_data_dir().join(RECORDING_DIR);
    if kept.parent() != Some(dir.as_path()) {
        return;
    }
    retire_older_in(&dir, kept);
}

fn retire_older_in(dir: &Path, kept: &Path) {
    let modified = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
    };
    let Some(kept_at) = modified(kept) else {
        return;
    };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != kept && modified(&path).is_some_and(|at| at < kept_at) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

pub(crate) fn import_into_project(project: &Path, source: &Path) -> Result<String, String> {
    let bytes = encode(&normalize(source)?)?;
    let relative = format!("content/images/{}", unique_name());
    write_new(&project.join(&relative), &bytes)?;
    Ok(relative)
}

/// Not while recording, nor while a Linux clean capture holds a start
/// waiting for its shortcut: that start already carries the picture.
pub(crate) fn can_change(cx: &gpui::App) -> bool {
    crate::session::RecordingSession::try_global(cx)
        .is_none_or(|session| session.read(cx).phase == crate::session::Phase::Idle)
        && !crate::app_windows::clean_capture_owned(cx)
}

pub(crate) fn select(path: PathBuf, cx: &mut gpui::App) {
    cx.spawn(async move |cx| {
        let loaded = cx
            .background_executor()
            .spawn({
                let path = path.clone();
                async move { load(&path) }
            })
            .await;
        cx.update(|cx| {
            let feeds = crate::feeds::Feeds::global(cx);
            match loaded {
                Ok(picture) if can_change(cx) => feeds.update(cx, |feeds, cx| {
                    feeds.set_camera_picture(Some(Arc::new(picture)), cx)
                }),
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "The camera picture could not be loaded");
                    feeds.update(cx, |feeds, cx| feeds.forget_camera_picture(cx));
                }
            }
        });
    })
    .detach();
}

pub(crate) fn select_or_choose(window: &mut gpui::Window, cx: &mut gpui::App) {
    match crate::feeds::Feeds::global(cx)
        .read(cx)
        .remembered_camera_picture
        .clone()
    {
        Some(path) => select(path, cx),
        None => choose(window, cx),
    }
}

pub(crate) fn choose(window: &mut gpui::Window, cx: &mut gpui::App) {
    let feeds = crate::feeds::Feeds::global(cx);
    if feeds.read(cx).picking_camera_picture || !can_change(cx) {
        return;
    }
    feeds.update(cx, |feeds, _| feeds.picking_camera_picture = true);
    window
        .spawn(cx, async move |cx| {
            #[cfg(target_os = "linux")]
            let picked = crate::platform::open_file_panel_async(
                &[(crate::i18n::tr::main::device::picture::filter(), EXTENSIONS)],
                None,
                cx,
            )
            .await;
            #[cfg(not(target_os = "linux"))]
            let picked = cx
                .update(|_, _| crate::platform::open_image_panel(EXTENSIONS))
                .ok()
                .flatten();
            let loaded = match picked {
                Some(source) => Some(
                    cx.background_executor()
                        .spawn(async move { load(&save_for_recording(&source)?) })
                        .await,
                ),
                None => None,
            };
            cx.update(|_, cx| {
                let feeds = crate::feeds::Feeds::global(cx);
                feeds.update(cx, |feeds, _| feeds.picking_camera_picture = false);
                match loaded {
                    Some(Ok(picture)) if can_change(cx) => feeds.update(cx, |feeds, cx| {
                        feeds.set_camera_picture(Some(Arc::new(picture)), cx)
                    }),
                    Some(Ok(_)) | None => {}
                    Some(Err(error)) => {
                        tracing::warn!(%error, "The camera picture could not be used");
                    }
                }
            })
            .ok();
        })
        .detach();
}

pub(crate) fn load(path: &Path) -> Result<CameraPicture, String> {
    let rgba = image::open(path)
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return Err("This picture is empty".into());
    }
    Ok(CameraPicture {
        path: path.to_path_buf(),
        image: crate::library::rgba_to_render_image(rgba),
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-gpui-camera-picture-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn large_transparent_pictures_shrink_and_flatten_onto_white() {
        let dir = temp_dir("normalize");
        let source = dir.join("wide.png");
        let mut image = image::RgbaImage::from_pixel(3000, 1500, image::Rgba([0, 0, 0, 0]));
        for x in 0..3000 {
            for y in 750..1500 {
                image.put_pixel(x, y, image::Rgba([200, 10, 10, 255]));
            }
        }
        image.save(&source).unwrap();
        let picture = normalize(&source).unwrap();
        assert_eq!(picture.dimensions(), (1024, 512));
        assert_eq!(picture.get_pixel(10, 10).0, [255, 255, 255]);
        let bottom = picture.get_pixel(10, 500).0;
        assert!(bottom[0] > 180 && bottom[1] < 40, "{bottom:?}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn small_pictures_keep_their_size_and_each_import_gets_its_own_file() {
        let dir = temp_dir("project");
        let source = dir.join("me.jpg");
        image::RgbImage::from_pixel(64, 48, image::Rgb([30, 90, 160]))
            .save(&source)
            .unwrap();
        let project = dir.join("rec.cap");
        std::fs::create_dir_all(&project).unwrap();
        let relative = import_into_project(&project, &source).unwrap();
        assert!(relative.starts_with("content/images/camera-picture-"));
        let loaded = load(&project.join(&relative)).unwrap();
        assert_eq!((loaded.width, loaded.height), (64, 48));
        let again = import_into_project(&project, &source).unwrap();
        assert_ne!(again, relative);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn only_pictures_older_than_the_kept_one_are_retired() {
        let dir = temp_dir("retire");
        let at = |secs: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        let write = |name: &str, secs: u64| {
            let path = dir.join(name);
            std::fs::write(&path, b"jpeg").unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(at(secs))
                .unwrap();
            path
        };
        let older = write("a.jpg", 1_000);
        let kept = write("b.jpg", 2_000);
        let newer = write("c.jpg", 3_000);
        retire_older_in(&dir, &kept);
        assert!(!older.exists());
        assert!(kept.exists());
        assert!(newer.exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unreadable_files_are_refused() {
        let dir = temp_dir("refuse");
        let source = dir.join("broken.png");
        std::fs::write(&source, b"not a picture").unwrap();
        assert!(normalize(&source).is_err());
        assert!(normalize(&dir.join("missing.png")).is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
