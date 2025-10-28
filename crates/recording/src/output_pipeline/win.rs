use crate::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoMuxer, screen_capture};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::aac::AACEncoder;
use cap_media_info::{AudioInfo, VideoInfo};
use futures::channel::oneshot;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::AtomicBool,
        mpsc::{SyncSender, sync_channel},
    },
    time::Duration,
};
use tracing::*;
use windows::{
    Foundation::TimeSpan,
    Graphics::SizeInt32,
    Win32::Graphics::{Direct3D11::ID3D11Device, Dxgi::Common::DXGI_FORMAT},
};

/// Muxes to MP4 using a combination of FFmpeg and Media Foundation
pub struct WindowsMuxer {
    video_tx: SyncSender<Option<(scap_direct3d::Frame, Duration)>>,
    output: Arc<Mutex<ffmpeg::format::context::Output>>,
    audio_encoder: Option<AACEncoder>,
}

pub struct WindowsMuxerConfig {
    pub pixel_format: DXGI_FORMAT,
    pub d3d_device: ID3D11Device,
    pub frame_rate: u32,
    pub bitrate_multiplier: f32,
    pub output_size: Option<SizeInt32>,
    pub encoder_preferences: crate::capture_pipeline::EncoderPreferences,
}

pub struct Finish {
    audio_result: Result<(), ffmpeg::Error>,
}

impl Muxer for WindowsMuxer {
    type Config = WindowsMuxerConfig;
    type Finish = Finish;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        tasks: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let video_config =
            video_config.ok_or_else(|| anyhow!("invariant: video config expected"))?;
        let input_size = SizeInt32 {
            Width: video_config.width as i32,
            Height: video_config.height as i32,
        };
        let output_size = config.output_size.unwrap_or(input_size);
        let (video_tx, video_rx) = sync_channel::<Option<(scap_direct3d::Frame, Duration)>>(8);

        let mut output = ffmpeg::format::output(&output_path)?;
        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()?;

        let output = Arc::new(Mutex::new(output));
        let (ready_tx, ready_rx) = oneshot::channel::<anyhow::Result<()>>();

        {
            let output = output.clone();

            tasks.spawn_thread("windows-encoder", move || {
                cap_mediafoundation_utils::thread_init();

                let encoder_preferences = &config.encoder_preferences;

                let encoder = (|| {
                    let fallback = |reason: Option<String>| {
                        use tracing::{error, info};

                        encoder_preferences.force_software_only();
                        if let Some(reason) = reason.as_ref() {
                            error!("Falling back to software H264 encoder: {reason}");
                        } else {
                            info!("Falling back to software H264 encoder");
                        }

                        let fallback_width = if output_size.Width > 0 {
                            output_size.Width as u32
                        } else {
                            video_config.width
                        };
                        let fallback_height = if output_size.Height > 0 {
                            output_size.Height as u32
                        } else {
                            video_config.height
                        };

                        let mut output_guard = match output.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => {
                                return Err(anyhow!(
                                    "ScreenSoftwareEncoder: failed to lock output mutex: {}",
                                    poisoned
                                ));
                            }
                        };

                        cap_enc_ffmpeg::h264::H264Encoder::builder(video_config)
                            .with_output_size(fallback_width, fallback_height)
                            .and_then(|builder| builder.build(&mut *output_guard))
                            .map(either::Right)
                            .map_err(|e| anyhow!("ScreenSoftwareEncoder/{e}"))
                    };

                    if encoder_preferences.should_force_software() {
                        return fallback(None);
                    }

                    match cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
                        &config.d3d_device,
                        config.pixel_format,
                        input_size,
                        output_size,
                        config.frame_rate,
                        config.bitrate_multiplier,
                    ) {
                        Ok(encoder) => {
                            let width = match u32::try_from(output_size.Width) {
                                Ok(width) if width > 0 => width,
                                _ => {
                                    return fallback(Some(format!(
                                        "Invalid output width: {}",
                                        output_size.Width
                                    )));
                                }
                            };

                            let height = match u32::try_from(output_size.Height) {
                                Ok(height) if height > 0 => height,
                                _ => {
                                    return fallback(Some(format!(
                                        "Invalid output height: {}",
                                        output_size.Height
                                    )));
                                }
                            };

                            let muxer = {
                                let mut output_guard = match output.lock() {
                                    Ok(guard) => guard,
                                    Err(poisoned) => {
                                        return fallback(Some(format!(
                                            "Failed to lock output mutex: {}",
                                            poisoned
                                        )));
                                    }
                                };

                                cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                                    &mut *output_guard,
                                    cap_mediafoundation_ffmpeg::MuxerConfig {
                                        width,
                                        height,
                                        fps: config.frame_rate,
                                        bitrate: encoder.bitrate(),
                                    },
                                )
                            };

                            match muxer {
                                Ok(muxer) => Ok(either::Left((encoder, muxer))),
                                Err(err) => fallback(Some(err.to_string())),
                            }
                        }
                        Err(err) => fallback(Some(err.to_string())),
                    }
                })();

                let encoder = match encoder {
                    Ok(encoder) => {
                        if ready_tx.send(Ok(())).is_err() {
                            error!("Failed to send ready signal - receiver dropped");
                            return Ok(());
                        }
                        encoder
                    }
                    Err(e) => {
                        error!("Encoder setup failed: {:#}", e);
                        let _ = ready_tx.send(Err(anyhow!("{e}")));
                        return Err(anyhow!("{e}"));
                    }
                };

                match encoder {
                    either::Left((mut encoder, mut muxer)) => {
                        trace!("Running native encoder");
                        let mut first_timestamp = None;
                        encoder
                            .run(
                                Arc::new(AtomicBool::default()),
                                || {
                                    let Ok(Some((frame, _))) = video_rx.recv() else {
                                        trace!("No more frames available");
                                        return Ok(None);
                                    };

                                    let frame_time = frame.inner().SystemRelativeTime()?;
                                    let first_timestamp = first_timestamp.get_or_insert(frame_time);
                                    let frame_time = TimeSpan {
                                        Duration: frame_time.Duration - first_timestamp.Duration,
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
                            .context("run native encoder")
                    }
                    either::Right(mut encoder) => {
                        while let Ok(Some((frame, time))) = video_rx.recv() {
                            let Ok(mut output) = output.lock() else {
                                continue;
                            };

                            // if pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
                            //     mp4.pause();
                            // } else {
                            //     mp4.resume();
                            // }

                            use scap_ffmpeg::AsFFmpeg;

                            frame
                                .as_ffmpeg()
                                .context("frame as_ffmpeg")
                                .and_then(|frame| {
                                    encoder
                                        .queue_frame(frame, time, &mut output)
                                        .context("queue_frame")
                                })?;
                        }

                        Ok(())
                    }
                }
            });
        }

        ready_rx
            .await
            .map_err(|_| anyhow!("Encoder thread ended unexpectedly"))??;

        output.lock().unwrap().write_header()?;

        Ok(Self {
            video_tx,
            output,
            audio_encoder,
        })
    }

    fn stop(&mut self) {
        let _ = self.video_tx.send(None);
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<Self::Finish> {
        let mut output = self
            .output
            .lock()
            .map_err(|_| anyhow!("Failed to lock output"))?;
        let audio_result = self
            .audio_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut output))
            .unwrap_or(Ok(()));

        output.write_trailer()?;

        Ok(Finish { audio_result })
    }
}

impl VideoMuxer for WindowsMuxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        Ok(self.video_tx.send(Some((frame.frame, timestamp)))?)
    }
}

impl AudioMuxer for WindowsMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(encoder) = self.audio_encoder.as_mut()
            && let Ok(mut output) = self.output.lock()
        {
            encoder.send_frame(frame.inner, timestamp, &mut output)?;
        }

        Ok(())
    }
}
