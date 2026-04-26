use cap_recording::CameraFeed;
use cap_utils::Url;
use std::collections::HashMap;

pub fn main() {
    let mut deeplink_handler = DeeplinkHandler::new();

    let recording_start_deeplink = Deeplink::new(Url::parse("https://example.com/recording/start").unwrap());
    let recording_stop_deeplink = Deeplink::new(Url::parse("https://example.com/recording/stop").unwrap());
    let recording_pause_deeplink = Deeplink::new(Url::parse("https://example.com/recording/pause").unwrap());
    let recording_resume_deeplink = Deeplink::new(Url::parse("https://example.com/recording/resume").unwrap());
    let camera_switch_deeplink = Deeplink::new(Url::parse("https://example.com/camera/switch").unwrap());
    let microphone_switch_deeplink = Deeplink::new(Url::parse("https://example.com/microphone/switch").unwrap());

    deeplink_handler.register_deeplink("recording_start".to_string(), recording_start_deeplink);
    deeplink_handler.register_deeplink("recording_stop".to_string(), recording_stop_deeplink);
    deeplink_handler.register_deeplink("recording_pause".to_string(), recording_pause_deeplink);
    deeplink_handler.register_deeplink("recording_resume".to_string(), recording_resume_deeplink);
    deeplink_handler.register_deeplink("camera_switch".to_string(), camera_switch_deeplink);
    deeplink_handler.register_deeplink("microphone_switch".to_string(), microphone_switch_deeplink);

    let camera_feed = CameraFeed::new();
    let deeplink = deeplink_handler.handle_deeplink("recording_start".to_string()).unwrap();
    println!("{}", deeplink.recording_start());
}