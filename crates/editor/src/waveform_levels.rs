use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

use cap_audio::{AudioData, AudioStream, ChunkRead, DecodedAudio};
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta};
use cap_rendering::{AudioLevelAnalyzer, AudioLevelSource, AudioLevels, RenderVideoConstants};

use crate::{AudioLoader, SegmentMedia, segments::resolve_music_path};

pub fn has_waveform_segments(project: &ProjectConfiguration) -> bool {
    project
        .timeline
        .as_ref()
        .is_some_and(|timeline| !timeline.waveform_segments.is_empty())
}

fn analyze(audio: &DecodedAudio) -> AudioLevels {
    let mut analyzer = AudioLevelAnalyzer::new(AudioData::SAMPLE_RATE);
    for samples in audio.sample_slices() {
        analyzer.push_interleaved(samples, usize::from(audio.channels()));
    }
    analyzer.finish()
}

fn analyze_file(path: &Path) -> Result<AudioLevels, String> {
    let mut stream = AudioStream::open(path, Arc::new(AtomicBool::new(false)))
        .map_err(|error| error.to_string())?;
    let mut analyzer = AudioLevelAnalyzer::new(AudioData::SAMPLE_RATE);
    let mut position = 0;
    loop {
        match stream
            .read_chunk(AudioData::SAMPLE_RATE as usize)
            .map_err(|error| error.to_string())?
        {
            ChunkRead::Chunk(chunk) => {
                if chunk.source_start_sample > position {
                    analyzer.push(&vec![0.0; (chunk.source_start_sample - position) as usize]);
                }
                let channels = usize::from(chunk.channels.max(1));
                analyzer.push_interleaved(&chunk.samples, channels);
                position = chunk.source_start_sample + (chunk.samples.len() / channels) as u64;
            }
            ChunkRead::Eof { .. } => return Ok(analyzer.finish()),
        }
    }
}

struct LevelSource<'a> {
    clip: u32,
    source: AudioLevelSource,
    path: PathBuf,
    loader: Option<&'a AudioLoader>,
    timing_offset_secs: f32,
}

/// Every mic and system track, plus the display file's own audio for clips
/// that have neither (audio-only web projects keep their audio muxed into a
/// placeholder display video).
fn audio_sources<'a>(
    recording: &RecordingMeta,
    meta: &StudioRecordingMeta,
    segments: &'a [SegmentMedia],
) -> Vec<LevelSource<'a>> {
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
                    segment.system_audio.as_ref(),
                )
            })
            .collect(),
    };
    let mut sources = Vec::new();
    for (index, (display, mic, system)) in clips.into_iter().enumerate() {
        let media = segments.get(index);
        let repair = media.map(|media| media.audio_timing_repair);
        if let Some(mic) = mic {
            sources.push(LevelSource {
                clip: index as u32,
                source: AudioLevelSource::Mic,
                path: recording.path(&mic.path),
                loader: media.map(|media| &media.audio),
                timing_offset_secs: repair.map_or(0.0, |repair| repair.mic_offset_secs),
            });
        }
        if let Some(system) = system {
            sources.push(LevelSource {
                clip: index as u32,
                source: AudioLevelSource::System,
                path: recording.path(&system.path),
                loader: media.map(|media| &media.system_audio),
                timing_offset_secs: repair.map_or(0.0, |repair| repair.system_audio_offset_secs),
            });
        }
        if mic.is_none() && system.is_none() {
            sources.push(LevelSource {
                clip: index as u32,
                source: AudioLevelSource::Display,
                path: recording.path(&display.path),
                loader: None,
                timing_offset_secs: 0.0,
            });
        }
    }
    sources
}

/// Fills `constants.audio_levels` so waveform overlays can draw. Reuses audio
/// the segments already decoded and streams the file otherwise (exports that
/// stream their audio mix, and display files with muxed audio).
pub async fn load_waveform_levels(constants: &RenderVideoConstants, segments: &[SegmentMedia]) {
    for level_source in audio_sources(&constants.recording_meta, &constants.meta, segments) {
        let LevelSource {
            clip,
            source,
            path,
            loader,
            timing_offset_secs,
        } = level_source;
        let decoded = match loader {
            Some(loader) => loader.get().await.ok().flatten(),
            None => None,
        };
        let levels = tokio::task::spawn_blocking(move || match decoded {
            Some(audio) => Ok(analyze(&audio)),
            None => analyze_file(&path),
        })
        .await;
        match levels {
            Ok(Ok(levels)) => {
                constants
                    .audio_levels
                    .set(clip, source, levels.advanced(timing_offset_secs.into()))
            }
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

/// Fills `constants.audio_levels` for each imported audio file the timeline
/// can play, skipping files whose levels are already loaded.
pub async fn load_timeline_audio_levels(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
) {
    let Some(timeline) = &project.timeline else {
        return;
    };
    let mut paths: Vec<&str> = timeline
        .audio_segments
        .iter()
        .filter(|segment| segment.enabled && segment.volume_gain() > 0.0)
        .map(|segment| segment.path.as_str())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    for path in paths {
        if constants.audio_levels.timeline_audio(path).is_some() {
            continue;
        }
        let file = resolve_music_path(&constants.recording_meta.project_path, path);
        match tokio::task::spawn_blocking(move || analyze_file(&file)).await {
            Ok(Ok(levels)) => constants.audio_levels.set_timeline_audio(path, levels),
            Ok(Err(error)) => {
                tracing::warn!(path, %error, "Timeline audio waveform levels are unavailable");
            }
            Err(error) => {
                tracing::warn!(path, %error, "Timeline audio waveform level task failed");
            }
        }
    }
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

    #[test]
    fn streamed_file_levels_match_decoded_levels() {
        let samples: Vec<i16> = (0..AudioData::SAMPLE_RATE as usize * 2)
            .map(|index| {
                let time = index as f64 / f64::from(AudioData::SAMPLE_RATE);
                let gate = if time < 1.0 { 0.0 } else { 12_000.0 };
                (gate * (std::f64::consts::TAU * 330.0 * time).sin()) as i16
            })
            .collect();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mic.wav");
        write_wav(&path, &samples);

        let streamed = analyze_file(&path).unwrap();
        let decoded = analyze(&DecodedAudio::from(Arc::new(AudioData::from_raw_f32(
            samples
                .iter()
                .map(|sample| f32::from(*sample) / 32_768.0)
                .collect(),
            1,
        ))));
        assert_eq!(streamed.frame_count(), 120);
        assert_eq!(streamed.frame_count(), decoded.frame_count());
        assert!(
            streamed
                .as_bytes()
                .iter()
                .zip(decoded.as_bytes())
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
            .map(|source| {
                (
                    source.clip,
                    source.source,
                    source.path,
                    source.loader.is_some(),
                )
            })
            .collect();
        assert_eq!(
            sources,
            vec![
                (
                    0,
                    AudioLevelSource::Mic,
                    PathBuf::from("/project/m0.ogg"),
                    false
                ),
                (
                    0,
                    AudioLevelSource::System,
                    PathBuf::from("/project/s0.ogg"),
                    false
                ),
                (
                    1,
                    AudioLevelSource::System,
                    PathBuf::from("/project/s1.ogg"),
                    false
                ),
                (
                    2,
                    AudioLevelSource::Display,
                    PathBuf::from("/project/d2.mp4"),
                    false
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
    async fn timeline_audio_levels_load_for_audible_segments_only() {
        let directory = tempfile::tempdir().unwrap();
        let tone: Vec<i16> = (0..AudioData::SAMPLE_RATE as usize)
            .map(|index| {
                let time = index as f64 / f64::from(AudioData::SAMPLE_RATE);
                (12_000.0 * (std::f64::consts::TAU * 220.0 * time).sin()) as i16
            })
            .collect();
        write_wav(&directory.path().join("display.wav"), &tone);
        std::fs::create_dir_all(directory.path().join("assets")).unwrap();
        write_wav(&directory.path().join("assets/music.wav"), &tone);
        write_wav(&directory.path().join("assets/muted.wav"), &tone);
        let mut recording: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "music",
            "display": { "path": "display.wav", "fps": 1 }
        }))
        .unwrap();
        recording.project_path = directory.path().to_path_buf();
        let meta = recording.studio_meta().unwrap().clone();
        let Ok(constants) = RenderVideoConstants::new_with_options(
            cap_rendering::RenderOptions {
                screen_size: cap_project::XY::new(16, 16),
                camera_size: None,
                preserve_screen_alpha: false,
            },
            recording,
            meta,
        )
        .await
        else {
            eprintln!("No GPU adapter available; skipping timeline audio level test");
            return;
        };
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
        load_timeline_audio_levels(&constants, &project).await;
        let music = constants
            .audio_levels
            .timeline_audio("assets/music.wav")
            .unwrap();
        assert_eq!(music.frame_count(), 60);
        assert!(
            constants
                .audio_levels
                .timeline_audio("assets/muted.wav")
                .is_none()
        );
        assert!(
            constants
                .audio_levels
                .timeline_audio("assets/missing.wav")
                .is_none()
        );
    }

    #[tokio::test]
    async fn display_audio_levels_load_from_the_display_file() {
        let directory = tempfile::tempdir().unwrap();
        let samples: Vec<i16> = (0..AudioData::SAMPLE_RATE as usize)
            .map(|index| {
                let time = index as f64 / f64::from(AudioData::SAMPLE_RATE);
                (12_000.0 * (std::f64::consts::TAU * 330.0 * time).sin()) as i16
            })
            .collect();
        write_wav(&directory.path().join("display.wav"), &samples);
        let mut recording: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "audio only",
            "display": { "path": "display.wav", "fps": 1 }
        }))
        .unwrap();
        recording.project_path = directory.path().to_path_buf();
        let meta = recording.studio_meta().unwrap().clone();
        let Ok(constants) = RenderVideoConstants::new_with_options(
            cap_rendering::RenderOptions {
                screen_size: cap_project::XY::new(16, 16),
                camera_size: None,
                preserve_screen_alpha: false,
            },
            recording,
            meta,
        )
        .await
        else {
            eprintln!("No GPU adapter available; skipping display level test");
            return;
        };
        load_waveform_levels(&constants, &[]).await;
        let levels = constants
            .audio_levels
            .get(0, AudioLevelSource::Display)
            .unwrap();
        assert_eq!(levels.frame_count(), 60);
        assert!(
            constants
                .audio_levels
                .get(0, AudioLevelSource::Mic)
                .is_none()
        );
    }
}
