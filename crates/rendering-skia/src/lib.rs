use thiserror::Error;

pub mod context;
pub mod layers;

pub use context::SkiaRenderContext;
pub use layers::{BackgroundLayer, LayerStack};

#[derive(Error, Debug)]
pub enum SkiaRenderingError {
    #[error("Failed to create GPU context")]
    NoGpuContext,

    #[error("Failed to create surface: {0}")]
    SurfaceCreationFailed(String),

    #[error("Failed to read pixels from surface")]
    ReadPixelsFailed,

    #[error("Invalid dimensions: {0}")]
    InvalidDimensions(String),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = SkiaRenderingError::NoGpuContext;
        assert_eq!(err.to_string(), "Failed to create GPU context");
    }
}
