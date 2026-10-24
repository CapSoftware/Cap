#![cfg(windows)]

mod windows_version;

pub use windows_version::WindowsVersion;

use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::RecvError,
    },
    time::{Duration, Instant},
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
            Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX,
                D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                D3D11_CREATE_DEVICE_FLAG, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                D3D11_MAP_FLAG_DO_NOT_WAIT, D3D11_MAP_READ, D3D11_MAP_WRITE,
                D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
                ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{
                    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM,
                    DXGI_SAMPLE_DESC,
                },
                DXGI_ERROR_UNSUPPORTED, DXGI_ERROR_WAS_STILL_DRAWING, IDXGIDevice,
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

const STAGING_POOL_SIZE: usize = 3;
const STAGING_POOL_LIMIT: usize = STAGING_POOL_SIZE + 1;
const STAGING_PADDING_ROWS: u32 = 1;
const READBACK_RETRY_INTERVAL: Duration = Duration::from_micros(100);
const READBACK_SPIN_BUDGET: Duration = Duration::from_millis(4);

struct CallbackActivity {
    active: Mutex<usize>,
    idle: Condvar,
}

impl CallbackActivity {
    fn new() -> Self {
        Self {
            active: Mutex::new(0),
            idle: Condvar::new(),
        }
    }

    fn enter(self: &Arc<Self>) -> CallbackActivityGuard {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active += 1;

        CallbackActivityGuard {
            activity: self.clone(),
        }
    }

    fn leave(&self) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if *active > 0 {
            *active -= 1;
        }

        if *active == 0 {
            self.idle.notify_all();
        }
    }

    fn wait_idle(&self, timeout: Duration) {
        let started = Instant::now();
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        while *active > 0 {
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }

            match self.idle.wait_timeout(active, remaining) {
                Ok((next_guard, wait_result)) => {
                    active = next_guard;
                    if wait_result.timed_out() {
                        break;
                    }
                }
                Err(poisoned) => {
                    let (next_guard, _) = poisoned.into_inner();
                    active = next_guard;
                }
            }
        }
    }
}

struct CallbackActivityGuard {
    activity: Arc<CallbackActivity>,
}

impl Drop for CallbackActivityGuard {
    fn drop(&mut self) {
        self.activity.leave();
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ReadbackError {
    #[error("D3D11: {0}")]
    D3D11(#[from] windows::core::Error),
    #[error("every staging texture is in flight")]
    StagingBusy,
    #[error("the GPU did not finish the readback before the deadline")]
    NotReady,
    #[error("failed to allocate the frame buffer reference")]
    FrameBufferAllocation,
}

struct PooledStagingTexture {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
}

struct StagingPoolInner {
    free: Vec<PooledStagingTexture>,
    live: usize,
}

pub struct StagingTexturePool {
    inner: Mutex<StagingPoolInner>,
    d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,
    pixel_format: PixelFormat,
}

impl StagingTexturePool {
    fn new(
        d3d_device: ID3D11Device,
        d3d_context: ID3D11DeviceContext,
        pixel_format: PixelFormat,
    ) -> Self {
        Self {
            inner: Mutex::new(StagingPoolInner {
                free: Vec::with_capacity(STAGING_POOL_SIZE),
                live: 0,
            }),
            d3d_device,
            d3d_context,
            pixel_format,
        }
    }

    fn acquire(self: &Arc<Self>, width: u32, height: u32) -> Result<StagingLease, ReadbackError> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(index) = inner
            .free
            .iter()
            .position(|pooled| pooled.width == width && pooled.height == height)
        {
            let pooled = inner.free.swap_remove(index);
            return Ok(StagingLease {
                pool: self.clone(),
                texture: pooled.texture,
                width,
                height,
            });
        }

        if inner.live >= STAGING_POOL_LIMIT {
            // A cached texture at another size is idle, so it can be released. Without this a
            // geometry change can wedge the pool at the limit while the previous frame is still
            // mapped, and every frame at the new size is dropped.
            let stale = inner
                .free
                .iter()
                .position(|pooled| pooled.width != width || pooled.height != height)
                .ok_or(ReadbackError::StagingBusy)?;
            inner.free.swap_remove(stale);
            inner.live -= 1;
        }

        let texture = create_staging_texture(
            &self.d3d_device,
            &self.d3d_context,
            self.pixel_format,
            width,
            height,
        )?;
        inner.live += 1;

        Ok(StagingLease {
            pool: self.clone(),
            texture,
            width,
            height,
        })
    }

    fn recycle(&self, texture: &ID3D11Texture2D, width: u32, height: u32) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if inner.free.len() < STAGING_POOL_SIZE {
            inner.free.push(PooledStagingTexture {
                texture: texture.clone(),
                width,
                height,
            });
        } else if let Some(slot) = inner
            .free
            .iter_mut()
            .find(|pooled| pooled.width != width || pooled.height != height)
        {
            // Capture size changed: keep the cache on the current geometry instead of allocating a
            // fresh texture per frame while the stale sizes sit unused.
            *slot = PooledStagingTexture {
                texture: texture.clone(),
                width,
                height,
            };
            // The replaced texture is dropped; the recycled one was an outstanding lease, so the
            // pool now owns one fewer texture.
            inner.live -= 1;
        } else {
            inner.live -= 1;
        }
    }
}

struct StagingLease {
    pool: Arc<StagingTexturePool>,
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
}

impl Drop for StagingLease {
    fn drop(&mut self) {
        self.pool.recycle(&self.texture, self.width, self.height);
    }
}

fn create_staging_texture(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    pixel_format: PixelFormat,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, ReadbackError> {
    let texture_desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height + STAGING_PADDING_ROWS,
        MipLevels: 1,
        ArraySize: 1,
        Format: pixel_format.as_dxgi(),
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
        device.CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
    };
    let texture = texture.ok_or_else(windows::core::Error::from_win32)?;
    zero_padding_row(context, &texture, height)?;

    Ok(texture)
}

// ffmpeg may read up to AV_INPUT_BUFFER_PADDING_SIZE bytes past the last pixel and requires them
// to be zero. The staging texture carries one extra row for that, zeroed once because copies only
// ever touch the image rows.
fn zero_padding_row(
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
    image_height: u32,
) -> Result<(), ReadbackError> {
    let mut mapped_resource = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        context.Map(texture, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped_resource))?;

        let padding = (mapped_resource.pData as *mut u8)
            .add(mapped_resource.RowPitch as usize * image_height as usize);
        std::ptr::write_bytes(padding, 0, mapped_resource.RowPitch as usize);

        context.Unmap(texture, 0);
    };

    Ok(())
}

pub struct MappedFrame {
    lease: StagingLease,
    d3d_context: ID3D11DeviceContext,
    data: *mut u8,
    row_pitch: u32,
    width: u32,
    height: u32,
    pixel_format: PixelFormat,
}

// SAFETY: the mapped staging memory belongs to the GPU resource, not to a thread; the only thread
// that touches the mapping owns this value, and the driver serializes the context (the capturer
// enables multithread protection). The AVBuffer built from it may be released on another thread,
// which only runs `Unmap` and returns the texture to the pool.
unsafe impl Send for MappedFrame {}

impl std::fmt::Debug for MappedFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MappedFrame")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("row_pitch", &self.row_pitch)
            .finish()
    }
}

impl Drop for MappedFrame {
    fn drop(&mut self) {
        unsafe {
            self.d3d_context.Unmap(&self.lease.texture, 0);
        }
    }
}

impl MappedFrame {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn row_pitch(&self) -> u32 {
        self.row_pitch
    }

    pub fn pixel_format(&self) -> PixelFormat {
        self.pixel_format
    }

    pub fn data_ptr(&self) -> *mut u8 {
        self.data
    }

    pub fn data_len(&self) -> usize {
        self.row_pitch as usize * (self.height as usize + STAGING_PADDING_ROWS as usize)
    }

    pub fn as_slice(&self) -> &[u8] {
        unsafe {
            std::slice::from_raw_parts(self.data, self.height as usize * self.row_pitch as usize)
        }
    }
}

pub fn is_supported() -> windows::core::Result<bool> {
    Ok(ApiInformation::IsApiContractPresentByMajor(
        &HSTRING::from("Windows.Foundation.UniversalApiContract"),
        8,
    )? && GraphicsCaptureSession::IsSupported()?)
}

fn create_d3d_device_with_type(
    driver_type: D3D_DRIVER_TYPE,
    flags: D3D11_CREATE_DEVICE_FLAG,
    device: *mut Option<ID3D11Device>,
) -> windows::core::Result<()> {
    unsafe {
        D3D11CreateDevice(
            None,
            driver_type,
            HMODULE::default(),
            flags,
            None,
            D3D11_SDK_VERSION,
            Some(device),
            None,
            None,
        )
    }
}

fn create_d3d_device_on_pinned_adapter(
    flags: D3D11_CREATE_DEVICE_FLAG,
    device: *mut Option<ID3D11Device>,
) -> Result<String, String> {
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;

    let selected = cap_d3d_adapter::select_capture_adapter(None)?;

    unsafe {
        D3D11CreateDevice(
            Some(&selected.adapter),
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            flags,
            None,
            D3D11_SDK_VERSION,
            Some(device),
            None,
            None,
        )
        .map_err(|e| {
            format!(
                "D3D11CreateDevice failed on '{}': {e:?}",
                selected.description
            )
        })?;
    }

    Ok(selected.description)
}

fn create_d3d_device_with_warp_fallback() -> windows::core::Result<(ID3D11Device, bool)> {
    let mut device = None;
    let video_flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    let basic_flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;

    match create_d3d_device_on_pinned_adapter(video_flags, &mut device) {
        Ok(description) => {
            tracing::info!(
                adapter = %description,
                "scap-direct3d: D3D11 device created on pinned hardware adapter with video support"
            );
            let device = device.ok_or_else(windows::core::Error::from_win32)?;
            return Ok((device, false));
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "scap-direct3d: video-support device creation failed on pinned adapter, retrying without it"
            );
        }
    }

    match create_d3d_device_on_pinned_adapter(basic_flags, &mut device) {
        Ok(description) => {
            tracing::info!(
                adapter = %description,
                "scap-direct3d: D3D11 device created on pinned hardware adapter"
            );
            let device = device.ok_or_else(windows::core::Error::from_win32)?;
            return Ok((device, false));
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "scap-direct3d: pinned-adapter device creation failed, attempting default-hardware path"
            );
        }
    }

    let result = create_d3d_device_with_type(D3D_DRIVER_TYPE_HARDWARE, basic_flags, &mut device);

    match result {
        Ok(()) => Ok((device.ok_or_else(windows::core::Error::from_win32)?, false)),
        Err(e) if e.code() == DXGI_ERROR_UNSUPPORTED => {
            tracing::info!("Hardware D3D11 device unavailable, attempting WARP fallback");
            create_d3d_device_with_type(D3D_DRIVER_TYPE_WARP, basic_flags, &mut device)?;
            Ok((device.ok_or_else(windows::core::Error::from_win32)?, true))
        }
        Err(e) => Err(e),
    }
}

#[derive(Clone, Default, Debug)]
pub struct Settings {
    pub is_border_required: Option<bool>,
    pub is_cursor_capture_enabled: Option<bool>,
    pub min_update_interval: Option<Duration>,
    pub pixel_format: PixelFormat,
    pub crop: Option<D3D11_BOX>,
    pub fps: Option<u32>,
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
    #[error("Screen capture requires Windows 10 version 1903 (build 18362) or later")]
    WindowsVersionTooOld,
    #[error(
        "Windows Graphics Capture API is disabled or unavailable. This may be due to group policy or missing system components."
    )]
    GraphicsCaptureDisabled,
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
    frame_pool: Direct3D11CaptureFramePool,
    frame_arrived_token: i64,
    stop_flag: Arc<AtomicBool>,
    callback_activity: Arc<CallbackActivity>,
    is_using_warp: bool,
}

impl Capturer {
    pub fn new(
        item: GraphicsCaptureItem,
        settings: Settings,
        mut callback: impl FnMut(Frame) -> windows::core::Result<()> + Send + 'static,
        mut closed_callback: impl FnMut() -> windows::core::Result<()> + Send + 'static,
        d3d_device: Option<ID3D11Device>,
    ) -> Result<Capturer, NewCapturerError> {
        if let Some(version) = WindowsVersion::detect() {
            tracing::debug!(
                version = %version.display_name(),
                meets_requirements = version.meets_minimum_requirements(),
                "Initializing screen capture"
            );

            if !version.meets_minimum_requirements() {
                tracing::error!(
                    version = %version.display_name(),
                    required = "Windows 10 version 1903 (build 18362)",
                    "Windows version does not meet minimum requirements"
                );
                return Err(NewCapturerError::WindowsVersionTooOld);
            }
        }

        let api_present = ApiInformation::IsApiContractPresentByMajor(
            &HSTRING::from("Windows.Foundation.UniversalApiContract"),
            8,
        )
        .unwrap_or(false);

        if !api_present {
            return Err(NewCapturerError::WindowsVersionTooOld);
        }

        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err(NewCapturerError::GraphicsCaptureDisabled);
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

        let (d3d_device, is_using_warp) = if let Some(device) = d3d_device {
            (device, false)
        } else {
            create_d3d_device_with_warp_fallback().map_err(NewCapturerError::CreateDevice)?
        };

        let (d3d_device, d3d_context) = Some(d3d_device)
            .map(|d| unsafe { d.GetImmediateContext() }.map(|v| (d, v)))
            .transpose()
            .map_err(NewCapturerError::Context)?
            .unwrap();

        if let Ok(multithread) = d3d_device.cast::<ID3D11Multithread>() {
            unsafe {
                let _ = multithread.SetMultithreadProtected(true);
            }
        }

        let staging_pool = Arc::new(StagingTexturePool::new(
            d3d_device.clone(),
            d3d_context.clone(),
            settings.pixel_format,
        ));

        let item = item.clone();
        let settings = settings.clone();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let callback_activity = Arc::new(CallbackActivity::new());

        let direct3d_device = (|| {
            let dxgi_device = d3d_device.cast::<IDXGIDevice>()?;
            let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }?;
            inspectable.cast::<IDirect3DDevice>()
        })()
        .map_err(NewCapturerError::Direct3DDevice)?;

        let frame_pool_size = settings
            .fps
            .map(|fps| ((fps as f32 / 30.0 * 2.0).ceil() as i32).clamp(2, 4))
            .unwrap_or(2);

        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &direct3d_device,
            settings.pixel_format.as_directx(),
            frame_pool_size,
            item.Size().map_err(NewCapturerError::ItemSize)?,
        )
        .map_err(NewCapturerError::FramePool)?;

        let session = frame_pool
            .CreateCaptureSession(&item)
            .map_err(NewCapturerError::CaptureSession)?;

        if let Some(border_required) = settings.is_border_required {
            session
                .SetIsBorderRequired(border_required)
                .map_err(NewCapturerError::Other)?;
        }

        if let Some(cursor_capture_enabled) = settings.is_cursor_capture_enabled {
            session
                .SetIsCursorCaptureEnabled(cursor_capture_enabled)
                .map_err(NewCapturerError::Other)?;
        }

        if let Some(min_update_interval) = settings.min_update_interval {
            session
                .SetMinUpdateInterval(min_update_interval.into())
                .map_err(NewCapturerError::Other)?;
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

                let texture = texture.ok_or_else(|| {
                    NewCapturerError::CropTexture(windows::core::Error::from_win32())
                })?;

                Ok::<_, NewCapturerError>((texture, crop))
            })
            .transpose()?;

        let frame_arrived_token = frame_pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new({
                    let d3d_context = d3d_context.clone();
                    let d3d_device = d3d_device.clone();
                    let stop_flag = stop_flag.clone();
                    let staging_pool = staging_pool.clone();
                    let callback_activity = callback_activity.clone();

                    move |frame_pool, _| {
                        let _activity_guard = callback_activity.enter();

                        if stop_flag.load(Ordering::Relaxed) {
                            return Ok(());
                        }

                        let Some(frame_pool) = frame_pool.as_ref() else {
                            return Ok(());
                        };

                        let frame = frame_pool.TryGetNextFrame()?;

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
                                staging_pool: staging_pool.clone(),
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
                                staging_pool: staging_pool.clone(),
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

        if is_using_warp {
            tracing::warn!(
                "Hardware GPU unavailable, using WARP software rasterizer for screen capture"
            );
        }

        Ok(Capturer {
            settings,
            d3d_device,
            d3d_context,
            session,
            frame_pool,
            frame_arrived_token,
            stop_flag,
            callback_activity,
            is_using_warp,
        })
    }

    pub fn is_using_software_rendering(&self) -> bool {
        self.is_using_warp
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
        if self.stop_flag.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.frame_pool.RemoveFrameArrived(self.frame_arrived_token);
        self.callback_activity.wait_idle(Duration::from_secs(2));
        let _ = self.session.Close();
        self.frame_pool.Close()
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
    staging_pool: Arc<StagingTexturePool>,
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

    /// Copies the frame into a staging texture and maps it, blocking until the GPU copy is done.
    /// Use [`Self::map_readback`] on latency-sensitive paths.
    pub fn as_buffer(&self) -> Result<FrameBuffer<'_>, ReadbackError> {
        let lease = self.staging_pool.acquire(self.width, self.height)?;
        self.copy_into_staging(&lease);
        let mapped = self.map_staging(lease, None)?;

        Ok(FrameBuffer {
            mapped,
            frame: std::marker::PhantomData,
        })
    }

    /// Copies the frame into a staging texture and maps it within `budget`. The default polls
    /// `DO_NOT_WAIT` until the copy completes or the budget expires; the caller can reuse the
    /// previous frame on `NotReady`. Set `CAP_READBACK_BLOCKING` to block in `Map` instead, which is
    /// faster when the copy consistently finishes quickly but removes the deadline.
    pub fn map_readback(&self, budget: Duration) -> Result<MappedFrame, ReadbackError> {
        let blocking = std::env::var_os("CAP_READBACK_BLOCKING").is_some();
        let lease = self.staging_pool.acquire(self.width, self.height)?;
        self.copy_into_staging(&lease);

        if blocking {
            return self.map_staging_hybrid(lease);
        }

        let deadline = Instant::now().checked_add(budget);
        self.map_staging(lease, deadline)
    }

    fn copy_into_staging(&self, lease: &StagingLease) {
        let source_box = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: self.width,
            bottom: self.height,
            back: 1,
        };

        unsafe {
            self.d3d_context.CopySubresourceRegion(
                &lease.texture,
                0,
                0,
                0,
                0,
                &self.texture,
                0,
                Some(&source_box),
            );
            self.d3d_context.Flush();
        }
    }

    fn map_staging(
        &self,
        lease: StagingLease,
        deadline: Option<Instant>,
    ) -> Result<MappedFrame, ReadbackError> {
        let mut mapped_resource = D3D11_MAPPED_SUBRESOURCE::default();

        if let Some(deadline) = deadline {
            let started = Instant::now();
            loop {
                match unsafe {
                    self.d3d_context.Map(
                        &lease.texture,
                        0,
                        D3D11_MAP_READ,
                        D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                        Some(&mut mapped_resource),
                    )
                } {
                    Ok(()) => break,
                    Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                        let now = Instant::now();
                        if now >= deadline {
                            return Err(ReadbackError::NotReady);
                        }
                        if now.duration_since(started) < READBACK_SPIN_BUDGET {
                            std::hint::spin_loop();
                        } else {
                            std::thread::sleep(
                                READBACK_RETRY_INTERVAL
                                    .min(deadline.saturating_duration_since(now)),
                            );
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        } else {
            unsafe {
                self.d3d_context.Map(
                    &lease.texture,
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped_resource),
                )?;
            }
        }

        Ok(self.mapped_frame(lease, mapped_resource))
    }

    fn mapped_frame(
        &self,
        lease: StagingLease,
        mapped_resource: D3D11_MAPPED_SUBRESOURCE,
    ) -> MappedFrame {
        MappedFrame {
            lease,
            d3d_context: self.d3d_context.clone(),
            data: mapped_resource.pData as *mut u8,
            row_pitch: mapped_resource.RowPitch,
            width: self.width,
            height: self.height,
            pixel_format: self.pixel_format,
        }
    }

    fn map_staging_hybrid(&self, lease: StagingLease) -> Result<MappedFrame, ReadbackError> {
        let mut mapped_resource = D3D11_MAPPED_SUBRESOURCE::default();

        match unsafe {
            self.d3d_context.Map(
                &lease.texture,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped_resource),
            )
        } {
            Ok(()) => {}
            Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => unsafe {
                self.d3d_context.Map(
                    &lease.texture,
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped_resource),
                )?;
            },
            Err(error) => return Err(error.into()),
        }

        Ok(self.mapped_frame(lease, mapped_resource))
    }
}

pub struct FrameBuffer<'a> {
    mapped: MappedFrame,
    frame: std::marker::PhantomData<&'a Frame>,
}

impl FrameBuffer<'_> {
    pub fn width(&self) -> u32 {
        self.mapped.width()
    }

    pub fn height(&self) -> u32 {
        self.mapped.height()
    }

    pub fn stride(&self) -> u32 {
        self.mapped.row_pitch()
    }

    pub fn data(&self) -> &[u8] {
        self.mapped.as_slice()
    }

    pub fn pixel_format(&self) -> PixelFormat {
        self.mapped.pixel_format()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warp_pool() -> Arc<StagingTexturePool> {
        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_FLAG::default(),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
            .unwrap();
        }

        let device = device.unwrap();
        let context = unsafe { device.GetImmediateContext().unwrap() };

        Arc::new(StagingTexturePool::new(
            device,
            context,
            PixelFormat::R8G8B8A8Unorm,
        ))
    }

    #[test]
    fn pool_survives_capture_size_changes() {
        let pool = warp_pool();
        let sizes = [(320, 240), (640, 480), (800, 600), (1024, 768), (1280, 720)];

        for (index, (width, height)) in sizes.into_iter().enumerate() {
            let lease = pool
                .acquire(width, height)
                .unwrap_or_else(|error| panic!("acquire size {index}: {error}"));
            drop(lease);

            let inner = pool.inner.lock().unwrap();
            assert_eq!(inner.live, inner.free.len(), "live after size {index}");
            assert!(inner.live <= STAGING_POOL_LIMIT);
        }
    }

    #[test]
    fn pool_evicts_stale_sizes_at_the_limit() {
        let pool = warp_pool();
        let held = pool.acquire(320, 240).unwrap();
        for (width, height) in [(640, 480), (800, 600), (1024, 768)] {
            drop(pool.acquire(width, height).unwrap());
        }

        {
            let inner = pool.inner.lock().unwrap();
            assert_eq!(inner.live, STAGING_POOL_LIMIT);
            assert_eq!(inner.free.len(), STAGING_POOL_SIZE);
        }

        let lease = pool
            .acquire(1280, 720)
            .unwrap_or_else(|error| panic!("acquire after a size change: {error}"));
        drop(lease);
        drop(held);

        let inner = pool.inner.lock().unwrap();
        assert_eq!(inner.live, inner.free.len());
        assert!(inner.live <= STAGING_POOL_LIMIT);
    }
}
