use cap_enc_ffmpeg::{mov::MOVFile, prores::ProResEncoder};
use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_project::XY;
use cap_rendering::{ProjectUniforms, RenderSegment, RenderedFrame};
use futures::FutureExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{path::PathBuf, time::Duration};

use crate::{ExportError, ExporterBase};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Type)]
pub struct MovExportSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
    #[serde(default)]
    pub cursor_only: bool,
}

impl MovExportSettings {
    pub async fn export(
        self,
        base: ExporterBase,
        mut on_progress: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<PathBuf, String> {
        let meta = &base.studio_meta;

        let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);
        let fps = self.fps;

        let output_size = ProjectUniforms::get_output_size(
            &base.render_constants.options,
            &base.project_config,
            self.resolution_base,
        );

        let mut mov_output_path = base.output_path.clone();
        if mov_output_path.extension() != Some(std::ffi::OsStr::new("mov")) {
            mov_output_path.set_extension("mov");
        }

        if let Some(parent) = mov_output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let video_info =
            VideoInfo::from_raw(RawVideoFormat::Rgba, output_size.0, output_size.1, fps);

        let encoder_thread = tokio::task::spawn_blocking(move || {
            let mut mov_encoder = MOVFile::init(mov_output_path.clone(), |output| {
                ProResEncoder::builder(video_info).build(output)
            })
            .map_err(|e| ExportError::Other(format!("Failed to create MOV encoder: {e}")))?;

            let mut reusable_frame = ffmpeg::frame::Video::new(
                ffmpeg::format::Pixel::RGBA,
                output_size.0,
                output_size.1,
            );
            let mut frame_count = 0;

            while let Some((frame, frame_number)) = video_rx.blocking_recv() {
                if !on_progress(frame_count) {
                    return Err(ExportError::Other("Export cancelled".to_string()));
                }

                fill_rgba_frame(&mut reusable_frame, &frame)
                    .map_err(|e| ExportError::Other(format!("Failed to prepare frame: {e}")))?;
                let timestamp = Duration::from_secs_f64(frame_number as f64 / fps as f64);

                mov_encoder
                    .queue_video_frame(&mut reusable_frame, timestamp)
                    .map_err(|e| ExportError::Other(format!("Failed to encode MOV frame: {e}")))?;

                frame_count += 1;
            }

            mov_encoder
                .finish()
                .map_err(|e| ExportError::Other(format!("Failed to finish MOV: {e}")))?;

            Ok(mov_output_path)
        })
        .then(|f| async {
            f.map_err(|e| e.to_string())
                .and_then(|v| v.map_err(|v| v.to_string()))
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
                    keyboard: s.keyboard.clone(),
                    decoders: s.decoders.clone(),
                    render_display: false,
                })
                .collect(),
            fps,
            self.resolution_base,
            &base.recordings,
        )
        .then(|f| async { f.map_err(|v| v.to_string()) });

        let (output_path, _) =
            tokio::try_join!(encoder_thread, render_video_task).map_err(|e| e.to_string())?;

        Ok(output_path)
    }
}

fn fill_rgba_frame(
    ffmpeg_frame: &mut ffmpeg::frame::Video,
    frame: &RenderedFrame,
) -> Result<(), String> {
    let dst_stride = ffmpeg_frame.stride(0);
    let src_stride = frame.padded_bytes_per_row as usize;
    let row_bytes = (frame.width * 4) as usize;

    for row in 0..frame.height as usize {
        let src_start = row * src_stride;
        let dst_start = row * dst_stride;

        if src_start + row_bytes > frame.data.len()
            || dst_start + row_bytes > ffmpeg_frame.data_mut(0).len()
        {
            return Err("Frame buffer bounds exceeded".to_string());
        }

        ffmpeg_frame.data_mut(0)[dst_start..dst_start + row_bytes]
            .copy_from_slice(&frame.data[src_start..src_start + row_bytes]);
    }

    Ok(())
}
