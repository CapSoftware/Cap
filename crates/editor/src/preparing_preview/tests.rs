use super::*;
use cap_enc_ffmpeg::RelocatableSource;
use cap_rendering::{ManagedVideoTrackInput, decoder::ManagedVideoExit};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

struct OwnerDropped(Arc<AtomicBool>);

impl Drop for OwnerDropped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn input(path: &Path) -> (PreparingPreviewInput, Arc<AtomicBool>) {
    let dropped = Arc::new(AtomicBool::new(false));
    let source = RelocatableSource::new_with_owner(
        path.to_path_buf(),
        Arc::new(OwnerDropped(dropped.clone())),
    )
    .unwrap();
    let recording_meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "project_path": path,
        "pretty_name": "Preparing test",
        "segments": [{"display": {"path": "content/segments/segment-0/display", "fps": 30, "start_time": 0.0}}],
        "status": {"status": "NeedsRemux"}
    })).unwrap();
    let segment = PreparingPreviewSegment {
        video: ManagedSegmentVideoInput::new(
            0,
            recording_meta.studio_meta().unwrap(),
            ManagedVideoTrackInput::new(source, vec!["missing-init.mp4".into()]).unwrap(),
            None,
        )
        .unwrap(),
        cursor: Arc::new(CursorEvents::default()),
    };
    let project = ProjectConfiguration {
        timeline: Some(serde_json::from_value(serde_json::json!({
            "segments": [{"recordingSegment": 0, "start": 0.0, "end": 7200.0, "timescale": 1.0}],
            "zoomSegments": []
        })).unwrap()),
        clips: vec![cap_project::ClipConfiguration::default()],
        ..Default::default()
    };
    (
        PreparingPreviewInput {
            recording_meta,
            project,
            segments: vec![segment],
            cursor_assets: FrozenRecordedCursorAssets::new([]).unwrap(),
        },
        dropped,
    )
}

#[test]
fn unsupported_presentation_and_unresolved_offsets_decline_before_open() {
    let directory = tempfile::tempdir().unwrap();
    let mutations: [fn(&mut ProjectConfiguration); 8] = [
        |project| {
            project.background.source = BackgroundSource::Image {
                path: Some("unreadable.png".into()),
            }
        },
        |project| project.camera.background_blur.mode = cap_project::BackgroundBlurMode::Heavy,
        |project| project.clips.clear(),
        |project| project.clips.push(project.clips[0].clone()),
        |project| project.clips[0].offsets.camera = f32::NAN,
        |project| project.timeline.as_mut().unwrap().segments[0].timescale = 0.5,
        |project| project.keyboard = Some(cap_project::KeyboardData::default()),
        |project| {
            project.timeline.as_mut().unwrap().keyboard_segments.push(
                serde_json::from_value(serde_json::json!({
                    "id": "kb-0", "start": 0.0, "end": 1.0, "displayText": "A"
                }))
                .unwrap(),
            )
        },
    ];
    for mutate in mutations {
        let (mut input, dropped) = input(directory.path());
        assert_eq!(validate_input(&input).unwrap(), 7200.0);
        mutate(&mut input.project);
        assert!(matches!(
            validate_input(&input),
            Err(PreparingPreviewError::InvalidInput(_))
        ));
        drop(input);
        assert!(dropped.load(Ordering::Acquire));
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn input_metadata_must_match_bound_decoder_timing() {
    let directory = tempfile::tempdir().unwrap();
    for changed in ["fps", "start_time", "missing_start"] {
        let (mut input, _) = input(directory.path());
        let cap_project::RecordingMetaInner::Studio(metadata) = &mut input.recording_meta.inner
        else {
            unreachable!()
        };
        let cap_project::StudioRecordingMeta::MultipleSegments { inner } = metadata.as_mut() else {
            unreachable!()
        };
        match changed {
            "fps" => inner.segments[0].display.fps = 24,
            "start_time" => inner.segments[0].display.start_time = Some(1.0),
            _ => inner.segments[0].display.start_time = None,
        }
        assert!(
            matches!(
                validate_input(&input),
                Err(PreparingPreviewError::InvalidInput(_))
            ),
            "{changed}"
        );
    }
}

#[test]
fn requests_reject_exclusive_end_and_invalid_dimensions() {
    let resolution = XY::new(1920, 1080);
    assert!(validate_request(7199 * 60, 60, resolution, 7200.0).is_ok());
    assert!(validate_request(7200 * 60, 60, resolution, 7200.0).is_err());
    assert!(validate_request(0, 0, resolution, 7200.0).is_err());
    assert!(validate_request(0, 60, XY::new(0, 1080), 7200.0).is_err());
    assert!(validate_request(0, 60, XY::new(16384, 1080), 7200.0).is_err());
    assert!(validate_request(0, 60, resolution, f64::INFINITY).is_err());
}

#[test]
fn rendered_frame_identity_and_latest_sequence_are_both_required() {
    let first = PreparingFrameRequest {
        sequence: 1,
        frame_number: 30,
        fps: 30,
        resolution_base: XY::new(160, 120),
    };
    let latest = PreparingFrameRequest {
        sequence: 2,
        frame_number: 60,
        ..first
    };
    let (sender, receiver) = watch::channel(Some(first));
    sender.send_replace(Some(latest));
    assert!(!is_current(&receiver, first));
    assert!(is_current(&receiver, latest));
    let layout = FrameLayout {
        display: [0.0, 0.0, 160.0, 120.0],
        camera: None,
        output_size: [160, 120],
    };
    let mut frame = cap_rendering::RenderedFrame {
        data: Arc::new(Vec::new()),
        width: 160,
        height: 120,
        padded_bytes_per_row: 640,
        frame_number: first.frame_number,
        target_time_ns: 0,
    };
    assert!(validate_output(&EditorFrameOutput::Rgba(frame.clone()), latest, layout).is_err());
    frame.frame_number = latest.frame_number;
    assert!(validate_output(&EditorFrameOutput::Rgba(frame.clone()), latest, layout).is_ok());
    frame.width = 80;
    assert!(validate_output(&EditorFrameOutput::Rgba(frame), latest, layout).is_err());
}

#[tokio::test]
async fn missing_media_preserves_failure_and_joins_before_source_release() {
    let directory = tempfile::tempdir().unwrap();
    let (input, dropped) = input(directory.path());
    let mut preview = PreparingPreview::spawn(
        input,
        PreparingPreviewOptions::default(),
        Box::new(|_, _, _| panic!("Missing media must not render")),
    )
    .unwrap();
    let stop = preview.stop_handle();
    let error = preview.wait_ready().await.unwrap_err();
    assert!(
        matches!(
            &error,
            PreparingPreviewError::Media(ManagedSegmentVideoError::Display(
                ManagedVideoError::Initialization(_)
            ))
        ),
        "{error:?}"
    );
    let exit = stop.stop_and_wait().await;
    assert_eq!(exit.reason, error);
    assert_eq!(exit.workers.len(), 1);
    assert!(matches!(
        exit.workers[0].display.as_ref().unwrap().terminal,
        ManagedVideoError::Initialization(_)
    ));
    assert!(dropped.load(Ordering::Acquire));
    assert!(preview.request_frame(0, 30, XY::new(160, 120)).is_err());
    assert!(preview.wait_ready().await.is_err());
}

#[tokio::test]
async fn dropped_readiness_and_shutdown_waiters_retain_join_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let (input, dropped) = input(directory.path());
    let mut preview = PreparingPreview::spawn(
        input,
        PreparingPreviewOptions::default(),
        Box::new(|_, _, _| panic!("Cancelled preview must not render")),
    )
    .unwrap();
    let stop = preview.stop_handle();
    assert!(preview.wait_ready().now_or_never().is_none());
    assert!(stop.control.cancel.is_cancelled());
    assert!(stop.stop_and_wait().now_or_never().is_none());
    assert!(!dropped.load(Ordering::Acquire));
    let exit = stop.stop_and_wait().await;
    assert_eq!(exit.reason, PreparingPreviewError::Cancelled);
    assert!(exit.workers.is_empty());
    assert!(dropped.load(Ordering::Acquire));
    let weak = Arc::downgrade(&stop.control);
    drop(preview);
    drop(stop);
    assert!(weak.upgrade().is_none());
}

#[tokio::test]
async fn owner_drop_closes_admission_before_join() {
    let directory = tempfile::tempdir().unwrap();
    let (input, dropped) = input(directory.path());
    let mut preview = PreparingPreview::spawn(
        input,
        PreparingPreviewOptions::default(),
        Box::new(|_, _, _| panic!("Cancelled preview must not render")),
    )
    .unwrap();
    assert_eq!(preview.request_frame(0, 30, XY::new(160, 120)).unwrap(), 1);
    assert_eq!(preview.request_frame(30, 30, XY::new(160, 120)).unwrap(), 2);
    let stop = preview.stop_handle();
    drop(preview);
    assert!(stop.control.cancel.is_cancelled());
    assert!(!dropped.load(Ordering::Acquire));
    assert_eq!(
        stop.stop_and_wait().await.reason,
        PreparingPreviewError::Cancelled
    );
    assert!(dropped.load(Ordering::Acquire));
}

#[test]
fn real_camera_failure_is_not_replaced_by_cancelled_display() {
    let exit = ManagedSegmentVideoExit {
        display: Some(ManagedVideoExit {
            terminal: ManagedVideoError::Cancelled,
        }),
        camera: Some(ManagedVideoExit {
            terminal: ManagedVideoError::Decode("missing fragment".into()),
        }),
    };
    assert_eq!(
        worker_exit_error(&exit),
        Some(PreparingPreviewError::Media(
            ManagedSegmentVideoError::Camera(ManagedVideoError::Decode("missing fragment".into()))
        ))
    );
}
