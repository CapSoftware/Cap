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
        pub adapter_index: u32,
        pub is_software_adapter: bool,
        pub is_basic_render_driver: bool,
        pub supports_hardware_encoding: bool,
    }

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct AllGpusInfo {
        pub gpus: Vec<GpuInfoDiag>,
        pub primary_gpu_index: Option<u32>,
        pub is_multi_gpu_system: bool,
        pub has_discrete_gpu: bool,
    }

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct RenderingStatus {
        pub is_using_software_rendering: bool,
        pub is_using_basic_render_driver: bool,
        pub hardware_encoding_available: bool,
        pub warning_message: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Type)]
    #[serde(rename_all = "camelCase")]
    pub struct SystemDiagnostics {
        pub windows_version: Option<WindowsVersionInfo>,
        pub gpu_info: Option<GpuInfoDiag>,
        pub all_gpus: Option<AllGpusInfo>,
        pub rendering_status: RenderingStatus,
        pub available_encoders: Vec<String>,
        pub graphics_capture_supported: bool,
        #[serde(rename = "d3D11VideoProcessorAvailable")]
        pub d3d11_video_processor_available: bool,
    }

    pub fn collect_diagnostics() -> SystemDiagnostics {
        let windows_version = get_windows_version_info();
        let gpu_info = get_gpu_info();
        let all_gpus = get_all_gpus_info();
        let rendering_status = get_rendering_status(&gpu_info);
        let available_encoders = get_available_encoders();
        let graphics_capture_supported = check_graphics_capture_support();
        let d3d11_video_processor_available = check_d3d11_video_processor();

        tracing::info!("System Diagnostics:");
        if let Some(ref ver) = windows_version {
            tracing::info!("  Windows: {}", ver.display_name);
        }
        if let Some(ref gpu) = gpu_info {
            tracing::info!(
                "  Primary GPU: {} ({}) - Software: {}, BasicRender: {}",
                gpu.description,
                gpu.vendor,
                gpu.is_software_adapter,
                gpu.is_basic_render_driver
            );
        }
        if let Some(ref all) = all_gpus {
            tracing::info!(
                "  GPU Count: {}, Multi-GPU: {}, Has Discrete: {}",
                all.gpus.len(),
                all.is_multi_gpu_system,
                all.has_discrete_gpu
            );
        }
        tracing::info!(
            "  Rendering: SoftwareRendering={}, HardwareEncoding={}",
            rendering_status.is_using_software_rendering,
            rendering_status.hardware_encoding_available
        );
        if let Some(ref warning) = rendering_status.warning_message {
            tracing::warn!("  Warning: {}", warning);
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
            all_gpus,
            rendering_status,
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

    fn gpu_info_to_diag(info: &cap_frame_converter::GpuInfo) -> GpuInfoDiag {
        GpuInfoDiag {
            vendor: info.vendor_name().to_string(),
            description: info.description.clone(),
            dedicated_video_memory_mb: (info.dedicated_video_memory / (1024 * 1024)) as f64,
            adapter_index: info.adapter_index,
            is_software_adapter: info.is_software_adapter,
            is_basic_render_driver: info.is_basic_render_driver(),
            supports_hardware_encoding: info.supports_hardware_encoding(),
        }
    }

    fn get_gpu_info() -> Option<GpuInfoDiag> {
        cap_frame_converter::detect_primary_gpu().map(gpu_info_to_diag)
    }

    fn get_all_gpus_info() -> Option<AllGpusInfo> {
        let all_gpus = cap_frame_converter::get_all_gpus();

        if all_gpus.is_empty() {
            return None;
        }

        let gpus: Vec<GpuInfoDiag> = all_gpus.iter().map(gpu_info_to_diag).collect();

        let primary_gpu = cap_frame_converter::detect_primary_gpu();
        let primary_gpu_index = primary_gpu.and_then(|primary| {
            all_gpus
                .iter()
                .position(|g| g.adapter_index == primary.adapter_index)
                .map(|idx| idx as u32)
        });

        let has_discrete = all_gpus.iter().any(|g| {
            matches!(
                g.vendor,
                cap_frame_converter::GpuVendor::Nvidia
                    | cap_frame_converter::GpuVendor::Amd
                    | cap_frame_converter::GpuVendor::Qualcomm
                    | cap_frame_converter::GpuVendor::Arm
            ) && !g.is_software_adapter
        });

        Some(AllGpusInfo {
            is_multi_gpu_system: gpus.len() > 1,
            has_discrete_gpu: has_discrete,
            primary_gpu_index,
            gpus,
        })
    }

    fn get_rendering_status(gpu_info: &Option<GpuInfoDiag>) -> RenderingStatus {
        let (is_software, is_basic_render, hw_encoding, warning) = match gpu_info {
            Some(gpu) => {
                let is_basic = gpu.is_basic_render_driver;
                let is_software = gpu.is_software_adapter;
                let hw_available = gpu.supports_hardware_encoding;

                let warning = if is_basic {
                    Some(
                        "Microsoft Basic Render Driver detected. This may indicate missing GPU drivers or a remote desktop session. Recording will use software encoding which may impact performance."
                            .to_string(),
                    )
                } else if is_software {
                    Some(
                        "Software rendering is active. Hardware GPU acceleration is not available. Update your graphics drivers for better performance."
                            .to_string(),
                    )
                } else if !hw_available {
                    Some(
                        "Hardware encoding may not be available on this GPU. Software encoding will be used as a fallback."
                            .to_string(),
                    )
                } else {
                    None
                };

                (is_software, is_basic, hw_available, warning)
            }
            None => (
                true,
                false,
                false,
                Some("No GPU detected. Recording will use software encoding.".to_string()),
            ),
        };

        RenderingStatus {
            is_using_software_rendering: is_software,
            is_using_basic_render_driver: is_basic_render,
            hardware_encoding_available: hw_encoding,
            warning_message: warning,
        }
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

        match cap_frame_converter::D3D11Converter::new(test_config) {
            Ok(converter) => {
                tracing::debug!(
                    "D3D11 video processor check passed: {} ({})",
                    converter.gpu_info().description,
                    converter.gpu_info().vendor_name()
                );
                true
            }
            Err(e) => {
                tracing::warn!("D3D11 video processor check failed: {e:?}");
                false
            }
        }
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
