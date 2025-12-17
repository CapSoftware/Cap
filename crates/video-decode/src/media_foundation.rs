use std::path::Path;
use tracing::info;
use windows::{
    Win32::{
        Foundation::{HANDLE, HMODULE},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{
                D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
                ID3D11DeviceContext, ID3D11Texture2D,
            },
            Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC},
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

pub struct MFDecodedFrame {
    pub texture: ID3D11Texture2D,
    pub shared_handle: Option<HANDLE>,
    pub y_texture: Option<ID3D11Texture2D>,
    pub y_handle: Option<HANDLE>,
    pub uv_texture: Option<ID3D11Texture2D>,
    pub uv_handle: Option<HANDLE>,
    pub width: u32,
    pub height: u32,
    pub pts: i64,
}

pub struct NV12Data {
    pub data: Vec<u8>,
    pub y_stride: u32,
    pub uv_stride: u32,
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

        info!(
            "MediaFoundation decoder initialized: {}x{} @ {}/{}fps",
            width, height, frame_rate_num, frame_rate_den
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

        let (output_texture, shared_handle) = unsafe {
            copy_texture_subresource(
                &self.d3d11_device,
                &self.d3d11_context,
                &texture,
                subresource_index,
                self.width,
                self.height,
            )?
        };

        let yuv_planes = unsafe {
            create_yuv_plane_textures(
                &self.d3d11_device,
                &self.d3d11_context,
                &output_texture,
                self.width,
                self.height,
            )
            .ok()
        };

        let (y_texture, y_handle, uv_texture, uv_handle) = yuv_planes
            .map(|p| {
                (
                    Some(p.y_texture),
                    p.y_handle,
                    Some(p.uv_texture),
                    p.uv_handle,
                )
            })
            .unwrap_or((None, None, None, None));

        Ok(Some(MFDecodedFrame {
            texture: output_texture,
            shared_handle,
            y_texture,
            y_handle,
            uv_texture,
            uv_handle,
            width: self.width,
            height: self.height,
            pts: timestamp,
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

    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;

    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            flags,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|e| format!("D3D11CreateDevice failed: {e:?}"))?;
    }

    let device = device.ok_or("D3D11CreateDevice returned null device")?;
    let context = context.ok_or("D3D11CreateDevice returned null context")?;

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

struct YuvPlaneTextures {
    y_texture: ID3D11Texture2D,
    y_handle: Option<HANDLE>,
    uv_texture: ID3D11Texture2D,
    uv_handle: Option<HANDLE>,
}

unsafe fn create_yuv_plane_textures(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    nv12_texture: &ID3D11Texture2D,
    width: u32,
    height: u32,
) -> Result<YuvPlaneTextures, String> {
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM};

    let y_desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let mut y_texture: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&y_desc, None, Some(&mut y_texture))
            .map_err(|e| format!("CreateTexture2D Y failed: {e:?}"))?;
    }
    let y_texture = y_texture.ok_or("CreateTexture2D Y returned null")?;

    let uv_desc = D3D11_TEXTURE2D_DESC {
        Width: width / 2,
        Height: height / 2,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8G8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let mut uv_texture: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&uv_desc, None, Some(&mut uv_texture))
            .map_err(|e| format!("CreateTexture2D UV failed: {e:?}"))?;
    }
    let uv_texture = uv_texture.ok_or("CreateTexture2D UV returned null")?;

    unsafe {
        context.CopySubresourceRegion(
            &y_texture,
            0,
            0,
            0,
            0,
            nv12_texture,
            0,
            Some(&windows::Win32::Graphics::Direct3D11::D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: width,
                bottom: height,
                back: 1,
            }),
        );

        context.CopySubresourceRegion(
            &uv_texture,
            0,
            0,
            0,
            0,
            nv12_texture,
            1,
            Some(&windows::Win32::Graphics::Direct3D11::D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: width / 2,
                bottom: height / 2,
                back: 1,
            }),
        );
    }

    Ok(YuvPlaneTextures {
        y_texture,
        y_handle: None,
        uv_texture,
        uv_handle: None,
    })
}

unsafe fn copy_texture_subresource(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    source: &ID3D11Texture2D,
    subresource_index: u32,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, Option<HANDLE>), String> {
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
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let mut output_texture: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut output_texture))
            .map_err(|e| format!("CreateTexture2D failed: {e:?}"))?;
    }

    let output_texture = output_texture.ok_or("CreateTexture2D returned null")?;

    unsafe {
        context.CopySubresourceRegion(&output_texture, 0, 0, 0, 0, source, subresource_index, None);
    }

    Ok((output_texture, None))
}

unsafe impl Send for MediaFoundationDecoder {}
