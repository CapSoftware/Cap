mod swscale;
pub use swscale::*;

mod pool;
pub use pool::*;

#[cfg(target_os = "macos")]
mod videotoolbox;
#[cfg(target_os = "macos")]
pub use videotoolbox::*;

#[cfg(target_os = "windows")]
mod d3d11;
#[cfg(target_os = "windows")]
pub use d3d11::*;

use std::sync::Arc;

#[derive(Debug, Clone, thiserror::Error)]
pub enum ConvertError {
    #[error("Conversion failed: {0}")]
    ConversionFailed(String),
    #[error("Unsupported format: {0:?} -> {1:?}")]
    UnsupportedFormat(ffmpeg::format::Pixel, ffmpeg::format::Pixel),
    #[error("Hardware unavailable: {0}")]
    HardwareUnavailable(String),
    #[error("Channel closed")]
    ChannelClosed,
    #[error("Pool shutdown")]
    PoolShutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConverterBackend {
    #[cfg(target_os = "macos")]
    VideoToolbox,
    #[cfg(target_os = "windows")]
    D3D11,
    Swscale,
    Passthrough,
}

impl std::fmt::Display for ConverterBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(target_os = "macos")]
            ConverterBackend::VideoToolbox => write!(f, "VideoToolbox (hardware)"),
            #[cfg(target_os = "windows")]
            ConverterBackend::D3D11 => write!(f, "D3D11 (GPU)"),
            ConverterBackend::Swscale => write!(f, "swscale (CPU)"),
            ConverterBackend::Passthrough => write!(f, "passthrough"),
        }
    }
}

pub trait FrameConverter: Send + Sync + 'static {
    fn convert(&self, input: ffmpeg::frame::Video) -> Result<ffmpeg::frame::Video, ConvertError>;

    fn name(&self) -> &'static str;

    fn backend(&self) -> ConverterBackend;

    fn is_hardware_accelerated(&self) -> bool {
        match self.backend() {
            #[cfg(target_os = "macos")]
            ConverterBackend::VideoToolbox => true,
            #[cfg(target_os = "windows")]
            ConverterBackend::D3D11 => true,
            ConverterBackend::Swscale => false,
            ConverterBackend::Passthrough => false,
        }
    }

    fn conversion_count(&self) -> u64 {
        0
    }

    fn verify_hardware_usage(&self) -> Option<bool> {
        None
    }
}

#[derive(Clone)]
pub struct ConversionConfig {
    pub input_format: ffmpeg::format::Pixel,
    pub input_width: u32,
    pub input_height: u32,
    pub output_format: ffmpeg::format::Pixel,
    pub output_width: u32,
    pub output_height: u32,
}

impl ConversionConfig {
    pub fn new(
        input_format: ffmpeg::format::Pixel,
        input_width: u32,
        input_height: u32,
        output_format: ffmpeg::format::Pixel,
        output_width: u32,
        output_height: u32,
    ) -> Self {
        Self {
            input_format,
            input_width,
            input_height,
            output_format,
            output_width,
            output_height,
        }
    }

    pub fn needs_conversion(&self) -> bool {
        self.input_format != self.output_format
            || self.input_width != self.output_width
            || self.input_height != self.output_height
    }

    pub fn needs_scaling(&self) -> bool {
        self.input_width != self.output_width || self.input_height != self.output_height
    }
}

pub struct ConverterSelectionResult {
    pub converter: Arc<dyn FrameConverter>,
    pub backend: ConverterBackend,
    pub fallback_reason: Option<String>,
}

impl ConverterSelectionResult {
    pub fn log_selection(&self) {
        if let Some(reason) = &self.fallback_reason {
            tracing::warn!("Using {} converter (fallback: {})", self.backend, reason);
        } else {
            tracing::info!("Using {} converter", self.backend);
        }
    }
}

pub fn create_converter(config: ConversionConfig) -> Result<Arc<dyn FrameConverter>, ConvertError> {
    let result = create_converter_with_details(config)?;
    result.log_selection();
    Ok(result.converter)
}

pub fn create_converter_with_details(
    config: ConversionConfig,
) -> Result<ConverterSelectionResult, ConvertError> {
    if !config.needs_conversion() {
        tracing::info!(
            "No conversion needed ({:?} {}x{} -> {:?} {}x{}), using passthrough",
            config.input_format,
            config.input_width,
            config.input_height,
            config.output_format,
            config.output_width,
            config.output_height
        );
        return Ok(ConverterSelectionResult {
            converter: Arc::new(PassthroughConverter),
            backend: ConverterBackend::Passthrough,
            fallback_reason: None,
        });
    }

    tracing::info!(
        "Creating converter: {:?} {}x{} -> {:?} {}x{}",
        config.input_format,
        config.input_width,
        config.input_height,
        config.output_format,
        config.output_width,
        config.output_height
    );

    let mut fallback_reasons: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        match VideoToolboxConverter::new(config.clone()) {
            Ok(converter) => {
                tracing::info!(
                    "✓ Created VideoToolbox converter - hardware accelerated pixel transfer"
                );
                return Ok(ConverterSelectionResult {
                    converter: Arc::new(converter),
                    backend: ConverterBackend::VideoToolbox,
                    fallback_reason: None,
                });
            }
            Err(e) => {
                let reason = format!("VideoToolbox: {}", e);
                tracing::debug!("{}", reason);
                fallback_reasons.push(reason);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        match D3D11Converter::new(config.clone()) {
            Ok(converter) => {
                let gpu_info = converter.gpu_info();
                tracing::info!(
                    "✓ Created D3D11 hardware converter - GPU: {} ({})",
                    gpu_info.description,
                    gpu_info.vendor_name()
                );
                return Ok(ConverterSelectionResult {
                    converter: Arc::new(converter),
                    backend: ConverterBackend::D3D11,
                    fallback_reason: None,
                });
            }
            Err(e) => {
                let reason = format!("D3D11: {}", e);
                tracing::debug!("{}", reason);
                fallback_reasons.push(reason);
            }
        }
    }

    let converter = SwscaleConverter::new(config.clone())?;

    let fallback_reason = if fallback_reasons.is_empty() {
        None
    } else {
        Some(fallback_reasons.join("; "))
    };

    tracing::info!("✓ Created swscale software converter (CPU-based, SIMD optimized)");

    Ok(ConverterSelectionResult {
        converter: Arc::new(converter),
        backend: ConverterBackend::Swscale,
        fallback_reason,
    })
}

struct PassthroughConverter;

impl FrameConverter for PassthroughConverter {
    fn convert(&self, input: ffmpeg::frame::Video) -> Result<ffmpeg::frame::Video, ConvertError> {
        Ok(input)
    }

    fn name(&self) -> &'static str {
        "passthrough"
    }

    fn backend(&self) -> ConverterBackend {
        ConverterBackend::Passthrough
    }
}
