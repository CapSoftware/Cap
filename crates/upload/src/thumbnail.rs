use crate::client::CapClient;
use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use std::path::Path;
use std::process::Command;
use tracing::debug;

pub fn extract_first_frame(video_path: &Path, output_path: &Path) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args([
            "-i",
            video_path.to_str().unwrap_or_default(),
            "-vframes",
            "1",
            "-q:v",
            "2",
            "-y",
            output_path.to_str().unwrap_or_default(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;

    if !status.success() {
        return Err("ffmpeg failed to extract frame".to_string());
    }
    Ok(())
}

pub fn compress_image(path: &Path) -> Result<Vec<u8>, String> {
    let img = ImageReader::open(path)
        .map_err(|e| format!("Failed to open image: {e}"))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {e}"))?;

    let resized = img.resize(
        img.width() / 2,
        img.height() / 2,
        image::imageops::FilterType::Nearest,
    );

    let mut buffer = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 30);
    encoder
        .encode(
            resized.as_bytes(),
            resized.width(),
            resized.height(),
            resized.color().into(),
        )
        .map_err(|e| format!("Failed to encode JPEG: {e}"))?;

    Ok(buffer)
}

pub async fn generate_and_upload_thumbnail(
    client: &CapClient,
    video_id: &str,
    video_path: &Path,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let frame_path = temp_dir.join(format!("cap-thumb-{video_id}.png"));

    extract_first_frame(video_path, &frame_path)?;
    let jpeg_result = compress_image(&frame_path);
    std::fs::remove_file(&frame_path).ok();
    let jpeg_data = jpeg_result?;

    debug!(
        video_id,
        size_bytes = jpeg_data.len(),
        "Uploading thumbnail"
    );

    client
        .upload_signed(video_id, "screenshot/screen-capture.jpg", jpeg_data)
        .await
        .map_err(|e| format!("Failed to upload thumbnail: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn compress_nonexistent_file_returns_error() {
        let result = compress_image(&PathBuf::from("/tmp/nonexistent-cap-test.png"));
        assert!(result.is_err());
    }
}
