use crate::{
    types::{
        CompleteMultipartRequest, CompleteMultipartResponse, InitiateMultipartResponse,
        ListVideosResponse, Organization, PresignPartResponse, S3ConfigData, S3ConfigInput,
        S3ConfigResponse, TranscriptResponse, Video, VideoInfo,
    },
    ApiError, AuthConfig,
};
use std::time::Duration;

const API_TIMEOUT: Duration = Duration::from_secs(10);

pub struct CapClient {
    http: reqwest::Client,
    auth: AuthConfig,
}

impl CapClient {
    pub fn new(auth: AuthConfig) -> Result<Self, ApiError> {
        let http = reqwest::Client::builder().timeout(API_TIMEOUT).build()?;
        Ok(Self { http, auth })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.auth.server_url.trim_end_matches('/'), path)
    }

    fn authed(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        builder.header("Authorization", format!("Bearer {}", self.auth.api_key))
    }

    async fn check_response(resp: reqwest::Response) -> Result<reqwest::Response, ApiError> {
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthorized);
        }
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<no response body>".to_string());
            return Err(ApiError::ServerError {
                status: status.as_u16(),
                body,
            });
        }
        Ok(resp)
    }

    pub async fn create_video(&self, org_id: Option<&str>) -> Result<Video, ApiError> {
        let mut url = self.url("/api/desktop/video/create?recordingMode=desktopMP4");
        if let Some(org) = org_id {
            url.push_str(&format!("&orgId={org}"));
        }
        let resp = self.authed(self.http.get(&url)).send().await.map_err(|e| {
            if e.is_connect() {
                return ApiError::Unreachable {
                    url: self.auth.server_url.clone(),
                };
            }
            if e.is_timeout() {
                return ApiError::Timeout {
                    timeout_secs: API_TIMEOUT.as_secs(),
                };
            }
            ApiError::Http(e)
        })?;
        let resp = Self::check_response(resp).await?;
        Ok(resp.json().await?)
    }

    pub async fn delete_video(&self, video_id: &str) -> Result<(), ApiError> {
        let url = self.url("/api/desktop/video/delete");
        let resp = self
            .authed(self.http.delete(&url).query(&[("videoId", video_id)]))
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    pub async fn initiate_multipart(
        &self,
        video_id: &str,
        content_type: &str,
    ) -> Result<String, ApiError> {
        let url = self.url("/api/upload/multipart/initiate");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "videoId": video_id,
                        "contentType": content_type
                    })),
            )
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        let data: InitiateMultipartResponse = resp.json().await?;
        Ok(data.upload_id)
    }

    pub async fn presign_part(
        &self,
        video_id: &str,
        upload_id: &str,
        part_number: u32,
    ) -> Result<String, ApiError> {
        let url = self.url("/api/upload/multipart/presign-part");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "videoId": video_id,
                        "uploadId": upload_id,
                        "partNumber": part_number
                    })),
            )
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        let data: PresignPartResponse = resp.json().await?;
        Ok(data.presigned_url)
    }

    pub async fn complete_multipart(
        &self,
        req: &CompleteMultipartRequest,
    ) -> Result<CompleteMultipartResponse, ApiError> {
        let url = self.url("/api/upload/multipart/complete");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(req),
            )
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        Ok(resp.json().await?)
    }

    pub async fn abort_multipart(&self, video_id: &str, upload_id: &str) -> Result<(), ApiError> {
        let url = self.url("/api/upload/multipart/abort");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "videoId": video_id,
                        "uploadId": upload_id
                    })),
            )
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    pub async fn list_organizations(&self) -> Result<Vec<Organization>, ApiError> {
        let url = self.url("/api/desktop/organizations");
        let resp = self.authed(self.http.get(&url)).send().await?;
        let resp = Self::check_response(resp).await?;
        Ok(resp.json().await?)
    }

    pub async fn get_s3_config(&self) -> Result<S3ConfigData, ApiError> {
        let url = self.url("/api/desktop/s3/config/get");
        let resp = self.authed(self.http.get(&url)).send().await?;
        let resp = Self::check_response(resp).await?;
        let wrapper: S3ConfigResponse = resp.json().await?;
        Ok(wrapper.config)
    }

    pub async fn set_s3_config(&self, config: &S3ConfigInput) -> Result<(), ApiError> {
        let url = self.url("/api/desktop/s3/config");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(config),
            )
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    pub async fn test_s3_config(&self, config: &S3ConfigInput) -> Result<(), ApiError> {
        let url = self.url("/api/desktop/s3/config/test");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(config),
            )
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    pub async fn delete_s3_config(&self) -> Result<(), ApiError> {
        let url = self.url("/api/desktop/s3/config/delete");
        let resp = self.authed(self.http.delete(&url)).send().await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    pub async fn upload_signed(
        &self,
        video_id: &str,
        subpath: &str,
        data: Vec<u8>,
    ) -> Result<(), ApiError> {
        let url = self.url("/api/upload/signed");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "videoId": video_id,
                        "subpath": subpath,
                        "method": "put"
                    })),
            )
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        let body: serde_json::Value = resp.json().await?;
        let presigned_url =
            body["presignedPutData"]["url"]
                .as_str()
                .ok_or_else(|| ApiError::ServerError {
                    status: 500,
                    body: "Missing presignedPutData.url in response".to_string(),
                })?;
        self.http
            .put(presigned_url)
            .header("Content-Type", "image/jpeg")
            .header("Content-Length", data.len())
            .body(data)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        Ok(())
    }

    pub async fn get_video_info(&self, video_id: &str) -> Result<VideoInfo, ApiError> {
        let url = self.url("/api/desktop/video/info");
        let resp = self
            .authed(self.http.get(&url).query(&[("videoId", video_id)]))
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        Ok(resp.json().await?)
    }

    pub async fn get_transcript(&self, video_id: &str) -> Result<String, ApiError> {
        let url = self.url("/api/desktop/video/transcript");
        let resp = self
            .authed(self.http.get(&url).query(&[("videoId", video_id)]))
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        let data: TranscriptResponse = resp.json().await?;
        Ok(data.content)
    }

    pub async fn set_video_password(
        &self,
        video_id: &str,
        password: Option<&str>,
    ) -> Result<(), ApiError> {
        let url = self.url("/api/desktop/video/password");
        let resp = self
            .authed(
                self.http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "videoId": video_id,
                        "password": password
                    })),
            )
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    pub async fn list_videos(
        &self,
        org_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<ListVideosResponse, ApiError> {
        let url = self.url("/api/desktop/video/list");
        let mut query: Vec<(&str, String)> =
            vec![("limit", limit.to_string()), ("offset", offset.to_string())];
        if let Some(org) = org_id {
            query.push(("orgId", org.to_string()));
        }
        let resp = self
            .authed(self.http.get(&url).query(&query))
            .send()
            .await?;
        let resp = Self::check_response(resp).await?;
        Ok(resp.json().await?)
    }

    pub fn share_url(&self, video_id: &str) -> String {
        format!(
            "{}/s/{}",
            self.auth.server_url.trim_end_matches('/'),
            video_id
        )
    }

    pub async fn submit_feedback(
        &self,
        feedback: &str,
        os: &str,
        version: &str,
    ) -> Result<(), ApiError> {
        let resp = self
            .authed(self.http.post(self.url("/api/desktop/feedback")))
            .form(&[("feedback", feedback), ("os", os), ("version", version)])
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
    }

    pub async fn upload_debug_logs(
        &self,
        log_data: Vec<u8>,
        os: &str,
        version: &str,
        diagnostics_json: &str,
    ) -> Result<(), ApiError> {
        let filename = format!(
            "cap-cli-{}-{}-{}.log",
            os,
            version,
            chrono::Utc::now().format("%Y%m%d%H%M%S")
        );
        let log_part = reqwest::multipart::Part::bytes(log_data)
            .file_name(filename)
            .mime_str("text/plain")
            .map_err(|e| ApiError::Other(e.to_string()))?;

        let form = reqwest::multipart::Form::new()
            .part("file", log_part)
            .text("os", os.to_string())
            .text("version", version.to_string())
            .text("diagnostics", diagnostics_json.to_string());

        let resp = self
            .authed(self.http.post(self.url("/api/desktop/logs")))
            .multipart(form)
            .send()
            .await?;
        Self::check_response(resp).await?;
        Ok(())
    }
}
