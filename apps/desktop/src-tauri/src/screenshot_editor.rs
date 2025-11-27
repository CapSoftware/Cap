use crate::frame_ws::{WSFrame, create_watch_frame_ws};
use crate::windows::{CapWindowId, ScreenshotEditorWindowIds};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, SingleSegment, StudioRecordingMeta,
    VideoMeta,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderVideoConstants,
    RendererLayers,
};
use image::GenericImageView;
use relative_path::RelativePathBuf;
use serde::Serialize;
use specta::Type;
use std::str::FromStr;
use std::{collections::HashMap, ops::Deref, path::PathBuf, sync::Arc};
use tauri::{Manager, Runtime, Window, ipc::CommandArg};
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

        if let Some(instance) = instance.get(window.label()).cloned() {
            Ok(Self(instance))
        } else {
            Err(tauri::InvokeError::from(format!(
                "no ScreenshotEditor instance for window '{}'",
                window.label(),
            )))
        }
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
                let (frame_tx, frame_rx) = watch::channel(None);
                let (ws_port, ws_shutdown_token) = create_watch_frame_ws(frame_rx).await;

                // Load image
                let img = image::open(&path).map_err(|e| format!("Failed to open image: {e}"))?;
                let (width, height) = img.dimensions();
                let img_rgba = img.to_rgba8();
                let data = img_rgba.into_raw();

                // Try to load existing meta if in a .cap directory
                let (recording_meta, loaded_config) = if let Some(parent) = path.parent() {
                    if parent.extension().and_then(|s| s.to_str()) == Some("cap") {
                        let meta = RecordingMeta::load_for_project(parent).ok();
                        let config = ProjectConfiguration::load(parent).ok();
                        (meta, config)
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

                let recording_meta = if let Some(meta) = recording_meta {
                    meta
                } else {
                    // Create dummy meta
                    let filename = path
                        .file_name()
                        .ok_or_else(|| "Invalid path".to_string())?
                        .to_string_lossy();
                    let relative_path = RelativePathBuf::from(filename.as_ref());
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
                    RecordingMeta {
                        platform: None,
                        project_path: path.parent().unwrap().to_path_buf(),
                        pretty_name: "Screenshot".to_string(),
                        sharing: None,
                        inner: RecordingMetaInner::Studio(studio_meta.clone()),
                        upload: None,
                    }
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

                // We need to extract the studio meta from the recording meta
                let studio_meta = match &recording_meta.inner {
                    RecordingMetaInner::Studio(meta) => meta.clone(),
                    _ => return Err("Invalid recording meta for screenshot".to_string()),
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

                let (config_tx, mut config_rx) = watch::channel(loaded_config.unwrap_or_default());

                let render_shutdown_token = ws_shutdown_token.clone();

                let instance = Arc::new(ScreenshotEditorInstance {
                    ws_port,
                    ws_shutdown_token,
                    config_tx,
                    path: path.clone(),
                });

                // Spawn render loop
                let decoded_frame = DecodedFrame::new(data, width, height);

                tokio::spawn(async move {
                    let mut frame_renderer = FrameRenderer::new(&constants);
                    let mut layers = RendererLayers::new(&constants.device, &constants.queue);

                    // Initial render
                    let mut current_config = config_rx.borrow().clone();

                    loop {
                        if render_shutdown_token.is_cancelled() {
                            let _ = frame_tx.send(None);
                            break;
                        }
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

                        let (base_w, base_h) =
                            ProjectUniforms::get_base_size(&constants.options, &current_config);

                        let uniforms = ProjectUniforms::new(
                            &constants,
                            &current_config,
                            0,
                            30,
                            cap_project::XY::new(base_w, base_h),
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
                                let _ = frame_tx.send(Some(WSFrame {
                                    data: frame.data,
                                    width: frame.width,
                                    height: frame.height,
                                    stride: frame.padded_bytes_per_row,
                                }));
                            }
                            Err(e) => {
                                eprintln!("Failed to render frame: {e}");
                            }
                        }

                        tokio::select! {
                            res = config_rx.changed() => {
                                if res.is_err() {
                                    let _ = frame_tx.send(None);
                                    break;
                                }
                                current_config = config_rx.borrow().clone();
                            }
                            _ = render_shutdown_token.cancelled() => {
                                let _ = frame_tx.send(None);
                                break;
                            }
                        }
                    }
                });

                entry.insert(instance.clone());
                Ok(instance)
            }
            Entry::Occupied(entry) => {
                let instance = entry.get().clone();
                // Force a re-render for the new client by sending the current config again
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
}

#[derive(Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SerializedScreenshotEditorInstance {
    pub frames_socket_url: String,
    pub path: PathBuf,
    pub config: Option<ProjectConfiguration>,
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
    let config = instance.config_tx.borrow().clone();

    Ok(SerializedScreenshotEditorInstance {
        frames_socket_url: format!("ws://localhost:{}", instance.ws_port),
        path: instance.path.clone(),
        config: Some(config),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn update_screenshot_config(
    instance: WindowScreenshotEditorInstance,
    config: ProjectConfiguration,
    save: bool,
) -> Result<(), String> {
    let _ = instance.config_tx.send(config.clone());

    if save {
        if let Some(parent) = instance.path.parent() {
            if parent.extension().and_then(|s| s.to_str()) == Some("cap") {
                let path = parent.to_path_buf();
                if let Err(e) = config.write(&path) {
                    eprintln!("Failed to save screenshot config: {}", e);
                } else {
                    println!("Saved screenshot config to {:?}", path);
                }
            } else {
                println!(
                    "Not saving config: parent {:?} is not a .cap directory",
                    parent
                );
            }
        }
    }
    Ok(())
}
