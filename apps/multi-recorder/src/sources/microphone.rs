use std::sync::Arc;
use cap_recording::{
    feeds::microphone::MicrophoneFeedLock,
    sources::microphone::Microphone as RecordingMicrophone,
};

pub type Microphone = RecordingMicrophone;
pub type MicrophoneFeed = Arc<MicrophoneFeedLock>;
