//! TODO: We should investigate generating this with OpenAPI.
//! This will come part of the EffectTS rewrite work.

use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::AppHandle;
use tracing::{instrument, trace};

use crate::web_api::{AuthedApiError, ManagerExt};

#[instrument(skip(app))]
pub async fn upload_multipart_initiate(
    app: &AppHandle,
    video_id: &str,
    subpath: &str,
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
                    "subpath": subpath,
                    "contentType": "video/mp4"
                }))
        })
        .await
        .map_err(|err| format!("api/upload_multipart_initiate/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
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

#[instrument(skip(app, upload_id))]
pub async fn upload_multipart_presign_part(
    app: &AppHandle,
    video_id: &str,
    subpath: &str,
    upload_id: &str,
    part_number: u32,
    md5_sum: Option<&str>,
) -> Result<String, AuthedApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Response {
        presigned_url: String,
    }

    let mut body = serde_json::Map::from_iter([
        ("videoId".to_string(), json!(video_id)),
        ("subpath".to_string(), json!(subpath)),
        ("uploadId".to_string(), json!(upload_id)),
        ("partNumber".to_string(), json!(part_number)),
    ]);

    if let Some(md5_sum) = md5_sum {
        body.insert("md5Sum".to_string(), json!(md5_sum));
    }

    let resp = app
        .authed_api_request("/api/upload/multipart/presign-part", |c, url| {
            c.post(url)
                .header("Content-Type", "application/json")
                .json(&serde_json::json!(body))
        })
        .await
        .map_err(|err| format!("api/upload_multipart_presign_part/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
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

#[instrument(skip_all)]
pub async fn upload_multipart_complete(
    app: &AppHandle,
    video_id: &str,
    subpath: &str,
    upload_id: &str,
    parts: &[UploadedPart],
    meta: Option<S3VideoMeta>,
) -> Result<Option<String>, AuthedApiError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MultipartCompleteRequest<'a> {
        video_id: &'a str,
        subpath: &'a str,
        upload_id: &'a str,
        parts: &'a [UploadedPart],
        #[serde(flatten)]
        meta: Option<S3VideoMeta>,
    }

    #[derive(Deserialize)]
    pub struct Response {
        location: Option<String>,
    }

    trace!("Completing multipart upload");

    let resp = app
        .authed_api_request("/api/upload/multipart/complete", |c, url| {
            c.post(url)
                .header("Content-Type", "application/json")
                .json(&MultipartCompleteRequest {
                    video_id,
                    subpath,
                    upload_id,
                    parts,
                    meta,
                })
        })
        .await
        .map_err(|err| format!("api/upload_multipart_complete/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
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

#[instrument(skip(app))]
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
        let status = resp.status().as_u16();
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

#[instrument(skip(app))]
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
        let status = resp.status().as_u16();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!("api/desktop_video_progress/{status}: {error_body}").into());
    }

    Ok(())
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub owner_id: String,
}

pub async fn fetch_organizations(app: &AppHandle) -> Result<Vec<Organization>, AuthedApiError> {
    let resp = app
        .authed_api_request("/api/desktop/organizations", |client, url| client.get(url))
        .await
        .map_err(|err| format!("api/fetch_organizations/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!("api/fetch_organizations/{status}: {error_body}").into());
    }

    resp.json()
        .await
        .map_err(|err| format!("api/fetch_organizations/response: {err}").into())
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

pub async fn fetch_workspaces(app: &AppHandle) -> Result<Vec<Workspace>, AuthedApiError> {
    #[derive(Deserialize)]
    struct Response {
        workspaces: Vec<Workspace>,
    }

    let resp = app
        .authed_api_request("/api/desktop/workspaces", |client, url| client.get(url))
        .await
        .map_err(|err| format!("api/fetch_workspaces/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!("api/fetch_workspaces/{status}: {error_body}").into());
    }

    let response: Response = resp
        .json()
        .await
        .map_err(|err| format!("api/fetch_workspaces/response: {err}"))?;

    Ok(response.workspaces)
}

#[instrument(skip(app))]
pub async fn trigger_ai_processing(
    app: &AppHandle,
    recording_id: &str,
) -> Result<(), AuthedApiError> {
    let resp = app
        .authed_api_request("/api/recording/process-ai", |c, url| {
            c.post(url)
                .header("Content-Type", "application/json")
                .json(&serde_json::json!({
                    "recordingId": recording_id
                }))
        })
        .await
        .map_err(|err| format!("api/trigger_ai_processing/request: {err}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let error_body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        trace!("AI processing trigger failed (non-critical): {status}: {error_body}");
        return Ok(());
    }

    trace!("AI processing triggered successfully for recording {}", recording_id);
    Ok(()
)}
