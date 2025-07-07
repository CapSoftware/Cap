use nokhwa::pixel_format::RgbAFormat;
use nokhwa::utils::{CameraInfo, RequestedFormat, RequestedFormatType};
use nokhwa::Camera;
use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::{debug, info};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SystemDiagnostics {
    pub os: OsInfo,
    pub hardware: HardwareInfo,
    pub video_devices: Vec<VideoDeviceInfo>,
    pub audio_devices: AudioDevicesInfo,
    pub displays: Vec<DisplayInfo>,
    pub capture_capabilities: CaptureCapabilities,
    pub ffmpeg_info: Option<FfmpegInfo>,
    pub performance_hints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OsInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub kernel_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HardwareInfo {
    pub cpu_model: String,
    pub cpu_cores: u32,
    pub total_memory_gb: f64,
    pub available_memory_gb: f64,
    pub gpu_info: Vec<GpuInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub driver_version: Option<String>,
    pub vram_mb: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VideoDeviceInfo {
    pub name: String,
    pub index: String,
    pub supported_formats: Vec<VideoFormat>,
    pub preferred_format: Option<VideoFormat>,
    pub driver_info: Option<String>,
    pub is_virtual: bool,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VideoFormat {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioDevicesInfo {
    pub input_devices: Vec<AudioDeviceInfo>,
    pub output_devices: Vec<AudioDeviceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub sample_rates: Vec<u32>,
    pub channels: u16,
    pub sample_formats: Vec<String>,
    pub is_default: bool,
    pub buffer_size_range: Option<(u32, u32)>,
    pub latency_ms: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub resolution: (u32, u32),
    pub refresh_rate: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
    pub color_space: Option<String>,
    pub bit_depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureCapabilities {
    pub screen_capture_api: String,
    pub supports_hardware_encoding: bool,
    pub supports_audio_capture: bool,
    pub max_supported_fps: u32,
    pub hardware_encoder: Option<String>,
    pub supported_codecs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FfmpegInfo {
    pub version: String,
    pub configuration: Vec<String>,
    pub libraries: Vec<FfmpegLibrary>,
    pub hardware_acceleration: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FfmpegLibrary {
    pub name: String,
    pub version: String,
}

impl SystemDiagnostics {
    pub async fn collect() -> Result<Self, crate::MediaError> {
        info!("Collecting system diagnostics...");

        let os = Self::collect_os_info();
        let hardware = Self::collect_hardware_info().await?;
        let video_devices = Self::collect_video_devices().await;
        let audio_devices = Self::collect_audio_devices()?;
        let displays = Self::collect_displays()?;
        let capture_capabilities = Self::collect_capture_capabilities();
        let ffmpeg_info = Self::collect_ffmpeg_info().await;
        let performance_hints =
            Self::generate_performance_hints(&hardware, &video_devices, &displays);

        let diagnostics = SystemDiagnostics {
            os,
            hardware,
            video_devices,
            audio_devices,
            displays,
            capture_capabilities,
            ffmpeg_info,
            performance_hints,
        };

        debug!("System diagnostics collected: {:#?}", diagnostics);

        Ok(diagnostics)
    }

    fn collect_os_info() -> OsInfo {
        let mut os_info = OsInfo {
            name: std::env::consts::OS.to_string(),
            version: sys_info::os_release().unwrap_or_else(|_| "unknown".to_string()),
            arch: std::env::consts::ARCH.to_string(),
            kernel_version: sys_info::os_type().ok(),
        };

        // Get more detailed OS version on macOS
        #[cfg(target_os = "macos")]
        {
            if let Ok(output) = std::process::Command::new("sw_vers").output() {
                let output_str = String::from_utf8_lossy(&output.stdout);
                for line in output_str.lines() {
                    if line.starts_with("ProductVersion:") {
                        os_info.version = line
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or(&os_info.version)
                            .to_string();
                    }
                }
            }
        }

        os_info
    }

    async fn collect_hardware_info() -> Result<HardwareInfo, crate::MediaError> {
        let mut cpu_model = "Unknown CPU".to_string();

        // Get actual CPU model name
        #[cfg(target_os = "macos")]
        {
            if let Ok(output) = std::process::Command::new("sysctl")
                .arg("-n")
                .arg("machdep.cpu.brand_string")
                .output()
            {
                cpu_model = String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Ok(output) = std::process::Command::new("wmic")
                .args(&["cpu", "get", "name", "/value"])
                .output()
            {
                let output_str = String::from_utf8_lossy(&output.stdout);
                for line in output_str.lines() {
                    if line.starts_with("Name=") {
                        cpu_model = line.trim_start_matches("Name=").trim().to_string();
                        break;
                    }
                }
            }
        }

        let cpu_cores = num_cpus::get() as u32;
        let mem_info = sys_info::mem_info().map_err(|e| crate::MediaError::Other(e.to_string()))?;
        let total_memory_gb = mem_info.total as f64 / 1024.0 / 1024.0;
        let available_memory_gb = mem_info.avail as f64 / 1024.0 / 1024.0;

        let gpu_info = Self::collect_gpu_info().await;

        Ok(HardwareInfo {
            cpu_model,
            cpu_cores,
            total_memory_gb,
            available_memory_gb,
            gpu_info,
        })
    }

    async fn collect_gpu_info() -> Vec<GpuInfo> {
        let mut gpus = vec![];

        #[cfg(target_os = "macos")]
        {
            // Use system_profiler to get GPU info
            if let Ok(output) = std::process::Command::new("system_profiler")
                .args(&["SPDisplaysDataType", "-json"])
                .output()
            {
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                    if let Some(displays) =
                        json.get("SPDisplaysDataType").and_then(|d| d.as_array())
                    {
                        for display in displays {
                            if let Some(name) = display.get("sppci_model").and_then(|n| n.as_str())
                            {
                                let vendor = display
                                    .get("sppci_vendor")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Unknown")
                                    .to_string();
                                let vram_mb = display
                                    .get("_spdisplays_vram")
                                    .or_else(|| display.get("spdisplays_vram"))
                                    .and_then(|v| v.as_str())
                                    .and_then(|v| v.split_whitespace().next())
                                    .and_then(|v| v.parse::<u32>().ok());

                                gpus.push(GpuInfo {
                                    name: name.to_string(),
                                    vendor,
                                    driver_version: None,
                                    vram_mb,
                                });
                            }
                        }
                    }
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Use WMIC to get GPU info
            if let Ok(output) = std::process::Command::new("wmic")
                .args(&[
                    "path",
                    "win32_VideoController",
                    "get",
                    "name,AdapterRAM,DriverVersion",
                    "/format:csv",
                ])
                .output()
            {
                let output_str = String::from_utf8_lossy(&output.stdout);
                for line in output_str.lines().skip(2) {
                    // Skip headers
                    let parts: Vec<&str> = line.split(',').collect();
                    if parts.len() >= 4 {
                        let name = parts[2].trim().to_string();
                        let vram_bytes = parts[1].trim().parse::<u64>().ok();
                        let driver_version = Some(parts[3].trim().to_string());

                        if !name.is_empty() && name != "Name" {
                            gpus.push(GpuInfo {
                                name: name.clone(),
                                vendor: if name.contains("NVIDIA") {
                                    "NVIDIA"
                                } else if name.contains("AMD") || name.contains("Radeon") {
                                    "AMD"
                                } else if name.contains("Intel") {
                                    "Intel"
                                } else {
                                    "Unknown"
                                }
                                .to_string(),
                                driver_version,
                                vram_mb: vram_bytes.map(|b| (b / 1024 / 1024) as u32),
                            });
                        }
                    }
                }
            }
        }

        gpus
    }

    async fn collect_video_devices() -> Vec<VideoDeviceInfo> {
        use nokhwa::utils::*;

        let cameras = match nokhwa::query(ApiBackend::Auto) {
            Ok(cameras) => cameras,
            Err(e) => {
                debug!("Failed to query cameras: {:?}", e);
                return vec![];
            }
        };

        let mut devices = vec![];

        for camera_info in cameras {
            let name = camera_info.human_name();
            let index = camera_info.index().to_string();

            // We don't have direct access to backend from CameraInfo
            let backend = "Auto".to_string(); // Default since we're using ApiBackend::Auto

            // Check if it's a virtual camera
            let is_virtual = name.to_lowercase().contains("virtual")
                || name.to_lowercase().contains("obs")
                || name.to_lowercase().contains("snap")
                || name.to_lowercase().contains("camo");

            // Try to get all supported formats
            let supported_formats = Self::probe_all_camera_formats(&camera_info).await;

            devices.push(VideoDeviceInfo {
                name,
                index,
                supported_formats,
                preferred_format: None,
                driver_info: None,
                is_virtual,
                backend,
            });
        }

        devices
    }

    async fn probe_all_camera_formats(camera_info: &CameraInfo) -> Vec<VideoFormat> {
        let mut formats = vec![];

        // Try highest framerate format first
        let format =
            RequestedFormat::new::<RgbAFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
        if let Ok(camera) = Camera::new(camera_info.index().clone(), format) {
            let fmt = camera.camera_format();
            formats.push(VideoFormat {
                format: format!("{:?}", fmt.format()),
                width: fmt.width(),
                height: fmt.height(),
                fps: fmt.frame_rate(),
            });
        }

        // For now, we'll just use the highest framerate format
        // since nokhwa doesn't support RequestedFormatType::Exact with specific resolutions
        // in the way we were trying to use it

        formats
    }

    fn collect_audio_devices() -> Result<AudioDevicesInfo, crate::MediaError> {
        use cpal::traits::{DeviceTrait, HostTrait};

        let host = cpal::default_host();
        let mut input_devices = vec![];
        let mut output_devices = vec![];

        // Collect input devices
        if let Ok(devices) = host.input_devices() {
            for device in devices {
                if let Ok(name) = device.name() {
                    let is_default = host
                        .default_input_device()
                        .and_then(|d| d.name().ok())
                        .map(|n| n == name)
                        .unwrap_or(false);

                    let mut sample_rates = vec![];
                    let mut channels = 2u16;
                    let mut sample_formats = vec![];

                    if let Ok(configs) = device.supported_input_configs() {
                        for config in configs {
                            // Collect sample rates
                            sample_rates.push(config.min_sample_rate().0);
                            sample_rates.push(config.max_sample_rate().0);

                            // Get channels
                            channels = config.channels();

                            // Get sample format
                            let format_str = format!("{:?}", config.sample_format());
                            if !sample_formats.contains(&format_str) {
                                sample_formats.push(format_str);
                            }
                        }
                    }

                    // Remove duplicates and sort
                    sample_rates.sort();
                    sample_rates.dedup();

                    input_devices.push(AudioDeviceInfo {
                        name,
                        sample_rates,
                        channels,
                        sample_formats,
                        is_default,
                        buffer_size_range: None,
                        latency_ms: None,
                    });
                }
            }
        }

        // Similar for output devices...
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                if let Ok(name) = device.name() {
                    let is_default = host
                        .default_output_device()
                        .and_then(|d| d.name().ok())
                        .map(|n| n == name)
                        .unwrap_or(false);

                    output_devices.push(AudioDeviceInfo {
                        name,
                        sample_rates: vec![44100, 48000], // Common defaults
                        channels: 2,
                        sample_formats: vec!["f32".to_string()],
                        is_default,
                        buffer_size_range: None,
                        latency_ms: None,
                    });
                }
            }
        }

        Ok(AudioDevicesInfo {
            input_devices,
            output_devices,
        })
    }

    fn collect_displays() -> Result<Vec<DisplayInfo>, crate::MediaError> {
        let mut displays = vec![];

        #[cfg(target_os = "macos")]
        {
            use crate::platform::{display_names, get_display_refresh_rate};
            use core_graphics::display::CGDisplay;

            let display_names_map = display_names();

            // Get all active displays
            for display_id in CGDisplay::active_displays().unwrap_or_default() {
                let cg_display = CGDisplay::new(display_id);
                let name = display_names_map
                    .get(&display_id)
                    .cloned()
                    .unwrap_or_else(|| format!("Display {}", display_id));

                let bounds = cg_display.bounds();
                let resolution = (
                    cg_display.pixels_wide() as u32,
                    cg_display.pixels_high() as u32,
                );
                let refresh_rate = get_display_refresh_rate(display_id).unwrap_or(60);
                let scale_factor = if bounds.size.width > 0.0 {
                    resolution.0 as f64 / bounds.size.width
                } else {
                    1.0
                };

                displays.push(DisplayInfo {
                    id: display_id,
                    name,
                    resolution,
                    refresh_rate,
                    scale_factor,
                    is_primary: cg_display.is_main(),
                    color_space: None,
                    bit_depth: None,
                });
            }
        }

        #[cfg(target_os = "windows")]
        {
            use crate::platform::{display_names, get_display_refresh_rate};
            use windows::Win32::Graphics::Gdi::{
                EnumDisplayMonitors, GetMonitorInfoW, BOOL, HDC, HMONITOR, LPARAM, MONITORINFOEXW,
                RECT, TRUE,
            };

            let display_names_map = display_names();

            unsafe extern "system" fn monitor_enum_proc(
                hmonitor: HMONITOR,
                _hdc: HDC,
                _lprc_clip: *mut RECT,
                lparam: LPARAM,
            ) -> BOOL {
                let displays = &mut *(lparam.0 as *mut Vec<DisplayInfo>);

                let mut minfo = MONITORINFOEXW::default();
                minfo.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;

                if GetMonitorInfoW(hmonitor, &mut minfo as *mut MONITORINFOEXW as *mut _).as_bool()
                {
                    let id = hmonitor.0 as u32;
                    let name = display_names_map
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| format!("Display {}", id));
                    let rect = minfo.monitorInfo.rcMonitor;
                    let resolution = (
                        (rect.right - rect.left) as u32,
                        (rect.bottom - rect.top) as u32,
                    );
                    let refresh_rate = get_display_refresh_rate(hmonitor).unwrap_or(60);

                    displays.push(DisplayInfo {
                        id,
                        name,
                        resolution,
                        refresh_rate,
                        scale_factor: 1.0, // TODO: Get actual DPI scaling
                        is_primary: minfo.monitorInfo.dwFlags & 1 != 0,
                        color_space: None,
                        bit_depth: None,
                    });
                }

                TRUE
            }

            let _ = unsafe {
                EnumDisplayMonitors(
                    None,
                    None,
                    Some(monitor_enum_proc),
                    LPARAM(core::ptr::addr_of_mut!(displays) as isize),
                )
            };
        }

        Ok(displays)
    }

    fn collect_capture_capabilities() -> CaptureCapabilities {
        let mut capabilities = CaptureCapabilities {
            screen_capture_api: if cfg!(target_os = "macos") {
                "AVFoundation".to_string()
            } else if cfg!(target_os = "windows") {
                "Windows Graphics Capture".to_string()
            } else {
                "Unknown".to_string()
            },
            supports_hardware_encoding: cfg!(target_os = "macos"),
            supports_audio_capture: true,
            max_supported_fps: 120,
            hardware_encoder: None,
            supported_codecs: vec!["h264".to_string()],
        };

        // Check for hardware encoder support
        #[cfg(target_os = "macos")]
        {
            capabilities.hardware_encoder = Some("VideoToolbox".to_string());
            capabilities.supported_codecs.push("hevc".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            // Check for NVIDIA encoder
            if std::path::Path::new("C:\\Windows\\System32\\nvEncodeAPI64.dll").exists() {
                capabilities.hardware_encoder = Some("NVENC".to_string());
                capabilities.supports_hardware_encoding = true;
            }
            // Check for AMD encoder
            else if std::path::Path::new("C:\\Windows\\System32\\amfrt64.dll").exists() {
                capabilities.hardware_encoder = Some("AMF".to_string());
                capabilities.supports_hardware_encoding = true;
            }
            // Check for Intel QuickSync
            else if std::path::Path::new("C:\\Windows\\System32\\mfx64.dll").exists() {
                capabilities.hardware_encoder = Some("QuickSync".to_string());
                capabilities.supports_hardware_encoding = true;
            }
        }

        capabilities
    }

    async fn collect_ffmpeg_info() -> Option<FfmpegInfo> {
        // Try to run ffmpeg -version
        if let Ok(output) = std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let mut version = "Unknown".to_string();
            let mut configuration = vec![];
            let mut libraries = vec![];

            for line in output_str.lines() {
                if line.starts_with("ffmpeg version") {
                    version = line
                        .split_whitespace()
                        .nth(2)
                        .unwrap_or("Unknown")
                        .to_string();
                } else if line.starts_with("configuration:") {
                    configuration = line
                        .trim_start_matches("configuration:")
                        .split_whitespace()
                        .map(|s| s.to_string())
                        .collect();
                } else if line.contains("lib") && line.contains(" ") {
                    let parts: Vec<&str> = line.trim().split_whitespace().collect();
                    if parts.len() >= 2 {
                        libraries.push(FfmpegLibrary {
                            name: parts[0].to_string(),
                            version: parts[1].to_string(),
                        });
                    }
                }
            }

            // Check hardware acceleration
            let mut hardware_acceleration = vec![];
            if let Ok(output) = std::process::Command::new("ffmpeg")
                .args(&["-hide_banner", "-hwaccels"])
                .output()
            {
                let output_str = String::from_utf8_lossy(&output.stdout);
                for line in output_str.lines().skip(1) {
                    // Skip header
                    let accel = line.trim().to_string();
                    if !accel.is_empty() {
                        hardware_acceleration.push(accel);
                    }
                }
            }

            Some(FfmpegInfo {
                version,
                configuration,
                libraries,
                hardware_acceleration,
            })
        } else {
            None
        }
    }

    fn generate_performance_hints(
        hardware: &HardwareInfo,
        video_devices: &[VideoDeviceInfo],
        displays: &[DisplayInfo],
    ) -> Vec<String> {
        let mut hints = vec![];

        // Check for low memory
        if hardware.available_memory_gb < 2.0 {
            hints.push("Low available memory detected. Close unnecessary applications for better performance.".to_string());
        }

        // Check for Intel integrated graphics
        if hardware
            .gpu_info
            .iter()
            .any(|gpu| gpu.vendor == "Intel" && gpu.name.contains("UHD"))
        {
            hints.push("Intel integrated graphics detected. Consider using lower resolution or framerate for better performance.".to_string());
        }

        // Check for high resolution displays
        if displays
            .iter()
            .any(|d| d.resolution.0 > 2560 || d.resolution.1 > 1440)
        {
            hints.push("High resolution display detected. Recording at full resolution may impact performance.".to_string());
        }

        // Check for virtual cameras
        if video_devices.iter().any(|d| d.is_virtual) {
            hints.push(
                "Virtual camera detected. Virtual cameras may have additional latency.".to_string(),
            );
        }

        // Check for high refresh rate displays
        if displays.iter().any(|d| d.refresh_rate > 60) {
            hints.push("High refresh rate display detected. Consider matching recording framerate to display refresh rate.".to_string());
        }

        hints
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}
