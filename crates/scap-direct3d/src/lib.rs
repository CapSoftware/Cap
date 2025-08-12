use std::{
    os::windows::io::AsRawHandle,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use windows::{
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{HANDLE, HMODULE, LPARAM, POINT, S_FALSE, WPARAM},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{D3D11_SDK_VERSION, D3D11CreateDevice},
            Dxgi::IDXGIDevice,
            Gdi::{HMONITOR, MONITOR_DEFAULTTONULL, MonitorFromPoint},
        },
        System::{
            Threading::GetThreadId,
            WinRT::{
                CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT,
                Direct3D11::CreateDirect3D11DeviceFromDXGIDevice, DispatcherQueueOptions,
                Graphics::Capture::IGraphicsCaptureItemInterop, RO_INIT_MULTITHREADED,
                RoInitialize,
            },
        },
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, MSG, PostThreadMessageW, TranslateMessage, WM_QUIT,
        },
    },
    core::{IInspectable, Interface},
};

#[derive(Clone)]
pub struct CaptureItem {
    inner: GraphicsCaptureItem,
}

pub struct Display {
    inner: HMONITOR,
}

impl Display {
    pub fn primary() -> Option<Self> {
        let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTONULL) };
        if monitor.is_invalid() {
            return None;
        }
        Some(Self { inner: monitor })
    }

    pub fn try_as_capture_item(&self) -> windows::core::Result<CaptureItem> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let inner = unsafe { interop.CreateForMonitor(self.inner) }?;

        Ok(CaptureItem { inner })
    }
}

#[derive(Default)]
pub struct Settings {
    pub is_border_required: Option<bool>,
    pub is_cursor_capture_enabled: Option<bool>,
}

pub struct Capturer {
    item: CaptureItem,
    settings: Settings,
}

impl Capturer {
    pub fn new(item: CaptureItem, settings: Settings) -> Self {
        Self { item, settings }
    }

    pub fn start(
        self,
        callback: impl FnMut(Direct3D11CaptureFrame) -> windows::core::Result<()> + Send + 'static,
    ) -> CaptureHandle {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_handle = std::thread::spawn({
            let stop_flag = stop_flag.clone();
            move || {
                let _ = dbg!(run(self.item, self.settings, callback, stop_flag));
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

fn run(
    item: CaptureItem,
    settings: Settings,
    mut callback: impl FnMut(Direct3D11CaptureFrame) -> windows::core::Result<()> + Send + 'static,
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
    let _d3d_context = d3d_context.unwrap();

    let direct3d_device = (|| {
        let dxgi_device = d3d_device.cast::<IDXGIDevice>()?;
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }?;
        inspectable.cast::<IDirect3DDevice>()
    })()
    .map_err(|_| "Failed to create direct3d device")?;

    let frame_pool = Direct3D11CaptureFramePool::Create(
        &direct3d_device,
        DirectXPixelFormat::R8G8B8A8UIntNormalized,
        1,
        item.inner.Size().map_err(|_| "Item size")?,
    )
    .map_err(|_| "Failed to create frame pool")?;

    let session = frame_pool
        .CreateCaptureSession(&item.inner)
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

    let _frame_arrived_token = frame_pool
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

                    (callback)(frame)
                },
            ),
        )
        .map_err(|_| "Failed to register frame arrived handler")?;

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
