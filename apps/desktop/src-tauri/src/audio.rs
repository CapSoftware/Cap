use cap_audio::DecodedAudio;

#[path = "recording_start_sound.rs"]
mod recording_start_sound;

pub use recording_start_sound::StartCue;

pub fn prime_recording_start_sound() -> StartCue {
    recording_start_sound::prime(AppSounds::StartRecording.get_sound_bytes())
}

pub async fn play_recording_start_sound(cue: StartCue, gate: cap_recording::RecordingStartGate) {
    recording_start_sound::play(cue, gate).await;
}

pub async fn play_recording_start_sound_for_admission(cue: StartCue) -> Result<(), String> {
    recording_start_sound::play_for_admission(cue).await
}

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

#[allow(dead_code)]
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

pub fn get_waveform(audio: &DecodedAudio) -> Vec<f32> {
    cap_audio::waveform_peaks(audio.sample_slices().flatten(), audio.channels())
}

const WAVEFORM_PEAKS_PER_SECOND: f64 = 10.0;
const WAVEFORM_SILENCE_DB: f32 = -60.0;

/// Playback reads each track at source time plus its timing repair offset
/// (`SegmentAudioTimingRepair`), so the peaks are shifted the same way; the
/// editor then only has to add the user's clip offset.
pub fn align_waveform_to_playback(peaks: Vec<f32>, timing_offset_secs: f32) -> Vec<f32> {
    let shift = (f64::from(timing_offset_secs) * WAVEFORM_PEAKS_PER_SECOND).round() as isize;
    if shift > 0 {
        peaks.into_iter().skip(shift.unsigned_abs()).collect()
    } else if shift < 0 {
        std::iter::repeat_n(WAVEFORM_SILENCE_DB, shift.unsigned_abs())
            .chain(peaks)
            .collect()
    } else {
        peaks
    }
}

#[cfg(test)]
mod waveform_alignment_tests {
    use super::align_waveform_to_playback;

    #[test]
    fn shifts_peaks_by_the_timing_repair_offset() {
        let peaks = vec![-10.0, -20.0, -30.0, -40.0];
        assert_eq!(
            align_waveform_to_playback(peaks.clone(), 0.2),
            vec![-30.0, -40.0]
        );
        assert_eq!(
            align_waveform_to_playback(peaks.clone(), -0.1),
            vec![-60.0, -10.0, -20.0, -30.0, -40.0]
        );
        assert_eq!(align_waveform_to_playback(peaks.clone(), 0.02), peaks);
    }
}
