use cap_project::XY;
use cap_rendering::{ProjectUniforms, RenderSegment, RenderedFrame};
use futures::FutureExt;
use gifski::{Collector, Repeat, Settings};
use rgb::RGBA8;
use serde::Deserialize;
use specta::Type;
use std::{
    fs::File,
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
};
use thiserror::Error;
use tracing::trace;

use crate::{ExportError, ExporterBase};

#[derive(Deserialize, Clone, Copy, Debug, Type)]
pub struct GifQuality {
    /// Encoding quality from 1-100 (default: 90)
    pub quality: Option<u8>,
    /// Whether to prioritize speed over quality (default: false)
    pub fast: Option<bool>,
}

#[derive(Deserialize, Clone, Copy, Debug, Type)]
pub struct GifExportSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
    pub quality: Option<GifQuality>,
}

impl Default for GifExportSettings {
    fn default() -> Self {
        Self {
            fps: 30,
            resolution_base: XY { x: 1920, y: 1080 },
            quality: None,
        }
    }
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

        // Create GIF encoder with quality settings
        let quality = self
            .quality
            .map(|q| encoder::GifQuality {
                quality: q.quality.unwrap_or(90),
                fast: q.fast.unwrap_or(false),
            })
            .unwrap_or_default();

        let mut gif_encoder = encoder::GifEncoderWrapper::new_with_quality(
            &gif_output_path,
            output_size.0,
            output_size.1,
            fps,
            quality,
        )
        .map_err(|e| format!("Failed to create GIF encoder: {e}"))?;

        let encoder_thread = tokio::task::spawn_blocking(move || {
            let mut frame_count = 0;

            while let Some((frame, _frame_number)) = video_rx.blocking_recv() {
                (on_progress)(frame_count);

                if let Err(e) =
                    gif_encoder.add_frame(&frame.data, frame.padded_bytes_per_row as usize)
                {
                    return Err(ExportError::Other(format!(
                        "Failed to add frame to GIF: {e}"
                    )));
                }

                frame_count += 1;
            }

            if let Err(e) = gif_encoder.finish() {
                return Err(ExportError::Other(format!("Failed to finish GIF: {e}")));
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

mod encoder {
    use super::*;

    /// Errors that can occur during GIF encoding
    #[derive(Error, Debug)]
    pub enum GifEncodingError {
        /// IO error occurred during encoding
        #[error("IO error: {0}")]
        Io(#[from] std::io::Error),
        /// Error from the gifski encoder
        #[error("Gifski error: {0}")]
        Gifski(String),
        /// Invalid frame data provided
        #[error("Invalid frame data")]
        InvalidFrameData,
        /// Encoder has been finished and cannot accept more frames
        #[error("Encoder already finished")]
        EncoderFinished,
    }

    /// Quality settings for GIF encoding
    #[derive(Clone, Debug)]
    pub struct GifQuality {
        /// Encoding quality from 1-100 (default: 90)
        pub quality: u8,
        /// Whether to prioritize speed over quality (default: false)
        pub fast: bool,
    }

    impl Default for GifQuality {
        fn default() -> Self {
            Self {
                quality: 90,
                fast: false,
            }
        }
    }

    /// Wrapper around gifski for encoding GIF animations
    pub struct GifEncoderWrapper {
        collector: Option<Collector>,
        writer_thread: Option<JoinHandle<Result<(), GifEncodingError>>>,
        width: u32,
        height: u32,
        frame_index: u32,
        fps: u32,
        finished: bool,
    }

    impl GifEncoderWrapper {
        pub fn new<P: AsRef<Path>>(
            path: P,
            width: u32,
            height: u32,
            fps: u32,
        ) -> Result<Self, GifEncodingError> {
            Self::new_with_quality(path, width, height, fps, GifQuality::default())
        }

        pub fn new_with_quality<P: AsRef<Path>>(
            path: P,
            width: u32,
            height: u32,
            fps: u32,
            quality: GifQuality,
        ) -> Result<Self, GifEncodingError> {
            if fps == 0 || width == 0 || height == 0 {
                return Err(GifEncodingError::InvalidFrameData);
            }
            let settings = Settings {
                width: Some(width),
                height: Some(height),
                quality: quality.quality,
                fast: quality.fast,
                repeat: Repeat::Infinite,
            };
            let (collector, writer) =
                gifski::new(settings).map_err(|e| GifEncodingError::Gifski(e.to_string()))?;

            let output_path = path.as_ref().to_path_buf();
            let writer_thread = thread::spawn(move || {
                let file = File::create(output_path).map_err(GifEncodingError::Io)?;
                writer
                    .write(file, &mut gifski::progress::NoProgress {})
                    .map_err(|e| GifEncodingError::Gifski(e.to_string()))
            });

            Ok(Self {
                collector: Some(collector),
                writer_thread: Some(writer_thread),
                width,
                height,
                frame_index: 0,
                fps,
                finished: false,
            })
        }

        /// Add a frame to the GIF
        pub fn add_frame(
            &mut self,
            frame_data: &[u8],
            bytes_per_row: usize,
        ) -> Result<(), GifEncodingError> {
            if self.finished {
                return Err(GifEncodingError::EncoderFinished);
            }

            let collector = self
                .collector
                .as_mut()
                .ok_or(GifEncodingError::EncoderFinished)?;

            // Calculate expected size
            let expected_bytes_per_row = (self.width as usize) * 4; // RGBA
            let expected_total_bytes = expected_bytes_per_row * (self.height as usize);

            // Validate frame data size
            if bytes_per_row < expected_bytes_per_row || frame_data.len() < expected_total_bytes {
                return Err(GifEncodingError::InvalidFrameData);
            }

            // Convert RGBA data to gifski's expected format
            let mut rgba_pixels = Vec::with_capacity(self.width as usize * self.height as usize);

            for y in 0..self.height {
                let src_row_start = (y as usize) * bytes_per_row;

                for x in 0..self.width {
                    let pixel_start = src_row_start + (x as usize) * 4;

                    if pixel_start + 3 < frame_data.len() {
                        let r = frame_data[pixel_start];
                        let g = frame_data[pixel_start + 1];
                        let b = frame_data[pixel_start + 2];
                        let a = frame_data[pixel_start + 3];

                        rgba_pixels.push(RGBA8::new(r, g, b, a));
                    } else {
                        return Err(GifEncodingError::InvalidFrameData);
                    }
                }
            }

            // Create imgref for gifski
            let img = imgref::Img::new(rgba_pixels, self.width as usize, self.height as usize);

            // Calculate presentation timestamp based on frame index and fps
            let pts = (self.frame_index as f64) / (self.fps as f64);

            // Add frame to collector
            collector
                .add_frame_rgba(self.frame_index as usize, img, pts)
                .map_err(|e| GifEncodingError::Gifski(e.to_string()))?;

            self.frame_index += 1;
            Ok(())
        }

        /// Finish encoding and close the GIF file
        ///
        /// This will wait for the encoding to complete and return any errors
        /// that occurred during the writing process.
        pub fn finish(mut self) -> Result<(), GifEncodingError> {
            if self.finished {
                return Ok(());
            }

            // Drop the collector to signal that we're done adding frames
            drop(self.collector.take());

            // Wait for the writer thread to complete
            if let Some(writer_thread) = self.writer_thread.take() {
                match writer_thread.join() {
                    Ok(result) => result?,
                    Err(_) => {
                        return Err(GifEncodingError::Gifski(
                            "Writer thread panicked".to_string(),
                        ));
                    }
                }
            }

            self.finished = true;
            Ok(())
        }

        /// Get the current frame count
        pub fn frame_count(&self) -> u32 {
            self.frame_index
        }

        /// Get the dimensions of the GIF
        pub fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }

        /// Get the target FPS
        pub fn fps(&self) -> u32 {
            self.fps
        }
    }

    impl Drop for GifEncoderWrapper {
        fn drop(&mut self) {
            if !self.finished && self.collector.is_some() {
                // Drop the collector to signal completion
                drop(self.collector.take());

                // Try to join the writer thread
                if let Some(thread) = self.writer_thread.take() {
                    let _ = thread.join();
                }

                self.finished = true;
            }
        }
    }
}
