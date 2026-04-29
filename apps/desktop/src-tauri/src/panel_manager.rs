#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use tokio::sync::RwLock;
#[cfg(target_os = "macos")]
use tracing::{debug, info, trace, warn};

#[cfg(target_os = "macos")]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum PanelState {
    #[default]
    None,
    Creating,
    Ready,
    Destroying,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanelWindowType {
    Camera,
}

#[cfg(target_os = "macos")]
impl std::fmt::Display for PanelWindowType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Camera => write!(f, "Camera"),
        }
    }
}

#[cfg(target_os = "macos")]
struct PanelEntry {
    state: PanelState,
    operation_id: u64,
}

#[cfg(target_os = "macos")]
impl Default for PanelEntry {
    fn default() -> Self {
        Self {
            state: PanelState::None,
            operation_id: 0,
        }
    }
}

#[cfg(target_os = "macos")]
pub struct PanelManager {
    panels: RwLock<HashMap<PanelWindowType, PanelEntry>>,
    operation_counter: std::sync::atomic::AtomicU64,
}

#[cfg(target_os = "macos")]
impl Default for PanelManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
impl PanelManager {
    pub fn new() -> Self {
        Self {
            panels: RwLock::new(HashMap::new()),
            operation_counter: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub async fn get_state(&self, window_type: PanelWindowType) -> PanelState {
        let panels = self.panels.read().await;
        panels
            .get(&window_type)
            .map(|e| e.state)
            .unwrap_or(PanelState::None)
    }

    pub async fn try_begin_create(
        &self,
        window_type: PanelWindowType,
    ) -> Option<PanelOperationGuard> {
        let mut panels = self.panels.write().await;
        let entry = panels.entry(window_type).or_default();

        match entry.state {
            PanelState::None => {
                let op_id = self
                    .operation_counter
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                entry.state = PanelState::Creating;
                entry.operation_id = op_id;
                debug!(
                    "Panel {}: beginning create operation (op_id={})",
                    window_type, op_id
                );
                Some(PanelOperationGuard {
                    operation_id: op_id,
                    completed: false,
                })
            }
            PanelState::Creating => {
                debug!(
                    "Panel {}: create blocked - already creating (op_id={})",
                    window_type, entry.operation_id
                );
                None
            }
            PanelState::Ready => {
                debug!(
                    "Panel {}: create blocked - already ready (op_id={})",
                    window_type, entry.operation_id
                );
                None
            }
            PanelState::Destroying => {
                debug!(
                    "Panel {}: create blocked - currently destroying (op_id={})",
                    window_type, entry.operation_id
                );
                None
            }
        }
    }

    pub async fn mark_ready(&self, window_type: PanelWindowType, operation_id: u64) {
        let mut panels = self.panels.write().await;
        if let Some(entry) = panels.get_mut(&window_type) {
            if entry.operation_id == operation_id && entry.state == PanelState::Creating {
                entry.state = PanelState::Ready;
                info!(
                    "Panel {}: marked ready (op_id={})",
                    window_type, operation_id
                );
            } else {
                warn!(
                    "Panel {}: mark_ready ignored - state mismatch (current state={:?}, current op={}, requested op={})",
                    window_type, entry.state, entry.operation_id, operation_id
                );
            }
        }
    }

    pub async fn force_reset(&self, window_type: PanelWindowType) {
        let mut panels = self.panels.write().await;
        if let Some(entry) = panels.get_mut(&window_type) {
            warn!(
                "Panel {}: force reset from state {:?} (op_id={})",
                window_type, entry.state, entry.operation_id
            );
            entry.state = PanelState::None;
            entry.operation_id = 0;
        }
    }

    pub async fn wait_for_state(
        &self,
        window_type: PanelWindowType,
        target_states: &[PanelState],
        timeout: std::time::Duration,
    ) -> bool {
        let start = std::time::Instant::now();
        let poll_interval = std::time::Duration::from_millis(10);

        while start.elapsed() < timeout {
            let state = self.get_state(window_type).await;
            if target_states.contains(&state) {
                return true;
            }
            tokio::time::sleep(poll_interval).await;
        }

        let state = self.get_state(window_type).await;
        warn!(
            "Panel {}: wait_for_state timed out after {:?}, current state={:?}, wanted one of {:?}",
            window_type, timeout, state, target_states
        );
        false
    }
}

#[cfg(target_os = "macos")]
pub struct PanelOperationGuard {
    pub operation_id: u64,
    completed: bool,
}

#[cfg(target_os = "macos")]
impl PanelOperationGuard {
    pub fn mark_completed(&mut self) {
        self.completed = true;
    }
}

#[cfg(target_os = "macos")]
pub fn is_window_handle_valid(window: &tauri::WebviewWindow) -> bool {
    match window.inner_size() {
        Ok(_) => true,
        Err(e) => {
            trace!("Window handle validation failed: {}", e);
            false
        }
    }
}

#[cfg(target_os = "macos")]
pub type NSPanel = tauri_nspanel::objc_id::Id<
    tauri_nspanel::raw_nspanel::RawNSPanel,
    tauri_nspanel::objc_id::Shared,
>;

#[cfg(target_os = "macos")]
pub fn try_to_panel(window: &tauri::WebviewWindow) -> Result<NSPanel, PanelConversionError> {
    use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;

    if !is_window_handle_valid(window) {
        return Err(PanelConversionError::InvalidHandle);
    }

    window
        .to_panel()
        .map_err(|e| PanelConversionError::ConversionFailed(format!("{:?}", e)))
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
pub enum PanelConversionError {
    InvalidHandle,
    ConversionFailed(String),
}

#[cfg(target_os = "macos")]
impl std::fmt::Display for PanelConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidHandle => write!(f, "Window handle is invalid or unavailable"),
            Self::ConversionFailed(msg) => write!(f, "Panel conversion failed: {}", msg),
        }
    }
}

#[cfg(target_os = "macos")]
impl std::error::Error for PanelConversionError {}
