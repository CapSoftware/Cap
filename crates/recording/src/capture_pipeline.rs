use crate::{
    SharedPauseState, StudioQuality,
    output_pipeline::*,
    sources::screen_capture::{self, CropBounds, ScreenCaptureFormat, ScreenCaptureTarget},
};

#[cfg(target_os = "macos")]
use crate::output_pipeline::{MacOSFragmentedM4SMuxer, MacOSFragmentedM4SMuxerConfig};
#[cfg(windows)]
use crate::output_pipeline::{WindowsFragmentedM4SMuxer, WindowsFragmentedM4SMuxerConfig};
use anyhow::anyhow;
use cap_enc_ffmpeg::h264::H264EncoderBuilder;
#[cfg(windows)]
use cap_enc_ffmpeg::h264::H264Preset;
use cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent;
use cap_timestamp::Timestamps;
use std::path::PathBuf;

#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
#[derive(Clone, Debug)]
pub struct EncoderPreferences {
    force_software: Arc<AtomicBool>,
}

#[cfg(windows)]
impl Default for EncoderPreferences {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
impl EncoderPreferences {
    pub fn new() -> Self {
        Self {
            force_software: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn should_force_software(&self) -> bool {
        self.force_software.load(Ordering::Relaxed)
    }

    pub fn force_software_only(&self) {
        self.force_software.store(true, Ordering::Relaxed);
    }
}

pub trait MakeCapturePipeline: ScreenCaptureFormat + std::fmt::Debug + 'static {
    #[allow(clippy::too_many_arguments)]
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
        fragmented: bool,
        use_oop_muxer: bool,
        shared_pause_state: Option<SharedPauseState>,
        output_size: Option<(u32, u32)>,
        quality: StudioQuality,
        #[cfg(windows)] encoder_preferences: EncoderPreferences,
    ) -> anyhow::Result<OutputPipeline>
    where
        Self: Sized;

    async fn make_instant_segmented_video_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        segments_dir: PathBuf,
        output_size: (u32, u32),
        start_time: Timestamps,
        segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    ) -> anyhow::Result<OutputPipeline>
    where
        Self: Sized;
}

pub struct Stop;

#[cfg(target_os = "macos")]
impl MakeCapturePipeline for screen_capture::CMSampleBufferCapture {
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
        fragmented: bool,
        use_oop_muxer: bool,
        shared_pause_state: Option<SharedPauseState>,
        output_size: Option<(u32, u32)>,
        quality: StudioQuality,
    ) -> anyhow::Result<OutputPipeline> {
        let ultra = quality == StudioQuality::Ultra;

        tracing::debug!(
            ?quality,
            ultra,
            fragmented,
            use_oop_muxer,
            "Studio mode capture pipeline quality selection"
        );

        if fragmented {
            let fragments_dir = output_path
                .parent()
                .map(|p| p.join("display"))
                .unwrap_or_else(|| output_path.with_file_name("display"));

            let bpp = if ultra {
                H264EncoderBuilder::ULTRA_BPP
            } else {
                H264EncoderBuilder::QUALITY_BPP
            };

            let preset = if ultra {
                cap_enc_ffmpeg::h264::H264Preset::Medium
            } else {
                cap_enc_ffmpeg::h264::H264Preset::Ultrafast
            };

            tracing::debug!(bpp, ?preset, "Fragmented studio pipeline encoder config");

            let oop_ok = if use_oop_muxer {
                match crate::output_pipeline::oop_muxer::resolve_muxer_binary() {
                    Ok(bin_path) => {
                        tracing::info!(
                            bin_path = %bin_path.display(),
                            "Using out-of-process fragmented M4S muxer (Phase 5 OOP isolation)"
                        );
                        true
                    }
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            "out_of_process_muxer requested but cap-muxer binary is unavailable; \
                             falling back to in-process muxer to preserve the recording"
                        );
                        false
                    }
                }
            } else {
                false
            };

            if oop_ok {
                use crate::output_pipeline::{
                    OutOfProcessFragmentedM4SMuxer, OutOfProcessFragmentedM4SMuxerConfig,
                };

                OutputPipeline::builder(fragments_dir)
                    .with_video::<screen_capture::VideoSource>(screen_capture)
                    .with_timestamps(start_time)
                    .build::<OutOfProcessFragmentedM4SMuxer>(OutOfProcessFragmentedM4SMuxerConfig {
                        preset,
                        bpp,
                        output_size,
                        shared_pause_state,
                        ..Default::default()
                    })
                    .await
            } else {
                OutputPipeline::builder(fragments_dir)
                    .with_video::<screen_capture::VideoSource>(screen_capture)
                    .with_timestamps(start_time)
                    .build::<MacOSFragmentedM4SMuxer>(MacOSFragmentedM4SMuxerConfig {
                        preset,
                        bpp,
                        output_size,
                        shared_pause_state,
                        ..Default::default()
                    })
                    .await
            }
        } else {
            tracing::debug!(
                ultra_quality = ultra,
                "Non-fragmented studio pipeline encoder config"
            );

            OutputPipeline::builder(output_path.clone())
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<AVFoundationMp4Muxer>(AVFoundationMp4MuxerConfig {
                    output_height: output_size.map(|(_, h)| h),
                    instant_mode: false,
                    ultra_quality: ultra,
                })
                .await
        }
    }

    async fn make_instant_segmented_video_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        segments_dir: PathBuf,
        output_size: (u32, u32),
        start_time: Timestamps,
        segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    ) -> anyhow::Result<OutputPipeline> {
        OutputPipeline::builder(segments_dir)
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time)
            .build::<MacOSFragmentedM4SMuxer>(MacOSFragmentedM4SMuxerConfig {
                bpp: H264EncoderBuilder::INSTANT_MODE_BPP,
                output_size: Some(output_size),
                segment_tx,
                ..Default::default()
            })
            .await
    }
}

#[cfg(windows)]
impl MakeCapturePipeline for screen_capture::Direct3DCapture {
    #[allow(clippy::too_many_arguments)]
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
        fragmented: bool,
        use_oop_muxer: bool,
        shared_pause_state: Option<SharedPauseState>,
        output_size: Option<(u32, u32)>,
        quality: StudioQuality,
        encoder_preferences: EncoderPreferences,
    ) -> anyhow::Result<OutputPipeline> {
        let ultra = quality == StudioQuality::Ultra;

        if fragmented {
            let fragments_dir = output_path
                .parent()
                .map(|p| p.join("display"))
                .unwrap_or_else(|| output_path.with_file_name("display"));

            let bpp = if ultra {
                H264EncoderBuilder::ULTRA_BPP
            } else {
                H264EncoderBuilder::QUALITY_BPP
            };

            let preset = if ultra {
                H264Preset::Medium
            } else {
                H264Preset::Ultrafast
            };

            let oop_ok = if use_oop_muxer {
                match crate::output_pipeline::oop_muxer::resolve_muxer_binary() {
                    Ok(bin_path) => {
                        tracing::info!(
                            bin_path = %bin_path.display(),
                            "Using Windows out-of-process fragmented M4S muxer (Phase 5 OOP isolation)"
                        );
                        true
                    }
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            "out_of_process_muxer requested but cap-muxer binary is unavailable; \
                             falling back to in-process muxer to preserve the recording"
                        );
                        false
                    }
                }
            } else {
                false
            };

            if oop_ok {
                use crate::output_pipeline::{
                    WindowsOOPFragmentedM4SMuxer, WindowsOOPFragmentedM4SMuxerConfig,
                };

                OutputPipeline::builder(fragments_dir)
                    .with_video::<screen_capture::VideoSource>(screen_capture)
                    .with_timestamps(start_time)
                    .build::<WindowsOOPFragmentedM4SMuxer>(WindowsOOPFragmentedM4SMuxerConfig {
                        segment_duration: std::time::Duration::from_secs(2),
                        preset,
                        bpp,
                        output_size,
                        shared_pause_state,
                        disk_space_callback: None,
                        segment_tx: None,
                        ..Default::default()
                    })
                    .await
            } else {
                OutputPipeline::builder(fragments_dir)
                    .with_video::<screen_capture::VideoSource>(screen_capture)
                    .with_timestamps(start_time)
                    .build::<WindowsFragmentedM4SMuxer>(WindowsFragmentedM4SMuxerConfig {
                        segment_duration: std::time::Duration::from_secs(2),
                        preset,
                        bpp,
                        output_size,
                        shared_pause_state,
                        disk_space_callback: None,
                        segment_tx: None,
                    })
                    .await
            }
        } else {
            let d3d_device = screen_capture.d3d_device.clone();
            let bitrate_multiplier = if ultra { 0.3f32 } else { 0.15f32 };

            OutputPipeline::builder(output_path.clone())
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<WindowsMuxer>(WindowsMuxerConfig {
                    pixel_format: screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi(),
                    d3d_device,
                    bitrate_multiplier,
                    frame_rate: 30u32,
                    output_size: output_size.map(|(w, h)| windows::Graphics::SizeInt32 {
                        Width: w as i32,
                        Height: h as i32,
                    }),
                    encoder_preferences,
                    fragmented: false,
                    frag_duration_us: 2_000_000,
                })
                .await
        }
    }

    async fn make_instant_segmented_video_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        segments_dir: PathBuf,
        output_size: (u32, u32),
        start_time: Timestamps,
        segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    ) -> anyhow::Result<OutputPipeline> {
        OutputPipeline::builder(segments_dir)
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time)
            .build::<WindowsFragmentedM4SMuxer>(WindowsFragmentedM4SMuxerConfig {
                segment_duration: std::time::Duration::from_secs(2),
                preset: H264Preset::Ultrafast,
                bpp: H264EncoderBuilder::INSTANT_MODE_BPP,
                output_size: Some(output_size),
                shared_pause_state: None,
                disk_space_callback: None,
                segment_tx,
            })
            .await
    }
}

#[cfg(target_os = "macos")]
pub type ScreenCaptureMethod = screen_capture::CMSampleBufferCapture;

#[cfg(windows)]
pub type ScreenCaptureMethod = screen_capture::Direct3DCapture;

pub fn target_to_display_and_crop(
    target: &ScreenCaptureTarget,
) -> anyhow::Result<(scap_targets::Display, Option<CropBounds>)> {
    use scap_targets::{bounds::*, *};

    let display = target
        .display()
        .ok_or_else(|| anyhow!("Display not found"))?;

    let crop_bounds = match target {
        ScreenCaptureTarget::Display { .. } => None,
        ScreenCaptureTarget::Window { id } => {
            let window = Window::from_id(id).ok_or_else(|| anyhow!("Window not found"))?;

            #[cfg(target_os = "macos")]
            {
                let raw_display_bounds = display
                    .raw_handle()
                    .logical_bounds()
                    .ok_or_else(|| anyhow!("No display bounds"))?;
                let raw_window_bounds = window
                    .raw_handle()
                    .logical_bounds()
                    .ok_or_else(|| anyhow!("No window bounds"))?;

                Some(LogicalBounds::new(
                    LogicalPosition::new(
                        raw_window_bounds.position().x() - raw_display_bounds.position().x(),
                        raw_window_bounds.position().y() - raw_display_bounds.position().y(),
                    ),
                    raw_window_bounds.size(),
                ))
            }

            #[cfg(windows)]
            {
                let raw_display_position = display
                    .raw_handle()
                    .physical_position()
                    .ok_or_else(|| anyhow!("No display bounds"))?;
                let raw_window_bounds = window
                    .raw_handle()
                    .physical_bounds()
                    .ok_or_else(|| anyhow!("No window bounds"))?;

                Some(PhysicalBounds::new(
                    PhysicalPosition::new(
                        raw_window_bounds.position().x() - raw_display_position.x(),
                        raw_window_bounds.position().y() - raw_display_position.y(),
                    ),
                    raw_window_bounds.size(),
                ))
            }
        }
        ScreenCaptureTarget::Area {
            bounds: relative_bounds,
            ..
        } => {
            #[cfg(target_os = "macos")]
            {
                Some(*relative_bounds)
            }

            #[cfg(windows)]
            {
                let raw_display_size = display
                    .physical_size()
                    .ok_or_else(|| anyhow!("No display bounds"))?;
                let logical_display_size = display
                    .logical_size()
                    .ok_or_else(|| anyhow!("No display logical size"))?;
                Some(PhysicalBounds::new(
                    PhysicalPosition::new(
                        (relative_bounds.position().x() / logical_display_size.width())
                            * raw_display_size.width(),
                        (relative_bounds.position().y() / logical_display_size.height())
                            * raw_display_size.height(),
                    ),
                    PhysicalSize::new(
                        (relative_bounds.size().width() / logical_display_size.width())
                            * raw_display_size.width(),
                        (relative_bounds.size().height() / logical_display_size.height())
                            * raw_display_size.height(),
                    ),
                ))
            }
        }
        ScreenCaptureTarget::CameraOnly => {
            return Err(anyhow!("Camera-only target has no display"));
        }
    };

    Ok((display, crop_bounds))
}

#[cfg(windows)]
pub fn create_d3d_device()
-> windows::core::Result<windows::Win32::Graphics::Direct3D11::ID3D11Device> {
    use windows::Win32::Graphics::{
        Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE},
        Direct3D11::{D3D11_CREATE_DEVICE_FLAG, ID3D11Device},
    };

    let mut device = None;
    let flags = {
        use windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_BGRA_SUPPORT;

        let mut flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        if cfg!(feature = "d3ddebug") {
            use windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_DEBUG;

            flags |= D3D11_CREATE_DEVICE_DEBUG;
        }
        flags
    };
    let mut result = create_d3d_device_with_type(D3D_DRIVER_TYPE_HARDWARE, flags, &mut device);
    if let Err(error) = &result {
        use windows::Win32::Graphics::Dxgi::DXGI_ERROR_UNSUPPORTED;

        if error.code() == DXGI_ERROR_UNSUPPORTED {
            use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;

            result = create_d3d_device_with_type(D3D_DRIVER_TYPE_WARP, flags, &mut device);
        }
    }
    result?;

    fn create_d3d_device_with_type(
        driver_type: D3D_DRIVER_TYPE,
        flags: D3D11_CREATE_DEVICE_FLAG,
        device: *mut Option<ID3D11Device>,
    ) -> windows::core::Result<()> {
        unsafe {
            use windows::Win32::{
                Foundation::HMODULE,
                Graphics::Direct3D11::{D3D11_SDK_VERSION, D3D11CreateDevice},
            };

            D3D11CreateDevice(
                None,
                driver_type,
                HMODULE(std::ptr::null_mut()),
                flags,
                None,
                D3D11_SDK_VERSION,
                Some(device),
                None,
                None,
            )
        }
    }

    Ok(device.unwrap())
}
