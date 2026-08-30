use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cap_enc_ffmpeg::segmented_stream::{SegmentCompletedEvent, SegmentMediaType};
use cap_project::{RecordingMeta, S3UploadMeta, SharingMeta, UploadMeta, VideoUploadInfo};
use futures_util::{StreamExt as _, stream::FuturesUnordered};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{self, AuthApiError};

const MIN_CHUNK_SIZE: u64 = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE: u64 = 15 * 1024 * 1024;
const MAX_SEGMENT_UPLOADS: usize = 6;
const SEGMENT_URL_PREFETCH: u32 = 20;
const SEGMENT_UPLOAD_ATTEMPTS: u32 = 3;
const MANIFEST_UPLOAD_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
struct SignedUploadTarget {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadResult {
    Success(String),
    NotAuthenticated,
    UpgradeRequired,
}

pub struct InstantUpload {
    pub video: VideoUploadInfo,
    segment_upload: Option<tokio::task::JoinHandle<Result<(), String>>>,
    cancel: Arc<AtomicBool>,
    metadata_lock: Arc<Mutex<()>>,
    completion_permit: Option<tokio::sync::oneshot::Sender<()>>,
    completion_control: Option<CompletionControl>,
}

#[derive(Clone)]
pub(crate) struct CompletionControl {
    denied: tokio::sync::watch::Sender<bool>,
    cancel: Arc<AtomicBool>,
}

impl CompletionControl {
    pub(crate) fn deny(&self) {
        self.cancel.store(true, Ordering::Release);
        self.denied.send_replace(true);
    }
}

pub(crate) struct CompletionAuthorization {
    permit: tokio::sync::oneshot::Sender<()>,
    required: CompletionRequirement,
    control: CompletionControl,
}

struct CompletionRequirement {
    permission: tokio::sync::oneshot::Receiver<()>,
    denied: tokio::sync::watch::Receiver<bool>,
}

impl CompletionAuthorization {
    pub(crate) fn new() -> Self {
        let (permit, permission) = tokio::sync::oneshot::channel();
        let (denied, denial) = tokio::sync::watch::channel(false);
        Self {
            permit,
            required: CompletionRequirement {
                permission,
                denied: denial,
            },
            control: CompletionControl {
                denied,
                cancel: Arc::new(AtomicBool::new(false)),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct SegmentManifestEntry {
    index: u32,
    duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct SegmentUploadManifest {
    version: u32,
    video_init_uploaded: bool,
    audio_init_uploaded: bool,
    video_segments: Vec<SegmentManifestEntry>,
    audio_segments: Vec<SegmentManifestEntry>,
    is_complete: bool,
}

impl Default for SegmentUploadManifest {
    fn default() -> Self {
        Self {
            version: 2,
            video_init_uploaded: false,
            audio_init_uploaded: false,
            video_segments: Vec::new(),
            audio_segments: Vec::new(),
            is_complete: false,
        }
    }
}

impl SegmentUploadManifest {
    fn record(&mut self, event: &SegmentCompletedEvent) {
        match (event.is_init, event.media_type) {
            (true, SegmentMediaType::Video) => self.video_init_uploaded = true,
            (true, SegmentMediaType::Audio) => self.audio_init_uploaded = true,
            (false, media_type) => {
                let segments = match media_type {
                    SegmentMediaType::Video => &mut self.video_segments,
                    SegmentMediaType::Audio => &mut self.audio_segments,
                };
                if let Some(segment) = segments
                    .iter_mut()
                    .find(|segment| segment.index == event.index)
                {
                    segment.duration = event.duration;
                } else {
                    segments.push(SegmentManifestEntry {
                        index: event.index,
                        duration: event.duration,
                    });
                    segments.sort_unstable_by_key(|segment| segment.index);
                }
            }
        }
    }

    fn has_video_content(&self) -> bool {
        self.video_init_uploaded && !self.video_segments.is_empty()
    }
}

pub async fn prepare_instant_upload(
    camera_only: bool,
    project_name: String,
    organization_id: Option<String>,
) -> Result<VideoUploadInfo, String> {
    if store_auth_missing() {
        return Err("Please sign in to use instant recording".to_string());
    }

    let recording_mode = if camera_only {
        "desktopMP4"
    } else {
        "desktopSegments"
    };
    let config = create_or_get_video_with_mode(
        false,
        None,
        Some(project_name),
        None,
        organization_id,
        recording_mode,
    )
    .await
    .map_err(|error| match error {
        AuthApiError::InvalidAuthentication => {
            "Your session has expired. Please sign in again to use instant recording.".to_string()
        }
        AuthApiError::UpgradeRequired => "Instant recording requires an upgraded plan.".to_string(),
        error => format!("Could not create the shareable link: {error}"),
    })?;

    Ok(VideoUploadInfo {
        id: config.id.clone(),
        link: format!("{}/s/{}", auth::server_url(), config.id),
        config,
    })
}

pub(crate) fn start_instant_upload(
    video: VideoUploadInfo,
    project_path: PathBuf,
    segment_rx: Option<std::sync::mpsc::Receiver<SegmentCompletedEvent>>,
    metadata_lock: Arc<Mutex<()>>,
    authorization: Option<CompletionAuthorization>,
) -> Result<InstantUpload, String> {
    let (completion_permit, required, completion_control) = match authorization {
        Some(authorization) => (
            Some(authorization.permit),
            Some(authorization.required),
            Some(authorization.control),
        ),
        None => (None, None, None),
    };
    let cancel = completion_control.as_ref().map_or_else(
        || Arc::new(AtomicBool::new(false)),
        |control| control.cancel.clone(),
    );
    let segment_upload = if let Some(segment_rx) = segment_rx {
        let (events_tx, events_rx) = flume::unbounded();
        std::thread::Builder::new()
            .name("gpui-instant-segments".to_string())
            .spawn(move || {
                while let Ok(event) = segment_rx.recv() {
                    if events_tx.send(event).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Failed to start instant upload: {error}"))?;

        let upload_video = video.clone();
        let upload_cancel = cancel.clone();
        let upload_metadata_lock = metadata_lock.clone();
        Some(tokio::spawn(async move {
            run_segment_upload(
                upload_video,
                project_path,
                events_rx,
                upload_cancel,
                upload_metadata_lock,
                required,
            )
            .await
        }))
    } else {
        None
    };

    Ok(InstantUpload {
        video,
        segment_upload,
        cancel,
        metadata_lock,
        completion_permit,
        completion_control,
    })
}

impl InstantUpload {
    pub fn video(&self) -> &VideoUploadInfo {
        &self.video
    }

    pub fn is_segmented(&self) -> bool {
        self.segment_upload.is_some()
    }

    pub(crate) fn metadata_lock(&self) -> &Mutex<()> {
        &self.metadata_lock
    }

    #[cfg(any(test, target_os = "linux"))]
    pub(crate) fn cancellation_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn completion_control(&self) -> Option<CompletionControl> {
        self.completion_control.clone()
    }

    pub(crate) fn authorize_completion(&mut self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("Cancelled Instant recording cannot complete".into());
        }
        if let Some(permit) = self.completion_permit.take() {
            permit
                .send(())
                .map_err(|_| "Instant completion authorization was lost".to_string())?;
        }
        Ok(())
    }

    pub async fn finish_segments(&mut self) -> Result<(), String> {
        check_segment_cancelled(&self.cancel)?;
        let Some(upload) = self.segment_upload.as_mut() else {
            return Ok(());
        };
        let result = upload
            .await
            .map_err(|error| format!("Instant segment upload task failed: {error}"));
        drop(self.segment_upload.take());
        check_segment_cancelled(&self.cancel)?;
        result?
    }

    pub async fn finish_screenshot(&self, project_path: &Path) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        let result = upload_screenshot_with_cancel(
            &self.video.id,
            &project_path.join("screenshots/display.jpg"),
            &self.cancel,
        )
        .await;
        #[cfg(not(target_os = "linux"))]
        let result = upload_screenshot(
            &self.video.id,
            &project_path.join("screenshots/display.jpg"),
        )
        .await;
        result.map_err(|error| format!("Instant recording thumbnail upload failed: {error}"))
    }

    pub async fn cancel(mut self) -> Result<(), String> {
        self.abort_segments().await;
        delete_instant_video(&self.video.id).await
    }

    pub(crate) async fn abort_segments(&mut self) {
        if let Some(control) = &self.completion_control {
            control.deny();
        }
        drop(self.completion_permit.take());
        self.cancel.store(true, Ordering::Release);
        if let Some(upload) = self.segment_upload.take() {
            upload.abort();
            let _ = upload.await;
        }
    }
}

pub async fn delete_instant_video(video_id: &str) -> Result<(), String> {
    let path = format!(
        "/api/desktop/video/delete?videoId={}",
        urlencoding(video_id)
    );
    let response = auth::authed_request(reqwest::Method::DELETE, &path, None)
        .await
        .map_err(|error| format!("Failed to delete instant recording: {error}"))?;
    let status = response.status();
    if status.is_success() || status == StatusCode::NOT_FOUND {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "Failed to delete instant recording {video_id}: {status}: {body}"
    ))
}

async fn run_segment_upload(
    video: VideoUploadInfo,
    project_path: PathBuf,
    events: flume::Receiver<SegmentCompletedEvent>,
    cancel: Arc<AtomicBool>,
    metadata_lock: Arc<Mutex<()>>,
    authorization: Option<CompletionRequirement>,
) -> Result<(), String> {
    let result = upload_segments(
        &LiveSegmentTransport,
        &video.id,
        events,
        cancel.clone(),
        authorization,
    )
    .await;
    if let Err(error) = &result
        && !cancel.load(Ordering::Acquire)
        && let Err(save_error) =
            crate::recording::persist_instant_upload_failure(&project_path, error, &metadata_lock)
    {
        tracing::error!("Failed to persist instant upload failure: {save_error}");
    }
    result
}

trait SegmentTransport: Send + Sync {
    fn prefetch(
        &self,
        video_id: &str,
        start: u32,
        count: u32,
    ) -> impl Future<Output = Result<HashMap<String, String>, String>> + Send;
    fn segment(
        &self,
        video_id: String,
        event: SegmentCompletedEvent,
        signed_urls: Arc<Mutex<HashMap<String, String>>>,
        cancel: Arc<AtomicBool>,
    ) -> impl Future<Output = Result<SegmentCompletedEvent, String>> + Send;
    fn manifest(
        &self,
        video_id: &str,
        manifest: &SegmentUploadManifest,
        cancel: &Arc<AtomicBool>,
    ) -> impl Future<Output = Result<(), String>> + Send;
    fn complete(
        &self,
        video_id: &str,
        cancel: &Arc<AtomicBool>,
    ) -> impl Future<Output = Result<(), String>> + Send;
}

struct LiveSegmentTransport;
impl SegmentTransport for LiveSegmentTransport {
    async fn prefetch(
        &self,
        video_id: &str,
        start: u32,
        count: u32,
    ) -> Result<HashMap<String, String>, String> {
        prefetch_segment_urls(video_id, start, count)
            .await
            .map_err(|error| error.to_string())
    }
    async fn segment(
        &self,
        video_id: String,
        event: SegmentCompletedEvent,
        signed_urls: Arc<Mutex<HashMap<String, String>>>,
        cancel: Arc<AtomicBool>,
    ) -> Result<SegmentCompletedEvent, String> {
        upload_segment_with_retry(video_id, event, signed_urls, cancel).await
    }
    async fn manifest(
        &self,
        video_id: &str,
        manifest: &SegmentUploadManifest,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        upload_segment_manifest_with_retry(video_id, manifest, cancel).await
    }
    async fn complete(&self, video_id: &str, cancel: &Arc<AtomicBool>) -> Result<(), String> {
        signal_recording_complete_with_retry(video_id, cancel).await
    }
}

async fn upload_segments(
    transport: &impl SegmentTransport,
    video_id: &str,
    events: flume::Receiver<SegmentCompletedEvent>,
    cancel: Arc<AtomicBool>,
    mut authorization: Option<CompletionRequirement>,
) -> Result<(), String> {
    let mut authorized = authorization.is_none();
    let mut manifest = SegmentUploadManifest::default();
    let mut uploads = FuturesUnordered::new();
    let mut events_closed = false;
    let mut last_manifest_upload: Option<Instant> = None;
    let mut next_prefetch = SEGMENT_URL_PREFETCH + 1;
    let prefetched = checked_segment_step(&cancel, || async {
        Ok(transport.prefetch(video_id, 1, SEGMENT_URL_PREFETCH).await)
    })
    .await?;
    let signed_urls = Arc::new(Mutex::new(prefetched.unwrap_or_else(|error| {
        tracing::warn!("Failed to prefetch instant upload URLs: {error}");
        HashMap::new()
    })));

    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Instant recording upload cancelled".into());
        }
        if events_closed && uploads.is_empty() && authorized {
            break;
        }
        let guarded = authorization.is_some();
        let (permission, denial) = match authorization.as_mut() {
            Some(required) => (Some(&mut required.permission), Some(&mut required.denied)),
            None => (None, None),
        };
        tokio::select! {
            permission = async { permission.unwrap().await }, if !authorized => {
                permission.map_err(|_| "Instant completion was not authorized".to_string())?;
                authorized = true;
            }
            _ = async {
                let denial = denial.unwrap();
                let denied = *denial.borrow_and_update();
                if !denied { let _ = denial.changed().await; }
            }, if guarded => {
                return Err("Instant completion authorization was revoked".into());
            }
            next_event = events.recv_async(), if !events_closed && uploads.len() < MAX_SEGMENT_UPLOADS => {
                match next_event {
                    Ok(event) => {
                        if cancel.load(Ordering::Acquire) {
                            return Err("Instant recording upload cancelled".to_string());
                        }
                        if event.media_type == SegmentMediaType::Video
                            && event.index.saturating_add(5) >= next_prefetch
                        {
                            match checked_segment_step(&cancel, || async {
                                Ok(transport.prefetch(video_id, next_prefetch, SEGMENT_URL_PREFETCH).await)
                            }).await? {
                                Ok(urls) => {
                                    signed_urls.lock().unwrap_or_else(|error| error.into_inner()).extend(urls);
                                    next_prefetch = next_prefetch.saturating_add(SEGMENT_URL_PREFETCH);
                                }
                                Err(error) => tracing::warn!("Failed to extend instant upload URLs: {error}"),
                            }
                        }
                        uploads.push(transport.segment(
                            video_id.to_string(),
                            event,
                            signed_urls.clone(),
                            cancel.clone(),
                        ));
                    }
                    Err(_) => events_closed = true,
                }
            }
            Some(upload) = uploads.next(), if !uploads.is_empty() => {
                check_segment_cancelled(&cancel)?;
                let event = upload?;
                manifest.record(&event);
                if manifest.has_video_content()
                    && last_manifest_upload.is_none_or(|last| last.elapsed() >= MANIFEST_UPLOAD_INTERVAL)
                {
                    checked_segment_step(&cancel, || transport.manifest(video_id, &manifest, &cancel)).await?;
                    last_manifest_upload = Some(Instant::now());
                }
            }
            else => break,
        }
    }

    if cancel.load(Ordering::Acquire) {
        return Err("Instant recording upload cancelled".to_string());
    }
    if !manifest.has_video_content() {
        return Err(format!(
            "Segment upload completed without video segments for {video_id}"
        ));
    }

    manifest.is_complete = true;
    checked_segment_step(&cancel, || transport.manifest(video_id, &manifest, &cancel)).await?;
    checked_segment_step(&cancel, || transport.complete(video_id, &cancel)).await
}

fn check_segment_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("Instant recording upload cancelled".into())
    } else {
        Ok(())
    }
}

async fn checked_segment_step<T, F>(
    cancel: &AtomicBool,
    step: impl FnOnce() -> F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    check_segment_cancelled(cancel)?;
    let result = step().await;
    check_segment_cancelled(cancel)?;
    result
}

async fn segment_retry_delay(cancel: &AtomicBool, delay: Duration) -> Result<(), String> {
    checked_segment_step(cancel, || async {
        tokio::time::sleep(delay).await;
        Ok(())
    })
    .await
}

fn prefetched_segment_paths(start: u32, count: u32) -> Vec<String> {
    let mut subpaths = Vec::with_capacity((count as usize).saturating_mul(2).saturating_add(3));
    if start == 1 {
        subpaths.push("segments/video/init.mp4".to_string());
        subpaths.push("segments/audio/init.mp4".to_string());
        subpaths.push("segments/manifest.json".to_string());
    }
    for index in start..start.saturating_add(count) {
        subpaths.push(format!("segments/video/segment_{index:03}.m4s"));
        subpaths.push(format!("segments/audio/segment_{index:03}.m4s"));
    }
    subpaths
}

async fn prefetch_segment_urls(
    video_id: &str,
    start: u32,
    count: u32,
) -> Result<HashMap<String, String>, AuthApiError> {
    #[derive(Deserialize)]
    struct BatchResponse {
        urls: HashMap<String, String>,
    }

    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/signed/batch",
        Some(json!({
            "videoId": video_id,
            "subpaths": prefetched_segment_paths(start, count),
        })),
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AuthApiError::Other(format!(
            "api/upload_signed_batch/{status}: {body}"
        )));
    }
    response
        .json::<BatchResponse>()
        .await
        .map(|batch| batch.urls)
        .map_err(|error| AuthApiError::Other(format!("api/upload_signed_batch/response: {error}")))
}

async fn upload_segment_with_retry(
    video_id: String,
    event: SegmentCompletedEvent,
    signed_urls: Arc<Mutex<HashMap<String, String>>>,
    cancel: Arc<AtomicBool>,
) -> Result<SegmentCompletedEvent, String> {
    let subpath = segment_subpath(&event);
    let bytes = read_completed_segment(&event, &subpath, &cancel).await?;
    let mut cached_url = signed_urls
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&subpath);

    for attempt in 0..SEGMENT_UPLOAD_ATTEMPTS {
        if cancel.load(Ordering::Acquire) {
            return Err("Instant recording upload cancelled".to_string());
        }
        if attempt > 0 {
            segment_retry_delay(&cancel, Duration::from_millis(250u64 << attempt)).await?;
        }

        let result = if let Some(url) = cached_url.take() {
            upload_signed_bytes_inner(
                SignedUploadTarget {
                    url,
                    headers: HashMap::new(),
                },
                &subpath,
                bytes.clone(),
                Some(&cancel),
            )
            .await
        } else {
            presigned_put_bytes_inner(&video_id, &subpath, bytes.clone(), Some(&cancel)).await
        };

        check_segment_cancelled(&cancel)?;

        match result {
            Ok(()) => return Ok(event),
            Err(AuthApiError::InvalidAuthentication) => {
                return Err("Authentication expired while uploading the instant recording".into());
            }
            Err(error) if attempt + 1 == SEGMENT_UPLOAD_ATTEMPTS => {
                return Err(format!(
                    "Failed to upload instant segment {subpath}: {error}"
                ));
            }
            Err(error) => tracing::warn!(
                subpath,
                attempt = attempt + 1,
                "Instant recording segment upload failed; retrying: {error}"
            ),
        }
    }

    Err(format!("Failed to upload instant segment {subpath}"))
}

async fn read_completed_segment(
    event: &SegmentCompletedEvent,
    subpath: &str,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Instant recording upload cancelled".to_string());
        }
        let bytes = tokio::task::spawn_blocking({
            let path = event.path.clone();
            move || std::fs::read(path)
        })
        .await
        .map_err(|error| format!("Failed to read instant segment {subpath}: {error}"))?;

        match bytes {
            Ok(bytes)
                if !bytes.is_empty()
                    && (event.file_size == 0 || bytes.len() >= event.file_size as usize) =>
            {
                return Ok(bytes);
            }
            Ok(_) if started.elapsed() >= Duration::from_secs(10) => {
                return Err(format!(
                    "Instant recording segment is incomplete: {subpath}"
                ));
            }
            Err(error) if started.elapsed() >= Duration::from_secs(10) => {
                return Err(format!("Failed to read instant segment {subpath}: {error}"));
            }
            _ => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

fn segment_subpath(event: &SegmentCompletedEvent) -> String {
    match (event.is_init, event.media_type) {
        (true, SegmentMediaType::Video) => "segments/video/init.mp4".to_string(),
        (true, SegmentMediaType::Audio) => "segments/audio/init.mp4".to_string(),
        (false, SegmentMediaType::Video) => {
            format!("segments/video/segment_{:03}.m4s", event.index)
        }
        (false, SegmentMediaType::Audio) => {
            format!("segments/audio/segment_{:03}.m4s", event.index)
        }
    }
}

async fn upload_segment_manifest(
    video_id: &str,
    manifest: &SegmentUploadManifest,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(manifest)
        .map_err(|error| format!("Failed to serialize instant upload manifest: {error}"))?;
    presigned_put_bytes_inner(video_id, "segments/manifest.json", bytes, Some(cancel))
        .await
        .map_err(|error| format!("Failed to upload instant recording manifest: {error}"))
}

async fn upload_segment_manifest_with_retry(
    video_id: &str,
    manifest: &SegmentUploadManifest,
    cancel: &AtomicBool,
) -> Result<(), String> {
    for attempt in 0..SEGMENT_UPLOAD_ATTEMPTS {
        if cancel.load(Ordering::Acquire) {
            return Err("Instant recording upload cancelled".to_string());
        }
        match checked_segment_step(cancel, || {
            upload_segment_manifest(video_id, manifest, cancel)
        })
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) if attempt + 1 == SEGMENT_UPLOAD_ATTEMPTS => return Err(error),
            Err(error) => {
                tracing::warn!(
                    attempt = attempt + 1,
                    "Instant manifest upload failed: {error}"
                );
                segment_retry_delay(cancel, Duration::from_millis(250u64 << attempt)).await?;
            }
        }
    }
    Err("Instant recording manifest upload failed".to_string())
}

async fn signal_recording_complete_with_retry(
    video_id: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    for attempt in 0..SEGMENT_UPLOAD_ATTEMPTS {
        if cancel.load(Ordering::Acquire) {
            return Err("Instant recording upload cancelled".to_string());
        }
        match checked_segment_step(cancel, || signal_recording_complete(video_id)).await {
            Ok(()) => return Ok(()),
            Err(error) if attempt + 1 == SEGMENT_UPLOAD_ATTEMPTS => return Err(error),
            Err(error) => {
                tracing::warn!(
                    attempt = attempt + 1,
                    "Instant completion signal failed: {error}"
                );
                segment_retry_delay(cancel, Duration::from_millis(250u64 << attempt)).await?;
            }
        }
    }
    Err("Failed to finish instant recording upload".to_string())
}

async fn signal_recording_complete(video_id: &str) -> Result<(), String> {
    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/recording-complete",
        Some(json!({ "videoId": video_id })),
    )
    .await
    .map_err(|error| format!("Failed to finish instant recording upload: {error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "Failed to finish instant recording upload: {status}: {body}"
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadedPart {
    part_number: u32,
    etag: String,
    size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoMeta {
    #[serde(rename = "durationInSecs")]
    duration_in_secs: f64,
    width: u32,
    height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    fps: Option<f32>,
}

fn check_export_cancelled(cancel: &AtomicBool) -> Result<(), AuthApiError> {
    if cancel.load(Ordering::Acquire) {
        Err(AuthApiError::Other("Export cancelled".into()))
    } else {
        Ok(())
    }
}

async fn checked_upload_step<T, F>(
    cancel: &AtomicBool,
    step: impl FnOnce() -> F,
) -> Result<T, AuthApiError>
where
    F: Future<Output = Result<T, AuthApiError>>,
{
    check_export_cancelled(cancel)?;
    let result = step().await;
    check_export_cancelled(cancel)?;
    result
}

pub async fn upload_exported_video(
    project_path: PathBuf,
    organization_id: Option<String>,
    progress: impl Fn(f64),
    cancel: std::sync::Arc<AtomicBool>,
) -> Result<UploadResult, String> {
    check_export_cancelled(&cancel).map_err(|error| error.to_string())?;
    if store_auth_missing() {
        let _ = crate::store::set_auth(None);
        return Ok(UploadResult::NotAuthenticated);
    }

    let mut meta = RecordingMeta::load_for_project(&project_path)
        .map_err(|error| format!("Failed to load recording metadata: {error}"))?;
    let file_path = meta.output_path();
    if !file_path.exists() {
        return Err("Failed to upload video: Rendered video not found".into());
    }

    let metadata = build_video_meta(&file_path)?;
    if !crate::store::auth_snapshot().is_upgraded() && metadata.duration_in_secs > 300.0 {
        return Ok(UploadResult::UpgradeRequired);
    }

    progress(0.0);
    if cancel.load(Ordering::Relaxed) {
        return Err("Export cancelled".into());
    }

    // The recording-time thumbnail is best-effort, so regenerate a missing
    // `screenshots/display.jpg` from the exported video rather than shipping a
    // share with no thumbnail or failing a video that could still be shared.
    let screenshot_path = meta.project_path.join("screenshots/display.jpg");
    if !screenshot_path.exists()
        && let Err(error) = crate::library::create_screenshot(&file_path, &screenshot_path, None)
    {
        return Err(format!("Failed to generate thumbnail: {error}"));
    }

    let video_id = match reusable_video_id(meta.sharing.as_ref(), meta.upload.as_ref()) {
        Some(video_id) => video_id,
        None => {
            let video_id = match checked_upload_step(&cancel, request_video_id).await {
                Ok(video_id) => video_id,
                Err(AuthApiError::InvalidAuthentication) => {
                    return Ok(UploadResult::NotAuthenticated);
                }
                Err(AuthApiError::UpgradeRequired) => return Ok(UploadResult::UpgradeRequired),
                Err(error) => return Err(error.to_string()),
            };
            meta.upload = Some(UploadMeta::SinglePartUpload {
                video_id: video_id.clone(),
                file_path: file_path.clone(),
                screenshot_path: screenshot_path.clone(),
                recording_dir: project_path.clone(),
            });
            meta.save_for_project()
                .map_err(|error| format!("Failed to persist upload identity: {error}"))?;
            video_id
        }
    };

    let s3_config = match checked_upload_step(&cancel, || {
        create_or_get_video(
            false,
            Some(video_id.clone()),
            Some(meta.pretty_name.clone()),
            Some(&metadata),
            organization_id,
        )
    })
    .await
    {
        Ok(config) => config,
        Err(AuthApiError::InvalidAuthentication) => return Ok(UploadResult::NotAuthenticated),
        Err(AuthApiError::UpgradeRequired) => return Ok(UploadResult::UpgradeRequired),
        Err(error) => return Err(error.to_string()),
    };
    if s3_config.id != video_id {
        return Err("Server did not preserve the reserved upload identity".into());
    }

    meta.upload = Some(UploadMeta::SinglePartUpload {
        video_id: s3_config.id.clone(),
        file_path: file_path.clone(),
        screenshot_path: screenshot_path.clone(),
        recording_dir: project_path.clone(),
    });
    meta.save_for_project()
        .map_err(|error| format!("Failed to persist upload state: {error}"))?;

    match checked_upload_step(&cancel, || {
        upload_video(&s3_config.id, &file_path, &metadata, progress, &cancel)
    })
    .await
    {
        Ok(link) => {
            meta.sharing = Some(SharingMeta {
                link: link.clone(),
                id: s3_config.id.clone(),
                content_hash: None,
            });
            meta.save_for_project()
                .map_err(|error| format!("Failed to persist sharing state: {error}"))?;

            if let Err(error) = checked_upload_step(&cancel, || {
                upload_screenshot_with_cancel(&s3_config.id, &screenshot_path, &cancel)
            })
            .await
            {
                return Err(format!("thumbnail upload failed: {error}"));
            }

            check_export_cancelled(&cancel).map_err(|error| error.to_string())?;
            meta.upload = Some(UploadMeta::Complete);
            meta.save_for_project()
                .map_err(|error| format!("Failed to persist completed upload: {error}"))?;
            check_export_cancelled(&cancel).map_err(|error| error.to_string())?;
            Ok(UploadResult::Success(link))
        }
        Err(AuthApiError::UpgradeRequired) => Ok(UploadResult::UpgradeRequired),
        Err(AuthApiError::InvalidAuthentication) => Ok(UploadResult::NotAuthenticated),
        Err(error) => Err(error.to_string()),
    }
}

fn reusable_video_id(sharing: Option<&SharingMeta>, upload: Option<&UploadMeta>) -> Option<String> {
    sharing
        .map(|sharing| sharing.id.clone())
        .or_else(|| match upload {
            Some(UploadMeta::SinglePartUpload { video_id, .. }) => Some(video_id.clone()),
            _ => None,
        })
}

fn store_auth_missing() -> bool {
    !crate::store::auth_snapshot().signed_in()
}

async fn request_video_id() -> Result<String, AuthApiError> {
    let response =
        auth::authed_request(reqwest::Method::GET, "/api/desktop/video/new-id", None).await?;
    if response.status() != StatusCode::OK {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AuthApiError::Other(format!(
            "request_video_id/error/{status}: {body:?}"
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|error| AuthApiError::Other(format!("Failed to read response body: {error}")))?;
    let config = serde_json::from_str::<S3UploadMeta>(&text).map_err(|error| {
        AuthApiError::Other(format!(
            "Failed to deserialize reserved video ID: {error}. Response body: {text}"
        ))
    })?;
    Ok(config.id)
}

/// `create_or_get_video` (`src-tauri/upload.rs:340-436`): passing an existing
/// `video_id` re-uses that server record (which is what keeps a share link
/// stable across re-uploads), and `is_screenshot` marks the record the way the
/// screenshot share flow needs (`isScreenshot=true` on the create URL).
async fn create_or_get_video(
    is_screenshot: bool,
    video_id: Option<String>,
    name: Option<String>,
    meta: Option<&VideoMeta>,
    organization_id: Option<String>,
) -> Result<S3UploadMeta, AuthApiError> {
    create_or_get_video_with_mode(
        is_screenshot,
        video_id,
        name,
        meta,
        organization_id,
        "desktopMP4",
    )
    .await
}

async fn create_or_get_video_with_mode(
    is_screenshot: bool,
    video_id: Option<String>,
    name: Option<String>,
    meta: Option<&VideoMeta>,
    organization_id: Option<String>,
    recording_mode: &str,
) -> Result<S3UploadMeta, AuthApiError> {
    let mut path = format!(
        "/api/desktop/video/create?recordingMode={}",
        urlencoding(recording_mode)
    );
    if let Some(id) = video_id {
        path.push_str(&format!("&videoId={id}"));
        path.push_str("&createWithId=true");
    }
    if is_screenshot {
        path.push_str("&isScreenshot=true");
    }
    if let Some(name) = name {
        path.push_str(&format!("&name={}", urlencoding(&name)));
    }
    if let Some(meta) = meta {
        path.push_str(&format!("&durationInSecs={}", meta.duration_in_secs));
        path.push_str(&format!("&width={}", meta.width));
        path.push_str(&format!("&height={}", meta.height));
        if let Some(fps) = meta.fps {
            path.push_str(&format!("&fps={fps}"));
        }
    }
    if let Some(org_id) = organization_id {
        path.push_str(&format!("&orgId={org_id}"));
    }

    let response = auth::authed_request(reqwest::Method::GET, &path, None).await?;
    if response.status() != StatusCode::OK {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == StatusCode::FORBIDDEN && body.contains("upgrade_required") {
            return Err(AuthApiError::UpgradeRequired);
        }
        return Err(AuthApiError::Other(format!(
            "create_or_get_video/error/{status}: {body:?}"
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|error| AuthApiError::Other(format!("Failed to read response body: {error}")))?;
    serde_json::from_str::<S3UploadMeta>(&text).map_err(|error| {
        AuthApiError::Other(format!(
            "Failed to deserialize response: {error}. Response body: {text}"
        ))
    })
}

async fn upload_video(
    video_id: &str,
    file_path: &Path,
    metadata: &VideoMeta,
    progress: impl Fn(f64),
    cancel: &AtomicBool,
) -> Result<String, AuthApiError> {
    let initiate = checked_upload_step(cancel, || multipart_initiate(video_id)).await?;
    let is_drive = is_google_drive_upload(initiate.provider.as_deref(), &initiate.upload_id);
    let parts = upload_parts(
        video_id,
        &initiate.upload_id,
        file_path,
        is_drive,
        &progress,
        cancel,
    )
    .await?;
    if cancel.load(Ordering::Relaxed) {
        return Err(AuthApiError::Other("Export cancelled".into()));
    }
    checked_upload_step(cancel, || {
        multipart_complete(video_id, &initiate.upload_id, &parts, Some(metadata))
    })
    .await?;
    progress(1.0);

    Ok(format!("{}/s/{video_id}", auth::server_url()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitiateResponse {
    upload_id: String,
    provider: Option<String>,
}

async fn multipart_initiate(video_id: &str) -> Result<InitiateResponse, AuthApiError> {
    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/multipart/initiate",
        Some(json!({
            "videoId": video_id,
            "contentType": "video/mp4"
        })),
    )
    .await
    .map_err(|error| {
        AuthApiError::Other(format!("api/upload_multipart_initiate/request: {error}"))
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".into());
        return Err(AuthApiError::Other(format!(
            "api/upload_multipart_initiate/{status}: {body}"
        )));
    }
    response.json().await.map_err(|error| {
        AuthApiError::Other(format!("api/upload_multipart_initiate/response: {error}"))
    })
}

async fn multipart_presign(
    video_id: &str,
    upload_id: &str,
    part_number: u32,
    md5_sum: Option<&str>,
) -> Result<String, AuthApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        presigned_url: String,
    }

    let mut body = serde_json::Map::from_iter([
        ("videoId".into(), json!(video_id)),
        ("uploadId".into(), json!(upload_id)),
        ("partNumber".into(), json!(part_number)),
    ]);
    if let Some(md5_sum) = md5_sum {
        body.insert("md5Sum".into(), json!(md5_sum));
    }

    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/multipart/presign-part",
        Some(Value::Object(body)),
    )
    .await
    .map_err(|error| {
        AuthApiError::Other(format!(
            "api/upload_multipart_presign_part/request: {error}"
        ))
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".into());
        return Err(AuthApiError::Other(format!(
            "api/upload_multipart_presign_part/{status}: {body}"
        )));
    }
    response
        .json::<Response>()
        .await
        .map(|data| data.presigned_url)
        .map_err(|error| {
            AuthApiError::Other(format!(
                "api/upload_multipart_presign_part/response: {error}"
            ))
        })
}

async fn multipart_complete(
    video_id: &str,
    upload_id: &str,
    parts: &[UploadedPart],
    meta: Option<&VideoMeta>,
) -> Result<(), AuthApiError> {
    let mut body = json!({
        "videoId": video_id,
        "uploadId": upload_id,
        "parts": parts,
    });
    if let Some(meta) = meta
        && let Value::Object(object) = &mut body
        && let Ok(Value::Object(extra)) = serde_json::to_value(meta)
    {
        object.extend(extra);
    }

    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/multipart/complete",
        Some(body),
    )
    .await
    .map_err(|error| {
        AuthApiError::Other(format!("api/upload_multipart_complete/request: {error}"))
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".into());
        return Err(AuthApiError::Other(format!(
            "api/upload_multipart_complete/{status}: {body}"
        )));
    }
    Ok(())
}

async fn upload_parts(
    video_id: &str,
    upload_id: &str,
    file_path: &Path,
    is_drive: bool,
    progress: &impl Fn(f64),
    cancel: &AtomicBool,
) -> Result<Vec<UploadedPart>, AuthApiError> {
    let file_size = std::fs::metadata(file_path)
        .map_err(|error| AuthApiError::Other(format!("Failed to read export size: {error}")))?
        .len();
    if file_size == 0 {
        return Err(AuthApiError::Other("Rendered video is empty".into()));
    }
    let chunk_size = chunk_size_for(file_size);
    let mut parts = Vec::new();
    let mut failed = Vec::new();
    let mut offset = 0u64;
    let mut part_number = 1u32;
    let use_md5 = auth::is_server_url_custom();

    while offset < file_size {
        if cancel.load(Ordering::Relaxed) {
            return Err(AuthApiError::Other("Export cancelled".into()));
        }
        let size = (file_size - offset).min(chunk_size) as usize;
        let chunk = read_chunk(file_path, offset, size)?;
        match put_part(
            video_id,
            upload_id,
            part_number,
            offset,
            file_size,
            &chunk,
            is_drive,
            use_md5,
            cancel,
        )
        .await
        {
            Ok(part) => parts.push(part),
            Err(error) => {
                check_export_cancelled(cancel)?;
                tracing::warn!(part_number, error = %error, "chunk upload failed; will retry");
                failed.push((part_number, offset, chunk, error));
            }
        }
        offset += size as u64;
        part_number += 1;
        progress((offset as f64 / file_size as f64).min(0.99));
    }

    for (part_number, offset, chunk, first_error) in failed {
        if cancel.load(Ordering::Relaxed) {
            return Err(AuthApiError::Other("Export cancelled".into()));
        }
        match put_part(
            video_id,
            upload_id,
            part_number,
            offset,
            file_size,
            &chunk,
            is_drive,
            use_md5,
            cancel,
        )
        .await
        {
            Ok(part) => parts.push(part),
            Err(_) => {
                check_export_cancelled(cancel)?;
                return Err(first_error);
            }
        }
    }

    parts.sort_by_key(|part| part.part_number);
    let mut deduped = HashMap::new();
    for part in parts {
        deduped.insert(part.part_number, part);
    }
    let mut parts = deduped.into_values().collect::<Vec<_>>();
    parts.sort_by_key(|part| part.part_number);
    Ok(parts)
}

#[allow(clippy::too_many_arguments)]
async fn put_part(
    video_id: &str,
    upload_id: &str,
    part_number: u32,
    offset: u64,
    total_size: u64,
    chunk: &[u8],
    is_drive: bool,
    use_md5: bool,
    cancel: &AtomicBool,
) -> Result<UploadedPart, AuthApiError> {
    let md5_sum = use_md5.then(|| md5_base64(chunk));
    let url = checked_upload_step(cancel, || {
        multipart_presign(video_id, upload_id, part_number, md5_sum.as_deref())
    })
    .await?;
    let client = reqwest::Client::new();
    let mut attempt = 0u32;
    loop {
        let mut request = client
            .put(&url)
            .header("Content-Length", chunk.len())
            .timeout(Duration::from_secs(5 * 60))
            .body(chunk.to_vec());
        if is_drive || is_google_drive_resumable_url(&url) {
            let end = offset.saturating_add(chunk.len() as u64).saturating_sub(1);
            request = request.header(
                "Content-Range",
                format!("bytes {offset}-{end}/{total_size}"),
            );
        }
        if let Some(md5_sum) = &md5_sum {
            request = request.header("Content-MD5", md5_sum);
        }
        let response = checked_upload_step(cancel, || async { Ok(request.send().await) }).await?;
        match response {
            Ok(response) => {
                if !upload_status_ok(
                    &url,
                    response.status(),
                    offset,
                    chunk.len() as u64,
                    total_size,
                ) {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    return Err(AuthApiError::Other(format!(
                        "uploader/part/{part_number}/status/{status}: {body}"
                    )));
                }
                let etag = response
                    .headers()
                    .get("ETag")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .trim_matches('"')
                    .to_string();
                return Ok(UploadedPart {
                    part_number,
                    etag,
                    size: chunk.len(),
                });
            }
            Err(error) if is_network_error(&error) && attempt < 4 => {
                attempt += 1;
                let delay = Duration::from_secs(2u64.saturating_pow(attempt).min(30));
                tracing::info!(
                    part_number,
                    attempt,
                    "network error uploading chunk; retrying in {delay:?}: {error}"
                );
                checked_upload_step(cancel, || async {
                    tokio::time::sleep(delay).await;
                    Ok(())
                })
                .await?;
            }
            Err(error) => {
                return Err(AuthApiError::Other(format!(
                    "uploader/part/{part_number}/error: {error}"
                )));
            }
        }
    }
}

async fn upload_screenshot_with_cancel(
    video_id: &str,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<(), AuthApiError> {
    check_export_cancelled(cancel)?;
    let bytes = compress_image(path)?;
    presigned_put_bytes_inner(
        video_id,
        "screenshot/screen-capture.jpg",
        bytes,
        Some(cancel),
    )
    .await
}

#[cfg(not(target_os = "linux"))]
async fn upload_screenshot(video_id: &str, path: &Path) -> Result<(), AuthApiError> {
    let bytes = compress_image(path)?;
    presigned_put_bytes(video_id, "screenshot/screen-capture.jpg", bytes).await
}

/// One presigned single-part PUT under a video's subpath -- `/api/upload/
/// signed` for the URL, then the raw body. The thumbnail upload and the
/// rendered-screenshot upload are both this shape (`singlepart_uploader` +
/// `PresignedS3PutRequest` in the Tauri binary).
async fn presigned_put_bytes(
    video_id: &str,
    subpath: &str,
    bytes: Vec<u8>,
) -> Result<(), AuthApiError> {
    presigned_put_bytes_inner(video_id, subpath, bytes, None).await
}

async fn optional_upload_step<T, F>(
    cancel: Option<&AtomicBool>,
    step: impl FnOnce() -> F,
) -> Result<T, AuthApiError>
where
    F: Future<Output = Result<T, AuthApiError>>,
{
    match cancel {
        Some(cancel) => checked_upload_step(cancel, step).await,
        None => step().await,
    }
}

async fn presigned_put_bytes_inner(
    video_id: &str,
    subpath: &str,
    bytes: Vec<u8>,
    cancel: Option<&AtomicBool>,
) -> Result<(), AuthApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        presigned_put_data: SignedUploadTarget,
    }

    let response = optional_upload_step(cancel, || {
        auth::authed_request(
            reqwest::Method::POST,
            "/api/upload/signed",
            Some(json!({
                "videoId": video_id,
                "subpath": subpath,
                "method": "put",
            })),
        )
    })
    .await?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(AuthApiError::Other(format!(
            "api/upload_signed/{status}: {body}"
        )));
    }
    let target = response
        .json::<Response>()
        .await
        .map_err(|error| AuthApiError::Other(format!("api/upload_signed/response: {error}")))?
        .presigned_put_data;
    upload_signed_bytes_inner(target, subpath, bytes, cancel).await
}

async fn upload_signed_bytes_inner(
    target: SignedUploadTarget,
    subpath: &str,
    bytes: Vec<u8>,
    cancel: Option<&AtomicBool>,
) -> Result<(), AuthApiError> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

    let length = bytes.len() as u64;
    let mut request = CLIENT
        .get_or_init(reqwest::Client::new)
        .put(&target.url)
        .header("Content-Length", length)
        .header("Content-Type", upload_content_type(subpath))
        .timeout(Duration::from_secs(5 * 60))
        .body(bytes);
    if is_google_drive_resumable_url(&target.url) && length > 0 {
        request = request.header(
            "Content-Range",
            format!("bytes 0-{}/{}", length.saturating_sub(1), length),
        );
    }
    for (name, value) in target.headers {
        request = request.header(name, value);
    }
    let response = optional_upload_step(cancel, || async {
        request.send().await.map_err(|error| {
            if error.is_timeout() {
                AuthApiError::Timeout
            } else {
                AuthApiError::Other(error.to_string())
            }
        })
    })
    .await?;
    if !response.status().is_success() {
        return Err(AuthApiError::Other(format!(
            "upload failed: {}",
            response.status()
        )));
    }
    Ok(())
}

fn upload_content_type(subpath: &str) -> &'static str {
    if subpath.ends_with(".json") {
        "application/json"
    } else if subpath.ends_with(".mp4") || subpath.ends_with(".m4s") {
        "video/mp4"
    } else if subpath.ends_with(".png") {
        "image/png"
    } else if subpath.ends_with(".jpg") || subpath.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "application/octet-stream"
    }
}

// ---------------------------------------------------------------------------
// Screenshot share upload
// ---------------------------------------------------------------------------

/// A created-or-reused server video record, with the share link derived from
/// its id -- `UploadedItem` in the Tauri binary.
pub struct UploadedItem {
    pub link: String,
    pub id: String,
}

/// What the screenshot share flow's upload step resolved to. The two
/// non-success arms carry the exact toasts `shareLinkFromUploadResult` maps
/// them to on the window side.
pub enum ScreenshotShareOutcome {
    Uploaded(UploadedItem),
    NotAuthenticated,
    UpgradeRequired,
}

/// `screenshot_upload_subpath` (`src-tauri/upload.rs:259-265`): the composited
/// image lands under the record's screenshot key, extension by content type.
fn screenshot_upload_subpath(content_type: &str) -> &'static str {
    if content_type.eq_ignore_ascii_case("image/png") {
        "screenshot/screen-capture.png"
    } else {
        "screenshot/screen-capture.jpg"
    }
}

/// `upload_rendered_screenshot` (`src-tauri/lib.rs:3761-3796`), minus the
/// clipboard/meta halves the window owns: gate on auth exactly as the Tauri
/// command does, create-or-get the screenshot video record (re-using the
/// sharing id when the caller has one, so the link survives re-uploads), and
/// presigned-PUT the encoded bytes to the screenshot subpath.
pub async fn upload_rendered_screenshot(
    image_bytes: Vec<u8>,
    content_type: &str,
    video_id: Option<String>,
) -> Result<ScreenshotShareOutcome, String> {
    let auth = crate::store::auth_snapshot();
    if !auth.signed_in() {
        // The Tauri command resets a corrupt/absent auth store on this path.
        let _ = crate::store::set_auth(None);
        return Ok(ScreenshotShareOutcome::NotAuthenticated);
    }
    if !auth.is_upgraded() {
        return Ok(ScreenshotShareOutcome::UpgradeRequired);
    }

    match upload_screenshot_bytes(image_bytes, content_type, video_id).await {
        Ok(item) => Ok(ScreenshotShareOutcome::Uploaded(item)),
        Err(AuthApiError::InvalidAuthentication) => Ok(ScreenshotShareOutcome::NotAuthenticated),
        Err(AuthApiError::UpgradeRequired) => Ok(ScreenshotShareOutcome::UpgradeRequired),
        Err(error) => Err(error.to_string()),
    }
}

/// `upload_screenshot_bytes` (`src-tauri/upload.rs:279-307`).
async fn upload_screenshot_bytes(
    image_bytes: Vec<u8>,
    content_type: &str,
    video_id: Option<String>,
) -> Result<UploadedItem, AuthApiError> {
    let s3_config = create_or_get_video(true, video_id, None, None, None).await?;
    let subpath = screenshot_upload_subpath(content_type);
    presigned_put_bytes(&s3_config.id, subpath, image_bytes).await?;
    Ok(UploadedItem {
        link: format!("{}/s/{}", auth::server_url(), s3_config.id),
        id: s3_config.id,
    })
}

fn compress_image(path: &Path) -> Result<Vec<u8>, AuthApiError> {
    let img = image::ImageReader::open(path)
        .map_err(|error| AuthApiError::Other(format!("Failed to open image: {error}")))?
        .decode()
        .map_err(|error| AuthApiError::Other(format!("Failed to decode image: {error}")))?;
    let resized = img.resize(
        img.width() / 2,
        img.height() / 2,
        image::imageops::FilterType::Nearest,
    );
    let mut buffer = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 30);
    encoder
        .encode(
            resized.as_bytes(),
            resized.width(),
            resized.height(),
            resized.color().into(),
        )
        .map_err(|error| AuthApiError::Other(format!("Failed to compress image: {error}")))?;
    Ok(buffer)
}

fn build_video_meta(path: &Path) -> Result<VideoMeta, String> {
    let input = ffmpeg::format::input(path)
        .map_err(|error| format!("Failed to read input file: {error}"))?;
    let video_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "Failed to find appropriate video stream in file".to_string())?;
    let video_codec =
        ffmpeg::codec::context::Context::from_parameters(video_stream.parameters())
            .map_err(|error| format!("Unable to read video codec information: {error}"))?;
    let video = video_codec
        .decoder()
        .video()
        .map_err(|error| format!("Unable to get video decoder: {error}"))?;
    Ok(VideoMeta {
        duration_in_secs: input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE),
        width: video.width(),
        height: video.height(),
        fps: video
            .frame_rate()
            .map(|rate| rate.numerator() as f32 / rate.denominator() as f32),
    })
}

fn read_chunk(path: &Path, offset: u64, size: usize) -> Result<Vec<u8>, AuthApiError> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| AuthApiError::Other(format!("Failed to open export: {error}")))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| AuthApiError::Other(format!("Failed to seek export: {error}")))?;
    let mut buffer = vec![0u8; size];
    file.read_exact(&mut buffer)
        .map_err(|error| AuthApiError::Other(format!("Failed to read export chunk: {error}")))?;
    Ok(buffer)
}

fn chunk_size_for(file_size: u64) -> u64 {
    (file_size / 100).clamp(MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
}

fn md5_base64(bytes: &[u8]) -> String {
    use md5::{Digest, Md5};
    let digest = Md5::digest(bytes);
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, digest)
}

fn is_google_drive_resumable_url(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    url.host_str().is_some_and(|host| {
        (host == "googleapis.com" || host.ends_with(".googleapis.com"))
            && url.path().starts_with("/upload/drive/")
    })
}

fn is_google_drive_upload(provider: Option<&str>, upload_id: &str) -> bool {
    provider == Some("googleDrive") || is_google_drive_resumable_url(upload_id)
}

fn upload_status_ok(
    url: &str,
    status: StatusCode,
    offset: u64,
    size: u64,
    total_size: u64,
) -> bool {
    status.is_success()
        || (is_google_drive_resumable_url(url)
            && status == StatusCode::PERMANENT_REDIRECT
            && offset.saturating_add(size) < total_size)
}

fn is_network_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

fn urlencoding(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abort_segments_waits_until_the_upload_task_has_stopped() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(async {
                let dropped = Arc::new(AtomicBool::new(false));
                let upload_dropped = dropped.clone();
                let (started_tx, started_rx) = tokio::sync::oneshot::channel();
                let task = tokio::spawn(async move {
                    let _dropped = Dropped(upload_dropped);
                    let _ = started_tx.send(());
                    std::future::pending::<()>().await;
                    Ok(())
                });
                started_rx.await.unwrap();
                let mut upload = InstantUpload {
                    video: VideoUploadInfo {
                        id: "test".into(),
                        link: "https://example.invalid/s/test".into(),
                        config: S3UploadMeta { id: "test".into() },
                    },
                    segment_upload: Some(task),
                    cancel: Arc::new(AtomicBool::new(false)),
                    metadata_lock: Arc::new(Mutex::new(())),
                    completion_permit: None,
                    completion_control: None,
                };

                {
                    let mut finish = Box::pin(upload.finish_segments());
                    assert!(
                        std::future::poll_fn(|context| std::task::Poll::Ready(
                            finish.as_mut().poll(context)
                        ))
                        .await
                        .is_pending()
                    );
                }
                assert!(upload.segment_upload.is_some());
                upload.abort_segments().await;

                assert!(dropped.load(Ordering::Acquire));
                assert!(upload.cancel.load(Ordering::Acquire));
            });
    }

    fn upload_with_task(
        task: tokio::task::JoinHandle<Result<(), String>>,
        control: Option<CompletionControl>,
    ) -> InstantUpload {
        InstantUpload {
            video: VideoUploadInfo {
                id: "owned-upload".into(),
                link: "https://example.invalid/s/owned-upload".into(),
                config: S3UploadMeta {
                    id: "owned-upload".into(),
                },
            },
            segment_upload: Some(task),
            cancel: control
                .as_ref()
                .map(|control| control.cancel.clone())
                .unwrap_or_else(|| Arc::new(AtomicBool::new(false))),
            metadata_lock: Arc::new(Mutex::new(())),
            completion_permit: None,
            completion_control: control,
        }
    }

    #[tokio::test]
    async fn denied_segment_finish_waits_until_the_owned_task_has_joined() {
        let authorization = CompletionAuthorization::new();
        let control = authorization.control.clone();
        let finished = Arc::new(AtomicBool::new(false));
        let task_finished = finished.clone();
        let (release, released) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            released.await.unwrap();
            task_finished.store(true, Ordering::Release);
            Ok(())
        });
        let mut upload = upload_with_task(task, Some(control.clone()));
        {
            let mut finish = Box::pin(upload.finish_segments());
            assert!(
                std::future::poll_fn(|context| std::task::Poll::Ready(
                    finish.as_mut().poll(context)
                ))
                .await
                .is_pending()
            );
            control.deny();
            assert!(
                std::future::poll_fn(|context| std::task::Poll::Ready(
                    finish.as_mut().poll(context)
                ))
                .await
                .is_pending()
            );
            assert!(!finished.load(Ordering::Acquire));
            release.send(()).unwrap();
            assert!(finish.await.unwrap_err().contains("cancelled"));
        }
        assert!(finished.load(Ordering::Acquire));
        assert!(upload.segment_upload.is_none());
        upload.abort_segments().await;
    }

    #[tokio::test]
    async fn segment_finish_preserves_results_and_removes_only_joined_handles() {
        for result in [Ok(()), Err("segment transfer failed".to_string())] {
            let expected = result.clone();
            let mut upload = upload_with_task(tokio::spawn(async move { result }), None);
            assert_eq!(upload.finish_segments().await, expected);
            assert!(upload.segment_upload.is_none());
            upload.abort_segments().await;
        }

        let task = tokio::spawn(std::future::pending::<Result<(), String>>());
        task.abort();
        let mut upload = upload_with_task(task, None);
        assert!(
            upload
                .finish_segments()
                .await
                .unwrap_err()
                .contains("Instant segment upload task failed")
        );
        assert!(upload.segment_upload.is_none());
        upload.abort_segments().await;

        let task: tokio::task::JoinHandle<Result<(), String>> =
            tokio::spawn(async { panic!("synthetic segment task panic") });
        let mut upload = upload_with_task(task, None);
        assert!(
            upload
                .finish_segments()
                .await
                .unwrap_err()
                .contains("Instant segment upload task failed")
        );
        assert!(upload.segment_upload.is_none());
        upload.abort_segments().await;

        let task = tokio::spawn(std::future::pending::<Result<(), String>>());
        let mut upload = upload_with_task(task, None);
        upload.cancel.store(true, Ordering::Release);
        assert!(
            upload
                .finish_segments()
                .await
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(upload.segment_upload.is_some());
        upload.abort_segments().await;
        assert!(upload.segment_upload.is_none());
    }

    fn segment_event(
        index: u32,
        duration: f64,
        is_init: bool,
        media_type: SegmentMediaType,
    ) -> SegmentCompletedEvent {
        SegmentCompletedEvent {
            path: PathBuf::from("segment.m4s"),
            index,
            duration,
            file_size: 16,
            is_init,
            media_type,
        }
    }

    #[test]
    fn segment_manifest_requires_init_and_orders_video_and_audio() {
        let mut manifest = SegmentUploadManifest::default();
        manifest.record(&segment_event(3, 1.5, false, SegmentMediaType::Video));
        manifest.record(&segment_event(1, 2.0, false, SegmentMediaType::Video));
        manifest.record(&segment_event(2, 2.0, false, SegmentMediaType::Audio));
        manifest.record(&segment_event(1, 1.8, false, SegmentMediaType::Audio));

        assert!(!manifest.has_video_content());
        manifest.record(&segment_event(0, 0.0, true, SegmentMediaType::Video));
        manifest.record(&segment_event(0, 0.0, true, SegmentMediaType::Audio));

        assert!(manifest.has_video_content());
        assert_eq!(
            manifest
                .video_segments
                .iter()
                .map(|segment| segment.index)
                .collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert_eq!(
            manifest
                .audio_segments
                .iter()
                .map(|segment| segment.index)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(manifest.video_init_uploaded);
        assert!(manifest.audio_init_uploaded);
        assert!(!manifest.is_complete);
    }

    #[test]
    fn initial_segment_batch_prefetches_initializers_and_matching_media_pairs() {
        let paths = prefetched_segment_paths(1, 3);

        assert_eq!(paths.len(), 9);
        assert!(paths.contains(&"segments/video/init.mp4".to_string()));
        assert!(paths.contains(&"segments/audio/init.mp4".to_string()));
        assert!(paths.contains(&"segments/manifest.json".to_string()));
        assert!(paths.contains(&"segments/video/segment_001.m4s".to_string()));
        assert!(paths.contains(&"segments/audio/segment_003.m4s".to_string()));
    }

    #[test]
    fn subsequent_segment_batches_do_not_repeat_initializers() {
        assert_eq!(
            prefetched_segment_paths(21, 2),
            vec![
                "segments/video/segment_021.m4s",
                "segments/audio/segment_021.m4s",
                "segments/video/segment_022.m4s",
                "segments/audio/segment_022.m4s",
            ]
        );
    }

    #[test]
    fn segment_manifest_updates_replayed_segments_without_duplicates() {
        let mut manifest = SegmentUploadManifest::default();
        manifest.record(&segment_event(4, 1.0, false, SegmentMediaType::Video));
        manifest.record(&segment_event(4, 2.5, false, SegmentMediaType::Video));

        assert_eq!(
            manifest.video_segments,
            vec![SegmentManifestEntry {
                index: 4,
                duration: 2.5,
            }]
        );
    }

    #[test]
    fn segment_upload_paths_match_tauri_storage_layout() {
        assert_eq!(
            segment_subpath(&segment_event(0, 0.0, true, SegmentMediaType::Video)),
            "segments/video/init.mp4"
        );
        assert_eq!(
            segment_subpath(&segment_event(0, 0.0, true, SegmentMediaType::Audio)),
            "segments/audio/init.mp4"
        );
        assert_eq!(
            segment_subpath(&segment_event(7, 2.0, false, SegmentMediaType::Video)),
            "segments/video/segment_007.m4s"
        );
        assert_eq!(
            segment_subpath(&segment_event(14, 2.0, false, SegmentMediaType::Audio)),
            "segments/audio/segment_014.m4s"
        );
    }

    #[test]
    fn signed_upload_content_types_match_media() {
        assert_eq!(
            upload_content_type("segments/manifest.json"),
            "application/json"
        );
        assert_eq!(upload_content_type("segments/video/init.mp4"), "video/mp4");
        assert_eq!(
            upload_content_type("segments/audio/segment_001.m4s"),
            "video/mp4"
        );
        assert_eq!(
            upload_content_type("screenshot/screen-capture.jpg"),
            "image/jpeg"
        );
        assert_eq!(
            upload_content_type("screenshot/screen-capture.png"),
            "image/png"
        );
    }

    #[test]
    fn chunk_size_clamps() {
        assert_eq!(chunk_size_for(1), MIN_CHUNK_SIZE);
        // A hundredth of the file, clamped: the upper assertion needs a file
        // whose hundredth actually exceeds the cap (1.5 GiB does; the old
        // `MIN_CHUNK_SIZE * 200` = 1000 MiB sat below it and asserted the
        // wrong side of the clamp).
        assert_eq!(chunk_size_for(MAX_CHUNK_SIZE * 200), MAX_CHUNK_SIZE);
        assert_eq!(chunk_size_for(MIN_CHUNK_SIZE * 50), MIN_CHUNK_SIZE);
    }

    #[test]
    fn drive_url_detection() {
        assert!(is_google_drive_resumable_url(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"
        ));
        assert!(!is_google_drive_resumable_url(
            "https://s3.amazonaws.com/bucket/key"
        ));
        assert!(is_google_drive_upload(Some("googleDrive"), "abc"));
    }

    #[test]
    fn reusable_video_id_prefers_sharing_state() {
        let sharing = SharingMeta {
            link: "https://cap.so/s/shared".into(),
            id: "shared".into(),
            content_hash: None,
        };
        let upload = UploadMeta::SinglePartUpload {
            video_id: "pending".into(),
            file_path: PathBuf::from("video.mp4"),
            screenshot_path: PathBuf::from("display.jpg"),
            recording_dir: PathBuf::from("recording.cap"),
        };

        assert_eq!(
            reusable_video_id(Some(&sharing), Some(&upload)).as_deref(),
            Some("shared")
        );
    }

    #[test]
    fn reusable_video_id_resumes_persisted_upload() {
        let upload = UploadMeta::SinglePartUpload {
            video_id: "pending".into(),
            file_path: PathBuf::from("video.mp4"),
            screenshot_path: PathBuf::from("display.jpg"),
            recording_dir: PathBuf::from("recording.cap"),
        };

        assert_eq!(
            reusable_video_id(None, Some(&upload)).as_deref(),
            Some("pending")
        );
        assert_eq!(
            reusable_video_id(
                None,
                Some(&UploadMeta::Failed {
                    error: "network".into(),
                }),
            ),
            None
        );
    }
    #[derive(Default)]
    struct FakeSegmentTransport {
        manifests: Mutex<Vec<bool>>,
        completed: std::sync::atomic::AtomicUsize,
        uploaded: std::sync::atomic::AtomicUsize,
        fail_segment: AtomicBool,
        delay_complete: AtomicBool,
        complete_started: tokio::sync::Notify,
        complete_response: tokio::sync::Notify,
        prefetch_count: std::sync::atomic::AtomicUsize,
        delay_prefetch_at: std::sync::atomic::AtomicUsize,
        prefetch_started: tokio::sync::Notify,
        prefetch_response: tokio::sync::Notify,
    }
    impl SegmentTransport for FakeSegmentTransport {
        async fn prefetch(
            &self,
            _: &str,
            _: u32,
            _: u32,
        ) -> Result<HashMap<String, String>, String> {
            let request = self.prefetch_count.fetch_add(1, Ordering::AcqRel) + 1;
            if request == self.delay_prefetch_at.load(Ordering::Acquire) {
                self.prefetch_started.notify_one();
                self.prefetch_response.notified().await;
            }
            Ok(HashMap::new())
        }
        async fn segment(
            &self,
            _: String,
            event: SegmentCompletedEvent,
            _: Arc<Mutex<HashMap<String, String>>>,
            _: Arc<AtomicBool>,
        ) -> Result<SegmentCompletedEvent, String> {
            if self.fail_segment.load(Ordering::Acquire) {
                Err("segment upload failed".into())
            } else {
                self.uploaded.fetch_add(1, Ordering::AcqRel);
                Ok(event)
            }
        }
        async fn manifest(
            &self,
            _: &str,
            manifest: &SegmentUploadManifest,
            _: &Arc<AtomicBool>,
        ) -> Result<(), String> {
            self.manifests.lock().unwrap().push(manifest.is_complete);
            Ok(())
        }
        async fn complete(&self, _: &str, _: &Arc<AtomicBool>) -> Result<(), String> {
            self.completed.fetch_add(1, Ordering::AcqRel);
            if self.delay_complete.load(Ordering::Acquire) {
                self.complete_started.notify_one();
                self.complete_response.notified().await;
            }
            Ok(())
        }
    }
    fn closed_segment_events() -> flume::Receiver<SegmentCompletedEvent> {
        let (sender, receiver) = flume::unbounded();
        sender
            .send(segment_event(0, 0.0, true, SegmentMediaType::Video))
            .unwrap();
        sender
            .send(segment_event(1, 1.0, false, SegmentMediaType::Video))
            .unwrap();
        drop(sender);
        receiver
    }

    #[tokio::test]
    async fn segmented_complete_response_after_revocation_cannot_publish_delete_or_share() {
        let transport = FakeSegmentTransport::default();
        transport.delay_complete.store(true, Ordering::Release);
        let authorization = CompletionAuthorization::new();
        let cancel = authorization.control.cancel.clone();
        authorization.permit.send(()).unwrap();
        let published = AtomicBool::new(false);
        let deleted = AtomicBool::new(false);
        let shared = AtomicBool::new(false);
        let future = async {
            crate::recording::finish_instant_upload_locally(
                Some(&cancel),
                upload_segments(
                    &transport,
                    "revoked-completion",
                    closed_segment_events(),
                    cancel.clone(),
                    Some(authorization.required),
                ),
                || {
                    published.store(true, Ordering::Release);
                    Ok(())
                },
                async {
                    deleted.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await?;
            shared.store(true, Ordering::Release);
            Ok::<(), anyhow::Error>(())
        };
        tokio::pin!(future);
        tokio::select! {
            _ = transport.complete_started.notified() => {}
            result = &mut future => panic!("Completion did not wait: {result:?}"),
        }
        authorization.control.deny();
        transport.complete_response.notify_one();
        assert!(future.await.unwrap_err().to_string().contains("cancelled"));
        assert_eq!(transport.completed.load(Ordering::Acquire), 1);
        assert!(!published.load(Ordering::Acquire));
        assert!(!deleted.load(Ordering::Acquire));
        assert!(!shared.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn segmented_prefetch_response_after_revocation_cannot_start_more_uploads() {
        for pause_at in [1, 2] {
            let transport = FakeSegmentTransport::default();
            transport
                .delay_prefetch_at
                .store(pause_at, Ordering::Release);
            let authorization = CompletionAuthorization::new();
            authorization.permit.send(()).unwrap();
            let (sender, receiver) = flume::unbounded();
            sender
                .send(segment_event(0, 0.0, true, SegmentMediaType::Video))
                .unwrap();
            sender
                .send(segment_event(20, 1.0, false, SegmentMediaType::Video))
                .unwrap();
            drop(sender);
            let future = upload_segments(
                &transport,
                "revoked-prefetch",
                receiver,
                authorization.control.cancel.clone(),
                Some(authorization.required),
            );
            tokio::pin!(future);
            tokio::select! {
                _ = transport.prefetch_started.notified() => {}
                result = &mut future => panic!("Prefetch did not wait: {result:?}"),
            }
            let uploaded = transport.uploaded.load(Ordering::Acquire);
            authorization.control.deny();
            transport.prefetch_response.notify_one();
            assert!(future.await.unwrap_err().contains("cancelled"));
            assert_eq!(transport.uploaded.load(Ordering::Acquire), uploaded);
            assert_eq!(transport.prefetch_count.load(Ordering::Acquire), pause_at);
            assert_eq!(transport.completed.load(Ordering::Acquire), 0);
        }
    }

    #[tokio::test]
    async fn segmented_retry_delay_observes_revocation_before_next_request() {
        let cancel = AtomicBool::new(false);
        let requested = AtomicBool::new(false);
        let future = async {
            segment_retry_delay(&cancel, Duration::from_millis(20)).await?;
            checked_segment_step(&cancel, || async {
                requested.store(true, Ordering::Release);
                Ok(())
            })
            .await
        };
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(Duration::from_millis(1), &mut future)
                .await
                .is_err()
        );
        cancel.store(true, Ordering::Release);
        assert!(future.await.unwrap_err().contains("cancelled"));
        assert!(!requested.load(Ordering::Acquire));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn segmented_screenshot_uses_shared_revocation_before_reading_file() {
        let authorization = CompletionAuthorization::new();
        let control = authorization.control.clone();
        let upload = InstantUpload {
            video: VideoUploadInfo {
                id: "cancelled-thumbnail".into(),
                link: "https://example.invalid/s/cancelled-thumbnail".into(),
                config: S3UploadMeta {
                    id: "cancelled-thumbnail".into(),
                },
            },
            segment_upload: None,
            cancel: control.cancel.clone(),
            metadata_lock: Arc::new(Mutex::new(())),
            completion_permit: Some(authorization.permit),
            completion_control: Some(control.clone()),
        };
        control.deny();
        assert!(
            upload
                .finish_screenshot(Path::new("/not-a-recording/cancelled.cap"))
                .await
                .unwrap_err()
                .contains("Export cancelled")
        );
    }

    #[tokio::test]
    async fn segmented_presign_response_revocation_prevents_following_put() {
        let cancel = AtomicBool::new(false);
        let put_started = AtomicBool::new(false);
        let (response, received) = tokio::sync::oneshot::channel();
        let future = async {
            optional_upload_step(Some(&cancel), || async {
                received.await.unwrap();
                Ok(())
            })
            .await?;
            optional_upload_step(Some(&cancel), || async {
                put_started.store(true, Ordering::Release);
                Ok(())
            })
            .await
        };
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(Duration::from_millis(1), &mut future)
                .await
                .is_err()
        );
        cancel.store(true, Ordering::Release);
        response.send(()).unwrap();
        assert!(future.await.is_err());
        assert!(!put_started.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn closed_capture_events_wait_for_successful_stop_permission_before_complete() {
        let transport = FakeSegmentTransport::default();
        let authorization = CompletionAuthorization::new();
        let future = upload_segments(
            &transport,
            "owned-attempt",
            closed_segment_events(),
            Arc::new(AtomicBool::new(false)),
            Some(authorization.required),
        );
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        assert_eq!(transport.completed.load(Ordering::Acquire), 0);
        assert!(
            transport
                .manifests
                .lock()
                .unwrap()
                .iter()
                .all(|complete| !complete)
        );
        authorization.permit.send(()).unwrap();
        future.await.unwrap();
        assert_eq!(transport.completed.load(Ordering::Acquire), 1);
        assert_eq!(transport.manifests.lock().unwrap().last(), Some(&true));
    }

    #[tokio::test]
    async fn failed_stop_denies_completion_even_after_all_segments_uploaded() {
        let transport = FakeSegmentTransport::default();
        let authorization = CompletionAuthorization::new();
        let future = upload_segments(
            &transport,
            "failed-attempt",
            closed_segment_events(),
            Arc::new(AtomicBool::new(false)),
            Some(authorization.required),
        );
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        assert_eq!(transport.uploaded.load(Ordering::Acquire), 2);
        drop(authorization.permit);
        assert!(future.await.unwrap_err().contains("not authorized"));
        assert_eq!(transport.completed.load(Ordering::Acquire), 0);
        assert!(
            transport
                .manifests
                .lock()
                .unwrap()
                .iter()
                .all(|complete| !complete)
        );
    }

    #[tokio::test]
    async fn cancelled_or_failed_upload_cannot_complete_with_a_queued_permission() {
        for fail_segment in [false, true] {
            let transport = FakeSegmentTransport::default();
            transport
                .fail_segment
                .store(fail_segment, Ordering::Release);
            let authorization = CompletionAuthorization::new();
            authorization.permit.send(()).unwrap();
            assert!(
                upload_segments(
                    &transport,
                    "failed-attempt",
                    closed_segment_events(),
                    Arc::new(AtomicBool::new(!fail_segment)),
                    Some(authorization.required)
                )
                .await
                .is_err()
            );
            assert_eq!(transport.completed.load(Ordering::Acquire), 0);
            assert!(
                transport
                    .manifests
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|complete| !complete)
            );
        }
    }

    #[tokio::test]
    async fn permission_from_an_old_attempt_cannot_release_a_new_attempt() {
        let old = CompletionAuthorization::new();
        drop(old.required);
        let current = CompletionAuthorization::new();
        let transport = FakeSegmentTransport::default();
        let future = upload_segments(
            &transport,
            "new-attempt",
            closed_segment_events(),
            Arc::new(AtomicBool::new(false)),
            Some(current.required),
        );
        tokio::pin!(future);
        assert!(old.permit.send(()).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        assert_eq!(transport.completed.load(Ordering::Acquire), 0);
        current.permit.send(()).unwrap();
        future.await.unwrap();
        assert_eq!(transport.completed.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn legacy_upload_without_authorization_preserves_channel_close_completion() {
        let transport = FakeSegmentTransport::default();
        upload_segments(
            &transport,
            "legacy-attempt",
            closed_segment_events(),
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .await
        .unwrap();
        assert_eq!(transport.completed.load(Ordering::Acquire), 1);
    }
    #[tokio::test]
    async fn aborting_upload_revokes_its_completion_permission_before_retry() {
        let authorization = CompletionAuthorization::new();
        let mut upload = InstantUpload {
            video: VideoUploadInfo {
                id: "cancelled".into(),
                link: "https://example.invalid/s/cancelled".into(),
                config: S3UploadMeta {
                    id: "cancelled".into(),
                },
            },
            segment_upload: None,
            cancel: Arc::new(AtomicBool::new(false)),
            metadata_lock: Arc::new(Mutex::new(())),
            completion_permit: Some(authorization.permit),
            completion_control: Some(authorization.control),
        };
        upload.abort_segments().await;
        assert!(authorization.required.permission.await.is_err());
        assert!(upload.authorize_completion().is_err());
    }
    #[tokio::test]
    async fn revocation_wakes_pending_completion_without_upload_mutex_or_permit_drop() {
        let authorization = CompletionAuthorization::new();
        let transport = FakeSegmentTransport::default();
        let future = upload_segments(
            &transport,
            "revoked-attempt",
            closed_segment_events(),
            authorization.control.cancel.clone(),
            Some(authorization.required),
        );
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        authorization.control.deny();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), future)
                .await
                .unwrap()
                .is_err()
        );
        assert_eq!(transport.completed.load(Ordering::Acquire), 0);
        assert!(
            transport
                .manifests
                .lock()
                .unwrap()
                .iter()
                .all(|complete| !complete)
        );
        assert!(authorization.permit.send(()).is_err());
    }
}

#[cfg(test)]
mod exported_upload_cancellation_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn cancelled_export_returns_before_auth_metadata_or_upload_submission() {
        let result = upload_exported_video(
            PathBuf::from("/not-a-recording/cancelled.cap"),
            None,
            |_| panic!("Cancelled export must not start"),
            Arc::new(AtomicBool::new(true)),
        )
        .await;
        assert!(result.unwrap_err().contains("Export cancelled"));
    }

    #[tokio::test]
    async fn cancellation_during_an_inflight_step_prevents_following_complete_submission() {
        let cancel = Arc::new(AtomicBool::new(false));
        let requested = Arc::new(AtomicUsize::new(0));
        let worker_cancel = cancel.clone();
        let worker_requested = requested.clone();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            checked_upload_step(&worker_cancel, || async {
                entered.send(()).unwrap();
                released.await.unwrap();
                Ok(())
            })
            .await?;
            checked_upload_step(&worker_cancel, || async {
                worker_requested.fetch_add(1, Ordering::AcqRel);
                Ok(())
            })
            .await
        });
        entered_rx.await.unwrap();
        cancel.store(true, Ordering::Release);
        release.send(()).unwrap();
        assert!(
            worker
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("Export cancelled")
        );
        assert_eq!(requested.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn cancellation_while_retry_waits_prevents_retry_and_complete() {
        let cancel = Arc::new(AtomicBool::new(false));
        let attempts = Arc::new(AtomicUsize::new(0));
        let worker_cancel = cancel.clone();
        let worker_attempts = attempts.clone();
        let (waiting, waiting_rx) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let first = checked_upload_step(&worker_cancel, || async {
                worker_attempts.fetch_add(1, Ordering::AcqRel);
                Err::<(), _>(AuthApiError::Other("network failure".into()))
            })
            .await;
            assert!(first.is_err());
            checked_upload_step(&worker_cancel, || async {
                waiting.send(()).unwrap();
                released.await.unwrap();
                Ok(())
            })
            .await?;
            checked_upload_step(&worker_cancel, || async {
                worker_attempts.fetch_add(1, Ordering::AcqRel);
                Ok(())
            })
            .await
        });
        waiting_rx.await.unwrap();
        cancel.store(true, Ordering::Release);
        release.send(()).unwrap();
        assert!(worker.await.unwrap().is_err());
        assert_eq!(attempts.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn instant_camera_only_export_observes_the_same_revocation_token() {
        let authorization = CompletionAuthorization::new();
        let control = authorization.control.clone();
        let upload = InstantUpload {
            video: VideoUploadInfo {
                id: "camera-only".into(),
                link: "https://example.invalid/s/camera-only".into(),
                config: S3UploadMeta {
                    id: "camera-only".into(),
                },
            },
            segment_upload: None,
            cancel: control.cancel.clone(),
            metadata_lock: Arc::new(Mutex::new(())),
            completion_permit: Some(authorization.permit),
            completion_control: Some(authorization.control),
        };
        let token = upload.cancellation_token();
        assert!(Arc::ptr_eq(&token, &control.cancel));
        control.deny();
        assert!(
            upload_exported_video(PathBuf::new(), None, |_| {}, token)
                .await
                .unwrap_err()
                .contains("Export cancelled")
        );
    }

    #[tokio::test]
    async fn optional_legacy_step_and_uncancelled_export_step_keep_results() {
        assert_eq!(
            optional_upload_step(None, || async { Ok(7) })
                .await
                .unwrap(),
            7
        );
        assert_eq!(
            checked_upload_step(&AtomicBool::new(false), || async { Ok(9) })
                .await
                .unwrap(),
            9
        );
        let result: Result<(), _> = checked_upload_step(&AtomicBool::new(true), || async {
            panic!("No new request may be submitted")
        })
        .await;
        assert!(result.is_err());
    }
}
