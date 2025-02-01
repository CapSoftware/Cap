use std::{
    collections::HashMap,
    ops::Deref,
    sync::{Arc, RwLock},
};

use cap_editor::EditorInstance;
use tauri::{ipc::CommandArg, Manager, Runtime, Window};

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
        let instance = instances.0.read().unwrap();

        Ok(Self(instance.get(window.label()).cloned().unwrap()))
    }
}

impl EditorInstances {
    pub fn add(window: &Window, instance: Arc<EditorInstance>) {
        let instances = match window.try_state::<EditorInstances>() {
            Some(s) => (*s).clone(),
            None => {
                let instances = Self(Arc::new(RwLock::new(HashMap::new())));
                window.manage(instances.clone());
                instances
            }
        };

        let mut instances = instances.0.write().unwrap();

        instances.insert(window.label().to_string(), instance);
    }

    pub fn remove(window: &Window) {
        let Some(instances) = window.try_state::<EditorInstances>() else {
            return;
        };

        instances.0.write().unwrap().remove(window.label());
    }
}
