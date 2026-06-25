use std::{path::Path, sync::Arc};

use cap_audio::AudioData;
use cap_project::ProjectConfiguration;
use tracing::warn;

use crate::{
    SegmentMedia,
    audio::{AudioSegment, AudioSegmentTrack, MusicTracks},
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

    for segment in &timeline.audio_segments {
        if result.contains_key(&segment.path) {
            continue;
        }

        if let Some(data) = cache.get(&segment.path) {
            result.insert(segment.path.clone(), Arc::clone(data));
            continue;
        }

        let resolved = resolve_music_path(project_path, &segment.path);
        match AudioData::from_file(&resolved) {
            Ok(data) => {
                let data = Arc::new(data);
                cache.insert(segment.path.clone(), Arc::clone(&data));
                result.insert(segment.path.clone(), data);
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

pub fn get_audio_segments(segments: &[SegmentMedia]) -> Vec<AudioSegment> {
    segments
        .iter()
        .map(|s| AudioSegment {
            tracks: [
                s.audio.clone().map(|a| {
                    AudioSegmentTrack::new(
                        a,
                        |c| c.mic_volume_db,
                        |c| match c.mic_stereo_mode {
                            cap_project::StereoMode::Stereo => cap_audio::StereoMode::Stereo,
                            cap_project::StereoMode::MonoL => cap_audio::StereoMode::MonoL,
                            cap_project::StereoMode::MonoR => cap_audio::StereoMode::MonoR,
                        },
                        |o| o.mic,
                    )
                    .with_timing_offset_secs(s.audio_timing_repair.mic_offset_secs)
                }),
                s.system_audio.clone().map(|a| -> AudioSegmentTrack {
                    AudioSegmentTrack::new(
                        a,
                        |c| c.system_volume_db,
                        |_| cap_audio::StereoMode::Stereo,
                        |o| o.system_audio,
                    )
                    .with_timing_offset_secs(s.audio_timing_repair.system_audio_offset_secs)
                }),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>(),
        })
        .collect::<Vec<_>>()
}
