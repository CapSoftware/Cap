use crate::output_pipeline::{
    self, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
    ChannelVideoSourceConfig, FFmpegVideoFrame,
};
use anyhow::Context;
use cap_media_info::AudioInfo;
use cap_timestamp::Timestamp;
use futures::channel::mpsc;
use std::time::Instant;
use tracing::warn;

use super::{ScreenCaptureConfig, ScreenCaptureFormat};

#[derive(Debug)]
pub struct FFmpegX11Capture;

impl ScreenCaptureFormat for FFmpegX11Capture {
    type VideoFormat = FFmpegVideoFrame;

    fn pixel_format() -> ffmpeg::format::Pixel {
        ffmpeg::format::Pixel::BGRA
    }

    fn audio_info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            48_000,
            2,
        )
        .expect("fallback audio config")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("Failed to open display: {0}")]
    DisplayOpen(String),
    #[error("FFmpeg error: {0}")]
    FFmpeg(String),
}

pub type VideoSourceConfig = ChannelVideoSourceConfig<FFmpegVideoFrame>;
pub type VideoSource = ChannelVideoSource<FFmpegVideoFrame>;
pub type SystemAudioSourceConfig = ChannelAudioSourceConfig;
pub type SystemAudioSource = ChannelAudioSource;

impl ScreenCaptureConfig<FFmpegX11Capture> {
    pub async fn to_sources(
        &self,
    ) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSourceConfig>)> {
        let config = self.config().clone();
        let video_info = self.info();
        let system_audio = self.system_audio;

        let (video_tx, video_rx) = flume::bounded(4);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<anyhow::Result<()>>();

        let width = video_info.width;
        let height = video_info.height;
        let fps = video_info.fps();

        std::thread::spawn(move || {
            let display_env = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string());
            let display_str = if display_env.contains('.') {
                display_env.clone()
            } else {
                format!("{display_env}.0")
            };

            let input_url = if let Some(crop) = config.crop_bounds {
                format!(
                    "{}+{},{}",
                    display_str,
                    crop.position().x() as i32,
                    crop.position().y() as i32,
                )
            } else {
                display_str
            };

            let mut input_opts = ffmpeg::Dictionary::new();
            input_opts.set("framerate", &fps.to_string());
            input_opts.set("video_size", &format!("{width}x{height}"));
            if config.show_cursor {
                input_opts.set("draw_mouse", "1");
            } else {
                input_opts.set("draw_mouse", "0");
            }

            let mut ictx = match open_x11grab_input(&input_url, input_opts) {
                Ok(ctx) => ctx,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };

            let video_stream = match ictx.streams().best(ffmpeg::media::Type::Video) {
                Some(s) => s,
                None => {
                    let _ = ready_tx.send(Err(anyhow::anyhow!("No video stream")));
                    return;
                }
            };
            let video_stream_index = video_stream.index();

            let codec_params = video_stream.parameters();
            let mut decoder = match ffmpeg::codec::Context::from_parameters(codec_params)
                .and_then(|ctx| ctx.decoder().video())
            {
                Ok(d) => d,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow::anyhow!("Decoder init: {e}")));
                    return;
                }
            };

            let _ = ready_tx.send(Ok(()));

            let start_time = Instant::now();
            let mut frame = ffmpeg::frame::Video::empty();
            let mut scaler: Option<ffmpeg::software::scaling::Context> = None;

            for (stream, packet) in ictx.packets() {
                if stream.index() != video_stream_index {
                    continue;
                }

                decoder.send_packet(&packet).ok();

                while decoder.receive_frame(&mut frame).is_ok() {
                    let output_frame = if frame.format() != ffmpeg::format::Pixel::BGRA
                        || frame.width() != width
                        || frame.height() != height
                    {
                        let sws = scaler.get_or_insert_with(|| {
                            ffmpeg::software::scaling::Context::get(
                                frame.format(),
                                frame.width(),
                                frame.height(),
                                ffmpeg::format::Pixel::BGRA,
                                width,
                                height,
                                ffmpeg::software::scaling::Flags::BILINEAR,
                            )
                            .expect("scaler init")
                        });

                        let mut dst = ffmpeg::frame::Video::empty();
                        sws.run(&frame, &mut dst).ok();
                        dst
                    } else {
                        frame.clone()
                    };

                    let _elapsed = start_time.elapsed();
                    let timestamp = Timestamp::Instant(std::time::Instant::now());

                    let video_frame = FFmpegVideoFrame {
                        inner: output_frame,
                        timestamp,
                    };

                    if video_tx.send(video_frame).is_err() {
                        break;
                    }
                }
            }
        });

        match ready_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(anyhow::anyhow!("x11grab capture thread died")),
        }

        let video_source = ChannelVideoSourceConfig::new(video_info, video_rx);

        let system_audio_source = if system_audio {
            match create_system_audio_source() {
                Ok(source) => Some(source),
                Err(e) => {
                    warn!("System audio capture not available: {e}");
                    None
                }
            }
        } else {
            None
        };

        Ok((video_source, system_audio_source))
    }
}

fn open_x11grab_input(
    url: &str,
    options: ffmpeg::Dictionary,
) -> anyhow::Result<ffmpeg::format::context::Input> {
    unsafe {
        ffmpeg::ffi::avdevice_register_all();

        let format_cstr = std::ffi::CString::new("x11grab")
            .map_err(|_| anyhow::anyhow!("Invalid format name"))?;
        let input_format = ffmpeg::ffi::av_find_input_format(format_cstr.as_ptr());
        if input_format.is_null() {
            return Err(anyhow::anyhow!(
                "x11grab input format not available - FFmpeg may not be compiled with x11grab support"
            ));
        }

        let url_cstr = std::ffi::CString::new(url).map_err(|_| anyhow::anyhow!("Invalid URL"))?;

        let mut ps = std::ptr::null_mut();
        let mut opts = options.disown();

        let ret =
            ffmpeg::ffi::avformat_open_input(&mut ps, url_cstr.as_ptr(), input_format, &mut opts);

        if !opts.is_null() {
            ffmpeg::ffi::av_dict_free(&mut opts);
        }

        if ret < 0 {
            return Err(anyhow::anyhow!(
                "Failed to open x11grab input (error code: {ret})"
            ));
        }

        let ret = ffmpeg::ffi::avformat_find_stream_info(ps, std::ptr::null_mut());
        if ret < 0 {
            ffmpeg::ffi::avformat_close_input(&mut ps);
            return Err(anyhow::anyhow!(
                "Failed to find stream info (error code: {ret})"
            ));
        }

        Ok(ffmpeg::format::context::Input::wrap(ps))
    }
}

fn create_system_audio_source() -> anyhow::Result<SystemAudioSourceConfig> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let output_device = host
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("No default audio output device"))?;

    let supported_config = output_device
        .default_output_config()
        .context("No default output config")?;

    let config: cpal::StreamConfig = supported_config.clone().into();
    let audio_info = AudioInfo::from_stream_config(&supported_config);

    let (mut tx, rx) = mpsc::channel(64);

    let stream = output_device
        .build_input_stream_raw(
            &config,
            supported_config.sample_format(),
            {
                let config = config.clone();
                move |data: &cpal::Data, _info: &cpal::InputCallbackInfo| {
                    use scap_ffmpeg::DataExt;
                    let frame = data.as_ffmpeg(&config);
                    let timestamp = Timestamp::from_duration(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default(),
                    );
                    let _ = tx.try_send(output_pipeline::AudioFrame {
                        inner: frame,
                        timestamp,
                    });
                }
            },
            |err| {
                warn!("System audio capture error: {err}");
            },
            None,
        )
        .context("Failed to build system audio capture stream")?;

    use cpal::traits::StreamTrait;
    stream
        .play()
        .context("Failed to start system audio capture")?;

    Ok(ChannelAudioSourceConfig::new(audio_info, rx))
}
