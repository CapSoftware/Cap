#[cfg(target_os = "windows")]
mod windows_impl {
    use serde::Serialize;
    use specta::Type;

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct WindowsVersionInfo {
        pub major: u32,
        pub minor: u32,
        pub build: u32,
        pub display_name: String,
        pub meets_requirements: bool,
        pub is_windows_11: bool,
    }

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct GpuInfoDiag {
        pub vendor: String,
        pub description: String,
        pub dedicated_video_memory_mb: f64,
    }

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SystemDiagnostics {
        pub windows_version: Option<WindowsVersionInfo>,
        pub gpu_info: Option<GpuInfoDiag>,
        pub available_encoders: Vec<String>,
        pub graphics_capture_supported: bool,
        pub d3d11_video_processor_available: bool,
    }

    pub fn collect_diagnostics() -> SystemDiagnostics {
        let windows_version = get_windows_version_info();
        let gpu_info = get_gpu_info();
        let available_encoders = get_available_encoders();
        let graphics_capture_supported = check_graphics_capture_support();
        let d3d11_video_processor_available = check_d3d11_video_processor();

        tracing::info!("System Diagnostics:");
        if let Some(ref ver) = windows_version {
            tracing::info!("  Windows: {}", ver.display_name);
        }
        if let Some(ref gpu) = gpu_info {
            tracing::info!("  GPU: {} ({})", gpu.description, gpu.vendor);
        }
        tracing::info!("  Encoders: {:?}", available_encoders);
        tracing::info!("  Graphics Capture: {}", graphics_capture_supported);
        tracing::info!(
            "  D3D11 Video Processor: {}",
            d3d11_video_processor_available
        );

        SystemDiagnostics {
            windows_version,
            gpu_info,
            available_encoders,
            graphics_capture_supported,
            d3d11_video_processor_available,
        }
    }

    fn get_windows_version_info() -> Option<WindowsVersionInfo> {
        scap_direct3d::WindowsVersion::detect().map(|v| WindowsVersionInfo {
            major: v.major,
            minor: v.minor,
            build: v.build,
            display_name: v.display_name(),
            meets_requirements: v.meets_minimum_requirements(),
            is_windows_11: v.is_windows_11(),
        })
    }

    fn get_gpu_info() -> Option<GpuInfoDiag> {
        cap_frame_converter::detect_primary_gpu().map(|info| GpuInfoDiag {
            vendor: info.vendor_name().to_string(),
            description: info.description.clone(),
            dedicated_video_memory_mb: (info.dedicated_video_memory / (1024 * 1024)) as f64,
        })
    }

    fn get_available_encoders() -> Vec<String> {
        let candidates = [
            "h264_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_mf",
            "libx264",
            "hevc_nvenc",
            "hevc_qsv",
            "hevc_amf",
            "hevc_mf",
            "libx265",
        ];

        candidates
            .iter()
            .filter(|name| ffmpeg::encoder::find_by_name(name).is_some())
            .map(|s| s.to_string())
            .collect()
    }

    fn check_graphics_capture_support() -> bool {
        scap_direct3d::is_supported().unwrap_or(false)
    }

    fn check_d3d11_video_processor() -> bool {
        use cap_frame_converter::ConversionConfig;

        let test_config = ConversionConfig::new(
            ffmpeg::format::Pixel::BGRA,
            1920,
            1080,
            ffmpeg::format::Pixel::NV12,
            1920,
            1080,
        );

        cap_frame_converter::D3D11Converter::new(test_config).is_ok()
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use serde::Serialize;
    use specta::Type;

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct MacOSVersionInfo {
        pub display_name: String,
    }

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SystemDiagnostics {
        pub macos_version: Option<MacOSVersionInfo>,
        pub available_encoders: Vec<String>,
        pub screen_capture_supported: bool,
    }

    pub fn collect_diagnostics() -> SystemDiagnostics {
        let available_encoders = get_available_encoders();

        tracing::info!("System Diagnostics:");
        tracing::info!("  Encoders: {:?}", available_encoders);

        SystemDiagnostics {
            macos_version: None,
            available_encoders,
            screen_capture_supported: true,
        }
    }

    fn get_available_encoders() -> Vec<String> {
        let candidates = [
            "h264_videotoolbox",
            "libx264",
            "hevc_videotoolbox",
            "libx265",
        ];

        candidates
            .iter()
            .filter(|name| ffmpeg::encoder::find_by_name(name).is_some())
            .map(|s| s.to_string())
            .collect()
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::*;

#[cfg(target_os = "macos")]
pub use macos_impl::*;
