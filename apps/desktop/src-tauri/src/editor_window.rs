use std::{collections::HashMap, ops::Deref, path::PathBuf, sync::Arc};
use tauri::{Manager, Runtime, Window, ipc::CommandArg};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::{
    create_editor_instance_impl,
    frame_ws::{WSFrame, create_frame_ws},
};

pub struct EditorInstance {
    inner: Arc<cap_editor::EditorInstance>,
    pub ws_port: u16,
    pub ws_shutdown_token: CancellationToken,
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
                let (frame_tx, frame_rx) = flume::bounded(4);

                let (ws_port, ws_shutdown_token) = create_frame_ws(frame_rx).await;
                let instance = create_editor_instance_impl(
                    window.app_handle(),
                    path,
                    Box::new(move |frame| {
                        let _ = frame_tx.send(WSFrame {
                            data: frame.data,
                            width: frame.width,
                            height: frame.height,
                            stride: frame.padded_bytes_per_row,
                        });
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
