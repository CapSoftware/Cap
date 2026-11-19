use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use cap_project::{
    AUDIO_ONLY_CANVAS_ENCODERS, AUDIO_ONLY_CANVAS_FPS, AUDIO_ONLY_CANVAS_HEIGHT,
    AUDIO_ONLY_CANVAS_WIDTH, AudioMeta, Cursors, MultipleSegment, MultipleSegments, Platform,
    RecordingMeta, RecordingMetaInner, StudioRecordingMeta, StudioRecordingStatus, VideoMeta,
};

const SEGMENT_DIR: &str = "content/segments/segment-0";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AudioProjectSources {
    pub microphone: Option<PathBuf>,
    pub system_audio: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum AudioProjectError {
    #[error("Choose at least one audio file")]
    NoSources,
    #[error("{} already exists", .0.display())]
    Exists(PathBuf),
    #[error("Could not read {}: {reason}", path.display())]
    Unreadable { path: PathBuf, reason: String },
    #[error("{0}")]
    Io(String),
    #[error("Could not write the project's placeholder video: {0}")]
    Placeholder(String),
}

/// Creates `project_path` as an audio-only Studio project from `sources` and
/// returns its metadata. The files are hard-linked when they share a volume
/// with the project and copied otherwise, so the project stays whole when the
/// originals are deleted. Nothing is left behind when a step fails.
pub fn create_audio_only_project(
    project_path: &Path,
    pretty_name: &str,
    sources: &AudioProjectSources,
) -> Result<RecordingMeta, AudioProjectError> {
    let _ = ffmpeg::init();
    let tracks = [
        (sources.microphone.as_deref(), "audio-input"),
        (sources.system_audio.as_deref(), "system_audio"),
    ];
    if tracks.iter().all(|(source, _)| source.is_none()) {
        return Err(AudioProjectError::NoSources);
    }
    let duration = tracks
        .iter()
        .filter_map(|(source, _)| *source)
        .map(audio_duration)
        .try_fold(Duration::ZERO, |longest, duration| {
            duration.map(|duration| longest.max(duration))
        })?;

    if let Some(parent) = project_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| io(parent, error))?;
    }
    // Claimed exclusively before cleanup is armed, so a failure here can only
    // ever remove a folder this call created.
    match std::fs::create_dir(project_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(AudioProjectError::Exists(project_path.to_path_buf()));
        }
        Err(error) => return Err(io(project_path, error)),
    }
    let mut cleanup = RemoveOnDrop(Some(project_path.to_path_buf()));
    let segment_dir = project_path.join(SEGMENT_DIR);
    std::fs::create_dir_all(&segment_dir).map_err(|error| io(&segment_dir, error))?;

    let mut audio = [None, None];
    for (slot, (source, stem)) in audio.iter_mut().zip(tracks) {
        let Some(source) = source else {
            continue;
        };
        let extension = source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("m4a")
            .to_ascii_lowercase();
        let name = format!("{stem}.{extension}");
        link_or_copy(source, &segment_dir.join(&name))?;
        *slot = Some(AudioMeta {
            path: format!("{SEGMENT_DIR}/{name}").into(),
            start_time: Some(0.0),
            device_id: None,
            gap_summary: None,
            digital_silence_ms: None,
        });
    }
    let [mic, system_audio] = audio;

    write_placeholder(&segment_dir.join("display.mp4"), duration)?;

    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_path.to_path_buf(),
        pretty_name: pretty_name.to_string(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: VideoMeta {
                        path: format!("{SEGMENT_DIR}/display.mp4").into(),
                        fps: AUDIO_ONLY_CANVAS_FPS,
                        start_time: Some(0.0),
                        device_id: None,
                    },
                    camera: None,
                    mic,
                    system_audio,
                    cursor: None,
                    keyboard: None,
                    display_notch: None,
                    cursor_shape_version: None,
                }],
                cursors: Cursors::default(),
                status: Some(StudioRecordingStatus::Complete),
                cursor_shape_version: cap_project::CURSOR_SHAPE_VERSION,
                audio_only: true,
            },
        })),
        upload: None,
    };
    cap_project::ProjectConfiguration::for_new_project()
        .write(project_path)
        .map_err(|error| io(project_path, error))?;
    meta.save_for_project()
        .map_err(|error| AudioProjectError::Io(format!("Could not save the project: {error:?}")))?;
    cleanup.0 = None;
    Ok(meta)
}

struct RemoveOnDrop(Option<PathBuf>);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

fn io(path: &Path, error: std::io::Error) -> AudioProjectError {
    AudioProjectError::Io(format!("{}: {error}", path.display()))
}

fn audio_duration(path: &Path) -> Result<Duration, AudioProjectError> {
    let unreadable = |reason: String| AudioProjectError::Unreadable {
        path: path.to_path_buf(),
        reason,
    };
    let input = ffmpeg::format::input(&path).map_err(|error| unreadable(error.to_string()))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| unreadable("it has no audio".into()))?;
    let stream_seconds =
        (stream.duration() > 0).then(|| stream.duration() as f64 * f64::from(stream.time_base()));
    let container_seconds = (input.duration() > 0)
        .then(|| input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE));
    stream_seconds
        .or(container_seconds)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map(Duration::from_secs_f64)
        .ok_or_else(|| unreadable("its length is unknown".into()))
}

fn link_or_copy(source: &Path, destination: &Path) -> Result<(), AudioProjectError> {
    if std::fs::hard_link(source, destination).is_ok() {
        return Ok(());
    }
    std::fs::copy(source, destination)
        .map(|_| ())
        .map_err(|error| io(source, error))
}

fn write_placeholder(path: &Path, duration: Duration) -> Result<(), AudioProjectError> {
    cap_enc_ffmpeg::standin::write_black_standin(
        path,
        AUDIO_ONLY_CANVAS_WIDTH,
        AUDIO_ONLY_CANVAS_HEIGHT,
        AUDIO_ONLY_CANVAS_FPS,
        duration,
        AUDIO_ONLY_CANVAS_ENCODERS,
    )
    .map_err(AudioProjectError::Placeholder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_needs_audio() {
        let dir = tempfile::tempdir().unwrap();
        let result = create_audio_only_project(
            &dir.path().join("x.cap"),
            "x",
            &AudioProjectSources::default(),
        );
        assert!(matches!(result, Err(AudioProjectError::NoSources)));
        assert!(!dir.path().join("x.cap").exists());
    }

    fn write_tone(path: &Path, seconds: f64) {
        let rate = 48_000u32;
        let frames = (seconds * f64::from(rate)) as u32;
        let mut bytes = Vec::with_capacity(44 + frames as usize * 4);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + frames * 4).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 4).to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(frames * 4).to_le_bytes());
        for frame in 0..frames {
            let t = f64::from(frame) / f64::from(rate);
            let value = ((t * 440.0 * std::f64::consts::TAU).sin() * 12_000.0) as i16;
            bytes.extend_from_slice(&value.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn media_seconds(path: &Path) -> f64 {
        let input = ffmpeg::format::input(&path).unwrap();
        input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE)
    }

    #[test]
    fn a_project_from_audio_has_an_exact_length_placeholder() {
        let dir = tempfile::tempdir().unwrap();
        let tone = dir.path().join("mic.wav");
        write_tone(&tone, 3.2);
        let project = dir.path().join("Meeting.cap");
        let meta = create_audio_only_project(
            &project,
            "Meeting",
            &AudioProjectSources {
                microphone: Some(tone.clone()),
                system_audio: None,
            },
        )
        .unwrap();

        let studio = meta.studio_meta().unwrap();
        assert!(studio.is_audio_only());
        let reread = RecordingMeta::load_for_project(&project).unwrap();
        assert!(reread.studio_meta().unwrap().is_audio_only());
        assert_eq!(reread.pretty_name, "Meeting");
        let StudioRecordingMeta::MultipleSegments { inner } = studio else {
            panic!("multiple segments expected");
        };
        let segment = &inner.segments[0];
        assert!(segment.system_audio.is_none());
        assert!(
            project
                .join(segment.mic.as_ref().unwrap().path.as_str())
                .is_file()
        );
        let display = media_seconds(&project.join(segment.display.path.as_str()));
        assert!((display - 3.2).abs() < 0.05, "placeholder {display}");
        let recordings = cap_rendering::ProjectRecordingsMeta::new(&project, studio).unwrap();
        assert!((recordings.segments[0].display.duration - 3.2).abs() < 0.05);
        assert!(
            create_audio_only_project(
                &project,
                "Meeting",
                &AudioProjectSources {
                    microphone: Some(tone),
                    system_audio: None,
                },
            )
            .is_err()
        );
        assert!(project.join("recording-meta.json").is_file());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_project_from_audio_exports_mp3_and_wav_of_the_same_length() {
        let dir = tempfile::tempdir().unwrap();
        let mic = dir.path().join("mic.wav");
        let system = dir.path().join("system.wav");
        write_tone(&mic, 4.0);
        write_tone(&system, 3.0);
        let project = dir.path().join("Call.cap");
        create_audio_only_project(
            &project,
            "Call",
            &AudioProjectSources {
                microphone: Some(mic),
                system_audio: Some(system),
            },
        )
        .unwrap();

        for format in crate::audio::AudioExportFormat::ALL {
            let output = dir.path().join(format!("Call.{}", format.extension()));
            let written = crate::audio::export_audio(
                project.clone(),
                None,
                format,
                output.clone(),
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                |_| {},
            )
            .await
            .unwrap();
            assert_eq!(written, output);
            let seconds = media_seconds(&output);
            assert!((seconds - 4.0).abs() < 0.1, "{format:?} lasts {seconds}");
            let size = std::fs::metadata(&output).unwrap().len();
            let estimate = format.estimated_bytes(4.0);
            assert!(
                size.abs_diff(estimate) < estimate / 20 + 8_192,
                "{format:?} is {size} bytes, estimate {estimate}"
            );
            let leftovers = std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".partial."))
                .count();
            assert_eq!(leftovers, 0);
        }
    }

    #[test]
    fn a_folder_someone_else_holds_is_never_touched() {
        let dir = tempfile::tempdir().unwrap();
        let tone = dir.path().join("tone.wav");
        write_tone(&tone, 1.0);
        let project = dir.path().join("x.cap");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("theirs.txt"), b"keep").unwrap();
        let result = create_audio_only_project(
            &project,
            "x",
            &AudioProjectSources {
                microphone: Some(tone),
                system_audio: None,
            },
        );
        assert!(matches!(result, Err(AudioProjectError::Exists(_))));
        assert_eq!(std::fs::read(project.join("theirs.txt")).unwrap(), b"keep");
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 1);
    }

    #[test]
    fn an_unreadable_file_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("bogus.wav");
        std::fs::write(&bogus, b"not audio").unwrap();
        let project = dir.path().join("x.cap");
        let result = create_audio_only_project(
            &project,
            "x",
            &AudioProjectSources {
                microphone: Some(bogus),
                system_audio: None,
            },
        );
        assert!(matches!(result, Err(AudioProjectError::Unreadable { .. })));
        assert!(!project.exists());
    }
}
