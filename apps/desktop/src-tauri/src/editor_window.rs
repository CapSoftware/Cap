use std::{
    collections::HashMap,
    ops::Deref,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Instant,
};
use tauri::{AppHandle, Listener, Manager, Runtime, Window, ipc::CommandArg};
use tokio::sync::{RwLock, watch};
use tokio_util::sync::CancellationToken;

use cap_rendering::GpuOutputFormat;
use tauri_specta::Event;

use crate::{
    FrameLayoutEvent, create_editor_instance_impl,
    frame_ws::{WSFrame, WSFrameFormat, create_watch_frame_ws},
    windows::{CapWindowId, EditorWindowIds},
};

/// Forwards rendered frames to the preview websocket and mirrors each frame's
/// display/camera placement to the webview so overlay hit-boxes always match
/// what was actually rendered.
fn make_frame_callback(
    app: AppHandle,
    frame_tx: watch::Sender<Option<Arc<WSFrame>>>,
) -> cap_editor::EditorFrameCallback {
    Box::new(move |output, layout| {
        let ws_frame = match output {
            cap_editor::EditorFrameOutput::Nv12(frame) => {
                let ws_format = match frame.format {
                    GpuOutputFormat::Nv12 => WSFrameFormat::Nv12 { full_range: false },
                    GpuOutputFormat::Rgba => WSFrameFormat::Rgba,
                };
                WSFrame {
                    data: Arc::new(frame.data.into_vec()),
                    width: frame.width,
                    height: frame.height,
                    stride: frame.y_stride,
                    frame_number: frame.frame_number,
                    target_time_ns: frame.target_time_ns,
                    format: ws_format,
                    created_at: Instant::now(),
                }
            }
            cap_editor::EditorFrameOutput::Rgba(frame) => WSFrame {
                data: frame.data,
                width: frame.width,
                height: frame.height,
                stride: frame.padded_bytes_per_row,
                frame_number: frame.frame_number,
                target_time_ns: frame.target_time_ns,
                format: WSFrameFormat::Rgba,
                created_at: Instant::now(),
            },
            // The Tauri editor transports frames over a websocket, so it never
            // requests the gpui-only zero-copy surface format.
            #[cfg(target_os = "macos")]
            cap_editor::EditorFrameOutput::Surface(_) => return,
        };
        let _ = frame_tx.send(Some(std::sync::Arc::new(ws_frame)));

        // Emitted unconditionally: a prewarmed instance renders before the
        // webview attaches its listener, so deduping here would leave a
        // fresh window without layout data until the next config change.
        let _ = FrameLayoutEvent::from(layout).emit(&app);
    })
}

pub struct EditorInstance {
    inner: Arc<cap_editor::EditorInstance>,
    pub ws_port: u16,
    pub ws_shutdown_token: CancellationToken,
    app_handle: AppHandle,
    render_frame_event_id: tauri::EventId,
}

type PendingResult = Result<Arc<EditorInstanceDelivery>, String>;
type PendingReceiver = tokio::sync::watch::Receiver<Option<PendingResult>>;

pub(crate) struct EditorInstanceDelivery {
    instance: Arc<EditorInstance>,
    cleanup_runtime: tokio::runtime::Handle,
    state: AtomicU8,
}

impl EditorInstanceDelivery {
    const PENDING: u8 = 0;
    const ADOPTED: u8 = 1;
    const RETIRED: u8 = 2;

    fn new(instance: Arc<EditorInstance>, cleanup_runtime: tokio::runtime::Handle) -> Arc<Self> {
        Arc::new(Self {
            instance,
            cleanup_runtime,
            state: AtomicU8::new(Self::PENDING),
        })
    }

    fn adopt_into(
        &self,
        instances: &mut HashMap<String, Arc<EditorInstance>>,
        window_label: &str,
    ) -> Result<Arc<EditorInstance>, String> {
        self.state
            .compare_exchange(
                Self::PENDING,
                Self::ADOPTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| "Editor instance delivery is no longer pending".to_string())?;
        let instance = self.instance.clone();
        let _ = instances.insert(window_label.to_string(), instance.clone());
        Ok(instance)
    }

    fn retire(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.state
            .compare_exchange(
                Self::PENDING,
                Self::RETIRED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .ok()?;
        let instance = self.instance.clone();
        Some(self.cleanup_runtime.spawn(async move {
            instance.dispose().await;
        }))
    }

    async fn dispose(&self) {
        if let Some(cleanup) = self.retire() {
            let _ = cleanup.await;
        }
    }
}

impl Drop for EditorInstanceDelivery {
    fn drop(&mut self) {
        drop(self.retire());
    }
}

#[derive(Clone, Default)]
pub struct PendingEditorInstances(Arc<RwLock<HashMap<String, PendingReceiver>>>);

async fn do_prewarm(app: AppHandle, path: PathBuf) -> Result<Arc<EditorInstance>, String> {
    let (frame_tx, frame_rx) = watch::channel(None);

    let (ws_port, ws_shutdown_token) = create_watch_frame_ws(frame_rx, Default::default()).await;
    let ws_guard = ws_shutdown_token.clone().drop_guard();
    let (inner, render_frame_event_id) =
        create_editor_instance_impl(&app, path, make_frame_callback(app.clone(), frame_tx)).await?;

    let instance = Arc::new(EditorInstance {
        inner,
        ws_port,
        ws_shutdown_token,
        app_handle: app,
        render_frame_event_id,
    });
    ws_guard.disarm();
    Ok(instance)
}

fn with_registered_editor<T>(
    window_ids: &EditorWindowIds,
    id: u32,
    action: impl FnOnce() -> T,
) -> Result<T, String> {
    let ids = window_ids.ids.lock().map_err(|error| error.to_string())?;
    if !ids.iter().any(|(_, registered_id)| *registered_id == id) {
        return Err("Editor window is no longer registered".to_string());
    }
    Ok(action())
}

impl PendingEditorInstances {
    pub fn get(app: &AppHandle) -> Self {
        match app.try_state::<Self>() {
            Some(s) => (*s).clone(),
            None => {
                let pending = Self::default();
                app.manage(pending);
                (*app.state::<Self>()).clone()
            }
        }
    }

    pub async fn start_prewarm(app: &AppHandle, window_label: String, path: PathBuf) {
        let Ok(CapWindowId::Editor { id }) = CapWindowId::from_str(&window_label) else {
            return;
        };
        let window_ids = EditorWindowIds::get(app);
        let pending = Self::get(app);
        let app = app.clone();
        let tx = {
            let mut instances = pending.0.write().await;
            let admitted = with_registered_editor(&window_ids, id, || {
                use std::collections::hash_map::Entry;
                match instances.entry(window_label) {
                    Entry::Vacant(entry) => {
                        let (tx, rx) = watch::channel(None);
                        entry.insert(rx);
                        Some(tx)
                    }
                    Entry::Occupied(_) => None,
                }
            });
            match admitted {
                Ok(Some(tx)) => tx,
                Ok(None) => return,
                Err(error) => {
                    tracing::debug!(%error, "Skipping prewarm for a retired editor");
                    return;
                }
            }
        };

        let cleanup_runtime = tokio::runtime::Handle::current();
        tokio::spawn(async move {
            let result = do_prewarm(app, path)
                .await
                .map(|instance| EditorInstanceDelivery::new(instance, cleanup_runtime));
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
                        "Timed out waiting for prewarmed editor instance to complete for cleanup"
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
                tracing::warn!("Timed out disposing pending editor instance during app exit");
            }
        }

        if count > 0 {
            tracing::info!(count, "Disposed pending editor instances during app exit");
        }
    }
}

impl EditorInstance {
    pub async fn dispose(&self) {
        self.inner.dispose().await;

        self.ws_shutdown_token.cancel();
        self.app_handle.unlisten(self.render_frame_event_id);
    }
}

impl Drop for EditorInstance {
    fn drop(&mut self) {
        self.ws_shutdown_token.cancel();
        self.app_handle.unlisten(self.render_frame_event_id);
    }
}

impl Deref for EditorInstance {
    type Target = Arc<cap_editor::EditorInstance>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

#[derive(Clone)]
pub struct EditorInstances(Arc<RwLock<HashMap<String, Arc<EditorInstance>>>>);

pub struct WindowEditorInstance(pub Arc<EditorInstance>);

impl specta::function::FunctionArg for WindowEditorInstance {
    fn to_datatype(_: &mut specta::TypeMap) -> Option<specta::DataType> {
        None
    }
}

impl Deref for WindowEditorInstance {
    type Target = Arc<EditorInstance>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<EditorInstance> for WindowEditorInstance {
    fn as_ref(&self) -> &EditorInstance {
        &self.0
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for WindowEditorInstance {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let window = Window::from_command(command)?;

        let Some(instances) = window.try_state::<EditorInstances>() else {
            return Err("editor instance registry unavailable".into());
        };

        // Avoid `futures::executor::block_on` on a tokio RwLock here. That can deadlock or
        // panic when the IPC handler runs from inside the tokio runtime (release builds hit
        // this path much more aggressively than dev builds and silently terminate the process).
        // `try_read` is sync and never blocks; if the lock is contended we surface a transient
        // error and let the frontend retry.
        let Ok(instance_guard) = instances.0.try_read() else {
            return Err("editor instance registry busy".into());
        };

        let Some(instance) = instance_guard.get(window.label()).cloned() else {
            return Err("editor instance unavailable".into());
        };

        Ok(Self(instance))
    }
}

pub struct OptionalWindowEditorInstance(pub Option<Arc<EditorInstance>>);

impl specta::function::FunctionArg for OptionalWindowEditorInstance {
    fn to_datatype(_: &mut specta::TypeMap) -> Option<specta::DataType> {
        None
    }
}

impl Deref for OptionalWindowEditorInstance {
    type Target = Option<Arc<EditorInstance>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for OptionalWindowEditorInstance {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let Ok(window) = Window::from_command(command) else {
            return Ok(Self(None));
        };

        let Some(instances) = window.try_state::<EditorInstances>() else {
            return Ok(Self(None));
        };

        match instances.0.try_read() {
            Ok(instance_guard) => Ok(Self(instance_guard.get(window.label()).cloned())),
            Err(_) => Ok(Self(None)),
        }
    }
}

impl EditorInstances {
    pub async fn get_or_create(
        window: &Window,
        path: PathBuf,
    ) -> Result<Arc<EditorInstance>, String> {
        let CapWindowId::Editor { id } =
            CapWindowId::from_str(window.label()).map_err(|error| error.to_string())?
        else {
            return Err("Invalid editor window".to_string());
        };
        let window_ids = EditorWindowIds::get(window.app_handle());
        with_registered_editor(&window_ids, id, || ())?;
        let instances = match window.try_state::<EditorInstances>() {
            Some(s) => (*s).clone(),
            None => {
                window.manage(Self(Arc::new(RwLock::new(HashMap::new()))));
                (*window.state::<Self>()).clone()
            }
        };
        let mut instances = instances.0.write().await;
        if let Some(instance) =
            with_registered_editor(&window_ids, id, || instances.get(window.label()).cloned())?
        {
            return Ok(instance);
        }

        let requested_at = Instant::now();
        let pending = PendingEditorInstances::get(window.app_handle());
        let mut prewarmed = None;
        if let Some(mut prewarmed_rx) = pending.take_prewarmed(window.label()).await {
            loop {
                let result = prewarmed_rx.borrow_and_update().clone();
                if let Some(result) = result {
                    prewarmed = Some(result?);
                    break;
                }
                if prewarmed_rx.changed().await.is_err() {
                    break;
                }
            }
            if prewarmed.is_none() {
                tracing::warn!(
                    "Editor open: prewarm channel closed without a result, building on demand"
                );
            }
        }
        let was_prewarmed = prewarmed.is_some();
        let instance = match prewarmed {
            Some(instance) => instance,
            None => {
                with_registered_editor(&window_ids, id, || ())?;
                let cleanup_runtime = tokio::runtime::Handle::current();
                let (frame_tx, frame_rx) = watch::channel(None);
                let (ws_port, ws_shutdown_token) =
                    create_watch_frame_ws(frame_rx, Default::default()).await;
                let ws_guard = ws_shutdown_token.clone().drop_guard();
                let app_handle = window.app_handle().clone();
                let (inner, render_frame_event_id) = create_editor_instance_impl(
                    window.app_handle(),
                    path.clone(),
                    make_frame_callback(app_handle.clone(), frame_tx),
                )
                .await?;
                let instance = Arc::new(EditorInstance {
                    inner,
                    ws_port,
                    ws_shutdown_token,
                    app_handle,
                    render_frame_event_id,
                });
                ws_guard.disarm();
                EditorInstanceDelivery::new(instance, cleanup_runtime)
            }
        };

        let published = with_registered_editor(&window_ids, id, || {
            instance.adopt_into(&mut instances, window.label())
        });
        drop(instances);
        let instance = match published {
            Ok(Ok(instance)) => instance,
            Ok(Err(error)) | Err(error) => {
                instance.dispose().await;
                return Err(error);
            }
        };
        if was_prewarmed {
            tracing::info!(
                wait_ms = requested_at.elapsed().as_millis() as u64,
                "Editor open: instance served from prewarm"
            );
        } else {
            tracing::info!(
                build_ms = requested_at.elapsed().as_millis() as u64,
                "Editor open: instance built on demand (no prewarm hit)"
            );
        }
        Ok(instance)
    }

    /// Project paths of every currently open editor. Used to avoid touching
    /// projects that are in use (e.g. when migrating recordings between
    /// storage folders).
    pub async fn open_project_paths(app: &AppHandle) -> Vec<PathBuf> {
        let Some(instances) = app.try_state::<EditorInstances>() else {
            return Vec::new();
        };

        let instances = instances.0.read().await;
        instances
            .values()
            .map(|instance| instance.project_path.clone())
            .collect()
    }

    pub async fn remove(window: Window) {
        let Some(instances) = window.try_state::<EditorInstances>() else {
            return;
        };

        let mut instances = instances.0.write().await;
        if let Some(instance) = instances.remove(window.label()) {
            instance.dispose().await;
        }
    }

    pub async fn dispose_all(app: &AppHandle) {
        let Some(instances) = app.try_state::<EditorInstances>() else {
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
            tracing::info!(count, "Disposed editor instances during app exit");
        }
    }
}
