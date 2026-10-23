#![cfg(target_os = "macos")]

use cap_rendering::decoder::{DecoderType, spawn_decoder};
use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

fn video(path: &Path, size: &str) {
    let result = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
        .arg(format!("testsrc2=size={size}:rate=30:duration=1"))
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Runs hundreds of real macOS video decoders and requires ffmpeg"]
async fn many_segment_project_decodes_and_seeks_without_hardware_exhaustion() {
    ffmpeg::init().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let screen = directory.path().join("display.mp4");
    let camera = directory.path().join("camera.mp4");
    video(&screen, "3840x2160");
    video(&camera, "1280x720");
    for count in [193, 568] {
        verify_project(&screen, &camera, count).await;
    }
}

async fn verify_project(screen: &Path, camera: &Path, count: usize) {
    let started = Instant::now();
    let decoders = futures::future::try_join_all((0..count).flat_map(|_| {
        [
            spawn_decoder("screen", screen.to_path_buf(), 30, 0.0, false),
            spawn_decoder("camera", camera.to_path_buf(), 30, 0.0, false),
        ]
    }))
    .await
    .unwrap();
    eprintln!(
        "Initialized {} tracks in {:?}",
        decoders.len(),
        started.elapsed()
    );
    for segment in [0, count - 1, 1, count / 2, 0] {
        let started = Instant::now();
        let (screen, camera) = tokio::join!(
            decoders[segment * 2].get_frame_initial(0.0),
            decoders[segment * 2 + 1].get_frame_initial(0.0)
        );
        assert!(screen.is_some(), "Missing screen for segment {segment}");
        assert!(camera.is_some(), "Missing camera for segment {segment}");
        assert_eq!(
            decoders[segment * 2].decoder_type(),
            DecoderType::AVAssetReader
        );
        eprintln!("Decoded segment {segment} in {:?}", started.elapsed());
        let first = screen.unwrap().y_plane().unwrap().to_vec();
        for time in [0.5, 0.1, 0.9] {
            let frame = decoders[segment * 2].get_frame_initial(time).await.unwrap();
            assert_ne!(
                frame.y_plane().unwrap(),
                first,
                "Seek did not advance video at {time}"
            );
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        let frame = decoders[segment * 2].get_frame_initial(0.0).await.unwrap();
        assert_eq!(
            frame.y_plane().unwrap(),
            first,
            "Idle resume changed the first frame"
        );
    }
    let frames = futures::future::join_all(
        decoders
            .iter()
            .take(32)
            .map(|decoder| decoder.get_frame_initial(0.0)),
    )
    .await;
    assert!(frames.iter().all(Option::is_some));
    assert!(
        decoders
            .iter()
            .take(32)
            .all(|decoder| decoder.decoder_type() == DecoderType::AVAssetReader)
    );
    for segment in 0..30 {
        for frame in 0..30 {
            let time = frame as f32 / 30.0;
            let (screen, camera) = tokio::join!(
                decoders[segment * 2].get_frame(time),
                decoders[segment * 2 + 1].get_frame(time)
            );
            assert!(
                screen.is_some() && camera.is_some(),
                "Playback lost segment {segment} frame {frame}"
            );
        }
    }
    eprintln!("Played 30 segments / 900 frames in the {count}-segment project");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Runs real macOS video decoders and requires ffmpeg"]
async fn idle_reader_preserves_vfr_holds_offsets_and_end_frames() {
    ffmpeg::init().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("gapped.mp4");
    let result = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x120:rate=30:duration=4",
            "-vf",
            "select=not(between(t\\,1\\,2))",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let decoder = spawn_decoder("screen", path.clone(), 30, 0.25, false)
        .await
        .unwrap();
    let reference = spawn_decoder("screen", path, 30, 0.0, false).await.unwrap();
    for time in [0.0, 1.0, 1.5, 2.0, 3.7, 0.25, 1.25] {
        let expected = reference.get_frame_initial(time + 0.25).await.unwrap();
        let before_idle = decoder.get_frame_initial(time).await.unwrap();
        assert_eq!(before_idle.y_plane(), expected.y_plane(), "time {time}");
        tokio::time::sleep(Duration::from_millis(350)).await;
        let after_idle = decoder.get_frame_initial(time).await.unwrap();
        assert_eq!(after_idle.y_plane(), expected.y_plane(), "time {time}");
        assert_eq!(decoder.decoder_type(), DecoderType::AVAssetReader);
    }
}
