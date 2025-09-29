use crate::output_pipeline::{AudioFrame, NewOutputPipeline};
use crate::{
    feeds::microphone::MicrophoneFeedLock,
    output_pipeline::{Muxer, OutputPipeline},
    sources::{ScreenCaptureFormat, ScreenCaptureSource, ScreenCaptureTarget, screen_capture},
};
use anyhow::anyhow;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::Timestamps;
use futures::{SinkExt, StreamExt, channel::mpsc};
use kameo::{
    actor::{ActorID, ActorRef, Recipient},
    prelude::*,
};
use std::{
    ops::ControlFlow,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::{Duration, SystemTime},
};
use tracing::*;

pub trait MakeCapturePipeline: ScreenCaptureFormat + std::fmt::Debug + 'static {
    async fn make_studio_mode_pipeline(
        source: ScreenCaptureSource<Self>,
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> anyhow::Result<NewOutputPipeline>
    where
        Self: Sized;

    async fn make_instant_mode_pipeline(
        source: ScreenCaptureSource<Self>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
        pause_flag: Arc<AtomicBool>,
    ) -> anyhow::Result<NewOutputPipeline>
    where
        Self: Sized;
}

struct RecordingSource {
    name: String,
    id: ActorID,
    stop: Recipient<Stop>,
}

pub struct Start;
pub struct Stop;

#[cfg(target_os = "macos")]
impl MakeCapturePipeline for screen_capture::CMSampleBufferCapture {
    async fn make_studio_mode_pipeline(
        source: ScreenCaptureSource<Self>,
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> anyhow::Result<NewOutputPipeline> {
        let mut output_builder =
            OutputPipeline::builder::<screen_capture::Source>(output_path.clone(), source.clone());

        output_builder.set_timestamps(start_time);

        output_builder
            .build::<AVFoundationMuxer>(AVFoundationMuxerConfig {
                output_height: None,
            })
            .await
    }

    async fn make_instant_mode_pipeline(
        source: ScreenCaptureSource<Self>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
        pause_flag: Arc<AtomicBool>,
    ) -> anyhow::Result<NewOutputPipeline> {
        let mut output_builder =
            OutputPipeline::builder::<screen_capture::Source>(output_path.clone(), source.clone());

        if let Some(mic_feed) = mic_feed {
            output_builder.add_audio_source(mic_feed);
        }

        output_builder
            .build::<AVFoundationMuxer>(AVFoundationMuxerConfig {
                output_height: Some(1080),
            })
            .await
    }
}

#[cfg(windows)]
impl MakeCapturePipeline for screen_capture::Direct3DCapture {
    async fn make_studio_mode_pipeline(
        source: ScreenCaptureSource<Self>,
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> anyhow::Result<NewOutputPipeline> {
        let mut output_builder =
            OutputPipeline::builder::<screen_capture::Source>(output_path.clone(), source.clone());

        output_builder.set_timestamps(start_time);

        output_builder
            .build::<WindowsMuxer>(WindowsMuxerConfig {
                pixel_format: screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi(),
                d3d_device: source.d3d_device().clone(),
                bitrate_multiplier: 0.1f32,
                frame_rate: 30u32,
            })
            .await
    }

    async fn make_instant_mode_pipeline(
        source: ScreenCaptureSource<Self>,
        mic_feed: Option<Arc<MicrophoneFeedLock>>,
        output_path: PathBuf,
        pause_flag: Arc<AtomicBool>,
    ) -> anyhow::Result<NewOutputPipeline> {
        let mut output_builder =
            OutputPipeline::builder::<screen_capture::Source>(output_path.clone(), source.clone());

        if let Some(mic_feed) = mic_feed {
            output_builder.add_audio_source(mic_feed);
        }

        output_builder
            .build::<WindowsMuxer>(WindowsMuxerConfig {
                pixel_format: screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi(),
                d3d_device: source.d3d_device().clone(),
                bitrate_multiplier: 0.15f32,
                frame_rate: 30u32,
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
) -> anyhow::Result<ScreenCaptureSource<ScreenCaptureMethod>> {
    Ok(ScreenCaptureSource::<ScreenCaptureMethod>::init(
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

#[cfg(target_os = "macos")]
use macos::*;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    #[derive(Clone)]
    pub struct AVFoundationMuxer(Arc<Mutex<cap_enc_avfoundation::MP4Encoder>>);

    pub struct AVFoundationMuxerConfig {
        pub output_height: Option<u32>,
    }

    impl Muxer for AVFoundationMuxer {
        type VideoFrame = screen_capture::VideoFrame;
        type Config = AVFoundationMuxerConfig;

        async fn setup(
            config: Self::Config,
            output_path: PathBuf,
            video_config: VideoInfo,
            audio_config: Option<AudioInfo>,
        ) -> anyhow::Result<Self> {
            Ok(Self(Arc::new(Mutex::new(
                cap_enc_avfoundation::MP4Encoder::init(
                    output_path,
                    video_config,
                    audio_config,
                    config.output_height,
                )
                .map_err(|e| anyhow!("{e}"))?,
            ))))
        }

        fn send_audio_frame(
            &mut self,
            frame: ffmpeg::frame::Audio,
            timestamp: Duration,
        ) -> anyhow::Result<()> {
            self.0
                .lock()
                .map_err(|e| anyhow!("{e}"))?
                .queue_audio_frame(frame, timestamp)
                .map_err(|e| anyhow!("{e}"))
        }

        fn send_video_frame(
            &mut self,
            frame: Self::VideoFrame,
            timestamp: Duration,
        ) -> anyhow::Result<()> {
            self.0
                .lock()
                .map_err(|e| anyhow!("{e}"))?
                .queue_video_frame(&frame.sample_buf, timestamp)
                .map_err(|e| anyhow!("{e}"))
        }

        fn finish(&mut self) -> anyhow::Result<()> {
            self.0.lock().map_err(|e| anyhow!("{e}"))?.finish();
            Ok(())
        }
    }
}

#[cfg(windows)]
use win::*;

#[cfg(windows)]
mod win {
    use std::sync::mpsc::{SyncSender, sync_channel};

    use cap_enc_ffmpeg::AACEncoder;
    use futures::channel::oneshot;
    use windows::{
        Foundation::TimeSpan,
        Graphics::SizeInt32,
        Win32::Graphics::{Direct3D11::ID3D11Device, Dxgi::Common::DXGI_FORMAT},
    };

    use super::*;

    /// Muxes to MP4 using a combination of FFmpeg and Media Foundation
    #[derive(Clone)]
    pub struct WindowsMuxer {
        video_tx: SyncSender<(scap_direct3d::Frame, Duration)>,
        audio_tx: Option<SyncSender<(ffmpeg::frame::Audio, Duration)>>,
        first_frame_tx: Option<SyncSender<Duration>>,
        output: Arc<Mutex<ffmpeg::format::context::Output>>,
    }

    pub struct WindowsMuxerConfig {
        pub pixel_format: DXGI_FORMAT,
        pub d3d_device: ID3D11Device,
        pub frame_rate: u32,
        pub bitrate_multiplier: f32,
    }

    impl Muxer for WindowsMuxer {
        type VideoFrame = screen_capture::VideoFrame;
        type Config = WindowsMuxerConfig;

        async fn setup(
            config: Self::Config,
            output_path: PathBuf,
            video_config: VideoInfo,
            audio_config: Option<AudioInfo>,
        ) -> anyhow::Result<Self>
        where
            Self: Sized,
        {
            let (video_tx, video_rx) = sync_channel::<(scap_direct3d::Frame, Duration)>(8);

            let mut output = ffmpeg::format::output(&output_path)?;
            let audio_encoder = audio_config
                .map(|config| AACEncoder::init("mic_audio", config, &mut output))
                .transpose()?;

            let (first_frame_tx, first_frame_rx) = sync_channel::<Duration>(1);

            let video_encoder = {
                cap_mediafoundation_utils::thread_init();

                let native_encoder = cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
                    &config.d3d_device,
                    config.pixel_format,
                    SizeInt32 {
                        Width: video_config.width as i32,
                        Height: video_config.height as i32,
                    },
                    SizeInt32 {
                        Width: video_config.width as i32,
                        Height: video_config.height as i32,
                    },
                    config.frame_rate,
                    config.bitrate_multiplier,
                );

                match native_encoder {
                    Ok(encoder) => cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                        &mut output,
                        cap_mediafoundation_ffmpeg::MuxerConfig {
                            width: video_config.width,
                            height: video_config.height,
                            fps: config.frame_rate,
                            bitrate: encoder.bitrate(),
                        },
                    )
                    .map(|muxer| either::Left((encoder, muxer)))
                    .map_err(|e| anyhow!("{e}")),
                    Err(e) => {
                        use tracing::{error, info};

                        error!("Failed to create native encoder: {e}");
                        info!("Falling back to software H264 encoder");

                        cap_enc_ffmpeg::H264Encoder::builder("screen", video_config)
                            .build(&mut output)
                            .map(either::Right)
                            .map_err(|e| anyhow!("{e}"))
                    }
                }?
            };

            output.write_header()?;

            let output = Arc::new(Mutex::new(output));

            {
                let output = output.clone();

                std::thread::spawn(move || {
                    cap_mediafoundation_utils::thread_init();

                    match video_encoder {
                        either::Left((mut encoder, mut muxer)) => {
                            trace!("Running native encoder");
                            let mut first_timestamp = None;
                            encoder
                                .run(
                                    Arc::new(AtomicBool::default()),
                                    || {
                                        let Ok((frame, _)) = video_rx.recv() else {
                                            return Ok(None);
                                        };

                                        let frame_time = frame.inner().SystemRelativeTime()?;
                                        let first_timestamp =
                                            first_timestamp.get_or_insert(frame_time);
                                        let frame_time = TimeSpan {
                                            Duration: frame_time.Duration
                                                - first_timestamp.Duration,
                                        };

                                        Ok(Some((frame.texture().clone(), frame_time)))
                                    },
                                    |output_sample| {
                                        let mut output = output.lock().unwrap();

                                        let _ = muxer
                                            .write_sample(&output_sample, &mut *output)
                                            .map_err(|e| format!("WriteSample: {e}"));

                                        Ok(())
                                    },
                                )
                                .unwrap();
                        }
                        either::Right(mut encoder) => {
                            while let Ok((frame, time)) = video_rx.recv() {
                                let Ok(mut output) = output.lock() else {
                                    continue;
                                };

                                // if pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
                                //     mp4.pause();
                                // } else {
                                //     mp4.resume();
                                // }

                                use scap_ffmpeg::AsFFmpeg;

                                encoder.queue_frame(
                                    frame
                                        .as_ffmpeg()
                                        .map_err(|e| format!("FrameAsFFmpeg: {e}"))
                                        .unwrap(),
                                    time,
                                    &mut output,
                                );
                            }
                        }
                    }
                });
            }

            let audio_tx = audio_encoder.map(|mut audio_encoder| {
                let (tx, rx) = std::sync::mpsc::sync_channel::<(ffmpeg::frame::Audio, Duration)>(8);
                let output = output.clone();

                std::thread::spawn(move || {
                    let time = first_frame_rx.recv().unwrap();

                    while let Ok((mut frame, timestamp)) = rx.recv() {
                        let Some(ts_offset) = timestamp.checked_sub(time) else {
                            continue;
                        };

                        let pts = (ts_offset.as_secs_f64() * frame.rate() as f64) as i64;
                        frame.set_pts(Some(pts));

                        if let Ok(mut output) = output.lock() {
                            audio_encoder.queue_frame(frame, &mut output)
                        }
                    }
                });

                tx
            });

            Ok(Self {
                video_tx,
                audio_tx,
                first_frame_tx: Some(first_frame_tx),
                output,
            })
        }

        fn send_audio_frame(
            &mut self,
            frame: ffmpeg::frame::Audio,
            timestamp: Duration,
        ) -> anyhow::Result<()> {
            if let Some(audio_tx) = &self.audio_tx {
                audio_tx.send((frame, timestamp))?;
            }

            Ok(())
        }

        fn send_video_frame(
            &mut self,
            frame: Self::VideoFrame,
            timestamp: Duration,
        ) -> anyhow::Result<()> {
            if let Some(first_frame_tx) = self.first_frame_tx.take() {
                let _ = first_frame_tx.send(timestamp);
            }

            Ok(self.video_tx.send((frame.frame, timestamp))?)
        }

        fn finish(&mut self) -> anyhow::Result<()> {
            Ok(self
                .output
                .lock()
                .map_err(|e| anyhow!("{e}"))?
                .write_trailer()?)
        }
    }
}
