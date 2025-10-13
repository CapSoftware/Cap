use cap_recording::*;

pub enum Input {
    Microphone(String),
    Camera(String),
}

pub struct RecordingConfig {
    inputs: HashMap<String, Input>,
}

fn main() {}
