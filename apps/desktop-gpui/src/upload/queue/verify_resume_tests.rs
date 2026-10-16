//! Quit and relaunch through the upload queue's persisted state, against the
//! mock Cap API from `upload::verify_tests` on a virtual clock.

use super::*;
use crate::upload::verify_tests::{
    Fault, MockCap, OWNER, Route, SAMPLE_MP4, Scratch, assert_segments_stored, budget,
    check_budget, instant_tracks, rule, virtual_time, write_thumbnail,
};

const VIDEO_ID: &str = "resumeverify01";
const PAIRS: u32 = 6;

fn saved_instant_project(
    root: &Path,
    server: &str,
) -> (
    PathBuf,
    Vec<SegmentCompletedEvent>,
    Vec<SegmentCompletedEvent>,
) {
    let project = root.join("instant.cap");
    std::fs::create_dir_all(project.join("content")).unwrap();
    std::fs::write(project.join("content/output.mp4"), SAMPLE_MP4).unwrap();
    let (video, audio) = instant_tracks(&project, PAIRS);
    write_thumbnail(&project.join("screenshots/display.jpg"));
    let video_info = VideoUploadInfo {
        id: VIDEO_ID.into(),
        link: format!("{server}/s/{VIDEO_ID}"),
        config: S3UploadMeta {
            id: VIDEO_ID.into(),
        },
    };
    RecordingMeta {
        platform: None,
        project_path: project.clone(),
        pretty_name: "Resume verify".into(),
        sharing: Some(SharingMeta {
            id: VIDEO_ID.into(),
            link: video_info.link.clone(),
            content_hash: None,
        }),
        inner: RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
            fps: 30,
            sample_rate: Some(48_000),
        }),
        upload: Some(UploadMeta::SegmentUpload {
            video_id: VIDEO_ID.into(),
            pre_created_video: video_info,
            recording_dir: project.clone(),
        }),
    }
    .save_for_project()
    .unwrap();
    write_state(
        &project,
        &UploadState {
            version: 1,
            video_id: VIDEO_ID.into(),
            server_url: server.into(),
            owner_id: Some(OWNER.into()),
            kind: UploadKind::Segments,
            requested_audio: Some(true),
            preserve_local: false,
            phase: UploadPhase::Pending,
            attempt_count: 0,
            last_error: None,
            next_retry_at: None,
            verification: None,
            receipt: None,
        },
    )
    .unwrap();
    (project, video, audio)
}

/// What the queue does for a pending recording at launch.
async fn launch(manager: &Arc<Manager<LiveBackend>>, project: &Path) {
    let ownership = UploadLock::acquire(project).unwrap();
    let project = ownership.project_path().to_path_buf();
    let state = read_state(&project).unwrap().unwrap();
    assert!(state.pending(now(), false), "not resumable: {state:?}");
    manager.resume(project, state, ownership).await.unwrap();
}

async fn settle(manager: &Manager<LiveBackend>) {
    loop {
        if manager
            .jobs
            .lock()
            .await
            .values()
            .all(|job| job.task.is_finished())
        {
            manager.reap().await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn assert_verified(
    mock: &MockCap,
    project: &Path,
    video: &[SegmentCompletedEvent],
    audio: &[SegmentCompletedEvent],
) {
    let state = read_state(project).unwrap().unwrap();
    assert_eq!(state.phase, UploadPhase::Verified, "{state:?}");
    assert!(state.receipt.is_some() && state.last_error.is_none());
    assert!(matches!(
        RecordingMeta::load_for_project(project).unwrap().upload,
        Some(UploadMeta::Complete)
    ));
    assert_segments_stored(mock, VIDEO_ID, video, audio);
    assert!(
        mock.object(&format!("{VIDEO_ID}/screenshot/screen-capture.jpg"))
            .is_some()
    );
    assert!(project.join("content/output.mp4").exists());
    mock.assert_clean();
}

/// The app quits while a saved Instant recording is half uploaded by the
/// queue, then relaunches. The relaunch resumes from `instant-upload.json`
/// with the same video id and verifies; it sends each object at most once.
#[test]
fn saved_instant_upload_resumes_after_quit_mid_transfer() {
    let case = "queue_resume_after_quit_mid_transfer";
    let scratch = Scratch::new(case);
    virtual_time(async {
        let mock = MockCap::start(vec![rule(
            Route::Object("segments/video/segment_002"),
            Fault::Trip(0.5),
        )])
        .await;
        scratch.sign_in(&mock.url);
        let (project, video, audio) = saved_instant_project(&scratch.0, &mock.url);

        let first = Arc::new(Manager::new(LiveBackend, CONFIRMATION_TIMEOUT));
        launch(&first, &project).await;
        mock.tripped().await;
        first.shutdown().await;
        let state = read_state(&project).unwrap().unwrap();
        assert_eq!(state.phase, UploadPhase::Uploading, "{state:?}");
        assert!(mock.confirmations().is_empty());
        assert_eq!(mock.deletes(), 0);

        mock.drain().await;
        mock.new_session();
        let relaunched = Arc::new(Manager::new(LiveBackend, CONFIRMATION_TIMEOUT));
        launch(&relaunched, &project).await;
        settle(&relaunched).await;
        assert_verified(&mock, &project, &video, &audio);
        assert_eq!(mock.confirmations().len(), 1);

        let stats = mock.stats();
        let media: u64 = video
            .iter()
            .chain(&audio)
            .map(|event| event.file_size)
            .sum();
        let thumbnail = mock
            .object(&format!("{VIDEO_ID}/screenshot/screen-capture.jpg"))
            .unwrap()
            .len() as u64;
        assert!(
            stats.media_bytes <= media + thumbnail,
            "relaunch sent {} media bytes for {} bytes of recording",
            stats.media_bytes,
            media + thumbnail
        );
        check_budget(case, &mock, budget::QUEUE_RESUME_AFTER_QUIT_MID_TRANSFER);
    });
}

/// The app quits while the queue waits for cloud verification. The relaunch
/// confirms the already uploaded recording without sending it again.
#[test]
fn saved_instant_upload_quit_during_verification_confirms_without_reupload() {
    let case = "queue_resume_after_quit_during_verification";
    let scratch = Scratch::new(case);
    virtual_time(async {
        let mock = MockCap::start(vec![rule(Route::Api("recording-complete"), Fault::Hang)]).await;
        scratch.sign_in(&mock.url);
        let (project, video, audio) = saved_instant_project(&scratch.0, &mock.url);

        let first = Arc::new(Manager::new(LiveBackend, CONFIRMATION_TIMEOUT));
        launch(&first, &project).await;
        while mock.count("POST", "recording-complete") == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        first.shutdown().await;
        let state = read_state(&project).unwrap().unwrap();
        assert_eq!(state.phase, UploadPhase::Processing, "{state:?}");
        assert!(state.verification.is_some());

        mock.drain().await;
        mock.new_session();
        let relaunched = Arc::new(Manager::new(LiveBackend, CONFIRMATION_TIMEOUT));
        launch(&relaunched, &project).await;
        settle(&relaunched).await;
        assert_verified(&mock, &project, &video, &audio);
        check_budget(
            case,
            &mock,
            budget::QUEUE_RESUME_AFTER_QUIT_DURING_VERIFICATION,
        );
    });
}
