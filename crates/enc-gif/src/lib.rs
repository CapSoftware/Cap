use gifski::{Collector, Repeat, Settings};
use rgb::RGBA8;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::thread::{self, JoinHandle};
use thiserror::Error;

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
            write_gif(writer, BufWriter::new(file))
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

    pub fn add_frame(
        &mut self,
        frame_data: &[u8],
        bytes_per_row: usize,
    ) -> Result<(), GifEncodingError> {
        if self.finished {
            return Err(GifEncodingError::EncoderFinished);
        }

        self.validate_frame(frame_data.len(), bytes_per_row)?;

        let w = self.width as usize;
        let h = self.height as usize;
        let expected_bytes_per_row = w * 4;

        let img = if bytes_per_row == expected_bytes_per_row {
            let pixel_count = w * h;
            let byte_slice = &frame_data[..pixel_count * 4];
            let pixels: &[RGBA8] = unsafe {
                std::slice::from_raw_parts(byte_slice.as_ptr().cast::<RGBA8>(), pixel_count)
            };
            imgref::Img::new(pixels.to_vec(), w, h)
        } else {
            let mut rgba_pixels = Vec::with_capacity(w * h);
            for y in 0..h {
                let row_start = y * bytes_per_row;
                let row_bytes = &frame_data[row_start..row_start + expected_bytes_per_row];
                let row_pixels: &[RGBA8] =
                    unsafe { std::slice::from_raw_parts(row_bytes.as_ptr().cast::<RGBA8>(), w) };
                rgba_pixels.extend_from_slice(row_pixels);
            }
            imgref::Img::new(rgba_pixels, w, h)
        };

        self.submit_frame(img)
    }

    pub fn add_frame_owned(
        &mut self,
        frame_data: Vec<u8>,
        bytes_per_row: usize,
    ) -> Result<(), GifEncodingError> {
        if self.finished {
            return Err(GifEncodingError::EncoderFinished);
        }

        self.validate_frame(frame_data.len(), bytes_per_row)?;

        if bytes_per_row % 4 != 0 || frame_data.len() % 4 != 0 || frame_data.capacity() % 4 != 0 {
            return self.add_frame(&frame_data, bytes_per_row);
        }

        let w = self.width as usize;
        let h = self.height as usize;

        let mut frame_data = frame_data;
        let (ptr, len, capacity) = (
            frame_data.as_mut_ptr(),
            frame_data.len(),
            frame_data.capacity(),
        );
        std::mem::forget(frame_data);
        // SAFETY: RGBA8 is #[repr(C)] with size 4 and alignment 1, the checks
        // above guarantee the byte length and capacity are multiples of 4, and
        // validate_frame guarantees the buffer covers every row at this stride.
        let pixels = unsafe { Vec::from_raw_parts(ptr.cast::<RGBA8>(), len / 4, capacity / 4) };

        self.submit_frame(imgref::Img::new_stride(pixels, w, h, bytes_per_row / 4))
    }

    fn validate_frame(
        &self,
        frame_len: usize,
        bytes_per_row: usize,
    ) -> Result<(), GifEncodingError> {
        let w = self.width as usize;
        let h = self.height as usize;
        let expected_bytes_per_row = w * 4;

        if bytes_per_row < expected_bytes_per_row
            || frame_len < bytes_per_row * h.saturating_sub(1) + expected_bytes_per_row
        {
            return Err(GifEncodingError::InvalidFrameData);
        }

        Ok(())
    }

    fn submit_frame(&mut self, img: imgref::ImgVec<RGBA8>) -> Result<(), GifEncodingError> {
        let collector = self
            .collector
            .as_mut()
            .ok_or(GifEncodingError::EncoderFinished)?;

        let pts = (self.frame_index as f64) / (self.fps as f64);

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

fn write_gif(
    writer: gifski::Writer,
    output: BufWriter<impl Write>,
) -> Result<(), GifEncodingError> {
    struct CheckedBuffer<W: Write> {
        buffered: BufWriter<W>,
        error: Option<std::io::Error>,
    }

    impl<W: Write> Write for CheckedBuffer<W> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            match self.buffered.write(bytes) {
                Err(error)
                    if error.kind() != std::io::ErrorKind::Interrupted && self.error.is_none() =>
                {
                    self.error = Some(match error.raw_os_error() {
                        Some(code) => std::io::Error::from_raw_os_error(code),
                        None => std::io::Error::new(error.kind(), error.to_string()),
                    });
                    Err(error)
                }
                result => result,
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.buffered.flush()
        }
    }

    let mut output = CheckedBuffer {
        buffered: output,
        error: None,
    };
    writer
        .write(&mut output, &mut gifski::progress::NoProgress {})
        .map_err(|e| GifEncodingError::Gifski(e.to_string()))?;
    // gif writes its trailer in Drop and can discard a buffer-drain error there.
    if let Some(error) = output.error {
        return Err(GifEncodingError::Io(error));
    }
    output.flush().map_err(GifEncodingError::Io)
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
    use std::io;

    fn single_frame_writer() -> gifski::Writer {
        let (collector, writer) = gifski::new(Settings {
            width: Some(2),
            height: Some(2),
            ..Settings::default()
        })
        .unwrap();
        collector
            .add_frame_rgba(
                0,
                imgref::Img::new(vec![RGBA8::new(255, 0, 0, 255); 4], 2, 2),
                0.0,
            )
            .unwrap();
        drop(collector);
        writer
    }

    #[test]
    fn buffered_output_matches_unbuffered_gif() {
        let mut expected = Vec::new();
        single_frame_writer()
            .write(&mut expected, &mut gifski::progress::NoProgress {})
            .unwrap();
        assert!(expected.len() < BufWriter::new(Vec::<u8>::new()).capacity());
        assert_eq!(expected.last(), Some(&0x3b));

        let mut actual = Vec::new();
        write_gif(single_frame_writer(), BufWriter::new(&mut actual)).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn buffered_tail_write_error_is_returned() {
        struct FailingOutput;

        impl Write for FailingOutput {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::other("output full"))
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let error = write_gif(single_frame_writer(), BufWriter::new(FailingOutput)).unwrap_err();
        assert!(matches!(error, GifEncodingError::Io(error) if error.to_string() == "output full"));
    }

    fn buffer_boundary_writer() -> gifski::Writer {
        let (collector, writer) = gifski::new(Settings {
            width: Some(100),
            height: Some(77),
            quality: 90,
            fast: false,
            ..Settings::default()
        })
        .unwrap();
        let mut hash = 161u32;
        let pixels = (0..100 * 77)
            .map(|_| {
                hash ^= hash << 13;
                hash ^= hash >> 17;
                hash ^= hash << 5;
                let value = hash % 64;
                RGBA8::new(
                    ((value & 3) * 85) as u8,
                    (((value >> 2) & 3) * 85) as u8,
                    (((value >> 4) & 3) * 85) as u8,
                    255,
                )
            })
            .collect();
        collector
            .add_frame_rgba(0, imgref::Img::new(pixels, 100, 77), 0.0)
            .unwrap();
        drop(collector);
        writer
    }

    fn buffer_boundary_gif() -> Vec<u8> {
        let mut expected = Vec::new();
        buffer_boundary_writer()
            .write(&mut expected, &mut gifski::progress::NoProgress {})
            .unwrap();
        assert_eq!(expected.last(), Some(&0x3b));
        expected
    }

    struct RecoveringOutput {
        bytes: Vec<u8>,
        first_error: Option<io::ErrorKind>,
        max_write: usize,
    }

    impl Write for RecoveringOutput {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if let Some(kind) = self.first_error.take() {
                return if kind == io::ErrorKind::WriteZero {
                    Ok(0)
                } else {
                    Err(io::Error::new(kind, "injected write failure"))
                };
            }
            let count = bytes.len().min(self.max_write);
            self.bytes.extend_from_slice(&bytes[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn assert_trailer_buffer_error(kind: io::ErrorKind) {
        let expected = buffer_boundary_gif();
        let mut output = RecoveringOutput {
            bytes: Vec::new(),
            first_error: Some(kind),
            max_write: usize::MAX,
        };
        let result = write_gif(
            buffer_boundary_writer(),
            BufWriter::with_capacity(expected.len() - 1, &mut output),
        );
        assert!(output.first_error.is_none());
        assert_ne!(output.bytes, expected);
        assert!(matches!(result, Err(GifEncodingError::Io(error)) if error.kind() == kind));
    }

    #[test]
    fn trailer_buffer_write_error_is_returned_after_sink_recovers() {
        assert_trailer_buffer_error(io::ErrorKind::Other);
    }

    #[test]
    fn trailer_buffer_write_zero_is_returned_after_sink_recovers() {
        assert_trailer_buffer_error(io::ErrorKind::WriteZero);
    }

    #[test]
    fn interrupted_and_short_writes_preserve_complete_gif() {
        let expected = buffer_boundary_gif();
        let mut output = RecoveringOutput {
            bytes: Vec::new(),
            first_error: Some(io::ErrorKind::Interrupted),
            max_write: 7,
        };
        write_gif(
            buffer_boundary_writer(),
            BufWriter::with_capacity(expected.len() - 1, &mut output),
        )
        .unwrap();
        assert!(output.first_error.is_none());
        assert_eq!(output.bytes, expected);
    }

    fn patterned_frame(width: usize, height: usize, bytes_per_row: usize) -> Vec<u8> {
        let mut frame = vec![0xEE; bytes_per_row * height];
        let mut hash = 7919u32;
        for y in 0..height {
            for x in 0..width {
                hash ^= hash << 13;
                hash ^= hash >> 17;
                hash ^= hash << 5;
                let value = hash % 64;
                let start = y * bytes_per_row + x * 4;
                frame[start] = ((value & 3) * 85) as u8;
                frame[start + 1] = (((value >> 2) & 3) * 85) as u8;
                frame[start + 2] = (((value >> 4) & 3) * 85) as u8;
                frame[start + 3] = 255;
            }
        }
        frame
    }

    fn encode_via_wrapper(owned: bool, bytes_per_row: usize) -> Vec<u8> {
        let (width, height) = (100usize, 77usize);
        let path = std::env::temp_dir().join(format!(
            "cap-enc-gif-test-{}-{owned}-{bytes_per_row}.gif",
            std::process::id()
        ));
        let mut encoder = GifEncoderWrapper::new(&path, width as u32, height as u32, 30).unwrap();
        for _ in 0..3 {
            let frame = patterned_frame(width, height, bytes_per_row);
            if owned {
                encoder.add_frame_owned(frame, bytes_per_row).unwrap();
            } else {
                encoder.add_frame(&frame, bytes_per_row).unwrap();
            }
        }
        encoder.finish().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        bytes
    }

    #[test]
    fn owned_frames_match_slice_frames_for_padded_rows() {
        let bytes_per_row = (100 * 4usize).next_multiple_of(256);
        assert_eq!(
            encode_via_wrapper(true, bytes_per_row),
            encode_via_wrapper(false, bytes_per_row)
        );
    }

    #[test]
    fn owned_frames_match_slice_frames_for_tight_rows() {
        assert_eq!(
            encode_via_wrapper(true, 100 * 4),
            encode_via_wrapper(false, 100 * 4)
        );
    }

    #[test]
    fn owned_frames_match_slice_frames_for_unaligned_stride() {
        let bytes_per_row = 100 * 4 + 2;
        assert_eq!(
            encode_via_wrapper(true, bytes_per_row),
            encode_via_wrapper(false, bytes_per_row)
        );
    }
}
