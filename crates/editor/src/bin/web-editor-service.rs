use std::{
    env,
    error::Error,
    io,
    path::PathBuf,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, Request, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{
        HeaderMap, StatusCode,
        header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use cap_editor::{
    AudioOutput, EditorFrameOutput, EditorInstance, FrameLayout, HEADLESS_CHANNELS,
    HEADLESS_SAMPLE_RATE, SegmentMedia, default_screen_recording_project_config,
    generate_project_auto_zoom_segments, waveform_peaks,
};
use cap_project::{
    KeyboardSettings, KeyboardTrackSegment, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta, XY, generate_project_keyboard_segments,
};
use cap_rendering::RenderedFrame;
use image::{
    ImageEncoder,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore, broadcast, mpsc, watch};

#[path = "../clip_thumbnails_shared.rs"]
mod clip_thumbnails_shared;
#[path = "web-editor-service/preview_h264.rs"]
mod web_editor_preview_h264;

static THUMBNAIL_SEMAPHORE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));
const MAX_CONFIG_BYTES: usize = 8 * 1024 * 1024;

type ApiError = (StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FramePlacement {
    display: [f32; 4],
    camera: Option<[f32; 4]>,
    output_width: u32,
    output_height: u32,
}

impl From<FrameLayout> for FramePlacement {
    fn from(layout: FrameLayout) -> Self {
        Self {
            display: layout.display,
            camera: layout.camera,
            output_width: layout.output_size[0],
            output_height: layout.output_size[1],
        }
    }
}

struct FramePacket {
    bytes: Bytes,
    compressed: Bytes,
    rendered: RenderedFrame,
    is_preview: bool,
    frame_number: u32,
    placement: FramePlacement,
}

#[derive(Default)]
struct FrameMetrics {
    produced: AtomicU64,
    packed: AtomicU64,
    pack_nanos: AtomicU64,
    raw_bytes: AtomicU64,
    sent_bytes: AtomicU64,
    h264_frames: AtomicU64,
    h264_bytes: AtomicU64,
}

struct ServiceState {
    editor: Arc<EditorInstance>,
    frame_rx: watch::Receiver<Option<Arc<FramePacket>>>,
    audio_tx: broadcast::Sender<Bytes>,
    playhead_rx: watch::Receiver<u32>,
    preview_lock: Mutex<()>,
    instance_id: String,
    internal_token: String,
    socket_origin: String,
    frame_metrics: Arc<FrameMetrics>,
    playing: Arc<AtomicBool>,
    force_png: Arc<AtomicBool>,
    png_viewers: Arc<AtomicU64>,
    h264_viewers: Arc<AtomicU64>,
    preview_fps: Arc<AtomicU64>,
}

struct PreviewPngGuard(Arc<AtomicBool>);

impl Drop for PreviewPngGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

struct FrameViewerGuard(Arc<AtomicU64>);

impl FrameViewerGuard {
    fn new(viewers: Arc<AtomicU64>) -> Self {
        viewers.fetch_add(1, Ordering::Relaxed);
        Self(viewers)
    }
}

impl Drop for FrameViewerGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRequest {
    frame_number: u32,
    fps: u32,
    resolution_base: XY<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaNameRequest {
    pretty_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyboardGenerationRequest {
    grouping_threshold_ms: f64,
    linger_duration_ms: f64,
    show_modifiers: bool,
    show_special_keys: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoZoomRequest {
    zoom_amount: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewResponse {
    frame_number: u32,
    placement: FramePlacement,
}

fn invalid_request(message: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}

fn internal_error(message: impl Into<String>) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, message.into())
}

fn validate_preview(request: &PreviewRequest) -> ApiResult<()> {
    if !(1..=60).contains(&request.fps)
        || request.resolution_base.x == 0
        || request.resolution_base.y == 0
        || request.resolution_base.x > 3840
        || request.resolution_base.y > 2160
    {
        return Err(invalid_request("Invalid preview frame rate or resolution"));
    }
    Ok(())
}

fn pack_frame(
    frame: RenderedFrame,
    layout: FrameLayout,
    compress_png: bool,
    is_preview: bool,
) -> Option<FramePacket> {
    let stride = frame.padded_bytes_per_row as usize;
    let row_bytes = frame.width as usize * 4;
    let height = frame.height as usize;
    if row_bytes == 0 || height == 0 || stride < row_bytes || frame.data.len() < stride * height {
        return None;
    }
    let packed = if stride == row_bytes {
        None
    } else {
        let mut data = Vec::with_capacity(row_bytes * height);
        for row in 0..height {
            let offset = row * stride;
            data.extend_from_slice(&frame.data[offset..offset + row_bytes]);
        }
        Some(data)
    };
    let rgba = packed
        .as_deref()
        .unwrap_or(&frame.data[..row_bytes * height]);
    let mut png = Vec::new();
    if compress_png {
        let encoded =
            PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
                .write_image(
                    rgba,
                    frame.width,
                    frame.height,
                    image::ColorType::Rgba8.into(),
                );
        if let Err(error) = encoded {
            tracing::warn!(?error, "Editor frame PNG compression failed");
            png.clear();
        }
    }
    let mut footer = Vec::with_capacity(24);
    footer.extend_from_slice(&frame.padded_bytes_per_row.to_le_bytes());
    footer.extend_from_slice(&frame.height.to_le_bytes());
    footer.extend_from_slice(&frame.width.to_le_bytes());
    footer.extend_from_slice(&frame.frame_number.to_le_bytes());
    footer.extend_from_slice(&frame.target_time_ns.to_le_bytes());
    let mut bytes = Vec::with_capacity(frame.data.len() + 24);
    bytes.extend_from_slice(frame.data.as_ref());
    bytes.extend_from_slice(&footer);
    let compressed = if png.is_empty() {
        Bytes::new()
    } else {
        let mut packet = Vec::with_capacity(png.len() + 32);
        packet.extend_from_slice(b"CAPPNG01");
        packet.extend_from_slice(&png);
        packet.extend_from_slice(&footer);
        packet.into()
    };
    Some(FramePacket {
        bytes: bytes.into(),
        compressed,
        frame_number: frame.frame_number,
        rendered: frame,
        is_preview,
        placement: layout.into(),
    })
}

fn pack_audio(samples: &[f32], deadline: Instant) -> Bytes {
    let wait = deadline.saturating_duration_since(Instant::now());
    let deadline_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .saturating_add(wait.as_nanos())
        .min(u128::from(u64::MAX)) as u64;
    let frames = (samples.len() / usize::from(HEADLESS_CHANNELS)) as u16;
    let mut bytes = Vec::with_capacity(20 + samples.len() * 4);
    bytes.extend_from_slice(b"CAPA");
    bytes.extend_from_slice(&HEADLESS_SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&HEADLESS_CHANNELS.to_le_bytes());
    bytes.extend_from_slice(&frames.to_le_bytes());
    bytes.extend_from_slice(&deadline_ns.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes.into()
}

async fn health() -> StatusCode {
    StatusCode::OK
}

async fn require_internal_token(
    State(state): State<Arc<ServiceState>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == state.internal_token);
    if !authorized {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}

async fn metrics(State(state): State<Arc<ServiceState>>) -> Json<serde_json::Value> {
    let counts = &state.frame_metrics;
    let packed = counts.packed.load(Ordering::Relaxed);
    Json(serde_json::json!({
        "gpuAdapter": state.editor.render_constants.adapter_name(),
        "softwareAdapter": state.editor.render_constants.is_software_adapter,
        "producedFrames": counts.produced.load(Ordering::Relaxed),
        "packedFrames": packed,
        "avgPackMs": if packed == 0 { 0.0 } else {
            counts.pack_nanos.load(Ordering::Relaxed) as f64 / packed as f64 / 1_000_000.0
        },
        "rawBytes": counts.raw_bytes.load(Ordering::Relaxed),
        "sentBytes": counts.sent_bytes.load(Ordering::Relaxed),
        "h264Frames": counts.h264_frames.load(Ordering::Relaxed),
        "h264Bytes": counts.h264_bytes.load(Ordering::Relaxed),
        "pngViewers": state.png_viewers.load(Ordering::Relaxed),
        "h264Viewers": state.h264_viewers.load(Ordering::Relaxed),
        "playing": state.playing.load(Ordering::Relaxed),
        "forcePng": state.force_png.load(Ordering::Relaxed),
    }))
}

async fn instance(State(state): State<Arc<ServiceState>>) -> Json<serde_json::Value> {
    let editor = &state.editor;
    let saved_project_config = editor.project_config.1.borrow().clone();
    Json(serde_json::json!({
        "instanceId": state.instance_id,
        "preparingPlayback": false,
        "preparingSnapshot": null,
        "framesSocketUrl": format!("{}/frames", state.socket_origin),
        "audioSocketUrl": format!("{}/audio", state.socket_origin),
        "eventsSocketUrl": format!("{}/events", state.socket_origin),
        "recordingDuration": editor.recordings.duration(),
        "savedProjectConfig": saved_project_config,
        "recordings": editor.recordings,
        "path": editor.project_path,
        "notchBase": editor.render_constants.meta.display_notch().unwrap_or(cap_project::DEFAULT_MACBOOK_NOTCH),
    }))
}

async fn meta(State(state): State<Arc<ServiceState>>) -> ApiResult<Json<RecordingMeta>> {
    RecordingMeta::load_for_project(&state.editor.project_path)
        .map(Json)
        .map_err(|error| internal_error(error.to_string()))
}

async fn generate_keyboard_segments(
    State(state): State<Arc<ServiceState>>,
    Json(request): Json<KeyboardGenerationRequest>,
) -> ApiResult<Json<Vec<KeyboardTrackSegment>>> {
    if !request.grouping_threshold_ms.is_finite()
        || !(0.0..=60_000.0).contains(&request.grouping_threshold_ms)
        || !request.linger_duration_ms.is_finite()
        || !(0.0..=60_000.0).contains(&request.linger_duration_ms)
    {
        return Err(invalid_request("Invalid keyboard generation settings"));
    }
    let Some(timeline) = state.editor.project_config.1.borrow().timeline.clone() else {
        return Ok(Json(Vec::new()));
    };
    let meta = RecordingMeta::load_for_project(&state.editor.project_path)
        .map_err(|error| internal_error(error.to_string()))?;
    let settings = KeyboardSettings {
        grouping_threshold_ms: request.grouping_threshold_ms,
        linger_duration: (request.linger_duration_ms / 1000.0) as f32,
        show_modifiers: request.show_modifiers,
        show_special_keys: request.show_special_keys,
        ..Default::default()
    };
    tokio::task::spawn_blocking(move || {
        generate_project_keyboard_segments(&meta, &timeline, &settings)
    })
    .await
    .map_err(|error| internal_error(error.to_string()))?
    .map(Json)
    .map_err(internal_error)
}

async fn generate_auto_zoom_segments(
    State(state): State<Arc<ServiceState>>,
    Json(request): Json<AutoZoomRequest>,
) -> ApiResult<Json<Vec<cap_project::ZoomSegment>>> {
    if !request.zoom_amount.is_finite() || !(0.1..=10.0).contains(&request.zoom_amount) {
        return Err(invalid_request("Invalid auto zoom amount"));
    }
    let meta = RecordingMeta::load_for_project(&state.editor.project_path)
        .map_err(|error| internal_error(error.to_string()))?;
    let timeline = state.editor.project_config.1.borrow().timeline.clone();
    let duration = state.editor.recordings.duration();
    let amount = request.zoom_amount;
    tokio::task::spawn_blocking(move || {
        generate_project_auto_zoom_segments(&meta, timeline.as_ref(), duration, amount)
    })
    .await
    .map(Json)
    .map_err(|error| internal_error(error.to_string()))
}

async fn save_meta_name(
    State(state): State<Arc<ServiceState>>,
    Json(request): Json<MetaNameRequest>,
) -> ApiResult<StatusCode> {
    let length = request.pretty_name.encode_utf16().count();
    if !(5..=100).contains(&length)
        || request.pretty_name.trim() != request.pretty_name
        || request.pretty_name.chars().any(char::is_control)
    {
        return Err(invalid_request("Invalid recording title"));
    }
    let mut meta = RecordingMeta::load_for_project(&state.editor.project_path)
        .map_err(|error| internal_error(error.to_string()))?;
    meta.pretty_name = request.pretty_name;
    meta.save_for_project()
        .map_err(|error| internal_error(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clip_thumbnail(
    State(state): State<Arc<ServiceState>>,
    Path((recording_segment, time_ms)): Path<(u32, i64)>,
) -> ApiResult<impl IntoResponse> {
    if !(0..=43_200_000).contains(&time_ms) {
        return Err(invalid_request("Invalid thumbnail time"));
    }
    let meta = RecordingMeta::load_for_project(&state.editor.project_path)
        .map_err(|error| internal_error(error.to_string()))?;
    let RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Err(invalid_request(
            "Clip thumbnails require a studio recording",
        ));
    };
    let display_path = match studio.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => meta.path(&segment.display.path),
        StudioRecordingMeta::MultipleSegments { inner } => {
            let segment = inner
                .segments
                .get(recording_segment as usize)
                .ok_or_else(|| invalid_request("Recording segment not found"))?;
            meta.path(&segment.display.path)
        }
    };
    let cache_path = state
        .editor
        .project_path
        .join("thumbnails")
        .join("clips-v2")
        .join(format!("seg{recording_segment}_{time_ms}.jpg"));
    if !tokio::fs::try_exists(&cache_path)
        .await
        .map_err(|error| internal_error(error.to_string()))?
    {
        let permit = THUMBNAIL_SEMAPHORE
            .acquire()
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        if !tokio::fs::try_exists(&cache_path)
            .await
            .map_err(|error| internal_error(error.to_string()))?
        {
            let output = cache_path.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                clip_thumbnails_shared::decode_clip_thumbnail(
                    &display_path,
                    time_ms as f64 / 1000.0,
                    &output,
                )
            })
            .await
            .map_err(|error| internal_error(error.to_string()))?
            .map_err(internal_error)?;
        }
    }
    let jpeg = tokio::fs::read(&cache_path)
        .await
        .map_err(|error| internal_error(error.to_string()))?;
    if jpeg.is_empty() || jpeg.len() > 256 * 1024 {
        return Err(internal_error("Invalid thumbnail size"));
    }
    Ok(([(CONTENT_TYPE, "image/jpeg")], Bytes::from(jpeg)))
}

async fn config(State(state): State<Arc<ServiceState>>) -> Json<ProjectConfiguration> {
    Json(state.editor.project_config.1.borrow().clone())
}

async fn default_config() -> Json<ProjectConfiguration> {
    Json(default_screen_recording_project_config())
}

async fn waveforms(segments: &[SegmentMedia], system_audio: bool) -> Vec<Vec<f32>> {
    let mut result = Vec::with_capacity(segments.len());
    for segment in segments {
        let loader = if system_audio {
            &segment.system_audio
        } else {
            &segment.audio
        };
        match loader.get().await {
            Ok(Some(audio)) => result.push(waveform_peaks(
                audio.sample_slices().flatten(),
                audio.channels(),
            )),
            Ok(None) | Err(_) => result.push(Vec::new()),
        }
    }
    result
}

async fn mic_waveforms(State(state): State<Arc<ServiceState>>) -> Json<Vec<Vec<f32>>> {
    Json(waveforms(state.editor.segment_medias.as_slice(), false).await)
}

async fn system_audio_waveforms(State(state): State<Arc<ServiceState>>) -> Json<Vec<Vec<f32>>> {
    Json(waveforms(state.editor.segment_medias.as_slice(), true).await)
}

async fn animated_gradients() -> Json<cap_project::AnimatedGradientCatalog> {
    Json(cap_project::animated_gradient_catalog())
}

async fn random_animated_gradient() -> Json<cap_project::AnimatedGradientConfig> {
    Json(cap_project::AnimatedGradientConfig::random())
}

async fn save_config(
    State(state): State<Arc<ServiceState>>,
    Json(config): Json<ProjectConfiguration>,
) -> ApiResult<StatusCode> {
    config
        .write(&state.editor.project_path)
        .map_err(|error| internal_error(error.to_string()))?;
    state
        .editor
        .project_config
        .0
        .send_modify(|current| *current = config);
    Ok(StatusCode::NO_CONTENT)
}

async fn update_config_in_memory(
    State(state): State<Arc<ServiceState>>,
    Json(config): Json<ProjectConfiguration>,
) -> StatusCode {
    state
        .editor
        .project_config
        .0
        .send_modify(|current| *current = config);
    StatusCode::NO_CONTENT
}

async fn preview(
    State(state): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<PreviewRequest>,
) -> ApiResult<impl IntoResponse> {
    validate_preview(&request)?;
    let _guard = state.preview_lock.lock().await;
    state.force_png.store(true, Ordering::Relaxed);
    let _png_guard = PreviewPngGuard(state.force_png.clone());
    let mut frame_rx = state.frame_rx.clone();
    drop(frame_rx.borrow_and_update());
    state.editor.preview_tx.send_modify(|current| {
        *current = Some((request.frame_number, request.fps, request.resolution_base));
    });
    let packet = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            frame_rx
                .changed()
                .await
                .map_err(|error| internal_error(error.to_string()))?;
            let packet = frame_rx.borrow_and_update().clone();
            if let Some(packet) = packet
                && packet.frame_number == request.frame_number
            {
                return Ok::<_, ApiError>(packet);
            }
        }
    })
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            "Preview frame timed out".into(),
        )
    })??;
    let placement = serde_json::to_string(&PreviewResponse {
        frame_number: packet.frame_number,
        placement: packet.placement.clone(),
    })
    .map_err(|error| internal_error(error.to_string()))?;
    if headers.get(ACCEPT).and_then(|value| value.to_str().ok())
        == Some("application/vnd.cap.editor-event")
    {
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Ok(([("x-cap-frame-placement", placement)], packet.bytes.clone()).into_response())
    }
}

async fn start_playback(
    State(state): State<Arc<ServiceState>>,
    Json(request): Json<PreviewRequest>,
) -> ApiResult<StatusCode> {
    validate_preview(&request)?;
    state
        .editor
        .modify_and_emit_state(|editor_state| {
            editor_state.playhead_position = request.frame_number;
        })
        .await;
    state
        .preview_fps
        .store(u64::from(request.fps), Ordering::Relaxed);
    state
        .editor
        .start_playback(request.fps, request.resolution_base)
        .await;
    state.playing.store(true, Ordering::Relaxed);
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_playback(State(state): State<Arc<ServiceState>>) -> StatusCode {
    state.playing.store(false, Ordering::Relaxed);
    let playback = {
        let mut editor_state = state.editor.state.lock().await;
        editor_state.playback_task.take()
    };
    if let Some(handle) = playback {
        handle.stop();
    }
    let mut active = state.editor.playback_watch();
    let stopped = tokio::time::timeout(Duration::from_secs(2), async {
        while *active.borrow_and_update() {
            if active.changed().await.is_err() {
                return false;
            }
        }
        true
    })
    .await;
    if matches!(stopped, Ok(true)) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::GATEWAY_TIMEOUT
    }
}

async fn seek(
    State(state): State<Arc<ServiceState>>,
    Json(request): Json<PreviewRequest>,
) -> ApiResult<StatusCode> {
    validate_preview(&request)?;
    if !state.editor.seek_playback(request.frame_number).await {
        state
            .editor
            .modify_and_emit_state(|editor_state| {
                editor_state.playhead_position = request.frame_number;
            })
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn frames(ws: WebSocketUpgrade, State(state): State<Arc<ServiceState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| frame_socket(socket, state))
}

async fn frame_socket(mut socket: WebSocket, state: Arc<ServiceState>) {
    let _viewer_guard = FrameViewerGuard::new(state.png_viewers.clone());
    let mut frame_rx = state.frame_rx.clone();
    let initial_packet = frame_rx.borrow_and_update().clone();
    if let Some(packet) = initial_packet
        && !packet.compressed.is_empty()
        && socket
            .send(Message::Binary(packet.compressed.to_vec()))
            .await
            .is_err()
    {
        return;
    }
    while frame_rx.changed().await.is_ok() {
        let packet = frame_rx.borrow_and_update().clone();
        if let Some(packet) = packet
            && !packet.compressed.is_empty()
            && socket
                .send(Message::Binary(packet.compressed.to_vec()))
                .await
                .is_err()
        {
            break;
        }
    }
}

enum H264WorkerMessage {
    Packet(Message),
    Error(String),
}

fn pack_h264_packet(
    packet: web_editor_preview_h264::PreviewH264Packet,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    let data_len = u32::try_from(packet.data.len()).ok()?;
    let mut bytes = Vec::with_capacity(packet.data.len() + 41);
    bytes.extend_from_slice(b"CAPH2641");
    bytes.extend_from_slice(&packet.sequence.to_le_bytes());
    bytes.push(u8::from(packet.is_keyframe));
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(&packet.frame_number.to_le_bytes());
    bytes.extend_from_slice(&packet.target_time_ns.to_le_bytes());
    bytes.extend_from_slice(&data_len.to_le_bytes());
    bytes.extend_from_slice(&packet.data);
    Some(bytes)
}

fn encode_h264_frames(
    mut input_rx: mpsc::Receiver<Arc<FramePacket>>,
    output_tx: mpsc::Sender<H264WorkerMessage>,
    state: Arc<ServiceState>,
    target_bpp_hundredths: Arc<AtomicU64>,
) {
    let mut encoder = None::<(
        u32,
        u32,
        u32,
        u64,
        web_editor_preview_h264::PreviewH264Encoder,
    )>;
    while let Some(packet) = input_rx.blocking_recv() {
        let width = packet.rendered.width;
        let height = packet.rendered.height;
        let fps = state.preview_fps.load(Ordering::Relaxed) as u32;
        let bpp_hundredths = target_bpp_hundredths.load(Ordering::Relaxed);
        if !encoder.as_ref().is_some_and(
            |(current_width, current_height, current_fps, current_bpp, _)| {
                *current_width == width
                    && *current_height == height
                    && *current_fps == fps
                    && *current_bpp == bpp_hundredths
            },
        ) {
            let next = match web_editor_preview_h264::PreviewH264Encoder::new(
                width,
                height,
                fps,
                bpp_hundredths as f32 / 100.0,
            ) {
                Ok(next) => next,
                Err(error) => {
                    let _ = output_tx.blocking_send(H264WorkerMessage::Error(error));
                    return;
                }
            };
            let configuration = serde_json::json!({
                "kind": "cap-h264-config",
                "codec": next.codec(),
                "width": width,
                "height": height,
            });
            if output_tx
                .blocking_send(H264WorkerMessage::Packet(Message::Text(
                    configuration.to_string(),
                )))
                .is_err()
            {
                return;
            }
            encoder = Some((width, height, fps, bpp_hundredths, next));
        }
        let Some((_, _, _, _, encoder)) = encoder.as_mut() else {
            return;
        };
        let encoded = match encoder.encode(&packet.rendered) {
            Ok(encoded) => encoded,
            Err(error) => {
                let _ = output_tx.blocking_send(H264WorkerMessage::Error(error));
                return;
            }
        };
        for frame in encoded {
            let Some(bytes) = pack_h264_packet(frame, width, height) else {
                let _ = output_tx.blocking_send(H264WorkerMessage::Error(
                    "H.264 preview packet was invalid".to_string(),
                ));
                return;
            };
            state
                .frame_metrics
                .h264_frames
                .fetch_add(1, Ordering::Relaxed);
            state
                .frame_metrics
                .h264_bytes
                .fetch_add(bytes.len() as u64, Ordering::Relaxed);
            if output_tx
                .blocking_send(H264WorkerMessage::Packet(Message::Binary(bytes)))
                .is_err()
            {
                return;
            }
        }
    }
}

async fn h264_frames(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServiceState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| h264_frame_socket(socket, state))
}

async fn h264_frame_socket(mut socket: WebSocket, state: Arc<ServiceState>) {
    let mut h264_guard = Some(FrameViewerGuard::new(state.h264_viewers.clone()));
    let mut png_guard = None::<FrameViewerGuard>;
    let mut fallback_png = false;
    let mut frame_rx = state.frame_rx.clone();
    let (input_tx, input_rx) = mpsc::channel(2);
    let (output_tx, mut output_rx) = mpsc::channel(2);
    let encoder_state = state.clone();
    let target_bpp_hundredths = Arc::new(AtomicU64::new(18));
    let encoder_bpp = target_bpp_hundredths.clone();
    let encoder_task = tokio::task::spawn_blocking(move || {
        encode_h264_frames(input_rx, output_tx, encoder_state, encoder_bpp)
    });
    let initial = frame_rx.borrow_and_update().clone();
    if let Some(packet) = initial {
        if state.playing.load(Ordering::Relaxed) && !packet.is_preview {
            let _ = input_tx.try_send(packet);
        } else if !packet.compressed.is_empty()
            && socket
                .send(Message::Binary(packet.compressed.to_vec()))
                .await
                .is_err()
        {
            drop(input_tx);
            drop(output_rx);
            let _ = encoder_task.await;
            return;
        }
    }
    loop {
        tokio::select! {
            changed = frame_rx.changed() => {
                if changed.is_err() { break; }
                let packet = frame_rx.borrow_and_update().clone();
                if let Some(packet) = packet {
                    if fallback_png || packet.is_preview || !state.playing.load(Ordering::Relaxed) {
                        if packet.compressed.is_empty() { continue; }
                        if socket.send(Message::Binary(packet.compressed.to_vec())).await.is_err() { break; }
                    } else {
                        let _ = input_tx.try_send(packet);
                    }
                }
            }
            encoded = output_rx.recv(), if !fallback_png => {
                match encoded {
                    Some(H264WorkerMessage::Packet(message)) => {
                        if socket.send(message).await.is_err() { break; }
                    }
                    Some(H264WorkerMessage::Error(error)) => {
                        drop(h264_guard.take());
                        png_guard = Some(FrameViewerGuard::new(state.png_viewers.clone()));
                        fallback_png = true;
                        let unavailable = serde_json::json!({
                            "kind": "cap-h264-unavailable",
                            "error": error,
                        });
                        if socket.send(Message::Text(unavailable.to_string())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(value))) if value == "{\"mode\":\"png\"}" => {
                        drop(h264_guard.take());
                        png_guard = Some(FrameViewerGuard::new(state.png_viewers.clone()));
                        fallback_png = true;
                    }
                    Some(Ok(Message::Text(value))) if value == "{\"bitrate\":\"low\"}" && !fallback_png => {
                        target_bpp_hundredths.store(5, Ordering::Relaxed);
                    }
                    Some(Ok(Message::Text(value))) if value == "{\"bitrate\":\"high\"}" && !fallback_png => {
                        target_bpp_hundredths.store(18, Ordering::Relaxed);
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {
                        let _ = socket.close().await;
                        break;
                    }
                }
            }
        }
    }
    drop(input_tx);
    drop(output_rx);
    drop(png_guard);
    drop(h264_guard);
    if let Err(error) = encoder_task.await {
        tracing::warn!(?error, "H.264 preview encoder task failed");
    }
}

async fn events(ws: WebSocketUpgrade, State(state): State<Arc<ServiceState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| {
        event_socket(socket, state.frame_rx.clone(), state.playhead_rx.clone())
    })
}

async fn audio(ws: WebSocketUpgrade, State(state): State<Arc<ServiceState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| audio_socket(socket, state.audio_tx.subscribe()))
}

async fn audio_socket(mut socket: WebSocket, mut audio_rx: broadcast::Receiver<Bytes>) {
    loop {
        match audio_rx.recv().await {
            Ok(packet) => {
                if socket.send(Message::Binary(packet.to_vec())).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn event_socket(
    mut socket: WebSocket,
    mut frame_rx: watch::Receiver<Option<Arc<FramePacket>>>,
    mut playhead_rx: watch::Receiver<u32>,
) {
    loop {
        let event = tokio::select! {
            changed = frame_rx.changed() => {
                if changed.is_err() { break; }
                let frame = frame_rx.borrow_and_update().clone();
                frame.map(|frame| serde_json::json!({
                    "event": "frameLayoutEvent",
                    "payload": frame.placement,
                }))
            }
            changed = playhead_rx.changed() => {
                if changed.is_err() { break; }
                let position = *playhead_rx.borrow_and_update();
                Some(serde_json::json!({
                    "event": "editorStateChanged",
                    "payload": { "playhead_position": position },
                }))
            }
        };
        if let Some(event) = event
            && socket.send(Message::Text(event.to_string())).await.is_err()
        {
            break;
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let internal_token = env::var("CAP_WEB_EDITOR_INTERNAL_TOKEN")?;
    if internal_token.len() != 43
        || !internal_token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(
            io::Error::new(io::ErrorKind::InvalidInput, "Invalid internal editor token").into(),
        );
    }
    let project_path = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing project path"))?;
    let (frame_tx, frame_rx) = watch::channel(None);
    let (frame_input_tx, mut frame_input_rx) =
        watch::channel::<Option<Arc<(RenderedFrame, FrameLayout)>>>(None);
    let frame_metrics = Arc::new(FrameMetrics::default());
    let playing = Arc::new(AtomicBool::new(false));
    let force_png = Arc::new(AtomicBool::new(false));
    let png_viewers = Arc::new(AtomicU64::new(0));
    let h264_viewers = Arc::new(AtomicU64::new(0));
    let preview_fps = Arc::new(AtomicU64::new(60));
    let pack_metrics = frame_metrics.clone();
    let pack_playing = playing.clone();
    let pack_force_png = force_png.clone();
    let pack_png_viewers = png_viewers.clone();
    let pack_h264_viewers = h264_viewers.clone();
    tokio::spawn(async move {
        while frame_input_rx.changed().await.is_ok() {
            let input = frame_input_rx.borrow_and_update().clone();
            if let Some(input) = input {
                let started = Instant::now();
                let is_preview = pack_force_png.load(Ordering::Relaxed);
                let compress_png = is_preview
                    || !pack_playing.load(Ordering::Relaxed)
                    || pack_h264_viewers.load(Ordering::Relaxed) == 0
                    || pack_png_viewers.load(Ordering::Relaxed) > 0;
                match tokio::task::spawn_blocking(move || {
                    pack_frame(input.0.clone(), input.1, compress_png, is_preview)
                })
                .await
                {
                    Ok(Some(packet)) => {
                        pack_metrics.packed.fetch_add(1, Ordering::Relaxed);
                        pack_metrics.pack_nanos.fetch_add(
                            started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64,
                            Ordering::Relaxed,
                        );
                        pack_metrics
                            .raw_bytes
                            .fetch_add(packet.bytes.len() as u64, Ordering::Relaxed);
                        if compress_png {
                            pack_metrics.sent_bytes.fetch_add(
                                if packet.compressed.is_empty() {
                                    packet.bytes.len()
                                } else {
                                    packet.compressed.len()
                                } as u64,
                                Ordering::Relaxed,
                            );
                        }
                        frame_tx.send_modify(|current| *current = Some(Arc::new(packet)));
                    }
                    Ok(None) => {}
                    Err(error) => tracing::warn!(?error, "Editor frame compression task failed"),
                }
            }
        }
    });
    let (playhead_tx, playhead_rx) = watch::channel(0);
    let (audio_tx, _) = broadcast::channel(32);
    let audio_tap_tx = audio_tx.clone();
    let produced_metrics = frame_metrics.clone();
    let editor = EditorInstance::new_with_audio_output(
        project_path,
        move |editor_state| {
            playhead_tx.send_modify(|position| *position = editor_state.playhead_position);
        },
        Box::new(move |output, layout| {
            if let EditorFrameOutput::Rgba(frame) = output {
                produced_metrics.produced.fetch_add(1, Ordering::Relaxed);
                frame_input_tx.send_modify(|current| *current = Some(Arc::new((frame, layout))));
            }
        }),
        None,
        Arc::new(AudioOutput::new_headless(Box::new(
            move |samples, deadline| {
                let _ = audio_tap_tx.send(pack_audio(samples, deadline));
            },
        ))),
    )
    .await
    .map_err(io::Error::other)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let instance_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .to_string();
    let state = Arc::new(ServiceState {
        editor,
        frame_rx,
        audio_tx,
        playhead_rx,
        preview_lock: Mutex::new(()),
        instance_id,
        internal_token,
        socket_origin: format!("ws://{address}"),
        frame_metrics,
        playing,
        force_png,
        png_viewers,
        h264_viewers,
        preview_fps,
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/instance", get(instance))
        .route("/keyboard-segments", post(generate_keyboard_segments))
        .route("/auto-zoom-segments", post(generate_auto_zoom_segments))
        .route(
            "/meta",
            get(meta)
                .put(save_meta_name)
                .layer(DefaultBodyLimit::max(1024)),
        )
        .route("/clip-thumbnail/:segment/:time_ms", get(clip_thumbnail))
        .route(
            "/config",
            get(config)
                .put(save_config)
                .layer(DefaultBodyLimit::max(MAX_CONFIG_BYTES)),
        )
        .route("/default-config", get(default_config))
        .route("/waveforms/mic", get(mic_waveforms))
        .route("/waveforms/system", get(system_audio_waveforms))
        .route(
            "/config/memory",
            put(update_config_in_memory).layer(DefaultBodyLimit::max(MAX_CONFIG_BYTES)),
        )
        .route("/animated-gradients", get(animated_gradients))
        .route("/animated-gradients/random", get(random_animated_gradient))
        .route("/preview", post(preview))
        .route("/playback", post(start_playback).delete(stop_playback))
        .route("/seek", put(seek))
        .route("/frames", get(frames))
        .route("/frames-h264", get(h264_frames))
        .route("/audio", get(audio))
        .route("/events", get(events))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state,
            require_internal_token,
        ));
    println!("{}", serde_json::json!({ "address": address.to_string() }));
    axum::serve(listener, app).await?;
    Ok(())
}
