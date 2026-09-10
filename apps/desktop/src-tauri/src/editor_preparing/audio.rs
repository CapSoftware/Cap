use super::*;
use cap_editor::PreparingAudioSegmentInput;
use cap_project::{AudioMeta, RecordingMeta, StudioRecordingMeta};
use cap_recording::recovery::PreparingAudioTrack;

const MAX_AUDIO_TIMING_LOG_BYTES: u64 = 4 * 1024 * 1024;

pub(super) struct AudioAdaptation {
    pub(super) tracks: Vec<PreparingAudioSegmentInput>,
    pub(super) expected_metadata: RecordingMeta,
}

pub(super) fn adapt_audio(
    sources: &Arc<PreparingStudioSources>,
    metadata: &RecordingMeta,
    control: &Arc<ConsumerControl>,
) -> Result<AudioAdaptation, String> {
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
    let expected_meta = expected_metadata
        .studio_meta()
        .ok_or("Preparing Studio metadata ended")?;
    // Clean Stop joins the synchronous writers of timing-repair lines; finalization can still append unrelated log events.
    let timing_log = read_timing_log(
        &metadata.project_path.join("recording-logs.log"),
        MAX_AUDIO_TIMING_LOG_BYTES,
    );
    let timing_eligible = timing_log.is_ok();
    if let Err(error) = &timing_log {
        tracing::debug!(%error, "Preparing audio timing requires ordinary loading");
    }
    let timing_log = timing_log.ok().flatten();
    let repairs = cap_editor::segment_audio_timing_repairs(expected_meta, timing_log.as_deref());
    let live = sources.live().ok_or("Preparing audio sources ended")?;
    let descriptors = live.segments().ok_or("Preparing audio sources ended")?;
    let mut tracks = Vec::with_capacity(descriptors.len());
    for (index, descriptor) in descriptors.iter().enumerate() {
        let repair = *repairs
            .get(index)
            .ok_or("Preparing audio timing layout changed")?;
        let track = |kind, stem| {
            if !timing_eligible {
                return None;
            }
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
        expected_metadata,
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

    #[test]
    fn timing_snapshot_preserves_utf8_and_distinguishes_absence_from_ineligible() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("recording-logs.log");
        assert_eq!(read_timing_log(&path, 100).unwrap(), None);
        let text = "微phone segment{index=0}:mic-out: Dropping overlapping audio frame frame_count=1 overlap_ms=100\n";
        std::fs::write(&path, text).unwrap();
        assert_eq!(
            read_timing_log(&path, text.len() as u64)
                .unwrap()
                .as_deref(),
            Some(text)
        );
        assert!(read_timing_log(&path, text.len() as u64 - 1).is_err());
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(read_timing_log(&path, 100).is_err());
        assert!(read_timing_log(root.path(), 100).is_err());
    }

    #[test]
    fn oversized_timing_log_is_declined_without_reading_its_payload() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("recording-logs.log");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_AUDIO_TIMING_LOG_BYTES + 1).unwrap();
        assert!(read_timing_log(&path, MAX_AUDIO_TIMING_LOG_BYTES).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn timing_log_symlink_is_ineligible() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.log");
        let path = root.path().join("recording-logs.log");
        std::fs::write(&target, "retained").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(read_timing_log(&path, 100).is_err());
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
