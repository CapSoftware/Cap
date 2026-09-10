use std::{collections::HashMap, path::Path, sync::Arc};

use cap_audio::AudioData;
use cap_project::ProjectConfiguration;
use tracing::warn;

use crate::{
    SegmentMedia,
    audio::{AudioSegment, AudioSegmentTrack, MUSIC_SILENCE_DB, MusicTracks},
};

fn resolve_music_path(project_path: &Path, path: &str) -> std::path::PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        project_path.join(candidate)
    }
}

/// Decodes every distinct music/imported-audio file referenced by the project's
/// timeline audio segments, reusing `cache` so repeated playback/export starts
/// don't re-decode. Returns a snapshot keyed by the config path string for the
/// renderer to mix. Files that fail to decode are skipped (logged) so a missing
/// or corrupt track never aborts playback or export.
pub fn load_music_tracks(
    project: &ProjectConfiguration,
    project_path: &Path,
    cache: &mut MusicTracks,
) -> MusicTracks {
    let mut result = MusicTracks::new();

    let Some(timeline) = &project.timeline else {
        return result;
    };

    let mut ranges: HashMap<&str, (usize, usize)> = HashMap::new();
    let sample_rate = AudioData::SAMPLE_RATE as f64;

    for segment in &timeline.audio_segments {
        if !segment.enabled || segment.end <= segment.start || segment.volume_db <= MUSIC_SILENCE_DB
        {
            continue;
        }

        let trim_start = (segment.trim_start.max(0.0) * sample_rate).round() as usize;
        let start = (segment.start * sample_rate).round() as i64;
        let end = (segment.end * sample_rate).round() as i64;
        let duration = end.saturating_sub(start).max(0) as usize;
        if duration == 0 {
            continue;
        }

        let trim_end = trim_start.saturating_add(duration);
        ranges
            .entry(segment.path.as_str())
            .and_modify(|(source_start, source_end)| {
                *source_start = (*source_start).min(trim_start);
                *source_end = (*source_end).max(trim_end);
            })
            .or_insert((trim_start, trim_end));
    }

    for (path, (source_start, source_end)) in ranges {
        if let Some(data) = cache.get(path)
            && data.covers_source_range(source_start, source_end)
        {
            result.insert(path.to_string(), Arc::clone(data));
            continue;
        }

        let resolved = resolve_music_path(project_path, path);
        match AudioData::from_file_range(&resolved, source_start, source_end) {
            Ok(data) => {
                let data = Arc::new(data);
                cache.insert(path.to_string(), Arc::clone(&data));
                result.insert(path.to_string(), data);
            }
            Err(error) => {
                warn!(
                    path = %resolved.display(),
                    error,
                    "Failed to load timeline audio track; skipping"
                );
            }
        }
    }

    result
}

/// Convenience wrapper for one-shot consumers (e.g. export) that don't keep a
/// persistent decode cache.
pub fn load_music_tracks_uncached(
    project: &ProjectConfiguration,
    project_path: &Path,
) -> MusicTracks {
    let mut cache = MusicTracks::new();
    load_music_tracks(project, project_path, &mut cache)
}

/// Waits for a segment track's background decode, degrading a failed track to
/// "no audio" (with a warning) so playback never hard-fails on a corrupt file.
/// Export validates loaders strictly before reaching this point.
async fn loaded_track(
    loader: &crate::AudioLoader,
    label: &str,
) -> Option<Arc<cap_audio::DecodedAudio>> {
    match loader.get().await {
        Ok(audio) => audio,
        Err(error) => {
            warn!(%error, "Failed to load {label} track; continuing without it");
            None
        }
    }
}

pub async fn get_audio_segments(segments: &[SegmentMedia]) -> Vec<AudioSegment> {
    let mut out = Vec::with_capacity(segments.len());

    for s in segments {
        let audio = loaded_track(&s.audio, "mic audio").await;
        let system_audio = loaded_track(&s.system_audio, "system audio").await;

        out.push(audio_segment_from_decoded(
            audio,
            system_audio,
            s.audio_timing_repair,
        ));
    }

    out
}

pub fn audio_segment_from_decoded(
    audio: Option<Arc<cap_audio::DecodedAudio>>,
    system_audio: Option<Arc<cap_audio::DecodedAudio>>,
    repair: crate::editor_instance::SegmentAudioTimingRepair,
) -> AudioSegment {
    AudioSegment {
        tracks: [
            audio.map(|a| {
                AudioSegmentTrack::from_decoded(
                    a,
                    |c| c.mic_volume_db,
                    |c| match c.mic_stereo_mode {
                        cap_project::StereoMode::Stereo => cap_audio::StereoMode::Stereo,
                        cap_project::StereoMode::MonoL => cap_audio::StereoMode::MonoL,
                        cap_project::StereoMode::MonoR => cap_audio::StereoMode::MonoR,
                    },
                    |o| o.mic,
                )
                .with_timing_offset_secs(repair.mic_offset_secs)
            }),
            system_audio.map(|a| -> AudioSegmentTrack {
                AudioSegmentTrack::from_decoded(
                    a,
                    |c| c.system_volume_db,
                    |_| cap_audio::StereoMode::Stereo,
                    |o| o.system_audio,
                )
                .with_timing_offset_secs(repair.system_audio_offset_secs)
            }),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>(),
    }
}

#[cfg(test)]
mod completed_audio_tests {
    use super::*;
    use cap_project::{AudioConfiguration, ClipOffsets};

    #[test]
    fn shared_audio_segment_preserves_arc_gain_stereo_and_timing() {
        let audio = crate::completed_audio::tests::audio();
        let repair = crate::SegmentAudioTimingRepair {
            mic_offset_secs: -0.25,
            system_audio_offset_secs: 0.125,
        };
        let segment = audio_segment_from_decoded(Some(audio.clone()), Some(audio.clone()), repair);
        assert_eq!(segment.tracks.len(), 2);
        for track in &segment.tracks {
            assert!(Arc::ptr_eq(track.data(), &audio));
        }
        let config = AudioConfiguration {
            mic_volume_db: -3.5,
            system_volume_db: -8.0,
            mic_stereo_mode: cap_project::StereoMode::MonoR,
            ..Default::default()
        };
        let offsets = ClipOffsets {
            mic: 0.5,
            system_audio: -0.5,
            ..Default::default()
        };
        assert_eq!(segment.tracks[0].gain(&config), -3.5);
        assert_eq!(segment.tracks[1].gain(&config), -8.0);
        assert!(matches!(
            segment.tracks[0].stereo_mode(&config),
            cap_audio::StereoMode::MonoR
        ));
        assert!(matches!(
            segment.tracks[1].stereo_mode(&config),
            cap_audio::StereoMode::Stereo
        ));
        assert_eq!(segment.tracks[0].offset(&offsets), 0.25);
        assert_eq!(segment.tracks[1].offset(&offsets), -0.375);
        assert!(
            audio_segment_from_decoded(None, None, repair)
                .tracks
                .is_empty()
        );
    }
}
