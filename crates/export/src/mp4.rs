use crate::ExporterBase;
use cap_editor::{AudioRenderer, get_audio_segments};
use cap_enc_ffmpeg::{AudioEncoder, aac::AACEncoder, h264::H264Encoder, mp4::*};
use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_project::XY;
use cap_rendering::{ProjectUniforms, RenderSegment, RenderedFrame};
use futures::FutureExt;
use image::ImageBuffer;
use serde::Deserialize;
use specta::Type;
use std::{path::PathBuf, time::Duration};
use tracing::{info, trace, warn};

#[derive(Deserialize, Type, Clone, Copy, Debug)]
pub enum ExportCompression {
    Maximum,
    Social,
    Web,
    Potato,
}

impl ExportCompression {
    pub fn bits_per_pixel(&self) -> f32 {
        match self {
            Self::Maximum => 0.3,
            Self::Social => 0.15,
            Self::Web => 0.08,
            Self::Potato => 0.04,
        }
    }
}

#[derive(Deserialize, Type, Clone, Copy, Debug)]
pub struct Mp4ExportSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
    pub compression: ExportCompression,
    pub custom_bpp: Option<f32>,
    #[serde(default)]
    pub force_ffmpeg_decoder: bool,
}

impl Mp4ExportSettings {
    pub fn effective_bpp(&self) -> f32 {
        self.custom_bpp
            .unwrap_or_else(|| self.compression.bits_per_pixel())
    }
}

impl Mp4ExportSettings {
    pub async fn export(
        self,
        base: ExporterBase,
        mut on_progress: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<PathBuf, String> {
        let output_path = base.output_path.clone();
        let meta = &base.studio_meta;

        info!("Exporting mp4 with settings: {:?}", &self);
        info!("Expected to render {} frames", base.total_frames(self.fps));

        let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(8);
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(8);

        let fps = self.fps;

        let output_size = ProjectUniforms::get_output_size(
            &base.render_constants.options,
            &base.project_config,
            self.resolution_base,
        );

        let mut video_info =
            VideoInfo::from_raw(RawVideoFormat::Rgba, output_size.0, output_size.1, fps);
        video_info.time_base = ffmpeg::Rational::new(1, fps as i32);

        let audio_segments = get_audio_segments(&base.segments);

        let mut audio_renderer = audio_segments
            .first()
            .filter(|_| !base.project_config.audio.mute)
            .map(|_| AudioRenderer::new(audio_segments.clone()));
        let has_audio = audio_renderer.is_some();

        let encoder_thread = tokio::task::spawn_blocking(move || {
            trace!("Creating MP4File encoder");

            let mut encoder = MP4File::init(
                "output",
                base.output_path.clone(),
                |o| {
                    H264Encoder::builder(video_info)
                        .with_bpp(self.effective_bpp())
                        .with_export_priority()
                        .build(o)
                },
                |o| {
                    has_audio.then(|| {
                        AACEncoder::init(AudioRenderer::info(), o)
                            .map(|v| v.boxed())
                            .map_err(Into::into)
                    })
                },
            )
            .map_err(|v| v.to_string())?;

            info!("Created MP4File encoder");

            while let Ok(frame) = frame_rx.recv() {
                encoder
                    .queue_video_frame(frame.video, Duration::MAX)
                    .map_err(|err| err.to_string())?;
                if let Some(audio) = frame.audio {
                    encoder.queue_audio_frame(audio);
                }
            }

            let res = encoder
                .finish()
                .map_err(|e| format!("Failed to finish encoding: {e}"))?;

            if let Err(e) = res.video_finish {
                return Err(format!("Video encoding failed: {e}"));
            }
            if let Err(e) = res.audio_finish {
                return Err(format!("Audio encoding failed: {e}"));
            }

            Ok::<_, String>(base.output_path)
        })
        .then(|r| async { r.map_err(|e| e.to_string()).and_then(|v| v) });

        let render_task = tokio::spawn({
            let project = base.project_config.clone();
            let project_path = base.project_path.clone();
            async move {
                let mut frame_count = 0;
                let mut first_frame = None;
                let sample_rate = u64::from(AudioRenderer::SAMPLE_RATE);
                let fps_u64 = u64::from(fps);
                let mut audio_sample_cursor = 0u64;

                let mut consecutive_timeouts = 0u32;
                const MAX_CONSECUTIVE_TIMEOUTS: u32 = 3;

                loop {
                    let timeout_secs = if frame_count == 0 { 120 } else { 90 };
                    let (frame, frame_number) = match tokio::time::timeout(
                        Duration::from_secs(timeout_secs),
                        video_rx.recv(),
                    )
                    .await
                    {
                        Err(_) => {
                            consecutive_timeouts += 1;

                            if consecutive_timeouts >= MAX_CONSECUTIVE_TIMEOUTS {
                                tracing::error!(
                                    frame_count = frame_count,
                                    timeout_secs = timeout_secs,
                                    consecutive_timeouts = consecutive_timeouts,
                                    "Export render_task timed out {} consecutive times - aborting",
                                    MAX_CONSECUTIVE_TIMEOUTS
                                );
                                return Err(format!(
                                    "Export timed out {MAX_CONSECUTIVE_TIMEOUTS} times consecutively after {timeout_secs}s each waiting for frame {frame_count} - GPU/decoder may be unresponsive"
                                ));
                            }

                            tracing::warn!(
                                frame_count = frame_count,
                                timeout_secs = timeout_secs,
                                consecutive_timeouts = consecutive_timeouts,
                                "Frame receive timed out, waiting for next frame..."
                            );
                            continue;
                        }
                        Ok(Some(v)) => {
                            consecutive_timeouts = 0;
                            v
                        }
                        Ok(None) => {
                            tracing::debug!(
                                frame_count = frame_count,
                                "Render channel closed - rendering complete"
                            );
                            break;
                        }
                    };

                    if !(on_progress)(frame_count) {
                        return Err("Export cancelled".to_string());
                    }

                    if frame_count == 0 {
                        first_frame = Some(frame.clone());
                        if let Some(audio) = &mut audio_renderer {
                            audio.set_playhead(0.0, &project);
                        }
                    }

                    let audio_frame = audio_renderer.as_mut().and_then(|audio| {
                        let n = u64::from(frame_number);
                        let end = ((n + 1) * sample_rate) / fps_u64;
                        if end <= audio_sample_cursor {
                            return None;
                        }
                        let pts = audio_sample_cursor as i64;
                        let samples = (end - audio_sample_cursor) as usize;
                        audio_sample_cursor = end;
                        audio.render_frame(samples, &project).map(|mut frame| {
                            frame.set_pts(Some(pts));
                            frame
                        })
                    });

                    if frame_tx
                        .send(MP4Input {
                            audio: audio_frame,
                            video: video_info.wrap_frame(
                                &frame.data,
                                frame_number as i64,
                                frame.padded_bytes_per_row as usize,
                            ),
                        })
                        .is_err()
                    {
                        warn!("Renderer task sender dropped. Exiting");
                        return Ok(());
                    }

                    frame_count += 1;
                }

                drop(frame_tx);

                if let Some(frame) = first_frame {
                    let project_path = project_path.clone();
                    let screenshot_task = tokio::task::spawn_blocking(move || {
                        let rgb_img = ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(
                            frame.width,
                            frame.height,
                            frame
                                .data
                                .chunks(frame.padded_bytes_per_row as usize)
                                .flat_map(|row| {
                                    row[0..(frame.width * 4) as usize]
                                        .chunks(4)
                                        .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
                                })
                                .collect::<Vec<_>>(),
                        );

                        let Some(rgb_img) = rgb_img else {
                            return;
                        };

                        let screenshots_dir = project_path.join("screenshots");
                        if std::fs::create_dir_all(&screenshots_dir).is_err() {
                            return;
                        }

                        let screenshot_path = screenshots_dir.join("display.jpg");
                        let _ = rgb_img.save(&screenshot_path);
                    });

                    if let Err(e) = screenshot_task.await {
                        warn!("Screenshot task failed: {e}");
                    }
                } else {
                    warn!("No frames were processed, cannot save screenshot or thumbnail");
                }

                Ok::<_, String>(())
            }
        })
        .then(|r| async {
            r.map_err(|e| e.to_string())
                .and_then(|v| v.map_err(|e| e.to_string()))
        });

        let render_video_task = cap_rendering::render_video_to_channel(
            &base.render_constants,
            &base.project_config,
            tx_image_data,
            &base.recording_meta,
            meta,
            base.segments
                .iter()
                .map(|s| RenderSegment {
                    cursor: s.cursor.clone(),
                    decoders: s.decoders.clone(),
                })
                .collect(),
            fps,
            self.resolution_base,
            &base.recordings,
        )
        .then(|v| async { v.map_err(|e| e.to_string()) });

        tokio::try_join!(encoder_thread, render_video_task, render_task)?;

        Ok(output_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum_samples(sample_rate: u64, fps: u64, frames: u64) -> u64 {
        (0..frames)
            .map(|n| {
                let start = (n * sample_rate) / fps;
                let end = ((n + 1) * sample_rate) / fps;
                end - start
            })
            .sum()
    }

    #[test]
    fn audio_samples_match_duration_across_fps() {
        let sample_rate = u64::from(AudioRenderer::SAMPLE_RATE);

        for fps in [24u64, 30, 60, 90, 120, 144] {
            let frames = fps * 10;
            let expected = (frames * sample_rate) / fps;
            assert_eq!(sum_samples(sample_rate, fps, frames), expected);
        }
    }
}
