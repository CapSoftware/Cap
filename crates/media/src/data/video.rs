pub struct FFVideo(ffmpeg::frame::Video);

impl FFVideo {
    pub fn new(format: ffmpeg::format::Pixel, width: u32, height: u32) -> Self {
        Self(ffmpeg::frame::Video::new(format, width, height))
    }

    pub fn data(&self, index: usize) -> &[u8] {
        self.0.data(index)
    }

    pub fn data_mut(&mut self, index: usize) -> &mut [u8] {
        self.0.data_mut(index)
    }

    pub fn stride(&self, index: usize) -> usize {
        self.0.stride(index)
    }

    pub fn as_mut_ptr(&mut self) -> *mut ffmpeg_sys_next::AVFrame {
        self.0.as_mut_ptr()
    }

    pub fn as_ptr(&self) -> *const ffmpeg_sys_next::AVFrame {
        self.0.as_ptr()
    }

    pub fn convert_with(
        &mut self,
        context: &mut ffmpeg::software::scaling::Context,
        output: &mut FFVideo,
    ) -> Result<(), ffmpeg::Error> {
        unsafe { context.run(&self.0, &mut output.0) }
    }
}
