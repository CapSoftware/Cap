use crate::ExporterBase;
use cap_editor::{AudioRenderer, get_audio_segments};
use cap_enc_ffmpeg::{AudioEncoder, aac::AACEncoder, h264::H264Encoder, mp4::*};
use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_project::XY;
use cap_rendering::{
    GpuOutputFormat, Nv12RenderedFrame, ProjectUniforms, RenderSegment, SharedNv12Buffer,
};
use futures::FutureExt;
use image::ImageBuffer;
use serde::Deserialize;
use specta::Type;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
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

#[derive(Clone, Default)]
struct ExportNv12Mode {
    stop_after_frames_sent: Option<u32>,
    record_first_queued_ms_since_pipeline: Option<Arc<AtomicU64>>,
    nv12_render_startup_breakdown_ms:
        Option<Arc<Mutex<Option<cap_rendering::Nv12RenderStartupBreakdownMs>>>>,
}

#[derive(Debug, serde::Serialize)]
pub struct FirstFrameQueuedBenchmark {
    pub ms_to_first_frame_queued_since_export_pipeline_start: u64,
    pub nv12_render_startup_breakdown_ms: Option<cap_rendering::Nv12RenderStartupBreakdownMs>,
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

        info!(
            width = output_size.0,
            height = output_size.1,
            "Exporting with NV12 pipeline (GPU when possible, CPU fallback otherwise)"
        );
        self.export_nv12(
            base,
            output_size,
            fps,
            on_progress,
            ExportNv12Mode::default(),
        )
        .await
    }

    pub async fn benchmark_first_frame_with_breakdown(
        self,
        base: ExporterBase,
    ) -> Result<FirstFrameQueuedBenchmark, String> {
        let fps = self.fps;
        let output_size = ProjectUniforms::get_output_size(
            &base.render_constants.options,
            &base.project_config,
            self.resolution_base,
        );
        let first_ms = Arc::new(AtomicU64::new(u64::MAX));
        let first_ms_enc = Arc::clone(&first_ms);
        let breakdown = Arc::new(Mutex::new(None));
        let breakdown_enc = Arc::clone(&breakdown);
        self.export_nv12(
            base,
            output_size,
            fps,
            |_| true,
            ExportNv12Mode {
                stop_after_frames_sent: Some(1),
                record_first_queued_ms_since_pipeline: Some(first_ms_enc),
                nv12_render_startup_breakdown_ms: Some(breakdown_enc),
            },
        )
        .await?;
        let v = first_ms.load(Ordering::Relaxed);
        if v == u64::MAX {
            return Err("first frame was not queued to the encoder".to_string());
        }
        let nv12_render_startup_breakdown_ms = breakdown.lock().ok().and_then(|mut g| g.take());
        Ok(FirstFrameQueuedBenchmark {
            ms_to_first_frame_queued_since_export_pipeline_start: v,
            nv12_render_startup_breakdown_ms,
        })
    }

    pub async fn benchmark_ms_to_first_frame_queued(
        self,
        base: ExporterBase,
    ) -> Result<u64, String> {
        Ok(self
            .benchmark_first_frame_with_breakdown(base)
            .await?
            .ms_to_first_frame_queued_since_export_pipeline_start)
    }

    async fn export_nv12(
        self,
        base: ExporterBase,
        output_size: (u32, u32),
        fps: u32,
        on_progress: impl FnMut(u32) -> bool + Send + 'static,
        mode: ExportNv12Mode,
    ) -> Result<PathBuf, String> {
        let pipeline_start = std::time::Instant::now();
        let output_path = base.output_path.clone();
        let meta = &base.studio_meta;

        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<ExportFrame>(4);

        let mut video_info =
            VideoInfo::from_raw(RawVideoFormat::Nv12, output_size.0, output_size.1, fps);
        video_info.time_base = ffmpeg::Rational::new(1, fps as i32);

        let audio_segments = get_audio_segments(&base.segments);

        let has_audio = audio_segments
            .first()
            .filter(|_| !base.project_config.audio.mute)
            .is_some();

        let record_first_queued_ms = mode.record_first_queued_ms_since_pipeline;
        let nv12_render_startup_breakdown_ms = mode.nv12_render_startup_breakdown_ms;

        let project_for_audio = base.project_config.clone();
        let pipeline_start_for_encoder = pipeline_start;
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

            let mut audio_renderer = if has_audio {
                Some(AudioRenderer::new(audio_segments))
            } else {
                None
            };

            let mut reusable_frame = ffmpeg::frame::Video::new(
                ffmpeg::format::Pixel::NV12,
                output_size.0,
                output_size.1,
            );
            let mut converted_frame: Option<ffmpeg::frame::Video> = None;
            let mut encoded_frames = 0u32;
            let encode_start = std::time::Instant::now();
            let sample_rate = u64::from(AudioRenderer::SAMPLE_RATE);
            let fps_u64 = u64::from(fps);
            let mut audio_sample_cursor = 0u64;

            while let Ok(input) = frame_rx.recv() {
                if encoded_frames == 0
                    && let Some(audio) = &mut audio_renderer
                {
                    audio.set_playhead(0.0, &project_for_audio);
                }

                let audio_frame = audio_renderer.as_mut().and_then(|audio| {
                    let n = u64::from(input.frame_number);
                    let end = ((n + 1) * sample_rate) / fps_u64;
                    if end <= audio_sample_cursor {
                        return None;
                    }
                    let pts = audio_sample_cursor as i64;
                    let samples = (end - audio_sample_cursor) as usize;
                    audio_sample_cursor = end;
                    audio
                        .render_frame(samples, &project_for_audio)
                        .map(|mut frame| {
                            frame.set_pts(Some(pts));
                            frame
                        })
                });

                fill_nv12_frame_direct(
                    &mut reusable_frame,
                    &input.nv12_data,
                    input.width,
                    input.height,
                    input.y_stride,
                    input.frame_number as i64,
                );
                encoder
                    .queue_video_frame_reusable(
                        &mut reusable_frame,
                        &mut converted_frame,
                        Duration::MAX,
                    )
                    .map_err(|err| err.to_string())?;
                if let Some(audio) = audio_frame {
                    encoder.queue_audio_frame(audio);
                }
                encoded_frames += 1;
                if encoded_frames == 1
                    && let Some(atom) = record_first_queued_ms.as_ref()
                {
                    let ms = pipeline_start_for_encoder.elapsed().as_millis() as u64;
                    let _ =
                        atom.compare_exchange(u64::MAX, ms, Ordering::Relaxed, Ordering::Relaxed);
                }
            }

            let encode_elapsed = encode_start.elapsed();
            if encoded_frames > 0 {
                let encode_fps = encoded_frames as f64 / encode_elapsed.as_secs_f64().max(0.001);
                info!(
                    encoded_frames = encoded_frames,
                    elapsed_secs = format!("{:.2}", encode_elapsed.as_secs_f64()),
                    encode_fps = format!("{:.1}", encode_fps),
                    "Encoder thread finished"
                );
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

        let stop_after_frames_sent = mode.stop_after_frames_sent;
        let render_video_task = export_render_to_channel(
            &base.render_constants,
            &base.project_config,
            frame_tx,
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
            stop_after_frames_sent,
            nv12_render_startup_breakdown_ms,
            on_progress,
            base.project_path.clone(),
        )
        .then(|v| async { v.map_err(|e| e.to_string()) });

        tokio::try_join!(encoder_thread, render_video_task)?;

        Ok(output_path)
    }
}

struct ExportFrame {
    nv12_data: SharedNv12Buffer,
    width: u32,
    height: u32,
    y_stride: u32,
    frame_number: u32,
}

struct FirstFrameNv12 {
    data: SharedNv12Buffer,
    width: u32,
    height: u32,
    y_stride: u32,
}

fn nv12_from_rendered_frame(frame: Nv12RenderedFrame) -> ExportFrame {
    if frame.format != GpuOutputFormat::Rgba {
        return ExportFrame {
            width: frame.width,
            height: frame.height,
            y_stride: frame.y_stride,
            frame_number: frame.frame_number,
            nv12_data: frame.data,
        };
    }

    tracing::warn!(
        frame_number = frame.frame_number,
        "GPU NV12 converter returned RGBA - converting to NV12 on CPU"
    );

    let width = frame.width;
    let height = frame.height;

    let mut rgba_frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, width, height);
    let stride = rgba_frame.stride(0);
    let src_stride = frame.y_stride as usize;
    for row in 0..height as usize {
        let src_start = row * src_stride;
        let dst_start = row * stride;
        let copy_width = (width as usize * 4).min(stride).min(src_stride);
        if src_start + copy_width <= frame.data.len()
            && dst_start + copy_width <= rgba_frame.data_mut(0).len()
        {
            rgba_frame.data_mut(0)[dst_start..dst_start + copy_width]
                .copy_from_slice(&frame.data[src_start..src_start + copy_width]);
        }
    }

    if let Ok(mut converter) = ffmpeg::software::scaling::Context::get(
        ffmpeg::format::Pixel::RGBA,
        width,
        height,
        ffmpeg::format::Pixel::NV12,
        width,
        height,
        ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
    ) {
        let mut nv12_frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
        if converter.run(&rgba_frame, &mut nv12_frame).is_ok() {
            let y_size = nv12_frame.stride(0) * height as usize;
            let uv_size = nv12_frame.stride(1) * (height as usize / 2);
            let y_data = &nv12_frame.data(0)[..y_size];
            let uv_data = &nv12_frame.data(1)[..uv_size];
            let mut result = Vec::with_capacity(width as usize * height as usize * 3 / 2);

            if nv12_frame.stride(0) == width as usize {
                result.extend_from_slice(y_data);
            } else {
                for row in 0..height as usize {
                    let start = row * nv12_frame.stride(0);
                    result.extend_from_slice(&y_data[start..start + width as usize]);
                }
            }

            if nv12_frame.stride(1) == width as usize {
                result.extend_from_slice(uv_data);
            } else {
                for row in 0..(height as usize / 2) {
                    let start = row * nv12_frame.stride(1);
                    result.extend_from_slice(&uv_data[start..start + width as usize]);
                }
            }

            return ExportFrame {
                nv12_data: SharedNv12Buffer::from_vec(result),
                width,
                height,
                y_stride: width,
                frame_number: frame.frame_number,
            };
        }
    }

    tracing::error!(
        frame_number = frame.frame_number,
        "swscale RGBA to NV12 conversion failed, using zeroed NV12"
    );
    ExportFrame {
        nv12_data: SharedNv12Buffer::from_vec(vec![0u8; width as usize * height as usize * 3 / 2]),
        width,
        height,
        y_stride: width,
        frame_number: frame.frame_number,
    }
}

fn fill_nv12_frame_direct(
    frame: &mut ffmpeg::frame::Video,
    nv12_data: &[u8],
    width: u32,
    height: u32,
    y_stride: u32,
    pts: i64,
) {
    frame.set_pts(Some(pts));

    let width = width as usize;
    let height = height as usize;
    let y_stride = y_stride as usize;

    let y_plane_size = y_stride * height;
    let y_src = &nv12_data[..y_plane_size.min(nv12_data.len())];
    let uv_src = if y_plane_size < nv12_data.len() {
        &nv12_data[y_plane_size..]
    } else {
        &[]
    };

    let dst_y_stride = frame.stride(0);
    if dst_y_stride == y_stride {
        let copy_len = y_src.len().min(frame.data_mut(0).len());
        frame.data_mut(0)[..copy_len].copy_from_slice(&y_src[..copy_len]);
    } else {
        for row in 0..height {
            let src_start = row * y_stride;
            let dst_start = row * dst_y_stride;
            let copy_width = width.min(y_stride).min(dst_y_stride);
            if src_start + copy_width <= y_src.len()
                && dst_start + copy_width <= frame.data_mut(0).len()
            {
                frame.data_mut(0)[dst_start..dst_start + copy_width]
                    .copy_from_slice(&y_src[src_start..src_start + copy_width]);
            }
        }
    }

    let uv_height = height / 2;
    let dst_uv_stride = frame.stride(1);
    if dst_uv_stride == width {
        let copy_len = uv_src.len().min(frame.data_mut(1).len());
        frame.data_mut(1)[..copy_len].copy_from_slice(&uv_src[..copy_len]);
    } else {
        for row in 0..uv_height {
            let src_start = row * width;
            let dst_start = row * dst_uv_stride;
            let copy_width = width.min(dst_uv_stride);
            if src_start + copy_width <= uv_src.len()
                && dst_start + copy_width <= frame.data_mut(1).len()
            {
                frame.data_mut(1)[dst_start..dst_start + copy_width]
                    .copy_from_slice(&uv_src[src_start..src_start + copy_width]);
            }
        }
    }
}

#[cfg(test)]
struct Nv12ExportFrame {
    nv12_data: SharedNv12Buffer,
    width: u32,
    height: u32,
    y_stride: u32,
    pts: i64,
    audio: Option<ffmpeg::frame::Audio>,
}

#[cfg(test)]
fn fill_nv12_frame(frame: &mut ffmpeg::frame::Video, input: &Nv12ExportFrame) {
    fill_nv12_frame_direct(
        frame,
        &input.nv12_data,
        input.width,
        input.height,
        input.y_stride,
        input.pts,
    );
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

use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta};
use cap_rendering::{ProjectRecordingsMeta, RenderVideoConstants};

const FRAME_RECEIVE_INITIAL_TIMEOUT_SECS: u64 = 120;
const FRAME_RECEIVE_STEADY_TIMEOUT_SECS: u64 = 90;
const MAX_CONSECUTIVE_FRAME_TIMEOUTS: u32 = 3;

#[allow(clippy::too_many_arguments)]
async fn export_render_to_channel(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    sender: std::sync::mpsc::SyncSender<ExportFrame>,
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    render_segments: Vec<RenderSegment>,
    fps: u32,
    resolution_base: XY<u32>,
    recordings: &ProjectRecordingsMeta,
    stop_after_frames_sent: Option<u32>,
    startup_breakdown_ms: Option<Arc<Mutex<Option<cap_rendering::Nv12RenderStartupBreakdownMs>>>>,
    mut on_progress: impl FnMut(u32) -> bool + Send + 'static,
    project_path: PathBuf,
) -> Result<(), cap_rendering::RenderingError> {
    let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(Nv12RenderedFrame, u32)>(2);

    let screenshot_project_path = project_path;

    let render_result = {
        let render_future = cap_rendering::render_video_to_channel_nv12(
            constants,
            project,
            tx_image_data,
            recording_meta,
            meta,
            render_segments,
            fps,
            resolution_base,
            recordings,
            stop_after_frames_sent,
            startup_breakdown_ms,
        );

        let forward_future = async {
            let mut first_frame_data: Option<FirstFrameNv12> = None;
            let mut frame_count = 0u32;
            let mut consecutive_timeouts = 0u32;

            loop {
                let timeout_secs = if frame_count == 0 {
                    FRAME_RECEIVE_INITIAL_TIMEOUT_SECS
                } else {
                    FRAME_RECEIVE_STEADY_TIMEOUT_SECS
                };

                let Some((frame, _frame_number)) = (match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    video_rx.recv(),
                )
                .await
                {
                    Ok(frame) => {
                        consecutive_timeouts = 0;
                        frame
                    }
                    Err(_) => {
                        consecutive_timeouts += 1;

                        if consecutive_timeouts >= MAX_CONSECUTIVE_FRAME_TIMEOUTS {
                            return Err(cap_rendering::RenderingError::ImageLoadError(format!(
                                "Export timed out {MAX_CONSECUTIVE_FRAME_TIMEOUTS} times consecutively after {timeout_secs}s each waiting for frame {frame_count}"
                            )));
                        }

                        warn!(
                            frame_count = frame_count,
                            timeout_secs = timeout_secs,
                            consecutive_timeouts = consecutive_timeouts,
                            "Timed out waiting for rendered frame"
                        );
                        continue;
                    }
                }) else {
                    break;
                };

                if !(on_progress)(frame_count) {
                    return Err(cap_rendering::RenderingError::ImageLoadError(
                        "Export cancelled".to_string(),
                    ));
                }

                let export_frame = nv12_from_rendered_frame(frame);

                if first_frame_data.is_none() {
                    first_frame_data = Some(FirstFrameNv12 {
                        data: export_frame.nv12_data.clone(),
                        width: export_frame.width,
                        height: export_frame.height,
                        y_stride: export_frame.y_stride,
                    });
                }

                if sender.send(export_frame).is_err() {
                    warn!("Encoder dropped, stopping render forwarding");
                    break;
                }

                frame_count += 1;
            }

            drop(sender);

            if let Some(first) = first_frame_data {
                let pp = screenshot_project_path;
                let _screenshot_task = tokio::task::spawn_blocking(move || {
                    save_screenshot_from_nv12(
                        first.data.as_ref(),
                        first.width,
                        first.height,
                        first.y_stride,
                        &pp,
                    );
                });
            }

            Ok::<_, cap_rendering::RenderingError>(())
        };

        tokio::try_join!(render_future, forward_future)
    };

    render_result?;

    Ok(())
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

    #[test]
    fn fill_nv12_frame_preserves_data_layout() {
        ffmpeg::init().unwrap();

        let width = 8u32;
        let height = 4u32;
        let y_size = (width * height) as usize;
        let uv_size = (width * height / 2) as usize;

        let mut nv12_data = vec![0u8; y_size + uv_size];
        for (i, item) in nv12_data.iter_mut().take(y_size).enumerate() {
            *item = (i % 256) as u8;
        }
        for (i, item) in nv12_data.iter_mut().skip(y_size).take(uv_size).enumerate() {
            *item = (128 + i % 128) as u8;
        }

        let input = Nv12ExportFrame {
            nv12_data: SharedNv12Buffer::from_vec(nv12_data.clone()),
            width,
            height,
            y_stride: width,
            pts: 42,
            audio: None,
        };

        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
        fill_nv12_frame(&mut frame, &input);

        assert_eq!(frame.pts(), Some(42));

        for row in 0..height as usize {
            for col in 0..width as usize {
                let src_val = nv12_data[row * width as usize + col];
                let dst_val = frame.data(0)[row * frame.stride(0) + col];
                assert_eq!(src_val, dst_val, "Y mismatch at ({col}, {row})");
            }
        }

        for row in 0..(height / 2) as usize {
            for col in 0..width as usize {
                let src_val = nv12_data[y_size + row * width as usize + col];
                let dst_val = frame.data(1)[row * frame.stride(1) + col];
                assert_eq!(src_val, dst_val, "UV mismatch at ({col}, {row})");
            }
        }
    }

    #[test]
    fn nv12_from_rendered_frame_passthrough_for_nv12_format() {
        use cap_rendering::{GpuOutputFormat, Nv12RenderedFrame};

        let data = vec![1u8, 2, 3, 4, 5, 6];
        let frame = Nv12RenderedFrame {
            data: SharedNv12Buffer::from_vec(data.clone()),
            width: 4,
            height: 2,
            y_stride: 4,
            frame_number: 0,
            target_time_ns: 0,
            format: GpuOutputFormat::Nv12,
        };

        let result = nv12_from_rendered_frame(frame);
        assert_eq!(*result.nv12_data, data);
    }

    #[test]
    fn nv12_export_frame_dimensions_match() {
        let width = 1920u32;
        let height = 1080u32;
        assert!(
            width.is_multiple_of(4),
            "1920 should be NV12-compatible (divisible by 4)"
        );
        assert!(
            height.is_multiple_of(2),
            "1080 should be NV12-compatible (divisible by 2)"
        );

        let nv12_size = width as usize * height as usize * 3 / 2;
        assert_eq!(nv12_size, 3_110_400);
        let rgba_size = width as usize * height as usize * 4;
        assert_eq!(rgba_size, 8_294_400);

        let savings_pct = (1.0 - nv12_size as f64 / rgba_size as f64) * 100.0;
        assert!(
            savings_pct > 62.0 && savings_pct < 63.0,
            "NV12 should save ~62.5% vs RGBA, got {savings_pct:.1}%"
        );
    }
}
