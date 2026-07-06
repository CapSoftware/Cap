use crate::PendingScreenshots;
use crate::frame_ws::{WSFrame, create_watch_frame_ws};
use crate::gpu_context;
use crate::windows::{CapWindowId, ScreenshotEditorWindowIds};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, SingleSegment, StudioRecordingMeta,
    VideoMeta,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderVideoConstants,
    RendererLayers, ZoomTransformTimeline,
};
use image::{
    GenericImageView, ImageEncoder, RgbImage, buffer::ConvertBuffer, codecs::png::PngEncoder,
};
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Cursor;
use std::str::FromStr;
use std::time::Instant;
use std::{collections::HashMap, ops::Deref, path::PathBuf, sync::Arc};
use tauri::{
    AppHandle, Manager, Runtime, Window,
    ipc::{CommandArg, InvokeError},
};
use tokio::sync::{RwLock, watch};
use tokio_util::sync::CancellationToken;

const MAX_DIMENSION: u32 = 16_384;

type PendingResult = Result<Arc<ScreenshotEditorInstance>, String>;
type PendingReceiver = watch::Receiver<Option<PendingResult>>;

#[derive(Clone)]
pub struct ScreenshotConfigUpdate {
    pub revision: u32,
    pub config: ProjectConfiguration,
}

pub struct ScreenshotEditorInstance {
    pub ws_port: u16,
    pub ws_shutdown_token: CancellationToken,
    pub config_tx: watch::Sender<ScreenshotConfigUpdate>,
    pub path: PathBuf,
    pub pretty_name: String,
    pub image_width: u32,
    pub image_height: u32,
    source_rgba: Arc<Vec<u8>>,
}

impl ScreenshotEditorInstance {
    pub async fn dispose(&self) {
        self.ws_shutdown_token.cancel();
    }
}

impl Drop for ScreenshotEditorInstance {
    fn drop(&mut self) {
        self.ws_shutdown_token.cancel();
    }
}

#[derive(Clone, Default)]
pub struct PendingScreenshotEditorInstances(Arc<RwLock<HashMap<String, PendingReceiver>>>);

#[derive(Clone)]
pub struct ScreenshotEditorInstances(Arc<RwLock<HashMap<String, Arc<ScreenshotEditorInstance>>>>);

pub struct WindowScreenshotEditorInstance(pub Arc<ScreenshotEditorInstance>);

impl specta::function::FunctionArg for WindowScreenshotEditorInstance {
    fn to_datatype(_: &mut specta::TypeMap) -> Option<specta::DataType> {
        None
    }
}

impl Deref for WindowScreenshotEditorInstance {
    type Target = Arc<ScreenshotEditorInstance>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for WindowScreenshotEditorInstance {
    fn from_command(command: tauri::ipc::CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let window = Window::from_command(command)?;

        let instances = window.state::<ScreenshotEditorInstances>();
        let instance = futures::executor::block_on(instances.0.read());

        if let Some(instance) = instance.get(window.label()).cloned() {
            Ok(Self(instance))
        } else {
            Err(InvokeError::from(format!(
                "no ScreenshotEditor instance for window '{}'",
                window.label(),
            )))
        }
    }
}

impl ScreenshotEditorInstances {
    async fn create_standalone_instance(
        app_handle: &AppHandle,
        path: PathBuf,
    ) -> Result<Arc<ScreenshotEditorInstance>, String> {
        let create_started = Instant::now();
        let (frame_tx, frame_rx) = watch::channel(None);
        let (ws_port, ws_shutdown_token) =
            create_watch_frame_ws(frame_rx, Default::default()).await;
        if ws_port == 0 {
            return Err("Failed to start screenshot editor frame websocket".to_string());
        }

        let (data, width, height) = {
            let key = path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let pending = app_handle.try_state::<PendingScreenshots>();
            let pending_frame = pending.and_then(|p| p.remove(&key));

            if let Some(frame) = pending_frame {
                let width = frame.width;
                let height = frame.height;
                let channels = frame.channels;

                if width > MAX_DIMENSION || height > MAX_DIMENSION {
                    return Err(format!("Image dimensions exceed maximum: {width}x{height}"));
                }

                let expected_len = width
                    .checked_mul(height)
                    .and_then(|p| p.checked_mul(channels))
                    .ok_or_else(|| format!("Image dimensions overflow: {width}x{height}"))?;
                let expected_len = usize::try_from(expected_len)
                    .map_err(|_| format!("Image size too large: {width}x{height}"))?;

                let data = frame.data;

                if data.len() != expected_len {
                    return Err(format!(
                        "Image data length mismatch: expected {expected_len} bytes for {width}x{height}x{channels} frame, got {}",
                        data.len()
                    ));
                }

                let rgba_data = if channels == 4 {
                    let rgba_img = image::RgbaImage::from_raw(width, height, data)
                        .ok_or_else(|| format!("Invalid RGBA data for {width}x{height} frame"))?;
                    rgba_img.into_raw()
                } else {
                    let rgb_img = RgbImage::from_raw(width, height, data)
                        .ok_or_else(|| format!("Invalid RGB data for {width}x{height} frame"))?;
                    let rgba_img: image::RgbaImage = rgb_img.convert();
                    rgba_img.into_raw()
                };
                (rgba_data, width, height)
            } else {
                let image_path = if path.is_dir() {
                    let original = path.join("original.png");
                    if original.exists() {
                        original
                    } else {
                        std::fs::read_dir(&path)
                            .ok()
                            .and_then(|dir| {
                                dir.flatten()
                                    .find(|e| {
                                        e.path().extension().and_then(|s| s.to_str()) == Some("png")
                                    })
                                    .map(|e| e.path())
                            })
                            .ok_or_else(|| format!("No PNG file found in directory: {path:?}"))?
                    }
                } else {
                    path.clone()
                };

                let img =
                    image::open(&image_path).map_err(|e| format!("Failed to open image: {e}"))?;
                let (w, h) = img.dimensions();

                if w > MAX_DIMENSION || h > MAX_DIMENSION {
                    return Err(format!("Image dimensions exceed maximum: {w}x{h}"));
                }

                w.checked_mul(h)
                    .and_then(|p| p.checked_mul(4))
                    .ok_or_else(|| format!("Image dimensions overflow: {w}x{h}"))?;

                (img.to_rgba8().into_raw(), w, h)
            }
        };

        tracing::info!(
            elapsed_ms = create_started.elapsed().as_millis() as u64,
            width,
            height,
            "screenshot_editor timing: source image ready"
        );

        let cap_dir = if path.extension().and_then(|s| s.to_str()) == Some("cap") {
            Some(path.clone())
        } else if let Some(parent) = path.parent() {
            if parent.extension().and_then(|s| s.to_str()) == Some("cap") {
                Some(parent.to_path_buf())
            } else {
                None
            }
        } else {
            None
        };

        let (recording_meta, loaded_config) = if let Some(cap_dir) = &cap_dir {
            let meta = RecordingMeta::load_for_project(cap_dir).ok();
            let config = ProjectConfiguration::load(cap_dir).ok();
            (meta, config)
        } else {
            (None, None)
        };

        let recording_meta = if let Some(meta) = recording_meta {
            meta
        } else {
            let filename = path
                .file_name()
                .ok_or_else(|| "Invalid path".to_string())?
                .to_string_lossy();
            let relative_path = RelativePathBuf::from(filename.as_ref());
            let video_meta = VideoMeta {
                path: relative_path.clone(),
                fps: 30,
                start_time: Some(0.0),
                device_id: None,
            };
            let segment = SingleSegment {
                display: video_meta.clone(),
                camera: None,
                audio: None,
                cursor: None,
            };
            let studio_meta = StudioRecordingMeta::SingleSegment { segment };
            RecordingMeta {
                platform: None,
                project_path: path.parent().unwrap().to_path_buf(),
                pretty_name: "Screenshot".to_string(),
                sharing: None,
                inner: RecordingMetaInner::Studio(Box::new(studio_meta.clone())),
                upload: None,
            }
        };

        let (shared, background_cache) = if let Some(gpu) = gpu_context::get_shared_gpu().await {
            (
                cap_rendering::SharedWgpuDevice {
                    instance: (*gpu.instance).clone(),
                    adapter: (*gpu.adapter).clone(),
                    device: (*gpu.device).clone(),
                    queue: (*gpu.queue).clone(),
                    is_software_adapter: gpu.is_software_adapter,
                },
                gpu.background_cache.clone(),
            )
        } else {
            let instance = cap_rendering::create_wgpu_instance().await;
            let force_software_adapter = cap_rendering::force_software_wgpu_adapter();
            let hardware_adapter = if force_software_adapter {
                None
            } else {
                instance
                    .request_adapter(&wgpu::RequestAdapterOptions {
                        power_preference: wgpu::PowerPreference::HighPerformance,
                        force_fallback_adapter: false,
                        compatible_surface: None,
                    })
                    .await
                    .ok()
            };
            let adapter = match hardware_adapter {
                Some(adapter) => adapter,
                None => instance
                    .request_adapter(&wgpu::RequestAdapterOptions {
                        power_preference: wgpu::PowerPreference::LowPower,
                        force_fallback_adapter: true,
                        compatible_surface: None,
                    })
                    .await
                    .map_err(|_| "No GPU adapter found".to_string())?,
            };
            let adapter_info = adapter.get_info();
            let is_software_adapter = cap_rendering::is_software_wgpu_adapter(&adapter_info);

            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("cap-rendering-device"),
                    required_features: wgpu::Features::empty(),
                    ..Default::default()
                })
                .await
                .map_err(|e| e.to_string())?;
            (
                cap_rendering::SharedWgpuDevice {
                    instance,
                    adapter,
                    device,
                    queue,
                    is_software_adapter,
                },
                Arc::new(cap_rendering::BackgroundTextureCache::default()),
            )
        };

        let options = cap_rendering::RenderOptions {
            screen_size: cap_project::XY::new(width, height),
            camera_size: None,
            preserve_screen_alpha: true,
        };

        let studio_meta = match &recording_meta.inner {
            RecordingMetaInner::Studio(meta) => meta.clone(),
            _ => return Err("Invalid recording meta for screenshot".to_string()),
        };

        let constants = RenderVideoConstants::from_shared_device(
            shared,
            options,
            *studio_meta,
            recording_meta.clone(),
            background_cache,
        );

        tracing::info!(
            elapsed_ms = create_started.elapsed().as_millis() as u64,
            "screenshot_editor timing: gpu + render constants ready"
        );

        let (config_tx, mut config_rx) = watch::channel(ScreenshotConfigUpdate {
            revision: 0,
            config: loaded_config.unwrap_or_default(),
        });

        let render_shutdown_token = ws_shutdown_token.clone();

        let source_rgba = Arc::new(data);

        let instance = Arc::new(ScreenshotEditorInstance {
            ws_port,
            ws_shutdown_token,
            config_tx,
            path: path.clone(),
            pretty_name: recording_meta.pretty_name.clone(),
            image_width: width,
            image_height: height,
            source_rgba: source_rgba.clone(),
        });

        let decoded_frame = DecodedFrame::new(source_rgba.as_ref().clone(), width, height);

        tokio::spawn(async move {
            let layers_started = Instant::now();
            let mut frame_renderer = FrameRenderer::new(&constants);
            let mut layers = RendererLayers::new_with_options(
                &constants.device,
                &constants.queue,
                constants.is_software_adapter,
            );
            tracing::info!(
                layers_init_ms = layers_started.elapsed().as_millis() as u64,
                total_ms = create_started.elapsed().as_millis() as u64,
                "screenshot_editor timing: renderer layers initialized"
            );
            let shutdown_token = render_shutdown_token;
            let mut current_update = config_rx.borrow().clone();
            let mut current_config = current_update.config.clone();
            let mut current_revision = current_update.revision;
            let mut first_frame_logged = false;

            loop {
                if shutdown_token.is_cancelled() {
                    break;
                }
                let segment_frames = DecodedSegmentFrames {
                    screen_frame: Some(DecodedFrame::new(
                        decoded_frame.data().to_vec(),
                        decoded_frame.width(),
                        decoded_frame.height(),
                    )),
                    camera_frame: None,
                    segment_time: 0.0,
                    recording_time: 0.0,
                    segment_has_camera: false,
                };

                let (base_w, base_h) =
                    ProjectUniforms::get_base_size(&constants.options, &current_config);

                let cursor_events = cap_project::CursorEvents::default();
                let mut zoom_timeline = ZoomTransformTimeline::from_project(
                    &current_config,
                    &cursor_events,
                    0.0,
                    constants.options.screen_size,
                );
                zoom_timeline.ensure_precomputed_until(1.0 / 30.0);

                let uniforms = ProjectUniforms::new(
                    &constants,
                    &current_config,
                    0,
                    30,
                    cap_project::XY::new(base_w, base_h),
                    &cursor_events,
                    &segment_frames,
                    0.0,
                    &zoom_timeline,
                );

                let render_started = Instant::now();
                let rendered_frame = frame_renderer
                    .render_immediate(
                        segment_frames,
                        uniforms,
                        &cap_project::CursorEvents::default(),
                        true,
                        &mut layers,
                    )
                    .await;

                match rendered_frame {
                    Ok(frame) => {
                        if !first_frame_logged {
                            first_frame_logged = true;
                            tracing::info!(
                                render_ms = render_started.elapsed().as_millis() as u64,
                                total_ms = create_started.elapsed().as_millis() as u64,
                                frame_width = frame.width,
                                frame_height = frame.height,
                                frame_bytes = frame.data.len(),
                                "screenshot_editor timing: first frame rendered + sent"
                            );
                        }
                        let _ = frame_tx.send(Some(std::sync::Arc::new(WSFrame {
                            data: frame.data,
                            width: frame.width,
                            height: frame.height,
                            stride: frame.padded_bytes_per_row,
                            frame_number: current_revision,
                            target_time_ns: frame.target_time_ns,
                            format: crate::frame_ws::WSFrameFormat::Rgba,
                            created_at: Instant::now(),
                        })));
                    }
                    Err(e) => {
                        tracing::error!("Failed to render screenshot frame: {e}");
                    }
                }

                tokio::select! {
                    res = config_rx.changed() => {
                        if res.is_err() {
                            break;
                        }
                        current_update = config_rx.borrow().clone();
                        current_revision = current_update.revision;
                        current_config = current_update.config.clone();
                    }
                    _ = shutdown_token.cancelled() => {
                        break;
                    }
                }
            }
            let _ = frame_tx.send(None);
        });

        Ok(instance)
    }

    pub async fn get_or_create(
        window: &Window,
        path: PathBuf,
    ) -> Result<Arc<ScreenshotEditorInstance>, String> {
        let instances = match window.try_state::<ScreenshotEditorInstances>() {
            Some(s) => (*s).clone(),
            None => {
                let instances = Self(Arc::new(RwLock::new(HashMap::new())));
                window.manage(instances.clone());
                instances
            }
        };

        let mut instances = instances.0.write().await;

        use std::collections::hash_map::Entry;

        match instances.entry(window.label().to_string()) {
            Entry::Vacant(entry) => {
                let pending = PendingScreenshotEditorInstances::get(window.app_handle());

                if let Some(mut prewarmed_rx) = pending.take_prewarmed(window.label()).await {
                    loop {
                        if let Some(result) = prewarmed_rx.borrow_and_update().clone() {
                            let instance = result?;
                            entry.insert(instance.clone());
                            return Ok(instance);
                        }
                        if prewarmed_rx.changed().await.is_err() {
                            break;
                        }
                    }
                }

                let instance = Self::create_standalone_instance(window.app_handle(), path).await?;
                entry.insert(instance.clone());
                Ok(instance)
            }
            Entry::Occupied(entry) => {
                let instance = entry.get().clone();
                let config = instance.config_tx.borrow().clone();
                let _ = instance.config_tx.send(config);
                Ok(instance)
            }
        }
    }

    pub async fn remove(window: Window) {
        let instances = match window.try_state::<ScreenshotEditorInstances>() {
            Some(s) => (*s).clone(),
            None => return,
        };

        let mut instances = instances.0.write().await;
        if let Some(instance) = instances.remove(window.label()) {
            instance.dispose().await;
        }
    }

    pub async fn dispose_all(app: &AppHandle) {
        let Some(instances) = app.try_state::<ScreenshotEditorInstances>() else {
            return;
        };

        let instances = {
            let mut instances = instances.0.write().await;
            std::mem::take(&mut *instances)
        };

        let count = instances.len();
        for (_, instance) in instances {
            instance.dispose().await;
        }

        if count > 0 {
            tracing::info!(
                count,
                "Disposed screenshot editor instances during app exit"
            );
        }
    }
}

impl PendingScreenshotEditorInstances {
    pub fn get(app: &AppHandle) -> Self {
        match app.try_state::<Self>() {
            Some(s) => (*s).clone(),
            None => {
                let pending = Self::default();
                app.manage(pending.clone());
                pending
            }
        }
    }

    pub async fn start_prewarm(app: &AppHandle, window_label: String, path: PathBuf) {
        let pending = Self::get(app);
        let app = app.clone();

        {
            let instances = pending.0.read().await;
            if instances.contains_key(&window_label) {
                return;
            }
        }

        let (tx, rx) = watch::channel(None);

        {
            let mut instances = pending.0.write().await;
            instances.insert(window_label.clone(), rx);
        }

        tokio::spawn(async move {
            let result = ScreenshotEditorInstances::create_standalone_instance(&app, path).await;
            tx.send(Some(result)).ok();
        });
    }

    pub async fn take_prewarmed(&self, window_label: &str) -> Option<PendingReceiver> {
        let mut instances = self.0.write().await;
        instances.remove(window_label)
    }

    pub async fn cancel_prewarm(&self, window_label: &str) {
        let mut instances = self.0.write().await;
        if let Some(mut rx) = instances.remove(window_label) {
            tokio::spawn(async move {
                let timeout = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    loop {
                        let instance_to_dispose = {
                            let borrowed = rx.borrow_and_update().clone();
                            match borrowed {
                                Some(Ok(instance)) => Some(instance),
                                Some(Err(_)) => break,
                                None => None,
                            }
                        };

                        if let Some(instance) = instance_to_dispose {
                            instance.dispose().await;
                            break;
                        }

                        if rx.changed().await.is_err() {
                            break;
                        }
                    }
                });
                if timeout.await.is_err() {
                    tracing::warn!(
                        "Timed out waiting for prewarmed screenshot editor instance to complete for cleanup"
                    );
                }
            });
        }
    }

    pub async fn dispose_all(app: &AppHandle) {
        let Some(pending) = app.try_state::<Self>() else {
            return;
        };

        let pending = {
            let mut instances = pending.0.write().await;
            std::mem::take(&mut *instances)
        };

        let count = pending.len();
        for (_, mut rx) in pending {
            let result = tokio::time::timeout(std::time::Duration::from_millis(500), async {
                loop {
                    let instance_to_dispose = {
                        let borrowed = rx.borrow_and_update().clone();
                        match borrowed {
                            Some(Ok(instance)) => Some(instance),
                            Some(Err(_)) => break,
                            None => None,
                        }
                    };

                    if let Some(instance) = instance_to_dispose {
                        instance.dispose().await;
                        break;
                    }

                    if rx.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;

            if result.is_err() {
                tracing::warn!(
                    "Timed out disposing pending screenshot editor instance during app exit"
                );
            }
        }

        if count > 0 {
            tracing::info!(
                count,
                "Disposed pending screenshot editor instances during app exit"
            );
        }
    }
}

#[derive(Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SerializedScreenshotEditorInstance {
    pub frames_socket_url: String,
    pub path: PathBuf,
    pub config: Option<ProjectConfiguration>,
    pub pretty_name: String,
    pub image_width: u32,
    pub image_height: u32,
}

#[derive(Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotProjectExport {
    pub image_bytes: Vec<u8>,
    pub config: ProjectConfiguration,
    pub image_width: u32,
    pub image_height: u32,
}

#[derive(Clone, Copy, Deserialize, Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOcrRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOcrLine {
    pub text: String,
    pub confidence: Option<f32>,
    pub bounds: ScreenshotOcrRegion,
}

#[derive(Clone, Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOcrResult {
    pub text: String,
    pub lines: Vec<ScreenshotOcrLine>,
    pub engine: String,
}

struct ScreenshotOcrImage {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn create_screenshot_editor_instance(
    window: Window,
) -> Result<SerializedScreenshotEditorInstance, String> {
    let CapWindowId::ScreenshotEditor { id } =
        CapWindowId::from_str(window.label()).map_err(|e| e.to_string())?
    else {
        return Err("Invalid window".to_string());
    };

    let path = {
        let window_ids = ScreenshotEditorWindowIds::get(window.app_handle());
        let window_ids = window_ids.ids.lock().unwrap();
        let Some((path, _)) = window_ids.iter().find(|(_, _id)| *_id == id) else {
            return Err("Screenshot editor instance not found".to_string());
        };
        path.clone()
    };

    let instance = ScreenshotEditorInstances::get_or_create(&window, path).await?;
    let config = instance.config_tx.borrow().config.clone();

    Ok(SerializedScreenshotEditorInstance {
        frames_socket_url: format!("ws://localhost:{}", instance.ws_port),
        path: instance.path.clone(),
        config: Some(config),
        pretty_name: instance.pretty_name.clone(),
        image_width: instance.image_width,
        image_height: instance.image_height,
    })
}

/// Renders one tiny throwaway frame on the shared GPU at startup so the Metal
/// render pipelines are compiled before the user opens the editor. On Apple GPUs
/// pipeline *creation* is cheap but the driver defers shader compilation to the
/// first draw, which was costing ~3.5s on the first real frame. Doing it here moves
/// that cost into background startup time; the compiled pipelines are cached on the
/// shared device, so the first editor open renders immediately.
pub async fn prewarm_screenshot_renderer() {
    use std::sync::atomic::{AtomicBool, Ordering};

    static PREWARMED: AtomicBool = AtomicBool::new(false);
    if PREWARMED.swap(true, Ordering::SeqCst) {
        return;
    }

    let Some(gpu) = gpu_context::get_shared_gpu().await else {
        return;
    };

    let _ = tokio::task::spawn_blocking(cap_rendering::prewarm_fonts).await;

    let started = Instant::now();

    let shared = cap_rendering::SharedWgpuDevice {
        instance: (*gpu.instance).clone(),
        adapter: (*gpu.adapter).clone(),
        device: (*gpu.device).clone(),
        queue: (*gpu.queue).clone(),
        is_software_adapter: gpu.is_software_adapter,
    };

    let width = 64u32;
    let height = 64u32;

    let video_meta = VideoMeta {
        path: RelativePathBuf::from("prewarm.png"),
        fps: 30,
        start_time: Some(0.0),
        device_id: None,
    };
    let studio_meta = StudioRecordingMeta::SingleSegment {
        segment: SingleSegment {
            display: video_meta,
            camera: None,
            audio: None,
            cursor: None,
        },
    };
    let recording_meta = RecordingMeta {
        platform: None,
        project_path: std::env::temp_dir(),
        pretty_name: "Prewarm".to_string(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(studio_meta.clone())),
        upload: None,
    };

    let options = cap_rendering::RenderOptions {
        screen_size: cap_project::XY::new(width, height),
        camera_size: None,
        preserve_screen_alpha: true,
    };

    let constants = RenderVideoConstants::from_shared_device(
        shared,
        options,
        studio_meta,
        recording_meta,
        Arc::new(cap_rendering::BackgroundTextureCache::default()),
    );

    let config = ProjectConfiguration::default();
    let mut frame_renderer = FrameRenderer::new(&constants);
    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );

    let segment_frames = DecodedSegmentFrames {
        screen_frame: Some(DecodedFrame::new(
            vec![255u8; (width * height * 4) as usize],
            width,
            height,
        )),
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };

    let (base_w, base_h) = ProjectUniforms::get_base_size(&constants.options, &config);
    let cursor_events = cap_project::CursorEvents::default();
    let mut zoom_timeline = ZoomTransformTimeline::new(
        &[],
        None,
        &cursor_events,
        config.screen_movement_spring,
        0.0,
        None,
    );
    zoom_timeline.ensure_precomputed_until(1.0 / 30.0);
    let uniforms = ProjectUniforms::new(
        &constants,
        &config,
        0,
        30,
        cap_project::XY::new(base_w, base_h),
        &cursor_events,
        &segment_frames,
        0.0,
        &zoom_timeline,
    );

    match frame_renderer
        .render_immediate(
            segment_frames,
            uniforms,
            &cap_project::CursorEvents::default(),
            true,
            &mut layers,
        )
        .await
    {
        Ok(_) => {
            tracing::info!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                "screenshot_editor timing: render pipeline prewarm complete"
            );
        }
        Err(e) => {
            tracing::warn!("screenshot_editor render pipeline prewarm failed: {e}");
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn prewarm_screenshot_background(path: String) -> Result<(), String> {
    let Some(gpu) = gpu_context::get_shared_gpu().await else {
        return Ok(());
    };

    let Some(clean_path) = cap_rendering::clean_background_path(&path) else {
        return Ok(());
    };

    let _ = gpu
        .background_cache
        .ensure(&gpu.device, &gpu.queue, &clean_path)
        .await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn update_screenshot_config(
    instance: WindowScreenshotEditorInstance,
    config: ProjectConfiguration,
    save: bool,
    revision: u32,
) -> Result<(), String> {
    config.validate().map_err(|error| error.to_string())?;

    let _ = instance.config_tx.send(ScreenshotConfigUpdate {
        revision,
        config: config.clone(),
    });

    if !save {
        return Ok(());
    }

    let Some(parent) = instance.path.parent() else {
        return Ok(());
    };

    if parent.extension().and_then(|s| s.to_str()) == Some("cap") {
        let path = parent.to_path_buf();
        if let Err(e) = config.write(&path) {
            eprintln!("Failed to save screenshot config: {e}");
        } else {
            println!("Saved screenshot config to {path:?}");
        }
    } else {
        println!("Not saving config: parent {parent:?} is not a .cap directory");
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn recognize_screenshot_text(
    instance: WindowScreenshotEditorInstance,
    region: ScreenshotOcrRegion,
) -> Result<ScreenshotOcrResult, String> {
    let region = clamp_screenshot_ocr_region(region, instance.image_width, instance.image_height)?;
    let image = create_screenshot_ocr_image(
        instance.source_rgba.as_ref(),
        instance.image_width,
        instance.image_height,
        region,
    )?;
    let mut result = recognize_screenshot_ocr_image(image).await?;

    for line in &mut result.lines {
        line.bounds.x = line.bounds.x.saturating_add(region.x);
        line.bounds.y = line.bounds.y.saturating_add(region.y);
    }

    Ok(result)
}

pub async fn recognize_text_from_image_path(path: &std::path::Path) -> Result<String, String> {
    let dynamic = image::open(path).map_err(|e| format!("Failed to open image for OCR: {e}"))?;
    let rgba = dynamic.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();

    if width == 0 || height == 0 {
        return Err("Image is empty".to_string());
    }

    let rgba_bytes = rgba.into_raw();
    let mut bgra = vec![0u8; rgba_bytes.len()];
    for (src, dst) in rgba_bytes.chunks_exact(4).zip(bgra.chunks_exact_mut(4)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
        dst[3] = src[3];
    }

    let image = ScreenshotOcrImage {
        bgra,
        width,
        height,
    };

    let result = recognize_screenshot_ocr_image(image).await?;
    Ok(result.text)
}

fn clamp_screenshot_ocr_region(
    region: ScreenshotOcrRegion,
    image_width: u32,
    image_height: u32,
) -> Result<ScreenshotOcrRegion, String> {
    if image_width == 0 || image_height == 0 {
        return Err("Screenshot image is empty".to_string());
    }

    let x = region.x.min(image_width.saturating_sub(1));
    let y = region.y.min(image_height.saturating_sub(1));
    let width = region.width.min(image_width.saturating_sub(x));
    let height = region.height.min(image_height.saturating_sub(y));

    if width < 4 || height < 4 {
        return Err("Select a larger text area".to_string());
    }

    Ok(ScreenshotOcrRegion {
        x,
        y,
        width,
        height,
    })
}

fn create_screenshot_ocr_image(
    source_rgba: &[u8],
    image_width: u32,
    image_height: u32,
    region: ScreenshotOcrRegion,
) -> Result<ScreenshotOcrImage, String> {
    let image_width = usize::try_from(image_width)
        .map_err(|_| "Screenshot width is too large for OCR".to_string())?;
    let image_height = usize::try_from(image_height)
        .map_err(|_| "Screenshot height is too large for OCR".to_string())?;
    let region_x =
        usize::try_from(region.x).map_err(|_| "OCR region x is too large".to_string())?;
    let region_y =
        usize::try_from(region.y).map_err(|_| "OCR region y is too large".to_string())?;
    let region_width =
        usize::try_from(region.width).map_err(|_| "OCR region width is too large".to_string())?;
    let region_height =
        usize::try_from(region.height).map_err(|_| "OCR region height is too large".to_string())?;

    let expected_len = image_width
        .checked_mul(image_height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Screenshot image is too large for OCR".to_string())?;

    if source_rgba.len() != expected_len {
        return Err("Screenshot image data is invalid for OCR".to_string());
    }

    let output_len = region_width
        .checked_mul(region_height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "OCR region is too large".to_string())?;
    let mut bgra = vec![0; output_len];
    let source_row_bytes = image_width
        .checked_mul(4)
        .ok_or_else(|| "Screenshot row is too large for OCR".to_string())?;
    let region_row_bytes = region_width
        .checked_mul(4)
        .ok_or_else(|| "OCR row is too large".to_string())?;
    let region_x_bytes = region_x
        .checked_mul(4)
        .ok_or_else(|| "OCR region x is too large".to_string())?;

    for row in 0..region_height {
        let source_start = region_y
            .checked_add(row)
            .and_then(|source_row| source_row.checked_mul(source_row_bytes))
            .and_then(|source_offset| source_offset.checked_add(region_x_bytes))
            .ok_or_else(|| "OCR source region is invalid".to_string())?;
        let source_end = source_start
            .checked_add(region_row_bytes)
            .ok_or_else(|| "OCR source region is invalid".to_string())?;
        let output_start = row
            .checked_mul(region_row_bytes)
            .ok_or_else(|| "OCR output region is invalid".to_string())?;
        let output_end = output_start
            .checked_add(region_row_bytes)
            .ok_or_else(|| "OCR output region is invalid".to_string())?;
        let source_row = source_rgba
            .get(source_start..source_end)
            .ok_or_else(|| "OCR source region is outside the screenshot".to_string())?;
        let output_row = bgra
            .get_mut(output_start..output_end)
            .ok_or_else(|| "OCR output region is invalid".to_string())?;

        for (source_pixel, output_pixel) in source_row
            .chunks_exact(4)
            .zip(output_row.chunks_exact_mut(4))
        {
            output_pixel[0] = source_pixel[2];
            output_pixel[1] = source_pixel[1];
            output_pixel[2] = source_pixel[0];
            output_pixel[3] = source_pixel[3];
        }
    }

    Ok(ScreenshotOcrImage {
        bgra,
        width: region.width,
        height: region.height,
    })
}

#[cfg(target_os = "macos")]
async fn recognize_screenshot_ocr_image(
    image: ScreenshotOcrImage,
) -> Result<ScreenshotOcrResult, String> {
    tokio::task::spawn_blocking(move || recognize_screenshot_ocr_image_macos(image))
        .await
        .map_err(|e| format!("OCR task failed: {e}"))?
}

#[cfg(target_os = "windows")]
async fn recognize_screenshot_ocr_image(
    image: ScreenshotOcrImage,
) -> Result<ScreenshotOcrResult, String> {
    tokio::task::spawn_blocking(move || recognize_screenshot_ocr_image_windows(image))
        .await
        .map_err(|e| format!("OCR task failed: {e}"))?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn recognize_screenshot_ocr_image(
    _image: ScreenshotOcrImage,
) -> Result<ScreenshotOcrResult, String> {
    Err("OCR is only available on macOS and Windows".to_string())
}

#[cfg(target_os = "macos")]
fn recognize_screenshot_ocr_image_macos(
    image: ScreenshotOcrImage,
) -> Result<ScreenshotOcrResult, String> {
    cidre::objc::ar_pool(|| {
        use cidre::{cv, ns, vn};
        use std::ffi::c_void;

        extern "C" fn release_pixel_buffer_data(
            release_ref_con: *mut c_void,
            _base_address: *const *const c_void,
        ) {
            if !release_ref_con.is_null() {
                unsafe {
                    drop(Box::from_raw(release_ref_con.cast::<Vec<u8>>()));
                }
            }
        }

        let width =
            usize::try_from(image.width).map_err(|_| "OCR image width is too large".to_string())?;
        let height = usize::try_from(image.height)
            .map_err(|_| "OCR image height is too large".to_string())?;
        let bytes_per_row = width
            .checked_mul(4)
            .ok_or_else(|| "OCR image row is too large".to_string())?;
        let mut data = Box::new(image.bgra);
        let base_address = data.as_mut_ptr().cast::<c_void>();
        let release_ref_con = Box::into_raw(data).cast::<c_void>();

        let pixel_buffer = match cv::PixelBuf::with_bytes(
            width,
            height,
            base_address,
            bytes_per_row,
            release_pixel_buffer_data,
            release_ref_con,
            cv::PixelFormat::_32_BGRA,
            None,
        ) {
            Ok(pixel_buffer) => pixel_buffer,
            Err(e) => {
                unsafe {
                    drop(Box::from_raw(release_ref_con.cast::<Vec<u8>>()));
                }
                return Err(format!("Failed to create OCR image: {e}"));
            }
        };

        let mut request = vn::RecognizeTextRequest::new();
        request.set_recognition_level(vn::RequestTextRecognitionLevel::Accurate);
        request.set_uses_lang_correction(true);

        if cidre::version!(macos = 13.0) {
            request.set_revision(vn::RecognizeTextRequest::REVISION_3);
            unsafe {
                request.set_automatically_detects_lang(true);
            }
        } else {
            request.set_revision(vn::RecognizeTextRequest::REVISION_2);
        }

        let handler = vn::ImageRequestHandler::with_cv_pixel_buf(&pixel_buffer, None)
            .ok_or_else(|| "Failed to initialize OCR image handler".to_string())?;
        let requests = ns::Array::<vn::Request>::from_slice(&[&request]);
        handler
            .perform(&requests)
            .map_err(|e| format!("macOS OCR failed: {e}"))?;

        let observations = request.results().unwrap_or_else(ns::Array::new);
        let mut lines = Vec::new();

        for observation in observations.iter() {
            let candidates = observation.top_candidates(1);
            let Some(candidate) = candidates.first() else {
                continue;
            };
            let text = candidate.string().to_string();
            if text.trim().is_empty() {
                continue;
            }
            lines.push(ScreenshotOcrLine {
                text,
                confidence: Some(candidate.confidence()),
                bounds: normalized_macos_ocr_rect_to_region(
                    observation.bounding_box(),
                    image.width,
                    image.height,
                ),
            });
        }

        let text = lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        Ok(ScreenshotOcrResult {
            text,
            lines,
            engine: "macos-vision".to_string(),
        })
    })
}

#[cfg(target_os = "macos")]
fn normalized_macos_ocr_rect_to_region(
    rect: cidre::cg::Rect,
    width: u32,
    height: u32,
) -> ScreenshotOcrRegion {
    let width_f = f64::from(width);
    let height_f = f64::from(height);
    let left = clamp_f64(rect.origin.x * width_f, 0.0, width_f);
    let right = clamp_f64((rect.origin.x + rect.size.width) * width_f, 0.0, width_f);
    let top = clamp_f64(
        (1.0 - rect.origin.y - rect.size.height) * height_f,
        0.0,
        height_f,
    );
    let bottom = clamp_f64((1.0 - rect.origin.y) * height_f, 0.0, height_f);
    let x = left.round() as u32;
    let y = top.round() as u32;
    let right = right.round() as u32;
    let bottom = bottom.round() as u32;

    ScreenshotOcrRegion {
        x,
        y,
        width: right.saturating_sub(x),
        height: bottom.saturating_sub(y),
    }
}

#[cfg(target_os = "macos")]
fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        min
    }
}

#[cfg(target_os = "windows")]
struct WindowsRuntimeGuard;

#[cfg(target_os = "windows")]
impl Drop for WindowsRuntimeGuard {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::WinRT::RoUninitialize();
        }
    }
}

#[cfg(target_os = "windows")]
fn initialize_windows_runtime() -> Result<WindowsRuntimeGuard, String> {
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};

    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(|e| format!("Windows OCR runtime failed: {e}"))?;

    Ok(WindowsRuntimeGuard)
}

#[cfg(target_os = "windows")]
fn recognize_screenshot_ocr_image_windows(
    image: ScreenshotOcrImage,
) -> Result<ScreenshotOcrResult, String> {
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    let _runtime = initialize_windows_runtime()?;

    let max_dimension =
        OcrEngine::MaxImageDimension().map_err(|e| format!("Windows OCR failed: {e}"))?;

    if image.width > max_dimension || image.height > max_dimension {
        return Err(format!(
            "Select a smaller text area. Windows OCR supports up to {max_dimension}px per side"
        ));
    }

    let width = i32::try_from(image.width).map_err(|_| "OCR image width is too large")?;
    let height = i32::try_from(image.height).map_err(|_| "OCR image height is too large")?;
    let writer = DataWriter::new().map_err(|e| format!("Windows OCR failed: {e}"))?;
    writer
        .WriteBytes(&image.bgra)
        .map_err(|e| format!("Windows OCR failed: {e}"))?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|e| format!("Windows OCR failed: {e}"))?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width,
        height,
        BitmapAlphaMode::Premultiplied,
    )
    .map_err(|e| format!("Windows OCR failed: {e}"))?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("Windows OCR is not available: {e}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("Windows OCR failed: {e}"))?
        .get()
        .map_err(|e| format!("Windows OCR failed: {e}"))?;
    let text = result
        .Text()
        .map_err(|e| format!("Windows OCR failed: {e}"))?
        .to_string_lossy();
    let ocr_lines = result
        .Lines()
        .map_err(|e| format!("Windows OCR failed: {e}"))?;
    let mut lines = Vec::new();

    for index in 0..ocr_lines
        .Size()
        .map_err(|e| format!("Windows OCR failed: {e}"))?
    {
        let line = ocr_lines
            .GetAt(index)
            .map_err(|e| format!("Windows OCR failed: {e}"))?;
        let line_text = line
            .Text()
            .map_err(|e| format!("Windows OCR failed: {e}"))?
            .to_string_lossy();
        if line_text.trim().is_empty() {
            continue;
        }
        let words = line
            .Words()
            .map_err(|e| format!("Windows OCR failed: {e}"))?;
        let mut bounds: Option<(f32, f32, f32, f32)> = None;

        for word_index in 0..words
            .Size()
            .map_err(|e| format!("Windows OCR failed: {e}"))?
        {
            let rect = words
                .GetAt(word_index)
                .and_then(|word| word.BoundingRect())
                .map_err(|e| format!("Windows OCR failed: {e}"))?;
            bounds = Some(match bounds {
                Some((left, top, right, bottom)) => (
                    left.min(rect.X),
                    top.min(rect.Y),
                    right.max(rect.X + rect.Width),
                    bottom.max(rect.Y + rect.Height),
                ),
                None => (rect.X, rect.Y, rect.X + rect.Width, rect.Y + rect.Height),
            });
        }

        lines.push(ScreenshotOcrLine {
            text: line_text,
            confidence: None,
            bounds: bounds
                .map(windows_ocr_bounds_to_region)
                .unwrap_or(ScreenshotOcrRegion {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                }),
        });
    }

    Ok(ScreenshotOcrResult {
        text,
        lines,
        engine: "windows-media-ocr".to_string(),
    })
}

#[cfg(target_os = "windows")]
fn windows_ocr_bounds_to_region(
    (left, top, right, bottom): (f32, f32, f32, f32),
) -> ScreenshotOcrRegion {
    let x = clamp_f32_to_u32(left);
    let y = clamp_f32_to_u32(top);
    let right = clamp_f32_to_u32(right);
    let bottom = clamp_f32_to_u32(bottom);

    ScreenshotOcrRegion {
        x,
        y,
        width: right.saturating_sub(x),
        height: bottom.saturating_sub(y),
    }
}

#[cfg(target_os = "windows")]
fn clamp_f32_to_u32(value: f32) -> u32 {
    if value.is_finite() && value > 0.0 {
        value.round().min(u32::MAX as f32) as u32
    } else {
        0
    }
}

#[tauri::command]
#[specta::specta]
pub async fn render_screenshot_for_export(
    instance: WindowScreenshotEditorInstance,
) -> Result<Vec<u8>, String> {
    render_screenshot_png(&instance).await
}

#[tauri::command]
#[specta::specta]
pub async fn render_screenshot_project_for_export(
    app: AppHandle,
    path: PathBuf,
) -> Result<ScreenshotProjectExport, String> {
    let instance = ScreenshotEditorInstances::create_standalone_instance(&app, path).await?;
    let config = instance.config_tx.borrow().config.clone();
    let image_width = instance.image_width;
    let image_height = instance.image_height;

    let result =
        render_screenshot_png(&instance)
            .await
            .map(|image_bytes| ScreenshotProjectExport {
                image_bytes,
                config,
                image_width,
                image_height,
            });
    instance.dispose().await;
    result
}

pub async fn render_screenshot_png(instance: &ScreenshotEditorInstance) -> Result<Vec<u8>, String> {
    let path = instance.path.clone();
    let config = instance.config_tx.borrow().config.clone();
    let width = instance.image_width;
    let height = instance.image_height;

    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!("Image dimensions exceed maximum: {width}x{height}"));
    }

    let data = instance.source_rgba.as_ref().clone();

    let cap_dir = if path.extension().and_then(|s| s.to_str()) == Some("cap") {
        Some(path.clone())
    } else if let Some(parent) = path.parent() {
        if parent.extension().and_then(|s| s.to_str()) == Some("cap") {
            Some(parent.to_path_buf())
        } else {
            None
        }
    } else {
        None
    };

    let recording_meta = if let Some(cap_dir) = &cap_dir {
        RecordingMeta::load_for_project(cap_dir).map_err(|e| e.to_string())?
    } else {
        let filename = path
            .file_name()
            .ok_or_else(|| "Invalid path".to_string())?
            .to_string_lossy();
        let relative_path = RelativePathBuf::from(filename.as_ref());
        let video_meta = VideoMeta {
            path: relative_path.clone(),
            fps: 30,
            start_time: Some(0.0),
            device_id: None,
        };
        let segment = SingleSegment {
            display: video_meta.clone(),
            camera: None,
            audio: None,
            cursor: None,
        };
        let studio_meta = StudioRecordingMeta::SingleSegment { segment };
        RecordingMeta {
            platform: None,
            project_path: path.parent().unwrap_or(&path).to_path_buf(),
            pretty_name: "Screenshot".to_string(),
            sharing: None,
            inner: RecordingMetaInner::Studio(Box::new(studio_meta)),
            upload: None,
        }
    };

    let (shared, background_cache) = if let Some(gpu) = gpu_context::get_shared_gpu().await {
        (
            cap_rendering::SharedWgpuDevice {
                instance: (*gpu.instance).clone(),
                adapter: (*gpu.adapter).clone(),
                device: (*gpu.device).clone(),
                queue: (*gpu.queue).clone(),
                is_software_adapter: gpu.is_software_adapter,
            },
            gpu.background_cache.clone(),
        )
    } else {
        let instance = cap_rendering::create_wgpu_instance().await;
        let force_software_adapter = cap_rendering::force_software_wgpu_adapter();
        let hardware_adapter = if force_software_adapter {
            None
        } else {
            instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    force_fallback_adapter: false,
                    compatible_surface: None,
                })
                .await
                .ok()
        };
        let adapter = match hardware_adapter {
            Some(adapter) => adapter,
            None => instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    force_fallback_adapter: true,
                    compatible_surface: None,
                })
                .await
                .map_err(|_| "No GPU adapter found".to_string())?,
        };
        let adapter_info = adapter.get_info();
        let is_software_adapter = cap_rendering::is_software_wgpu_adapter(&adapter_info);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("cap-rendering-device"),
                required_features: wgpu::Features::empty(),
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())?;
        (
            cap_rendering::SharedWgpuDevice {
                instance,
                adapter,
                device,
                queue,
                is_software_adapter,
            },
            Arc::new(cap_rendering::BackgroundTextureCache::default()),
        )
    };

    let options = cap_rendering::RenderOptions {
        screen_size: cap_project::XY::new(width, height),
        camera_size: None,
        preserve_screen_alpha: true,
    };

    let studio_meta = match &recording_meta.inner {
        RecordingMetaInner::Studio(meta) => meta.clone(),
        _ => return Err("Invalid recording meta for screenshot".to_string()),
    };

    let constants = RenderVideoConstants::from_shared_device(
        shared,
        options,
        *studio_meta,
        recording_meta.clone(),
        background_cache,
    );

    let (base_width, base_height) = ProjectUniforms::get_base_size(&constants.options, &config);
    let display_size = ProjectUniforms::display_size(
        &constants.options,
        &config,
        cap_project::XY::new(base_width, base_height),
    )
    .coord;
    let crop = ProjectUniforms::get_crop(&constants.options, &config);
    let export_scale = f64::max(
        f64::max(
            crop.size.x as f64 / f64::max(display_size.x, 1.0),
            crop.size.y as f64 / f64::max(display_size.y, 1.0),
        ),
        1.0,
    );

    let resolution_base = cap_project::XY::new(
        (((base_width as f64 * export_scale).ceil() as u32) + 3) & !3,
        (((base_height as f64 * export_scale).ceil() as u32) + 1) & !1,
    );

    if resolution_base.x > MAX_DIMENSION || resolution_base.y > MAX_DIMENSION {
        return Err(format!(
            "Export dimensions exceed maximum: {}x{}",
            resolution_base.x, resolution_base.y
        ));
    }

    let mut frame_renderer = FrameRenderer::new(&constants);
    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );
    let decoded_frame = DecodedFrame::new(data, width, height);
    let segment_frames = DecodedSegmentFrames {
        screen_frame: Some(DecodedFrame::new(
            decoded_frame.data().to_vec(),
            decoded_frame.width(),
            decoded_frame.height(),
        )),
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };
    let cursor_events = cap_project::CursorEvents::default();
    let mut zoom_timeline = ZoomTransformTimeline::from_project(
        &config,
        &cursor_events,
        0.0,
        constants.options.screen_size,
    );
    zoom_timeline.ensure_precomputed_until(1.0 / 30.0);
    let uniforms = ProjectUniforms::new(
        &constants,
        &config,
        0,
        30,
        resolution_base,
        &cursor_events,
        &segment_frames,
        0.0,
        &zoom_timeline,
    );
    let rendered_frame = frame_renderer
        .render_immediate(
            segment_frames,
            uniforms,
            &cap_project::CursorEvents::default(),
            true,
            &mut layers,
        )
        .await
        .map_err(|e| format!("Failed to render screenshot export: {e}"))?;

    let width_usize =
        usize::try_from(rendered_frame.width).map_err(|_| "Invalid export width".to_string())?;
    let height_usize =
        usize::try_from(rendered_frame.height).map_err(|_| "Invalid export height".to_string())?;
    let unpadded_bytes_per_row = width_usize
        .checked_mul(4)
        .ok_or_else(|| "Export row size overflow".to_string())?;
    let padded_bytes_per_row = usize::try_from(rendered_frame.padded_bytes_per_row)
        .map_err(|_| "Invalid export stride".to_string())?;

    if padded_bytes_per_row < unpadded_bytes_per_row {
        return Err(format!(
            "Invalid export stride: {} for {}x{} image",
            rendered_frame.padded_bytes_per_row, rendered_frame.width, rendered_frame.height
        ));
    }

    let expected_padded_len = padded_bytes_per_row
        .checked_mul(height_usize)
        .ok_or_else(|| "Export buffer size overflow".to_string())?;
    if rendered_frame.data.len() < expected_padded_len {
        return Err(format!(
            "Invalid export buffer length: expected at least {} got {} for {}x{} image",
            expected_padded_len,
            rendered_frame.data.len(),
            rendered_frame.width,
            rendered_frame.height
        ));
    }

    let rgba_data: Vec<u8> = rendered_frame
        .data
        .chunks(padded_bytes_per_row)
        .take(height_usize)
        .flat_map(|row| row[..unpadded_bytes_per_row].iter().copied())
        .collect();

    let mut png_data = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut png_data);
    encoder
        .write_image(
            &rgba_data,
            rendered_frame.width,
            rendered_frame.height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Failed to encode screenshot export: {e}"))?;

    Ok(png_data.into_inner())
}
