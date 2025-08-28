use ffmpeg::format::Pixel;
use scap_direct3d::PixelFormat;

pub type AsFFmpegError = windows::core::Error;

impl<'a> super::AsFFmpeg for scap_direct3d::Frame<'a> {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError> {
        let buffer = self.as_buffer()?;

        let width = self.width() as usize;
        let height = self.height() as usize;

        let src_bytes = buffer.data();
        let src_stride = buffer.stride() as usize;

        match self.pixel_format() {
            PixelFormat::R8G8B8A8Unorm => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::RGBA,
                    self.width(),
                    self.height(),
                );

                let dest_stride = ff_frame.stride(0);
                let dest_bytes = ff_frame.data_mut(0);

                let row_length = width * 4;

                for i in 0..height {
                    let src_row = &src_bytes[i * src_stride..i * src_stride + row_length];
                    let dest_row = &mut dest_bytes[i * dest_stride..i * dest_stride + row_length];

                    dest_row.copy_from_slice(src_row);
                }

                Ok(ff_frame)
            }
            PixelFormat::B8G8R8A8Unorm => {
                let mut ff_frame = ffmpeg::frame::Video::new(
                    ffmpeg::format::Pixel::BGRA,
                    self.width(),
                    self.height(),
                );

                let dest_stride = ff_frame.stride(0);
                let dest_bytes = ff_frame.data_mut(0);

                let row_length = width * 4;

                for i in 0..height {
                    let src_row = &src_bytes[i * src_stride..i * src_stride + row_length];
                    let dest_row = &mut dest_bytes[i * dest_stride..i * dest_stride + row_length];

                    dest_row.copy_from_slice(src_row);
                }

                Ok(ff_frame)
            }
        }
    }
}

pub trait PixelFormatExt {
    fn as_ffmpeg(&self) -> Pixel;
}

impl PixelFormatExt for PixelFormat {
    fn as_ffmpeg(&self) -> Pixel {
        match self {
            PixelFormat::R8G8B8A8Unorm => Pixel::RGBA,
            PixelFormat::B8G8R8A8Unorm => Pixel::BGRA,
        }
    }
}
