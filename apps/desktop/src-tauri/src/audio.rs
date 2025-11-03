use cap_audio::AudioData;

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
            AppSounds::Notification => include_bytes!("../sounds/action.ogg"),
        }
    }
}

pub fn get_waveform(audio: &AudioData) -> Vec<f32> {
    const CHUNK_SIZE: usize = (cap_audio::AudioData::SAMPLE_RATE as usize) / 10; // ~100ms

    let channels = audio.channels() as usize;
    let samples = audio.samples();
    let mut waveform = Vec::new();

    let mut i = 0;
    while i < samples.len() {
        let end = (i + CHUNK_SIZE * channels).min(samples.len());
        let mut sum = 0.0f32;
        for s in &samples[i..end] {
            sum += s.abs();
        }
        let avg = if end > i { sum / (end - i) as f32 } else { 0.0 };
        waveform.push(avg);
        i += CHUNK_SIZE * channels;
    }

    // Convert to absolute dBFS (0 dBFS = digital full scale)
    for v in waveform.iter_mut() {
        *v = if *v > 0.0 {
            20.0 * v.log10() // Absolute dBFS relative to 1.0
        } else {
            -60.0 // Set silence to -60dBFS instead of -∞ for practical use
        };
    }

    waveform
}
