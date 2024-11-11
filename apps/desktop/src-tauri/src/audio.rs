use std::io::Cursor;
use std::sync::mpsc;
use std::thread;

// Channel sender for audio control commands
lazy_static::lazy_static! {
    static ref AUDIO_CONTROL: std::sync::Mutex<Option<mpsc::Sender<AudioCommand>>> = std::sync::Mutex::new(None);
}

#[derive(Clone)]
pub(crate) enum AudioCommand {
    PlaySound(Vec<u8>),
}

// Private function to get or initialize audio control
fn get_or_init_audio_control() -> mpsc::Sender<AudioCommand> {
    let mut control = AUDIO_CONTROL.lock().unwrap();
    if control.is_none() {
        println!("Initializing audio system...");
        *control = Some(start_audio_thread());
    }
    control.as_ref().unwrap().clone()
}

fn start_audio_thread() -> mpsc::Sender<AudioCommand> {
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        use rodio::{OutputStream, Sink};

        println!("Audio thread started");
        match OutputStream::try_default() {
            Ok((stream, stream_handle)) => {
                println!("Successfully created audio output stream");
                let mut current_startup_sink: Option<Sink> = None;

                while let Ok(command) = rx.recv() {
                    match command {
                        AudioCommand::PlaySound(bytes) => {
                            if let Ok(sink) = Sink::try_new(&stream_handle) {
                                let file = Cursor::new(bytes);
                                if let Ok(source) = rodio::Decoder::new(file) {
                                    sink.append(source);
                                    sink.sleep_until_end();
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("Failed to create audio output stream: {}", e);
            }
        }
        println!("Audio thread terminated");
    });

    tx
}

pub enum AppSounds {
    StartRecording,
    StopRecording,
    Screenshot,
    Notification,
}

impl AppSounds {
    pub fn play(&self) {
        let bytes = self.get_sound_bytes().to_vec();
        let control = get_or_init_audio_control();
        let _ = control.send(AudioCommand::PlaySound(bytes));
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
