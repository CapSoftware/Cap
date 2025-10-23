// a whole bunch of credit to https://github.com/NiiightmareXD/windows-capture

#![cfg(windows)]

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::RecvError,
    },
    time::Duration,
};
use windows::{
    Foundation::{Metadata::ApiInformation, TypedEventHandler},
    Graphics::{
        Capture::{
            Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
            GraphicsCaptureSession,
        },
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX,
                D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE, D3D11_MAP_READ_WRITE,
                D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
                ID3D11DeviceContext, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{
                    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM,
                    DXGI_SAMPLE_DESC,
                },
                IDXGIDevice,
            },
        },
        System::WinRT::Direct3D11::{
            CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
        },
    },
    core::{HSTRING, IInspectable, Interface},
};

#[derive(Default, Clone, Copy, Debug)]
#[repr(i32)]
pub enum PixelFormat {
    #[default]
    R8G8B8A8Unorm,
    B8G8R8A8Unorm,
}

impl PixelFormat {
    pub fn as_directx(&self) -> DirectXPixelFormat {
        match self {
            Self::R8G8B8A8Unorm => DirectXPixelFormat::R8G8B8A8UIntNormalized,
            Self::B8G8R8A8Unorm => DirectXPixelFormat::B8G8R8A8UIntNormalized,
        }
    }

    pub fn as_dxgi(&self) -> DXGI_FORMAT {
        match self {
            Self::R8G8B8A8Unorm => DXGI_FORMAT_R8G8B8A8_UNORM,
            Self::B8G8R8A8Unorm => DXGI_FORMAT_B8G8R8A8_UNORM,
        }
    }
}

pub fn is_supported() -> windows::core::Result<bool> {
    Ok(ApiInformation::IsApiContractPresentByMajor(
        &HSTRING::from("Windows.Foundation.UniversalApiContract"),
        8,
    )? && GraphicsCaptureSession::IsSupported()?)
}

#[derive(Clone, Default, Debug)]
pub struct Settings {
    pub is_border_required: Option<bool>,
    pub is_cursor_capture_enabled: Option<bool>,
    pub min_update_interval: Option<Duration>,
    pub pixel_format: PixelFormat,
    pub crop: Option<D3D11_BOX>,
}

impl Settings {
    pub fn can_is_border_required() -> windows::core::Result<bool> {
        ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("IsBorderRequired"),
        )
    }

    pub fn can_is_cursor_capture_enabled() -> windows::core::Result<bool> {
        ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("IsCursorCaptureEnabled"),
        )
    }

    pub fn can_min_update_interval() -> windows::core::Result<bool> {
        ApiInformation::IsPropertyPresent(
            &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
            &HSTRING::from("MinUpdateInterval"),
        )
    }
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum NewCapturerError {
    #[error("NotSupported")]
    NotSupported,
    #[error("BorderNotSupported")]
    BorderNotSupported,
    #[error("CursorNotSupported")]
    CursorNotSupported,
    #[error("UpdateIntervalNotSupported")]
    UpdateIntervalNotSupported,
    #[error("CreateDevice: {0}")]
    CreateDevice(windows::core::Error),
    #[error("CreateDevice: {0}")]
    Context(windows::core::Error),
    #[error("Direct3DDevice: {0}")]
    Direct3DDevice(windows::core::Error),
    #[error("CreateDevice: {0}")]
    ItemSize(windows::core::Error),
    #[error("FramePool: {0}")]
    FramePool(windows::core::Error),
    #[error("CaptureSession: {0}")]
    CaptureSession(windows::core::Error),
    #[error("CropTexture: {0}")]
    CropTexture(windows::core::Error),
    #[error("RegisterFrameArrived: {0}")]
    RegisterFrameArrived(windows::core::Error),
    #[error("RegisterClosed: {0}")]
    RegisterClosed(windows::core::Error),
    #[error("RecvTimeout")]
    RecvTimeout(#[from] RecvError),
    #[error("Other: {0}")]
    Other(#[from] windows::core::Error),
}

pub struct Capturer {
    settings: Settings,
    d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,
    session: GraphicsCaptureSession,
    _frame_pool: Direct3D11CaptureFramePool,
}

impl Capturer {
    pub fn new(
        item: GraphicsCaptureItem,
        settings: Settings,
        mut callback: impl FnMut(Frame) -> windows::core::Result<()> + Send + 'static,
        mut closed_callback: impl FnMut() -> windows::core::Result<()> + Send + 'static,
        mut d3d_device: Option<ID3D11Device>,
    ) -> Result<Capturer, NewCapturerError> {
        if !is_supported()? {
            return Err(NewCapturerError::NotSupported);
        }

        if settings.is_border_required.is_some() && !Settings::can_is_border_required()? {
            return Err(NewCapturerError::BorderNotSupported);
        }

        if settings.is_cursor_capture_enabled.is_some()
            && !Settings::can_is_cursor_capture_enabled()?
        {
            return Err(NewCapturerError::CursorNotSupported);
        }

        if settings.min_update_interval.is_some() && !Settings::can_min_update_interval()? {
            return Err(NewCapturerError::UpdateIntervalNotSupported);
        }

        if d3d_device.is_none() {
            unsafe {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    Default::default(),
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut d3d_device),
                    None,
                    None,
                )
            }
            .map_err(NewCapturerError::CreateDevice)?;
        }

        let (d3d_device, d3d_context) = d3d_device
            .map(|d| unsafe { d.GetImmediateContext() }.map(|v| (d, v)))
            .transpose()
            .map_err(NewCapturerError::Context)?
            .unwrap();

        let item = item.clone();
        let settings = settings.clone();
        let stop_flag = Arc::new(AtomicBool::new(false));

        let direct3d_device = (|| {
            let dxgi_device = d3d_device.cast::<IDXGIDevice>()?;
            let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }?;
            inspectable.cast::<IDirect3DDevice>()
        })()
        .map_err(NewCapturerError::Direct3DDevice)?;

        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &direct3d_device,
            settings.pixel_format.as_directx(),
            1,
            item.Size().map_err(NewCapturerError::ItemSize)?,
        )
        .map_err(NewCapturerError::FramePool)?;

        let session = frame_pool
            .CreateCaptureSession(&item)
            .map_err(NewCapturerError::CaptureSession)?;

        if let Some(border_required) = settings.is_border_required {
            session.SetIsBorderRequired(border_required).unwrap();
        }

        if let Some(cursor_capture_enabled) = settings.is_cursor_capture_enabled {
            session
                .SetIsCursorCaptureEnabled(cursor_capture_enabled)
                .unwrap();
        }

        if let Some(min_update_interval) = settings.min_update_interval {
            session
                .SetMinUpdateInterval(min_update_interval.into())
                .unwrap();
        }

        let crop_data = settings
            .crop
            .map(|crop| {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: (crop.right - crop.left),
                    Height: (crop.bottom - crop.top),
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: settings.pixel_format.as_dxgi(),
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };

                let mut texture = None;
                unsafe { d3d_device.CreateTexture2D(&desc, None, Some(&mut texture)) }
                    .map_err(NewCapturerError::CropTexture)?;

                Ok::<_, NewCapturerError>((texture.unwrap(), crop))
            })
            .transpose()?;

        frame_pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new({
                    let d3d_context = d3d_context.clone();
                    let d3d_device = d3d_device.clone();

                    move |frame_pool, _| {
                        if stop_flag.load(Ordering::Relaxed) {
                            return Ok(());
                        }

                        let frame = frame_pool
                            .as_ref()
                            .expect("FrameArrived parameter was None")
                            .TryGetNextFrame()?;

                        let size = frame.ContentSize()?;

                        let surface = frame.Surface()?;
                        let dxgi_interface = surface.cast::<IDirect3DDxgiInterfaceAccess>()?;
                        let texture = unsafe { dxgi_interface.GetInterface::<ID3D11Texture2D>() }?;

                        let frame = if let Some((cropped_texture, crop)) = crop_data.clone() {
                            unsafe {
                                d3d_context.CopySubresourceRegion(
                                    &cropped_texture,
                                    0,
                                    0,
                                    0,
                                    0,
                                    &texture,
                                    0,
                                    Some(&crop),
                                );
                            }

                            Frame {
                                width: crop.right - crop.left,
                                height: crop.bottom - crop.top,
                                pixel_format: settings.pixel_format,
                                inner: frame,
                                texture: cropped_texture,
                                d3d_context: d3d_context.clone(),
                                d3d_device: d3d_device.clone(),
                            }
                        } else {
                            Frame {
                                width: size.Width as u32,
                                height: size.Height as u32,
                                pixel_format: settings.pixel_format,
                                inner: frame,
                                texture,
                                d3d_context: d3d_context.clone(),
                                d3d_device: d3d_device.clone(),
                            }
                        };

                        (callback)(frame)
                    }
                }),
            )
            .map_err(NewCapturerError::RegisterFrameArrived)?;

        item.Closed(
            &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                closed_callback()
            }),
        )
        .map_err(NewCapturerError::RegisterClosed)?;

        Ok(Capturer {
            settings,
            // thread_handle: None,
            d3d_device,
            d3d_context,
            session,
            _frame_pool: frame_pool,
        })
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn session(&self) -> &GraphicsCaptureSession {
        &self.session
    }

    pub fn d3d_device(&self) -> &ID3D11Device {
        &self.d3d_device
    }

    pub fn d3d_context(&self) -> &ID3D11DeviceContext {
        &self.d3d_context
    }
}

impl Capturer {
    pub fn start(&mut self) -> windows::core::Result<()> {
        self.session.StartCapture()
    }
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum StopCapturerError {
    #[error("NotStarted")]
    NotStarted,
    #[error("PostMessageFailed")]
    PostMessageFailed,
    #[error("ThreadJoinFailed")]
    ThreadJoinFailed,
}

impl Capturer {
    pub fn stop(&mut self) -> windows::core::Result<()> {
        self.session.Close()
    }
}

impl Drop for Capturer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub struct Frame {
    width: u32,
    height: u32,
    pixel_format: PixelFormat,
    inner: Direct3D11CaptureFrame,
    texture: ID3D11Texture2D,
    d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,
}

impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Frame")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

impl Frame {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn pixel_format(&self) -> PixelFormat {
        self.pixel_format
    }

    pub fn inner(&self) -> &Direct3D11CaptureFrame {
        &self.inner
    }

    pub fn texture(&self) -> &ID3D11Texture2D {
        &self.texture
    }

    pub fn d3d_device(&self) -> &ID3D11Device {
        &self.d3d_device
    }

    pub fn d3d_context(&self) -> &ID3D11DeviceContext {
        &self.d3d_context
    }

    pub fn as_buffer<'a>(&'a self) -> windows::core::Result<FrameBuffer<'a>> {
        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: self.width,
            Height: self.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT(DirectXPixelFormat::R8G8B8A8UIntNormalized.0), // (self.color_format as i32),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32 | D3D11_CPU_ACCESS_WRITE.0 as u32,
            MiscFlags: 0,
        };

        let mut texture = None;
        unsafe {
            self.d3d_device
                .CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
        };

        let texture = texture.unwrap();

        // Copies GPU only texture to CPU-mappable texture
        unsafe {
            self.d3d_context.CopyResource(&texture, &self.texture);
        };

        let mut mapped_resource = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.d3d_context.Map(
                &texture,
                0,
                D3D11_MAP_READ_WRITE,
                0,
                Some(&mut mapped_resource),
            )?;
        };

        let data = unsafe {
            std::slice::from_raw_parts_mut(
                mapped_resource.pData.cast(),
                (self.height * mapped_resource.RowPitch) as usize,
            )
        };

        Ok(FrameBuffer {
            data,
            width: self.width,
            height: self.height,
            stride: mapped_resource.RowPitch,
            pixel_format: self.pixel_format,
            resource: mapped_resource,
        })
    }
}

pub struct FrameBuffer<'a> {
    data: &'a mut [u8],
    width: u32,
    height: u32,
    stride: u32,
    resource: D3D11_MAPPED_SUBRESOURCE,
    pixel_format: PixelFormat,
}

impl<'a> FrameBuffer<'a> {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn stride(&self) -> u32 {
        self.stride
    }

    pub fn data(&self) -> &[u8] {
        self.data
    }

    pub fn inner(&self) -> &D3D11_MAPPED_SUBRESOURCE {
        &self.resource
    }

    pub fn pixel_format(&self) -> PixelFormat {
        self.pixel_format
    }
}
