use std::{collections::HashMap, ops::Deref, path::PathBuf, sync::Arc, time::Instant};
use tauri::{AppHandle, Manager, Runtime, Window, ipc::CommandArg};
use tokio::sync::{RwLock, watch};
use tokio_util::sync::CancellationToken;
use tracing::debug;

use cap_rendering::RenderedFrame;

use crate::{
    create_editor_instance_impl,
    frame_ws::{WSFrame, create_watch_frame_ws},
};

fn strip_frame_padding(frame: RenderedFrame) -> Result<(Vec<u8>, u32), &'static str> {
    let expected_stride = frame
        .width
        .checked_mul(4)
        .ok_or("overflow computing expected_stride")?;
    if frame.padded_bytes_per_row == expected_stride {
        Ok((frame.data, expected_stride))
    } else {
        let capacity = expected_stride
            .checked_mul(frame.height)
            .ok_or("overflow computing buffer capacity")?;
        let mut stripped = Vec::with_capacity(capacity as usize);
        for row in 0..frame.height {
            let start = row
                .checked_mul(frame.padded_bytes_per_row)
                .ok_or("overflow computing row start")? as usize;
            let end = start + expected_stride as usize;
            stripped.extend_from_slice(&frame.data[start..end]);
        }
        Ok((stripped, expected_stride))
    }
}

pub struct EditorInstance {
    inner: Arc<cap_editor::EditorInstance>,
    pub ws_port: u16,
    pub ws_shutdown_token: CancellationToken,
}

type PendingResult = Result<Arc<EditorInstance>, String>;
type PendingReceiver = tokio::sync::watch::Receiver<Option<PendingResult>>;

#[derive(Clone, Default)]
pub struct PendingEditorInstances(Arc<RwLock<HashMap<String, PendingReceiver>>>);

async fn do_prewarm(app: AppHandle, path: PathBuf) -> PendingResult {
    let (frame_tx, frame_rx) = watch::channel(None);

    let (ws_port, ws_shutdown_token) = create_watch_frame_ws(frame_rx).await;
    let inner = create_editor_instance_impl(
        &app,
        path,
        Box::new(move |frame| {
            let width = frame.width;
            let height = frame.height;
            if let Ok((data, stride)) = strip_frame_padding(frame)
                && let Err(e) = frame_tx.send(Some(WSFrame {
                    data,
                    width,
                    height,
                    stride,
                    created_at: Instant::now(),
                }))
            {
                debug!("Frame receiver dropped during prewarm: {e}");
            }
        }),
    )
    .await?;

    Ok(Arc::new(EditorInstance {
        inner,
        ws_port,
        ws_shutdown_token,
    }))
}

impl PendingEditorInstances {
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

        let (tx, rx) = tokio::sync::watch::channel(None);

        {
            let mut instances = pending.0.write().await;
            instances.insert(window_label.clone(), rx);
        }

        tokio::spawn(async move {
            let result = do_prewarm(app, path).await;
            tx.send(Some(result)).ok();
        });
    }

    pub async fn take_prewarmed(&self, window_label: &str) -> Option<PendingReceiver> {
        let mut instances = self.0.write().await;
        instances.remove(window_label)
    }
}

impl EditorInstance {
    pub async fn dispose(&self) {
        self.inner.dispose().await;

        self.ws_shutdown_token.cancel();
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

        let instances = window.state::<EditorInstances>();
        let instance = futures::executor::block_on(instances.0.read());

        Ok(Self(instance.get(window.label()).cloned().unwrap()))
    }
}

impl EditorInstances {
    pub async fn get_or_create(
        window: &Window,
        path: PathBuf,
    ) -> Result<Arc<EditorInstance>, String> {
        let instances = match window.try_state::<EditorInstances>() {
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
                let pending = PendingEditorInstances::get(window.app_handle());

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

                let (frame_tx, frame_rx) = watch::channel(None);

                let (ws_port, ws_shutdown_token) = create_watch_frame_ws(frame_rx).await;
                let instance = create_editor_instance_impl(
                    window.app_handle(),
                    path,
                    Box::new(move |frame| {
                        let width = frame.width;
                        let height = frame.height;
                        if let Ok((data, stride)) = strip_frame_padding(frame)
                            && let Err(e) = frame_tx.send(Some(WSFrame {
                                data,
                                width,
                                height,
                                stride,
                                created_at: Instant::now(),
                            }))
                        {
                            debug!("Frame receiver dropped in get_or_create: {e}");
                        }
                    }),
                )
                .await?;

                let instance = Arc::new(EditorInstance {
                    inner: instance.clone(),
                    ws_port,
                    ws_shutdown_token,
                });

                entry.insert(instance.clone());

                Ok(instance)
            }
            Entry::Occupied(entry) => Ok(entry.get().clone()),
        }
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
}
