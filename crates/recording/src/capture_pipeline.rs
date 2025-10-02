use crate::{
    feeds::microphone::MicrophoneFeedLock,
    output_pipeline::*,
    sources,
    sources::screen_capture::{
        self, ScreenCaptureConfig, ScreenCaptureFormat, ScreenCaptureTarget,
    },
};
use cap_timestamp::Timestamps;
use std::{path::PathBuf, sync::Arc, time::SystemTime};

pub trait MakeCapturePipeline: ScreenCaptureFormat + std::fmt::Debug + 'static {
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> anyhow::Result<OutputPipeline>
    where
        Self: Sized;

    async fn make_instant_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        system_audio: Option<screen_capture::SystemAudioSourceConfig>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
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
    ) -> anyhow::Result<OutputPipeline> {
        OutputPipeline::builder(output_path.clone())
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time)
            .build::<AVFoundationMp4Muxer>(Default::default())
            .await
    }

    async fn make_instant_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        system_audio: Option<screen_capture::SystemAudioSourceConfig>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
    ) -> anyhow::Result<OutputPipeline> {
        let mut output = OutputPipeline::builder(output_path.clone())
            .with_video::<screen_capture::VideoSource>(screen_capture);

        if let Some(system_audio) = system_audio {
            output = output.with_audio_source::<screen_capture::SystemAudioSource>(system_audio);
        }

        if let Some(mic_feed) = mic_feed {
            output = output.with_audio_source::<sources::Microphone>(mic_feed);
        }

        output
            .build::<AVFoundationMp4Muxer>(AVFoundationMp4MuxerConfig {
                output_height: Some(1080),
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
    ) -> anyhow::Result<OutputPipeline> {
        let d3d_device = screen_capture.1.d3d_device().clone();

        OutputPipeline::builder(output_path.clone())
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time)
            .build::<WindowsMuxer>(WindowsMuxerConfig {
                pixel_format: screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi(),
                d3d_device,
                bitrate_multiplier: 0.1f32,
                frame_rate: 30u32,
            })
            .await
    }

    async fn make_instant_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        system_audio: Option<screen_capture::SystemAudioSourceConfig>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
    ) -> anyhow::Result<OutputPipeline> {
        let d3d_device = screen_capture.1.d3d_device().clone();
        let mut output_builder = OutputPipeline::builder(output_path.clone())
            .with_video::<screen_capture::VideoSource>(screen_capture);

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
                bitrate_multiplier: 0.15f32,
                frame_rate: 30u32,
                d3d_device,
            })
            .await
    }
}

#[cfg(target_os = "macos")]
pub type ScreenCaptureMethod = screen_capture::CMSampleBufferCapture;

#[cfg(windows)]
pub type ScreenCaptureMethod = screen_capture::Direct3DCapture;

pub async fn create_screen_capture(
    capture_target: &ScreenCaptureTarget,
    force_show_cursor: bool,
    max_fps: u32,
    start_time: SystemTime,
    system_audio: bool,
    #[cfg(windows)] d3d_device: ::windows::Win32::Graphics::Direct3D11::ID3D11Device,
) -> anyhow::Result<ScreenCaptureConfig<ScreenCaptureMethod>> {
    Ok(ScreenCaptureConfig::<ScreenCaptureMethod>::init(
        capture_target,
        force_show_cursor,
        max_fps,
        start_time,
        system_audio,
        #[cfg(windows)]
        d3d_device,
    )
    .await?)
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
