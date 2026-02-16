use crate::{
    SharedPauseState,
    feeds::microphone::MicrophoneFeedLock,
    output_pipeline::*,
    sources,
    sources::screen_capture::{self, CropBounds, ScreenCaptureFormat, ScreenCaptureTarget},
};

#[cfg(target_os = "macos")]
use crate::output_pipeline::{MacOSFragmentedM4SMuxer, MacOSFragmentedM4SMuxerConfig};
#[cfg(windows)]
use crate::output_pipeline::{WindowsFragmentedM4SMuxer, WindowsFragmentedM4SMuxerConfig};
use anyhow::anyhow;
#[cfg(windows)]
use cap_enc_ffmpeg::h264::H264Preset;
use cap_timestamp::Timestamps;
use std::{path::PathBuf, sync::Arc};

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
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
        fragmented: bool,
        shared_pause_state: Option<SharedPauseState>,
        output_size: Option<(u32, u32)>,
        #[cfg(windows)] encoder_preferences: EncoderPreferences,
    ) -> anyhow::Result<OutputPipeline>
    where
        Self: Sized;

    async fn make_instant_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        system_audio: Option<screen_capture::SystemAudioSourceConfig>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
        output_resolution: (u32, u32),
        start_time: Timestamps,
        #[cfg(windows)] encoder_preferences: EncoderPreferences,
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
        shared_pause_state: Option<SharedPauseState>,
        output_size: Option<(u32, u32)>,
    ) -> anyhow::Result<OutputPipeline> {
        if fragmented {
            let fragments_dir = output_path
                .parent()
                .map(|p| p.join("display"))
                .unwrap_or_else(|| output_path.with_file_name("display"));

            OutputPipeline::builder(fragments_dir)
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<MacOSFragmentedM4SMuxer>(MacOSFragmentedM4SMuxerConfig {
                    output_size,
                    shared_pause_state,
                    ..Default::default()
                })
                .await
        } else {
            OutputPipeline::builder(output_path.clone())
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<AVFoundationMp4Muxer>(AVFoundationMp4MuxerConfig {
                    output_height: output_size.map(|(_, h)| h),
                    instant_mode: false,
                })
                .await
        }
    }

    async fn make_instant_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        system_audio: Option<screen_capture::SystemAudioSourceConfig>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
        output_resolution: (u32, u32),
        start_time: Timestamps,
    ) -> anyhow::Result<OutputPipeline> {
        let mut output = OutputPipeline::builder(output_path.clone())
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time);

        if let Some(system_audio) = system_audio {
            output = output.with_audio_source::<screen_capture::SystemAudioSource>(system_audio);
        }

        if let Some(mic_feed) = mic_feed {
            output = output.with_audio_source::<sources::Microphone>(mic_feed);
        }

        output
            .build::<AVFoundationMp4Muxer>(AVFoundationMp4MuxerConfig {
                output_height: Some(output_resolution.1),
                instant_mode: true,
            })
            .await
    }
}

#[cfg(windows)]
impl MakeCapturePipeline for screen_capture::Direct3DCapture {
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
        fragmented: bool,
        shared_pause_state: Option<SharedPauseState>,
        output_size: Option<(u32, u32)>,
        encoder_preferences: EncoderPreferences,
    ) -> anyhow::Result<OutputPipeline> {
        if fragmented {
            let fragments_dir = output_path
                .parent()
                .map(|p| p.join("display"))
                .unwrap_or_else(|| output_path.with_file_name("display"));

            OutputPipeline::builder(fragments_dir)
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<WindowsFragmentedM4SMuxer>(WindowsFragmentedM4SMuxerConfig {
                    segment_duration: std::time::Duration::from_secs(3),
                    preset: H264Preset::Ultrafast,
                    output_size,
                    shared_pause_state,
                    disk_space_callback: None,
                })
                .await
        } else {
            let d3d_device = screen_capture.d3d_device.clone();
            OutputPipeline::builder(output_path.clone())
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<WindowsMuxer>(WindowsMuxerConfig {
                    pixel_format: screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi(),
                    d3d_device,
                    bitrate_multiplier: 0.15f32,
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

    async fn make_instant_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        system_audio: Option<screen_capture::SystemAudioSourceConfig>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
        output_resolution: (u32, u32),
        start_time: Timestamps,
        encoder_preferences: EncoderPreferences,
    ) -> anyhow::Result<OutputPipeline> {
        let d3d_device = screen_capture.d3d_device.clone();
        let mut output_builder = OutputPipeline::builder(output_path.clone())
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time);

        if let Some(mic_feed) = mic_feed {
            output_builder = output_builder.with_audio_source::<sources::Microphone>(mic_feed);
        }

        if let Some(system_audio) = system_audio {
            output_builder =
                output_builder.with_audio_source::<screen_capture::SystemAudioSource>(system_audio);
        }

        output_builder
            .build::<WindowsMuxer>(WindowsMuxerConfig {
                pixel_format: screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi(),
                bitrate_multiplier: 0.055f32,
                frame_rate: 30u32,
                d3d_device,
                output_size: Some(windows::Graphics::SizeInt32 {
                    Width: output_resolution.0 as i32,
                    Height: output_resolution.1 as i32,
                }),
                encoder_preferences,
                fragmented: false,
                frag_duration_us: 2_000_000,
            })
            .await
    }
}

#[cfg(target_os = "macos")]
pub type ScreenCaptureMethod = screen_capture::CMSampleBufferCapture;

#[cfg(windows)]
pub type ScreenCaptureMethod = screen_capture::Direct3DCapture;

#[cfg(target_os = "linux")]
pub type ScreenCaptureMethod = screen_capture::FFmpegX11Capture;

#[cfg(target_os = "linux")]
impl MakeCapturePipeline for screen_capture::FFmpegX11Capture {
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
        fragmented: bool,
        shared_pause_state: Option<SharedPauseState>,
        output_size: Option<(u32, u32)>,
    ) -> anyhow::Result<OutputPipeline> {
        if fragmented {
            let fragments_dir = output_path
                .parent()
                .map(|p| p.join("display"))
                .unwrap_or_else(|| output_path.with_file_name("display"));

            OutputPipeline::builder(fragments_dir)
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<SegmentedVideoMuxer>(SegmentedVideoMuxerConfig {
                    output_size,
                    shared_pause_state,
                    ..Default::default()
                })
                .await
        } else {
            OutputPipeline::builder(output_path)
                .with_video::<screen_capture::VideoSource>(screen_capture)
                .with_timestamps(start_time)
                .build::<Mp4Muxer>(())
                .await
        }
    }

    async fn make_instant_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        system_audio: Option<screen_capture::SystemAudioSourceConfig>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
        _output_resolution: (u32, u32),
        start_time: Timestamps,
    ) -> anyhow::Result<OutputPipeline> {
        let mut output = OutputPipeline::builder(output_path)
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time);

        if let Some(system_audio) = system_audio {
            output = output.with_audio_source::<screen_capture::SystemAudioSource>(system_audio);
        }

        if let Some(mic_feed) = mic_feed {
            output = output.with_audio_source::<sources::Microphone>(mic_feed);
        }

        output
            .build::<Mp4Muxer>(())
            .await
    }
}

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

            #[cfg(target_os = "linux")]
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

            #[cfg(target_os = "linux")]
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
