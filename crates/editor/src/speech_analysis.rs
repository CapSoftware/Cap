use cap_project::StudioRecordingMeta;
use cap_rendering::ClipSpeech;
use std::path::{Path, PathBuf};

fn clip_mics(project_path: &Path, meta: &StudioRecordingMeta) -> Vec<Option<PathBuf>> {
    match meta {
        StudioRecordingMeta::SingleSegment { segment } => vec![
            segment
                .audio
                .as_ref()
                .map(|audio| audio.path.to_path(project_path)),
        ],
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .map(|segment| {
                segment
                    .mic
                    .as_ref()
                    .map(|mic| mic.path.to_path(project_path))
            })
            .collect(),
    }
}

/// Runs speech detection over every clip's mic. A clip with no mic, or one
/// that cannot be read, is `None` and is never mistaken for silence.
pub fn analyze_clip_speech(
    project_path: &Path,
    meta: &StudioRecordingMeta,
) -> Vec<Option<ClipSpeech>> {
    let legacy_log = std::fs::read_to_string(project_path.join("recording-logs.log")).ok();
    let repairs = crate::segment_audio_timing_repairs(meta, legacy_log.as_deref());
    clip_mics(project_path, meta)
        .into_iter()
        .enumerate()
        .map(|(index, mic)| {
            let spans = cap_audio::detect_speech_in_file(&mic?)
                .inspect_err(|error| {
                    tracing::warn!(%error, clip = index, "Speech analysis failed");
                })
                .ok()?;
            let timing_offset = repairs
                .get(index)
                .map(|repair| f64::from(repair.mic_offset_secs))
                .filter(|offset| offset.is_finite())
                .unwrap_or(0.0);
            Some(ClipSpeech {
                spans,
                timing_offset,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mic_that_cannot_be_read_is_never_treated_as_silence() {
        let dir = tempfile::tempdir().unwrap();
        let segment = dir.path().join("content/segments/segment-0");
        std::fs::create_dir_all(&segment).unwrap();
        std::fs::write(segment.join("audio-input.m4a"), b"not an m4a file").unwrap();
        let meta: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
            "segments": [
                {
                    "display": { "path": "content/segments/segment-0/display.mp4", "fps": 30 },
                    "mic": { "path": "content/segments/segment-0/audio-input.m4a" }
                },
                { "display": { "path": "content/segments/segment-1/display.mp4", "fps": 30 } }
            ]
        }))
        .unwrap();
        assert_eq!(analyze_clip_speech(dir.path(), &meta), vec![None, None]);
    }
}
