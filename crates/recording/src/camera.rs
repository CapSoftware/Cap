use cap_recording::CameraFeed;
use cap_utils::Url;
use std::collections::HashMap;

pub struct Camera {
    pub feed: CameraFeed,
    pub deeplink_handler: DeeplinkHandler,
}

impl Camera {
    pub fn new() -> Self {
        Self {
            feed: CameraFeed::new(),
            deeplink_handler: DeeplinkHandler::new(),
        }
    }

    pub fn start_recording(&self) {
        let deeplink = self.deeplink_handler.handle_deeplink("recording_start".to_string()).unwrap();
        println!("{}", deeplink.recording_start());
    }

    pub fn stop_recording(&self) {
        let deeplink = self.deeplink_handler.handle_deeplink("recording_stop".to_string()).unwrap();
        println!("{}", deeplink.recording_stop());
    }

    pub fn pause_recording(&self) {
        let deeplink = self.deeplink_handler.handle_deeplink("recording_pause".to_string()).unwrap();
        println!("{}", deeplink.recording_pause());
    }

    pub fn resume_recording(&self) {
        let deeplink = self.deeplink_handler.handle_deeplink("recording_resume".to_string()).unwrap();
        println!("{}", deeplink.recording_resume());
    }

    pub fn switch_camera(&self) {
        let deeplink = self.deeplink_handler.handle_deeplink("camera_switch".to_string()).unwrap();
        println!("{}", deeplink.camera_switch());
    }

    pub fn switch_microphone(&self) {
        let deeplink = self.deeplink_handler.handle_deeplink("microphone_switch".to_string()).unwrap();
        println!("{}", deeplink.microphone_switch());
    }
}