use crate::{
    AudioFrame, SetupCtx, output_pipeline,
    screen_capture::{
        CropBounds, DesktopAreaPlan, ScreenCaptureConfig, ScreenCaptureFormat,
        cadence::FrameCadenceGate,
    },
};
use ::windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_CPU_ACCESS_READ,
    D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    ID3D11Texture2D,
};
use ::windows::Win32::Graphics::Dxgi::{
    Common::DXGI_SAMPLE_DESC, DXGI_ERROR_DEVICE_REMOVED, DXGI_ERROR_DEVICE_RESET,
};
use ::windows::core::Interface;
use anyhow::anyhow;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{PerformanceCounterTimestamp, Timestamp};
use cpal::traits::{DeviceTrait, HostTrait};
use futures::{
    FutureExt, SinkExt, StreamExt,
    channel::{mpsc, oneshot},
};
use scap_ffmpeg::*;
use scap_targets::{Display, DisplayId, Window, WindowId, bounds::PhysicalSize};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{self, AtomicBool, AtomicU32, AtomicUsize},
    },
    time::Duration,
};
use tokio_util::{future::FutureExt as _, sync::CancellationToken};
use tracing::*;

// const WINDOW_DURATION: Duration = Duration::from_secs(3);
// const LOG_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct Direct3DCapture;

impl Direct3DCapture {
    pub const PIXEL_FORMAT: scap_direct3d::PixelFormat = scap_direct3d::PixelFormat::R8G8B8A8Unorm;
}

impl ScreenCaptureFormat for Direct3DCapture {
    type VideoFormat = scap_direct3d::Frame;

    fn pixel_format() -> ffmpeg::format::Pixel {
        scap_direct3d::PixelFormat::R8G8B8A8Unorm.as_ffmpeg()
    }

    fn audio_info() -> AudioInfo {
        let host = cpal::default_host();
        let Some(output_device) = host.default_output_device() else {
            warn!("No default audio output device available, using fallback audio config");
            return AudioInfo::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                48_000,
                2,
            )
            .expect("fallback audio config");
        };
        let Ok(supported_config) = output_device.default_output_config() else {
            warn!("Failed to get default output config, using fallback audio config");
            return AudioInfo::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                48_000,
                2,
            )
            .expect("fallback audio config");
        };

        let mut info = AudioInfo::from_stream_config(&supported_config);
        let sample_format = info.sample_format;
        info.sample_format = match sample_format {
            ffmpeg::format::Sample::U8(_) => {
                ffmpeg::format::Sample::U8(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::I16(_) => {
                ffmpeg::format::Sample::I16(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::I32(_) => {
                ffmpeg::format::Sample::I32(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::I64(_) => {
                ffmpeg::format::Sample::I64(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::F32(_) => {
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed)
            }
            ffmpeg::format::Sample::F64(_) => {
                ffmpeg::format::Sample::F64(ffmpeg::format::sample::Type::Packed)
            }
            other => other,
        };

        info
    }
}

pub enum ScreenFrame {
    Captured(scap_direct3d::Frame),
    Composited(CompositedScreenFrame),
    Scaled(ScaledScreenFrame),
}

const COMPOSITED_STAGING_POOL_SIZE: usize = 3;

struct CompositedStagingPool {
    textures: Mutex<Vec<ID3D11Texture2D>>,
    d3d_device: ID3D11Device,
    width: u32,
    height: u32,
    pixel_format: scap_direct3d::PixelFormat,
    next_index: AtomicUsize,
}

impl CompositedStagingPool {
    fn new(
        d3d_device: ID3D11Device,
        width: u32,
        height: u32,
        pixel_format: scap_direct3d::PixelFormat,
    ) -> Self {
        Self {
            textures: Mutex::new(Vec::with_capacity(COMPOSITED_STAGING_POOL_SIZE)),
            d3d_device,
            width,
            height,
            pixel_format,
            next_index: AtomicUsize::new(0),
        }
    }

    fn get_or_create(&self) -> ::windows::core::Result<ID3D11Texture2D> {
        let mut textures = self
            .textures
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index =
            self.next_index.fetch_add(1, atomic::Ordering::Relaxed) % COMPOSITED_STAGING_POOL_SIZE;
        if let Some(existing) = textures.get(index) {
            return Ok(existing.clone());
        }

        let desc = D3D11_TEXTURE2D_DESC {
            Width: self.width,
            Height: self.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: self.pixel_format.as_dxgi(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe {
            self.d3d_device
                .CreateTexture2D(&desc, None, Some(&mut texture))?;
        }
        let texture = texture.ok_or_else(::windows::core::Error::from_win32)?;
        textures.push(texture.clone());
        Ok(texture)
    }
}

fn create_composited_texture(
    d3d_device: &ID3D11Device,
    width: u32,
    height: u32,
    pixel_format: scap_direct3d::PixelFormat,
    initial_rgba: Option<&[u8]>,
) -> ::windows::core::Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: pixel_format.as_dxgi(),
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };

    let init = initial_rgba.map(|bytes| D3D11_SUBRESOURCE_DATA {
        pSysMem: bytes.as_ptr().cast(),
        SysMemPitch: width * 4,
        SysMemSlicePitch: 0,
    });

    let mut texture = None;
    unsafe {
        d3d_device.CreateTexture2D(
            &desc,
            init.as_ref()
                .map(|data| data as *const D3D11_SUBRESOURCE_DATA),
            Some(&mut texture),
        )?;
    }
    texture.ok_or_else(::windows::core::Error::from_win32)
}

pub struct CompositedScreenFrame {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
    pixel_format: scap_direct3d::PixelFormat,
    d3d_context: ID3D11DeviceContext,
    staging_pool: Arc<CompositedStagingPool>,
}

unsafe impl Send for CompositedScreenFrame {}

impl CompositedScreenFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, ::windows::core::Error> {
        let staging_texture = self.staging_pool.get_or_create()?;
        unsafe {
            self.d3d_context
                .CopyResource(&staging_texture, &self.texture);
        }

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.d3d_context
                .Map(&staging_texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }

        let ffmpeg_pixel = match self.pixel_format {
            scap_direct3d::PixelFormat::R8G8B8A8Unorm => ffmpeg::format::Pixel::RGBA,
            scap_direct3d::PixelFormat::B8G8R8A8Unorm => ffmpeg::format::Pixel::BGRA,
        };
        let mut ff_frame = ffmpeg::frame::Video::new(ffmpeg_pixel, self.width, self.height);
        let dest_stride = ff_frame.stride(0);
        let dest_bytes = ff_frame.data_mut(0);
        let src_stride = mapped.RowPitch as usize;
        let row_length = (self.width * 4) as usize;
        let src_bytes = unsafe {
            std::slice::from_raw_parts(mapped.pData.cast::<u8>(), self.height as usize * src_stride)
        };

        for row in 0..self.height as usize {
            let src_start = row * src_stride;
            let dst_start = row * dest_stride;
            let copy_len = row_length.min(
                src_bytes
                    .len()
                    .saturating_sub(src_start)
                    .min(dest_bytes.len().saturating_sub(dst_start)),
            );
            if copy_len > 0 {
                dest_bytes[dst_start..dst_start + copy_len]
                    .copy_from_slice(&src_bytes[src_start..src_start + copy_len]);
            }
        }

        unsafe {
            self.d3d_context.Unmap(&staging_texture, 0);
        }

        Ok(ff_frame)
    }
}

enum CompositorStep {
    WaitingForAllRegions,
    Decimated,
    Emit(CompositedScreenFrame, i64),
}

struct DesktopCompositor {
    d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,
    pixel_format: scap_direct3d::PixelFormat,
    plan: DesktopAreaPlan,
    staging_canvas: ID3D11Texture2D,
    received_mask: Vec<bool>,
    last_emitted_hns: Option<i64>,
    cadence_gate: Option<FrameCadenceGate>,
    staging_pool: Arc<CompositedStagingPool>,
}

unsafe impl Send for DesktopCompositor {}

impl DesktopCompositor {
    fn new(
        d3d_device: ID3D11Device,
        pixel_format: scap_direct3d::PixelFormat,
        plan: DesktopAreaPlan,
        cadence_interval_hns: Option<i64>,
    ) -> anyhow::Result<Self> {
        if let Ok(multithread) = d3d_device.cast::<ID3D11Multithread>() {
            unsafe {
                let _ = multithread.SetMultithreadProtected(true);
            }
        }
        let d3d_context = unsafe { d3d_device.GetImmediateContext() }
            .map_err(|e| anyhow!("Failed to get D3D11 immediate context: {e}"))?;

        let pixel_count = (plan.canvas_width as usize)
            .checked_mul(plan.canvas_height as usize)
            .ok_or_else(|| anyhow!("Desktop area canvas size overflow"))?;
        let mut opaque_black = vec![0u8; pixel_count * 4];
        for px in opaque_black.chunks_exact_mut(4) {
            px[3] = 255;
        }

        let staging_canvas = create_composited_texture(
            &d3d_device,
            plan.canvas_width,
            plan.canvas_height,
            pixel_format,
            Some(&opaque_black),
        )
        .map_err(|e| anyhow!("Failed to create desktop area staging canvas: {e}"))?;

        let staging_pool = Arc::new(CompositedStagingPool::new(
            d3d_device.clone(),
            plan.canvas_width,
            plan.canvas_height,
            pixel_format,
        ));
        let received_mask = vec![false; plan.regions.len()];

        Ok(Self {
            d3d_device,
            d3d_context,
            pixel_format,
            plan,
            staging_canvas,
            received_mask,
            last_emitted_hns: None,
            cadence_gate: cadence_interval_hns.map(FrameCadenceGate::new),
            staging_pool,
        })
    }

    fn composite_texture(
        &mut self,
        region_index: usize,
        texture: &ID3D11Texture2D,
        frame_width: u32,
        frame_height: u32,
        capture_time_hns: i64,
    ) -> ::windows::core::Result<CompositorStep> {
        let Some(region) = self.plan.regions.get(region_index) else {
            return Ok(CompositorStep::WaitingForAllRegions);
        };
        let copy_width = frame_width
            .min(region.source_width)
            .min(self.plan.canvas_width.saturating_sub(region.dest_x));
        let copy_height = frame_height
            .min(region.source_height)
            .min(self.plan.canvas_height.saturating_sub(region.dest_y));
        if copy_width == 0 || copy_height == 0 {
            return Ok(CompositorStep::WaitingForAllRegions);
        }

        let src_box = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: copy_width,
            bottom: copy_height,
            back: 1,
        };
        unsafe {
            self.d3d_context.CopySubresourceRegion(
                &self.staging_canvas,
                0,
                region.dest_x,
                region.dest_y,
                0,
                texture,
                0,
                Some(&src_box),
            );
        }

        if let Some(slot) = self.received_mask.get_mut(region_index) {
            *slot = true;
        }
        if !self.received_mask.iter().all(|&seen| seen) {
            return Ok(CompositorStep::WaitingForAllRegions);
        }

        let ts_hns = self
            .last_emitted_hns
            .map_or(capture_time_hns, |prev| capture_time_hns.max(prev + 1));
        if let Some(gate) = self.cadence_gate.as_mut()
            && !gate.admit(ts_hns)
        {
            return Ok(CompositorStep::Decimated);
        }
        self.last_emitted_hns = Some(ts_hns);

        let output_texture = create_composited_texture(
            &self.d3d_device,
            self.plan.canvas_width,
            self.plan.canvas_height,
            self.pixel_format,
            None,
        )?;
        unsafe {
            self.d3d_context
                .CopyResource(&output_texture, &self.staging_canvas);
        }

        Ok(CompositorStep::Emit(
            CompositedScreenFrame {
                texture: output_texture,
                width: self.plan.canvas_width,
                height: self.plan.canvas_height,
                pixel_format: self.pixel_format,
                d3d_context: self.d3d_context.clone(),
                staging_pool: self.staging_pool.clone(),
            },
            ts_hns,
        ))
    }
}

pub struct ScaledScreenFrame {
    texture: ID3D11Texture2D,
    pixel_data: Vec<u8>,
    width: u32,
    height: u32,
    pixel_format: scap_direct3d::PixelFormat,
}

unsafe impl Send for ScaledScreenFrame {}

impl ScreenFrame {
    pub fn texture(&self) -> &ID3D11Texture2D {
        match self {
            ScreenFrame::Captured(frame) => frame.texture(),
            ScreenFrame::Composited(composited) => &composited.texture,
            ScreenFrame::Scaled(scaled) => &scaled.texture,
        }
    }

    pub fn width(&self) -> u32 {
        match self {
            ScreenFrame::Captured(frame) => frame.width(),
            ScreenFrame::Composited(composited) => composited.width,
            ScreenFrame::Scaled(scaled) => scaled.width,
        }
    }

    pub fn height(&self) -> u32 {
        match self {
            ScreenFrame::Captured(frame) => frame.height(),
            ScreenFrame::Composited(composited) => composited.height,
            ScreenFrame::Scaled(scaled) => scaled.height,
        }
    }

    pub fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, ::windows::core::Error> {
        match self {
            ScreenFrame::Captured(frame) => {
                use scap_ffmpeg::AsFFmpeg;
                frame.as_ffmpeg()
            }
            ScreenFrame::Composited(composited) => composited.as_ffmpeg(),
            ScreenFrame::Scaled(scaled) => {
                let ffmpeg_pixel = match scaled.pixel_format {
                    scap_direct3d::PixelFormat::R8G8B8A8Unorm => ffmpeg::format::Pixel::RGBA,
                    scap_direct3d::PixelFormat::B8G8R8A8Unorm => ffmpeg::format::Pixel::BGRA,
                };
                let mut ff_frame =
                    ffmpeg::frame::Video::new(ffmpeg_pixel, scaled.width, scaled.height);
                let dest_stride = ff_frame.stride(0);
                let dest_bytes = ff_frame.data_mut(0);
                let row_length = (scaled.width * 4) as usize;

                for row in 0..scaled.height as usize {
                    let src_start = row * row_length;
                    let dst_start = row * dest_stride;
                    let copy_len = row_length.min(
                        scaled
                            .pixel_data
                            .len()
                            .saturating_sub(src_start)
                            .min(dest_bytes.len().saturating_sub(dst_start)),
                    );
                    if copy_len > 0 {
                        dest_bytes[dst_start..dst_start + copy_len]
                            .copy_from_slice(&scaled.pixel_data[src_start..src_start + copy_len]);
                    }
                }

                Ok(ff_frame)
            }
        }
    }
}

struct FrameScalerState {
    context: ffmpeg::software::scaling::Context,
    source_width: u32,
    source_height: u32,
}

unsafe impl Send for FrameScalerState {}

struct WindowsFrameScaler {
    target_width: u32,
    target_height: u32,
    pixel_format: scap_direct3d::PixelFormat,
    d3d_device: ID3D11Device,
    state: Option<FrameScalerState>,
}

impl WindowsFrameScaler {
    fn new(
        target_width: u32,
        target_height: u32,
        pixel_format: scap_direct3d::PixelFormat,
        d3d_device: ID3D11Device,
    ) -> Self {
        Self {
            target_width,
            target_height,
            pixel_format,
            d3d_device,
            state: None,
        }
    }

    fn replace_device(&mut self, d3d_device: ID3D11Device) {
        self.d3d_device = d3d_device;
        self.state = None;
    }

    fn scale_ffmpeg_frame(&mut self, src_frame: &ffmpeg::frame::Video) -> Option<ScreenFrame> {
        let src_width = src_frame.width();
        let src_height = src_frame.height();

        let src_pixel = match self.pixel_format {
            scap_direct3d::PixelFormat::R8G8B8A8Unorm => ffmpeg::format::Pixel::RGBA,
            scap_direct3d::PixelFormat::B8G8R8A8Unorm => ffmpeg::format::Pixel::BGRA,
        };

        let needs_reinit = self
            .state
            .as_ref()
            .is_none_or(|s| s.source_width != src_width || s.source_height != src_height);

        if needs_reinit {
            let context = ffmpeg::software::scaling::Context::get(
                src_pixel,
                src_width,
                src_height,
                src_pixel,
                self.target_width,
                self.target_height,
                ffmpeg::software::scaling::Flags::BILINEAR,
            )
            .ok()?;

            self.state = Some(FrameScalerState {
                context,
                source_width: src_width,
                source_height: src_height,
            });
        }

        let state = self.state.as_mut()?;
        let mut dst_frame =
            ffmpeg::frame::Video::new(src_pixel, self.target_width, self.target_height);
        state.context.run(src_frame, &mut dst_frame).ok()?;

        let dst_stride = dst_frame.stride(0);
        let dst_row_length = (self.target_width * 4) as usize;
        let total_bytes = dst_row_length * self.target_height as usize;
        let mut pixel_data = vec![0u8; total_bytes];
        let dst_data = dst_frame.data(0);

        for row in 0..self.target_height as usize {
            let s_start = row * dst_stride;
            let d_start = row * dst_row_length;
            let copy_len = dst_row_length.min(
                dst_data
                    .len()
                    .saturating_sub(s_start)
                    .min(pixel_data.len().saturating_sub(d_start)),
            );
            if copy_len > 0 {
                pixel_data[d_start..d_start + copy_len]
                    .copy_from_slice(&dst_data[s_start..s_start + copy_len]);
            }
        }

        let dxgi_format = self.pixel_format.as_dxgi();

        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: self.target_width,
            Height: self.target_height,
            MipLevels: 1,
            ArraySize: 1,
            Format: dxgi_format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };

        let subresource_data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixel_data.as_ptr() as *const _,
            SysMemPitch: dst_row_length as u32,
            SysMemSlicePitch: 0,
        };

        let texture = unsafe {
            let mut tex = None;
            self.d3d_device
                .CreateTexture2D(&texture_desc, Some(&subresource_data), Some(&mut tex))
                .ok()?;
            tex?
        };

        Some(ScreenFrame::Scaled(ScaledScreenFrame {
            texture,
            pixel_data,
            width: self.target_width,
            height: self.target_height,
            pixel_format: self.pixel_format,
        }))
    }

    fn scale_frame(&mut self, frame: &scap_direct3d::Frame) -> Option<ScreenFrame> {
        use scap_ffmpeg::AsFFmpeg;
        let src_frame = frame.as_ffmpeg().ok()?;
        self.scale_ffmpeg_frame(&src_frame)
    }

    fn scale_composited(
        &mut self,
        frame: &CompositedScreenFrame,
    ) -> windows::core::Result<Option<ScreenFrame>> {
        let src_frame = frame.as_ffmpeg()?;
        Ok(self.scale_ffmpeg_frame(&src_frame))
    }
}

pub struct VideoFrame {
    pub frame: ScreenFrame,
    pub timestamp: Timestamp,
}

impl output_pipeline::VideoFrame for VideoFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

/// The size a window recording is encoded at: the window's own capture item,
/// floored to even. WGC delivers the window's frames at the item's size, which
/// differs from the window rect (invisible resize borders, odd dimensions), so
/// sizing the output from the rect sends every frame through the CPU scaler.
/// The odd row or column is trimmed on the GPU (`Settings::even_dimensions`),
/// which keeps the frames exactly this size.
pub fn window_capture_size(window: &WindowId) -> Option<PhysicalSize> {
    let size = Window::from_id_direct(window)?
        .raw_handle()
        .try_as_capture_item()
        .ok()?
        .Size()
        .ok()?;
    even_capture_size(size.Width, size.Height)
}

fn even_capture_size(width: i32, height: i32) -> Option<PhysicalSize> {
    let width = (width.max(0) as u32) & !1;
    let height = (height.max(0) as u32) & !1;
    (width > 0 && height > 0).then(|| PhysicalSize::new(width as f64, height as f64))
}

/// A window target captures the window's own GraphicsCaptureItem, so the crop
/// that carves the window out of the display is neither needed nor correct:
/// WGC already hands back just that window, and the crop would additionally
/// pin the recording to wherever the window started out.
fn crop_for_target(
    window: Option<&WindowId>,
    crop_bounds: Option<CropBounds>,
) -> Option<CropBounds> {
    match window {
        Some(_) => None,
        None => crop_bounds,
    }
}

impl ScreenCaptureConfig<Direct3DCapture> {
    pub async fn to_sources(
        &self,
    ) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSourceConfig>)> {
        let crop_bounds = crop_for_target(self.config.window.as_ref(), self.config.crop_bounds);

        let mut settings = scap_direct3d::Settings {
            pixel_format: Direct3DCapture::PIXEL_FORMAT,
            crop: crop_bounds.map(|b| {
                let position = b.position();
                let size = b.size().map(|v| (v / 2.0).floor() * 2.0);

                let left = position.x().max(0.0) as u32;
                let top = position.y().max(0.0) as u32;
                let right = (position.x() + size.width()).max(0.0) as u32;
                let bottom = (position.y() + size.height()).max(0.0) as u32;

                D3D11_BOX {
                    left,
                    top,
                    right: right.max(left),
                    bottom: bottom.max(top),
                    front: 0,
                    back: 1,
                }
            }),
            // Matches `window_capture_size`, which the output is sized from.
            even_dimensions: self.config.window.is_some(),
            // Only a window target follows its item's size; display and area
            // recordings keep the pool they were created with.
            follow_item_size: self.config.window.is_some(),
            ..Default::default()
        };

        if let Ok(true) = scap_direct3d::Settings::can_is_border_required() {
            settings.is_border_required = Some(false);
        }

        if let Ok(true) = scap_direct3d::Settings::can_is_cursor_capture_enabled() {
            settings.is_cursor_capture_enabled = Some(self.config.show_cursor);
        }

        if let Ok(true) = scap_direct3d::Settings::can_min_update_interval() {
            settings.min_update_interval =
                Some(Duration::from_secs_f64(1.0 / self.config.fps as f64));
        }

        settings.fps = Some(self.config.fps);

        // Store the target's ID instead of GraphicsCaptureItem to avoid COM threading issues
        // The GraphicsCaptureItem will be created on the capture thread
        Ok((
            VideoSourceConfig {
                video_info: self.video_info,
                display_id: self.config.display.clone(),
                window_id: self.config.window.clone(),
                desktop_area: self.config.desktop_area.clone(),
                settings,
                d3d_device: self.d3d_device.clone(),
            },
            self.system_audio.then_some(SystemAudioSourceConfig),
        ))
    }
}

#[derive(thiserror::Error, Clone, Copy, Debug)]
pub enum VideoSourceError {
    #[error("Screen capture closed")]
    Closed,
}

pub struct VideoSourceConfig {
    video_info: VideoInfo,
    display_id: DisplayId,
    window_id: Option<WindowId>,
    desktop_area: Option<DesktopAreaPlan>,
    settings: scap_direct3d::Settings,
    pub d3d_device: ID3D11Device,
}
pub struct VideoSource {
    video_info: VideoInfo,
    ctrl_tx: std::sync::mpsc::SyncSender<VideoControl>,
    first_frame: Option<oneshot::Receiver<Result<(), String>>>,
}

type SharedFirstScreenFrameSender = Arc<Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

#[derive(Clone)]
struct FirstScreenFrame(SharedFirstScreenFrameSender);

impl FirstScreenFrame {
    fn complete(&self, result: Result<(), String>) {
        if let Ok(mut sender) = self.0.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(result);
        }
    }
}

async fn wait_for_first_screen_frame(
    receiver: oneshot::Receiver<Result<(), String>>,
    timeout: Duration,
) -> anyhow::Result<()> {
    tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| anyhow!("Windows screen capture produced no accepted frame within 5s"))?
        .map_err(|_| anyhow!("Windows screen capture closed before its first frame"))?
        .map_err(anyhow::Error::msg)
}

enum VideoControl {
    Start(oneshot::Sender<anyhow::Result<()>>),
    Stop(oneshot::Sender<anyhow::Result<()>>),
    Restart,
    RecreateDevice,
}

const MAX_CAPTURE_RESTARTS: u32 = 3;
const RESTART_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureClosureKind {
    DeviceRemoved { hresult: i32 },
    TargetLost,
    Transient,
}

fn classify_capture_closure(device: &ID3D11Device) -> CaptureClosureKind {
    unsafe {
        if let Err(e) = device.GetDeviceRemovedReason() {
            return CaptureClosureKind::DeviceRemoved {
                hresult: e.code().0,
            };
        }
    }
    CaptureClosureKind::TargetLost
}

#[derive(Debug, Clone)]
struct CaptureClosureEvent {
    kind: CaptureClosureKind,
    message: String,
}

struct CreateCapturerParams<'a> {
    display_id: &'a DisplayId,
    window_id: Option<&'a WindowId>,
    desktop_area: Option<&'a DesktopAreaPlan>,
    settings: &'a scap_direct3d::Settings,
    d3d_device: &'a ID3D11Device,
    video_tx: &'a mpsc::Sender<VideoFrame>,
    video_frame_counter: &'a Arc<AtomicU32>,
    video_drop_counter: &'a Arc<AtomicU32>,
    /// Decimated by the cadence gate: expected on high-refresh monitors,
    /// tracked separately from drops so it never trips drop-rate health.
    video_decimated_counter: &'a Arc<AtomicU32>,
    /// Nominal frame interval in QPC hundred-nanosecond units; `None`
    /// disables rate capping.
    cadence_interval_hns: Option<i64>,
    expected_width: u32,
    expected_height: u32,
    frame_scaler: Arc<Mutex<WindowsFrameScaler>>,
    scaling_logged: Arc<AtomicBool>,
    scaled_frame_count: Arc<AtomicU32>,
    stall_health_tx: output_pipeline::HealthSender,
    first_frame: FirstScreenFrame,
}

enum ActiveCapturer {
    Single(scap_direct3d::Capturer),
    Multi(Vec<scap_direct3d::Capturer>),
}

impl ActiveCapturer {
    fn start(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Single(capturer) => capturer.start().map_err(Into::into),
            Self::Multi(capturers) => {
                for (index, capturer) in capturers.iter_mut().enumerate() {
                    if let Err(error) = capturer.start() {
                        for started in &mut capturers[..index] {
                            let _ = started.stop();
                        }
                        return Err(error.into());
                    }
                }
                Ok(())
            }
        }
    }

    fn stop(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Single(capturer) => capturer.stop().map_err(Into::into),
            Self::Multi(capturers) => {
                let mut first_err = None;
                for capturer in capturers {
                    if let Err(error) = capturer.stop()
                        && first_err.is_none()
                    {
                        first_err = Some(anyhow::Error::from(error));
                    }
                }
                match first_err {
                    Some(err) => Err(err),
                    None => Ok(()),
                }
            }
        }
    }
}

fn map_new_capturer_error(error: scap_direct3d::NewCapturerError) -> anyhow::Error {
    match &error {
        scap_direct3d::NewCapturerError::CaptureSession(inner)
            if inner.code() == windows::Win32::Foundation::E_ACCESSDENIED =>
        {
            anyhow!(
                "Windows denied Cap access to screen capture. Check that screen capture is allowed for desktop apps in Windows privacy settings and that no security software is blocking it ({error})"
            )
        }
        _ => anyhow!("{error}"),
    }
}

fn create_active_capturer(
    params: &CreateCapturerParams,
    error_tx: &mpsc::Sender<CaptureClosureEvent>,
) -> anyhow::Result<ActiveCapturer> {
    if let Some(plan) = params.desktop_area {
        create_multi_d3d_capturer(plan, params, error_tx).map(ActiveCapturer::Multi)
    } else {
        create_d3d_capturer(params, error_tx).map(ActiveCapturer::Single)
    }
}

fn create_multi_d3d_capturer(
    plan: &DesktopAreaPlan,
    params: &CreateCapturerParams,
    error_tx: &mpsc::Sender<CaptureClosureEvent>,
) -> anyhow::Result<Vec<scap_direct3d::Capturer>> {
    let compositor = Arc::new(Mutex::new(DesktopCompositor::new(
        params.d3d_device.clone(),
        params.settings.pixel_format,
        plan.clone(),
        params.cadence_interval_hns,
    )?));

    let mut capturers = Vec::with_capacity(plan.regions.len());
    for (region_index, region) in plan.regions.iter().enumerate() {
        let capture_item = Display::from_id(&region.display_id)
            .ok_or_else(|| anyhow!("Display not found for ID: {:?}", region.display_id))?
            .raw_handle()
            .try_as_capture_item()
            .map_err(|e| anyhow!("Failed to create GraphicsCaptureItem: {}", e))?;

        let mut region_settings = params.settings.clone();
        region_settings.crop = Some(D3D11_BOX {
            left: region.source_left,
            top: region.source_top,
            right: region.source_left + region.source_width,
            bottom: region.source_top + region.source_height,
            front: 0,
            back: 1,
        });
        region_settings.even_dimensions = false;
        region_settings.follow_item_size = false;

        let capturer = scap_direct3d::Capturer::new(
            capture_item,
            region_settings,
            {
                let compositor = compositor.clone();
                let video_frame_counter = params.video_frame_counter.clone();
                let video_drop_counter = params.video_drop_counter.clone();
                let video_decimated_counter = params.video_decimated_counter.clone();
                let mut tx = params.video_tx.clone();
                let expected_width = params.expected_width;
                let expected_height = params.expected_height;
                let frame_scaler = params.frame_scaler.clone();
                let scaling_logged = params.scaling_logged.clone();
                let scaled_frame_count = params.scaled_frame_count.clone();
                let stall_health_tx = params.stall_health_tx.clone();
                let first_frame = params.first_frame.clone();
                let mut frame_error_tx = error_tx.clone();
                let frame_device = params.d3d_device.clone();
                move |frame| {
                    let result = (|| {
                        let capture_time = frame.inner().SystemRelativeTime()?;
                        if frame.width() == 0 || frame.height() == 0 {
                            return Err(windows::core::Error::new(
                                windows::Win32::Foundation::E_INVALIDARG,
                                "Empty screen frame",
                            ));
                        }

                        let mut compositor = compositor
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        let step = compositor.composite_texture(
                            region_index,
                            frame.texture(),
                            frame.width(),
                            frame.height(),
                            capture_time.Duration,
                        )?;

                        let (composited, ts_hns) = match step {
                            CompositorStep::WaitingForAllRegions => return Ok(()),
                            CompositorStep::Decimated => {
                                video_decimated_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                return Ok(());
                            }
                            CompositorStep::Emit(composited, ts_hns) => (composited, ts_hns),
                        };

                        let timestamp = Timestamp::PerformanceCounter(
                            PerformanceCounterTimestamp::from_100ns(ts_hns),
                        );

                        let screen_frame = if composited.width != expected_width
                            || composited.height != expected_height
                        {
                            let Ok(mut scaler_guard) = frame_scaler.lock() else {
                                video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                return Ok(());
                            };
                            if !scaling_logged.load(atomic::Ordering::Relaxed) {
                                info!(
                                    expected_width,
                                    expected_height,
                                    frame_width = composited.width,
                                    frame_height = composited.height,
                                    "Scaling composited desktop area frames to output dimensions"
                                );
                                scaling_logged.store(true, atomic::Ordering::Relaxed);
                            }
                            match scaler_guard.scale_composited(&composited)? {
                                Some(scaled) => {
                                    scaled_frame_count.fetch_add(1, atomic::Ordering::Relaxed);
                                    scaled
                                }
                                None => {
                                    video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                    return Ok(());
                                }
                            }
                        } else {
                            ScreenFrame::Composited(composited)
                        };

                        match output_pipeline::send_with_stall_budget_futures(
                            &mut tx,
                            VideoFrame {
                                frame: screen_frame,
                                timestamp,
                            },
                            "screen-video",
                            &stall_health_tx,
                        ) {
                            output_pipeline::StallSendOutcome::Sent => {
                                video_frame_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                first_frame.complete(Ok(()));
                            }
                            output_pipeline::StallSendOutcome::StalledAndDropped { .. }
                            | output_pipeline::StallSendOutcome::Disconnected => {
                                video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            }
                        }
                        Ok(())
                    })();
                    if let Err(error) = &result {
                        let message = format!("Windows desktop area frame failed: {error}");
                        first_frame.complete(Err(message.clone()));
                        let kind = match error.code() {
                            DXGI_ERROR_DEVICE_REMOVED | DXGI_ERROR_DEVICE_RESET => {
                                CaptureClosureKind::DeviceRemoved {
                                    hresult: error.code().0,
                                }
                            }
                            _ => classify_capture_closure(&frame_device),
                        };
                        if matches!(kind, CaptureClosureKind::DeviceRemoved { .. }) {
                            let _ = frame_error_tx.try_send(CaptureClosureEvent { kind, message });
                        }
                    }
                    result
                }
            },
            {
                let first_frame = params.first_frame.clone();
                let mut err_tx = error_tx.clone();
                let device_for_callback = params.d3d_device.clone();
                move || {
                    let kind = classify_capture_closure(&device_for_callback);
                    let message = match kind {
                        CaptureClosureKind::DeviceRemoved { hresult } => {
                            format!("d3d11 device removed (hresult=0x{hresult:08x})")
                        }
                        CaptureClosureKind::TargetLost => "capture target lost".to_string(),
                        CaptureClosureKind::Transient => "capture closed".to_string(),
                    };
                    first_frame.complete(Err(message.clone()));
                    drop(err_tx.try_send(CaptureClosureEvent { kind, message }));
                    Ok(())
                }
            },
            Some(params.d3d_device.clone()),
        )
        .map_err(map_new_capturer_error)?;

        capturers.push(capturer);
    }

    Ok(capturers)
}

fn create_d3d_capturer(
    params: &CreateCapturerParams,
    error_tx: &mpsc::Sender<CaptureClosureEvent>,
) -> anyhow::Result<scap_direct3d::Capturer> {
    let capture_item = match params.window_id {
        // Resolve the handle directly: `from_id` searches `list()`, which
        // skips minimized windows, so a target minimized between selection
        // and capture setup would fail to start despite still existing.
        Some(window_id) => Window::from_id_direct(window_id)
            .ok_or_else(|| anyhow!("Window not found for ID: {:?}", window_id))?
            .raw_handle()
            .try_as_capture_item()
            .map_err(|e| anyhow!("Failed to create window GraphicsCaptureItem: {}", e))?,
        None => Display::from_id(params.display_id)
            .ok_or_else(|| anyhow!("Display not found for ID: {:?}", params.display_id))?
            .raw_handle()
            .try_as_capture_item()
            .map_err(|e| anyhow!("Failed to create GraphicsCaptureItem: {}", e))?,
    };

    scap_direct3d::Capturer::new(
        capture_item,
        params.settings.clone(),
        {
            let video_frame_counter = params.video_frame_counter.clone();
            let video_drop_counter = params.video_drop_counter.clone();
            let video_decimated_counter = params.video_decimated_counter.clone();
            let mut cadence_gate = params.cadence_interval_hns.map(FrameCadenceGate::new);
            let mut tx = params.video_tx.clone();
            let expected_width = params.expected_width;
            let expected_height = params.expected_height;
            let frame_scaler = params.frame_scaler.clone();
            let scaling_logged = params.scaling_logged.clone();
            let scaled_frame_count = params.scaled_frame_count.clone();
            let stall_health_tx = params.stall_health_tx.clone();
            let first_frame = params.first_frame.clone();
            move |frame| {
                let result = (|| {
                let capture_time = frame.inner().SystemRelativeTime()?;
                if frame.width() == 0 || frame.height() == 0 {
                    return Err(windows::core::Error::new(windows::Win32::Foundation::E_INVALIDARG, "Empty screen frame"));
                }

                // WGC delivers a frame per screen update — up to the monitor
                // refresh rate on systems without MinUpdateInterval support —
                // so cap delivery at the nominal rate before any conversion
                // or channel work.
                if let Some(gate) = cadence_gate.as_mut()
                    && !gate.admit(capture_time.Duration)
                {
                    video_decimated_counter.fetch_add(1, atomic::Ordering::Relaxed);
                    return Ok(());
                }

                let timestamp = Timestamp::PerformanceCounter(
                    PerformanceCounterTimestamp::from_100ns(capture_time.Duration),
                );

                let frame_width = frame.width();
                let frame_height = frame.height();

                let screen_frame =
                    if frame_width != expected_width || frame_height != expected_height {
                        let Ok(mut scaler_guard) = frame_scaler.lock() else {
                            video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            return Ok(());
                        };

                        if !scaling_logged.load(atomic::Ordering::Relaxed) {
                            info!(
                                expected_width,
                                expected_height,
                                frame_width,
                                frame_height,
                                "Display resolution changed, scaling frames to match original dimensions"
                            );
                            scaling_logged.store(true, atomic::Ordering::Relaxed);
                        }

                        match scaler_guard.scale_frame(&frame) {
                            Some(scaled) => {
                                let count =
                                    scaled_frame_count.fetch_add(1, atomic::Ordering::Relaxed) + 1;
                                if count.is_multiple_of(300) {
                                    debug!(scaled_frames = count, "Scaling frames");
                                }
                                scaled
                            }
                            None => {
                                video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                return Ok(());
                            }
                        }
                    } else {
                        if scaling_logged.swap(false, atomic::Ordering::Relaxed) {
                            let count = scaled_frame_count.swap(0, atomic::Ordering::Relaxed);
                            info!(
                                scaled_frames = count,
                                "Display dimensions restored, resuming direct capture"
                            );
                            if let Ok(mut guard) = frame_scaler.lock() {
                                guard.state = None;
                            }
                        }
                        ScreenFrame::Captured(frame)
                    };

                match output_pipeline::send_with_stall_budget_futures(
                    &mut tx,
                    VideoFrame {
                        frame: screen_frame,
                        timestamp,
                    },
                    "screen-video",
                    &stall_health_tx,
                ) {
                    output_pipeline::StallSendOutcome::Sent => {
                        video_frame_counter.fetch_add(1, atomic::Ordering::Relaxed);
                        first_frame.complete(Ok(()));
                    }
                    output_pipeline::StallSendOutcome::StalledAndDropped { .. }
                    | output_pipeline::StallSendOutcome::Disconnected => {
                        video_drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                    }
                }
                Ok(())
                })();
                if let Err(error) = &result {
                    first_frame.complete(Err(format!("Windows first screen frame failed: {error}")));
                }
                result
            }
        },
        {
            let first_frame = params.first_frame.clone();
            let mut err_tx = error_tx.clone();
            let device_for_callback = params.d3d_device.clone();
            move || {
                let kind = classify_capture_closure(&device_for_callback);
                let message = match kind {
                    CaptureClosureKind::DeviceRemoved { hresult } => {
                        format!("d3d11 device removed (hresult=0x{hresult:08x})")
                    }
                    CaptureClosureKind::TargetLost => "capture target lost".to_string(),
                    CaptureClosureKind::Transient => "capture closed".to_string(),
                };
                first_frame.complete(Err(message.clone()));
                drop(err_tx.try_send(CaptureClosureEvent { kind, message }));
                Ok(())
            }
        },
        Some(params.d3d_device.clone()),
    )
    .map_err(|error| match &error {
        scap_direct3d::NewCapturerError::CaptureSession(inner)
            if inner.code() == windows::Win32::Foundation::E_ACCESSDENIED =>
        {
            anyhow!(
                "Windows denied Cap access to screen capture. Check that screen capture is allowed for desktop apps in Windows privacy settings and that no security software is blocking it ({error})"
            )
        }
        _ => anyhow!("{error}"),
    })
}

impl output_pipeline::VideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = VideoFrame;

    async fn setup(
        VideoSourceConfig {
            video_info,
            display_id,
            window_id,
            desktop_area,
            settings,
            d3d_device,
        }: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut output_pipeline::SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (error_tx, mut error_rx) = mpsc::channel::<CaptureClosureEvent>(4);
        let (ctrl_tx, ctrl_rx) = std::sync::mpsc::sync_channel::<VideoControl>(4);
        let monitor_ctrl_tx = ctrl_tx.clone();

        let (first_tx, first_rx) = oneshot::channel();
        let first_frame = FirstScreenFrame(Arc::new(Mutex::new(Some(first_tx))));
        let tokio_rt = tokio::runtime::Handle::current();
        let restart_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        let expected_width = video_info.width;
        let expected_height = video_info.height;
        let frame_scaler = Arc::new(Mutex::new(WindowsFrameScaler::new(
            expected_width,
            expected_height,
            Direct3DCapture::PIXEL_FORMAT,
            d3d_device.clone(),
        )));
        let scaling_logged: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        let scaled_frame_count: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        // Belt-and-braces alongside WGC's MinUpdateInterval: on systems where
        // that API is unsupported (or silently ineffective) the gate keeps
        // high-refresh monitors from recording far more frames than the
        // nominal rate. For sources at or below nominal it admits everything.
        let cadence_interval_hns = if std::env::var("CAP_DISABLE_CAPTURE_CADENCE").is_ok() {
            info!("Capture cadence gate disabled via CAP_DISABLE_CAPTURE_CADENCE");
            None
        } else {
            let fps = video_info.fps();
            (fps > 0).then(|| 10_000_000i64 / fps as i64)
        };

        let is_desktop_area = desktop_area.is_some();
        let stats_health_tx = ctx.health_tx().clone();
        ctx.tasks().spawn_thread("d3d-capture-thread", {
            let restart_counter = restart_counter.clone();
            let frame_scaler = frame_scaler.clone();
            let scaling_logged = scaling_logged.clone();
            let scaled_frame_count = scaled_frame_count.clone();
            let stats_health_tx = stats_health_tx.clone();
            move || {
                cap_mediafoundation_utils::thread_init();

                let video_frame_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
                let video_drop_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
                let video_decimated_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
                let cancel_token = CancellationToken::new();
                let mut error_tx = error_tx;
                let mut d3d_device = d3d_device;

                macro_rules! build_params {
                    ($device:expr) => {
                        CreateCapturerParams {
                            display_id: &display_id,
                            window_id: window_id.as_ref(),
                            desktop_area: desktop_area.as_ref(),
                            settings: &settings,
                            d3d_device: $device,
                            video_tx: &video_tx,
                            video_frame_counter: &video_frame_counter,
                            video_drop_counter: &video_drop_counter,
                            video_decimated_counter: &video_decimated_counter,
                            cadence_interval_hns,
                            expected_width,
                            expected_height,
                            frame_scaler: frame_scaler.clone(),
                            scaling_logged: scaling_logged.clone(),
                            scaled_frame_count: scaled_frame_count.clone(),
                            stall_health_tx: stats_health_tx.clone(),
                            first_frame: first_frame.clone(),
                        }
                    };
                }

                let mut capturer =
                    match create_active_capturer(&build_params!(&d3d_device), &error_tx) {
                        Ok(c) => {
                            trace!("D3D capturer created successfully");
                            Some(c)
                        }
                        Err(e) => {
                            error!("Failed to create D3D capturer: {}", e);
                            // `start` reads why from here: its reply channel only
                            // says the thread is gone.
                            first_frame.complete(Err(format!("{e:#}")));
                            return Err(e);
                        }
                    };

                let Ok(VideoControl::Start(reply)) = ctrl_rx.recv() else {
                    error!("Failed to receive Start control message - channel disconnected");
                    return Err(anyhow!("Control channel disconnected before Start"));
                };

                tokio_rt.spawn(
                    {
                        let video_frame_counter = video_frame_counter.clone();
                        let video_drop_counter = video_drop_counter.clone();
                        let video_decimated_counter = video_decimated_counter.clone();
                        let restart_counter = restart_counter.clone();
                        let scaled_frame_count = scaled_frame_count.clone();
                        let stats_health_tx = stats_health_tx.clone();
                        let desktop_device = desktop_area.as_ref().map(|_| d3d_device.clone());
                        let mut device_error_tx = error_tx.clone();
                        let first_frame = first_frame.clone();
                        async move {
                            loop {
                                tokio::time::sleep(Duration::from_secs(5)).await;
                                if let Some(device) = &desktop_device
                                    && let kind @ CaptureClosureKind::DeviceRemoved { hresult } =
                                        classify_capture_closure(device)
                                {
                                    let message = format!(
                                        "d3d11 desktop area device removed (hresult=0x{hresult:08x})"
                                    );
                                    first_frame.complete(Err(message.clone()));
                                    let _ = device_error_tx
                                        .send(CaptureClosureEvent { kind, message })
                                        .await;
                                    break;
                                }
                                let captured = video_frame_counter.load(atomic::Ordering::Relaxed);
                                let dropped = video_drop_counter.load(atomic::Ordering::Relaxed);
                                let decimated =
                                    video_decimated_counter.load(atomic::Ordering::Relaxed);
                                let restarts = restart_counter.load(atomic::Ordering::Relaxed);
                                let scaled = scaled_frame_count.load(atomic::Ordering::Relaxed);
                                // Decimated frames are the cadence gate doing
                                // its job on a high-refresh monitor, not a
                                // health problem; keep them out of drop rate.
                                let total = captured + dropped;
                                if dropped > 0 || restarts > 0 || scaled > 0 {
                                    let drop_pct = if total > 0 {
                                        100.0 * dropped as f64 / total as f64
                                    } else {
                                        0.0
                                    };
                                    warn!(
                                        captured = captured,
                                        dropped = dropped,
                                        drop_pct = format!("{:.1}%", drop_pct),
                                        decimated = decimated,
                                        restarts = restarts,
                                        scaled_frames = scaled,
                                        "Screen capture stats"
                                    );
                                    if drop_pct > 5.0 {
                                        output_pipeline::emit_health(
                                            &stats_health_tx,
                                            output_pipeline::PipelineHealthEvent::FrameDropRateHigh {
                                                source: "screen-video".to_string(),
                                                rate_pct: drop_pct,
                                            },
                                        );
                                    }
                                } else {
                                    debug!(
                                        captured = captured,
                                        decimated = decimated,
                                        "Screen capture frames"
                                    );
                                }
                            }
                        }
                    }
                    .with_cancellation_token_owned(cancel_token.clone())
                    .in_current_span(),
                );
                let drop_guard = cancel_token.drop_guard();

                trace!("Starting D3D capturer");
                let start_result = capturer
                    .as_mut()
                    .map(ActiveCapturer::start)
                    .unwrap_or(Err(anyhow!("No capturer available")));
                if let Err(ref e) = start_result {
                    error!("Failed to start D3D capturer: {}", e);
                }
                if reply.send(start_result).is_err() {
                    error!("Failed to send start result - receiver dropped");
                    return Ok(());
                }

                loop {
                    match ctrl_rx.recv() {
                        Ok(VideoControl::Stop(reply)) => {
                            if let Some(mut cap) = capturer.take() {
                                let _ = reply.send(cap.stop());
                            } else {
                                let _ = reply.send(Ok(()));
                            }
                            break;
                        }
                        Ok(VideoControl::RecreateDevice) => {
                            warn!("Recreating D3D device after device-lost");
                            if let Some(mut old) = capturer.take() {
                                let _ = old.stop();
                                drop(old);
                            }
                            match crate::capture_pipeline::create_d3d_device() {
                                Ok(new_device) => {
                                    info!("Recreated D3D device after device-lost");
                                    d3d_device = new_device;
                                    frame_scaler
                                        .lock()
                                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                                        .replace_device(d3d_device.clone());
                                }
                                Err(e) => {
                                    error!(error = %e, "Failed to recreate D3D device");
                                    let _ = error_tx.try_send(CaptureClosureEvent {
                                        kind: CaptureClosureKind::Transient,
                                        message: format!("recreate_device_failed: {e}"),
                                    });
                                    continue;
                                }
                            }
                            match create_active_capturer(&build_params!(&d3d_device), &error_tx) {
                                Ok(mut new_cap) => match new_cap.start() {
                                    Ok(()) => {
                                        info!(
                                            "Windows screen capture resumed after device recreation"
                                        );
                                        output_pipeline::emit_health(
                                            &stats_health_tx,
                                            output_pipeline::PipelineHealthEvent::SourceRestarted,
                                        );
                                        capturer = Some(new_cap);
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "Failed to start capturer after device recreation");
                                        let _ = error_tx.try_send(CaptureClosureEvent {
                                            kind: CaptureClosureKind::Transient,
                                            message: format!("recreate_start_failed: {e}"),
                                        });
                                    }
                                },
                                Err(e) => {
                                    warn!(error = %e, "Failed to recreate capturer after device recreation");
                                    let _ = error_tx.try_send(CaptureClosureEvent {
                                        kind: CaptureClosureKind::Transient,
                                        message: format!("recreate_capturer_failed: {e}"),
                                    });
                                }
                            }
                        }
                        Ok(VideoControl::Restart) => {
                            info!("Restarting Windows screen capture");
                            output_pipeline::emit_health(
                                &stats_health_tx,
                                output_pipeline::PipelineHealthEvent::SourceRestarting,
                            );
                            if let Some(mut old) = capturer.take() {
                                let _ = old.stop();
                                drop(old);
                            }

                            match create_active_capturer(&build_params!(&d3d_device), &error_tx) {
                                Ok(mut new_cap) => match new_cap.start() {
                                    Ok(()) => {
                                        let count = restart_counter
                                            .fetch_add(1, atomic::Ordering::Relaxed)
                                            + 1;
                                        info!(
                                            restart_count = count,
                                            "Windows screen capture restarted successfully"
                                        );
                                        output_pipeline::emit_health(
                                            &stats_health_tx,
                                            output_pipeline::PipelineHealthEvent::SourceRestarted,
                                        );
                                        capturer = Some(new_cap);
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "Failed to start restarted capturer");
                                        let _ = error_tx.try_send(CaptureClosureEvent {
                                            kind: CaptureClosureKind::Transient,
                                            message: format!("restart_start_failed: {e}"),
                                        });
                                    }
                                },
                                Err(e) => {
                                    warn!(error = %e, "Failed to recreate capturer");
                                    let _ = error_tx.try_send(CaptureClosureEvent {
                                        kind: CaptureClosureKind::Transient,
                                        message: format!("restart_create_failed: {e}"),
                                    });
                                }
                            }
                        }
                        Ok(VideoControl::Start(_)) => {}
                        Err(_) => break,
                    }
                }

                drop(drop_guard);

                Ok(())
            }
        });

        let monitor_health_tx = ctx.health_tx().clone();
        ctx.tasks().spawn("d3d-capture", async move {
            let mut restart_count = 0u32;

            while let Some(event) = error_rx.next().await {
                let is_device_lost = matches!(event.kind, CaptureClosureKind::DeviceRemoved { .. });
                match event.kind {
                    CaptureClosureKind::DeviceRemoved { hresult } => {
                        error!(
                            hresult = format!("0x{:08x}", hresult),
                            message = %event.message,
                            "Windows D3D device removed"
                        );
                        output_pipeline::emit_health(
                            &monitor_health_tx,
                            output_pipeline::PipelineHealthEvent::DeviceLost {
                                subsystem: "d3d11".to_string(),
                            },
                        );
                    }
                    CaptureClosureKind::TargetLost => {
                        warn!(message = %event.message, "Windows capture target lost");
                        output_pipeline::emit_health(
                            &monitor_health_tx,
                            output_pipeline::PipelineHealthEvent::CaptureTargetLost {
                                target: "display".to_string(),
                            },
                        );
                        return Err(anyhow!("Windows capture target lost: {}", event.message));
                    }
                    CaptureClosureKind::Transient => {}
                }

                if is_device_lost && is_desktop_area {
                    return Err(anyhow!(
                        "Windows desktop area capture lost its device: {}",
                        event.message
                    ));
                }

                if restart_count < MAX_CAPTURE_RESTARTS {
                    restart_count += 1;
                    warn!(
                        restart_count,
                        max_restarts = MAX_CAPTURE_RESTARTS,
                        message = %event.message,
                        "Windows capture interrupted, attempting restart"
                    );
                    tokio::time::sleep(RESTART_DELAY).await;
                    let control = if is_device_lost {
                        VideoControl::RecreateDevice
                    } else {
                        VideoControl::Restart
                    };
                    if monitor_ctrl_tx.try_send(control).is_err() {
                        return Err(anyhow!("Failed to send restart signal to capture thread"));
                    }
                    continue;
                }

                return Err(anyhow!(
                    "Windows screen capture failed after {} restart attempts: {}",
                    MAX_CAPTURE_RESTARTS,
                    event.message
                ));
            }

            Ok(())
        });

        Ok(Self {
            video_info,
            ctrl_tx,
            first_frame: Some(first_rx),
        })
    }

    fn video_info(&self) -> VideoInfo {
        self.video_info
    }

    fn start(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        let (tx, rx) = oneshot::channel();
        let _ = self.ctrl_tx.send(VideoControl::Start(tx));

        let first_frame = self.first_frame.take();
        async move {
            tokio::time::timeout(Duration::from_secs(5), async move {
                let first_frame =
                    first_frame.ok_or_else(|| anyhow!("Windows screen source already started"))?;
                match rx.await {
                    Ok(started) => started?,
                    Err(_) => {
                        return Err(match first_frame.await {
                            Ok(Err(reason)) => anyhow!(reason),
                            _ => anyhow!("Windows screen capture stopped before it started"),
                        });
                    }
                }
                wait_for_first_screen_frame(first_frame, Duration::from_secs(5)).await
            })
            .await
            .map_err(|_| {
                anyhow!("Windows screen startup did not acknowledge an accepted frame within 5s")
            })?
        }
        .boxed()
    }

    fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        let (tx, rx) = oneshot::channel();
        let _ = self.ctrl_tx.send(VideoControl::Stop(tx));

        async {
            rx.await??;
            Ok(())
        }
        .boxed()
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum StartCapturingError {
    #[error("AlreadyCapturing")]
    AlreadyCapturing,
    #[error("CreateCapturer/{0}")]
    CreateCapturer(scap_direct3d::NewCapturerError),
    #[error("StartCapturer/{0}")]
    StartCapturer(::windows::core::Error),
}

const DEVICE_POLL_INTERVAL: Duration = Duration::from_secs(2);
const SILENCE_CHUNK_DURATION: Duration = Duration::from_millis(20);
const SILENCE_CHUNKS_ON_SWITCH: usize = 5;

pub struct SystemAudioSourceConfig;

struct CapturerState {
    capturer: Option<scap_cpal::Capturer>,
    is_started: bool,
    device_name: String,
}

pub struct SystemAudioSource {
    state: Arc<std::sync::Mutex<CapturerState>>,
    cancel_token: CancellationToken,
    audio_info: AudioInfo,
}

struct SystemAudioResampler {
    context: ffmpeg::software::resampling::Context,
}

impl SystemAudioResampler {
    fn create(source_info: &AudioInfo, target_info: &AudioInfo) -> Option<Self> {
        // The capture frames come from `scap_ffmpeg::DataExt::as_ffmpeg`, which tags
        // them with `ChannelLayout::default(channels)`. swr revalidates each frame's
        // layout against the context and silently drops it on a mismatch, so the
        // context must use the same `default` layout — the named `channel_layout()`
        // masks diverge for 3/4/5/6-channel devices (e.g. a 5.1 loopback output) and
        // would silence system audio entirely.
        let source_layout = source_info.packed_channel_layout();
        let context = ffmpeg::software::resampler(
            (
                source_info.sample_format,
                source_layout,
                source_info.sample_rate,
            ),
            (
                target_info.sample_format,
                target_info.channel_layout(),
                target_info.sample_rate,
            ),
        )
        .ok()?;
        Some(Self { context })
    }

    fn resample(
        &mut self,
        input: ffmpeg::frame::Audio,
        timestamp: Timestamp,
    ) -> Option<AudioFrame> {
        let input_samples = input.samples();
        let src_rate = self.context.input().rate.max(1) as u64;
        let target = *self.context.output();
        let dst_rate = target.rate.max(1) as u64;

        let pending_output_samples = self
            .context
            .delay()
            .map(|d| d.output.max(0) as u64)
            .unwrap_or(0);
        let resampled_from_input = (input_samples as u64)
            .saturating_mul(dst_rate)
            .div_ceil(src_rate);
        let capacity = pending_output_samples
            .saturating_add(resampled_from_input)
            .saturating_add(16)
            .min(i32::MAX as u64) as usize;

        let mut output = ffmpeg::frame::Audio::new(target.format, capacity, target.channel_layout);
        self.context.run(&input, &mut output).ok()?;
        if output.samples() == 0 {
            return None;
        }
        // Use the input frame's capture timestamp directly (no resampler-delay offset):
        // the muxer reconciles the timeline via capture timestamps + sample counts, and
        // subtracting the swr delay makes resampled frames overlap, causing the muxer to
        // drop ~0.8s of audio up front (see the mic path for the same fix).
        Some(AudioFrame::new(output, timestamp))
    }
}

fn get_current_device_name() -> String {
    let host = cpal::default_host();
    host.default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default()
}

fn create_silence_frame(info: &AudioInfo, sample_count: usize) -> ffmpeg::frame::Audio {
    let mut frame =
        ffmpeg::frame::Audio::new(info.sample_format, sample_count, info.channel_layout());
    for i in 0..frame.planes() {
        frame.data_mut(i).fill(0);
    }
    frame.set_rate(info.sample_rate);
    frame
}

fn create_system_audio_capturer(
    mut tx: mpsc::Sender<AudioFrame>,
    frame_counter: Arc<AtomicU32>,
    drop_counter: Arc<AtomicU32>,
    error_flag: Arc<AtomicBool>,
    last_timestamp: Arc<std::sync::Mutex<Option<Timestamp>>>,
    _target_info: AudioInfo,
    stall_health_tx: output_pipeline::HealthSender,
) -> Result<scap_cpal::Capturer, scap_cpal::CapturerError> {
    let device_info = Direct3DCapture::audio_info();
    let target_info = crate::sources::audio_mixer::AudioMixer::INFO;
    let device_differs_from_target = !device_info.matches_format(&target_info);
    let mut capture_clock =
        crate::sources::capture_clock::CaptureClock::new(cap_timestamp::Timestamps::now());

    let mut resampler = if device_differs_from_target {
        info!(
            device_rate = device_info.sample_rate,
            device_channels = device_info.channels,
            device_format = ?device_info.sample_format,
            target_rate = target_info.sample_rate,
            target_channels = target_info.channels,
            target_format = ?target_info.sample_format,
            "System audio device differs from output target, creating resampler"
        );
        SystemAudioResampler::create(&device_info, &target_info)
    } else {
        None
    };

    scap_cpal::create_capturer(
        {
            let frame_counter = frame_counter.clone();
            let drop_counter = drop_counter.clone();
            let last_timestamp = last_timestamp.clone();
            move |data, info, config| {
                use scap_ffmpeg::*;

                thread_local! {
                    static MMCSS_HANDLE: std::cell::RefCell<
                        Option<cap_mediafoundation_utils::MmcssAudioHandle>,
                    > = const { std::cell::RefCell::new(None) };
                }
                MMCSS_HANDLE.with(|cell| {
                    let mut h = cell.borrow_mut();
                    if h.is_none() {
                        *h = cap_mediafoundation_utils::MmcssAudioHandle::register_audio();
                    }
                });

                let buffer_duration = Duration::from_secs_f64(
                    data.len() as f64
                        / f64::from(config.channels.max(1))
                        / f64::from(config.sample_rate.0.max(1)),
                );
                let timestamp = capture_clock.timestamp(
                    Timestamp::from_cpal(info.timestamp().capture),
                    std::time::Instant::now(),
                    buffer_duration,
                );
                let raw_frame = data.as_ffmpeg(config);

                let frame = if let Some(ref mut ctx) = resampler {
                    match ctx.resample(raw_frame, timestamp) {
                        Some(f) => f,
                        None => {
                            drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            return;
                        }
                    }
                } else {
                    AudioFrame::new(raw_frame, timestamp)
                };

                if let Ok(mut guard) = last_timestamp.lock() {
                    *guard = Some(timestamp);
                }

                match output_pipeline::send_with_stall_budget_futures(
                    &mut tx,
                    frame,
                    "screen-system-audio",
                    &stall_health_tx,
                ) {
                    output_pipeline::StallSendOutcome::Sent => {
                        frame_counter.fetch_add(1, atomic::Ordering::Relaxed);
                    }
                    output_pipeline::StallSendOutcome::StalledAndDropped { .. }
                    | output_pipeline::StallSendOutcome::Disconnected => {
                        drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                    }
                }
            }
        },
        {
            let error_flag = error_flag.clone();
            move |e| {
                warn!("System audio CPAL stream error: {e}");
                error_flag.store(true, atomic::Ordering::Relaxed);
            }
        },
    )
}

impl output_pipeline::AudioSource for SystemAudioSource {
    type Config = SystemAudioSourceConfig;

    fn setup(
        _: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        let cancel_token = ctx.stop_token().child_token();

        ctx.tasks().spawn("system-audio", {
            let cancel = cancel_token.clone();
            async move {
                cancel.cancelled().await;
                Ok(())
            }
        });

        let audio_info = crate::sources::audio_mixer::AudioMixer::INFO;
        let device_name = get_current_device_name();

        let frame_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
        let drop_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
        let error_flag = Arc::new(AtomicBool::new(false));
        let last_timestamp: Arc<std::sync::Mutex<Option<Timestamp>>> =
            Arc::new(std::sync::Mutex::new(None));
        let device_switch_count: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));
        let silence_frame_count: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        let stall_health_tx_for_setup = ctx.health_tx().clone();
        let setup_result = create_system_audio_capturer(
            tx.clone(),
            frame_counter.clone(),
            drop_counter.clone(),
            error_flag.clone(),
            last_timestamp.clone(),
            audio_info,
            stall_health_tx_for_setup,
        );

        let state = Arc::new(std::sync::Mutex::new(CapturerState {
            capturer: None,
            is_started: false,
            device_name,
        }));

        let stall_health_tx_for_watcher = ctx.health_tx().clone();
        let runtime = tokio::runtime::Handle::current();
        ctx.tasks().spawn_thread("system-audio-watcher", {
            let state = state.clone();
            let mut watcher_tx = tx.clone();
            let frame_counter = frame_counter.clone();
            let drop_counter = drop_counter.clone();
            let error_flag = error_flag.clone();
            let last_timestamp = last_timestamp.clone();
            let cancel = cancel_token.clone();
            let device_switch_count = device_switch_count.clone();
            let silence_frame_count = silence_frame_count.clone();
            let stall_health_tx = stall_health_tx_for_watcher;

            move || {
                let silence_chunk_samples = (audio_info.sample_rate as f64
                    * SILENCE_CHUNK_DURATION.as_secs_f64())
                .ceil() as usize;

                loop {
                    if runtime
                        .block_on(async {
                            tokio::time::timeout(DEVICE_POLL_INTERVAL, cancel.cancelled()).await
                        })
                        .is_ok()
                    {
                        break;
                    }

                    let current_name = get_current_device_name();
                    let mut guard = match state.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };

                    let stream_error = error_flag.swap(false, atomic::Ordering::Relaxed);
                    let device_changed = current_name != guard.device_name;
                    let needs_retry = guard.capturer.is_none() && guard.is_started;

                    if !device_changed && !stream_error && !needs_retry {
                        continue;
                    }

                    if device_changed {
                        info!(
                            old_device = guard.device_name,
                            new_device = current_name,
                            "Default audio output device changed"
                        );
                        device_switch_count.fetch_add(1, atomic::Ordering::Relaxed);
                    } else if stream_error {
                        info!("System audio stream error detected, recreating capturer");
                    } else {
                        info!("Retrying system audio capturer creation");
                    }

                    let was_started = guard.is_started;

                    if let Some(old_capturer) = guard.capturer.take() {
                        if was_started {
                            let _ = old_capturer.pause();
                        }
                        drop(old_capturer);
                    }

                    let base_ts = last_timestamp.lock().ok().and_then(|g| *g);
                    if let Some(mut ts) = base_ts {
                        let chunk_duration = Duration::from_secs_f64(
                            silence_chunk_samples as f64 / audio_info.sample_rate as f64,
                        );
                        for _ in 0..SILENCE_CHUNKS_ON_SWITCH {
                            ts = ts + chunk_duration;
                            let silence = create_silence_frame(&audio_info, silence_chunk_samples);
                            let frame = AudioFrame::new(silence, ts);
                            match output_pipeline::send_with_stall_budget_futures(
                                &mut watcher_tx,
                                frame,
                                "screen-system-audio:silence-fill",
                                &stall_health_tx,
                            ) {
                                output_pipeline::StallSendOutcome::Sent => {
                                    silence_frame_count.fetch_add(1, atomic::Ordering::Relaxed);
                                }
                                output_pipeline::StallSendOutcome::StalledAndDropped { .. } => {
                                    drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                    break;
                                }
                                output_pipeline::StallSendOutcome::Disconnected => break,
                            }
                        }
                        if let Ok(mut lt) = last_timestamp.lock() {
                            *lt = Some(ts);
                        }
                    }

                    match create_system_audio_capturer(
                        watcher_tx.clone(),
                        frame_counter.clone(),
                        drop_counter.clone(),
                        error_flag.clone(),
                        last_timestamp.clone(),
                        audio_info,
                        stall_health_tx.clone(),
                    ) {
                        Ok(new_capturer) => {
                            if was_started {
                                match new_capturer.play() {
                                    Ok(()) => {
                                        info!(
                                            device = current_name,
                                            "System audio capturer restarted on new device"
                                        );
                                    }
                                    Err(e) => {
                                        warn!(
                                            device = current_name,
                                            error = %e,
                                            "Failed to start capturer on new device, will retry"
                                        );
                                        guard.device_name = current_name;
                                        continue;
                                    }
                                }
                            }
                            guard.capturer = Some(new_capturer);
                            guard.device_name = current_name;
                        }
                        Err(e) => {
                            warn!(
                                device = current_name,
                                error = %e,
                                "Failed to create capturer for new audio device, will retry"
                            );
                            guard.device_name = current_name;
                        }
                    }
                }

                Ok(())
            }
        });

        let cancel = cancel_token.clone();

        async move {
            let capturer = setup_result.map_err(|e| anyhow!("{e}"))?;
            if capturer.has_silence_keepalive() {
                info!("System audio loopback silence keepalive active");
            } else {
                warn!(
                    "System audio loopback has no silence keepalive; \
                     capture will only produce packets while other apps play audio"
                );
            }
            if let Ok(mut guard) = state.lock() {
                guard.capturer = Some(capturer);
            }

            tokio::spawn({
                let cancel = cancel.clone();
                async move {
                    loop {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                            _ = cancel.cancelled() => break,
                        }
                        let captured = frame_counter.load(atomic::Ordering::Relaxed);
                        let dropped = drop_counter.load(atomic::Ordering::Relaxed);
                        let switches = device_switch_count.load(atomic::Ordering::Relaxed);
                        let silence = silence_frame_count.load(atomic::Ordering::Relaxed);
                        let total = captured + dropped;

                        if dropped > 0 || switches > 0 {
                            let drop_pct = if total > 0 {
                                100.0 * dropped as f64 / total as f64
                            } else {
                                0.0
                            };
                            warn!(
                                captured = captured,
                                dropped = dropped,
                                drop_pct = format!("{:.1}%", drop_pct),
                                device_switches = switches,
                                silence_frames = silence,
                                "System audio capture stats"
                            );
                        } else if captured > 0 {
                            debug!(captured = captured, "System audio frames captured");
                        }
                    }
                }
            });

            Ok(Self {
                state,
                cancel_token: cancel,
                audio_info,
            })
        }
    }

    fn audio_info(&self) -> cap_media_info::AudioInfo {
        self.audio_info
    }

    fn start(&mut self) -> impl Future<Output = anyhow::Result<()>> {
        let result = match self.state.lock() {
            Ok(mut guard) => {
                guard.is_started = true;
                match &guard.capturer {
                    Some(c) => c.play().map_err(|e| anyhow!("{e}")),
                    None => Ok(()),
                }
            }
            Err(_) => Err(anyhow!("System audio state lock poisoned")),
        };
        async move { result }
    }

    fn stop(&mut self) -> impl Future<Output = anyhow::Result<()>> {
        self.cancel_token.cancel();
        if let Ok(guard) = self.state.lock()
            && let Some(ref capturer) = guard.capturer
            && let Err(err) = capturer.pause()
        {
            warn!("system audio capturer pause failed: {err}");
        }
        async { Ok(()) }
    }
}

#[cfg(test)]
mod first_screen_frame_tests {
    use super::*;

    fn signal() -> (FirstScreenFrame, oneshot::Receiver<Result<(), String>>) {
        let (sender, receiver) = oneshot::channel();
        (
            FirstScreenFrame(Arc::new(Mutex::new(Some(sender)))),
            receiver,
        )
    }

    #[tokio::test]
    async fn accepted_frame_acknowledges_startup_once() {
        let (signal, receiver) = signal();
        signal.complete(Ok(()));
        signal.complete(Err("later close".into()));
        wait_for_first_screen_frame(receiver, Duration::from_millis(20))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn early_closed_source_cannot_become_ready_on_a_late_frame() {
        let (signal, receiver) = signal();
        signal.complete(Err("capture target lost".into()));
        signal.complete(Ok(()));
        let error = wait_for_first_screen_frame(receiver, Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("capture target lost"));
    }

    #[tokio::test]
    async fn no_accepted_screen_frame_is_a_startup_error() {
        let (_signal, receiver) = signal();
        let error = wait_for_first_screen_frame(receiver, Duration::from_millis(1))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("no accepted frame"));
    }

    #[tokio::test]
    async fn dropped_capture_thread_is_not_startup_success() {
        let (signal, receiver) = signal();
        drop(signal);
        let error = wait_for_first_screen_frame(receiver, Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("closed before its first frame"));
    }
}

#[cfg(test)]
mod capture_target_tests {
    use super::*;
    use scap_targets::bounds::{PhysicalPosition, PhysicalSize};

    fn bounds() -> CropBounds {
        CropBounds::new(
            PhysicalPosition::new(120.0, 80.0),
            PhysicalSize::new(640.0, 480.0),
        )
    }

    #[test]
    fn a_display_target_keeps_its_crop() {
        let kept = crop_for_target(None, Some(bounds())).expect("crop kept");
        assert_eq!(kept.position().x(), 120.0);
        assert_eq!(kept.size().width(), 640.0);
        assert!(crop_for_target(None, None).is_none());
    }

    #[test]
    fn a_window_recording_is_sized_to_its_capture_item_floored_to_even() {
        let size = even_capture_size(801, 601).expect("size");
        assert_eq!((size.width(), size.height()), (800.0, 600.0));
        let size = even_capture_size(786, 593).expect("size");
        assert_eq!((size.width(), size.height()), (786.0, 592.0));
        assert!(even_capture_size(1, 600).is_none());
        assert!(even_capture_size(-4, 600).is_none());
    }

    #[test]
    fn a_window_target_captures_the_window_rather_than_a_crop_of_the_display() {
        let window: WindowId = "1234".parse().unwrap();
        assert!(crop_for_target(Some(&window), Some(bounds())).is_none());
    }
}

#[cfg(test)]
mod frame_scaler_tests {
    use super::*;
    use ::windows::{
        Win32::{
            Foundation::HMODULE,
            Graphics::{
                Direct3D::D3D_DRIVER_TYPE_WARP,
                Direct3D11::{
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice,
                },
            },
        },
        core::{IUnknown, Interface},
    };

    fn warp_device() -> ID3D11Device {
        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .expect("create WARP device");
        device.expect("WARP device")
    }

    #[test]
    fn scaled_frames_are_created_on_the_recreated_device() {
        let recreated = warp_device();
        let scaler = Arc::new(Mutex::new(WindowsFrameScaler::new(
            64,
            36,
            Direct3DCapture::PIXEL_FORMAT,
            warp_device(),
        )));
        scaler.lock().unwrap().replace_device(recreated.clone());

        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let item = Display::primary()
            .raw_handle()
            .try_as_capture_item()
            .expect("display capture item");
        let mut capturer = scap_direct3d::Capturer::new(
            item,
            scap_direct3d::Settings {
                is_border_required: Some(false),
                is_cursor_capture_enabled: Some(false),
                pixel_format: Direct3DCapture::PIXEL_FORMAT,
                ..Default::default()
            },
            {
                let scaler = scaler.clone();
                move |frame| {
                    let scaled = scaler.lock().unwrap().scale_frame(&frame).map(|scaled| {
                        let device = unsafe { scaled.texture().GetDevice() };
                        (scaled.width(), scaled.height(), device)
                    });
                    let _ = tx.try_send(scaled);
                    Ok(())
                }
            },
            || Ok(()),
            Some(recreated.clone()),
        )
        .expect("create capturer");
        capturer.start().expect("start capture");
        let scaled = rx.recv_timeout(Duration::from_secs(10));
        capturer.stop().expect("stop capture");

        let (width, height, device) = scaled
            .expect("a captured frame")
            .expect("the frame is scaled after the device is recreated");
        assert_eq!((width, height), (64, 36));
        assert_eq!(
            device
                .expect("scaled texture device")
                .cast::<IUnknown>()
                .unwrap(),
            recreated.cast::<IUnknown>().unwrap()
        );
    }
}

#[cfg(test)]
mod desktop_compositor_tests {
    use super::*;
    use crate::screen_capture::resolve_desktop_area_plan;
    use scap_targets::bounds::{PhysicalBounds, PhysicalPosition, PhysicalSize};

    fn solid_texture(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        rgba: [u8; 4],
    ) -> ID3D11Texture2D {
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for px in pixels.chunks_exact_mut(4) {
            px.copy_from_slice(&rgba);
        }
        create_composited_texture(
            device,
            width,
            height,
            Direct3DCapture::PIXEL_FORMAT,
            Some(&pixels),
        )
        .expect("solid texture")
    }

    fn pixel_at(frame: &ffmpeg::frame::Video, x: u32, y: u32) -> [u8; 4] {
        let stride = frame.stride(0);
        let offset = y as usize * stride + x as usize * 4;
        let data = frame.data(0);
        [
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]
    }

    #[test]
    fn composites_two_offset_mixed_dpi_monitors_into_one_desktop_layout_frame() {
        let device = crate::capture_pipeline::create_d3d_device().expect("d3d11 device");
        let monitors = vec![
            (
                "1".parse().unwrap(),
                PhysicalBounds::new(
                    PhysicalPosition::new(-2560.0, -120.0),
                    PhysicalSize::new(2560.0, 1440.0),
                ),
            ),
            (
                "2".parse().unwrap(),
                PhysicalBounds::new(
                    PhysicalPosition::new(0.0, 180.0),
                    PhysicalSize::new(1920.0, 1080.0),
                ),
            ),
        ];
        let plan = resolve_desktop_area_plan(
            PhysicalBounds::new(
                PhysicalPosition::new(-160.0, 60.0),
                PhysicalSize::new(320.0, 240.0),
            ),
            &monitors,
        )
        .expect("desktop area plan");

        assert_eq!((plan.canvas_width, plan.canvas_height), (320, 240));
        assert_eq!(plan.regions.len(), 2);
        assert_eq!(
            (
                plan.regions[0].dest_x,
                plan.regions[0].dest_y,
                plan.regions[0].source_width,
                plan.regions[0].source_height
            ),
            (0, 0, 160, 240)
        );
        assert_eq!(
            (
                plan.regions[1].dest_x,
                plan.regions[1].dest_y,
                plan.regions[1].source_width,
                plan.regions[1].source_height
            ),
            (160, 120, 160, 120)
        );

        let mut compositor =
            DesktopCompositor::new(device.clone(), Direct3DCapture::PIXEL_FORMAT, plan, None)
                .expect("compositor");

        let left_tex = solid_texture(&device, 160, 240, [220, 40, 60, 255]);
        let right_tex = solid_texture(&device, 160, 120, [30, 180, 90, 255]);

        let first = compositor
            .composite_texture(0, &left_tex, 160, 240, 1_000_000)
            .expect("first monitor");
        assert!(matches!(first, CompositorStep::WaitingForAllRegions));

        let second = compositor
            .composite_texture(1, &right_tex, 160, 120, 1_000_000)
            .expect("second monitor");
        let CompositorStep::Emit(composited, ts1) = second else {
            panic!("expected emitted composited frame");
        };
        assert_eq!(ts1, 1_000_000);
        assert_eq!((composited.width, composited.height), (320, 240));

        let retained_texture = composited.texture.clone();
        let ff = ScreenFrame::Composited(composited)
            .as_ffmpeg()
            .expect("ffmpeg readback");
        assert_eq!(pixel_at(&ff, 10, 10), [220, 40, 60, 255]);
        assert_eq!(pixel_at(&ff, 159, 239), [220, 40, 60, 255]);
        assert_eq!(pixel_at(&ff, 160, 10), [0, 0, 0, 255]);
        assert_eq!(pixel_at(&ff, 319, 119), [0, 0, 0, 255]);
        assert_eq!(pixel_at(&ff, 160, 120), [30, 180, 90, 255]);
        assert_eq!(pixel_at(&ff, 319, 239), [30, 180, 90, 255]);

        let updated_left = solid_texture(&device, 160, 240, [50, 90, 240, 255]);
        let third = compositor
            .composite_texture(0, &updated_left, 160, 240, 900_000)
            .expect("out-of-order timestamp");
        let CompositorStep::Emit(composited2, ts2) = third else {
            panic!("expected second emitted frame");
        };
        assert!(ts2 > ts1);
        assert_ne!(composited2.texture, retained_texture);

        let ff2 = ScreenFrame::Composited(composited2)
            .as_ffmpeg()
            .expect("ffmpeg readback 2");
        assert_eq!(pixel_at(&ff2, 80, 120), [50, 90, 240, 255]);
        assert_eq!(pixel_at(&ff2, 240, 180), [30, 180, 90, 255]);
        assert_eq!(pixel_at(&ff2, 240, 40), [0, 0, 0, 255]);
    }

    #[test]
    fn composited_frame_scales_on_recreated_device_and_encodes_into_one_video_segment() {
        use ::windows::core::{IUnknown, Interface};
        use cap_enc_ffmpeg::h264::H264Preset;
        use cap_enc_ffmpeg::segmented_stream::{
            SegmentedVideoEncoder, SegmentedVideoEncoderConfig,
        };

        let initial_device = crate::capture_pipeline::create_d3d_device().expect("initial d3d11");
        let recreated_device =
            crate::capture_pipeline::create_d3d_device().expect("recreated d3d11");
        let monitors = vec![
            (
                "1".parse().unwrap(),
                PhysicalBounds::new(
                    PhysicalPosition::new(-2560.0, -120.0),
                    PhysicalSize::new(2560.0, 1440.0),
                ),
            ),
            (
                "2".parse().unwrap(),
                PhysicalBounds::new(
                    PhysicalPosition::new(0.0, 180.0),
                    PhysicalSize::new(1920.0, 1080.0),
                ),
            ),
        ];
        let plan = resolve_desktop_area_plan(
            PhysicalBounds::new(
                PhysicalPosition::new(-160.0, 60.0),
                PhysicalSize::new(320.0, 240.0),
            ),
            &monitors,
        )
        .expect("desktop area plan");

        let mut compositor = DesktopCompositor::new(
            recreated_device.clone(),
            Direct3DCapture::PIXEL_FORMAT,
            plan,
            None,
        )
        .expect("compositor on recreated device");
        let left = solid_texture(&recreated_device, 160, 240, [220, 40, 60, 255]);
        let right = solid_texture(&recreated_device, 160, 120, [30, 180, 90, 255]);

        assert!(matches!(
            compositor
                .composite_texture(0, &left, 160, 240, 1_000_000)
                .expect("left initial"),
            CompositorStep::WaitingForAllRegions
        ));
        let CompositorStep::Emit(composited, _) = compositor
            .composite_texture(1, &right, 160, 120, 1_100_000)
            .expect("right initial")
        else {
            panic!("expected composited frame");
        };

        let mut scaler =
            WindowsFrameScaler::new(160, 120, Direct3DCapture::PIXEL_FORMAT, initial_device);
        scaler.replace_device(recreated_device.clone());
        let scaled = scaler
            .scale_composited(&composited)
            .expect("read composited frame")
            .expect("scale composited frame");
        assert_eq!((scaled.width(), scaled.height()), (160, 120));
        let scaled_device = unsafe { scaled.texture().GetDevice() }.expect("scaled device");
        assert_eq!(
            scaled_device.cast::<IUnknown>().unwrap(),
            recreated_device.cast::<IUnknown>().unwrap()
        );

        let dir = tempfile::tempdir().expect("tempdir");
        let video_info = VideoInfo::from_raw_ffmpeg(Direct3DCapture::pixel_format(), 320, 240, 30);
        let mut encoder = SegmentedVideoEncoder::init_with_timed_fragments(
            dir.path().to_path_buf(),
            video_info,
            SegmentedVideoEncoderConfig {
                segment_duration: Duration::from_secs(2),
                preset: H264Preset::Ultrafast,
                bpp: 0.15,
                output_size: Some((320, 240)),
                prefer_videotoolbox_hw_input: false,
            },
            true,
        )
        .expect("init segmented video encoder");

        for i in 0..3u64 {
            let right_updated = solid_texture(
                &recreated_device,
                160,
                120,
                [30, (180 + i * 10) as u8, 90, 255],
            );
            let CompositorStep::Emit(frame, _) = compositor
                .composite_texture(1, &right_updated, 160, 120, 2_000_000 + i as i64 * 333_333)
                .expect("composite frame")
            else {
                panic!("expected composited frame {i}");
            };
            let ff = ScreenFrame::Composited(frame)
                .as_ffmpeg()
                .expect("ffmpeg readback");
            encoder
                .queue_frame(ff, Duration::from_millis(i * 33))
                .expect("queue composited frame");
        }
        encoder
            .finish_with_timestamp(Duration::from_millis(100))
            .expect("finish segmented encoder");

        let init_path = dir.path().join("init.mp4");
        assert!(init_path.exists());
        assert!(std::fs::metadata(&init_path).unwrap().len() > 0);
        let has_segment = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry.path().extension().and_then(|e| e.to_str()) == Some("m4s")
                    && entry.metadata().map(|m| m.len() > 0).unwrap_or(false)
            });
        assert!(has_segment, "expected at least one non-empty .m4s segment");

        let probe = ffmpeg::format::input(&init_path).expect("probe init.mp4");
        let stream = probe
            .streams()
            .best(ffmpeg::media::Type::Video)
            .expect("video stream");
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .expect("codec context")
            .decoder()
            .video()
            .expect("video decoder");
        assert_eq!((decoder.width(), decoder.height()), (320, 240));
    }
}
