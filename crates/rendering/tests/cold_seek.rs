#![cfg(target_os = "macos")]

use cap_rendering::{
    DecodedFrame, PixelFormat,
    decoder::{DecoderType, spawn_decoder},
};
use std::{
    collections::{BTreeMap, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    path::PathBuf,
    time::Duration,
};

fn pixels(frame: &DecodedFrame) -> u64 {
    let mut hash = DefaultHasher::new();
    frame.width().hash(&mut hash);
    frame.height().hash(&mut hash);
    match frame.format() {
        PixelFormat::Nv12 => {
            for (plane, stride) in [
                (frame.y_plane().unwrap(), frame.y_stride()),
                (frame.uv_plane().unwrap(), frame.uv_stride()),
            ] {
                for row in plane.chunks_exact(stride as usize) {
                    row[..frame.width() as usize].hash(&mut hash);
                }
            }
        }
        other => panic!("Expected native NV12 frames, got {other:?}"),
    }
    hash.finish()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Requires CAP_DECODER_TEST_VIDEO (at least 8 seconds) and CAP_DECODER_TEST_FPS on macOS"]
async fn cold_and_idle_seeks_match_sequential_decode() {
    ffmpeg::init().unwrap();
    let path = PathBuf::from(std::env::var_os("CAP_DECODER_TEST_VIDEO").unwrap());
    let fps: u32 = std::env::var("CAP_DECODER_TEST_FPS")
        .unwrap()
        .parse()
        .unwrap();
    assert!(fps > 0);
    let probe_frames = [
        0,
        1,
        fps,
        3 * fps,
        5 * fps - 1,
        5 * fps,
        7 * fps,
        7 * fps + 1,
    ];
    let sequential = spawn_decoder("sequential", path.clone(), fps, 0.0, false)
        .await
        .unwrap();
    let mut expected = BTreeMap::new();
    for number in 0..=*probe_frames.last().unwrap() {
        let frame = sequential
            .get_frame_initial(number as f32 / fps as f32)
            .await
            .unwrap();
        if probe_frames.contains(&number) {
            expected.insert(number, pixels(&frame));
        }
    }
    drop(sequential);
    let resumed = spawn_decoder("resumed", path.clone(), fps, 0.0, false)
        .await
        .unwrap();
    for &number in probe_frames.iter().rev() {
        let time = number as f32 / fps as f32;
        let cold = spawn_decoder("cold", path.clone(), fps, 0.0, false)
            .await
            .unwrap();
        let frame = cold.get_frame_initial(time).await.unwrap();
        assert_eq!(pixels(&frame), expected[&number], "Cold seek at {time}");
        assert_eq!(cold.decoder_type(), DecoderType::AVAssetReader);
        drop(cold);
        tokio::time::sleep(Duration::from_millis(350)).await;
        let frame = resumed.get_frame_initial(time).await.unwrap();
        assert_eq!(pixels(&frame), expected[&number], "Idle seek at {time}");
        assert_eq!(resumed.decoder_type(), DecoderType::AVAssetReader);
    }
}
