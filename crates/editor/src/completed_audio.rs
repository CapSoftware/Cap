use cap_audio::DecodedAudio;
use cap_project::{AudioGapSummary, AudioMeta, RecordingMeta, StudioRecordingMeta};
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Default)]
pub(crate) struct CompletedAudioSegment {
    pub(crate) mic: Option<Arc<DecodedAudio>>,
    pub(crate) system_audio: Option<Arc<DecodedAudio>>,
}

#[derive(Clone, PartialEq, Eq)]
struct AudioTrackIdentity {
    path: String,
    start_time_bits: Option<u64>,
    device_id: Option<String>,
    gap_summary: Option<AudioGapSummary>,
}

impl From<&AudioMeta> for AudioTrackIdentity {
    fn from(meta: &AudioMeta) -> Self {
        Self {
            path: meta.path.to_string(),
            start_time_bits: meta.start_time.map(f64::to_bits),
            device_id: meta.device_id.clone(),
            gap_summary: meta.gap_summary,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct SegmentAudioIdentity {
    mic: Option<AudioTrackIdentity>,
    system_audio: Option<AudioTrackIdentity>,
}

fn audio_identities(meta: &StudioRecordingMeta) -> Vec<SegmentAudioIdentity> {
    match meta {
        StudioRecordingMeta::SingleSegment { segment } => vec![SegmentAudioIdentity {
            mic: segment.audio.as_ref().map(Into::into),
            system_audio: None,
        }],
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .map(|segment| SegmentAudioIdentity {
                mic: segment.mic.as_ref().map(Into::into),
                system_audio: segment.system_audio.as_ref().map(Into::into),
            })
            .collect(),
    }
}

#[derive(Clone)]
pub struct CompletedAudioHandoff {
    project_path: PathBuf,
    identities: Vec<SegmentAudioIdentity>,
    segments: Vec<CompletedAudioSegment>,
}

impl CompletedAudioHandoff {
    pub(crate) fn from_completed_tracks(
        source_metadata: &RecordingMeta,
        expected_finalized_metadata: &RecordingMeta,
        segments: Vec<CompletedAudioSegment>,
    ) -> Result<Self, String> {
        if source_metadata.project_path != expected_finalized_metadata.project_path {
            return Err("Completed audio belongs to a different project".into());
        }
        let source = audio_identities(
            source_metadata
                .studio_meta()
                .ok_or("Completed audio requires Studio metadata")?,
        );
        let identities = audio_identities(
            expected_finalized_metadata
                .studio_meta()
                .ok_or("Completed audio requires Studio metadata")?,
        );
        if segments.len() != identities.len() || source.len() != identities.len() {
            return Err("Completed audio segment count changed".into());
        }
        for ((completed, expected), original) in segments.iter().zip(&identities).zip(&source) {
            for (audio, expected, original) in [
                (&completed.mic, &expected.mic, &original.mic),
                (
                    &completed.system_audio,
                    &expected.system_audio,
                    &original.system_audio,
                ),
            ] {
                if audio.is_some()
                    && !matches!((original, expected), (Some(original), Some(expected)) if original.path == expected.path)
                {
                    return Err("Completed audio track path or presence changed".into());
                }
            }
        }
        Ok(Self {
            project_path: expected_finalized_metadata.project_path.clone(),
            identities,
            segments,
        })
    }

    pub(crate) fn into_matching(
        self,
        recording_meta: &RecordingMeta,
        meta: &StudioRecordingMeta,
    ) -> Option<Vec<CompletedAudioSegment>> {
        (self.project_path == recording_meta.project_path
            && self.identities == audio_identities(meta))
        .then_some(self.segments)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use cap_project::{
        MultipleSegment, MultipleSegments, RecordingMetaInner, StudioRecordingStatus, VideoMeta,
    };
    use std::io::Write;

    pub(crate) fn audio() -> Arc<DecodedAudio> {
        let mut file = tempfile::Builder::new().suffix(".wav").tempfile().unwrap();
        let samples: Vec<i16> = (0..2003)
            .map(|index| ((index * 31) % 12000 - 6000) as i16)
            .collect();
        let bytes = (samples.len() * 2) as u32;
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + bytes).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&48000u32.to_le_bytes()).unwrap();
        file.write_all(&96000u32.to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&bytes.to_le_bytes()).unwrap();
        for sample in samples {
            file.write_all(&sample.to_le_bytes()).unwrap();
        }
        file.flush().unwrap();
        Arc::new(DecodedAudio::from(Arc::new(
            cap_audio::AudioData::from_file(file.path()).unwrap(),
        )))
    }

    pub(crate) fn metadata() -> RecordingMeta {
        RecordingMeta {
            platform: None,
            project_path: "fixture.cap".into(),
            pretty_name: "Audio handoff fixture".into(),
            sharing: None,
            upload: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments: (0..2)
                        .map(|index| MultipleSegment {
                            display: VideoMeta {
                                path: format!("content/segments/segment-{index}/display.mp4")
                                    .into(),
                                fps: 30,
                                start_time: Some(0.0),
                                device_id: None,
                            },
                            camera: None,
                            mic: Some(AudioMeta {
                                path: format!("content/segments/segment-{index}/audio-input.m4a")
                                    .into(),
                                start_time: Some(0.125),
                                device_id: Some("mic".into()),
                                gap_summary: None,
                            }),
                            system_audio: Some(AudioMeta {
                                path: format!("content/segments/segment-{index}/system_audio.ogg")
                                    .into(),
                                start_time: Some(-0.25),
                                device_id: None,
                                gap_summary: None,
                            }),
                            cursor: None,
                            keyboard: None,
                            display_notch: None,
                        })
                        .collect(),
                    cursors: Default::default(),
                    status: Some(StudioRecordingStatus::Complete),
                },
            })),
        }
    }

    pub(crate) fn segments_mut(meta: &mut RecordingMeta) -> &mut Vec<MultipleSegment> {
        let RecordingMetaInner::Studio(studio) = &mut meta.inner else {
            panic!()
        };
        let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
            panic!()
        };
        &mut inner.segments
    }

    fn completed(audio: &Arc<DecodedAudio>) -> Vec<CompletedAudioSegment> {
        vec![
            CompletedAudioSegment {
                mic: Some(audio.clone()),
                system_audio: None,
            },
            CompletedAudioSegment::default(),
        ]
    }

    #[test]
    fn completed_cache_preserves_arc_and_sparse_missing_tracks() {
        let meta = metadata();
        let audio = audio();
        let cache =
            CompletedAudioHandoff::from_completed_tracks(&meta, &meta, completed(&audio)).unwrap();
        let matched = cache
            .into_matching(&meta, meta.studio_meta().unwrap())
            .unwrap();
        assert!(Arc::ptr_eq(matched[0].mic.as_ref().unwrap(), &audio));
        assert!(matched[0].system_audio.is_none());
        assert!(matched[1].mic.is_none());
    }

    #[test]
    fn completed_cache_rejects_every_changed_track_identity() {
        let original = metadata();
        let audio = audio();
        for field in [
            "project", "index", "count", "presence", "path", "start", "device", "gap",
        ] {
            let mut actual = original.clone();
            match field {
                "project" => actual.project_path = "other.cap".into(),
                "index" => segments_mut(&mut actual).swap(0, 1),
                "count" => {
                    assert!(segments_mut(&mut actual).pop().is_some());
                }
                "presence" => segments_mut(&mut actual)[0].mic = None,
                "path" => {
                    segments_mut(&mut actual)[0].mic.as_mut().unwrap().path = "changed.ogg".into()
                }
                "start" => {
                    segments_mut(&mut actual)[0]
                        .mic
                        .as_mut()
                        .unwrap()
                        .start_time = Some(0.1250000001)
                }
                "device" => segments_mut(&mut actual)[0].mic.as_mut().unwrap().device_id = None,
                "gap" => {
                    segments_mut(&mut actual)[0]
                        .mic
                        .as_mut()
                        .unwrap()
                        .gap_summary = Some(AudioGapSummary {
                        total_overlap_trimmed_ms: 100,
                        startup_overlap_trimmed_ms: 100,
                        overlap_dropped_frames: 3,
                        startup_overlap_drops: 3,
                    })
                }
                _ => unreachable!(),
            }
            let cache = CompletedAudioHandoff::from_completed_tracks(
                &original,
                &original,
                completed(&audio),
            )
            .unwrap();
            assert!(
                cache
                    .into_matching(&actual, actual.studio_meta().unwrap())
                    .is_none(),
                "{field}"
            );
        }
    }

    #[test]
    fn completed_pcm_cannot_be_relabelled_as_transcoded_or_absent_track() {
        let original = metadata();
        let audio = audio();
        let mut expected = original.clone();
        segments_mut(&mut expected)[0].mic.as_mut().unwrap().path =
            "content/segments/segment-0/audio-input.ogg".into();
        assert!(
            CompletedAudioHandoff::from_completed_tracks(&original, &expected, completed(&audio))
                .is_err()
        );
        segments_mut(&mut expected)[0].mic = None;
        assert!(
            CompletedAudioHandoff::from_completed_tracks(&original, &expected, completed(&audio))
                .is_err()
        );
    }
}
