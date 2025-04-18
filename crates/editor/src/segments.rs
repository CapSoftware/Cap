use cap_media::feeds::{AudioSegment, AudioSegmentTrack};

use crate::Segment;

pub fn get_audio_segments(segments: &[Segment]) -> Vec<AudioSegment> {
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
                    )
                }),
                s.system_audio.clone().map(|a| -> AudioSegmentTrack {
                    AudioSegmentTrack::new(
                        a,
                        |c| c.system_volume_db,
                        |_| cap_audio::StereoMode::Stereo,
                    )
                }),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>(),
        })
        .collect::<Vec<_>>()
}
