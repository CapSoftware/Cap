use cap_recording::CameraFeed;
use cap_utils::Url;
use std::collections::HashMap;

pub struct DeeplinkHandler {
    pub deeplinks: HashMap<String, Deeplink>,
}

impl DeeplinkHandler {
    pub fn new() -> Self {
        Self {
            deeplinks: HashMap::new(),
        }
    }

    pub fn register_deeplink(&mut self, name: String, deeplink: Deeplink) {
        self.deeplinks.insert(name, deeplink);
    }

    pub fn handle_deeplink(&self, name: String) -> Option<&Deeplink> {
        self.deeplinks.get(&name)
    }
}