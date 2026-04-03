use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Video {
    pub id: String,
    pub user_id: String,
    pub aws_region: String,
    pub aws_bucket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitiateMultipartResponse {
    pub upload_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignPartResponse {
    pub presigned_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedPart {
    pub part_number: u32,
    pub etag: String,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteMultipartRequest {
    pub video_id: String,
    pub upload_id: String,
    pub parts: Vec<UploadedPart>,
    #[serde(rename = "durationInSecs")]
    pub duration_in_secs: f64,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompleteMultipartResponse {
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Organization {
    pub id: String,
    pub name: String,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ConfigInput {
    pub provider: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub endpoint: String,
    pub bucket_name: String,
    pub region: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ConfigResponse {
    pub config: S3ConfigData,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ConfigData {
    pub provider: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub endpoint: String,
    pub bucket_name: String,
    pub region: String,
}

#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps: Option<f32>,
}

pub struct UploadResult {
    pub video_id: String,
    pub share_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub id: String,
    pub name: Option<String>,
    pub created_at: Option<String>,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub public: Option<bool>,
    pub has_password: bool,
    pub transcription_status: Option<String>,
    pub ai_title: Option<String>,
    pub summary: Option<String>,
    pub chapters: Option<Vec<Chapter>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    pub title: String,
    pub start: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptResponse {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSummary {
    pub id: String,
    pub name: Option<String>,
    pub created_at: Option<String>,
    pub duration: Option<f64>,
    pub has_password: bool,
    pub transcription_status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListVideosResponse {
    pub data: Vec<VideoSummary>,
    pub total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_video_info() {
        let json = r#"{
            "id": "abc123",
            "name": "My Video",
            "createdAt": "2026-03-31T12:00:00Z",
            "duration": 15.5,
            "width": 1920,
            "height": 1080,
            "public": true,
            "hasPassword": false,
            "transcriptionStatus": "COMPLETE",
            "aiTitle": "AI Generated Title",
            "summary": "A summary of the video",
            "chapters": [{"title": "Intro", "start": 0.0}, {"title": "Main", "start": 5.0}]
        }"#;
        let info: VideoInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.id, "abc123");
        assert_eq!(info.name.as_deref(), Some("My Video"));
        assert_eq!(info.duration, Some(15.5));
        assert!(!info.has_password);
        assert_eq!(info.chapters.as_ref().unwrap().len(), 2);
        assert_eq!(info.chapters.as_ref().unwrap()[1].title, "Main");
    }

    #[test]
    fn deserialize_video_info_nulls() {
        let json = r#"{
            "id": "xyz",
            "name": null,
            "createdAt": null,
            "duration": null,
            "width": null,
            "height": null,
            "public": null,
            "hasPassword": true,
            "transcriptionStatus": null,
            "aiTitle": null,
            "summary": null,
            "chapters": null
        }"#;
        let info: VideoInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.id, "xyz");
        assert!(info.name.is_none());
        assert!(info.duration.is_none());
        assert!(info.has_password);
        assert!(info.chapters.is_none());
    }

    #[test]
    fn deserialize_list_videos_response() {
        let json = r#"{
            "data": [
                {
                    "id": "v1",
                    "name": "Video One",
                    "createdAt": "2026-03-31T12:00:00Z",
                    "duration": 30.0,
                    "hasPassword": false,
                    "transcriptionStatus": "PROCESSING"
                },
                {
                    "id": "v2",
                    "name": null,
                    "createdAt": null,
                    "duration": null,
                    "hasPassword": true,
                    "transcriptionStatus": null
                }
            ],
            "total": 42
        }"#;
        let resp: ListVideosResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.data.len(), 2);
        assert_eq!(resp.total, 42);
        assert_eq!(resp.data[0].id, "v1");
        assert!(resp.data[1].has_password);
        assert!(resp.data[1].name.is_none());
    }

    #[test]
    fn deserialize_chapter() {
        let json = r#"{"title": "Getting Started", "start": 12.5}"#;
        let ch: Chapter = serde_json::from_str(json).unwrap();
        assert_eq!(ch.title, "Getting Started");
        assert!((ch.start - 12.5).abs() < f64::EPSILON);
    }

    #[test]
    fn deserialize_transcript_response() {
        let json = r#"{"content": "WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nHello world"}"#;
        let resp: TranscriptResponse = serde_json::from_str(json).unwrap();
        assert!(resp.content.starts_with("WEBVTT"));
    }
}
