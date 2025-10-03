use crate::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoMuxer, screen_capture};
use anyhow::anyhow;
use cap_enc_ffmpeg::AACEncoder;
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
}

impl Muxer for WindowsMuxer {
    type Config = WindowsMuxerConfig;

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
        let (video_tx, video_rx) = sync_channel::<Option<(scap_direct3d::Frame, Duration)>>(8);

        let mut output = ffmpeg::format::output(&output_path)?;
        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()?;

        let output = Arc::new(Mutex::new(output));
        let (ready_tx, ready_rx) = oneshot::channel();

        {
            let output = output.clone();

            tasks.spawn_thread("windows-encoder", move || {
                cap_mediafoundation_utils::thread_init();

                let encoder = (|| {
                    let mut output = output.lock().unwrap();

                    let native_encoder =
                        cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
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

                            cap_enc_ffmpeg::H264Encoder::builder(video_config)
                                .build(&mut output)
                                .map(either::Right)
                                .map_err(|e| anyhow!("ScreenSoftwareEncoder/{e}"))
                        }
                    }
                })();

                let encoder = match encoder {
                    Ok(encoder) => {
                        if ready_tx.send(Ok(())).is_err() {
                            info!("Failed to send ready signal");
                            return;
                        }
                        encoder
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
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
                            .unwrap();
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

        let _ = ready_rx.await;

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

    fn finish(&mut self) -> anyhow::Result<()> {
        let mut output = self.output.lock().unwrap();
        if let Some(audio_encoder) = self.audio_encoder.as_mut() {
            let _ = audio_encoder.finish(&mut output);
        }
        Ok(output.write_trailer()?)
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
