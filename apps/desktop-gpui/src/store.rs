//! Tiny persisted state for this app.
//!
//! The Tauri app keeps the camera window's chrome state in the webview's
//! `localStorage` (`cameraWindowState`); there is no webview here, so the same
//! shape lives in a JSON file next to the Tauri store (`gpui-state.json` inside
//! `so.cap.desktop`'s app-data dir). Reads happen once at open; writes are
//! whole-file rewrites on a background thread -- the state is a handful of
//! scalars, atomicity beyond rename is not worth plumbing.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// `CameraPreviewShape` in the web app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CameraShape {
    #[default]
    Round,
    Square,
    Full,
}

/// `BackgroundBlurMode`. Cycled and persisted for parity; the effects pipeline
/// itself is not wired yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlurMode {
    #[default]
    Off,
    Light,
    Heavy,
}

impl BlurMode {
    pub fn cycle(self) -> Self {
        match self {
            Self::Off => Self::Light,
            Self::Light => Self::Heavy,
            Self::Heavy => Self::Off,
        }
    }

    /// The tiny label under the person glyph: `Light` / `Heavy`, nothing when
    /// off.
    pub fn label(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Light => Some("Light"),
            Self::Heavy => Some("Heavy"),
        }
    }
}

/// `CameraWindowState` from `CameraPreviewChrome.tsx`, minus `mirrored` (no
/// flip transform exists in this gpui rev; see README).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CameraWindowState {
    pub size: f32,
    pub shape: CameraShape,
    pub mirrored: bool,
    pub background_blur: BlurMode,
}

impl Default for CameraWindowState {
    fn default() -> Self {
        Self {
            size: crate::camera_window::CAMERA_DEFAULT_SIZE,
            shape: CameraShape::Round,
            mirrored: false,
            background_blur: BlurMode::Off,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedState {
    pub camera_window: Option<CameraWindowState>,
}

fn state_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join("Library/Application Support/so.cap.desktop/gpui-state.json")
}

pub fn load() -> PersistedState {
    std::fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Read-modify-write on the caller's thread; callers hand this to the
/// background executor.
pub fn update(mutate: impl FnOnce(&mut PersistedState)) {
    let path = state_path();
    let mut state = load();
    mutate(&mut state);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_vec_pretty(&state) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(&path, bytes) {
                tracing::warn!("persisting gpui state: {error}");
            }
        }
        Err(error) => tracing::warn!("serializing gpui state: {error}"),
    }
}
