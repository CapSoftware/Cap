#[derive(Debug)]
pub struct VideoFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub pixel_format: ffmpeg::format::Pixel,
}

#[derive(Debug)]
pub enum AsFFmpegError {
    InvalidData,
    EmptyFrame,
}

impl super::AsFFmpeg for VideoFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        if self.data.is_empty() {
            return Err(AsFFmpegError::EmptyFrame);
        }

        let mut frame = ffmpeg::frame::Video::new(
            self.pixel_format,
            self.width,
            self.height,
        );

        let dst = frame.data_mut(0);
        let copy_len = dst.len().min(self.data.len());
        dst[..copy_len].copy_from_slice(&self.data[..copy_len]);

        Ok(frame)
    }
}
