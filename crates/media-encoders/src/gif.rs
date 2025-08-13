use std::path::Path;
use std::thread::{self, JoinHandle};
use std::fs::File;
use thiserror::Error;
use gifski::{Collector, Settings, Repeat};
use rgb::RGBA8;

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
    /// Create a new GIF encoder with default quality settings
    ///
    /// # Arguments
    /// * `path` - Output path for the GIF file
    /// * `width` - Width of the GIF in pixels
    /// * `height` - Height of the GIF in pixels
    /// * `fps` - Frames per second for the animation
    pub fn new<P: AsRef<Path>>(
        path: P,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<Self, GifEncodingError> {
        Self::new_with_quality(path, width, height, fps, GifQuality::default())
    }

    /// Create a new GIF encoder with custom quality settings
    ///
    /// # Arguments
    /// * `path` - Output path for the GIF file
    /// * `width` - Width of the GIF in pixels
    /// * `height` - Height of the GIF in pixels
    /// * `fps` - Frames per second for the animation
    /// * `quality` - Quality settings for encoding
    pub fn new_with_quality<P: AsRef<Path>>(
        path: P,
        width: u32,
        height: u32,
        fps: u32,
        quality: GifQuality,
    ) -> Result<Self, GifEncodingError> {
        let settings = Settings {
            width: Some(width),
            height: Some(height),
            quality: quality.quality,
            fast: quality.fast,
            repeat: Repeat::Infinite,
        };

        let (collector, writer) = gifski::new(settings)
            .map_err(|e| GifEncodingError::Gifski(e.to_string()))?;

        // Start the writer thread
        let output_path = path.as_ref().to_path_buf();
        let writer_thread = thread::spawn(move || {
            let file = File::create(output_path)
                .map_err(|e| GifEncodingError::Io(e))?;
            writer.write(file, &mut gifski::progress::NoProgress {})
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
    ///
    /// # Arguments
    /// * `frame_data` - RGBA frame data (4 bytes per pixel)
    /// * `bytes_per_row` - Number of bytes per row in the frame data
    pub fn add_frame(
        &mut self,
        frame_data: &[u8],
        bytes_per_row: usize,
    ) -> Result<(), GifEncodingError> {
        if self.finished {
            return Err(GifEncodingError::EncoderFinished);
        }

        let collector = self.collector.as_mut()
            .ok_or(GifEncodingError::EncoderFinished)?;

        // Calculate expected size
        let expected_bytes_per_row = (self.width as usize) * 4; // RGBA
        let expected_total_bytes = expected_bytes_per_row * (self.height as usize);

        // Validate frame data size
        if frame_data.len() < expected_total_bytes {
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
        let img = imgref::Img::new(
            rgba_pixels,
            self.width as usize,
            self.height as usize,
        );

        // Calculate presentation timestamp based on frame index and fps
        let pts = (self.frame_index as f64) / (self.fps as f64);

        // Add frame to collector
        collector.add_frame_rgba(self.frame_index as usize, img, pts)
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
                Err(_) => return Err(GifEncodingError::Gifski("Writer thread panicked".to_string())),
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

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::tempdir;

    #[test]
    fn test_gif_encoder_creation() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        let encoder = GifEncoderWrapper::new(&gif_path, 100, 100, 10);
        assert!(encoder.is_ok());
    }

    #[test]
    fn test_gif_encoder_with_quality() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        let quality = GifQuality {
            quality: 100,
            fast: true,
        };

        let encoder = GifEncoderWrapper::new_with_quality(&gif_path, 100, 100, 10, quality);
        assert!(encoder.is_ok());
    }

    #[test]
    fn test_gif_encoder_with_frames() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        let mut encoder = GifEncoderWrapper::new(&gif_path, 100, 100, 10).unwrap();

        // Create a simple red frame (RGBA)
        let mut frame_data = Vec::new();
        for _ in 0..100 * 100 {
            frame_data.extend_from_slice(&[255u8, 0, 0, 255]);
        }
        let bytes_per_row = 100 * 4;

        let result = encoder.add_frame(&frame_data, bytes_per_row);
        assert!(result.is_ok());

        let finish_result = encoder.finish();
        assert!(finish_result.is_ok());
    }

    #[test]
    fn test_invalid_frame_data() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        let mut encoder = GifEncoderWrapper::new(&gif_path, 100, 100, 10).unwrap();

        // Create frame data that's too small
        let frame_data = vec![255u8; 100]; // Way too small
        let bytes_per_row = 100 * 4;

        let result = encoder.add_frame(&frame_data, bytes_per_row);
        assert!(matches!(result, Err(GifEncodingError::InvalidFrameData)));
    }

    #[test]
    fn test_multiple_frames() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        let mut encoder = GifEncoderWrapper::new(&gif_path, 50, 50, 10).unwrap();

        // Add multiple frames with different colors
        for i in 0..5 {
            let mut frame_data = Vec::with_capacity(50 * 50 * 4);
            for _ in 0..50 * 50 {
                frame_data.extend_from_slice(&[(i * 50) as u8, 128, (255 - i * 50) as u8, 255]);
            }

            let result = encoder.add_frame(&frame_data, 50 * 4);
            assert!(result.is_ok());
        }

        let finish_result = encoder.finish();
        assert!(finish_result.is_ok());
    }

    #[test]
    fn test_encoder_finished_state() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        let mut encoder = GifEncoderWrapper::new(&gif_path, 10, 10, 10).unwrap();

        // Add a frame
        let mut frame_data = Vec::new();
        for _ in 0..10 * 10 {
            frame_data.extend_from_slice(&[255u8, 0, 0, 255]);
        }
        encoder.add_frame(&frame_data, 10 * 4).unwrap();

        // Test that we can successfully finish the encoder
        let finish_result = encoder.finish();
        assert!(finish_result.is_ok());

        // Note: After finish() is called, the encoder is consumed, so we can't test
        // adding frames to the same instance. This is by design to prevent misuse.
    }

    #[test]
    fn test_edge_case_dimensions() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        // Test with minimum practical dimensions
        let encoder = GifEncoderWrapper::new(&gif_path, 1, 1, 1);
        assert!(encoder.is_ok());

        // Test with larger dimensions
        let gif_path2 = temp_dir.path().join("test2.gif");
        let encoder2 = GifEncoderWrapper::new(&gif_path2, 1920, 1080, 30);
        assert!(encoder2.is_ok());
    }

    #[test]
    fn test_encoder_properties() {
        let temp_dir = tempdir().unwrap();
        let gif_path = temp_dir.path().join("test.gif");

        let encoder = GifEncoderWrapper::new(&gif_path, 200, 150, 25).unwrap();

        assert_eq!(encoder.dimensions(), (200, 150));
        assert_eq!(encoder.fps(), 25);
        assert_eq!(encoder.frame_count(), 0);
    }
}
