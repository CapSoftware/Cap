use super::*;
use cap_editor::PreparingAudioSegmentInput;
use cap_project::{AudioMeta, RecordingMeta, StudioRecordingMeta};
use cap_recording::recovery::PreparingAudioTrack;

const MAX_AUDIO_TIMING_LOG_BYTES: u64 = 4 * 1024 * 1024;

struct AudioTiming {
    expected_metadata: RecordingMeta,
    repairs: Option<Vec<cap_editor::SegmentAudioTimingRepair>>,
}

pub(super) struct AudioAdaptation {
    pub(super) tracks: Vec<PreparingAudioSegmentInput>,
    pub(super) expected_metadata: RecordingMeta,
}

pub(super) fn adapt_audio(
    sources: &Arc<PreparingStudioSources>,
    metadata: &RecordingMeta,
    control: &Arc<ConsumerControl>,
) -> Result<AudioAdaptation, String> {
    let timing = audio_timing(metadata)?;
    let live = sources.live().ok_or("Preparing audio sources ended")?;
    let descriptors = live.segments().ok_or("Preparing audio sources ended")?;
    let mut tracks = Vec::with_capacity(descriptors.len());
    for (index, descriptor) in descriptors.iter().enumerate() {
        let repair = match &timing.repairs {
            Some(repairs) => *repairs
                .get(index)
                .ok_or("Preparing audio timing layout changed")?,
            None => cap_editor::SegmentAudioTimingRepair::default(),
        };
        let track = |kind, stem| {
            timing.repairs.as_ref()?;
            let lease = live.audio(descriptor.index(), kind)?;
            let metadata = lease.metadata()?;
            let (source, path) = lease.input()?;
            if !preserved_audio_path(metadata, path, stem) {
                return None;
            }
            if path.extension().is_some_and(|extension| extension == "m4a") {
                let control = control.clone();
                let sources = sources.clone();
                let input = cap_enc_ffmpeg::SegmentedInput::open_relocatable_interruptible(
                    source,
                    [path],
                    Arc::new(move || *control.cancelled.borrow() || sources.live().is_none()),
                )
                .ok()?;
                if input
                    .input()
                    .streams()
                    .best(ffmpeg::media::Type::Video)
                    .is_some()
                    || !input
                        .input()
                        .streams()
                        .best(ffmpeg::media::Type::Audio)
                        .is_some_and(|stream| stream.parameters().id() == ffmpeg::codec::Id::AAC)
                {
                    return None;
                }
            }
            cap_audio::ManagedAudioInput::new(source.clone(), path.to_path_buf()).ok()
        };
        tracks.push(PreparingAudioSegmentInput {
            mic: track(PreparingAudioTrack::Mic, "audio-input"),
            system_audio: track(PreparingAudioTrack::SystemAudio, "system_audio"),
            timing_repair: repair,
        });
        if *control.cancelled.borrow() || sources.live().is_none() {
            return Err("Preparing audio sources ended".into());
        }
    }
    Ok(AudioAdaptation {
        tracks,
        expected_metadata: timing.expected_metadata,
    })
}

fn audio_timing(metadata: &RecordingMeta) -> Result<AudioTiming, String> {
    let mut expected_metadata = metadata.clone();
    let cap_project::RecordingMetaInner::Studio(studio) = &mut expected_metadata.inner else {
        return Err("Preparing audio requires Studio metadata".into());
    };
    let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        return Err("Preparing audio requires stopped segments".into());
    };
    for segment in &mut inner.segments {
        for audio in [&mut segment.mic, &mut segment.system_audio]
            .into_iter()
            .flatten()
        {
            audio.gap_summary = None;
        }
    }
    // Clean Stop joins timing-log writers; finalization can still append unrelated events.
    let timing_log = read_timing_log(
        &metadata.project_path.join("recording-logs.log"),
        MAX_AUDIO_TIMING_LOG_BYTES,
    );
    let repairs = match timing_log {
        Ok(log) => Some(cap_editor::segment_audio_timing_repairs(
            expected_metadata
                .studio_meta()
                .ok_or("Preparing Studio metadata ended")?,
            log.as_deref(),
        )),
        Err(error) => {
            tracing::debug!(%error, "Preparing audio timing requires ordinary loading");
            None
        }
    };
    Ok(AudioTiming {
        expected_metadata,
        repairs,
    })
}

fn read_timing_log(path: &Path, limit: u64) -> Result<Option<String>, String> {
    let initial = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Preparing audio timing log metadata: {error}")),
    };
    if !initial.is_file() || initial.len() > limit {
        return Err("Preparing audio timing log is not a bounded regular file".into());
    }
    let file = std::fs::File::open(path)
        .map_err(|error| format!("Preparing audio timing log open: {error}"))?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file()
        || opened.len() != initial.len()
        || opened.modified().ok() != initial.modified().ok()
    {
        return Err("Preparing audio timing log changed before reading".into());
    }
    let mut bytes = String::with_capacity(opened.len() as usize);
    let mut bounded = file.take(limit.saturating_add(1));
    bounded
        .read_to_string(&mut bytes)
        .map_err(|error| format!("Preparing audio timing log read: {error}"))?;
    let finished = bounded
        .get_ref()
        .metadata()
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != opened.len()
        || finished.len() != opened.len()
        || finished.modified().ok() != opened.modified().ok()
    {
        return Err("Preparing audio timing log changed while reading".into());
    }
    Ok(Some(bytes))
}

fn preserved_audio_path(metadata: &AudioMeta, relative: &Path, stem: &str) -> bool {
    let expected = Path::new("content/segments").join(relative);
    if Path::new(metadata.path.as_str()) != expected {
        return false;
    }
    ["m4a", "ogg"].into_iter().any(|extension| {
        relative
            .file_name()
            .is_some_and(|name| name == format!("{stem}.{extension}").as_str())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "cap-gpui-preparing-audio-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn metadata(&self) -> RecordingMeta {
            let mut metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
                "pretty_name": "Timing snapshot",
                "segments": [{
                    "display": { "path": "content/segments/segment-0/display", "fps": 30 },
                    "mic": {
                        "path": "content/segments/segment-0/audio-input.m4a",
                        "start_time": 0.125,
                        "gap_summary": {
                            "total_overlap_trimmed_ms": 867,
                            "startup_overlap_trimmed_ms": 867,
                            "overlap_dropped_frames": 3,
                            "startup_overlap_drops": 3
                        }
                    },
                    "system_audio": {
                        "path": "content/segments/segment-0/system_audio.m4a",
                        "start_time": 0.25
                    }
                }]
            }))
            .unwrap();
            metadata.project_path = self.0.clone();
            metadata
        }

        fn log(&self) -> PathBuf {
            self.0.join("recording-logs.log")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repair_log() -> String {
        "segment{index=0}:mic-out: Dropping overlapping audio frame frame_count=1 overlap_ms=100\nsegment{index=0}:system-audio-out: Dropping overlapping audio frame frame_count=1 overlap_ms=50\n".repeat(3)
    }

    #[test]
    fn present_and_missing_timing_logs_admit_ordinary_zero_offsets() {
        let directory = TestDirectory::new();
        let metadata = directory.metadata();
        let absent = audio_timing(&metadata).unwrap();
        assert_eq!(absent.repairs.unwrap(), vec![Default::default()]);
        for text in [
            "",
            "Finalization finished 微phone\n",
            "overlap_ms=not-a-number\n",
        ] {
            std::fs::write(directory.log(), text).unwrap();
            let present = audio_timing(&metadata).unwrap();
            assert_eq!(present.repairs.unwrap(), vec![Default::default()]);
        }
    }

    #[test]
    fn stopped_timing_matches_ordinary_gap_clearing_and_nonzero_log_repairs() {
        let directory = TestDirectory::new();
        let metadata = directory.metadata();
        let before = serde_json::to_value(&metadata).unwrap();
        assert_eq!(
            cap_editor::segment_audio_timing_repairs(metadata.studio_meta().unwrap(), None)[0]
                .mic_offset_secs,
            -0.867
        );
        std::fs::write(directory.log(), repair_log()).unwrap();
        let snapshot = audio_timing(&metadata).unwrap();
        let mut finalized_value = before.clone();
        finalized_value["segments"][0]["mic"]
            .as_object_mut()
            .unwrap()
            .remove("gap_summary");
        let finalized: RecordingMeta = serde_json::from_value(finalized_value.clone()).unwrap();
        let ordinary_log = std::fs::read_to_string(directory.log()).unwrap();
        let ordinary = cap_editor::segment_audio_timing_repairs(
            finalized.studio_meta().unwrap(),
            Some(&ordinary_log),
        );
        assert_eq!(snapshot.repairs.as_ref().unwrap(), &ordinary);
        assert_eq!(ordinary[0].mic_offset_secs, -0.3);
        assert_eq!(ordinary[0].system_audio_offset_secs, -0.15);
        assert_eq!(
            serde_json::to_value(&snapshot.expected_metadata).unwrap(),
            finalized_value
        );
        assert_eq!(
            snapshot.expected_metadata.project_path,
            metadata.project_path
        );
        assert_eq!(serde_json::to_value(&metadata).unwrap(), before);
    }

    #[test]
    fn malformed_oversized_and_nonregular_logs_decline_audio_timing() {
        let directory = TestDirectory::new();
        let metadata = directory.metadata();
        std::fs::write(directory.log(), [0xff, 0xfe]).unwrap();
        assert!(audio_timing(&metadata).unwrap().repairs.is_none());
        let file = std::fs::File::create(directory.log()).unwrap();
        file.set_len(MAX_AUDIO_TIMING_LOG_BYTES + 1).unwrap();
        drop(file);
        assert!(audio_timing(&metadata).unwrap().repairs.is_none());
        std::fs::remove_file(directory.log()).unwrap();
        std::fs::create_dir(directory.log()).unwrap();
        assert!(audio_timing(&metadata).unwrap().repairs.is_none());
    }

    #[test]
    fn captured_timing_is_immutable_across_later_log_updates() {
        let directory = TestDirectory::new();
        let metadata = directory.metadata();
        let log = repair_log();
        std::fs::write(directory.log(), &log).unwrap();
        let snapshot = audio_timing(&metadata).unwrap();
        std::fs::write(directory.log(), format!("{log}Finalization published\n")).unwrap();
        assert_eq!(audio_timing(&metadata).unwrap().repairs, snapshot.repairs);
        std::fs::write(directory.log(), "different later contents").unwrap();
        assert_eq!(
            audio_timing(&metadata).unwrap().repairs.unwrap(),
            vec![Default::default()]
        );
        assert_eq!(snapshot.repairs.unwrap()[0].mic_offset_secs, -0.3);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_timing_log_is_not_admitted() {
        let directory = TestDirectory::new();
        let target = directory.0.join("target.log");
        std::fs::write(&target, repair_log()).unwrap();
        std::os::unix::fs::symlink(target, directory.log()).unwrap();
        assert!(
            audio_timing(&directory.metadata())
                .unwrap()
                .repairs
                .is_none()
        );
    }

    #[test]
    fn audio_admission_requires_the_unchanged_final_path_and_container_name() {
        let metadata = |path: &str| AudioMeta {
            path: path.into(),
            start_time: Some(0.0),
            device_id: None,
            gap_summary: None,
        };
        for extension in ["m4a", "ogg"] {
            let relative = PathBuf::from(format!("segment-0/audio-input.{extension}"));
            let meta = metadata(&format!("content/segments/{}", relative.display()));
            assert!(preserved_audio_path(&meta, &relative, "audio-input"));
            assert!(!preserved_audio_path(&meta, &relative, "system_audio"));
        }
        for path in [
            "segment-0/audio-input.mp3",
            "segment-0/audio-input/audio.m4a",
            "segment-0/audio-input.M4A",
        ] {
            assert!(!preserved_audio_path(
                &metadata(&format!("content/segments/{path}")),
                Path::new(path),
                "audio-input"
            ));
        }
        assert!(!preserved_audio_path(
            &metadata("content/segments/other/audio-input.m4a"),
            Path::new("segment-0/audio-input.m4a"),
            "audio-input"
        ));
    }
}
