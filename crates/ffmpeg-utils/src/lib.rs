pub trait PlanarData {
    fn plane_data(&self, index: usize) -> &[u8];
    fn plane_data_mut(&mut self, index: usize) -> &mut [u8];
}

impl PlanarData for ffmpeg::frame::Audio {
    #[inline]
    fn plane_data(&self, index: usize) -> &[u8] {
        if index >= self.planes() {
            panic!("out of bounds");
        }

        unsafe {
            std::slice::from_raw_parts(
                (*self.as_ptr()).data[index],
                (*self.as_ptr()).linesize[0] as usize,
            )
        }
    }

    #[inline]
    fn plane_data_mut(&mut self, index: usize) -> &mut [u8] {
        if index >= self.planes() {
            panic!("out of bounds");
        }

        unsafe {
            std::slice::from_raw_parts_mut(
                (*self.as_mut_ptr()).data[index],
                (*self.as_ptr()).linesize[0] as usize,
            )
        }
    }
}
