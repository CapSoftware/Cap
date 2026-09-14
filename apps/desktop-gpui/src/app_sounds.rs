use std::io::Cursor;

use anyhow::Context as _;
use rodio::{Decoder, OutputStream, Sink};

#[path = "../../desktop/src-tauri/src/recording_start_sound.rs"]
mod recording_start_sound;

pub use recording_start_sound::StartCue;

pub fn prime_recording_start_sound() -> StartCue {
    recording_start_sound::prime(AppSound::StartRecording.bytes())
}

pub async fn play_recording_start_sound(cue: StartCue, gate: cap_recording::RecordingStartGate) {
    recording_start_sound::play(cue, gate).await;
}

#[derive(Clone, Copy, Debug)]
pub enum AppSound {
    StartRecording,
    StopRecording,
    Notification,
}

impl AppSound {
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::StartRecording => {
                include_bytes!("../../desktop/src-tauri/sounds/start-recording.ogg")
            }
            Self::StopRecording => {
                include_bytes!("../../desktop/src-tauri/sounds/stop-recording.ogg")
            }
            Self::Notification => include_bytes!("../../desktop/src-tauri/sounds/action.ogg"),
        }
    }

    pub fn play(self) {
        if let Err(error) = std::thread::Builder::new()
            .name("app-sound".into())
            .spawn(move || {
                if let Err(error) = self.play_to_end() {
                    tracing::warn!(?self, %error, "App sound unavailable");
                }
            })
        {
            tracing::warn!(%error, "Could not start app sound playback");
        }
    }

    fn play_to_end(self) -> anyhow::Result<()> {
        let (_stream, handle) = OutputStream::try_default().context("opening audio output")?;
        let source = Decoder::new(Cursor::new(self.bytes())).context("decoding app sound")?;
        let sink = Sink::try_new(&handle).context("creating app sound sink")?;
        sink.append(source);
        sink.sleep_until_end();
        tracing::debug!(?self, "App sound played");
        Ok(())
    }
}

pub fn play_notification() {
    if crate::store::notification_sounds_enabled() {
        AppSound::Notification.play();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::Source as _;

    const SOUNDS: [AppSound; 3] = [
        AppSound::StartRecording,
        AppSound::StopRecording,
        AppSound::Notification,
    ];

    #[test]
    fn tauri_sound_assets_decode_to_audible_pcm() {
        for sound in SOUNDS {
            let source = Decoder::new(Cursor::new(sound.bytes())).unwrap();
            let channels = source.channels();
            let rate = source.sample_rate();
            assert!(channels > 0);
            assert!(rate > 0);
            let samples: Vec<_> = source.collect();
            assert!(samples.iter().any(|sample| *sample != 0), "{sound:?}");
            let duration = samples.len() as f64 / f64::from(channels) / f64::from(rate);
            assert!((0.05..10.0).contains(&duration), "{sound:?}: {duration}");
        }
    }

    #[test]
    #[ignore = "plays the recording and notification cues through the default audio output"]
    fn native_app_sound_playback() {
        for sound in SOUNDS {
            sound.play_to_end().unwrap();
        }
    }
}
