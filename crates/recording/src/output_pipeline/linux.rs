use super::VideoFrame;
use cap_timestamp::Timestamp;

#[derive(Clone)]
pub struct NativeCameraFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub timestamp: Timestamp,
}

unsafe impl Send for NativeCameraFrame {}
unsafe impl Sync for NativeCameraFrame {}

impl VideoFrame for NativeCameraFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}
