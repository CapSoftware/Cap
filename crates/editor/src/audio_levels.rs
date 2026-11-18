use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use cap_audio::{AudioData, waveform_peaks};
use cap_project::{RecordingMeta, StudioRecordingMeta};
use cap_rendering::AudioLevels;

/// A minute at a time: a multiple of the tenth-of-a-second waveform block, so
/// the chunks join into the same peaks one full decode would give, while a
/// long recording never sits in memory whole.
const CHUNK_FRAMES: usize = AudioData::SAMPLE_RATE as usize * 60;

pub fn compute_audio_levels(
    recording: &RecordingMeta,
    meta: &StudioRecordingMeta,
    cancel: &AtomicBool,
) -> Result<AudioLevels, String> {
    let StudioRecordingMeta::MultipleSegments { inner } = meta else {
        return Ok(AudioLevels::default());
    };
    let mut mic = Vec::with_capacity(inner.segments.len());
    let mut system = Vec::with_capacity(inner.segments.len());
    for segment in &inner.segments {
        for (audio, out) in [
            (segment.mic.as_ref(), &mut mic),
            (segment.usable_system_audio(), &mut system),
        ] {
            out.push(match audio {
                Some(audio) => track_peaks(&recording.path(&audio.path), cancel)?,
                None => Vec::new(),
            });
        }
    }
    Ok(AudioLevels::from_waveform_peaks(&mic, &system))
}

fn track_peaks(path: &Path, cancel: &AtomicBool) -> Result<Vec<f32>, String> {
    let mut peaks = Vec::new();
    let mut start = 0usize;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        let chunk = AudioData::from_file_range(path, start, start + CHUNK_FRAMES)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let frames = chunk.sample_count();
        if frames == 0 {
            break;
        }
        peaks.extend(waveform_peaks([chunk.samples()], chunk.channels()));
        start += CHUNK_FRAMES;
    }
    Ok(peaks)
}
