use std::path::PathBuf;

use cap_media::encoders::GifEncoderWrapper;
use cap_project::XY;
use cap_rendering::{ProjectUniforms, RenderSegment, RenderedFrame};
use futures::FutureExt;
use serde::Deserialize;
use specta::Type;
use tracing::trace;

use crate::{ExportError, ExporterBase};

#[derive(Deserialize, Clone, Copy, Debug, Type)]
pub struct GifExportSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
}

impl GifExportSettings {
    pub async fn export(
        self,
        base: ExporterBase,
        mut on_progress: impl FnMut(u32) + Send + 'static,
    ) -> Result<PathBuf, String> {
        let meta = &base.studio_meta;

        let (tx_image_data, mut video_rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);

        let fps = self.fps;

        let output_size = ProjectUniforms::get_output_size(
            &base.render_constants.options,
            &base.project_config,
            self.resolution_base,
        );

        // Ensure the output path has .gif extension
        let mut gif_output_path = base.output_path.clone();
        if gif_output_path.extension() != Some(std::ffi::OsStr::new("gif")) {
            gif_output_path.set_extension("gif");
        }

        std::fs::create_dir_all(gif_output_path.parent().unwrap()).map_err(|e| e.to_string())?;

        trace!(
            "Creating GIF encoder at path '{}'",
            gif_output_path.display()
        );
        let mut gif_encoder =
            GifEncoderWrapper::new(&gif_output_path, output_size.0, output_size.1, fps)
                .map_err(|e| format!("Failed to create GIF encoder: {}", e))?;

        let encoder_thread = tokio::task::spawn_blocking(move || {
            let mut frame_count = 0;

            while let Some((frame, _frame_number)) = video_rx.blocking_recv() {
                (on_progress)(frame_count);

                if let Err(e) =
                    gif_encoder.add_frame(&frame.data, frame.padded_bytes_per_row as usize)
                {
                    return Err(ExportError::Other(format!(
                        "Failed to add frame to GIF: {}",
                        e
                    )));
                }

                frame_count += 1;
            }

            if let Err(e) = gif_encoder.finish() {
                return Err(ExportError::Other(format!("Failed to finish GIF: {}", e)));
            }

            Ok(gif_output_path)
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
                    decoders: s.decoders.clone(),
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
