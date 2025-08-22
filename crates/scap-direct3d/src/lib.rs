// a whole bunch of credit to https://github.com/NiiightmareXD/windows-capture

#![cfg(windows)]

use std::{
    os::windows::io::AsRawHandle,
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
        Foundation::{HANDLE, HMODULE, LPARAM, POINT, S_FALSE, WPARAM},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX,
                D3D11_CPU_ACCESS_FLAG, D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE,
                D3D11_MAP_READ_WRITE, D3D11_MAPPED_SUBRESOURCE, D3D11_RESOURCE_MISC_FLAG,
                D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{DXGI_FORMAT, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC},
                IDXGIDevice,
            },
            Gdi::{HMONITOR, MONITOR_DEFAULTTONULL, MonitorFromPoint},
        },
        System::{
            Threading::GetThreadId,
            WinRT::{
                CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT,
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                DispatcherQueueOptions,
                Graphics::Capture::IGraphicsCaptureItemInterop,
                RO_INIT_MULTITHREADED, RoInitialize,
            },
        },
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, MSG, PostThreadMessageW, TranslateMessage, WM_QUIT,
        },
    },
    core::{HSTRING, IInspectable, Interface},
};

#[derive(Default, Clone, Copy, Debug)]
#[repr(i32)]
pub enum PixelFormat {
    #[default]
    R8G8B8A8Unorm = 28,
}

impl PixelFormat {
    pub fn as_directx(&self) -> DirectXPixelFormat {
        match self {
            Self::R8G8B8A8Unorm => DirectXPixelFormat::R8G8B8A8UIntNormalized,
        }
    }

    pub fn as_dxgi(&self) -> DXGI_FORMAT {
        match self {
            Self::R8G8B8A8Unorm => DXGI_FORMAT_R8G8B8A8_UNORM,
        }
    }
}

pub fn is_supported() -> windows::core::Result<bool> {
    Ok(ApiInformation::IsApiContractPresentByMajor(
        &HSTRING::from("Windows.Foundation.UniversalApiContract"),
        8,
    )? && GraphicsCaptureSession::IsSupported()?)
}

#[derive(Default, Debug)]
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

#[derive(Debug, thiserror::Error)]
pub enum StartCapturerError {
    #[error("NotSupported")]
    NotSupported,
    #[error("BorderNotSupported")]
    BorderNotSupported,
    #[error("CursorNotSupported")]
    CursorNotSupported,
    #[error("UpdateIntervalNotSupported")]
    UpdateIntervalNotSupported,
    #[error("CreateRunner: {0}")]
    CreateRunner(#[from] CreateRunnerError),
    #[error("RecvTimeout")]
    RecvTimeout(#[from] RecvError),
    #[error("Other: {0}")]
    Other(#[from] windows::core::Error),
}

pub struct Capturer {
    item: GraphicsCaptureItem,
    settings: Settings,
}

impl Capturer {
    pub fn new(item: GraphicsCaptureItem, settings: Settings) -> Self {
        Self { item, settings }
    }

    pub fn start(
        self,
        callback: impl FnMut(Frame) -> windows::core::Result<()> + Send + 'static,
        closed_callback: impl FnMut() -> windows::core::Result<()> + Send + 'static,
    ) -> Result<CaptureHandle, StartCapturerError> {
        if !is_supported()? {
            return Err(StartCapturerError::NotSupported);
        }

        if self.settings.is_border_required.is_some() && !Settings::can_is_border_required()? {
            return Err(StartCapturerError::BorderNotSupported);
        }

        if self.settings.is_cursor_capture_enabled.is_some()
            && !Settings::can_is_cursor_capture_enabled()?
        {
            return Err(StartCapturerError::CursorNotSupported);
        }

        if self.settings.min_update_interval.is_some() && !Settings::can_min_update_interval()? {
            return Err(StartCapturerError::UpdateIntervalNotSupported);
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let thread_handle = std::thread::spawn({
            let stop_flag = stop_flag.clone();
            move || {
                let runner = Runner::start(
                    self.item,
                    self.settings,
                    callback,
                    closed_callback,
                    stop_flag,
                );

                let runner = match runner {
                    Ok(runner) => {
                        started_tx.send(Ok(()));
                        runner
                    }
                    Err(e) => {
                        started_tx.send(Err(e));
                        return;
                    }
                };

                runner.run();
            }
        });

        started_rx.recv()??;

        Ok(CaptureHandle {
            stop_flag,
            thread_handle,
        })
    }
}

pub struct CaptureHandle {
    stop_flag: Arc<AtomicBool>,
    thread_handle: std::thread::JoinHandle<()>,
}

impl CaptureHandle {
    pub fn stop(self) -> Result<(), &'static str> {
        self.stop_flag.store(true, Ordering::Relaxed);

        let handle = HANDLE(self.thread_handle.as_raw_handle());
        let thread_id = unsafe { GetThreadId(handle) };

        while let Err(e) =
            unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM::default(), LPARAM::default()) }
        {
            if self.thread_handle.is_finished() {
                break;
            }

            if e.code().0 != -2147023452 {
                return Err("Failed to post message");
            }
        }

        self.thread_handle.join().map_err(|_| "Join failed")
    }
}

pub struct Frame<'a> {
    width: u32,
    height: u32,
    pixel_format: PixelFormat,
    inner: Direct3D11CaptureFrame,
    texture: ID3D11Texture2D,
    d3d_device: &'a ID3D11Device,
    d3d_context: &'a ID3D11DeviceContext,
}

impl<'a> std::fmt::Debug for Frame<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Frame")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

impl<'a> Frame<'a> {
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

    pub fn as_buffer(&self) -> windows::core::Result<FrameBuffer<'a>> {
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

#[derive(Debug, thiserror::Error)]
pub enum CreateRunnerError {
    #[error("Failed to initialize WinRT")]
    FailedToInitializeWinRT,
    #[error("DispatchQueue: {0}")]
    DispatchQueue(windows::core::Error),
    #[error("D3DDevice: {0}")]
    D3DDevice(windows::core::Error),
    #[error("Direct3DDevice: {0}")]
    Direct3DDevice(windows::core::Error),
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
    #[error("StartCapture: {0}")]
    StartCapture(windows::core::Error),
    #[error("Other: {0}")]
    Other(#[from] windows::core::Error),
}

struct Runner {
    _session: GraphicsCaptureSession,
    _frame_pool: Direct3D11CaptureFramePool,
}

impl Runner {
    fn start(
        item: GraphicsCaptureItem,
        settings: Settings,
        mut callback: impl FnMut(Frame) -> windows::core::Result<()> + Send + 'static,
        mut closed_callback: impl FnMut() -> windows::core::Result<()> + Send + 'static,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Self, CreateRunnerError> {
        if let Err(e) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            && e.code() != S_FALSE
        {
            return Err(CreateRunnerError::FailedToInitializeWinRT);
        }

        let queue_options = DispatcherQueueOptions {
            dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
            threadType: DQTYPE_THREAD_CURRENT,
            apartmentType: DQTAT_COM_NONE,
        };

        let _controller = unsafe { CreateDispatcherQueueController(queue_options) }
            .map_err(CreateRunnerError::DispatchQueue)?;

        let mut d3d_device = None;
        let mut d3d_context = None;

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
                Some(&mut d3d_context),
            )
        }
        .map_err(CreateRunnerError::D3DDevice)?;

        let d3d_device = d3d_device.unwrap();
        let d3d_context = d3d_context.unwrap();

        let direct3d_device = (|| {
            let dxgi_device = d3d_device.cast::<IDXGIDevice>()?;
            let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }?;
            inspectable.cast::<IDirect3DDevice>()
        })()
        .map_err(CreateRunnerError::Direct3DDevice)?;

        let frame_pool = Direct3D11CaptureFramePool::Create(
            &direct3d_device,
            PixelFormat::R8G8B8A8Unorm.as_directx(),
            1,
            item.Size()?,
        )
        .map_err(CreateRunnerError::FramePool)?;

        let session = frame_pool
            .CreateCaptureSession(&item)
            .map_err(CreateRunnerError::CaptureSession)?;

        if let Some(border_required) = settings.is_border_required {
            session.SetIsBorderRequired(border_required)?;
        }

        if let Some(cursor_capture_enabled) = settings.is_cursor_capture_enabled {
            session.SetIsCursorCaptureEnabled(cursor_capture_enabled)?;
        }

        if let Some(min_update_interval) = settings.min_update_interval {
            session.SetMinUpdateInterval(min_update_interval.into())?;
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
                    .map_err(CreateRunnerError::CropTexture)?;

                Ok::<_, CreateRunnerError>((texture.unwrap(), crop))
            })
            .transpose()?;

        frame_pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
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
                                d3d_context: &d3d_context,
                                d3d_device: &d3d_device,
                            }
                        } else {
                            Frame {
                                width: size.Width as u32,
                                height: size.Height as u32,
                                pixel_format: settings.pixel_format,
                                inner: frame,
                                texture,
                                d3d_context: &d3d_context,
                                d3d_device: &d3d_device,
                            }
                        };

                        (callback)(frame)
                    },
                ),
            )
            .map_err(CreateRunnerError::RegisterFrameArrived)?;

        item.Closed(
            &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                closed_callback()
            }),
        )
        .map_err(CreateRunnerError::RegisterClosed)?;

        session
            .StartCapture()
            .map_err(CreateRunnerError::StartCapture)?;

        Ok(Self {
            _session: session,
            _frame_pool: frame_pool,
        })
    }

    fn run(self) {
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
            let _ = unsafe { TranslateMessage(&message) };
            unsafe { DispatchMessageW(&message) };
        }
    }
}
