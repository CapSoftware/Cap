fn play_audio(bytes: &'static [u8]) {
    use rodio::{Decoder, OutputStream, Sink};
    use std::io::Cursor;

    std::thread::spawn(move || {
        if let Ok((_, stream)) = OutputStream::try_default() {
            let file = Cursor::new(bytes);
            let source = Decoder::new(file).unwrap();
            let sink = Sink::try_new(&stream).unwrap();
            sink.append(source);
            sink.sleep_until_end();
        }
    });
}

pub enum AppSounds {
    StartRecording,
    StopRecording,
    Screenshot,
    Notification,
}

impl AppSounds {
    pub fn play(&self) {
        let bytes = self.get_sound_bytes();
        play_audio(bytes);
    }

    fn get_sound_bytes(&self) -> &'static [u8] {
        match self {
            AppSounds::StartRecording => include_bytes!("../sounds/start-recording.ogg"),
            AppSounds::StopRecording => include_bytes!("../sounds/stop-recording.ogg"),
            AppSounds::Screenshot => include_bytes!("../sounds/screenshot.ogg"),
            AppSounds::Notification => include_bytes!("../sounds/action.ogg"),
        }
    }
}
