//! Studio recordings left `NeedsRemux` (the remux after stop never ran or did
//! not finish), at the fragment counts real recordings reach, and every way a
//! recovery publication can be cut short. Issue #4135.

use super::*;
use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};
use std::fs;

const DISPLAY: &str = "content/segments/segment-0/display";

fn encode_display(display: &Path, fragments: usize) {
    ffmpeg::init().unwrap();
    let mut encoder = SegmentedVideoEncoder::init(
        display.to_path_buf(),
        cap_media_info::VideoInfo {
            pixel_format: cap_media_info::Pixel::NV12,
            width: 320,
            height: 240,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(10, 1),
        },
        SegmentedVideoEncoderConfig {
            segment_duration: Duration::from_millis(300),
            ..Default::default()
        },
    )
    .unwrap();
    // Three frames per fragment, each fragment opening on a keyframe.
    for index in 0..fragments * 3 {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
        frame.data_mut(0).fill(16 + (index % 200) as u8);
        frame.data_mut(1).fill(128);
        if index % 3 == 0 {
            frame.set_kind(ffmpeg::picture::Type::I);
        }
        encoder
            .queue_frame(frame, Duration::from_millis(index as u64 * 100))
            .unwrap();
    }
    encoder.finish().unwrap();
}

/// A Studio project exactly as the recorder leaves it when the remux after
/// stop does not run: the metadata points at the fragment directory and says
/// `NeedsRemux`. The manifest fields are what every release since 0.6.0
/// writes.
fn needs_remux_project(parent: &Path, name: &str, fragments: usize) -> PathBuf {
    let project = parent.join(name);
    encode_display(&project.join(DISPLAY), fragments);
    let project = project.canonicalize().unwrap();
    RecordingMeta {
        platform: None,
        project_path: project.clone(),
        pretty_name: name.into(),
        sharing: None,
        upload: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: VideoMeta {
                        path: DISPLAY.into(),
                        fps: 10,
                        start_time: None,
                        device_id: None,
                    },
                    camera: None,
                    mic: None,
                    system_audio: None,
                    cursor: None,
                    keyboard: None,
                    display_notch: None,
                }],
                cursors: Cursors::default(),
                status: Some(StudioRecordingStatus::NeedsRemux),
            },
        })),
    }
    .save_for_project()
    .unwrap();
    ProjectConfiguration::default().write(&project).unwrap();
    assert_eq!(fragment_names(&project.join(DISPLAY)).len(), fragments);
    project
}

fn fragment_names(display: &Path) -> Vec<String> {
    let mut paths = fs::read_dir(display)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| RecoveryManager::m4s_fragment_index(path).is_some())
        .collect::<Vec<_>>();
    cap_enc_ffmpeg::fragment_order::sort_fragment_paths(&mut paths);
    paths
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect()
}

fn workspaces(project: &Path) -> Vec<PathBuf> {
    fs::read_dir(project)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".recovery-")
        })
        .collect()
}

/// Backups of original media still on disk. A finished remux deletes its backup
/// and keeps only the publication receipt.
fn original_backups(project: &Path) -> Vec<PathBuf> {
    workspaces(project)
        .into_iter()
        .filter(|workspace| workspace.join("original-segments").exists())
        .collect()
}

fn video_packets(path: &Path) -> usize {
    let mut input = ffmpeg::format::input(path).unwrap();
    let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
    let index = stream.index();
    input
        .packets()
        .filter(|(stream, _)| stream.index() == index)
        .count()
}

fn status(project: &Path) -> StudioRecordingStatus {
    RecordingMeta::load_for_project(project)
        .unwrap()
        .studio_meta()
        .unwrap()
        .status()
}

/// Video packets in a remux of the untouched recording (the init segment and
/// every fragment but `skip`), made outside the project with the same
/// concatenation finalization uses, so recovery is held to exactly what the
/// remux itself produces on this platform.
fn recorded_frames(project: &Path, skip: Option<&str>) -> usize {
    let display = project.join(DISPLAY);
    let fragments = fragment_names(&display)
        .into_iter()
        .filter(|name| Some(name.as_str()) != skip)
        .map(|name| display.join(name))
        .collect::<Vec<_>>();
    let scratch = tempfile::tempdir().unwrap();
    let reference = scratch.path().join("reference.mp4");
    cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init_validated(
        &display.join("init.mp4"),
        &fragments,
        &reference,
    )
    .unwrap();
    video_packets(&reference)
}

fn remuxed_frames(project: &Path) -> usize {
    assert!(matches!(status(project), StudioRecordingStatus::Complete));
    video_packets(&project.join("content/segments/segment-0/display.mp4"))
}

/// What the editor reads: the metadata, the config and every media byte.
fn layout(project: &Path) -> RecoverySnapshot {
    recovery_snapshot(project).unwrap()
}

fn finalize_publishing_with(
    project: &Path,
    rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<RecoveredRecording, RecoveryError> {
    let incomplete = RecoveryManager::inspect_recording(project).unwrap();
    let mut rename = Some(rename);
    RecoveryManager::finalize_with_publication(
        &incomplete,
        RecoveryPurpose::Finalize,
        copy_recovery_input_with_durability,
        |_, _| Ok(()),
        |project, workspace| publish_recovery_with(project, workspace, rename.take().unwrap()),
        RecoveryLock::acquire,
        None,
    )
}

/// Cuts a publication short after `renames` renames, as a crash or a force
/// quit would, leaving its journal behind.
fn kill_publication_after(project: &Path, renames: usize) {
    let mut calls = 0;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        finalize_publishing_with(project, |source, destination| {
            assert_ne!(calls, renames, "killed before rename {}", calls + 1);
            calls += 1;
            std::fs::rename(source, destination)
        })
    }));
    assert!(result.is_err(), "the publication was not interrupted");
    assert!(project.join(RECOVERY_PUBLICATION).is_file());
}

#[test]
fn needs_remux_recordings_of_every_size_validate_and_remux_in_order() {
    for fragments in [1, 999, 1000, 1356, 5000] {
        let temporary = tempfile::tempdir().unwrap();
        let project = needs_remux_project(
            temporary.path(),
            &format!("Cap {fragments} Café 録画 - Copy (2)"),
            fragments,
        );
        validate_recovery_manifests(&project.join("content"), true).unwrap();
        let recorded = recorded_frames(&project, None);
        let incomplete = RecoveryManager::inspect_recording(&project).unwrap();
        let display = &incomplete.recoverable_segments[0].display_fragments;
        assert_eq!(display.len(), fragments);
        let indexes = display
            .iter()
            .map(|path| RecoveryManager::m4s_fragment_index(path).unwrap())
            .collect::<Vec<_>>();
        assert!(
            indexes.windows(2).all(|pair| pair[0] < pair[1]),
            "{fragments}"
        );
        assert_eq!(RecoveryManager::remux_if_needed(&project).unwrap(), true);
        assert_eq!(remuxed_frames(&project), recorded, "{fragments}");
        assert!(original_backups(&project).is_empty());
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
    }
}

#[test]
fn torn_missing_or_unlisted_tails_still_remux_and_mid_recording_damage_is_refused_untouched() {
    let temporary = tempfile::tempdir().unwrap();
    let make = |name: &str| needs_remux_project(temporary.path(), name, 1356);

    let partial = make("partial last fragment");
    let recorded = recorded_frames(&partial, Some("segment_1356.m4s"));
    let last = partial.join(DISPLAY).join("segment_1356.m4s");
    let bytes = fs::read(&last).unwrap();
    fs::write(&last, &bytes[..bytes.len() / 2]).unwrap();
    assert_eq!(RecoveryManager::remux_if_needed(&partial).unwrap(), true);
    assert_eq!(remuxed_frames(&partial), recorded);

    let missing = make("missing last fragment");
    let recorded = recorded_frames(&missing, Some("segment_1356.m4s"));
    fs::remove_file(missing.join(DISPLAY).join("segment_1356.m4s")).unwrap();
    assert_eq!(RecoveryManager::remux_if_needed(&missing).unwrap(), true);
    assert_eq!(remuxed_frames(&missing), recorded);

    let unlisted = make("missing manifest");
    let recorded = recorded_frames(&unlisted, None);
    fs::remove_file(unlisted.join(DISPLAY).join("manifest.json")).unwrap();
    assert_eq!(RecoveryManager::remux_if_needed(&unlisted).unwrap(), true);
    assert_eq!(remuxed_frames(&unlisted), recorded);

    let damaged = make("damaged middle fragment");
    let middle = damaged.join(DISPLAY).join("segment_700.m4s");
    let bytes = fs::read(&middle).unwrap();
    fs::write(&middle, &bytes[..bytes.len() / 2]).unwrap();
    let before = layout(&damaged);
    let error = RecoveryManager::remux_if_needed(&damaged).unwrap_err();
    assert!(error.to_string().contains("segment_700.m4s"), "{error}");
    assert_eq!(layout(&damaged), before);
    assert!(workspaces(&damaged).is_empty());

    let no_meta = make("metadata None");
    fs::remove_file(no_meta.join("recording-meta.json")).unwrap();
    let before = layout(&no_meta);
    assert!(RecoveryManager::inspect_recording(&no_meta).is_none());
    assert_eq!(RecoveryManager::remux_if_needed(&no_meta).unwrap(), false);
    RecoveryManager::restore_interrupted_recovery(&no_meta).unwrap();
    assert_eq!(layout(&no_meta), before);
}

#[test]
fn a_publication_killed_at_any_step_relaunches_to_the_original_layout() {
    for renames in 0..=3 {
        let temporary = tempfile::tempdir().unwrap();
        let project = needs_remux_project(temporary.path(), "killed", 40);
        let recorded = recorded_frames(&project, None);
        let before = layout(&project);
        if renames == 0 {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let incomplete = RecoveryManager::inspect_recording(&project).unwrap();
                RecoveryManager::finalize_with_operations(
                    &incomplete,
                    RecoveryPurpose::Finalize,
                    |_, _, _| panic!("killed while staging"),
                    |_, _| Ok(()),
                )
            }));
            assert!(result.is_err());
        } else {
            kill_publication_after(&project, renames);
        }
        RecoveryManager::restore_interrupted_recovery(&project).unwrap();
        assert_eq!(layout(&project), before, "killed after {renames} renames");
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
        assert!(matches!(
            status(&project),
            StudioRecordingStatus::NeedsRemux
        ));
        assert_eq!(
            RecoveryManager::inspect_recording(&project)
                .unwrap()
                .recoverable_segments[0]
                .display_fragments
                .len(),
            40
        );
        assert_eq!(RecoveryManager::remux_if_needed(&project).unwrap(), true);
        assert_eq!(remuxed_frames(&project), recorded);
    }
}

#[test]
fn a_rollback_killed_at_any_step_relaunches_to_the_original_layout() {
    // Publication renames are 1 (segments out), 2 (recovered segments in),
    // 3 (config), 4 (metadata). A failure at 3 or 4 rolls back with up to
    // three more renames; a kill can land after any of them.
    for failure in 2..=4 {
        for killed_after in failure..=failure + 3 {
            let temporary = tempfile::tempdir().unwrap();
            let project = needs_remux_project(temporary.path(), "rollback killed", 20);
            let before = layout(&project);
            let mut calls = 0;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                finalize_publishing_with(&project, |source, destination| {
                    calls += 1;
                    if calls == failure {
                        return Err(std::io::Error::other("injected sharing violation"));
                    }
                    assert!(calls <= killed_after, "killed during rollback");
                    std::fs::rename(source, destination)
                })
            }));
            let _ = result;
            RecoveryManager::restore_interrupted_recovery(&project).unwrap();
            assert_eq!(
                layout(&project),
                before,
                "failure at {failure}, killed after {killed_after}"
            );
            assert!(!project.join(RECOVERY_PUBLICATION).exists());
        }
    }
}

#[test]
fn a_failed_publication_rolls_back_and_leaves_no_copy_behind() {
    for failure in 1..=4 {
        let temporary = tempfile::tempdir().unwrap();
        let project = needs_remux_project(temporary.path(), "rolled back", 20);
        let before = layout(&project);
        let mut calls = 0;
        let error = finalize_publishing_with(&project, |source, destination| {
            calls += 1;
            if calls == failure {
                return Err(std::io::Error::other("injected sharing violation"));
            }
            std::fs::rename(source, destination)
        })
        .unwrap_err();
        assert!(error.to_string().contains("injected"), "{error}");
        assert_eq!(layout(&project), before, "failure at rename {failure}");
        assert!(
            workspaces(&project).is_empty(),
            "failure at rename {failure}"
        );
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
    }
}

#[test]
fn a_rollback_that_windows_refuses_is_finished_by_the_next_open() {
    for failure in 2..=4 {
        let temporary = tempfile::tempdir().unwrap();
        let project = needs_remux_project(temporary.path(), "rollback refused", 20);
        let recorded = recorded_frames(&project, None);
        let before = layout(&project);
        let mut calls = 0;
        let error = finalize_publishing_with(&project, |source, destination| {
            calls += 1;
            if calls >= failure {
                return Err(std::io::Error::other("injected sharing violation"));
            }
            std::fs::rename(source, destination)
        })
        .unwrap_err();
        if failure > 2 {
            assert!(error.to_string().contains("rollback failed"), "{error}");
            assert!(project.join(RECOVERY_PUBLICATION).is_file());
        }
        RecoveryManager::restore_interrupted_recovery(&project).unwrap();
        assert_eq!(layout(&project), before, "failure at rename {failure}");
        assert!(!project.join(RECOVERY_PUBLICATION).exists());
        assert_eq!(RecoveryManager::remux_if_needed(&project).unwrap(), true);
        assert_eq!(remuxed_frames(&project), recorded);
    }
}

/// The layout 0.6.3 leaves behind: the recovered segments were installed, the
/// metadata never was, and its reconciliation then finished the journal, so
/// nothing would ever roll it back.
fn stranded_by_an_older_build(project: &Path, renames: usize) -> PathBuf {
    kill_publication_after(project, renames);
    fs::remove_file(project.join(RECOVERY_PUBLICATION)).unwrap();
    let [workspace] = workspaces(project).try_into().unwrap();
    workspace
}

fn mark_failed(project: &Path) {
    let mut meta = RecordingMeta::load_for_project(project).unwrap();
    if let RecordingMetaInner::Studio(studio) = &mut meta.inner
        && let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut()
    {
        inner.status = Some(StudioRecordingStatus::Failed {
            error: "No recoverable segments found".into(),
        });
    }
    meta.save_for_project().unwrap();
}

#[test]
fn projects_an_older_build_stranded_are_restored_and_open_again() {
    #[derive(Debug, Clone, Copy)]
    enum Variant {
        SegmentsInstalled,
        ConfigInstalled,
        SegmentsMissing,
        MarkedFailed,
        EmptyDisplayLeftOver,
        SecondAttemptBackup,
        ReadOnlyMedia,
    }
    for variant in [
        Variant::SegmentsInstalled,
        Variant::ConfigInstalled,
        Variant::SegmentsMissing,
        Variant::MarkedFailed,
        Variant::EmptyDisplayLeftOver,
        Variant::SecondAttemptBackup,
        Variant::ReadOnlyMedia,
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let project = needs_remux_project(temporary.path(), "Cap Ünïcode - Copy (2)", 30);
        let recorded = recorded_frames(&project, None);
        let original_meta = fs::read(project.join("recording-meta.json")).unwrap();
        let before = layout(&project);
        if matches!(variant, Variant::ReadOnlyMedia) {
            for entry in fs::read_dir(project.join(DISPLAY)).unwrap().flatten() {
                let mut permissions = entry.metadata().unwrap().permissions();
                permissions.set_readonly(true);
                fs::set_permissions(entry.path(), permissions).unwrap();
            }
        }
        let renames = match variant {
            Variant::SegmentsMissing => 1,
            Variant::ConfigInstalled => 3,
            _ => 2,
        };
        let workspace = stranded_by_an_older_build(&project, renames);
        match variant {
            Variant::MarkedFailed => mark_failed(&project),
            Variant::EmptyDisplayLeftOver => {
                fs::create_dir_all(project.join(DISPLAY)).unwrap();
            }
            Variant::SecondAttemptBackup => {
                let second = project.join(format!(".recovery-{}", uuid::Uuid::new_v4()));
                create_private_recovery_dir(&second).unwrap();
                copy_recovery_input(
                    &project.join("content/segments"),
                    &second.join("original-segments"),
                )
                .unwrap();
                fs::write(second.join("original-recording-meta.json"), &original_meta).unwrap();
            }
            _ => {}
        }
        if !matches!(variant, Variant::SegmentsMissing) {
            assert!(
                editor_cannot_find_display(&project),
                "{variant:?} is not stranded"
            );
        }

        RecoveryManager::restore_interrupted_recovery(&project).unwrap();

        let after = layout(&project);
        for (path, digest) in &before {
            if path.starts_with("content") {
                assert_eq!(after.get(path), Some(digest), "{variant:?} {path:?}");
            }
        }
        assert_eq!(
            fs::read(project.join("recording-meta.json")).unwrap(),
            original_meta,
            "{variant:?}"
        );
        assert_eq!(
            layout(&project).get(Path::new("project-config.json")),
            before.get(Path::new("project-config.json")),
            "{variant:?}"
        );
        assert!(!editor_cannot_find_display(&project), "{variant:?}");
        if !matches!(variant, Variant::SegmentsMissing) {
            assert!(
                workspace
                    .join("displaced-segments/segment-0/display.mp4")
                    .is_file(),
                "{variant:?}: the recovered output is kept, not deleted"
            );
        }
        // Settled: opening again changes nothing.
        let settled = layout(&project);
        RecoveryManager::restore_interrupted_recovery(&project).unwrap();
        assert_eq!(layout(&project), settled, "{variant:?}");
        if matches!(variant, Variant::ReadOnlyMedia) {
            for entry in fs::read_dir(project.join(DISPLAY)).unwrap().flatten() {
                let mut permissions = entry.metadata().unwrap().permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                fs::set_permissions(entry.path(), permissions).unwrap();
            }
        }
        assert_eq!(RecoveryManager::remux_if_needed(&project).unwrap(), true);
        assert_eq!(remuxed_frames(&project), recorded, "{variant:?}");
    }
}

fn editor_cannot_find_display(project: &Path) -> bool {
    let display = project.join(DISPLAY);
    !display.is_dir() || fragment_names(&display).is_empty()
}

#[test]
fn a_restore_killed_at_any_step_finishes_on_the_next_open() {
    // Restoration writes the original metadata, then moves the project's
    // segments aside, then moves the backup in. Rebuild each intermediate
    // state by hand and reopen it.
    for step in 0..=2 {
        let temporary = tempfile::tempdir().unwrap();
        let project = needs_remux_project(temporary.path(), "restore killed", 12);
        let original_meta = fs::read(project.join("recording-meta.json")).unwrap();
        let before = layout(&project);
        let workspace = stranded_by_an_older_build(&project, 2);
        mark_failed(&project);
        if step >= 1 {
            fs::write(project.join("recording-meta.json"), &original_meta).unwrap();
        }
        if step >= 2 {
            fs::rename(
                project.join("content/segments"),
                workspace.join("displaced-segments"),
            )
            .unwrap();
        }
        RecoveryManager::restore_interrupted_recovery(&project).unwrap();
        assert_eq!(layout(&project), before, "killed after step {step}");
    }
}

#[test]
fn restoration_leaves_settled_and_repaired_projects_alone() {
    let temporary = tempfile::tempdir().unwrap();

    // A finished remux whose backup was kept for a preparing editor.
    let committed = needs_remux_project(temporary.path(), "committed", 10);
    let recorded = recorded_frames(&committed, None);
    let incomplete = RecoveryManager::inspect_recording(&committed).unwrap();
    RecoveryManager::finalize_with_publication(
        &incomplete,
        RecoveryPurpose::Finalize,
        copy_recovery_input_with_durability,
        |_, _| Ok(()),
        publish_recovery,
        RecoveryLock::acquire,
        None,
    )
    .unwrap();
    assert_eq!(workspaces(&committed).len(), 1);
    let settled = layout(&committed);
    RecoveryManager::restore_interrupted_recovery(&committed).unwrap();
    assert_eq!(layout(&committed), settled);
    assert_eq!(remuxed_frames(&committed), recorded);

    // A user who already copied their fragments back by hand.
    let repaired = needs_remux_project(temporary.path(), "repaired", 10);
    let workspace = stranded_by_an_older_build(&repaired, 2);
    fs::remove_dir_all(repaired.join("content/segments")).unwrap();
    copy_recovery_input(
        &workspace.join("original-segments"),
        &repaired.join("content/segments"),
    )
    .unwrap();
    let settled = layout(&repaired);
    RecoveryManager::restore_interrupted_recovery(&repaired).unwrap();
    assert_eq!(layout(&repaired), settled);
    assert!(workspace.join("original-segments").is_dir());

    // A backup belonging to different metadata is never applied.
    let foreign = needs_remux_project(temporary.path(), "foreign", 10);
    let workspace = stranded_by_an_older_build(&foreign, 2);
    fs::write(
        workspace.join("original-recording-meta.json"),
        br#"{"pretty_name":"someone else","segments":[]}"#,
    )
    .unwrap();
    let settled = layout(&foreign);
    RecoveryManager::restore_interrupted_recovery(&foreign).unwrap();
    assert_eq!(layout(&foreign), settled);
}

#[test]
fn a_remux_while_another_open_holds_the_project_changes_nothing() {
    let temporary = tempfile::tempdir().unwrap();
    let project = needs_remux_project(temporary.path(), "two opens", 200);
    let recorded = recorded_frames(&project, None);
    let before = layout(&project);
    {
        let _held = RecoveryLock::acquire(&project).unwrap();
        let other = project.clone();
        let result = std::thread::spawn(move || RecoveryManager::remux_if_needed(&other))
            .join()
            .unwrap();
        assert!(result.is_err());
        assert_eq!(layout(&project), before);
    }

    let results = (0..2)
        .map(|_| {
            let project = project.clone();
            std::thread::spawn(move || RecoveryManager::remux_if_needed(&project))
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert!(
        results.iter().any(|result| matches!(result, Ok(true))),
        "{results:?}"
    );
    assert_eq!(remuxed_frames(&project), recorded);
    assert!(original_backups(&project).is_empty());
    assert!(!project.join(RECOVERY_PUBLICATION).exists());
}

#[test]
fn a_full_disk_while_staging_leaves_the_recording_as_it_was() {
    let temporary = tempfile::tempdir().unwrap();
    let project = needs_remux_project(temporary.path(), "disk full", 300);
    let before = layout(&project);
    let incomplete = RecoveryManager::inspect_recording(&project).unwrap();
    let error = RecoveryManager::finalize_with_operations(
        &incomplete,
        RecoveryPurpose::Finalize,
        |source, destination, durability| {
            copy_recovery_input_with_durability(source, destination, durability)?;
            if source.ends_with("content") {
                // The volume fills as the last fragment lands.
                return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
            }
            Ok(())
        },
        |_, _| Ok(()),
    )
    .unwrap_err();
    assert!(
        matches!(&error, RecoveryError::Io(io) if io.kind() == std::io::ErrorKind::StorageFull),
        "{error}"
    );
    assert_eq!(layout(&project), before);
    assert!(workspaces(&project).is_empty());
}
