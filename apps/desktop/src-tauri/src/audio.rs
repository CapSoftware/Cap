use std::io::Cursor;
use std::sync::mpsc;
use std::thread;

// Channel sender for audio control commands
lazy_static::lazy_static! {
    static ref AUDIO_CONTROL: std::sync::Mutex<Option<mpsc::Sender<AudioCommand>>> = std::sync::Mutex::new(None);
}

#[derive(Clone)]
pub(crate) enum AudioCommand {
    PlayStartup,
    StopStartup,
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

pub fn play_startup_music() {
    println!("Attempting to play startup music...");
    let control = get_or_init_audio_control();

    let control_clone = control.clone();
    std::thread::spawn(move || {
        println!("Sending PlayStartup command...");
        if let Err(e) = control_clone.send(AudioCommand::PlayStartup) {
            eprintln!("Failed to send PlayStartup command: {}", e);
        }
    });
}

pub fn stop_startup_music() {
    println!("Stopping startup music...");
    let control = get_or_init_audio_control();

    let control_clone = control.clone();
    std::thread::spawn(move || {
        println!("Sending StopStartup command...");
        if let Err(e) = control_clone.send(AudioCommand::StopStartup) {
            eprintln!("Failed to send StopStartup command: {}", e);
        }
    });
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
                        AudioCommand::PlayStartup => {
                            println!("Processing PlayStartup command");
                            // Stop any existing startup music
                            if let Some(sink) = current_startup_sink.take() {
                                sink.stop();
                            }

                            match Sink::try_new(&stream_handle) {
                                Ok(sink) => {
                                    let bytes = AppSounds::StartupMusic.get_sound_bytes();
                                    let file = Cursor::new(bytes);
                                    match rodio::Decoder::new(file) {
                                        Ok(source) => {
                                            sink.set_volume(0.5);
                                            sink.append(source);
                                            sink.play();
                                            println!("Successfully started playing startup music");
                                            current_startup_sink = Some(sink);
                                        }
                                        Err(e) => eprintln!("Failed to create decoder: {}", e),
                                    }
                                }
                                Err(e) => eprintln!("Failed to create sink: {}", e),
                            }
                        }
                        AudioCommand::StopStartup => {
                            println!("Processing StopStartup command");
                            if let Some(sink) = current_startup_sink.take() {
                                sink.stop();
                                println!("Stopped startup music");
                            }
                        }
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
    StartupMusic,
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
            AppSounds::StartupMusic => {
                include_bytes!("../sounds/tears-and-fireflies-adi-goldstein.ogg")
            }
        }
    }
}
