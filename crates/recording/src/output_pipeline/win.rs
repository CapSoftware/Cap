use crate::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoMuxer, screen_capture};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::aac::AACEncoder;
use cap_media_info::{AudioInfo, VideoInfo};
use futures::channel::oneshot;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
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

struct PauseTracker {
    flag: Arc<AtomicBool>,
    paused_at: Option<Duration>,
    offset: Duration,
}

impl PauseTracker {
    fn new(flag: Arc<AtomicBool>) -> Self {
        Self {
            flag,
            paused_at: None,
            offset: Duration::ZERO,
        }
    }

    fn adjust(&mut self, timestamp: Duration) -> anyhow::Result<Option<Duration>> {
        if self.flag.load(Ordering::Relaxed) {
            if self.paused_at.is_none() {
                self.paused_at = Some(timestamp);
            }
            return Ok(None);
        }

        if let Some(start) = self.paused_at.take() {
            let delta = timestamp.checked_sub(start).ok_or_else(|| {
                anyhow!(
                    "Frame timestamp went backward during unpause (resume={start:?}, current={timestamp:?})"
                )
            })?;

            self.offset = self.offset.checked_add(delta).ok_or_else(|| {
                anyhow!(
                    "Pause offset overflow (offset={:?}, delta={delta:?})",
                    self.offset
                )
            })?;
        }

        let adjusted = timestamp.checked_sub(self.offset).ok_or_else(|| {
            anyhow!(
                "Adjusted timestamp underflow (timestamp={timestamp:?}, offset={:?})",
                self.offset
            )
        })?;

        Ok(Some(adjusted))
    }
}

/// Muxes to MP4 using a combination of FFmpeg and Media Foundation
pub struct WindowsMuxer {
    video_tx: SyncSender<Option<(scap_direct3d::Frame, Duration)>>,
    output: Arc<Mutex<ffmpeg::format::context::Output>>,
    audio_encoder: Option<AACEncoder>,
    pause: PauseTracker,
}

pub struct WindowsMuxerConfig {
    pub pixel_format: DXGI_FORMAT,
    pub d3d_device: ID3D11Device,
    pub frame_rate: u32,
    pub bitrate_multiplier: f32,
    pub output_size: Option<SizeInt32>,
    pub encoder_preferences: crate::capture_pipeline::EncoderPreferences,
}

impl Muxer for WindowsMuxer {
    type Config = WindowsMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
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
                        let mut first_timestamp: Option<Duration> = None;
                        encoder
                            .run(
                                Arc::new(AtomicBool::default()),
                                || {
                                    let Ok(Some((frame, timestamp))) = video_rx.recv() else {
                                        trace!("No more frames available");
                                        return Ok(None);
                                    };

                                    let relative = if let Some(first) = first_timestamp {
                                        timestamp.checked_sub(first).unwrap_or(Duration::ZERO)
                                    } else {
                                        first_timestamp = Some(timestamp);
                                        Duration::ZERO
                                    };
                                    let frame_time = duration_to_timespan(relative);

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
            pause: PauseTracker::new(pause_flag),
        })
    }

    fn stop(&mut self) {
        let _ = self.video_tx.send(None);
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
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

        Ok(audio_result.map_err(Into::into))
    }
}

impl VideoMuxer for WindowsMuxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        if let Some(timestamp) = self.pause.adjust(timestamp)? {
            self.video_tx.send(Some((frame.frame, timestamp)))?;
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(timestamp) = self.pause.adjust(timestamp)? {
            if let Some(encoder) = self.audio_encoder.as_mut()
                && let Ok(mut output) = self.output.lock()
            {
                encoder.send_frame(frame.inner, timestamp, &mut output)?;
            }
        }

        Ok(())
    }
}

fn duration_to_timespan(duration: Duration) -> TimeSpan {
    const TICKS_PER_SEC: u64 = 10_000_000;
    const NANOS_PER_TICK: u32 = 100;

    let secs_ticks = duration.as_secs().saturating_mul(TICKS_PER_SEC);
    let nanos_ticks = (duration.subsec_nanos() / NANOS_PER_TICK) as u64;
    let total_ticks = secs_ticks.saturating_add(nanos_ticks);
    let clamped = total_ticks.min(i64::MAX as u64);

    TimeSpan {
        Duration: clamped as i64,
    }
}
