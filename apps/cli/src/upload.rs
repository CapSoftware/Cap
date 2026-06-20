use std::path::{Path, PathBuf};

use cap_project::RecordingMeta;
use clap::Args;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::io::ReaderStream;

use crate::{OutputFormat, credentials, export, resolve_format, write_json};

#[derive(Args)]
pub struct UploadArgs {
    /// Path to a video file (.mp4) or a '.cap' project directory to upload
    file: PathBuf,
    /// Title for the uploaded video
    #[arg(long)]
    name: Option<String>,
    /// Reuse an existing video id instead of creating a new one
    #[arg(long)]
    video_id: Option<String>,
    /// If the input is a '.cap' project with no exported video yet, export it first
    #[arg(long)]
    export: bool,
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum UploadEvent<'a> {
    Uploaded { id: &'a str, link: &'a str },
}

struct VideoMeta {
    duration_in_secs: f64,
    width: u32,
    height: u32,
    fps: f64,
}

fn rational_fps(rate: ffmpeg::Rational) -> Option<f64> {
    (rate.denominator() != 0 && rate.numerator() > 0)
        .then(|| f64::from(rate.numerator()) / f64::from(rate.denominator()))
}

fn is_mp4(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
}

impl UploadArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let format = resolve_format(json, self.format);
        match self.run_inner(format).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if format == OutputFormat::Json {
                    let _ = write_json(&json!({ "error": error }));
                }
                Err(error)
            }
        }
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), String> {
        // Resolves CAP_API_KEY, else the login Cap Desktop already stored, so an agent never has to
        // fetch or paste a key when the user is signed in.
        let creds = credentials::resolve()?;
        let server = creds.server.clone();

        let file_path = self.resolve_upload_file().await?;
        let meta = probe_video_meta(&file_path)?;

        let http = Client::new();
        let auth = format!("Bearer {}", creds.api_key);

        let video_id =
            create_video(&http, &server, &auth, &self.name, self.video_id, &meta).await?;
        let put_url = presign_put(&http, &server, &auth, &video_id, &meta).await?;
        upload_file(&http, &put_url, &file_path).await?;

        let link = format!("{server}/s/{video_id}");

        let is_project = self.file.is_dir()
            || self
                .file
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("cap"));
        if is_project {
            crate::automation::run_upload_completed(&self.file, &link, &video_id).await;
        }

        match format {
            OutputFormat::Json => write_json(&UploadEvent::Uploaded {
                id: &video_id,
                link: &link,
            })?,
            OutputFormat::Text => println!("{link}"),
        }

        Ok(())
    }

    async fn resolve_upload_file(&self) -> Result<PathBuf, String> {
        let input = &self.file;
        let is_project = input.is_dir()
            || input
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("cap"));

        if is_project {
            let meta = RecordingMeta::load_for_project(input)
                .map_err(|e| format!("Failed to load project at {}: {e}", input.display()))?;
            let output = meta.output_path();
            if output.exists() {
                return Ok(output);
            }
            if self.export {
                return export::export_project_default(input.clone()).await;
            }
            Err(format!(
                "Project has no exported video at {}; run `cap export {}` first, or pass --export to export it automatically",
                output.display(),
                input.display()
            ))
        } else if input.exists() {
            // The video is stored under (and played back from) a canonical `result.mp4` key, so the
            // bytes must actually be MP4. A `.cap` project always resolves to an MP4 output above, but a
            // directly-passed file could be a gif/mov from `cap export`; reject it rather than store it
            // mislabeled.
            if !is_mp4(input) {
                return Err(format!(
                    "cap upload only supports MP4 files; {} is not an .mp4. \
                     Export to MP4 first with `cap export <project.cap> --format mp4`.",
                    input.display()
                ));
            }
            Ok(input.clone())
        } else {
            Err(format!("File not found: {}", input.display()))
        }
    }
}

/// Upload an existing MP4 video file and return its shareable link. Reuses the same credential
/// resolution and signed-upload flow as `cap upload`, so automation-driven uploads behave identically.
pub async fn upload_video_path(file_path: &Path, name: Option<String>) -> Result<String, String> {
    if !is_mp4(file_path) {
        return Err(format!(
            "Automation upload only supports MP4 files; {} is not an .mp4",
            file_path.display()
        ));
    }

    let creds = credentials::resolve()?;
    let server = creds.server.clone();
    let meta = probe_video_meta(file_path)?;

    let http = Client::new();
    let auth = format!("Bearer {}", creds.api_key);

    let video_id = create_video(&http, &server, &auth, &name, None, &meta).await?;
    let put_url = presign_put(&http, &server, &auth, &video_id, &meta).await?;
    upload_file(&http, &put_url, file_path).await?;

    Ok(format!("{server}/s/{video_id}"))
}

fn probe_video_meta(path: &Path) -> Result<VideoMeta, String> {
    ffmpeg::init().map_err(|e| format!("Failed to initialise FFmpeg: {e}"))?;

    let input = ffmpeg::format::input(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "No video stream found in file".to_string())?;
    // The codec context's frame_rate is often unset for mp4, which made uploads send fps=null and
    // the signed-URL endpoint reject them. The stream's r_frame_rate is the reliable source; fall
    // back to the decoder, then a sane default so a probe gap never blocks an upload.
    let stream_rate = stream.rate();
    let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("Unable to read video codec: {e}"))?
        .decoder()
        .video()
        .map_err(|e| format!("Unable to read video decoder: {e}"))?;

    let fps = rational_fps(stream_rate)
        .or_else(|| decoder.frame_rate().and_then(rational_fps))
        .unwrap_or(30.0);

    let width = decoder.width();
    let height = decoder.height();
    if width == 0 || height == 0 {
        return Err(format!(
            "{} has invalid video dimensions ({width}x{height})",
            path.display()
        ));
    }

    // ffmpeg reports AV_NOPTS_VALUE (a large negative) for the container duration of a streamed or
    // fragmented MP4; fall back to the video stream's own duration and clamp, so a probe gap never
    // sends a negative durationInSecs to the server (which stores it verbatim).
    let container_duration = input.duration();
    let duration_in_secs = if container_duration > 0 {
        container_duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE)
    } else {
        let stream_duration = stream.duration();
        let time_base = stream.time_base();
        if stream_duration > 0 && time_base.denominator() != 0 {
            stream_duration as f64 * f64::from(time_base.numerator())
                / f64::from(time_base.denominator())
        } else {
            0.0
        }
    };

    Ok(VideoMeta {
        duration_in_secs,
        width,
        height,
        fps,
    })
}

async fn create_video(
    http: &Client,
    server: &str,
    auth: &str,
    name: &Option<String>,
    video_id: Option<String>,
    meta: &VideoMeta,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct CreateResponse {
        id: String,
    }

    let mut params: Vec<(&str, String)> = vec![
        ("recordingMode", "desktopMP4".to_string()),
        ("durationInSecs", meta.duration_in_secs.to_string()),
        ("width", meta.width.to_string()),
        ("height", meta.height.to_string()),
    ];
    params.push(("fps", meta.fps.to_string()));
    if let Some(name) = name {
        params.push(("name", name.clone()));
    }
    if let Some(id) = &video_id {
        params.push(("videoId", id.clone()));
    }

    let response = http
        .get(format!("{server}/api/desktop/video/create"))
        .header("Authorization", auth)
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Cap: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Video creation failed ({status}): {body}"));
    }

    response
        .json::<CreateResponse>()
        .await
        .map(|r| r.id)
        .map_err(|e| format!("Unexpected video-create response: {e}"))
}

async fn presign_put(
    http: &Client,
    server: &str,
    auth: &str,
    video_id: &str,
    meta: &VideoMeta,
) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SignedResponse {
        presigned_put_data: PresignedPutData,
    }
    #[derive(Deserialize)]
    struct PresignedPutData {
        url: String,
    }

    let response = http
        .post(format!("{server}/api/upload/signed"))
        .header("Authorization", auth)
        .json(&json!({
            "videoId": video_id,
            // The web player resolves a desktopMP4 video from the canonical `<id>/result.mp4` key, and
            // the server only marks the upload complete when the key ends in `result.mp4` — so this is
            // fixed, and `cap upload` guards its input to MP4 to keep the stored bytes consistent.
            "subpath": "result.mp4",
            "method": "put",
            "durationInSecs": meta.duration_in_secs,
            "width": meta.width,
            "height": meta.height,
            "fps": meta.fps,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to request upload URL: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Upload URL request failed ({status}): {body}"));
    }

    response
        .json::<SignedResponse>()
        .await
        .map(|r| r.presigned_put_data.url)
        .map_err(|e| format!("Unexpected upload-URL response: {e}"))
}

async fn upload_file(http: &Client, put_url: &str, path: &Path) -> Result<(), String> {
    // Stream the file rather than buffering it into memory — recordings can be gigabytes, so a
    // `tokio::fs::read` would OOM on exactly the long unattended recordings agents produce. S3 PUT
    // needs an explicit Content-Length for a streamed body (it rejects chunked transfer encoding),
    // mirroring the desktop's singlepart uploader.
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let total_size = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?
        .len();
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));

    let response = http
        .put(put_url)
        .header(reqwest::header::CONTENT_LENGTH, total_size)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Upload failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Storage upload failed ({status}): {body}"));
    }

    Ok(())
}
