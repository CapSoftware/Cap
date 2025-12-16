use ffmpeg::{format, frame, software};

pub struct FrameConverter {
    scaler: Option<ScalerState>,
    rgba_frame: frame::Video,
}

struct ScalerState {
    context: software::scaling::Context,
    input_format: format::Pixel,
    width: u32,
    height: u32,
}

impl FrameConverter {
    pub fn new() -> Self {
        Self {
            scaler: None,
            rgba_frame: frame::Video::empty(),
        }
    }

    pub fn convert(&mut self, frame: &mut frame::Video) -> Vec<u8> {
        if frame.format() == format::Pixel::RGBA {
            let width = frame.width() as usize;
            let height = frame.height() as usize;
            let stride = frame.stride(0);

            return copy_rgba_plane(frame.data(0), stride, width, height);
        }

        let width = frame.width();
        let height = frame.height();

        self.ensure_scaler(frame.format(), width, height);
        self.ensure_rgba_frame(width, height);

        {
            let rgba_frame = &mut self.rgba_frame;
            self.scaler
                .as_mut()
                .expect("scaler must be initialised")
                .context
                .run(frame, rgba_frame)
                .expect("frame conversion should succeed");
        }

        let rgba_frame = &self.rgba_frame;
        copy_rgba_plane(
            rgba_frame.data(0),
            rgba_frame.stride(0),
            rgba_frame.width() as usize,
            rgba_frame.height() as usize,
        )
    }

    fn ensure_scaler(&mut self, input_format: format::Pixel, width: u32, height: u32) {
        let needs_new = self.scaler.as_ref().is_none_or(|state| {
            state.input_format != input_format || state.width != width || state.height != height
        });

        if needs_new {
            self.scaler = Some(ScalerState {
                context: software::converter((width, height), input_format, format::Pixel::RGBA)
                    .expect("failed to create frame scaler"),
                input_format,
                width,
                height,
            });
            self.ensure_rgba_frame(width, height);
        }
    }

    fn ensure_rgba_frame(&mut self, width: u32, height: u32) {
        if self.rgba_frame.width() != width || self.rgba_frame.height() != height {
            self.rgba_frame = frame::Video::new(format::Pixel::RGBA, width, height);
        }
    }
}

pub fn copy_rgba_plane(data: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
    debug_assert!(stride >= width * 4, "stride too small for RGBA frame");

    let row_len = width * 4;
    let mut frame_buffer = Vec::with_capacity(row_len * height);

    for row in data.chunks(stride).take(height) {
        frame_buffer.extend_from_slice(&row[..row_len]);
    }

    frame_buffer
}

#[cfg(target_os = "macos")]
pub fn copy_bgra_to_rgba(data: &[u8], stride: usize, width: usize, height: usize) -> Vec<u8> {
    debug_assert!(stride >= width * 4, "stride too small for BGRA frame");

    let row_len = width * 4;
    let mut frame_buffer = Vec::with_capacity(row_len * height);

    for row in data.chunks(stride).take(height) {
        for pixel in row[..row_len].chunks_exact(4) {
            frame_buffer.push(pixel[2]);
            frame_buffer.push(pixel[1]);
            frame_buffer.push(pixel[0]);
            frame_buffer.push(pixel[3]);
        }
    }

    frame_buffer
}
