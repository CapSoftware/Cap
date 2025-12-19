use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use ffmpeg::{format::Pixel, frame};
use parking_lot::Mutex;
use std::{
    mem::ManuallyDrop,
    ptr,
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, HMODULE},
        Graphics::{
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE,
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_MAP_READ, D3D11_MAP_WRITE,
                D3D11_MAPPED_SUBRESOURCE, D3D11_RESOURCE_MISC_SHARED,
                D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
                D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
                D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VPIV_DIMENSION_TEXTURE2D,
                D3D11_VPOV_DIMENSION_TEXTURE2D, D3D11CreateDevice, ID3D11Device,
                ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice,
                ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
                ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
            },
            Dxgi::{
                Common::{
                    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_FORMAT_P010,
                    DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_YUY2,
                },
                CreateDXGIFactory1, DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE,
                IDXGIAdapter, IDXGIDevice, IDXGIFactory1, IDXGIResource1,
            },
        },
    },
    core::Interface,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Qualcomm,
    Arm,
    Microsoft,
    Unknown(u32),
}

impl GpuVendor {
    pub fn from_id(vendor_id: u32) -> Self {
        match vendor_id {
            0x10DE => GpuVendor::Nvidia,
            0x1002 | 0x1022 => GpuVendor::Amd,
            0x8086 => GpuVendor::Intel,
            0x5143 => GpuVendor::Qualcomm,
            0x13B5 => GpuVendor::Arm,
            0x1414 => GpuVendor::Microsoft,
            _ => GpuVendor::Unknown(vendor_id),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GpuInfo {
    pub vendor: GpuVendor,
    pub vendor_id: u32,
    pub device_id: u32,
    pub description: String,
    pub dedicated_video_memory: u64,
    pub adapter_index: u32,
    pub is_software_adapter: bool,
}

impl GpuInfo {
    pub fn is_basic_render_driver(&self) -> bool {
        self.vendor == GpuVendor::Microsoft
            && (self.description.contains("Basic Render Driver")
                || self.description.contains("Microsoft Basic")
                || self.dedicated_video_memory == 0)
    }

    pub fn is_warp(&self) -> bool {
        self.description.contains("Microsoft Basic Render Driver")
            || self.description.contains("WARP")
    }

    pub fn supports_hardware_encoding(&self) -> bool {
        !self.is_software_adapter && !self.is_basic_render_driver()
    }
}

impl GpuInfo {
    pub fn vendor_name(&self) -> &'static str {
        match self.vendor {
            GpuVendor::Nvidia => "NVIDIA",
            GpuVendor::Amd => "AMD",
            GpuVendor::Intel => "Intel",
            GpuVendor::Qualcomm => "Qualcomm",
            GpuVendor::Arm => "ARM",
            GpuVendor::Microsoft => "Microsoft",
            GpuVendor::Unknown(_) => "Unknown",
        }
    }
}

static DETECTED_GPU: OnceLock<Option<GpuInfo>> = OnceLock::new();
static ALL_GPUS: OnceLock<Vec<GpuInfo>> = OnceLock::new();

pub fn detect_primary_gpu() -> Option<&'static GpuInfo> {
    DETECTED_GPU
        .get_or_init(|| {
            let all_gpus = enumerate_all_gpus();
            let result = select_best_gpu(&all_gpus);
            if let Some(ref info) = result {
                tracing::debug!(
                    "Selected primary GPU: {} (Vendor: {}, VendorID: 0x{:04X}, VRAM: {} MB, Adapter: {}, SoftwareRenderer: {})",
                    info.description,
                    info.vendor_name(),
                    info.vendor_id,
                    info.dedicated_video_memory / (1024 * 1024),
                    info.adapter_index,
                    info.is_software_adapter
                );

                if info.is_basic_render_driver() {
                    tracing::warn!(
                        "Detected Microsoft Basic Render Driver - hardware encoding will be disabled. \
                        This may indicate missing GPU drivers or a remote desktop session."
                    );
                }
            } else {
                tracing::debug!("No GPU detected via DXGI, using default encoder order");
            }
            result
        })
        .as_ref()
}

pub fn get_all_gpus() -> &'static Vec<GpuInfo> {
    ALL_GPUS.get_or_init(enumerate_all_gpus)
}

fn enumerate_all_gpus() -> Vec<GpuInfo> {
    let mut gpus = Vec::new();

    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("Failed to create DXGI factory: {e:?}");
                return gpus;
            }
        };

        let mut adapter_index = 0u32;
        loop {
            let adapter: IDXGIAdapter = match factory.EnumAdapters(adapter_index) {
                Ok(a) => a,
                Err(_) => break,
            };

            if let Ok(desc) = adapter.GetDesc() {
                let description = String::from_utf16_lossy(
                    &desc
                        .Description
                        .iter()
                        .take_while(|&&c| c != 0)
                        .copied()
                        .collect::<Vec<_>>(),
                );

                let is_software = desc.VendorId == 0x1414
                    && (description.contains("Basic Render")
                        || description.contains("WARP")
                        || description.contains("Microsoft Basic"));

                let gpu_info = GpuInfo {
                    vendor: GpuVendor::from_id(desc.VendorId),
                    vendor_id: desc.VendorId,
                    device_id: desc.DeviceId,
                    description: description.clone(),
                    dedicated_video_memory: desc.DedicatedVideoMemory as u64,
                    adapter_index,
                    is_software_adapter: is_software,
                };

                tracing::debug!(
                    "Found GPU adapter {}: {} (Vendor: 0x{:04X}, VRAM: {} MB, Software: {})",
                    adapter_index,
                    description,
                    desc.VendorId,
                    desc.DedicatedVideoMemory / (1024 * 1024),
                    is_software
                );

                gpus.push(gpu_info);
            }

            adapter_index += 1;
        }
    }

    if gpus.is_empty() {
        tracing::warn!("No GPU adapters found via DXGI enumeration");
    } else {
        tracing::info!("Enumerated {} GPU adapter(s)", gpus.len());
    }

    gpus
}

fn select_best_gpu(gpus: &[GpuInfo]) -> Option<GpuInfo> {
    if gpus.is_empty() {
        return None;
    }

    let hardware_gpus: Vec<&GpuInfo> = gpus.iter().filter(|g| !g.is_software_adapter).collect();

    if hardware_gpus.is_empty() {
        tracing::warn!("No hardware GPUs found, falling back to software adapter");
        return gpus.first().cloned();
    }

    let discrete_gpus: Vec<&GpuInfo> = hardware_gpus
        .iter()
        .filter(|g| {
            matches!(
                g.vendor,
                GpuVendor::Nvidia | GpuVendor::Amd | GpuVendor::Qualcomm | GpuVendor::Arm
            )
        })
        .copied()
        .collect();

    if !discrete_gpus.is_empty() {
        let best = discrete_gpus
            .iter()
            .max_by_key(|g| g.dedicated_video_memory)
            .unwrap();

        if discrete_gpus.len() > 1 || hardware_gpus.len() > 1 {
            tracing::info!(
                "Multi-GPU system detected ({} GPUs). Selected {} with {} MB VRAM for encoding.",
                gpus.len(),
                best.description,
                best.dedicated_video_memory / (1024 * 1024)
            );
        }

        return Some((*best).clone());
    }

    let best = hardware_gpus
        .iter()
        .max_by_key(|g| g.dedicated_video_memory)
        .unwrap();

    Some((*best).clone())
}

struct D3D11Resources {
    #[allow(dead_code)]
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    input_texture: ID3D11Texture2D,
    output_texture: ID3D11Texture2D,
    input_shared_handle: Option<HANDLE>,
    output_shared_handle: Option<HANDLE>,
    staging_input: ID3D11Texture2D,
    staging_output: ID3D11Texture2D,
}

pub struct D3D11Converter {
    resources: Mutex<D3D11Resources>,
    input_format: Pixel,
    output_format: Pixel,
    input_width: u32,
    input_height: u32,
    output_width: u32,
    output_height: u32,
    gpu_info: GpuInfo,
    conversion_count: AtomicU64,
    verified_gpu_usage: AtomicBool,
    total_conversion_time_ns: AtomicU64,
}

fn get_gpu_info(device: &ID3D11Device) -> Result<GpuInfo, ConvertError> {
    unsafe {
        let dxgi_device: IDXGIDevice = device.cast().map_err(|e| {
            ConvertError::HardwareUnavailable(format!("Failed to get DXGI device: {e:?}"))
        })?;

        let adapter: IDXGIAdapter = dxgi_device.GetAdapter().map_err(|e| {
            ConvertError::HardwareUnavailable(format!("Failed to get adapter: {e:?}"))
        })?;

        let desc = adapter.GetDesc().map_err(|e| {
            ConvertError::HardwareUnavailable(format!("Failed to get adapter description: {e:?}"))
        })?;

        let description = String::from_utf16_lossy(
            &desc
                .Description
                .iter()
                .take_while(|&&c| c != 0)
                .copied()
                .collect::<Vec<_>>(),
        );

        let is_software = desc.VendorId == 0x1414
            && (description.contains("Basic Render")
                || description.contains("WARP")
                || description.contains("Microsoft Basic"));

        Ok(GpuInfo {
            vendor: GpuVendor::from_id(desc.VendorId),
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            description,
            dedicated_video_memory: desc.DedicatedVideoMemory as u64,
            adapter_index: 0,
            is_software_adapter: is_software,
        })
    }
}

impl D3D11Converter {
    fn create_device_on_best_adapter() -> Result<(ID3D11Device, ID3D11DeviceContext), ConvertError>
    {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| {
                ConvertError::HardwareUnavailable(format!("Failed to create DXGI factory: {e:?}"))
            })?;

            let mut best_adapter: Option<(IDXGIAdapter, String, u64)> = None;
            let mut adapter_index = 0u32;

            loop {
                let adapter: IDXGIAdapter = match factory.EnumAdapters(adapter_index) {
                    Ok(a) => a,
                    Err(_) => break,
                };

                if let Ok(desc) = adapter.GetDesc() {
                    let description = String::from_utf16_lossy(
                        &desc
                            .Description
                            .iter()
                            .take_while(|&&c| c != 0)
                            .copied()
                            .collect::<Vec<_>>(),
                    );

                    let is_software = desc.VendorId == 0x1414
                        && (description.contains("Basic Render")
                            || description.contains("WARP")
                            || description.contains("Microsoft Basic"));

                    if !is_software {
                        let vendor = GpuVendor::from_id(desc.VendorId);
                        let is_discrete = matches!(
                            vendor,
                            GpuVendor::Nvidia
                                | GpuVendor::Amd
                                | GpuVendor::Qualcomm
                                | GpuVendor::Arm
                        );

                        let vram = desc.DedicatedVideoMemory as u64;

                        let should_use = match &best_adapter {
                            None => true,
                            Some((_, _, best_vram)) => {
                                if is_discrete {
                                    vram > *best_vram
                                } else {
                                    false
                                }
                            }
                        };

                        if should_use {
                            tracing::debug!(
                                "D3D11: Candidate adapter {}: {} (Vendor: 0x{:04X}, VRAM: {} MB, Discrete: {})",
                                adapter_index,
                                description,
                                desc.VendorId,
                                vram / (1024 * 1024),
                                is_discrete
                            );
                            best_adapter = Some((adapter, description, vram));
                        }
                    } else {
                        tracing::debug!(
                            "D3D11: Skipping software adapter {}: {}",
                            adapter_index,
                            description
                        );
                    }
                }

                adapter_index += 1;
            }

            let (adapter, adapter_name, _) = best_adapter.ok_or_else(|| {
                ConvertError::HardwareUnavailable(
                    "No suitable hardware GPU adapter found".to_string(),
                )
            })?;

            tracing::info!("D3D11: Creating device on adapter: {}", adapter_name);

            let mut device = None;
            let mut context = None;

            D3D11CreateDevice(
                Some(&adapter),
                windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|e| {
                ConvertError::HardwareUnavailable(format!(
                    "D3D11CreateDevice failed on {adapter_name}: {e:?}"
                ))
            })?;

            let device = device.ok_or_else(|| {
                ConvertError::HardwareUnavailable("D3D11 device was null".to_string())
            })?;
            let context = context.ok_or_else(|| {
                ConvertError::HardwareUnavailable("D3D11 context was null".to_string())
            })?;

            Ok((device, context))
        }
    }

    pub fn new(config: ConversionConfig) -> Result<Self, ConvertError> {
        let input_dxgi = pixel_to_dxgi(config.input_format)?;
        let output_dxgi = pixel_to_dxgi(config.output_format)?;

        let (device, context) = Self::create_device_on_best_adapter()?;

        let gpu_info = get_gpu_info(&device)?;

        tracing::debug!(
            "D3D11 GPU detected: {} (Vendor: {}, VendorID: 0x{:04X}, DeviceID: 0x{:04X}, VRAM: {} MB)",
            gpu_info.description,
            gpu_info.vendor_name(),
            gpu_info.vendor_id,
            gpu_info.device_id,
            gpu_info.dedicated_video_memory / (1024 * 1024)
        );

        let video_device: ID3D11VideoDevice = device.cast().map_err(|e| {
            ConvertError::HardwareUnavailable(format!(
                "GPU does not support D3D11 Video API (ID3D11VideoDevice): {e:?}"
            ))
        })?;

        let video_context: ID3D11VideoContext = context.cast().map_err(|e| {
            ConvertError::HardwareUnavailable(format!("Failed to get ID3D11VideoContext: {e:?}"))
        })?;

        let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat:
                windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL {
                Numerator: 30,
                Denominator: 1,
            },
            InputWidth: config.input_width,
            InputHeight: config.input_height,
            OutputFrameRate: windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL {
                Numerator: 30,
                Denominator: 1,
            },
            OutputWidth: config.output_width,
            OutputHeight: config.output_height,
            Usage: windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };

        let enumerator = unsafe {
            video_device
                .CreateVideoProcessorEnumerator(&content_desc)
                .map_err(|e| {
                    ConvertError::HardwareUnavailable(format!(
                        "CreateVideoProcessorEnumerator failed (format {:?}->{:?} not supported by GPU?): {e:?}",
                        config.input_format, config.output_format
                    ))
                })?
        };

        let processor = unsafe {
            video_device
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|e| {
                    ConvertError::HardwareUnavailable(format!("CreateVideoProcessor failed: {e:?}"))
                })?
        };

        let (input_texture, input_shared_handle) = create_shared_texture(
            &device,
            config.input_width,
            config.input_height,
            input_dxgi,
            D3D11_BIND_RENDER_TARGET.0 as u32,
        )?;

        let (output_texture, output_shared_handle) = create_shared_texture(
            &device,
            config.output_width,
            config.output_height,
            output_dxgi,
            D3D11_BIND_RENDER_TARGET.0 as u32,
        )?;

        let staging_input = create_texture(
            &device,
            config.input_width,
            config.input_height,
            input_dxgi,
            D3D11_USAGE_STAGING,
            0,
            D3D11_CPU_ACCESS_WRITE.0 as u32,
        )?;

        let staging_output = create_texture(
            &device,
            config.output_width,
            config.output_height,
            output_dxgi,
            D3D11_USAGE_STAGING,
            0,
            D3D11_CPU_ACCESS_READ.0 as u32,
        )?;

        if input_shared_handle.is_some() && output_shared_handle.is_some() {
            tracing::info!("D3D11 converter created with shared texture handles enabled");
        } else {
            tracing::warn!(
                "D3D11 converter created without shared handles (input: {}, output: {})",
                input_shared_handle.is_some(),
                output_shared_handle.is_some()
            );
        }

        let resources = D3D11Resources {
            device,
            context,
            video_device,
            video_context,
            processor,
            enumerator,
            input_texture,
            output_texture,
            input_shared_handle,
            output_shared_handle,
            staging_input,
            staging_output,
        };

        tracing::debug!(
            "D3D11 converter created: {:?} {}x{} -> {:?} {}x{} on {}",
            config.input_format,
            config.input_width,
            config.input_height,
            config.output_format,
            config.output_width,
            config.output_height,
            gpu_info.description
        );

        Ok(Self {
            resources: Mutex::new(resources),
            input_format: config.input_format,
            output_format: config.output_format,
            input_width: config.input_width,
            input_height: config.input_height,
            output_width: config.output_width,
            output_height: config.output_height,
            gpu_info,
            conversion_count: AtomicU64::new(0),
            verified_gpu_usage: AtomicBool::new(false),
            total_conversion_time_ns: AtomicU64::new(0),
        })
    }

    pub fn gpu_info(&self) -> &GpuInfo {
        &self.gpu_info
    }

    pub fn input_shared_handle(&self) -> Option<HANDLE> {
        self.resources.lock().input_shared_handle
    }

    pub fn output_shared_handle(&self) -> Option<HANDLE> {
        self.resources.lock().output_shared_handle
    }

    pub fn output_texture(&self) -> ID3D11Texture2D {
        self.resources.lock().output_texture.clone()
    }

    pub fn has_shared_handles(&self) -> bool {
        let resources = self.resources.lock();
        resources.input_shared_handle.is_some() && resources.output_shared_handle.is_some()
    }

    pub fn average_conversion_time_ms(&self) -> Option<f64> {
        let count = self.conversion_count.load(Ordering::Relaxed);
        if count == 0 {
            return None;
        }
        let total_ns = self.total_conversion_time_ns.load(Ordering::Relaxed);
        Some((total_ns as f64 / count as f64) / 1_000_000.0)
    }

    pub fn format_info(&self) -> (Pixel, Pixel, u32, u32, u32, u32) {
        (
            self.input_format,
            self.output_format,
            self.input_width,
            self.input_height,
            self.output_width,
            self.output_height,
        )
    }
}

pub fn supported_input_formats() -> &'static [Pixel] {
    &[
        Pixel::NV12,
        Pixel::YUYV422,
        Pixel::BGRA,
        Pixel::RGBA,
        Pixel::P010LE,
    ]
}

pub fn is_format_supported(pixel: Pixel) -> bool {
    pixel_to_dxgi(pixel).is_ok()
}

impl FrameConverter for D3D11Converter {
    fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
        let start = Instant::now();
        let count = self.conversion_count.fetch_add(1, Ordering::Relaxed);

        if count == 0 {
            tracing::info!(
                "D3D11 converter first frame: {:?} {}x{} -> {:?} {}x{} on GPU {} ({})",
                self.input_format,
                self.input_width,
                self.input_height,
                self.output_format,
                self.output_width,
                self.output_height,
                self.gpu_info.description,
                self.gpu_info.vendor_name()
            );
        }

        let pts = input.pts();
        let resources = self.resources.lock();

        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            resources
                .context
                .Map(
                    &resources.staging_input,
                    0,
                    D3D11_MAP_WRITE,
                    0,
                    Some(&mut mapped),
                )
                .map_err(|e| ConvertError::ConversionFailed(format!("Map input failed: {e:?}")))?;

            copy_frame_to_mapped(&input, mapped.pData as *mut u8, mapped.RowPitch as usize);

            resources.context.Unmap(&resources.staging_input, 0);

            resources
                .context
                .CopyResource(&resources.input_texture, &resources.staging_input);

            let input_view_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous:
                    windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                        Texture2D: windows::Win32::Graphics::Direct3D11::D3D11_TEX2D_VPIV {
                            MipSlice: 0,
                            ArraySlice: 0,
                        },
                    },
            };

            let mut input_view: Option<ID3D11VideoProcessorInputView> = None;
            resources
                .video_device
                .CreateVideoProcessorInputView(
                    &resources.input_texture,
                    &resources.enumerator,
                    &input_view_desc,
                    Some(&mut input_view),
                )
                .map_err(|e| {
                    ConvertError::ConversionFailed(format!("CreateInputView failed: {e:?}"))
                })?;
            let input_view = input_view.ok_or_else(|| {
                ConvertError::ConversionFailed("CreateInputView returned null".to_string())
            })?;

            let output_view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous:
                    windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                        Texture2D: windows::Win32::Graphics::Direct3D11::D3D11_TEX2D_VPOV {
                            MipSlice: 0,
                        },
                    },
            };

            let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
            resources
                .video_device
                .CreateVideoProcessorOutputView(
                    &resources.output_texture,
                    &resources.enumerator,
                    &output_view_desc,
                    Some(&mut output_view),
                )
                .map_err(|e| {
                    ConvertError::ConversionFailed(format!("CreateOutputView failed: {e:?}"))
                })?;
            let output_view = output_view.ok_or_else(|| {
                ConvertError::ConversionFailed("CreateOutputView returned null".to_string())
            })?;

            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                PastFrames: 0,
                FutureFrames: 0,
                ppPastSurfaces: ptr::null_mut(),
                pInputSurface: std::mem::transmute_copy(&input_view),
                ppFutureSurfaces: ptr::null_mut(),
                ppPastSurfacesRight: ptr::null_mut(),
                pInputSurfaceRight: ManuallyDrop::new(None),
                ppFutureSurfacesRight: ptr::null_mut(),
            };

            resources
                .video_context
                .VideoProcessorBlt(&resources.processor, &output_view, 0, &[stream])
                .map_err(|e| {
                    ConvertError::ConversionFailed(format!("VideoProcessorBlt failed: {e:?}"))
                })?;

            if !self.verified_gpu_usage.swap(true, Ordering::Relaxed) {
                tracing::info!(
                    "D3D11 VideoProcessorBlt succeeded - confirmed GPU hardware acceleration on {}",
                    self.gpu_info.description
                );
            }

            resources
                .context
                .CopyResource(&resources.staging_output, &resources.output_texture);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            resources
                .context
                .Map(
                    &resources.staging_output,
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped),
                )
                .map_err(|e| ConvertError::ConversionFailed(format!("Map output failed: {e:?}")))?;

            let mut output =
                frame::Video::new(self.output_format, self.output_width, self.output_height);
            copy_mapped_to_frame(
                mapped.pData as *const u8,
                mapped.RowPitch as usize,
                &mut output,
            );

            resources.context.Unmap(&resources.staging_output, 0);

            output.set_pts(pts);

            let elapsed_ns = start.elapsed().as_nanos() as u64;
            self.total_conversion_time_ns
                .fetch_add(elapsed_ns, Ordering::Relaxed);

            let frame_count = count + 1;
            if frame_count.is_multiple_of(300) {
                let total_ns = self.total_conversion_time_ns.load(Ordering::Relaxed);
                let avg_ms = (total_ns as f64 / frame_count as f64) / 1_000_000.0;
                tracing::debug!(
                    "D3D11 converter: {:.2}ms avg over {} frames ({:?} -> {:?}) on {}",
                    avg_ms,
                    frame_count,
                    self.input_format,
                    self.output_format,
                    self.gpu_info.description
                );
            }

            Ok(output)
        }
    }

    fn name(&self) -> &'static str {
        "d3d11"
    }

    fn backend(&self) -> ConverterBackend {
        ConverterBackend::D3D11
    }

    fn conversion_count(&self) -> u64 {
        self.conversion_count.load(Ordering::Relaxed)
    }

    fn verify_hardware_usage(&self) -> Option<bool> {
        Some(self.verified_gpu_usage.load(Ordering::Relaxed))
    }
}

fn pixel_to_dxgi(pixel: Pixel) -> Result<DXGI_FORMAT, ConvertError> {
    match pixel {
        Pixel::NV12 => Ok(DXGI_FORMAT_NV12),
        Pixel::YUYV422 => Ok(DXGI_FORMAT_YUY2),
        Pixel::BGRA => Ok(DXGI_FORMAT_B8G8R8A8_UNORM),
        Pixel::RGBA => Ok(DXGI_FORMAT_R8G8B8A8_UNORM),
        Pixel::P010LE => Ok(DXGI_FORMAT_P010),
        _ => Err(ConvertError::UnsupportedFormat(pixel, Pixel::NV12)),
    }
}

#[allow(dead_code)]
fn dxgi_format_name(format: DXGI_FORMAT) -> &'static str {
    match format {
        DXGI_FORMAT_NV12 => "NV12",
        DXGI_FORMAT_YUY2 => "YUY2",
        DXGI_FORMAT_B8G8R8A8_UNORM => "BGRA",
        DXGI_FORMAT_R8G8B8A8_UNORM => "RGBA",
        DXGI_FORMAT_P010 => "P010",
        _ => "Unknown",
    }
}

fn create_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    usage: windows::Win32::Graphics::Direct3D11::D3D11_USAGE,
    bind_flags: u32,
    cpu_access: u32,
) -> Result<ID3D11Texture2D, ConvertError> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: usage,
        BindFlags: bind_flags,
        CPUAccessFlags: cpu_access,
        MiscFlags: 0,
    };

    unsafe {
        let mut texture: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|e| {
                ConvertError::HardwareUnavailable(format!("CreateTexture2D failed: {e:?}"))
            })?;
        texture.ok_or_else(|| {
            ConvertError::HardwareUnavailable("CreateTexture2D returned null".to_string())
        })
    }
}

fn create_shared_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    bind_flags: u32,
) -> Result<(ID3D11Texture2D, Option<HANDLE>), ConvertError> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind_flags,
        CPUAccessFlags: 0,
        MiscFlags: (D3D11_RESOURCE_MISC_SHARED.0 | D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0) as u32,
    };

    let texture = unsafe {
        let mut texture: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|e| {
                ConvertError::HardwareUnavailable(format!(
                    "CreateTexture2D with shared handle failed: {e:?}"
                ))
            })?;
        texture.ok_or_else(|| {
            ConvertError::HardwareUnavailable("CreateTexture2D returned null".to_string())
        })?
    };

    let shared_handle = extract_shared_handle(&texture);

    Ok((texture, shared_handle))
}

fn extract_shared_handle(texture: &ID3D11Texture2D) -> Option<HANDLE> {
    unsafe {
        let dxgi_resource: Result<IDXGIResource1, _> = texture.cast();
        match dxgi_resource {
            Ok(resource) => {
                let result = resource.CreateSharedHandle(
                    None,
                    DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                    None,
                );
                match result {
                    Ok(handle) if !handle.is_invalid() => {
                        tracing::debug!("Created shared handle for texture: {:?}", handle);
                        Some(handle)
                    }
                    Ok(_) => {
                        tracing::warn!("CreateSharedHandle returned invalid handle");
                        None
                    }
                    Err(e) => {
                        tracing::warn!("CreateSharedHandle failed: {e:?}");
                        None
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to cast texture to IDXGIResource1: {e:?}");
                None
            }
        }
    }
}

unsafe fn copy_frame_to_mapped(frame: &frame::Video, dst: *mut u8, dst_stride: usize) {
    let height = frame.height() as usize;
    let width = frame.width() as usize;
    let format = frame.format();

    match format {
        Pixel::NV12 => {
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        frame.data(0).as_ptr().add(y * frame.stride(0)),
                        dst.add(y * dst_stride),
                        width,
                    );
                }
            }
            let uv_offset = height * dst_stride;
            for y in 0..height / 2 {
                unsafe {
                    ptr::copy_nonoverlapping(
                        frame.data(1).as_ptr().add(y * frame.stride(1)),
                        dst.add(uv_offset + y * dst_stride),
                        width,
                    );
                }
            }
        }
        Pixel::YUYV422 => {
            let row_bytes = width * 2;
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        frame.data(0).as_ptr().add(y * frame.stride(0)),
                        dst.add(y * dst_stride),
                        row_bytes,
                    );
                }
            }
        }
        Pixel::BGRA | Pixel::RGBA => {
            let row_bytes = width * 4;
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        frame.data(0).as_ptr().add(y * frame.stride(0)),
                        dst.add(y * dst_stride),
                        row_bytes,
                    );
                }
            }
        }
        Pixel::P010LE => {
            let row_bytes = width * 2;
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        frame.data(0).as_ptr().add(y * frame.stride(0)),
                        dst.add(y * dst_stride),
                        row_bytes,
                    );
                }
            }
            let uv_offset = height * dst_stride;
            for y in 0..height / 2 {
                unsafe {
                    ptr::copy_nonoverlapping(
                        frame.data(1).as_ptr().add(y * frame.stride(1)),
                        dst.add(uv_offset + y * dst_stride),
                        row_bytes,
                    );
                }
            }
        }
        _ => {}
    }
}

unsafe fn copy_mapped_to_frame(src: *const u8, src_stride: usize, frame: &mut frame::Video) {
    let height = frame.height() as usize;
    let width = frame.width() as usize;
    let format = frame.format();

    match format {
        Pixel::NV12 => {
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        src.add(y * src_stride),
                        frame.data_mut(0).as_mut_ptr().add(y * frame.stride(0)),
                        width,
                    );
                }
            }
            let uv_offset = height * src_stride;
            for y in 0..height / 2 {
                unsafe {
                    ptr::copy_nonoverlapping(
                        src.add(uv_offset + y * src_stride),
                        frame.data_mut(1).as_mut_ptr().add(y * frame.stride(1)),
                        width,
                    );
                }
            }
        }
        Pixel::YUYV422 => {
            let row_bytes = width * 2;
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        src.add(y * src_stride),
                        frame.data_mut(0).as_mut_ptr().add(y * frame.stride(0)),
                        row_bytes,
                    );
                }
            }
        }
        Pixel::BGRA | Pixel::RGBA => {
            let row_bytes = width * 4;
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        src.add(y * src_stride),
                        frame.data_mut(0).as_mut_ptr().add(y * frame.stride(0)),
                        row_bytes,
                    );
                }
            }
        }
        Pixel::P010LE => {
            let row_bytes = width * 2;
            for y in 0..height {
                unsafe {
                    ptr::copy_nonoverlapping(
                        src.add(y * src_stride),
                        frame.data_mut(0).as_mut_ptr().add(y * frame.stride(0)),
                        row_bytes,
                    );
                }
            }
            let uv_offset = height * src_stride;
            for y in 0..height / 2 {
                unsafe {
                    ptr::copy_nonoverlapping(
                        src.add(uv_offset + y * src_stride),
                        frame.data_mut(1).as_mut_ptr().add(y * frame.stride(1)),
                        row_bytes,
                    );
                }
            }
        }
        _ => {}
    }
}

unsafe impl Send for D3D11Converter {}
unsafe impl Sync for D3D11Converter {}

impl Drop for D3D11Resources {
    fn drop(&mut self) {
        unsafe {
            if let Some(handle) = self.input_shared_handle.take()
                && !handle.is_invalid()
                && let Err(e) = CloseHandle(handle)
            {
                tracing::error!("Failed to close input shared handle: {:?}", e);
            }
            if let Some(handle) = self.output_shared_handle.take()
                && !handle.is_invalid()
                && let Err(e) = CloseHandle(handle)
            {
                tracing::error!("Failed to close output shared handle: {:?}", e);
            }
        }
    }
}
