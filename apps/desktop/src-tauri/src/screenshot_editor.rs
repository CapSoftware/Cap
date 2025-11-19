use crate::frame_ws::{WSFrame, create_frame_ws};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, Resolution, SingleSegment,
    StudioRecordingMeta, VideoMeta,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderSession,
    RenderVideoConstants, RenderedFrame, RendererLayers,
};
use image::GenericImageView;
use relative_path::RelativePathBuf;
use serde::Serialize;
use specta::Type;
use std::{collections::HashMap, ops::Deref, path::PathBuf, sync::Arc};
use tauri::{AppHandle, Manager, Runtime, Window, ipc::CommandArg};
use tokio::sync::{RwLock, watch};
use tokio_util::sync::CancellationToken;

pub struct ScreenshotEditorInstance {
    pub ws_port: u16,
    pub ws_shutdown_token: CancellationToken,
    pub config_tx: watch::Sender<ProjectConfiguration>,
    pub path: PathBuf,
}

impl ScreenshotEditorInstance {
    pub async fn dispose(&self) {
        self.ws_shutdown_token.cancel();
    }
}

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
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let window = Window::from_command(command)?;

        let instances = window.state::<ScreenshotEditorInstances>();
        let instance = futures::executor::block_on(instances.0.read());

        Ok(Self(instance.get(window.label()).cloned().unwrap()))
    }
}

impl ScreenshotEditorInstances {
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
                let (frame_tx, frame_rx) = flume::bounded(4);
                let (ws_port, ws_shutdown_token) = create_frame_ws(frame_rx).await;

                // Load image
                let img = image::open(&path).map_err(|e| format!("Failed to open image: {e}"))?;
                let (width, height) = img.dimensions();
                let img_rgba = img.to_rgba8();
                let data = img_rgba.into_raw();

                // Create dummy meta
                let relative_path = RelativePathBuf::from_path(&path).unwrap();
                let video_meta = VideoMeta {
                    path: relative_path.clone(),
                    fps: 30,
                    start_time: Some(0.0),
                };
                let segment = SingleSegment {
                    display: video_meta.clone(),
                    camera: None,
                    audio: None,
                    cursor: None,
                };
                let studio_meta = StudioRecordingMeta::SingleSegment { segment };
                let recording_meta = RecordingMeta {
                    platform: None,
                    project_path: path.parent().unwrap().to_path_buf(),
                    pretty_name: "Screenshot".to_string(),
                    sharing: None,
                    inner: RecordingMetaInner::Studio(studio_meta.clone()),
                    upload: None,
                };

                let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
                let adapter = instance
                    .request_adapter(&wgpu::RequestAdapterOptions {
                        power_preference: wgpu::PowerPreference::HighPerformance,
                        force_fallback_adapter: false,
                        compatible_surface: None,
                    })
                    .await
                    .map_err(|_| "No GPU adapter found".to_string())?;

                let (device, queue) = adapter
                    .request_device(&wgpu::DeviceDescriptor {
                        label: Some("cap-rendering-device"),
                        required_features: wgpu::Features::empty(),
                        ..Default::default()
                    })
                    .await
                    .map_err(|e| e.to_string())?;

                let options = cap_rendering::RenderOptions {
                    screen_size: cap_project::XY::new(width, height),
                    camera_size: None,
                };

                let constants = RenderVideoConstants {
                    _instance: instance,
                    _adapter: adapter,
                    queue,
                    device,
                    options,
                    meta: studio_meta,
                    recording_meta: recording_meta.clone(),
                    background_textures: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
                };

                let (config_tx, mut config_rx) = watch::channel(ProjectConfiguration::default());

                let instance = Arc::new(ScreenshotEditorInstance {
                    ws_port,
                    ws_shutdown_token,
                    config_tx,
                    path: path.clone(),
                });

                // Spawn render loop
                let frame_tx = frame_tx.clone();
                let decoded_frame = DecodedFrame::new(data, width, height);

                tokio::spawn(async move {
                    let mut frame_renderer = FrameRenderer::new(&constants);
                    let mut layers = RendererLayers::new(&constants.device, &constants.queue);

                    // Initial render
                    let mut current_config = config_rx.borrow().clone();

                    loop {
                        // Wait for config change
                        if config_rx.changed().await.is_err() {
                            break;
                        }
                        current_config = config_rx.borrow().clone();

                        let segment_frames = DecodedSegmentFrames {
                            screen_frame: DecodedFrame::new(
                                decoded_frame.data().to_vec(),
                                decoded_frame.width(),
                                decoded_frame.height(),
                            ),
                            camera_frame: None,
                            segment_time: 0.0,
                            recording_time: 0.0,
                        };

                        let uniforms = ProjectUniforms::new(
                            &constants,
                            &current_config,
                            0,
                            30,
                            cap_project::XY::new(width, height),
                            &cap_project::CursorEvents::default(),
                            &segment_frames,
                        );

                        let rendered_frame = frame_renderer
                            .render(
                                segment_frames,
                                uniforms,
                                &cap_project::CursorEvents::default(),
                                &mut layers,
                            )
                            .await;

                        match rendered_frame {
                            Ok(frame) => {
                                let _ = frame_tx.send(WSFrame {
                                    data: frame.data,
                                    width: frame.width,
                                    height: frame.height,
                                    stride: frame.padded_bytes_per_row,
                                });
                            }
                            Err(e) => {
                                eprintln!("Failed to render frame: {e}");
                            }
                        }
                    }
                });

                entry.insert(instance.clone());
                Ok(instance)
            }
            Entry::Occupied(entry) => Ok(entry.get().clone()),
        }
    }
}

#[derive(Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SerializedScreenshotEditorInstance {
    pub frames_socket_url: String,
    pub path: PathBuf,
}

#[tauri::command]
#[specta::specta]
pub async fn create_screenshot_editor_instance(
    window: Window,
    path: PathBuf,
) -> Result<SerializedScreenshotEditorInstance, String> {
    let instance = ScreenshotEditorInstances::get_or_create(&window, path).await?;

    Ok(SerializedScreenshotEditorInstance {
        frames_socket_url: format!("ws://localhost:{}", instance.ws_port),
        path: instance.path.clone(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn update_screenshot_config(
    instance: WindowScreenshotEditorInstance,
    config: ProjectConfiguration,
) -> Result<(), String> {
    let _ = instance.config_tx.send(config);
    Ok(())
}
