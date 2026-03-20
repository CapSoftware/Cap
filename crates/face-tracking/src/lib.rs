#[derive(Clone, Debug, Default)]
pub struct FacePose {
    pub head_pitch: f32,
    pub head_yaw: f32,
    pub head_roll: f32,
    pub mouth_open: f32,
    pub left_eye_open: f32,
    pub right_eye_open: f32,
    pub confidence: f32,
}

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::FaceTracker;

#[cfg(not(target_os = "macos"))]
pub struct FaceTracker;

#[cfg(not(target_os = "macos"))]
impl FaceTracker {
    pub fn new() -> Self {
        Self
    }

    pub fn track(&mut self, _rgba_data: &[u8], _width: u32, _height: u32) -> FacePose {
        FacePose::default()
    }
}
