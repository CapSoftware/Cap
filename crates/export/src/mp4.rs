use crate::ExporterBase;
use cap_editor::{AudioRenderer, get_audio_segments};
use cap_enc_ffmpeg::{AudioEncoder, aac::AACEncoder, h264::H264Encoder, mp4::*};
use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_project::XY;
use cap_rendering::{Nv12RenderedFrame, ProjectUniforms, RenderSegment};
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
        on_progress: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<PathBuf, String> {
        info!("Exporting mp4 with settings: {:?}", &self);
        info!("Expected to render {} frames", base.total_frames(self.fps));

        let fps = self.fps;

        let output_size = ProjectUniforms::get_output_size(
            &base.render_constants.options,
            &base.project_config,
            self.resolution_base,
        );

        let nv12_compatible = output_size.0.is_multiple_of(4) && output_size.1.is_multiple_of(2);

        if nv12_compatible {
            info!(
                width = output_size.0,
                height = output_size.1,
                "Using GPU NV12 export path (reduced readback + no CPU swscale)"
            );
            self.export_nv12(base, output_size, fps, on_progress).await
        } else {
            info!(
                width = output_size.0,
                height = output_size.1,
                "Falling back to RGBA export path (dimensions not NV12-compatible)"
            );
            self.export_rgba(base, output_size, fps, on_progress).await
        }
    }

    async fn export_nv12(
        self,
        base: ExporterBase,
        output_size: (u32, u32),
        fps: u32,
        mut on_progress: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<PathBuf, String> {
        let output_path = base.output_path.clone();
        let meta = &base.studio_meta;

        let (tx_image_data, mut video_rx) =
            tokio::sync::mpsc::channel::<(Nv12RenderedFrame, u32)>(16);
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(16);

        let mut video_info =
            VideoInfo::from_raw(RawVideoFormat::Nv12, output_size.0, output_size.1, fps);
        video_info.time_base = ffmpeg::Rational::new(1, fps as i32);

        let mut rgba_video_info =
            VideoInfo::from_raw(RawVideoFormat::Rgba, output_size.0, output_size.1, fps);
        rgba_video_info.time_base = ffmpeg::Rational::new(1, fps as i32);

        let audio_segments = get_audio_segments(&base.segments);

        let mut audio_renderer = audio_segments
            .first()
            .filter(|_| !base.project_config.audio.mute)
            .map(|_| AudioRenderer::new(audio_segments.clone()));
        let has_audio = audio_renderer.is_some();

        let encoder_thread = tokio::task::spawn_blocking(move || {
            trace!("Creating MP4File encoder (NV12 path)");

            let mut encoder = MP4File::init(
                "output",
                base.output_path.clone(),
                |o| {
                    H264Encoder::builder(video_info)
                        .with_bpp(self.effective_bpp())
                        .with_export_priority()
                        .with_export_settings()
                        .with_external_conversion()
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

            info!("Created MP4File encoder (NV12, external conversion, export settings)");

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
                let mut first_frame_data: Option<FirstFrameNv12> = None;
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
                        first_frame_data = Some(FirstFrameNv12 {
                            data: frame.data.clone(),
                            width: frame.width,
                            height: frame.height,
                            y_stride: frame.y_stride,
                        });
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

                    let video_frame =
                        nv12_to_ffmpeg_frame(&frame, frame_number as i64, &rgba_video_info);

                    if frame_tx
                        .send(MP4Input {
                            audio: audio_frame,
                            video: video_frame,
                        })
                        .is_err()
                    {
                        warn!("Renderer task sender dropped. Exiting");
                        return Ok(());
                    }

                    frame_count += 1;
                }

                drop(frame_tx);

                if let Some(first) = first_frame_data {
                    let project_path = project_path.clone();
                    let screenshot_task = tokio::task::spawn_blocking(move || {
                        save_screenshot_from_nv12(
                            &first.data,
                            first.width,
                            first.height,
                            first.y_stride,
                            &project_path,
                        );
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

        let render_video_task = cap_rendering::render_video_to_channel_nv12(
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

    async fn export_rgba(
        self,
        base: ExporterBase,
        output_size: (u32, u32),
        fps: u32,
        mut on_progress: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<PathBuf, String> {
        let output_path = base.output_path.clone();
        let meta = &base.studio_meta;

        let (tx_image_data, mut video_rx) =
            tokio::sync::mpsc::channel::<(cap_rendering::RenderedFrame, u32)>(16);
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(16);

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
            trace!("Creating MP4File encoder (RGBA fallback)");

            let mut encoder = MP4File::init(
                "output",
                base.output_path.clone(),
                |o| {
                    H264Encoder::builder(video_info)
                        .with_bpp(self.effective_bpp())
                        .with_export_priority()
                        .with_export_settings()
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

            info!("Created MP4File encoder (RGBA fallback, export settings)");

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

struct FirstFrameNv12 {
    data: Vec<u8>,
    width: u32,
    height: u32,
    y_stride: u32,
}

fn nv12_to_ffmpeg_frame(
    frame: &Nv12RenderedFrame,
    pts: i64,
    rgba_video_info: &VideoInfo,
) -> ffmpeg::frame::Video {
    use cap_rendering::GpuOutputFormat;

    if frame.format == GpuOutputFormat::Rgba {
        tracing::warn!(
            frame_number = frame.frame_number,
            "NV12 conversion fell back to RGBA - converting on CPU"
        );
        let rgba_frame = rgba_video_info.wrap_frame(&frame.data, pts, frame.y_stride as usize);
        let mut converter = ffmpeg::software::scaling::Context::get(
            ffmpeg::format::Pixel::RGBA,
            frame.width,
            frame.height,
            ffmpeg::format::Pixel::NV12,
            frame.width,
            frame.height,
            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
        )
        .expect("failed to create RGBA→NV12 scaler");
        let mut nv12_frame =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, frame.width, frame.height);
        converter
            .run(&rgba_frame, &mut nv12_frame)
            .expect("RGBA→NV12 conversion failed");
        nv12_frame.set_pts(Some(pts));
        return nv12_frame;
    }

    let width = frame.width;
    let height = frame.height;
    let y_stride = frame.y_stride;

    let mut video_frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
    video_frame.set_pts(Some(pts));

    let y_plane_size = (y_stride as usize) * (height as usize);
    let y_src = &frame.data[..y_plane_size.min(frame.data.len())];
    let uv_src = if y_plane_size < frame.data.len() {
        &frame.data[y_plane_size..]
    } else {
        &[]
    };

    let dst_y_stride = video_frame.stride(0);
    let dst_uv_stride = video_frame.stride(1);

    if dst_y_stride == y_stride as usize {
        let copy_len = y_src.len().min(video_frame.data_mut(0).len());
        video_frame.data_mut(0)[..copy_len].copy_from_slice(&y_src[..copy_len]);
    } else {
        for row in 0..height as usize {
            let src_start = row * y_stride as usize;
            let dst_start = row * dst_y_stride;
            let copy_width = (width as usize).min(y_stride as usize).min(dst_y_stride);
            if src_start + copy_width <= y_src.len()
                && dst_start + copy_width <= video_frame.data_mut(0).len()
            {
                video_frame.data_mut(0)[dst_start..dst_start + copy_width]
                    .copy_from_slice(&y_src[src_start..src_start + copy_width]);
            }
        }
    }

    let uv_height = height as usize / 2;
    let uv_width = width as usize;
    if dst_uv_stride == uv_width {
        let copy_len = uv_src.len().min(video_frame.data_mut(1).len());
        video_frame.data_mut(1)[..copy_len].copy_from_slice(&uv_src[..copy_len]);
    } else {
        for row in 0..uv_height {
            let src_start = row * uv_width;
            let dst_start = row * dst_uv_stride;
            let copy_width = uv_width.min(dst_uv_stride);
            if src_start + copy_width <= uv_src.len()
                && dst_start + copy_width <= video_frame.data_mut(1).len()
            {
                video_frame.data_mut(1)[dst_start..dst_start + copy_width]
                    .copy_from_slice(&uv_src[src_start..src_start + copy_width]);
            }
        }
    }

    video_frame
}

fn save_screenshot_from_nv12(
    nv12_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    project_path: &std::path::Path,
) {
    let y_plane_size = (y_stride as usize) * (height as usize);
    let y_data = &nv12_data[..y_plane_size.min(nv12_data.len())];
    let uv_data = if y_plane_size < nv12_data.len() {
        &nv12_data[y_plane_size..]
    } else {
        return;
    };

    let mut rgba = vec![0u8; (width * height * 4) as usize];
    cap_rendering::cpu_yuv::nv12_to_rgba_simd(
        y_data, uv_data, width, height, y_stride, width, &mut rgba,
    );

    let rgb_img = ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(
        width,
        height,
        rgba.chunks(4)
            .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
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
