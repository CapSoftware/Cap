use cap_recording::CameraFeed;
use cap_utils::Url;
use std::collections::HashMap;

pub fn main() {
    let camera = Camera::new();
    camera.start_recording();
    camera.stop_recording();
    camera.pause_recording();
    camera.resume_recording();
    camera.switch_camera();
    camera.switch_microphone();
}