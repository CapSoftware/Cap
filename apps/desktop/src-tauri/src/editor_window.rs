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
    pub fn get(window: &Window) -> Option<Arc<EditorInstance>> {
        let instances = window.try_state::<EditorInstances>()?;

        let instances = instances.0.read().unwrap();

        instances.get(window.label()).cloned()
    }

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

/// New enum to represent supported export file types.
#[derive(Clone)]
pub enum ExportFileType {
    MP4,
    GIF,
}

/// New struct to hold export settings.
#[derive(Clone)]
pub struct ExportSettings {
    pub file_type: ExportFileType,
    pub fps: u32,
    pub high_quality: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            file_type: ExportFileType::MP4,
            fps: 30,            // default FPS for non-GIF exports
            high_quality: false, // default quality flag
        }
    }
}

/// Dummy function to render the export dialog UI.  
/// Replace the println! calls with your actual UI code.
pub fn render_export_dialog() {
    // File type dropdown (MP4 or GIF)
    println!("Select file type: [1] MP4  [2] GIF");

    // If the user selects GIF, display GIF-specific options.
    // (In your actual UI code, this would be conditionally rendered.)
    println!("GIF options:");
    println!("  - FPS (Enter desired FPS; default is 15 if left empty)");
    println!("  - High quality toggle (true/false)");
    
    // ... code to capture UI inputs and update state variables ...
}

/// Function called when the export button is clicked.  
/// It processes the export request based on the export settings.
pub fn handle_export_request(settings: ExportSettings) {
    match settings.file_type {
        ExportFileType::MP4 => {
            println!("Exporting as MP4 with {} fps.", settings.fps);
            // ... existing MP4 export logic ...
        }
        ExportFileType::GIF => {
            // Apply GIF-specific defaults if needed. For example, if the FPS is not set or is zero:
            let fps = if settings.fps == 0 { 15 } else { settings.fps };
            println!(
                "Exporting as GIF at {} fps. High quality: {}",
                fps, settings.high_quality
            );
            // ... add GIF export processing logic here ...
        }
    }
}
