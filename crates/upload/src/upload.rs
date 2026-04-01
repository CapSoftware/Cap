use crate::{
    client::CapClient,
    error::UploadError,
    types::{CompleteMultipartRequest, UploadResult, UploadedPart, VideoMetadata},
};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tracing::{debug, info, warn};

const CHUNK_SIZE: usize = 5 * 1024 * 1024;
const MAX_CONCURRENCY: usize = 3;
const MAX_RETRIES: u32 = 3;

pub trait UploadProgress: Send + Sync {
    fn on_chunk_uploaded(&self, bytes_uploaded: u64, total_bytes: u64);
    fn on_complete(&self);
    fn on_error(&self, error: &str);
}

pub fn detect_content_type(path: &Path) -> Result<&'static str, UploadError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "mp4" => Ok("video/mp4"),
        "webm" => Ok("video/webm"),
        "mov" => Ok("video/quicktime"),
        "mkv" => Ok("video/x-matroska"),
        "avi" => Ok("video/x-msvideo"),
        other => Err(UploadError::UnsupportedFormat {
            extension: other.to_string(),
        }),
    }
}

fn calculate_parts(file_size: u64, chunk_size: usize) -> Vec<(u32, u64, usize)> {
    if file_size == 0 {
        return vec![];
    }
    let chunk_size_u64 = chunk_size as u64;
    let num_parts = file_size.div_ceil(chunk_size_u64) as u32;
    (0..num_parts)
        .map(|i| {
            let offset = i as u64 * chunk_size_u64;
            let size = std::cmp::min(chunk_size_u64, file_size - offset) as usize;
            (i + 1, offset, size)
        })
        .collect()
}

pub struct UploadEngine<'a> {
    client: &'a CapClient,
}

impl<'a> UploadEngine<'a> {
    pub fn new(client: &'a CapClient) -> Self {
        Self { client }
    }

    pub async fn upload_file(
        &self,
        path: &Path,
        metadata: VideoMetadata,
        progress: Option<&dyn UploadProgress>,
        org_id: Option<&str>,
    ) -> Result<UploadResult, UploadError> {
        if !path.exists() {
            return Err(UploadError::FileNotFound(path.to_path_buf()));
        }

        let content_type = detect_content_type(path)?;
        let file_size = tokio::fs::metadata(path).await?.len();

        info!(
            path = %path.display(),
            size_mb = file_size as f64 / 1_000_000.0,
            content_type,
            "Starting upload"
        );

        let video = self.client.create_video(org_id).await?;
        let video_id = video.id.clone();

        let upload_id = self
            .client
            .initiate_multipart(&video_id, content_type)
            .await?;

        let parts_plan = calculate_parts(file_size, CHUNK_SIZE);

        let result = self
            .upload_all_chunks(
                path,
                &video_id,
                &upload_id,
                &parts_plan,
                file_size,
                progress,
            )
            .await;

        match result {
            Ok(uploaded_parts) => {
                let complete_req = CompleteMultipartRequest {
                    video_id: video_id.clone(),
                    upload_id: upload_id.clone(),
                    parts: uploaded_parts,
                    duration_in_secs: metadata.duration_secs,
                    width: metadata.width,
                    height: metadata.height,
                    fps: metadata.fps,
                };

                self.client.complete_multipart(&complete_req).await?;

                if let Some(p) = progress {
                    p.on_complete();
                }

                match crate::thumbnail::generate_and_upload_thumbnail(self.client, &video_id, path)
                    .await
                {
                    Ok(()) => debug!("Thumbnail uploaded"),
                    Err(e) => warn!(error = %e, "Thumbnail upload failed (non-fatal)"),
                }

                let share_url = self.client.share_url(&video_id);
                info!(share_url = %share_url, "Upload complete");

                Ok(UploadResult {
                    video_id,
                    share_url,
                })
            }
            Err(e) => {
                warn!(video_id = %video_id, "Upload failed, aborting multipart upload");
                self.client
                    .abort_multipart(&video_id, &upload_id)
                    .await
                    .ok();
                if let Some(p) = progress {
                    p.on_error(&e.to_string());
                }
                Err(e)
            }
        }
    }

    async fn upload_all_chunks(
        &self,
        path: &Path,
        video_id: &str,
        upload_id: &str,
        parts_plan: &[(u32, u64, usize)],
        total_size: u64,
        progress: Option<&dyn UploadProgress>,
    ) -> Result<Vec<UploadedPart>, UploadError> {
        let mut uploaded_parts: Vec<UploadedPart> = Vec::with_capacity(parts_plan.len());
        let mut bytes_uploaded: u64 = 0;

        for batch in parts_plan.chunks(MAX_CONCURRENCY) {
            let mut handles = tokio::task::JoinSet::new();

            for &(part_number, offset, size) in batch {
                let mut chunk_data = vec![0u8; size];
                let mut file = tokio::fs::File::open(path).await?;
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                file.read_exact(&mut chunk_data).await?;

                let vid = video_id.to_string();
                let uid = upload_id.to_string();

                let presigned_url = self.client.presign_part(&vid, &uid, part_number).await?;

                handles.spawn({
                    let chunk_data = chunk_data;
                    async move {
                        let size = chunk_data.len();
                        let etag = upload_chunk_with_retry(&presigned_url, chunk_data, part_number)
                            .await?;
                        Ok::<UploadedPart, UploadError>(UploadedPart {
                            part_number,
                            etag,
                            size,
                        })
                    }
                });
            }

            while let Some(result) = handles.join_next().await {
                let part = result.expect("chunk upload task panicked")?;
                bytes_uploaded += part.size as u64;
                if let Some(p) = progress {
                    p.on_chunk_uploaded(bytes_uploaded, total_size);
                }
                uploaded_parts.push(part);
            }
        }

        uploaded_parts.sort_by_key(|p| p.part_number);
        Ok(uploaded_parts)
    }
}

async fn upload_chunk_with_retry(
    presigned_url: &str,
    data: Vec<u8>,
    part_number: u32,
) -> Result<String, UploadError> {
    let client = reqwest::Client::new();

    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            let delay = std::time::Duration::from_secs(1 << attempt);
            debug!(
                part_number,
                attempt,
                delay_secs = delay.as_secs(),
                "Retrying chunk upload"
            );
            tokio::time::sleep(delay).await;
        }

        match client
            .put(presigned_url)
            .header("Content-Length", data.len())
            .body(data.clone())
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
        {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    warn!(part_number, attempt, %status, body = %body, "Chunk upload HTTP error");
                    continue;
                }
                let etag = resp
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                return Ok(etag);
            }
            Err(e) => {
                warn!(part_number, attempt, error = %e, "Chunk upload failed");
            }
        }
    }

    Err(UploadError::ChunkFailed {
        part_number,
        max_retries: MAX_RETRIES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn detect_mp4() {
        assert_eq!(
            detect_content_type(&PathBuf::from("video.mp4")).unwrap(),
            "video/mp4"
        );
    }

    #[test]
    fn detect_webm() {
        assert_eq!(
            detect_content_type(&PathBuf::from("video.webm")).unwrap(),
            "video/webm"
        );
    }

    #[test]
    fn detect_mov() {
        assert_eq!(
            detect_content_type(&PathBuf::from("recording.MOV")).unwrap(),
            "video/quicktime"
        );
    }

    #[test]
    fn detect_mkv() {
        assert_eq!(
            detect_content_type(&PathBuf::from("video.mkv")).unwrap(),
            "video/x-matroska"
        );
    }

    #[test]
    fn detect_avi() {
        assert_eq!(
            detect_content_type(&PathBuf::from("clip.avi")).unwrap(),
            "video/x-msvideo"
        );
    }

    #[test]
    fn detect_unsupported() {
        let err = detect_content_type(&PathBuf::from("file.gif")).unwrap_err();
        assert!(err.to_string().contains("Unsupported format"));
    }

    #[test]
    fn calculate_parts_exact_multiple() {
        let parts = calculate_parts(15 * 1024 * 1024, 5 * 1024 * 1024);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], (1, 0, 5 * 1024 * 1024));
        assert_eq!(parts[1], (2, 5u64 * 1024 * 1024, 5 * 1024 * 1024));
        assert_eq!(parts[2], (3, 10u64 * 1024 * 1024, 5 * 1024 * 1024));
    }

    #[test]
    fn calculate_parts_one_byte_over() {
        let file_size = 5 * 1024 * 1024 + 1;
        let parts = calculate_parts(file_size as u64, 5 * 1024 * 1024);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], (1, 0, 5 * 1024 * 1024));
        assert_eq!(parts[1], (2, 5u64 * 1024 * 1024, 1));
    }

    #[test]
    fn calculate_parts_small_file() {
        let parts = calculate_parts(100, 5 * 1024 * 1024);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], (1, 0, 100));
    }

    #[test]
    fn calculate_parts_zero_bytes() {
        let parts = calculate_parts(0, 5 * 1024 * 1024);
        assert_eq!(parts.len(), 0);
    }
}
