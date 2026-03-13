use cap_camera::CapturedFrame;

#[derive(Debug)]
pub enum AsFFmpegError {
    InvalidData,
}

impl super::CapturedFrameExt for CapturedFrame {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let native = self.native();
        let width = native.width;
        let height = native.height;

        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGB24, width, height);

        let data = &native.data;
        let dst = frame.data_mut(0);
        let copy_len = dst.len().min(data.len());
        dst[..copy_len].copy_from_slice(&data[..copy_len]);

        Ok(frame)
    }
}
