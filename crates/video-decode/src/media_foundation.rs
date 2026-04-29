use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tracing::{info, warn};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::core::PCSTR;
use windows::{
    Win32::{
        Foundation::{HANDLE, HMODULE},
        Graphics::{
            Direct3D::{
                D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL,
                D3D_SRV_DIMENSION_TEXTURE2D, ID3DBlob,
            },
            Direct3D11::{
                D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_SHADER_RESOURCE,
                D3D11_BIND_UNORDERED_ACCESS, D3D11_BUFFER_DESC, D3D11_CPU_ACCESS_READ,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                D3D11_DECODER_PROFILE_H264_VLD_NOFGT, D3D11_DECODER_PROFILE_HEVC_VLD_MAIN,
                D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION,
                D3D11_SHADER_RESOURCE_VIEW_DESC1, D3D11_SHADER_RESOURCE_VIEW_DESC1_0,
                D3D11_TEX2D_SRV1, D3D11_TEX2D_UAV, D3D11_TEXTURE2D_DESC,
                D3D11_UAV_DIMENSION_TEXTURE2D, D3D11_UNORDERED_ACCESS_VIEW_DESC,
                D3D11_UNORDERED_ACCESS_VIEW_DESC_0, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
                D3D11_VIDEO_DECODER_DESC, D3D11CreateDevice, ID3D11Buffer, ID3D11ComputeShader,
                ID3D11Device, ID3D11Device3, ID3D11DeviceContext, ID3D11DeviceContext1,
                ID3D11ShaderResourceView, ID3D11ShaderResourceView1, ID3D11Texture2D,
                ID3D11UnorderedAccessView, ID3D11VideoDevice,
            },
            Dxgi::Common::{
                DXGI_FORMAT_NV12, DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM, DXGI_SAMPLE_DESC,
            },
        },
        Media::MediaFoundation::{
            IMFAttributes, IMFDXGIBuffer, IMFDXGIDeviceManager, IMFSample, IMFSourceReader,
            MF_API_VERSION, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
            MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READER_D3D_MANAGER,
            MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
            MFCreateAttributes, MFCreateDXGIDeviceManager, MFCreateMediaType,
            MFCreateSourceReaderFromURL, MFMediaType_Video, MFSTARTUP_NOSOCKET, MFShutdown,
            MFStartup, MFVideoFormat_NV12,
        },
        System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
    },
    core::{Interface, PCWSTR},
};

#[derive(Debug, Clone)]
pub struct MFDecoderCapabilities {
    pub max_width: u32,
    pub max_height: u32,
    pub supports_h264: bool,
    pub supports_hevc: bool,
    pub feature_level: D3D_FEATURE_LEVEL,
}

impl Default for MFDecoderCapabilities {
    fn default() -> Self {
        Self {
            max_width: 4096,
            max_height: 4096,
            supports_h264: true,
            supports_hevc: false,
            feature_level: windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0,
        }
    }
}

static MF_CAPABILITIES: OnceLock<MFDecoderCapabilities> = OnceLock::new();

fn query_mf_decoder_capabilities(device: &ID3D11Device) -> MFDecoderCapabilities {
    let result: Result<MFDecoderCapabilities, String> = (|| {
        let video_device: ID3D11VideoDevice = device
            .cast()
            .map_err(|e| format!("Failed to get ID3D11VideoDevice: {e:?}"))?;

        let feature_level = unsafe { device.GetFeatureLevel() };

        let mut max_width = 4096u32;
        let mut max_height = 4096u32;
        let mut supports_h264 = false;
        let mut supports_hevc = false;

        let test_resolutions = [(8192, 8192), (7680, 4320), (5120, 2880), (4096, 4096)];

        for &(test_w, test_h) in &test_resolutions {
            let h264_desc = D3D11_VIDEO_DECODER_DESC {
                Guid: D3D11_DECODER_PROFILE_H264_VLD_NOFGT,
                SampleWidth: test_w,
                SampleHeight: test_h,
                OutputFormat: DXGI_FORMAT_NV12,
            };

            if let Ok(config_count) = unsafe { video_device.GetVideoDecoderConfigCount(&h264_desc) }
                && config_count > 0
            {
                supports_h264 = true;
                max_width = max_width.max(test_w);
                max_height = max_height.max(test_h);
                break;
            }
        }

        for &(test_w, test_h) in &test_resolutions {
            let hevc_desc = D3D11_VIDEO_DECODER_DESC {
                Guid: D3D11_DECODER_PROFILE_HEVC_VLD_MAIN,
                SampleWidth: test_w,
                SampleHeight: test_h,
                OutputFormat: DXGI_FORMAT_NV12,
            };

            if let Ok(config_count) = unsafe { video_device.GetVideoDecoderConfigCount(&hevc_desc) }
                && config_count > 0
            {
                supports_hevc = true;
                max_width = max_width.max(test_w);
                max_height = max_height.max(test_h);
                break;
            }
        }

        Ok(MFDecoderCapabilities {
            max_width,
            max_height,
            supports_h264,
            supports_hevc,
            feature_level,
        })
    })();

    result.unwrap_or_default()
}

pub fn get_mf_decoder_capabilities() -> Option<&'static MFDecoderCapabilities> {
    MF_CAPABILITIES.get()
}

pub struct MFDecodedFrame {
    pub textures: Arc<FrameTextures>,
    pub width: u32,
    pub height: u32,
    pub pts: i64,
    pub plane_time: Duration,
}

pub struct NV12Data {
    pub data: Vec<u8>,
    pub y_stride: u32,
    pub uv_stride: u32,
}
#[derive(Clone)]
pub struct FrameTexture {
    pub texture: ID3D11Texture2D,
    pub handle: HANDLE,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone)]
pub struct FrameTextures {
    pub nv12: FrameTexture,
    pub y: FrameTexture,
    pub uv: FrameTexture,
    pub y_uav: ID3D11UnorderedAccessView,
    pub uv_uav: ID3D11UnorderedAccessView,
}

unsafe impl Send for FrameTextures {}
unsafe impl Sync for FrameTextures {}

impl FrameTextures {
    fn create(device: &ID3D11Device, width: u32, height: u32) -> Result<Self, String> {
        let nv12 = create_internal_texture(
            device,
            width,
            height,
            DXGI_FORMAT_NV12,
            D3D11_BIND_SHADER_RESOURCE.0 as u32,
        )
        .map_err(|ie| format!("[NV12] {ie}"))?;

        let y = create_internal_texture(
            device,
            width,
            height,
            DXGI_FORMAT_R8_UNORM,
            (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS).0 as u32,
        )
        .map_err(|ie| format!("[Y-plane] {ie}"))?;

        let uv = create_internal_texture(
            device,
            width / 2,
            height / 2,
            DXGI_FORMAT_R8G8_UNORM,
            (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS).0 as u32,
        )
        .map_err(|ie| format!("[UV-plane] {ie}"))?;

        let y_uav = create_uav(device, &y.texture, DXGI_FORMAT_R8_UNORM)?;
        let uv_uav = create_uav(device, &uv.texture, DXGI_FORMAT_R8G8_UNORM)?;

        Ok(Self {
            nv12,
            y,
            uv,
            y_uav,
            uv_uav,
        })
    }
}

#[derive(Default)]
pub struct FramePool {
    free: Vec<FrameTextures>,
    width: u32,
    height: u32,
}

impl FramePool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire(
        &mut self,
        device: &ID3D11Device,
        width: u32,
        height: u32,
    ) -> Result<FrameTextures, String> {
        if self.width != width || self.height != height {
            self.free.clear();
            self.width = width;
            self.height = height;
        }

        if let Some(textures) = self.free.pop() {
            return Ok(textures);
        }

        FrameTextures::create(device, width, height)
    }

    pub fn recycle(&mut self, textures: FrameTextures) {
        self.free.push(textures);
    }
}

#[repr(C)]
struct PlaneConstants {
    width: u32,
    height: u32,
    uv_width: u32,
    uv_height: u32,
}

pub struct Nv12PlaneConverter {
    device3: ID3D11Device3,
    context1: ID3D11DeviceContext1,
    shader: ID3D11ComputeShader,
    constants: ID3D11Buffer,
}

impl Nv12PlaneConverter {
    pub fn new(device: &ID3D11Device, context: &ID3D11DeviceContext) -> Result<Self, String> {
        let device3: ID3D11Device3 = device
            .cast()
            .map_err(|e| format!("Failed to cast to ID3D11Device3: {e:?}"))?;
        let context1: ID3D11DeviceContext1 = context
            .cast()
            .map_err(|e| format!("Failed to cast to ID3D11DeviceContext1: {e:?}"))?;

        let shader = compile_plane_shader(&device3)?;

        let constants = create_constant_buffer(&device3)?;

        Ok(Self {
            device3,
            context1,
            shader,
            constants,
        })
    }

    pub fn convert(
        &self,
        input: &ID3D11Texture2D,
        outputs: &FrameTextures,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let y_srv_desc = D3D11_SHADER_RESOURCE_VIEW_DESC1 {
            Format: DXGI_FORMAT_R8_UNORM,
            ViewDimension: D3D_SRV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC1_0 {
                Texture2D: D3D11_TEX2D_SRV1 {
                    MostDetailedMip: 0,
                    MipLevels: 1,
                    PlaneSlice: 0,
                },
            },
        };

        let uv_srv_desc = D3D11_SHADER_RESOURCE_VIEW_DESC1 {
            Format: DXGI_FORMAT_R8G8_UNORM,
            ViewDimension: D3D_SRV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC1_0 {
                Texture2D: D3D11_TEX2D_SRV1 {
                    MostDetailedMip: 0,
                    MipLevels: 1,
                    PlaneSlice: 1,
                },
            },
        };

        let y_srv = unsafe {
            let mut srv: Option<ID3D11ShaderResourceView1> = None;
            self.device3
                .CreateShaderResourceView1(input, Some(&y_srv_desc), Some(&mut srv))
                .map_err(|e| format!("CreateShaderResourceView1 for Y failed: {e:?}"))?;
            srv.ok_or("Y SRV creation returned null")?
        };

        let uv_srv = unsafe {
            let mut srv: Option<ID3D11ShaderResourceView1> = None;
            self.device3
                .CreateShaderResourceView1(input, Some(&uv_srv_desc), Some(&mut srv))
                .map_err(|e| format!("CreateShaderResourceView1 for UV failed: {e:?}"))?;
            srv.ok_or("UV SRV creation returned null")?
        };

        let y_srv_base: ID3D11ShaderResourceView = y_srv
            .cast()
            .map_err(|e| format!("Cast Y SRV1 to base failed: {e:?}"))?;
        let uv_srv_base: ID3D11ShaderResourceView = uv_srv
            .cast()
            .map_err(|e| format!("Cast UV SRV1 to base failed: {e:?}"))?;

        let constants = PlaneConstants {
            width,
            height,
            uv_width: width / 2,
            uv_height: height / 2,
        };

        unsafe {
            self.context1.UpdateSubresource(
                &self.constants,
                0,
                None,
                &constants as *const _ as *const std::ffi::c_void,
                0,
                0,
            );

            self.context1.CSSetShader(Some(&self.shader), None);
            self.context1
                .CSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
            self.context1.CSSetShaderResources(
                0,
                Some(&[Some(y_srv_base.clone()), Some(uv_srv_base.clone())]),
            );
            let uavs = [Some(outputs.y_uav.clone()), Some(outputs.uv_uav.clone())];
            self.context1.CSSetUnorderedAccessViews(
                0,
                uavs.len() as u32,
                Some(uavs.as_ptr()),
                None,
            );

            let groups_x = width.div_ceil(16);
            let groups_y = height.div_ceil(16);
            self.context1.Dispatch(groups_x, groups_y, 1);

            self.context1.CSSetShaderResources(0, Some(&[None, None]));
            let null_uavs: [Option<ID3D11UnorderedAccessView>; 2] = [None, None];
            self.context1.CSSetUnorderedAccessViews(
                0,
                null_uavs.len() as u32,
                Some(null_uavs.as_ptr()),
                None,
            );
            self.context1.CSSetConstantBuffers(0, Some(&[None]));
            self.context1.CSSetShader(None, None);
        }

        Ok(())
    }
}

fn compile_plane_shader(device: &ID3D11Device3) -> Result<ID3D11ComputeShader, String> {
    let source = br#"
cbuffer FrameSize : register(b0) {
    uint width;
    uint height;
    uint uv_width;
    uint uv_height;
};
Texture2D<uint> YPlane : register(t0);
Texture2D<uint2> UVPlane : register(t1);
RWTexture2D<uint> OutY : register(u0);
RWTexture2D<uint2> OutUV : register(u1);

[numthreads(16,16,1)]
void main(uint3 dtid : SV_DispatchThreadID) {
    uint x = dtid.x;
    uint y = dtid.y;
    if (x < width && y < height) {
        OutY[uint2(x, y)] = YPlane.Load(int3(x, y, 0));
    }
    if (x < uv_width && y < uv_height) {
        OutUV[uint2(x, y)] = UVPlane.Load(int3(x, y, 0));
    }
}
"#;

    let mut shader_blob: Option<ID3DBlob> = None;
    let mut error_blob: Option<ID3DBlob> = None;
    let shader_blob_ptr: *mut Option<ID3DBlob> = &mut shader_blob;
    let error_blob_ptr: *mut Option<ID3DBlob> = &mut error_blob;

    unsafe {
        D3DCompile(
            source.as_ptr() as *const std::ffi::c_void,
            source.len(),
            None,
            None,
            None,
            PCSTR(c"main".as_ptr().cast()),
            PCSTR(c"cs_5_0".as_ptr().cast()),
            0,
            0,
            shader_blob_ptr,
            Some(error_blob_ptr),
        )
        .map_err(|e| format!("D3DCompile failed: {e:?}"))?;
    }

    let shader_blob =
        shader_blob.ok_or_else(|| "Shader compilation produced no blob".to_string())?;

    let shader_bytes = unsafe {
        std::slice::from_raw_parts(
            shader_blob.GetBufferPointer() as *const u8,
            shader_blob.GetBufferSize(),
        )
    };

    let mut shader = None;
    unsafe {
        device
            .CreateComputeShader(shader_bytes, None, Some(&mut shader))
            .map_err(|e| format!("CreateComputeShader failed: {e:?}"))?;
    }

    shader.ok_or_else(|| "CreateComputeShader returned null".to_string())
}

fn create_constant_buffer(device: &ID3D11Device3) -> Result<ID3D11Buffer, String> {
    let desc = D3D11_BUFFER_DESC {
        ByteWidth: std::mem::size_of::<PlaneConstants>() as u32,
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
        StructureByteStride: 0,
    };

    unsafe {
        let mut buffer = None;
        device
            .CreateBuffer(&desc, None, Some(&mut buffer))
            .map_err(|e| format!("CreateBuffer failed: {e:?}"))?;
        buffer.ok_or_else(|| "CreateBuffer returned null".to_string())
    }
}

fn create_internal_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    bind: u32,
) -> Result<FrameTexture, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let texture = unsafe {
        let mut tex: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .map_err(|e| format!("CreateTexture2D failed: {e:?}"))?;
        tex.ok_or("CreateTexture2D returned null")?
    };

    Ok(FrameTexture {
        texture,
        handle: HANDLE::default(),
        width,
        height,
    })
}

fn create_uav(
    device: &ID3D11Device,
    texture: &ID3D11Texture2D,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
) -> Result<ID3D11UnorderedAccessView, String> {
    let desc = D3D11_UNORDERED_ACCESS_VIEW_DESC {
        Format: format,
        ViewDimension: D3D11_UAV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_UNORDERED_ACCESS_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_UAV { MipSlice: 0 },
        },
    };

    unsafe {
        let mut uav = None;
        device
            .CreateUnorderedAccessView(texture, Some(&desc), Some(&mut uav))
            .map_err(|e| format!("CreateUnorderedAccessView failed: {e:?}"))?;
        uav.ok_or_else(|| "CreateUnorderedAccessView returned null".to_string())
    }
}

pub struct MediaFoundationDecoder {
    source_reader: IMFSourceReader,
    d3d11_device: ID3D11Device,
    d3d11_context: ID3D11DeviceContext,
    _device_manager: IMFDXGIDeviceManager,
    width: u32,
    height: u32,
    frame_rate_num: u32,
    frame_rate_den: u32,
    staging_texture: Option<ID3D11Texture2D>,
    staging_width: u32,
    staging_height: u32,
    frame_pool: FramePool,
    plane_converter: Nv12PlaneConverter,
    capabilities: MFDecoderCapabilities,
}

struct MFInitGuard;

impl Drop for MFInitGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

impl MediaFoundationDecoder {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, String> {
        unsafe { Self::new_inner(path.as_ref()) }
    }

    unsafe fn new_inner(path: &Path) -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("Failed to initialize COM: {e:?}"))?;

            MFStartup(MF_API_VERSION, MFSTARTUP_NOSOCKET)
                .map_err(|e| format!("Failed to start Media Foundation: {e:?}"))?;
        }

        let guard = MFInitGuard;

        let (d3d11_device, d3d11_context) = unsafe { create_d3d11_device()? };
        let device_manager = unsafe { create_dxgi_device_manager(&d3d11_device)? };

        let source_reader = unsafe { create_source_reader(path, &device_manager)? };

        unsafe { configure_output_type(&source_reader)? };

        let (width, height, frame_rate_num, frame_rate_den) =
            unsafe { get_video_info(&source_reader)? };

        let capabilities = MF_CAPABILITIES
            .get_or_init(|| query_mf_decoder_capabilities(&d3d11_device))
            .clone();

        let plane_converter = Nv12PlaneConverter::new(&d3d11_device, &d3d11_context)?;

        if width > capabilities.max_width || height > capabilities.max_height {
            warn!(
                video_width = width,
                video_height = height,
                max_width = capabilities.max_width,
                max_height = capabilities.max_height,
                "Video dimensions exceed detected hardware decoder limits"
            );
        }

        info!(
            width = width,
            height = height,
            frame_rate = format!("{}/{}", frame_rate_num, frame_rate_den),
            max_hw_resolution = format!("{}x{}", capabilities.max_width, capabilities.max_height),
            "MediaFoundation decoder initialized"
        );

        std::mem::forget(guard);

        Ok(Self {
            source_reader,
            d3d11_device,
            d3d11_context,
            _device_manager: device_manager,
            width,
            height,
            frame_rate_num,
            frame_rate_den,
            staging_texture: None,
            staging_width: 0,
            staging_height: 0,
            frame_pool: FramePool::new(),
            plane_converter,
            capabilities,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn frame_rate(&self) -> (u32, u32) {
        (self.frame_rate_num, self.frame_rate_den)
    }

    pub fn d3d11_device(&self) -> &ID3D11Device {
        &self.d3d11_device
    }

    pub fn capabilities(&self) -> &MFDecoderCapabilities {
        &self.capabilities
    }

    pub fn read_texture_to_cpu(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<NV12Data, String> {
        unsafe { self.read_texture_to_cpu_inner(texture, width, height) }
    }

    unsafe fn read_texture_to_cpu_inner(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<NV12Data, String> {
        if self.staging_width != width
            || self.staging_height != height
            || self.staging_texture.is_none()
        {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };

            let staging_texture = unsafe {
                let mut tex: Option<ID3D11Texture2D> = None;
                self.d3d11_device
                    .CreateTexture2D(&desc, None, Some(&mut tex))
                    .map_err(|e| format!("CreateTexture2D staging failed: {e:?}"))?;
                tex.ok_or("CreateTexture2D staging returned null")?
            };

            self.staging_texture = Some(staging_texture);
            self.staging_width = width;
            self.staging_height = height;
        }

        let staging = self.staging_texture.as_ref().unwrap();

        unsafe {
            self.d3d11_context.CopyResource(staging, texture);
        }

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.d3d11_context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| format!("Map staging texture failed: {e:?}"))?;
        }

        let y_stride = mapped.RowPitch;
        let y_height = height;
        let uv_height = height / 2;

        let y_size = (y_stride * y_height) as usize;
        let uv_size = (y_stride * uv_height) as usize;
        let total_size = y_size + uv_size;

        let mut data = vec![0u8; total_size];
        unsafe {
            std::ptr::copy_nonoverlapping(mapped.pData as *const u8, data.as_mut_ptr(), total_size);
            self.d3d11_context.Unmap(staging, 0);
        }

        Ok(NV12Data {
            data,
            y_stride,
            uv_stride: y_stride,
        })
    }

    pub fn read_sample(&mut self) -> Result<Option<MFDecodedFrame>, String> {
        unsafe { self.read_sample_inner() }
    }

    pub fn recycle_textures(&mut self, textures: Arc<FrameTextures>) {
        if Arc::strong_count(&textures) == 1
            && let Ok(textures) = Arc::try_unwrap(textures)
        {
            self.frame_pool.recycle(textures);
        }
    }

    unsafe fn read_sample_inner(&mut self) -> Result<Option<MFDecodedFrame>, String> {
        let mut stream_index = 0u32;
        let mut flags = 0u32;
        let mut timestamp = 0i64;
        let mut sample: Option<IMFSample> = None;

        unsafe {
            self.source_reader
                .ReadSample(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                    0,
                    Some(&mut stream_index),
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )
                .map_err(|e| format!("ReadSample failed: {e:?}"))?;
        }

        const MF_SOURCE_READERF_ENDOFSTREAM: u32 = 0x00000001;
        const MF_SOURCE_READERF_ERROR: u32 = 0x00000002;

        if flags & MF_SOURCE_READERF_ENDOFSTREAM != 0 {
            return Ok(None);
        }

        if flags & MF_SOURCE_READERF_ERROR != 0 {
            return Err("Stream error".to_string());
        }

        let Some(sample) = sample else {
            return Ok(None);
        };

        let buffer = unsafe {
            sample
                .GetBufferByIndex(0)
                .map_err(|e| format!("GetBufferByIndex failed: {e:?}"))?
        };

        let dxgi_buffer: IMFDXGIBuffer = buffer
            .cast()
            .map_err(|e| format!("Failed to cast to IMFDXGIBuffer: {e:?}"))?;

        let texture = unsafe {
            let mut texture: Option<ID3D11Texture2D> = None;
            dxgi_buffer
                .GetResource(&ID3D11Texture2D::IID, &mut texture as *mut _ as *mut _)
                .map_err(|e| format!("GetResource failed: {e:?}"))?;
            texture.ok_or("GetResource returned null texture")?
        };

        let subresource_index = unsafe {
            dxgi_buffer
                .GetSubresourceIndex()
                .map_err(|e| format!("GetSubresourceIndex failed: {e:?}"))?
        };

        let frame_textures =
            self.frame_pool
                .acquire(&self.d3d11_device, self.width, self.height)?;

        let plane_start = Instant::now();

        unsafe {
            self.d3d11_context.CopySubresourceRegion(
                &frame_textures.nv12.texture,
                0,
                0,
                0,
                0,
                &texture,
                subresource_index,
                None,
            );

            self.plane_converter.convert(
                &frame_textures.nv12.texture,
                &frame_textures,
                self.width,
                self.height,
            )?;
        }

        let plane_time = plane_start.elapsed();

        Ok(Some(MFDecodedFrame {
            textures: Arc::new(frame_textures),
            width: self.width,
            height: self.height,
            pts: timestamp,
            plane_time,
        }))
    }

    pub fn seek(&mut self, time_100ns: i64) -> Result<(), String> {
        use std::mem::MaybeUninit;
        use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

        let mut prop = MaybeUninit::<PROPVARIANT>::zeroed();
        unsafe {
            let prop_ptr = prop.as_mut_ptr();
            let inner_ptr = std::ptr::addr_of_mut!((*prop_ptr).Anonymous.Anonymous);
            let inner = &mut *inner_ptr;
            inner.vt = windows::Win32::System::Variant::VT_I8;
            inner.Anonymous.hVal = time_100ns;

            let prop = prop.assume_init();
            self.source_reader
                .SetCurrentPosition(&windows::core::GUID::zeroed(), &prop)
                .map_err(|e| format!("Seek failed: {e:?}"))?;
        }

        Ok(())
    }
}

impl Drop for MediaFoundationDecoder {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

unsafe fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;

    let feature_levels = [
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_1,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_10_1,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_10_0,
    ];

    let driver_types = [
        (D3D_DRIVER_TYPE_HARDWARE, "hardware"),
        (D3D_DRIVER_TYPE_WARP, "WARP (software)"),
    ];

    let mut last_error = String::new();

    for (driver_type, driver_name) in driver_types {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;

        let result = unsafe {
            D3D11CreateDevice(
                None,
                driver_type,
                HMODULE::default(),
                flags,
                Some(&feature_levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        };

        match result {
            Ok(()) => {
                if let (Some(device), Some(context)) = (device, context) {
                    if driver_type == D3D_DRIVER_TYPE_WARP {
                        warn!(
                            "Using WARP software rasterizer for D3D11 - hardware GPU unavailable"
                        );
                    } else {
                        info!("D3D11 device created using {} adapter", driver_name);
                    }

                    let multithread: windows::Win32::Graphics::Direct3D11::ID3D11Multithread =
                        device
                            .cast()
                            .map_err(|e| format!("Failed to get ID3D11Multithread: {e:?}"))?;
                    unsafe {
                        let _ = multithread.SetMultithreadProtected(true);
                    }

                    return Ok((device, context));
                }
                last_error =
                    format!("D3D11CreateDevice ({driver_name}) returned null device/context");
            }
            Err(e) => {
                last_error = format!("D3D11CreateDevice ({driver_name}) failed: {e:?}");
                if driver_type == D3D_DRIVER_TYPE_HARDWARE {
                    warn!("{}, trying WARP fallback", last_error);
                }
            }
        }
    }

    Err(last_error)
}

unsafe fn create_dxgi_device_manager(
    device: &ID3D11Device,
) -> Result<IMFDXGIDeviceManager, String> {
    let mut reset_token = 0u32;
    let mut manager: Option<IMFDXGIDeviceManager> = None;

    unsafe {
        MFCreateDXGIDeviceManager(&mut reset_token, &mut manager)
            .map_err(|e| format!("MFCreateDXGIDeviceManager failed: {e:?}"))?;
    }

    let manager = manager.ok_or("MFCreateDXGIDeviceManager returned null")?;

    unsafe {
        manager
            .ResetDevice(device, reset_token)
            .map_err(|e| format!("ResetDevice failed: {e:?}"))?;
    }

    Ok(manager)
}

unsafe fn create_source_reader(
    path: &Path,
    device_manager: &IMFDXGIDeviceManager,
) -> Result<IMFSourceReader, String> {
    let mut attributes: Option<IMFAttributes> = None;
    unsafe {
        MFCreateAttributes(&mut attributes, 4)
            .map_err(|e| format!("MFCreateAttributes failed: {e:?}"))?;
    }

    let attributes = attributes.ok_or("MFCreateAttributes returned null")?;

    unsafe {
        attributes
            .SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, device_manager)
            .map_err(|e| format!("SetUnknown D3D_MANAGER failed: {e:?}"))?;

        attributes
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
            .map_err(|e| format!("SetUINT32 ENABLE_HARDWARE_TRANSFORMS failed: {e:?}"))?;

        attributes
            .SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
            .map_err(|e| format!("SetUINT32 ENABLE_ADVANCED_VIDEO_PROCESSING failed: {e:?}"))?;
    }

    let path_wide: Vec<u16> = path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let source_reader = unsafe {
        MFCreateSourceReaderFromURL(PCWSTR(path_wide.as_ptr()), &attributes)
            .map_err(|e| format!("MFCreateSourceReaderFromURL failed: {e:?}"))?
    };

    Ok(source_reader)
}

unsafe fn configure_output_type(source_reader: &IMFSourceReader) -> Result<(), String> {
    let media_type =
        unsafe { MFCreateMediaType().map_err(|e| format!("MFCreateMediaType failed: {e:?}"))? };

    unsafe {
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|e| format!("SetGUID MAJOR_TYPE failed: {e:?}"))?;

        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(|e| format!("SetGUID SUBTYPE failed: {e:?}"))?;

        source_reader
            .SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                None,
                &media_type,
            )
            .map_err(|e| format!("SetCurrentMediaType failed: {e:?}"))?;
    }

    Ok(())
}

unsafe fn get_video_info(source_reader: &IMFSourceReader) -> Result<(u32, u32, u32, u32), String> {
    let media_type = unsafe {
        source_reader
            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            .map_err(|e| format!("GetCurrentMediaType failed: {e:?}"))?
    };

    let frame_size = unsafe {
        media_type
            .GetUINT64(&MF_MT_FRAME_SIZE)
            .map_err(|e| format!("GetUINT64 FRAME_SIZE failed: {e:?}"))?
    };

    let width = (frame_size >> 32) as u32;
    let height = frame_size as u32;

    let frame_rate = unsafe {
        media_type
            .GetUINT64(&MF_MT_FRAME_RATE)
            .unwrap_or((30 << 32) | 1)
    };

    let frame_rate_num = (frame_rate >> 32) as u32;
    let frame_rate_den = frame_rate as u32;

    Ok((width, height, frame_rate_num, frame_rate_den.max(1)))
}

unsafe impl Send for MediaFoundationDecoder {}
