use std::path::{Path, PathBuf};

use cap_audio::AudioData;
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta};
use cap_rendering::{
    AudioBandLevels, AudioLevelAnalyzer, AudioLevelSource, AudioLevelStore, RenderVideoConstants,
};

use crate::{SegmentAudioTimingRepair, SegmentMedia, segments::resolve_music_path};

const CHUNK_FRAMES: usize = AudioData::SAMPLE_RATE as usize * 60;

pub fn has_waveform_segments(project: &ProjectConfiguration) -> bool {
    project
        .timeline
        .as_ref()
        .is_some_and(|timeline| !timeline.waveform_segments.is_empty())
}

fn analyze_file(path: &Path) -> Result<AudioBandLevels, String> {
    let mut analyzer = AudioLevelAnalyzer::new(AudioData::SAMPLE_RATE);
    let mut start = 0usize;
    loop {
        let chunk = AudioData::from_file_range(path, start, start + CHUNK_FRAMES)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if chunk.sample_count() == 0 {
            return Ok(analyzer.finish());
        }
        analyzer.push_interleaved(chunk.samples(), usize::from(chunk.channels().max(1)));
        start += CHUNK_FRAMES;
    }
}

#[derive(Debug, PartialEq)]
struct LevelSource {
    clip: u32,
    source: AudioLevelSource,
    path: PathBuf,
    timing_offset_secs: f32,
}

// Audio-only browser projects keep their audio muxed into a placeholder
// display video.
fn audio_sources(
    recording: &RecordingMeta,
    meta: &StudioRecordingMeta,
    repairs: &[SegmentAudioTimingRepair],
) -> Vec<LevelSource> {
    let clips: Vec<_> = match meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            vec![(&segment.display, segment.audio.as_ref(), None)]
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .map(|segment| {
                (
                    &segment.display,
                    segment.mic.as_ref(),
                    segment.usable_system_audio(),
                )
            })
            .collect(),
    };
    let mut sources = Vec::new();
    for (index, (display, mic, system)) in clips.into_iter().enumerate() {
        let repair = repairs.get(index);
        if let Some(mic) = mic {
            sources.push(LevelSource {
                clip: index as u32,
                source: AudioLevelSource::Mic,
                path: recording.path(&mic.path),
                timing_offset_secs: repair.map_or(0.0, |repair| repair.mic_offset_secs),
            });
        }
        if let Some(system) = system {
            sources.push(LevelSource {
                clip: index as u32,
                source: AudioLevelSource::System,
                path: recording.path(&system.path),
                timing_offset_secs: repair.map_or(0.0, |repair| repair.system_audio_offset_secs),
            });
        }
        if mic.is_none() && system.is_none() {
            sources.push(LevelSource {
                clip: index as u32,
                source: AudioLevelSource::Display,
                path: recording.path(&display.path),
                timing_offset_secs: 0.0,
            });
        }
    }
    sources
}

async fn load_recording_levels(
    store: &AudioLevelStore,
    recording: &RecordingMeta,
    meta: &StudioRecordingMeta,
    repairs: &[SegmentAudioTimingRepair],
) {
    for level_source in audio_sources(recording, meta, repairs) {
        let LevelSource {
            clip,
            source,
            path,
            timing_offset_secs,
        } = level_source;
        match tokio::task::spawn_blocking(move || analyze_file(&path)).await {
            Ok(Ok(levels)) => store.set(clip, source, levels.advanced(timing_offset_secs.into())),
            Ok(Err(error)) if source == AudioLevelSource::Display => {
                tracing::debug!(clip, %error, "Display file has no waveform audio");
            }
            Ok(Err(error)) => {
                tracing::warn!(clip, ?source, %error, "Waveform audio levels are unavailable");
            }
            Err(error) => {
                tracing::warn!(clip, ?source, %error, "Waveform audio level task failed");
            }
        }
    }
}

fn timeline_audio_paths(project: &ProjectConfiguration) -> Vec<&str> {
    let Some(timeline) = &project.timeline else {
        return Vec::new();
    };
    let mut paths: Vec<&str> = timeline
        .audio_segments
        .iter()
        .filter(|segment| segment.enabled && segment.volume_gain() > 0.0)
        .map(|segment| segment.path.as_str())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths
}

async fn load_timeline_levels(
    store: &AudioLevelStore,
    project_path: &Path,
    project: &ProjectConfiguration,
) {
    for path in timeline_audio_paths(project) {
        if store.timeline_audio(path).is_some() {
            continue;
        }
        let file = resolve_music_path(project_path, path);
        match tokio::task::spawn_blocking(move || analyze_file(&file)).await {
            Ok(Ok(levels)) => store.set_timeline_audio(path, levels),
            Ok(Err(error)) => {
                tracing::warn!(path, %error, "Timeline audio waveform levels are unavailable");
            }
            Err(error) => {
                tracing::warn!(path, %error, "Timeline audio waveform level task failed");
            }
        }
    }
}

pub async fn load_waveform_levels(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    segments: &[SegmentMedia],
) {
    let repairs: Vec<_> = segments
        .iter()
        .map(|segment| segment.audio_timing_repair)
        .collect();
    load_waveform_levels_into(
        &constants.waveform_levels,
        &constants.recording_meta,
        &constants.meta,
        project,
        &repairs,
    )
    .await;
}

/// The same levels as `load_waveform_levels`, for a caller that has no
/// decoders open, such as a render farm computing them once per export.
pub async fn load_waveform_levels_into(
    store: &AudioLevelStore,
    recording: &RecordingMeta,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
    repairs: &[SegmentAudioTimingRepair],
) {
    if !has_waveform_segments(project) {
        return;
    }
    load_recording_levels(store, recording, meta, repairs).await;
    load_timeline_levels(store, &recording.project_path, project).await;
}

/// Every file the waveform levels are read from, whole.
pub fn waveform_level_inputs(
    recording: &RecordingMeta,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
) -> Vec<PathBuf> {
    if !has_waveform_segments(project) {
        return Vec::new();
    }
    audio_sources(recording, meta, &[])
        .into_iter()
        .map(|source| source.path)
        .chain(
            timeline_audio_paths(project)
                .into_iter()
                .map(|path| resolve_music_path(&recording.project_path, path)),
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(path: &Path, samples: &[i16]) {
        let data_size = samples.len() as u32 * 2;
        let mut bytes = Vec::with_capacity(44 + data_size as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&AudioData::SAMPLE_RATE.to_le_bytes());
        bytes.extend_from_slice(&(AudioData::SAMPLE_RATE * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn tone(seconds: f64, gate_after: f64) -> Vec<i16> {
        (0..(f64::from(AudioData::SAMPLE_RATE) * seconds) as usize)
            .map(|index| {
                let time = index as f64 / f64::from(AudioData::SAMPLE_RATE);
                let gate = if time < gate_after { 0.0 } else { 12_000.0 };
                (gate * (std::f64::consts::TAU * 330.0 * time).sin()) as i16
            })
            .collect()
    }

    #[test]
    fn file_levels_match_analysing_the_samples_directly() {
        let samples = tone(2.0, 1.0);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mic.wav");
        write_wav(&path, &samples);

        let streamed = analyze_file(&path).unwrap();
        let mut analyzer = AudioLevelAnalyzer::new(AudioData::SAMPLE_RATE);
        analyzer.push(
            &samples
                .iter()
                .map(|sample| f32::from(*sample) / 32_768.0)
                .collect::<Vec<_>>(),
        );
        let direct = analyzer.finish();
        assert_eq!(streamed.frame_count(), 120);
        assert_eq!(streamed.frame_count(), direct.frame_count());
        assert!(
            streamed
                .as_bytes()
                .iter()
                .zip(direct.as_bytes())
                .all(|(a, b)| a.abs_diff(*b) <= 2)
        );
        let peak = |frame: usize| {
            streamed.as_bytes()[frame * cap_rendering::AUDIO_LEVEL_BANDS..]
                [..cap_rendering::AUDIO_LEVEL_BANDS]
                .iter()
                .copied()
                .max()
                .unwrap()
        };
        assert_eq!(peak(30), 0);
        assert!(peak(90) > 200);
        assert!(analyze_file(&directory.path().join("missing.wav")).is_err());
    }

    #[test]
    fn sources_cover_tracks_and_fall_back_to_display_audio() {
        let mut recording: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "levels",
            "segments": [
                {
                    "display": { "path": "d0.mp4", "fps": 30 },
                    "mic": { "path": "m0.ogg" },
                    "system_audio": { "path": "s0.ogg" }
                },
                { "display": { "path": "d1.mp4", "fps": 30 }, "system_audio": { "path": "s1.ogg" } },
                { "display": { "path": "d2.mp4", "fps": 30 } }
            ]
        }))
        .unwrap();
        recording.project_path = PathBuf::from("/project");
        let meta = recording.studio_meta().unwrap().clone();
        let sources: Vec<_> = audio_sources(&recording, &meta, &[])
            .into_iter()
            .map(|source| (source.clip, source.source, source.path))
            .collect();
        assert_eq!(
            sources,
            vec![
                (0, AudioLevelSource::Mic, PathBuf::from("/project/m0.ogg")),
                (
                    0,
                    AudioLevelSource::System,
                    PathBuf::from("/project/s0.ogg")
                ),
                (
                    1,
                    AudioLevelSource::System,
                    PathBuf::from("/project/s1.ogg")
                ),
                (
                    2,
                    AudioLevelSource::Display,
                    PathBuf::from("/project/d2.mp4")
                ),
            ]
        );

        let mut single: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "audio only",
            "display": { "path": "display.mp4", "fps": 1 }
        }))
        .unwrap();
        single.project_path = PathBuf::from("/project");
        let meta = single.studio_meta().unwrap().clone();
        let sources = audio_sources(&single, &meta, &[]);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source, AudioLevelSource::Display);
        assert_eq!(sources[0].path, PathBuf::from("/project/display.mp4"));
    }

    #[tokio::test]
    async fn recording_and_timeline_levels_load_for_audible_sources_only() {
        let directory = tempfile::tempdir().unwrap();
        let samples = tone(1.0, 0.0);
        write_wav(&directory.path().join("display.wav"), &samples);
        std::fs::create_dir_all(directory.path().join("assets")).unwrap();
        write_wav(&directory.path().join("assets/music.wav"), &samples);
        write_wav(&directory.path().join("assets/muted.wav"), &samples);
        let mut recording: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "audio only",
            "display": { "path": "display.wav", "fps": 1 }
        }))
        .unwrap();
        recording.project_path = directory.path().to_path_buf();
        let meta = recording.studio_meta().unwrap().clone();
        let project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [{ "timescale": 1.0, "start": 0.0, "end": 1.0 }],
                "zoomSegments": [],
                "audioSegments": [
                    { "start": 2.0, "end": 3.0, "path": "assets/music.wav", "trimStart": 0.5 },
                    { "start": 0.0, "end": 1.0, "path": "assets/music.wav" },
                    { "start": 0.0, "end": 1.0, "path": "assets/muted.wav", "volumeDb": -60.0 },
                    { "start": 0.0, "end": 1.0, "path": "assets/missing.wav" }
                ]
            }
        }))
        .unwrap();

        let store = AudioLevelStore::default();
        load_recording_levels(&store, &recording, &meta, &[]).await;
        load_timeline_levels(&store, directory.path(), &project).await;

        let display = store.get(0, AudioLevelSource::Display).unwrap();
        assert_eq!(display.frame_count(), 60);
        assert!(store.get(0, AudioLevelSource::Mic).is_none());
        assert_eq!(
            store
                .timeline_audio("assets/music.wav")
                .unwrap()
                .frame_count(),
            60
        );
        assert!(store.timeline_audio("assets/muted.wav").is_none());
        assert!(store.timeline_audio("assets/missing.wav").is_none());
    }
}
