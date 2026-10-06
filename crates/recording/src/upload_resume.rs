use cap_enc_ffmpeg::segmented_stream::{SegmentCompletedEvent, SegmentMediaType};
use serde::Deserialize;
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub enum UploadLockError {
    Busy,
    Io(io::Error),
}

impl std::fmt::Display for UploadLockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => formatter.write_str("Another upload owns this recording"),
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for UploadLockError {}

impl From<io::Error> for UploadLockError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub struct UploadLock {
    _file: fs::File,
    project: PathBuf,
    #[cfg(unix)]
    owner_pid: libc::pid_t,
}

impl UploadLock {
    pub fn acquire(project: &Path) -> Result<Self, UploadLockError> {
        metadata(project, true).map_err(io::Error::other)?;
        let project = project.canonicalize()?;
        let parent = project
            .parent()
            .ok_or_else(|| io::Error::other("Recording has no parent directory"))?;
        let directory = parent.join(".upload-locks");
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        match builder.create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let directory_meta = metadata(&directory, true).map_err(io::Error::other)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if directory_meta.uid() != unsafe { libc::geteuid() }
                || directory_meta.permissions().mode() & 0o077 != 0
            {
                return Err(io::Error::other("Upload lock directory is not private").into());
            }
        }
        #[cfg(not(unix))]
        let _ = directory_meta;
        #[cfg(windows)]
        let identity = project.to_string_lossy().to_lowercase().into_bytes();
        #[cfg(not(windows))]
        let identity = project.as_os_str().as_encoded_bytes().to_vec();
        let path = directory.join(format!("{}.lock", blake3::hash(&identity).to_hex()));
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0).custom_flags(0x0020_0000);
        }
        let file = options.open(&path).map_err(|error| {
            if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) {
                UploadLockError::Busy
            } else {
                UploadLockError::Io(error)
            }
        })?;
        let file_meta = file.metadata()?;
        if !file_meta.is_file() || file_meta.len() != 0 {
            return Err(io::Error::other("Invalid upload lock file").into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if file_meta.file_attributes() & 0x400 != 0 {
                return Err(io::Error::other("Upload lock is a reparse point").into());
            }
        }
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
            if file_meta.nlink() != 1 || file_meta.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::other("Upload lock is not exclusively owned").into());
            }
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let error = io::Error::last_os_error();
                return Err(if error.kind() == io::ErrorKind::WouldBlock {
                    UploadLockError::Busy
                } else {
                    UploadLockError::Io(error)
                });
            }
        }
        let lock = Self {
            _file: file,
            project,
            #[cfg(unix)]
            owner_pid: unsafe { libc::getpid() },
        };
        metadata(&lock.project, true).map_err(io::Error::other)?;
        if lock.project.canonicalize()? != lock.project {
            return Err(
                io::Error::other("Recording identity changed while acquiring upload").into(),
            );
        }
        Ok(lock)
    }

    pub fn project_path(&self) -> &Path {
        &self.project
    }
}

#[cfg(unix)]
impl Drop for UploadLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        if self.owner_pid == unsafe { libc::getpid() }
            && unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) } != 0
        {
            tracing::warn!(error = %io::Error::last_os_error(), "Failed to release upload lock");
        }
    }
}

#[derive(Deserialize)]
struct Manifest {
    version: u32,
    #[serde(rename = "type")]
    kind: String,
    init_segment: String,
    segments: Vec<Segment>,
    is_complete: bool,
}

#[derive(Deserialize)]
struct Segment {
    path: String,
    index: u32,
    duration: f64,
    is_complete: bool,
    file_size: Option<u64>,
}

fn metadata(path: &Path, directory: bool) -> Result<fs::Metadata, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "{}: reparse points cannot be resumed",
                path.display()
            ));
        }
    }
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.len() == 0))
    {
        return Err(format!(
            "{}: invalid recording file or directory",
            path.display()
        ));
    }
    Ok(metadata)
}

pub fn collect_segment_events(
    recording_dir: &Path,
    required_audio: bool,
) -> Result<Vec<SegmentCompletedEvent>, String> {
    metadata(recording_dir, true)?;
    let content = recording_dir.join("content");
    metadata(&content, true)?;
    let mut events = collect_track(&content.join("display"), SegmentMediaType::Video)?;
    let audio = content.join("audio");
    match fs::symlink_metadata(&audio) {
        Ok(_) => {
            metadata(&audio, true)?;
            let empty = fs::read_dir(&audio)
                .map_err(|error| error.to_string())?
                .next()
                .is_none();
            if required_audio || !empty {
                events.extend(collect_track(&audio, SegmentMediaType::Audio)?);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !required_audio => {}
        Err(error) => return Err(format!("Required audio cannot be resumed: {error}")),
    }
    Ok(events)
}

fn collect_track(
    directory: &Path,
    media_type: SegmentMediaType,
) -> Result<Vec<SegmentCompletedEvent>, String> {
    metadata(directory, true)?;
    let manifest_path = directory.join("manifest.json");
    metadata(&manifest_path, false)?;
    let mut manifest: Manifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("{}: {error}", manifest_path.display()))?;
    let (version, kind, stream_kind) = match media_type {
        SegmentMediaType::Video => (5, "m4s_segments", ffmpeg::media::Type::Video),
        SegmentMediaType::Audio => (2, "m4s_audio_segments", ffmpeg::media::Type::Audio),
    };
    if manifest.version != version
        || manifest.kind != kind
        || !manifest.is_complete
        || manifest.init_segment != "init.mp4"
        || manifest.segments.is_empty()
    {
        return Err(format!(
            "{}: recording manifest is not complete or supported",
            manifest_path.display()
        ));
    }
    let init = directory.join(&manifest.init_segment);
    let init_size = metadata(&init, false)?.len();
    let input =
        ffmpeg::format::input(&init).map_err(|error| format!("{}: {error}", init.display()))?;
    if input.streams().best(stream_kind).is_none() {
        return Err(format!(
            "{}: required initialization stream is missing",
            init.display()
        ));
    }
    drop(input);
    let mut events = vec![SegmentCompletedEvent {
        path: init,
        index: 0,
        duration: 0.0,
        file_size: init_size,
        is_init: true,
        media_type,
    }];
    let mut listed = HashSet::new();
    manifest.segments.sort_by_key(|segment| segment.index);
    for (position, segment) in manifest.segments.into_iter().enumerate() {
        if u64::from(segment.index) != position as u64 + 1
            || segment.path != format!("segment_{:03}.m4s", segment.index)
            || !segment.is_complete
            || !segment.duration.is_finite()
            || segment.duration <= 0.0
            || !listed.insert(segment.path.clone())
        {
            return Err(format!(
                "{}: invalid or incomplete segment entry",
                manifest_path.display()
            ));
        }
        let file_size = segment.file_size.filter(|size| *size > 0).ok_or_else(|| {
            format!(
                "{}: completed segment has no recorded byte count",
                manifest_path.display()
            )
        })?;
        let path = directory.join(&segment.path);
        if metadata(&path, false)?.len() != file_size {
            return Err(format!(
                "{}: recorded segment size does not match",
                path.display()
            ));
        }
        if !cap_enc_ffmpeg::fragmented_mp4::tail_is_complete(&path)
            .map_err(|error| error.to_string())?
        {
            return Err(format!("{}: fragment is incomplete", path.display()));
        }
        events.push(SegmentCompletedEvent {
            path,
            index: segment.index,
            duration: segment.duration,
            file_size,
            is_init: false,
            media_type,
        });
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.ends_with(".m4s") && !listed.contains(name.as_ref())) || name.ends_with(".m4s.tmp")
        {
            return Err(format!(
                "{}: unlisted or unfinished recording media",
                entry.path().display()
            ));
        }
        let attributes = entry.file_type().map_err(|error| error.to_string())?;
        if attributes.is_symlink() {
            return Err(format!(
                "{}: linked recording input",
                entry.path().display()
            ));
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_enc_ffmpeg::{
        dash_audio::{DashAudioSegmentEncoder, DashAudioSegmentEncoderConfig},
        segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig},
    };
    use std::{path::PathBuf, sync::OnceLock, time::Duration};

    const ROUND_TRIP_DURATIONS: [(u64, &str, u64); 4] = [
        (2_017_793_167, "2.0177931669999998", 0x4000_2470_be72_dbae),
        (2_014_456_625, "2.0144566250000002", 0x4000_1d9b_6f5c_af2e),
        (2_013_162_750, "2.0131627500000002", 0x4000_1af5_1266_3412),
        (2_015_835_292, "2.0158352920000002", 0x4000_206e_40ea_19d4),
    ];

    #[test]
    fn legacy_manifest_durations_round_trip_without_changing_bits() {
        for (nanos, json, expected_bits) in ROUND_TRIP_DURATIONS {
            let live_duration = Duration::from_nanos(nanos).as_secs_f64();
            assert_eq!(live_duration.to_bits(), expected_bits);
            assert_eq!(serde_json::to_string(&live_duration).unwrap(), json);
            for (version, kind) in [(5, "m4s_segments"), (2, "m4s_audio_segments")] {
                let manifest_json = format!(
                    r#"{{"version":{version},"type":"{kind}","init_segment":"init.mp4","segments":[{{"path":"segment_001.m4s","index":1,"duration":{json},"is_complete":true,"file_size":1}}],"is_complete":true}}"#
                );
                let manifest: Manifest = serde_json::from_str(&manifest_json).unwrap();
                let mut duration = manifest.segments[0].duration;
                for _ in 0..16 {
                    assert_eq!(duration.to_bits(), expected_bits);
                    let serialized = serde_json::to_string(&duration).unwrap();
                    assert_eq!(serialized, json);
                    duration = serde_json::from_str(&serialized).unwrap();
                }
            }
        }
    }

    #[test]
    fn upload_lock_defers_other_owners_and_survives_bundle_deletion() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("recording.cap");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("original-media"), b"retained").unwrap();
        let first = UploadLock::acquire(&project).unwrap();
        assert!(matches!(
            UploadLock::acquire(&project),
            Err(UploadLockError::Busy)
        ));
        assert_eq!(
            fs::read(project.join("original-media")).unwrap(),
            b"retained"
        );
        fs::remove_dir_all(&project).unwrap();
        fs::create_dir(&project).unwrap();
        assert!(matches!(
            UploadLock::acquire(&project),
            Err(UploadLockError::Busy)
        ));
        drop(first);
        drop(UploadLock::acquire(&project).unwrap());
        assert_eq!(
            fs::read_dir(directory.path().join(".upload-locks"))
                .unwrap()
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn upload_lock_releases_despite_an_inherited_descriptor() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("recording.cap");
        fs::create_dir(&project).unwrap();
        let first = UploadLock::acquire(&project).unwrap();
        let inherited = first._file.try_clone().unwrap();
        drop(first);
        let second = UploadLock::acquire(&project).unwrap();
        drop(inherited);
        assert!(matches!(
            UploadLock::acquire(&project),
            Err(UploadLockError::Busy)
        ));
        drop(second);
    }

    #[cfg(unix)]
    #[test]
    fn upload_lock_rejects_a_linked_lock_directory() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project = directory.path().join("recording.cap");
        fs::create_dir(&project).unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join(".upload-locks")).unwrap();
        assert!(matches!(
            UploadLock::acquire(&project),
            Err(UploadLockError::Io(_))
        ));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn upload_lock_normalizes_windows_path_case() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("Recording.cap");
        fs::create_dir(&project).unwrap();
        let _first = UploadLock::acquire(&project).unwrap();
        let uppercase = PathBuf::from(project.to_string_lossy().to_uppercase());
        assert!(matches!(
            UploadLock::acquire(&uppercase),
            Err(UploadLockError::Busy)
        ));
    }

    fn fixture() -> tempfile::TempDir {
        static FILES: OnceLock<Vec<(PathBuf, Vec<u8>)>> = OnceLock::new();
        let files = FILES.get_or_init(|| {
            ffmpeg::init().unwrap();
            let project = tempfile::tempdir().unwrap();
            let display = project.path().join("content/display");
            let audio = project.path().join("content/audio");
            let video_info = cap_media_info::VideoInfo {
                pixel_format: cap_media_info::Pixel::NV12,
                width: 32,
                height: 32,
                time_base: ffmpeg::Rational(1, 1_000_000),
                frame_rate: ffmpeg::Rational(30, 1),
            };
            let mut video = SegmentedVideoEncoder::init(
                display.clone(),
                video_info,
                SegmentedVideoEncoderConfig::default(),
            )
            .unwrap();
            for index in 0..6 {
                let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 32, 32);
                for plane in 0..frame.planes() {
                    frame.data_mut(plane).fill(128);
                }
                video
                    .queue_frame(frame, Duration::from_nanos(index * 1_000_000_000 / 30))
                    .unwrap();
            }
            video.finish().unwrap();
            drop(video);
            let audio_info = cap_media_info::AudioInfo {
                sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                sample_rate: 48_000,
                channels: 1,
                time_base: ffmpeg::Rational(1, 48_000),
                buffer_size: 1024,
                is_wireless_transport: false,
            };
            let mut encoder = DashAudioSegmentEncoder::init(
                audio.clone(),
                audio_info,
                DashAudioSegmentEncoderConfig {
                    segment_duration: Duration::from_secs(3),
                },
            )
            .unwrap();
            for index in 0..6 {
                let mut frame = ffmpeg::frame::Audio::new(
                    audio_info.sample_format,
                    1024,
                    ffmpeg::ChannelLayout::MONO,
                );
                frame.set_rate(48_000);
                frame.data_mut(0).fill(0);
                encoder
                    .queue_frame(
                        frame,
                        Duration::from_nanos(index * 1024 * 1_000_000_000 / 48_000),
                    )
                    .unwrap();
            }
            encoder.finish().unwrap();
            drop(encoder);
            [display, audio]
                .into_iter()
                .flat_map(|directory| {
                    fs::read_dir(directory)
                        .unwrap()
                        .map(|entry| {
                            let path = entry.unwrap().path();
                            (
                                path.strip_prefix(project.path()).unwrap().to_path_buf(),
                                fs::read(path).unwrap(),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        });
        let project = tempfile::tempdir().unwrap();
        for (relative, bytes) in files {
            let path = project.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        project
    }

    fn edit_manifest(project: &Path, edit: impl FnOnce(&mut serde_json::Value)) {
        let path = project.join("content/display/manifest.json");
        let mut manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        edit(&mut manifest);
        fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn complete_059_manifest_shapes_keep_recorded_sizes_and_durations() {
        let project = fixture();
        let events = collect_segment_events(project.path(), true).unwrap();
        assert!(events.len() >= 4);
        for event in events.iter().filter(|event| !event.is_init) {
            let directory = event.path.parent().unwrap();
            let manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(directory.join("manifest.json")).unwrap())
                    .unwrap();
            let entry = manifest["segments"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["index"].as_u64() == Some(u64::from(event.index)))
                .unwrap();
            assert_eq!(entry["file_size"].as_u64(), Some(event.file_size));
            assert_eq!(entry["duration"].as_f64(), Some(event.duration));
        }
    }

    #[test]
    fn repeated_resume_preserves_live_durations_and_manifest_bytes() {
        for (nanos, json, expected_bits) in ROUND_TRIP_DURATIONS {
            let project = fixture();
            let mut manifests = Vec::new();
            for track in ["display", "audio"] {
                let path = project
                    .path()
                    .join("content")
                    .join(track)
                    .join("manifest.json");
                let mut manifest: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                manifest["segments"][0]["duration"] =
                    serde_json::json!(Duration::from_nanos(nanos).as_secs_f64());
                let bytes = serde_json::to_vec(&manifest).unwrap();
                fs::write(&path, &bytes).unwrap();
                manifests.push((path, bytes));
            }
            for _ in 0..3 {
                let events = collect_segment_events(project.path(), true).unwrap();
                for media_type in [SegmentMediaType::Video, SegmentMediaType::Audio] {
                    let segment = events
                        .iter()
                        .find(|event| {
                            !event.is_init && event.index == 1 && event.media_type == media_type
                        })
                        .unwrap();
                    assert_eq!(segment.duration.to_bits(), expected_bits);
                    assert_eq!(serde_json::to_string(&segment.duration).unwrap(), json);
                }
                for (path, bytes) in &manifests {
                    assert_eq!(&fs::read(path).unwrap(), bytes);
                }
            }
        }
    }

    #[test]
    fn changed_actual_length_cannot_replace_the_recorded_length() {
        for longer in [false, true] {
            let project = fixture();
            let path = project.path().join("content/display/segment_001.m4s");
            let mut bytes = fs::read(&path).unwrap();
            if longer {
                bytes.push(0);
            } else {
                let _ = bytes.pop();
            }
            fs::write(&path, &bytes).unwrap();
            assert!(collect_segment_events(project.path(), true).is_err());
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn missing_init_media_or_required_audio_returns_no_events() {
        for relative in [
            "content/display/init.mp4",
            "content/display/segment_001.m4s",
            "content/audio/init.mp4",
            "content/audio/segment_001.m4s",
        ] {
            let project = fixture();
            fs::remove_file(project.path().join(relative)).unwrap();
            assert!(collect_segment_events(project.path(), true).is_err());
        }
        let project = fixture();
        fs::remove_dir_all(project.path().join("content/audio")).unwrap();
        assert!(collect_segment_events(project.path(), true).is_err());
        assert!(collect_segment_events(project.path(), false).is_ok());
        fs::create_dir(project.path().join("content/audio")).unwrap();
        assert!(collect_segment_events(project.path(), false).is_ok());
        assert!(collect_segment_events(project.path(), true).is_err());
    }

    #[test]
    fn incomplete_escaping_and_size_less_entries_are_withheld() {
        for (pointer, value) in [
            ("/is_complete", serde_json::json!(false)),
            ("/segments/0/is_complete", serde_json::json!(false)),
            ("/segments/0/path", serde_json::json!("../segment_001.m4s")),
            ("/segments/0/path", serde_json::json!("/segment_001.m4s")),
            ("/segments/0/path", serde_json::json!("segment_1.m4s")),
            ("/segments/0/index", serde_json::json!(2)),
            ("/segments/0/duration", serde_json::json!(0)),
            ("/segments/0/file_size", serde_json::Value::Null),
            ("/segments/0/file_size", serde_json::json!(0)),
            ("/init_segment", serde_json::json!("../init.mp4")),
        ] {
            let project = fixture();
            edit_manifest(project.path(), |manifest| {
                *manifest.pointer_mut(pointer).unwrap() = value
            });
            assert!(
                collect_segment_events(project.path(), true).is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn unlisted_and_unfinished_media_are_withheld_but_sidecars_are_allowed() {
        for name in ["segment_999.m4s", "segment_999.m4s.tmp"] {
            let project = fixture();
            fs::write(
                project.path().join("content/display").join(name),
                b"retained",
            )
            .unwrap();
            assert!(collect_segment_events(project.path(), true).is_err());
        }
        let project = fixture();
        fs::write(
            project.path().join("content/display/diagnostic.log"),
            b"diagnostic",
        )
        .unwrap();
        assert!(collect_segment_events(project.path(), true).is_ok());
    }

    #[test]
    fn duplicate_indices_and_corrupt_init_are_withheld() {
        let project = fixture();
        edit_manifest(project.path(), |manifest| {
            let duplicate = manifest["segments"][0].clone();
            manifest["segments"].as_array_mut().unwrap().push(duplicate);
        });
        assert!(collect_segment_events(project.path(), true).is_err());
        let project = fixture();
        fs::write(
            project.path().join("content/display/init.mp4"),
            b"corrupt init",
        )
        .unwrap();
        assert!(collect_segment_events(project.path(), true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linked_manifest_init_fragment_and_track_are_withheld() {
        for relative in [
            "content/display/manifest.json",
            "content/display/init.mp4",
            "content/display/segment_001.m4s",
            "content/audio",
        ] {
            let project = fixture();
            let original = project.path().join(relative);
            let target = project.path().join("retained-original");
            fs::rename(&original, &target).unwrap();
            std::os::unix::fs::symlink(&target, &original).unwrap();
            assert!(collect_segment_events(project.path(), true).is_err());
            assert!(target.exists());
            assert!(
                fs::symlink_metadata(original)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }
    }
}
