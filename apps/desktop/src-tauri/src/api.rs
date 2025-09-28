//! TODO: We should investigate generating this with OpenAPI.
//! This will come part of the EffectTS rewrite work.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::web_api::ManagerExt;

// TODO: Adding retry and backoff logic to everything!

pub async fn upload_multipart_initiate(app: &AppHandle, video_id: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    pub struct Response {
        upload_id: String,
    }

    let resp = app
        .authed_api_request("/api/upload/multipart/initiate", |c, url| {
            c.post(url)
                .header("Content-Type", "application/json")
                .json(&serde_json::json!({
                    "videoId": video_id,
                    "contentType": "video/mp4"
                }))
        })
        .await
        .map_err(|err| format!("api/upload_multipart_initiate/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!(
            "api/upload_multipart_initiate/{status}: {error_body}"
        ));
    }

    resp.json::<Response>()
        .await
        .map_err(|err| format!("api/upload_multipart_initiate/response: {err}"))
        .map(|data| data.upload_id)
}

pub async fn upload_multipart_presign_part(
    app: &AppHandle,
    video_id: &str,
    upload_id: &str,
    part_number: u32,
    md5_sum: &str,
) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Response {
        presigned_url: String,
    }

    let resp = app
        .authed_api_request("/api/upload/multipart/presign-part", |c, url| {
            c.post(url)
                .header("Content-Type", "application/json")
                .json(&serde_json::json!({
                    "videoId": video_id,
                    "uploadId": upload_id,
                    "partNumber": part_number,
                    "md5Sum": md5_sum
                }))
        })
        .await
        .map_err(|err| format!("api/upload_multipart_presign_part/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!(
            "api/upload_multipart_presign_part/{status}: {error_body}"
        ));
    }

    resp.json::<Response>()
        .await
        .map_err(|err| format!("api/upload_multipart_presign_part/response: {err}"))
        .map(|data| data.presigned_url)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedPart {
    pub part_number: u32,
    pub etag: String,
    pub size: usize,
    #[serde(skip)]
    pub total_size: u64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct S3VideoMeta {
    #[serde(rename = "durationInSecs")]
    pub duration_in_secs: f64,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f32>,
}

pub async fn upload_multipart_complete(
    app: &AppHandle,
    video_id: &str,
    upload_id: &str,
    parts: &[UploadedPart],
    meta: Option<S3VideoMeta>,
) -> Result<Option<String>, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MultipartCompleteRequest<'a> {
        video_id: &'a str,
        upload_id: &'a str,
        parts: &'a [UploadedPart],
        #[serde(flatten)]
        meta: Option<S3VideoMeta>,
    }

    #[derive(Deserialize)]
    pub struct Response {
        location: Option<String>,
    }

    let resp = app
        .authed_api_request("/api/upload/multipart/complete", |c, url| {
            c.post(url)
                .header("Content-Type", "application/json")
                .json(&MultipartCompleteRequest {
                    video_id,
                    upload_id,
                    parts,
                    meta,
                })
        })
        .await
        .map_err(|err| format!("api/upload_multipart_complete/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!(
            "api/upload_multipart_complete/{status}: {error_body}"
        ));
    }

    resp.json::<Response>()
        .await
        .map_err(|err| format!("api/upload_multipart_complete/response: {err}"))
        .map(|data| data.location)
}
