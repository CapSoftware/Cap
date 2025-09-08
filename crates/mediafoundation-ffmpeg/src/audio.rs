use windows::Win32::Media::MediaFoundation::{IMFSample, MFCreateMemoryBuffer, MFCreateSample};

pub trait AudioExt {
    fn to_sample(&self) -> windows::core::Result<IMFSample>;
}

impl AudioExt for ffmpeg::frame::Audio {
    fn to_sample(&self) -> windows::core::Result<IMFSample> {
        let sample = unsafe { MFCreateSample()? };

        let length = (self.samples() * self.format().bytes())
            * (if self.is_planar() {
                self.channels() as usize
            } else {
                1
            });
        let buffer = unsafe { MFCreateMemoryBuffer(length as u32)? };

        unsafe { sample.AddBuffer(&buffer)? };

        let mut buffer_ptr: *mut u8 = std::ptr::null_mut();
        unsafe { buffer.Lock(&mut buffer_ptr, None, None)? };

        unsafe {
            std::ptr::copy_nonoverlapping(self.data(0).as_ptr(), buffer_ptr, length as usize);
        }

        unsafe { buffer.SetCurrentLength(length as u32)? }

        unsafe { buffer.Unlock()? };

        if let Some(pts) = self.pts() {
            unsafe {
                sample.SetSampleTime((pts as f64 / self.rate() as f64 * 10_000_000_f64) as i64)?
            };
        }

        unsafe {
            sample.SetSampleDuration(
                ((self.samples() as f64 / self.rate() as f64) * 10_000_000_f64) as i64,
            )?
        };

        Ok(sample)
    }
}
