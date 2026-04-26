// File: crates/recording/src/deeplink.rs
use cap_utils::Url;
use std::collections::HashMap;

pub struct Deeplink {
    pub url: Url,
}

impl Deeplink {
    pub fn new(url: Url) -> Self {
        Self { url }
    }

    pub fn recording_start(&self) -> Url {
        self.url.join("recording/start").unwrap()
    }

    pub fn recording_stop(&self) -> Url {
        self.url.join("recording/stop").unwrap()
    }

    pub fn recording_pause(&self) -> Url {
        self.url.join("recording/pause").unwrap()
    }

    pub fn recording_resume(&self) -> Url {
        self.url.join("recording/resume").unwrap()
    }

    pub fn camera_switch(&self) -> Url {
        self.url.join("camera/switch").unwrap()
    }

    pub fn microphone_switch(&self) -> Url {
        self.url.join("microphone/switch").unwrap()
    }
}