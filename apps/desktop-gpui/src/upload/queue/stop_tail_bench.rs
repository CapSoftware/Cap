//! How long an Instant recording takes, after Stop, to publish its final
//! manifest and send its completion signal, with every API call and object
//! PUT answered after a fixed delay on the virtual clock. Manual:
//!
//! ```sh
//! STOP_TAIL_API_MS=200 STOP_TAIL_OBJECT_MS=80 \
//!   cargo test --bin cap-gpui stop_tail -- --ignored --nocapture
//! ```

use super::*;
use crate::upload::verify_tests::{
    Fault, MockCap, OWNER, Route, SAMPLE_MP4, Scratch, assert_segments_stored, instant_tracks,
    rule, virtual_time, write_thumbnail,
};

const VIDEO_ID: &str = "stoptail01";

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn recording_project(
    root: &Path,
    server: &str,
    pairs: u32,
) -> (
    PathBuf,
    VideoUploadInfo,
    Vec<SegmentCompletedEvent>,
    Vec<SegmentCompletedEvent>,
) {
    let project = root.join("instant.cap");
    std::fs::create_dir_all(project.join("content")).unwrap();
    std::fs::write(project.join("content/output.mp4"), SAMPLE_MP4).unwrap();
    let (video, audio) = instant_tracks(&project, pairs);
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
        pretty_name: "Stop tail".into(),
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
            pre_created_video: video_info.clone(),
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
            phase: UploadPhase::Recording,
            attempt_count: 0,
            last_error: None,
            next_retry_at: None,
            verification: None,
            receipt: None,
        },
    )
    .unwrap();
    (project, video_info, video, audio)
}

fn last_response(mock: &MockCap, method: &str, fragment: &str) -> Duration {
    mock.responses(method, fragment)
        .into_iter()
        .map(|(_, at)| at)
        .max()
        .unwrap_or_default()
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
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[test]
#[ignore = "manual Instant stop tail benchmark"]
fn stop_tail_benchmark() {
    let api = Duration::from_millis(env_number("STOP_TAIL_API_MS", 200));
    let object = Duration::from_millis(env_number("STOP_TAIL_OBJECT_MS", 80));
    let pairs = env_number("STOP_TAIL_PAIRS", 30) as u32;
    let _shared_client = crate::auth::SHARED_API_CLIENT_TEST_LOCK.blocking_lock();
    let scratch = Scratch::new("stop_tail");
    virtual_time(async {
        let epoch = tokio::time::Instant::now();
        let mock = MockCap::start(vec![
            rule(Route::Api("/api/"), Fault::Delay(api)).times(u32::MAX),
            rule(Route::Object(""), Fault::Delay(object)).times(u32::MAX),
        ])
        .await;
        scratch.sign_in(&mock.url);
        let (project, video_info, video, audio) = recording_project(&scratch.0, &mock.url, pairs);
        let (sender, receiver) = std::sync::mpsc::channel();
        let upload = crate::upload::start_instant_upload(
            video_info,
            project.clone(),
            Some(receiver),
            Arc::new(Mutex::new(())),
            Some(crate::upload::CompletionAuthorization::new()),
        )
        .unwrap();
        let start = tokio::time::Instant::now();
        sender.send(video[0].clone()).unwrap();
        sender.send(audio[0].clone()).unwrap();
        for k in 1..video.len() {
            tokio::time::sleep_until(start + Duration::from_secs(2 * k as u64)).await;
            sender.send(audio[k].clone()).unwrap();
            sender.send(video[k].clone()).unwrap();
        }
        drop(sender);
        let stopped = epoch.elapsed();
        let manager = Arc::new(Manager::new(LiveBackend, CONFIRMATION_TIMEOUT));
        manager.admit(project.clone(), upload, false).await.unwrap();
        settle(&manager).await;
        let state = read_state(&project).unwrap().unwrap();
        assert_eq!(state.phase, UploadPhase::Verified, "{state:?}");
        assert_segments_stored(&mock, VIDEO_ID, &video, &audio);
        mock.assert_clean();
        let since_stop = |at: Duration| at.saturating_sub(stopped).as_secs_f64();
        eprintln!(
            "stop-tail api={api:?} object={object:?} pairs={pairs}: thumbnail {:.3}s, final manifest {:.3}s, completion {:.3}s; {} requests, {} presigns",
            since_stop(last_response(&mock, "PUT", "screenshot/")),
            since_stop(last_response(&mock, "PUT", "segments/manifest.json")),
            since_stop(last_response(
                &mock,
                "POST",
                "/api/upload/recording-complete"
            )),
            mock.stats().requests,
            mock.count("POST", "/api/upload/signed"),
        );
    });
}
