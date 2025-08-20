// a whole bunch of credit to https://github.com/NiiightmareXD/windows-capture

#![cfg(windows)]

use std::{
    os::windows::io::AsRawHandle,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use windows::{
    Foundation::{TypedEventHandler, Metadata::ApiInformation},
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem},
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
    core::{IInspectable, Interface, HSTRING},
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

#[derive(Default, Debug)]
pub struct Settings {
    pub is_border_required: Option<bool>,
    pub is_cursor_capture_enabled: Option<bool>,
    pub min_update_interval: Option<Duration>,
    pub pixel_format: PixelFormat,
    pub crop: Option<D3D11_BOX>,
}

impl Settings {
	pub fn can_is_border_required(&self) -> windows::core::Result<bool> {
		Ok(ApiInformation::IsPropertyPresent(
			&HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
			&HSTRING::from("IsCursorCaptureEnabled"),
		))
	}

	pub fn can_is_cursor_capture_enabled(&self) -> windows::core::Result<bool> {
		Ok(ApiInformation::IsPropertyPresent(
			&HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
			&HSTRING::from("IsBorderRequired"),
		))
	}

	pub fn can_min_update_interval(&self) -> windows::core::Result<bool> {
		Ok(ApiInformation::IsPropertyPresent(
			&HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
			&HSTRING::from("MinUpdateInterval"),
		))
	}
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
    ) -> CaptureHandle {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_handle = std::thread::spawn({
            let stop_flag = stop_flag.clone();
            move || {
                run(
                    self.item,
                    self.settings,
                    callback,
                    closed_callback,
                    stop_flag,
                );
            }
        });

        CaptureHandle {
            stop_flag,
            thread_handle,
        }
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

fn run(
    item: GraphicsCaptureItem,
    settings: Settings,
    mut callback: impl FnMut(Frame) -> windows::core::Result<()> + Send + 'static,
    mut closed_callback: impl FnMut() -> windows::core::Result<()> + Send + 'static,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), &'static str> {
    if let Err(e) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        && e.code() != S_FALSE
    {
        return Err("Failed to initialise WinRT");
    }

    let queue_options = DispatcherQueueOptions {
        dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
        threadType: DQTYPE_THREAD_CURRENT,
        apartmentType: DQTAT_COM_NONE,
    };

    let _controller = unsafe { CreateDispatcherQueueController(queue_options) }
        .map_err(|_| "Failed to create dispatcher queue controller")?;

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
    .map_err(|_| "Failed to create d3d11 device")?;

    let d3d_device = d3d_device.unwrap();
    let d3d_context = d3d_context.unwrap();

    let direct3d_device = (|| {
        let dxgi_device = d3d_device.cast::<IDXGIDevice>()?;
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }?;
        inspectable.cast::<IDirect3DDevice>()
    })()
    .map_err(|_| "Failed to create direct3d device")?;

    let frame_pool = Direct3D11CaptureFramePool::Create(
        &direct3d_device,
        PixelFormat::R8G8B8A8Unorm.as_directx(),
        1,
        item.Size().map_err(|_| "Item size")?,
    )
    .map_err(|_| "Failed to create frame pool")?;

    let session = frame_pool
        .CreateCaptureSession(&item)
        .map_err(|_| "Failed to create capture session")?;

    if let Some(border_required) = settings.is_border_required {
        session
            .SetIsBorderRequired(border_required)
            .map_err(|_| "Failed to set border required")?;
    }

    if let Some(cursor_capture_enabled) = settings.is_cursor_capture_enabled {
        session
            .SetIsCursorCaptureEnabled(cursor_capture_enabled)
            .map_err(|_| "Failed to set cursor capture enabled")?;
    }

    if let Some(min_update_interval) = settings.min_update_interval {
        session
            .SetMinUpdateInterval(min_update_interval.into())
            .map_err(|_| "Failed to set min update interval")?;
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
            unsafe { d3d_device.CreateTexture2D(&desc, None, Some(&mut texture)) }?;

            Ok::<_, windows::core::Error>((
                texture.ok_or(windows::core::Error::from_hresult(S_FALSE))?,
                crop,
            ))
        })
        .transpose()
        .map_err(|_| "Failed to create crop texture")?;

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
        .map_err(|_| "Failed to register frame arrived handler")?;

    item.Closed(
        &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| closed_callback()),
    )
    .map_err(|_| "Failed to register closed handler")?;

    session
        .StartCapture()
        .map_err(|_| "Failed to start capture")?;

    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        let _ = unsafe { TranslateMessage(&message) };
        unsafe { DispatchMessageW(&message) };
    }

    Ok(())
}
