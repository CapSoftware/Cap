//! TODO: We should investigate generating this with OpenAPI.
//! This will come part of the EffectTS rewrite work.

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use tracing::instrument;

use crate::web_api::{AuthedApiError, ManagerExt};

#[instrument]
pub async fn upload_multipart_initiate(
    app: &AppHandle,
    video_id: &str,
) -> Result<String, AuthedApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
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
        return Err(format!("api/upload_multipart_initiate/{status}: {error_body}").into());
    }

    resp.json::<Response>()
        .await
        .map_err(|err| format!("api/upload_multipart_initiate/response: {err}").into())
        .map(|data| data.upload_id)
}

#[instrument]
pub async fn upload_multipart_presign_part(
    app: &AppHandle,
    video_id: &str,
    upload_id: &str,
    part_number: u32,
    md5_sum: &str,
) -> Result<String, AuthedApiError> {
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
        return Err(format!("api/upload_multipart_presign_part/{status}: {error_body}").into());
    }

    resp.json::<Response>()
        .await
        .map_err(|err| format!("api/upload_multipart_presign_part/response: {err}").into())
        .map(|data| data.presigned_url)
}

#[derive(Debug, Serialize)]
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

#[instrument]
pub async fn upload_multipart_complete(
    app: &AppHandle,
    video_id: &str,
    upload_id: &str,
    parts: &[UploadedPart],
    meta: Option<S3VideoMeta>,
) -> Result<Option<String>, AuthedApiError> {
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
        return Err(format!("api/upload_multipart_complete/{status}: {error_body}").into());
    }

    resp.json::<Response>()
        .await
        .map_err(|err| format!("api/upload_multipart_complete/response: {err}").into())
        .map(|data| data.location)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresignedS3PutRequestMethod {
    #[allow(unused)]
    Post,
    Put,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignedS3PutRequest {
    pub video_id: String,
    pub subpath: String,
    pub method: PresignedS3PutRequestMethod,
    #[serde(flatten)]
    pub meta: Option<S3VideoMeta>,
}

#[instrument(skip())]
pub async fn upload_signed(
    app: &AppHandle,
    body: PresignedS3PutRequest,
) -> Result<String, AuthedApiError> {
    #[derive(Deserialize)]
    struct Data {
        url: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Response {
        presigned_put_data: Data,
    }

    let resp = app
        .authed_api_request("/api/upload/signed", |client, url| {
            client.post(url).json(&body)
        })
        .await
        .map_err(|err| format!("api/upload_signed/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!("api/upload_signed/{status}: {error_body}").into());
    }

    resp.json::<Response>()
        .await
        .map_err(|err| format!("api/upload_signed/response: {err}").into())
        .map(|data| data.presigned_put_data.url)
}

#[instrument]
pub async fn desktop_video_progress(
    app: &AppHandle,
    video_id: &str,
    uploaded: u64,
    total: u64,
) -> Result<(), AuthedApiError> {
    let resp = app
        .authed_api_request("/api/desktop/video/progress", |client, url| {
            client.post(url).json(&json!({
                "videoId": video_id,
                "uploaded": uploaded,
                "total": total,
                "updatedAt": chrono::Utc::now().to_rfc3339()
            }))
        })
        .await
        .map_err(|err| format!("api/desktop_video_progress/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!("api/desktop_video_progress/{status}: {error_body}").into());
    }

    Ok(())
}
