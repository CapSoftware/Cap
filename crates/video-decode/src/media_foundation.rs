use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};
use tracing::{info, warn};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::core::PCSTR;
use windows::{
    Win32::{
        Foundation::{HANDLE, HMODULE},
        Graphics::{
            Direct3D::{D3D_FEATURE_LEVEL, D3D_SRV_DIMENSION_TEXTURE2D, ID3DBlob},
            Direct3D11::{
                D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_SHADER_RESOURCE,
                D3D11_BIND_UNORDERED_ACCESS, D3D11_BOX, D3D11_BUFFER_DESC, D3D11_CPU_ACCESS_READ,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                D3D11_DECODER_PROFILE_H264_VLD_NOFGT, D3D11_DECODER_PROFILE_HEVC_VLD_MAIN,
                D3D11_MAP_FLAG_DO_NOT_WAIT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
                D3D11_SDK_VERSION, D3D11_SHADER_RESOURCE_VIEW_DESC1,
                D3D11_SHADER_RESOURCE_VIEW_DESC1_0, D3D11_TEX2D_SRV1, D3D11_TEX2D_UAV,
                D3D11_TEXTURE2D_DESC, D3D11_UAV_DIMENSION_TEXTURE2D,
                D3D11_UNORDERED_ACCESS_VIEW_DESC, D3D11_UNORDERED_ACCESS_VIEW_DESC_0,
                D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11_VIDEO_DECODER_DESC,
                D3D11CreateDevice, ID3D11Buffer, ID3D11ComputeShader, ID3D11Device, ID3D11Device3,
                ID3D11DeviceContext, ID3D11DeviceContext1, ID3D11ShaderResourceView,
                ID3D11ShaderResourceView1, ID3D11Texture2D, ID3D11UnorderedAccessView,
                ID3D11VideoDevice,
            },
            Dxgi::{
                Common::{
                    DXGI_FORMAT_NV12, DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM,
                    DXGI_SAMPLE_DESC,
                },
                DXGI_ERROR_WAS_STILL_DRAWING,
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

// The decoder's output surface for a sample: a texture array, the sample's slice in it, and its
// time. Media Foundation decodes into the slice again as soon as the sample is released, so the
// sample is held until the copy out of it is queued.
struct DecoderSurface {
    _sample: IMFSample,
    texture: ID3D11Texture2D,
    subresource: u32,
    pts: i64,
}

pub struct NV12Sample {
    pub pts: i64,
    pub data: NV12Data,
}

#[derive(Clone)]
pub struct NV12Data {
    pub data: Arc<MappedNV12>,
    pub y_stride: u32,
    pub uv_stride: u32,
    /// Identifies this fill of a reused staging texture, so storage-identity
    /// comparisons do not mistake a recycled allocation for the same frame.
    pub storage_epoch: u64,
}

impl NV12Data {
    pub fn as_slice(&self) -> &[u8] {
        self.data.as_slice()
    }
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

unsafe fn create_staging_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, String> {
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

    unsafe {
        let mut tex: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .map_err(|e| format!("CreateTexture2D staging failed: {e:?}"))?;
        tex.ok_or_else(|| "CreateTexture2D staging returned null".to_string())
    }
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

const MAX_IDLE_STAGING_BYTES: usize = 32 * 1024 * 1024;
// Idle readback textures are process-wide: per-decoder caps would multiply the
// staging footprint in projects with many segment and transition decoders.
const MAX_GLOBAL_IDLE_STAGING_BYTES: usize = 128 * 1024 * 1024;
static NEXT_READBACK_EPOCH: AtomicU64 = AtomicU64::new(1);
static GLOBAL_IDLE_STAGING_BYTES: AtomicUsize = AtomicUsize::new(0);

fn reserve_global_staging(bytes: usize) -> bool {
    let mut current = GLOBAL_IDLE_STAGING_BYTES.load(Ordering::Relaxed);
    loop {
        let Some(next) = current.checked_add(bytes) else {
            return false;
        };
        if next > MAX_GLOBAL_IDLE_STAGING_BYTES {
            return false;
        }
        match GLOBAL_IDLE_STAGING_BYTES.compare_exchange_weak(
            current,
            next,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

#[derive(Default)]
struct FreeStagingTextures {
    textures: Vec<ID3D11Texture2D>,
    bytes: usize,
}

struct StagingTexturePool {
    free: std::sync::Mutex<FreeStagingTextures>,
    device: ID3D11Device,
    width: u32,
    height: u32,
    frame_bytes: usize,
}

unsafe impl Send for StagingTexturePool {}
unsafe impl Sync for StagingTexturePool {}

impl StagingTexturePool {
    fn new(device: ID3D11Device, width: u32, height: u32) -> Self {
        Self {
            free: std::sync::Mutex::new(FreeStagingTextures::default()),
            device,
            width,
            height,
            frame_bytes: (width as usize)
                .saturating_mul(height as usize)
                .saturating_mul(3)
                / 2,
        }
    }

    fn acquire(&self) -> Result<(ID3D11Texture2D, bool), String> {
        let mut free = self
            .free
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(texture) = free.textures.pop() {
            free.bytes = free.bytes.saturating_sub(self.frame_bytes);
            let _ = GLOBAL_IDLE_STAGING_BYTES.fetch_update(
                Ordering::Relaxed,
                Ordering::Relaxed,
                |bytes| Some(bytes.saturating_sub(self.frame_bytes)),
            );
            return Ok((texture, true));
        }
        drop(free);

        let texture = unsafe { create_staging_texture(&self.device, self.width, self.height)? };
        Ok((texture, false))
    }

    fn recycle(&self, texture: ID3D11Texture2D) {
        let mut free = self
            .free
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if free.bytes.saturating_add(self.frame_bytes) > MAX_IDLE_STAGING_BYTES
            || !reserve_global_staging(self.frame_bytes)
        {
            return;
        }

        free.textures.push(texture);
        free.bytes = free.bytes.saturating_add(self.frame_bytes);
    }
}

impl Drop for StagingTexturePool {
    fn drop(&mut self) {
        let free = self
            .free
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if free.bytes > 0 {
            let _ = GLOBAL_IDLE_STAGING_BYTES.fetch_update(
                Ordering::Relaxed,
                Ordering::Relaxed,
                |bytes| Some(bytes.saturating_sub(free.bytes)),
            );
        }
    }
}

struct ReclaimTexture {
    texture: Option<ID3D11Texture2D>,
    context: ID3D11DeviceContext,
}

// SAFETY: the decoder's immediate context has multithread protection enabled,
// and the texture is only touched again after the decoder drains it.
unsafe impl Send for ReclaimTexture {}

impl ReclaimTexture {
    fn new(texture: ID3D11Texture2D, context: ID3D11DeviceContext) -> Self {
        Self {
            texture: Some(texture),
            context,
        }
    }

    fn take(&mut self) -> Option<ID3D11Texture2D> {
        self.texture.take()
    }
}

impl Drop for ReclaimTexture {
    fn drop(&mut self) {
        // The decoder can drop its receiver with reclaims still queued, so
        // unmap here on the decoder's thread before releasing the context.
        if let Some(texture) = self.texture.take() {
            unsafe {
                self.context.Unmap(&texture, 0);
            }
        }
    }
}

/// A decoded NV12 frame left mapped in its staging texture. The mapping stays
/// valid until the last clone is dropped, so plane access involves no copy.
pub struct MappedNV12 {
    texture: Option<ID3D11Texture2D>,
    reclaim: mpsc::Sender<ReclaimTexture>,
    context: ID3D11DeviceContext,
    _device: ID3D11Device,
    pool: Arc<StagingTexturePool>,
    _init_guard: Arc<MFInitGuard>,
    ptr: *mut u8,
    len: usize,
}

// SAFETY: the mapped bytes are immutable while shared, and the last reference
// hands the texture back to the decoder's thread before it is reused.
unsafe impl Send for MappedNV12 {}
unsafe impl Sync for MappedNV12 {}

impl MappedNV12 {
    pub fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Drop for MappedNV12 {
    fn drop(&mut self) {
        let Some(texture) = self.texture.take() else {
            return;
        };

        if let Err(mut error) = self
            .reclaim
            .send(ReclaimTexture::new(texture, self.context.clone()))
        {
            // The decoder has shut down, so there is no thread that can still
            // hold the device lock; unmap before releasing the texture.
            if let Some(texture) = error.0.take() {
                unsafe {
                    self.context.Unmap(&texture, 0);
                }
                self.pool.recycle(texture);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NV12ReadbackStats {
    pub frames: u64,
    pub bytes: u64,
    pub map_immediate: u64,
    pub map_waited: u64,
    pub map_blocked: u64,
    pub map_wait: Duration,
    pub pool_hits: u64,
    pub pool_misses: u64,
}

impl NV12ReadbackStats {
    fn record_frame(&mut self, bytes: usize, map_wait: Duration, attempts: u32, blocked: bool) {
        self.frames += 1;
        self.bytes = self.bytes.saturating_add(bytes as u64);
        self.map_wait += map_wait;
        if attempts == 0 {
            self.map_immediate += 1;
        } else {
            self.map_waited += 1;
        }
        if blocked {
            self.map_blocked += 1;
        }

        if self.frames % 240 == 0 {
            tracing::debug!(
                frames = self.frames,
                readback_mb = self.bytes as f64 / (1024.0 * 1024.0),
                map_immediate = self.map_immediate,
                map_waited = self.map_waited,
                map_blocked = self.map_blocked,
                map_wait_us = self.map_wait.as_secs_f64() * 1_000_000.0 / self.frames as f64,
                pool_hits = self.pool_hits,
                pool_misses = self.pool_misses,
                "MediaFoundation NV12 readback"
            );
        }
    }
}

unsafe fn map_nv12_staging(
    context: &ID3D11DeviceContext,
    staging: ID3D11Texture2D,
    height: u32,
    pool: &Arc<StagingTexturePool>,
    reclaim: &mpsc::Sender<ReclaimTexture>,
    stats: &mut NV12ReadbackStats,
    init_guard: Arc<MFInitGuard>,
) -> Result<NV12Data, String> {
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    let map_start = Instant::now();
    let mut attempts = 0u32;
    let mut blocked = false;

    match unsafe {
        context.Map(
            &staging,
            0,
            D3D11_MAP_READ,
            D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
            Some(&mut mapped),
        )
    } {
        Ok(()) => {}
        Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
            attempts = 1;
            // The copy is still in flight and this thread has no other work to
            // overlap, so spinning would only add to the wait. Block in Map.
            if let Err(error) =
                unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
            {
                pool.recycle(staging);
                return Err(format!("Map staging texture failed: {error:?}"));
            }
            blocked = true;
        }
        Err(error) => {
            pool.recycle(staging);
            return Err(format!("Map staging texture failed: {error:?}"));
        }
    }
    let map_wait = map_start.elapsed();

    let y_stride = mapped.RowPitch;
    let uv_height = height.div_ceil(2);
    let len = (y_stride as usize)
        .saturating_mul(height as usize)
        .saturating_add((y_stride as usize).saturating_mul(uv_height as usize));
    let storage_epoch = NEXT_READBACK_EPOCH.fetch_add(1, Ordering::Relaxed);

    stats.record_frame(len, map_wait, attempts, blocked);

    Ok(NV12Data {
        data: Arc::new(MappedNV12 {
            texture: Some(staging),
            reclaim: reclaim.clone(),
            context: context.clone(),
            _device: pool.device.clone(),
            pool: Arc::clone(pool),
            _init_guard: init_guard,
            ptr: mapped.pData as *mut u8,
            len,
        }),
        y_stride,
        uv_stride: y_stride,
        storage_epoch,
    })
}

// Samples whose copy to a staging texture can be in flight while an earlier one is mapped.
const READBACK_DEPTH: usize = 2;

pub struct MediaFoundationDecoder {
    source_reader: IMFSourceReader,
    d3d11_device: ID3D11Device,
    d3d11_context: ID3D11DeviceContext,
    _device_manager: IMFDXGIDeviceManager,
    width: u32,
    height: u32,
    frame_rate_num: u32,
    frame_rate_den: u32,
    readback_queue: VecDeque<(i64, ID3D11Texture2D)>,
    staging_pool: Arc<StagingTexturePool>,
    reclaim_tx: mpsc::Sender<ReclaimTexture>,
    reclaim_rx: mpsc::Receiver<ReclaimTexture>,
    readback_stats: NV12ReadbackStats,
    // How the stream stopped, reported once the queued readbacks are drained.
    readback_end: Option<Result<(), String>>,
    frame_pool: FramePool,
    plane_converter: Nv12PlaneConverter,
    capabilities: MFDecoderCapabilities,
    // COM can unload the decoder DLL, so release every COM field before its apartment shuts down.
    _init_guard: Arc<MFInitGuard>,
    _com_guard: ComInitGuard,
}

struct MFInitGuard {
    media_foundation_started: bool,
}

impl Drop for MFInitGuard {
    fn drop(&mut self) {
        if self.media_foundation_started {
            unsafe {
                let _ = MFShutdown();
            }
        }
    }
}

// COM apartments belong to the thread that initialized them, so that lifetime
// stays with the decoder on its creating thread instead of following mapped
// frames onto a render thread.
struct ComInitGuard {
    initialized: bool,
    init_thread: std::thread::ThreadId,
}

impl Drop for ComInitGuard {
    fn drop(&mut self) {
        if self.initialized && std::thread::current().id() == self.init_thread {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

impl MediaFoundationDecoder {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, String> {
        unsafe { Self::new_inner(path.as_ref()) }
    }

    unsafe fn new_inner(path: &Path) -> Result<Self, String> {
        unsafe { Self::new_inner_with_device(path, || create_d3d11_device()) }
    }

    #[cfg(test)]
    pub(crate) fn new_plain_warp(path: impl AsRef<Path>) -> Result<Self, String> {
        unsafe {
            Self::new_inner_with_device(path.as_ref(), || {
                create_warp_device(false).map_err(|e| format!("plain WARP: {e}"))
            })
        }
    }

    unsafe fn new_inner_with_device(
        path: &Path,
        create_device: impl FnOnce() -> Result<(ID3D11Device, ID3D11DeviceContext), String>,
    ) -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("Failed to initialize COM: {e:?}"))?;
        }
        let com_guard = ComInitGuard {
            initialized: true,
            init_thread: std::thread::current().id(),
        };
        let mut init_guard = MFInitGuard {
            media_foundation_started: false,
        };
        unsafe {
            MFStartup(MF_API_VERSION, MFSTARTUP_NOSOCKET)
                .map_err(|e| format!("Failed to start Media Foundation: {e:?}"))?;
        }
        init_guard.media_foundation_started = true;

        let (d3d11_device, d3d11_context) = create_device()?;
        let device_manager = unsafe { create_dxgi_device_manager(&d3d11_device)? };

        let source_reader = unsafe { create_source_reader(path, &device_manager)? };

        unsafe { configure_output_type(&source_reader)? };

        let (width, height, frame_rate_num, frame_rate_den) =
            unsafe { get_video_info(&source_reader)? };

        let capabilities = MF_CAPABILITIES
            .get_or_init(|| query_mf_decoder_capabilities(&d3d11_device))
            .clone();

        let plane_converter = Nv12PlaneConverter::new(&d3d11_device, &d3d11_context)?;
        let staging_pool = Arc::new(StagingTexturePool::new(d3d11_device.clone(), width, height));
        let (reclaim_tx, reclaim_rx) = mpsc::channel();
        for _ in 0..READBACK_DEPTH {
            let texture = unsafe { create_staging_texture(&d3d11_device, width, height)? };
            staging_pool.recycle(texture);
        }

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

        Ok(Self {
            source_reader,
            d3d11_device,
            d3d11_context,
            _device_manager: device_manager,
            width,
            height,
            frame_rate_num,
            frame_rate_den,
            readback_queue: VecDeque::new(),
            staging_pool,
            reclaim_tx,
            reclaim_rx,
            readback_stats: NV12ReadbackStats::default(),
            readback_end: None,
            frame_pool: FramePool::new(),
            plane_converter,
            capabilities,
            _init_guard: Arc::new(init_guard),
            _com_guard: com_guard,
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

    pub fn readback_stats(&self) -> NV12ReadbackStats {
        self.readback_stats
    }

    /// Reads the next sample back to the CPU. The copy of the sample after it is queued
    /// first, so the GPU decodes and copies that one while this one is mapped.
    pub fn read_nv12(&mut self) -> Result<Option<NV12Sample>, String> {
        self.drain_reclaimed();
        let mut enqueued = false;
        while self.readback_end.is_none() && self.readback_queue.len() < READBACK_DEPTH {
            let (staging, reused) = self.staging_pool.acquire()?;
            if reused {
                self.readback_stats.pool_hits += 1;
            } else {
                self.readback_stats.pool_misses += 1;
            }

            match unsafe { self.read_decoder_surface() } {
                Ok(Some(surface)) => {
                    let source_box = D3D11_BOX {
                        left: 0,
                        top: 0,
                        front: 0,
                        right: self.width,
                        bottom: self.height,
                        back: 1,
                    };
                    unsafe {
                        self.d3d11_context.CopySubresourceRegion(
                            &staging,
                            0,
                            0,
                            0,
                            0,
                            &surface.texture,
                            surface.subresource,
                            Some(&source_box),
                        );
                    }
                    self.readback_queue.push_back((surface.pts, staging));
                    enqueued = true;
                }
                end => {
                    self.staging_pool.recycle(staging);
                    self.readback_end = Some(end.map(|_| ()));
                }
            }
        }
        if enqueued {
            unsafe {
                self.d3d11_context.Flush();
            }
        }

        let Some((pts, staging)) = self.readback_queue.pop_front() else {
            return self
                .readback_end
                .take()
                .expect("the queue only runs dry once the stream has stopped")
                .map(|()| None);
        };
        let data = unsafe { self.map_staging(staging) };
        Ok(Some(NV12Sample { pts, data: data? }))
    }

    unsafe fn map_staging(&mut self, staging: ID3D11Texture2D) -> Result<NV12Data, String> {
        unsafe {
            map_nv12_staging(
                &self.d3d11_context,
                staging,
                self.height,
                &self.staging_pool,
                &self.reclaim_tx,
                &mut self.readback_stats,
                Arc::clone(&self._init_guard),
            )
        }
    }

    fn drain_reclaimed(&mut self) {
        while let Ok(mut reclaim) = self.reclaim_rx.try_recv() {
            let Some(texture) = reclaim.take() else {
                continue;
            };
            unsafe {
                self.d3d11_context.Unmap(&texture, 0);
            }
            self.staging_pool.recycle(texture);
        }
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

    unsafe fn read_decoder_surface(&mut self) -> Result<Option<DecoderSurface>, String> {
        let mut stream_index = 0u32;
        let mut flags = 0u32;
        let mut timestamp = 0i64;
        let mut sample: Option<IMFSample> = None;

        const MF_SOURCE_READERF_ENDOFSTREAM: u32 = 0x00000001;
        const MF_SOURCE_READERF_ERROR: u32 = 0x00000002;

        // A stream tick (a gap in the stream) comes without a sample; only the end-of-stream
        // flag means no samples follow.
        let sample = loop {
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

            if flags & MF_SOURCE_READERF_ENDOFSTREAM != 0 {
                return Ok(None);
            }

            if flags & MF_SOURCE_READERF_ERROR != 0 {
                return Err("Stream error".to_string());
            }

            if let Some(sample) = sample.take() {
                break sample;
            }
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

        Ok(Some(DecoderSurface {
            _sample: sample,
            texture,
            subresource: subresource_index,
            pts: timestamp,
        }))
    }

    unsafe fn read_sample_inner(&mut self) -> Result<Option<MFDecodedFrame>, String> {
        let Some(surface) = (unsafe { self.read_decoder_surface()? }) else {
            return Ok(None);
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
                &surface.texture,
                surface.subresource,
                None,
            );

            if !frame_textures.y.handle.0.is_null() && !frame_textures.uv.handle.0.is_null() {
                self.plane_converter.convert(
                    &frame_textures.nv12.texture,
                    &frame_textures,
                    self.width,
                    self.height,
                )?;
            }
        }

        let plane_time = plane_start.elapsed();

        Ok(Some(MFDecodedFrame {
            textures: Arc::new(frame_textures),
            width: self.width,
            height: self.height,
            pts: surface.pts,
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

        self.drain_reclaimed();
        for (_, staging) in self.readback_queue.drain(..) {
            self.staging_pool.recycle(staging);
        }
        self.readback_end = None;
        Ok(())
    }
}

impl Drop for MediaFoundationDecoder {
    fn drop(&mut self) {
        self.drain_reclaimed();
    }
}

unsafe fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;

    let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;

    let feature_levels = [
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_1,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_10_1,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_10_0,
    ];

    let mut last_error = String::new();

    if let Ok(selected) = cap_d3d_adapter::select_capture_adapter(None) {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;

        let result = unsafe {
            D3D11CreateDevice(
                Some(&selected.adapter),
                D3D_DRIVER_TYPE_UNKNOWN,
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
                    info!(
                        adapter = %selected.description,
                        "D3D11 device created on pinned hardware adapter"
                    );

                    let multithread: windows::Win32::Graphics::Direct3D11::ID3D11Multithread =
                        device
                            .cast()
                            .map_err(|e| format!("Failed to get ID3D11Multithread: {e:?}"))?;
                    unsafe {
                        let _ = multithread.SetMultithreadProtected(true);
                    }

                    return Ok((device, context));
                }
                last_error = format!(
                    "D3D11CreateDevice (pinned adapter '{}') returned null device/context",
                    selected.description
                );
            }
            Err(e) => {
                last_error = format!(
                    "D3D11CreateDevice (pinned adapter '{}') failed: {e:?}",
                    selected.description
                );
                warn!("{}, trying WARP fallback", last_error);
            }
        }
    } else {
        warn!("No physical hardware DXGI adapter available, falling back to WARP");
    }

    match unsafe { create_warp_device(true) } {
        Ok(device) => {
            warn!("Using WARP software rasterizer for D3D11 - hardware GPU unavailable");
            Ok(device)
        }
        Err(error) => Err(format!("{last_error}; {error}")),
    }
}

unsafe fn create_warp_device(
    video_support: bool,
) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;

    let mut flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    if video_support {
        flags |= D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    }

    let feature_levels = [
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_1,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_10_1,
        windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_10_0,
    ];

    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;

    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_WARP,
            HMODULE::default(),
            flags,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|error| format!("D3D11CreateDevice (WARP) failed: {error:?}"))?;

    let (device, context) = match (device, context) {
        (Some(device), Some(context)) => (device, context),
        _ => return Err("D3D11CreateDevice (WARP) returned a null device/context".to_string()),
    };

    let multithread: windows::Win32::Graphics::Direct3D11::ID3D11Multithread = device
        .cast()
        .map_err(|e| format!("Failed to get ID3D11Multithread: {e:?}"))?;
    unsafe {
        let _ = multithread.SetMultithreadProtected(true);
    }

    Ok((device, context))
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

    let path_wide = media_foundation_path(path);

    let source_reader = unsafe {
        MFCreateSourceReaderFromURL(PCWSTR(path_wide.as_ptr()), &attributes)
            .map_err(|e| format!("MFCreateSourceReaderFromURL failed: {e:?}"))?
    };

    Ok(source_reader)
}

fn media_foundation_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
    let extended_unc = [92, 92, 63, 92, 85, 78, 67, 92];
    let extended_drive = [92, 92, 63, 92];

    if path.starts_with(&extended_unc) {
        path.splice(..extended_unc.len(), [92, 92]);
    } else if path.starts_with(&extended_drive) {
        path.drain(..extended_drive.len());
    }

    path.push(0);
    path
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;
    use std::sync::{Mutex, MutexGuard};

    const FIXTURE_1080P: &str = "h264-1080p.mp4";
    static MF_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serial_mf_test() -> MutexGuard<'static, ()> {
        MF_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    fn skip_or_fail(required: bool, reason: &str) {
        if required {
            panic!("{reason}");
        }
        eprintln!("MediaFoundation test skipped: {reason}");
    }

    fn skip_or_fail_d3d11(reason: &str) {
        skip_or_fail(
            std::env::var_os("CAP_REQUIRE_D3D11_TESTS").is_some(),
            reason,
        );
    }

    fn skip_or_fail_mf(reason: &str) {
        skip_or_fail(std::env::var_os("CAP_REQUIRE_MF_TESTS").is_some(), reason);
    }

    fn test_device() -> Option<(ID3D11Device, ID3D11DeviceContext)> {
        if std::env::var_os("CAP_FORCE_WARP_TESTS").is_none()
            && let Ok(device) = unsafe { create_d3d11_device() }
        {
            return Some(device);
        }

        // Hosted Windows runners expose no video-capable adapter. The staging
        // tests only need a D3D11 context, so fall back to plain WARP.
        match unsafe { create_warp_device(false) } {
            Ok(device) => Some(device),
            Err(error) => {
                skip_or_fail_d3d11(&format!("no D3D11 test device available: {error}"));
                None
            }
        }
    }

    fn test_decoder(path: &Path) -> Option<MediaFoundationDecoder> {
        let result = if std::env::var_os("CAP_FORCE_WARP_TESTS").is_some() {
            MediaFoundationDecoder::new_plain_warp(path)
        } else {
            MediaFoundationDecoder::new(path)
        };
        match result {
            Ok(decoder) => Some(decoder),
            Err(error) => {
                skip_or_fail_mf(&format!(
                    "no Media Foundation H.264 decoder available: {error}"
                ));
                None
            }
        }
    }

    fn create_cpu_readwrite_staging(
        device: &ID3D11Device,
        width: u32,
        height: u32,
    ) -> ID3D11Texture2D {
        use windows::Win32::Graphics::Direct3D11::D3D11_CPU_ACCESS_WRITE;

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
            CPUAccessFlags: (D3D11_CPU_ACCESS_READ.0 | D3D11_CPU_ACCESS_WRITE.0) as u32,
            MiscFlags: 0,
        };
        unsafe {
            let mut texture = None;
            device
                .CreateTexture2D(&desc, None, Some(&mut texture))
                .unwrap();
            texture.unwrap()
        }
    }

    unsafe fn blocking_map_copy(
        context: &ID3D11DeviceContext,
        staging: &ID3D11Texture2D,
        height: u32,
    ) -> Vec<u8> {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .unwrap();
            let y_stride = mapped.RowPitch as usize;
            let len = y_stride * height as usize + y_stride * (height / 2) as usize;
            let data = std::slice::from_raw_parts(mapped.pData as *const u8, len).to_vec();
            context.Unmap(staging, 0);
            data
        }
    }

    fn recycle_reclaimed(
        context: &ID3D11DeviceContext,
        pool: &StagingTexturePool,
        rx: &mpsc::Receiver<ReclaimTexture>,
    ) {
        while let Ok(mut reclaim) = rx.try_recv() {
            let Some(texture) = reclaim.take() else {
                continue;
            };
            unsafe {
                context.Unmap(&texture, 0);
            }
            pool.recycle(texture);
        }
    }

    #[test]
    fn repeatedly_releases_decoder_objects_before_com_shutdown() {
        let _mf = serial_mf_test();
        if std::env::var_os("CAP_FORCE_WARP_TESTS").is_some() {
            eprintln!(
                "MediaFoundation lifecycle test skipped: WARP removes devices after repeated re-creation"
            );
            return;
        }
        let path = fixture("h264-decoder-lifecycle.mp4");
        let decoders = 20;
        for _ in 0..decoders {
            let Some(mut decoder) = test_decoder(&path) else {
                return;
            };
            for _ in 0..5 {
                assert!(decoder.read_sample().unwrap().is_some());
            }
            drop(decoder);
        }
        println!("MediaFoundation lifecycle: {decoders} decoders created and released");
    }

    #[test]
    fn pipelined_readback_returns_every_sample_in_order() {
        let _mf = serial_mf_test();
        let path = fixture(FIXTURE_1080P);
        // This file, like the reference recording, ends with a stream error rather than an
        // end-of-stream flag, so both readers stop at whichever comes first.
        let mut expected = Vec::new();
        let Some(mut decoder) = test_decoder(&path) else {
            return;
        };
        let video_width = decoder.width;
        let video_height = decoder.height;
        let mut surface_height = 0;
        let expected_end = loop {
            let (staging, _) = decoder.staging_pool.acquire().unwrap();
            match unsafe { decoder.read_decoder_surface() } {
                Ok(Some(surface)) => unsafe {
                    let mut desc = D3D11_TEXTURE2D_DESC::default();
                    surface.texture.GetDesc(&mut desc);
                    surface_height = desc.Height;
                    // Keep the copy box identical to read_nv12 so this comparison
                    // isolates the CPU readback path from the surface clipping.
                    let source_box = D3D11_BOX {
                        left: 0,
                        top: 0,
                        front: 0,
                        right: video_width,
                        bottom: video_height,
                        back: 1,
                    };
                    decoder.d3d11_context.CopySubresourceRegion(
                        &staging,
                        0,
                        0,
                        0,
                        0,
                        &surface.texture,
                        surface.subresource,
                        Some(&source_box),
                    );
                    let data = blocking_map_copy(&decoder.d3d11_context, &staging, video_height);
                    expected.push((surface.pts, data));
                    decoder.staging_pool.recycle(staging);
                },
                end => {
                    decoder.staging_pool.recycle(staging);
                    break end.is_err();
                }
            }
        };
        drop(decoder);

        let Some(mut decoder) = test_decoder(&path) else {
            return;
        };
        let mut read = Vec::new();
        let end = loop {
            match decoder.read_nv12() {
                Ok(Some(sample)) => read.push((sample.pts, sample.data.as_slice().to_vec())),
                end => break end.is_err(),
            }
        };
        assert_eq!((video_width, video_height), (1920, 1080));
        assert_eq!(
            surface_height, 1088,
            "the decoder surface must stay macroblock-aligned for this test"
        );
        assert!(expected.len() > READBACK_DEPTH);
        assert!(read == expected);
        assert_eq!(end, expected_end);

        let stats = decoder.readback_stats();
        assert_eq!(stats.frames, read.len() as u64);
        assert!(stats.pool_hits + stats.pool_misses >= stats.frames);
        println!(
            "MediaFoundation readback parity: {} frames, {}x{}, {}-row decoder surface",
            read.len(),
            video_width,
            video_height,
            surface_height
        );

        let first = |decoder: &mut MediaFoundationDecoder| {
            let sample = decoder.read_nv12().unwrap().unwrap();
            (sample.pts, sample.data.as_slice().to_vec())
        };
        decoder.seek(0).unwrap();
        assert!(first(&mut decoder) == expected[0]);
        decoder.read_nv12().unwrap();
        decoder.seek(0).unwrap();
        assert!(first(&mut decoder) == expected[0]);
    }

    #[test]
    fn software_decoded_1080p_frame_matches_blocking_readback() {
        use windows::Win32::Graphics::Direct3D11::D3D11_MAP_WRITE;

        const WIDTH: u32 = 1920;
        const HEIGHT: u32 = 1080;
        const SURFACE_HEIGHT: u32 = 1088;

        let _mf = serial_mf_test();
        let path = fixture(FIXTURE_1080P);
        let mut decoder = crate::FFmpegDecoder::new(&path, None).unwrap();
        let frame = decoder
            .frames()
            .next()
            .expect("fixture has no frames")
            .unwrap();
        assert_eq!(frame.format(), ::ffmpeg::format::Pixel::YUV420P);

        let Some((device, context)) = test_device() else {
            return;
        };
        let source = create_cpu_readwrite_staging(&device, WIDTH, SURFACE_HEIGHT);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context
                .Map(&source, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped))
                .unwrap();
            let pitch = mapped.RowPitch as usize;
            let total = pitch * (SURFACE_HEIGHT + SURFACE_HEIGHT.div_ceil(2)) as usize;
            let bytes = std::slice::from_raw_parts_mut(mapped.pData as *mut u8, total);

            for row in 0..SURFACE_HEIGHT as usize {
                let destination = &mut bytes[row * pitch..row * pitch + WIDTH as usize];
                if row < HEIGHT as usize {
                    let stride = frame.stride(0);
                    let source = &frame.data(0)[row * stride..row * stride + WIDTH as usize];
                    destination.copy_from_slice(source);
                } else {
                    destination.fill(0xEE);
                }
            }

            let uv_start = pitch * SURFACE_HEIGHT as usize;
            for row in 0..SURFACE_HEIGHT.div_ceil(2) as usize {
                let start = uv_start + row * pitch;
                let destination = &mut bytes[start..start + WIDTH as usize];
                if row < HEIGHT.div_ceil(2) as usize {
                    let u_stride = frame.stride(1);
                    let v_stride = frame.stride(2);
                    let u = &frame.data(1)[row * u_stride..row * u_stride + WIDTH as usize / 2];
                    let v = &frame.data(2)[row * v_stride..row * v_stride + WIDTH as usize / 2];
                    for (x, (&u_byte, &v_byte)) in u.iter().zip(v).enumerate() {
                        destination[2 * x] = u_byte;
                        destination[2 * x + 1] = v_byte;
                    }
                } else {
                    destination.fill(0xDD);
                }
            }
            context.Unmap(&source, 0);
            context.Flush();
        }

        let pool = Arc::new(StagingTexturePool::new(device.clone(), WIDTH, HEIGHT));
        let (old_staging, _) = pool.acquire().unwrap();
        let (new_staging, _) = pool.acquire().unwrap();
        let source_box = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: WIDTH,
            bottom: HEIGHT,
            back: 1,
        };
        unsafe {
            for destination in [&old_staging, &new_staging] {
                context.CopySubresourceRegion(
                    destination,
                    0,
                    0,
                    0,
                    0,
                    &source,
                    0,
                    Some(&source_box),
                );
            }
            context.Flush();
        }

        let old = unsafe { blocking_map_copy(&context, &old_staging, HEIGHT) };
        pool.recycle(old_staging);

        let (reclaim_tx, reclaim_rx) = mpsc::channel();
        let mut stats = NV12ReadbackStats::default();
        let guard = Arc::new(MFInitGuard {
            media_foundation_started: false,
        });
        let new = unsafe {
            map_nv12_staging(
                &context,
                new_staging,
                HEIGHT,
                &pool,
                &reclaim_tx,
                &mut stats,
                guard,
            )
            .unwrap()
        };
        assert_eq!(new.as_slice(), old.as_slice());
        assert_eq!(new.as_slice().len(), old.len());
        println!(
            "MediaFoundation software-decode parity: 1 frame, {WIDTH}x{HEIGHT}, {SURFACE_HEIGHT}-row source"
        );
        drop(new);
        recycle_reclaimed(&context, &pool, &reclaim_rx);
    }

    #[test]
    fn mapped_frame_outlives_decoder() {
        let _mf = serial_mf_test();
        let path = fixture(FIXTURE_1080P);
        let Some(mut decoder) = test_decoder(&path) else {
            return;
        };
        let frame = decoder.read_nv12().unwrap().unwrap();
        drop(decoder);

        let byte = std::thread::spawn(move || {
            let byte = frame.data.as_slice()[0];
            drop(frame);
            byte
        })
        .join()
        .unwrap();
        std::hint::black_box(byte);
        println!("MediaFoundation mapped frame outlived its decoder");
    }

    #[test]
    fn dropped_mapped_frame_is_reclaimed_when_the_decoder_drains() {
        let _mf = serial_mf_test();
        let path = fixture(FIXTURE_1080P);
        let Some(mut decoder) = test_decoder(&path) else {
            return;
        };
        let frame = decoder.read_nv12().unwrap().unwrap();
        let free_before = decoder.staging_pool.free.lock().unwrap().textures.len();
        drop(frame);
        let free_after_drop = decoder.staging_pool.free.lock().unwrap().textures.len();
        assert_eq!(free_after_drop, free_before);

        decoder.drain_reclaimed();
        let free_after_drain = decoder.staging_pool.free.lock().unwrap().textures.len();
        assert_eq!(free_after_drain, free_before + 1);
        assert!(matches!(
            decoder.reclaim_rx.try_recv(),
            Err(TryRecvError::Empty)
        ));
        println!("MediaFoundation mapped frame reclaimed when the decoder drained it");
    }

    #[test]
    fn staging_pool_reuses_recycled_textures() {
        let Some((device, _)) = test_device() else {
            return;
        };
        let pool = StagingTexturePool::new(device, 64, 64);

        let (first, first_hit) = pool.acquire().unwrap();
        assert!(!first_hit);
        pool.recycle(first);

        let (second, second_hit) = pool.acquire().unwrap();
        assert!(second_hit);
        pool.recycle(second);
        println!("MediaFoundation staging pool reused a recycled texture");
    }

    #[test]
    fn aligned_decoder_surface_copies_only_the_visible_rows() {
        use windows::Win32::Graphics::Direct3D11::D3D11_MAP_WRITE;

        const WIDTH: u32 = 1920;
        const HEIGHT: u32 = 1080;
        const SURFACE_HEIGHT: u32 = 1088;

        let Some((device, context)) = test_device() else {
            return;
        };
        let source = create_cpu_readwrite_staging(&device, WIDTH, SURFACE_HEIGHT);
        let staging = unsafe { create_staging_texture(&device, WIDTH, HEIGHT).unwrap() };

        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context
                .Map(&source, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped))
                .unwrap();
            let pitch = mapped.RowPitch as usize;
            let y_len = pitch * SURFACE_HEIGHT as usize;
            let uv_len = pitch * SURFACE_HEIGHT.div_ceil(2) as usize;
            let bytes = std::slice::from_raw_parts_mut(mapped.pData as *mut u8, y_len + uv_len);
            for row in 0..SURFACE_HEIGHT as usize {
                let value = if row < HEIGHT as usize {
                    row as u8
                } else {
                    0xEE
                };
                bytes[row * pitch..(row + 1) * pitch].fill(value);
            }
            for row in 0..SURFACE_HEIGHT.div_ceil(2) as usize {
                let value = if row < HEIGHT.div_ceil(2) as usize {
                    0x80 | (row as u8 & 0x7F)
                } else {
                    0xDD
                };
                let start = y_len + row * pitch;
                bytes[start..start + pitch].fill(value);
            }
            context.Unmap(&source, 0);

            let source_box = D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: WIDTH,
                bottom: HEIGHT,
                back: 1,
            };
            context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &source, 0, Some(&source_box));
            context.Flush();

            context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .unwrap();
            let staging_pitch = mapped.RowPitch as usize;
            let staging_y_len = staging_pitch * HEIGHT as usize;
            let staging_uv_len = staging_pitch * HEIGHT.div_ceil(2) as usize;
            let visible = std::slice::from_raw_parts(
                mapped.pData as *const u8,
                staging_y_len + staging_uv_len,
            );
            for row in 0..HEIGHT as usize {
                assert!(
                    visible[row * staging_pitch..row * staging_pitch + WIDTH as usize]
                        .iter()
                        .all(|&byte| byte == row as u8),
                    "luma row {row} was not copied from the visible region"
                );
            }
            for row in 0..HEIGHT.div_ceil(2) as usize {
                let start = staging_y_len + row * staging_pitch;
                assert!(
                    visible[start..start + WIDTH as usize]
                        .iter()
                        .all(|&byte| byte == 0x80 | (row as u8 & 0x7F)),
                    "chroma row {row} was not copied from the visible region"
                );
            }
            context.Unmap(&staging, 0);
        }
        println!("MediaFoundation 1088-row copy: only visible 1080 luma and chroma rows");
    }

    #[test]
    #[ignore = "performance probe: baseline blocking Map plus a fresh buffer per frame"]
    fn nv12_4k_readback_baseline() {
        const WIDTH: u32 = 3840;
        const HEIGHT: u32 = 2160;
        const ITERS: u32 = 60;

        let (device, context) = unsafe { create_d3d11_device().unwrap() };
        let source = create_internal_texture(&device, WIDTH, HEIGHT, DXGI_FORMAT_NV12, 0).unwrap();
        let staging = [
            unsafe { create_staging_texture(&device, WIDTH, HEIGHT).unwrap() },
            unsafe { create_staging_texture(&device, WIDTH, HEIGHT).unwrap() },
        ];

        unsafe {
            context.CopySubresourceRegion(&staging[0], 0, 0, 0, 0, &source.texture, 0, None);
            context.Flush();
        }

        let wall_start = Instant::now();
        let mut map_wait = Duration::ZERO;
        let mut copy_time = Duration::ZERO;
        let mut bytes = 0usize;
        for iteration in 0..ITERS {
            let current = (iteration % 2) as usize;
            let next = ((iteration + 1) % 2) as usize;
            unsafe {
                context.CopySubresourceRegion(&staging[next], 0, 0, 0, 0, &source.texture, 0, None);
                context.Flush();

                let map_start = Instant::now();
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                context
                    .Map(&staging[current], 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                    .unwrap();
                map_wait += map_start.elapsed();

                let y_stride = mapped.RowPitch as usize;
                let total_size =
                    y_stride * HEIGHT as usize + y_stride * HEIGHT.div_ceil(2) as usize;
                let copy_start = Instant::now();
                let mut data = vec![0u8; total_size];
                std::ptr::copy_nonoverlapping(
                    mapped.pData as *const u8,
                    data.as_mut_ptr(),
                    total_size,
                );
                context.Unmap(&staging[current], 0);
                copy_time += copy_start.elapsed();
                bytes += total_size;
                std::hint::black_box(data.len());
            }
        }
        let wall = wall_start.elapsed();

        let frames = ITERS as f64;
        let readback_mib = bytes as f64 / (1024.0 * 1024.0);
        println!(
            "4K NV12 MF readback baseline (blocking map, fresh Vec): {:.2} ms/frame wall ({:.1} MiB/s), map {:.2} ms, alloc+copy {:.2} ms",
            wall.as_secs_f64() * 1000.0 / frames,
            readback_mib / wall.as_secs_f64(),
            map_wait.as_secs_f64() * 1000.0 / frames,
            copy_time.as_secs_f64() * 1000.0 / frames,
        );
    }

    #[test]
    #[ignore = "performance probe: requires a Windows D3D11 device"]
    fn nv12_4k_readback_benchmark() {
        const WIDTH: u32 = 3840;
        const HEIGHT: u32 = 2160;
        const ITERS: u32 = 60;

        let (device, context) = unsafe { create_d3d11_device().unwrap() };
        let source = create_internal_texture(&device, WIDTH, HEIGHT, DXGI_FORMAT_NV12, 0).unwrap();
        let staging_pool = Arc::new(StagingTexturePool::new(device.clone(), WIDTH, HEIGHT));
        let mut stats = NV12ReadbackStats::default();

        let (mut staging, _) = staging_pool.acquire().unwrap();
        unsafe {
            context.CopySubresourceRegion(&staging, 0, 0, 0, 0, &source.texture, 0, None);
            context.Flush();
        }

        let guard = Arc::new(MFInitGuard {
            media_foundation_started: false,
        });
        let (reclaim_tx, reclaim_rx) = mpsc::channel();

        let wall_start = Instant::now();
        for _ in 0..ITERS {
            let (next, reused) = staging_pool.acquire().unwrap();
            if reused {
                stats.pool_hits += 1;
            } else {
                stats.pool_misses += 1;
            }
            unsafe {
                context.CopySubresourceRegion(&next, 0, 0, 0, 0, &source.texture, 0, None);
                context.Flush();
                let data = map_nv12_staging(
                    &context,
                    staging,
                    HEIGHT,
                    &staging_pool,
                    &reclaim_tx,
                    &mut stats,
                    Arc::clone(&guard),
                )
                .unwrap();
                std::hint::black_box(data.as_slice().len());
            }
            recycle_reclaimed(&context, &staging_pool, &reclaim_rx);
            staging = next;
        }
        let wall = wall_start.elapsed();

        let frames = stats.frames as f64;
        let readback_mib = stats.bytes as f64 / (1024.0 * 1024.0);
        println!(
            "4K NV12 MF readback (2-deep, zero-copy): {:.2} ms/frame wall ({:.1} MiB/s), map {:.2} ms, immediate {}/{}, blocked {}, staging hits {}",
            wall.as_secs_f64() * 1000.0 / frames,
            readback_mib / wall.as_secs_f64(),
            stats.map_wait.as_secs_f64() * 1000.0 / frames,
            stats.map_immediate,
            stats.frames,
            stats.map_blocked,
            stats.pool_hits,
        );
        assert_eq!(stats.frames, ITERS as u64);
        assert!(stats.pool_hits + stats.pool_misses >= stats.frames);
        assert!(stats.pool_hits > 0);
    }

    fn normalized(path: &str) -> String {
        let encoded = media_foundation_path(Path::new(path));
        assert_eq!(encoded.last(), Some(&0));
        String::from_utf16(&encoded[..encoded.len().saturating_sub(1)]).unwrap()
    }

    #[test]
    fn removes_extended_drive_prefix_for_media_foundation() {
        assert_eq!(
            normalized(r"\\?\C:\Recordings\clip.mp4"),
            r"C:\Recordings\clip.mp4"
        );
    }

    #[test]
    fn restores_unc_prefix_for_media_foundation() {
        assert_eq!(
            normalized(r"\\?\UNC\server\recordings\clip.mp4"),
            r"\\server\recordings\clip.mp4"
        );
    }

    #[test]
    fn preserves_regular_unicode_paths() {
        assert_eq!(normalized(r"C:\Vidéos\录制.mp4"), r"C:\Vidéos\录制.mp4");
    }
}
