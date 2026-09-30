use cap_recording::oop_muxer::{
    AudioStreamInit, MuxerSubprocess, MuxerSubprocessConfig, RespawningMuxerSubprocess,
    VideoStreamInit, resolve_muxer_binary,
};
use std::path::PathBuf;
use std::sync::Once;
use tempfile::TempDir;

const TEST_WIDTH: u32 = 640;
const TEST_HEIGHT: u32 = 360;
const TEST_FPS: u32 = 30;

static MUXER_BINARY: Once = Once::new();

fn setup_muxer_binary() -> PathBuf {
    let workspace = env!("CARGO_MANIFEST_DIR");
    let binary_name = format!("cap-muxer{}", std::env::consts::EXE_SUFFIX);
    let target_debug = PathBuf::from(workspace)
        .join("../../target/debug")
        .join(&binary_name);
    let target_release = PathBuf::from(workspace)
        .join("../../target/release")
        .join(binary_name);

    for candidate in [target_debug, target_release] {
        if candidate.exists() {
            MUXER_BINARY.call_once(|| unsafe {
                std::env::set_var(cap_recording::oop_muxer::ENV_BIN_PATH, &candidate);
            });
            return candidate;
        }
    }

    panic!("cap-muxer binary not found; run `cargo build -p cap-muxer` before the OOP muxer tests");
}

fn minimal_video_config(output_dir: &std::path::Path, extradata: Vec<u8>) -> MuxerSubprocessConfig {
    MuxerSubprocessConfig {
        output_directory: output_dir.to_path_buf(),
        init_segment_name: "init.mp4".to_string(),
        media_segment_pattern: "segment_$Number%03d$.m4s".to_string(),
        video_init: Some(VideoStreamInit {
            codec: "libx264".to_string(),
            width: TEST_WIDTH,
            height: TEST_HEIGHT,
            frame_rate: (TEST_FPS as i32, 1),
            time_base: (1, 90_000),
            extradata,
            segment_duration_ms: 2000,
        }),
        audio_init: None,
    }
}

#[test]
fn subprocess_spawns_and_finishes_cleanly_without_packets() {
    let bin = setup_muxer_binary();
    let temp_dir = TempDir::new().unwrap();
    let output_dir = temp_dir.path().join("video");

    let config = minimal_video_config(&output_dir, Vec::new());
    let subprocess = MuxerSubprocess::spawn(bin, config, None)
        .expect("spawn cap-muxer subprocess with no packets");

    let report = subprocess
        .finish()
        .expect("subprocess finishes cleanly with no packets");
    assert_eq!(report.exit_code, Some(0));
    assert_eq!(report.packets_written, 0);
}

fn empty_audio_init() -> AudioStreamInit {
    AudioStreamInit {
        codec: "aac".into(),
        sample_rate: 48_000,
        channels: 2,
        sample_format: "fltp".into(),
        time_base: (1, 48_000),
        extradata: vec![0x11, 0x90],
    }
}

#[test]
fn empty_audio_and_combined_streams_preserve_initialization_files() {
    let binary = setup_muxer_binary();
    for with_video in [false, true] {
        let directory = TempDir::new().unwrap();
        let output = directory.path().join("output");
        let mut config = minimal_video_config(&output, Vec::new());
        if !with_video {
            config.video_init = None;
        }
        config.audio_init = Some(empty_audio_init());
        config.init_segment_name = "init_$RepresentationID$.mp4".into();
        let subprocess = MuxerSubprocess::spawn(binary.clone(), config, None).unwrap();
        let report = subprocess.finish().unwrap();
        assert_eq!(report.exit_code, Some(0));
        assert_eq!(report.packets_written, 0);
        assert!(output.join("init_0.mp4").is_file());
        assert_eq!(output.join("init_1.mp4").is_file(), with_video);
        assert!(
            std::fs::read(output.join("dash_manifest.mpd"))
                .unwrap()
                .is_empty()
        );
        assert!(!output.join("dash_manifest.mpd.tmp").exists());
    }
}

#[test]
fn discarded_packets_before_first_video_keyframe_leave_a_clean_empty_output() {
    let directory = TempDir::new().unwrap();
    let output = directory.path().join("output");
    let mut config = minimal_video_config(&output, Vec::new());
    config.audio_init = Some(empty_audio_init());
    config.init_segment_name = "init_$RepresentationID$.mp4".into();
    let mut subprocess = MuxerSubprocess::spawn(setup_muxer_binary(), config, None).unwrap();
    subprocess
        .write_video_packet(0, 0, 3_000, false, &[1, 2, 3])
        .unwrap();
    subprocess
        .write_audio_packet(0, 0, 1_024, &[4, 5, 6])
        .unwrap();
    let report = subprocess.finish().unwrap();
    assert_eq!(report.exit_code, Some(0));
    assert_eq!(report.packets_written, 2);
    assert!(output.join("init_0.mp4").is_file());
    assert!(output.join("init_1.mp4").is_file());
    assert!(
        std::fs::read(output.join("dash_manifest.mpd"))
            .unwrap()
            .is_empty()
    );
    assert!(std::fs::read_dir(&output).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".m4s")
    }));
}

#[test]
fn subprocess_exits_after_finish_or_abort_without_waiting_for_stdin_eof() {
    use cap_muxer_protocol::{Frame, InitVideo, StartParams, write_frame};
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let binary = setup_muxer_binary();
    for (initialized, frame, expected_exit) in [
        (false, Some(Frame::Finish), 0),
        (false, Some(Frame::Abort("test".into())), 40),
        (true, Some(Frame::Finish), 0),
        (true, Some(Frame::Abort("test".into())), 40),
        (true, None, 0),
    ] {
        let directory = TempDir::new().unwrap();
        let mut child = Command::new(&binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take();
        let writer = stdin.as_mut().unwrap();
        if initialized {
            write_frame(
                writer,
                &Frame::InitVideo(InitVideo {
                    codec: "libx264".into(),
                    width: TEST_WIDTH,
                    height: TEST_HEIGHT,
                    frame_rate_num: TEST_FPS as i32,
                    frame_rate_den: 1,
                    time_base_num: 1,
                    time_base_den: 90_000,
                    extradata: Vec::new(),
                    segment_duration_ms: 2_000,
                }),
            )
            .unwrap();
            write_frame(
                writer,
                &Frame::Start(StartParams {
                    output_directory: directory.path().to_string_lossy().into_owned(),
                    init_segment_name: "init.mp4".into(),
                    media_segment_pattern: "segment_$Number%03d$.m4s".into(),
                }),
            )
            .unwrap();
        }
        if let Some(frame) = &frame {
            write_frame(writer, frame).unwrap();
            writer.flush().unwrap();
        } else {
            writer.flush().unwrap();
            drop(stdin.take());
        }
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() >= Duration::from_secs(3) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("muxer waited for stdin EOF after receiving {frame:?}");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        drop(stdin);
        assert_eq!(status.code(), Some(expected_exit));
        if initialized {
            assert!(directory.path().join("init.mp4").is_file());
        }
    }
}

#[cfg(unix)]
#[test]
fn finish_preserves_packets_when_a_slow_muxer_takes_more_than_five_seconds() {
    use cap_muxer_protocol::{Frame, read_frame};
    use std::io::Cursor;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let directory = TempDir::new().unwrap();
    let binary = directory.path().join("slow-muxer");
    std::fs::write(&binary, "#!/bin/sh\nsleep 6\ncat > \"$0.received\"\n").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = minimal_video_config(&directory.path().join("video"), Vec::new());
    let mut subprocess = MuxerSubprocess::spawn(binary, config, None).unwrap();
    let payload = vec![42; 128 * 1024];
    subprocess
        .write_video_packet(0, 0, 1, true, &payload)
        .unwrap();
    let started = Instant::now();
    let report = subprocess.finish().unwrap();
    assert_eq!(report.exit_code, Some(0));
    assert!(started.elapsed() >= Duration::from_secs(5));

    let received = std::fs::read(directory.path().join("slow-muxer.received")).unwrap();
    let mut reader = Cursor::new(received.as_slice());
    assert!(matches!(
        read_frame(&mut reader).unwrap(),
        Frame::InitVideo(_)
    ));
    assert!(matches!(read_frame(&mut reader).unwrap(), Frame::Start(_)));
    let Frame::Packet(packet) = read_frame(&mut reader).unwrap() else {
        panic!("expected the buffered video packet");
    };
    assert_eq!(packet.data, payload);
    assert!(matches!(read_frame(&mut reader).unwrap(), Frame::Finish));
    assert_eq!(reader.position(), received.len() as u64);
}

#[test]
fn subprocess_survives_kill_and_parent_reports_crashed() {
    let bin = setup_muxer_binary();
    let temp_dir = TempDir::new().unwrap();
    let output_dir = temp_dir.path().join("video");

    let fake_extradata = vec![0x01, 0x64, 0x00, 0x33, 0xFF, 0xE1, 0x00, 0x17];
    let config = minimal_video_config(&output_dir, fake_extradata);

    use cap_recording::PipelineHealthEvent;
    let (health_tx, mut health_rx) = tokio::sync::mpsc::channel::<PipelineHealthEvent>(16);

    let mut subprocess =
        MuxerSubprocess::spawn(bin, config, Some(health_tx)).expect("spawn cap-muxer subprocess");

    subprocess
        .kill_for_testing()
        .expect("kill subprocess for testing");

    std::thread::sleep(std::time::Duration::from_millis(100));

    let write_result = subprocess.write_video_packet(0, 0, 0, false, &[0u8; 256]);
    assert!(
        write_result.is_err() || {
            let _ = subprocess.finish();
            true
        }
    );

    let mut saw_crashed = false;
    for _ in 0..10 {
        match health_rx.try_recv() {
            Ok(PipelineHealthEvent::MuxerCrashed { .. }) => {
                saw_crashed = true;
                break;
            }
            Ok(_) => {}
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
        }
    }

    assert!(
        saw_crashed,
        "parent should emit PipelineHealthEvent::MuxerCrashed after kill"
    );
}

#[test]
fn resolve_muxer_binary_respects_env_override() {
    let temp = TempDir::new().unwrap();
    let fake = temp.path().join("fake-muxer");
    std::fs::write(&fake, b"").unwrap();
    unsafe {
        std::env::set_var(cap_recording::oop_muxer::ENV_BIN_PATH, &fake);
    }
    let resolved = resolve_muxer_binary().expect("resolve with override");
    assert_eq!(resolved, fake);
    unsafe {
        std::env::remove_var(cap_recording::oop_muxer::ENV_BIN_PATH);
    }
}

#[test]
fn resolve_muxer_binary_fails_with_invalid_env() {
    unsafe {
        std::env::set_var(
            cap_recording::oop_muxer::ENV_BIN_PATH,
            "/nonexistent/path/definitely-not-here-12345",
        );
    }
    let err = resolve_muxer_binary().unwrap_err();
    assert!(err.to_string().contains("missing path"));
    unsafe {
        std::env::remove_var(cap_recording::oop_muxer::ENV_BIN_PATH);
    }
}

#[test]
fn respawning_subprocess_reports_clean_exit_when_no_crash() {
    let bin = setup_muxer_binary();
    let temp_dir = TempDir::new().unwrap();
    let output_dir = temp_dir.path().join("video");

    let config = minimal_video_config(&output_dir, Vec::new());
    let respawn =
        RespawningMuxerSubprocess::new(bin, config, None, 2).expect("spawn respawn subprocess");

    assert_eq!(respawn.respawn_attempts(), 0);

    let report = respawn.finish().expect("clean finish");
    assert_eq!(report.exit_code, Some(0));
}

#[test]
fn subprocess_survives_finish_after_init_only() {
    let bin = setup_muxer_binary();
    let temp_dir = TempDir::new().unwrap();
    let output_dir = temp_dir.path().join("video");

    let fake_extradata = vec![0x01, 0x64, 0x00, 0x33, 0xFF, 0xE1, 0x00, 0x17];
    let config = minimal_video_config(&output_dir, fake_extradata.clone());

    let subprocess = MuxerSubprocess::spawn(bin, config, None)
        .expect("spawn cap-muxer with non-empty extradata");
    let report = subprocess.finish().expect("finish cleanly");
    assert_eq!(report.exit_code, Some(0));

    let init_path = output_dir.join("init.mp4");
    assert!(
        init_path.exists(),
        "init.mp4 should be written when extradata is supplied"
    );
}

#[test]
fn encoder_to_subprocess_end_to_end_produces_playable_init_and_segments() {
    assert_encoded_recording_survives_finish(60);
}

#[test]
fn the_only_encoded_packet_is_flushed_before_empty_output_is_decided() {
    assert_encoded_recording_survives_finish(1);
}

fn assert_encoded_recording_survives_finish(frame_count: u64) {
    use cap_enc_ffmpeg::h264::{H264EncoderBuilder, H264Preset};
    use cap_enc_ffmpeg::h264_packet::EncodePacketError;
    use cap_media_info::{Pixel, VideoInfo};

    ffmpeg::init().ok();

    let bin = setup_muxer_binary();
    let temp_dir = TempDir::new().unwrap();
    let output_dir = temp_dir.path().join("video");
    std::fs::create_dir_all(&output_dir).unwrap();

    let video_info = VideoInfo {
        pixel_format: Pixel::NV12,
        width: 320,
        height: 240,
        time_base: ffmpeg::Rational(1, 1_000_000),
        frame_rate: ffmpeg::Rational(30, 1),
    };

    let mut encoder = H264EncoderBuilder::new(video_info)
        .with_preset(H264Preset::Ultrafast)
        .build_standalone()
        .expect("standalone encoder");

    let extradata = encoder.extradata();
    assert!(
        !extradata.is_empty(),
        "expected non-empty extradata from standalone libx264 encoder"
    );

    let config = MuxerSubprocessConfig {
        output_directory: output_dir.clone(),
        init_segment_name: "init.mp4".to_string(),
        media_segment_pattern: "segment_$Number%03d$.m4s".to_string(),
        video_init: Some(VideoStreamInit {
            codec: "libx264".to_string(),
            width: encoder.output_width(),
            height: encoder.output_height(),
            frame_rate: (
                encoder.frame_rate().numerator(),
                encoder.frame_rate().denominator(),
            ),
            time_base: (
                encoder.time_base().numerator(),
                encoder.time_base().denominator(),
            ),
            extradata,
            segment_duration_ms: 500,
        }),
        audio_init: None,
    };

    let mut subprocess =
        MuxerSubprocess::spawn(bin, config, None).expect("spawn cap-muxer subprocess");

    fn ship_packet(
        subprocess: &mut MuxerSubprocess,
        pkt: cap_enc_ffmpeg::h264_packet::EncodedPacket,
    ) -> Result<(), EncodePacketError> {
        subprocess
            .write_video_packet(
                pkt.pts,
                pkt.dts,
                pkt.duration.max(0) as u64,
                pkt.is_keyframe,
                &pkt.data,
            )
            .map_err(|_| {
                EncodePacketError::Encode(ffmpeg::Error::Other {
                    errno: ffmpeg::ffi::AVERROR_EXTERNAL,
                })
            })
    }

    for i in 0..frame_count {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
        for plane_idx in 0..frame.planes() {
            let data = frame.data_mut(plane_idx);
            for (idx, byte) in data.iter_mut().enumerate() {
                *byte = ((i * 13 + idx as u64 * 7) & 0xFF) as u8;
            }
        }
        let timestamp = std::time::Duration::from_millis(i * 33);
        let sub_ref = &mut subprocess;
        encoder
            .encode_frame(frame, timestamp, |pkt| ship_packet(sub_ref, pkt))
            .expect("encode_frame succeeds");
    }

    let sub_ref_flush = &mut subprocess;
    encoder
        .flush(|pkt| ship_packet(sub_ref_flush, pkt))
        .expect("flush succeeds");

    let report = subprocess.finish().expect("subprocess finish cleanly");
    assert_eq!(report.exit_code, Some(0));
    assert_eq!(report.packets_written, frame_count);

    let init_path = output_dir.join("init.mp4");
    assert!(
        init_path.exists(),
        "init.mp4 must exist after end-to-end encode"
    );
    let init_meta = std::fs::metadata(&init_path).unwrap();
    assert!(
        init_meta.len() > 100,
        "init.mp4 should be non-trivially sized, got {} bytes",
        init_meta.len()
    );

    let mut segments = Vec::new();
    for entry in std::fs::read_dir(&output_dir).unwrap().flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("segment_") && name_str.ends_with(".m4s") {
            let meta = entry.metadata().unwrap();
            assert!(
                meta.len() > 0,
                "segment file {name_str} should be non-empty"
            );
            segments.push(entry.path());
        }
    }
    assert!(
        !segments.is_empty(),
        "expected at least one segment_*.m4s file"
    );
    segments.sort();
    let combined_path = temp_dir.path().join("combined.mp4");
    let mut combined = std::fs::read(init_path).unwrap();
    for segment in segments {
        combined.extend(std::fs::read(segment).unwrap());
    }
    std::fs::write(&combined_path, combined).unwrap();
    let mut input = ffmpeg::format::input(&combined_path).unwrap();
    let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
    let stream_index = stream.index();
    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .unwrap()
        .decoder()
        .video()
        .unwrap();
    let mut decoded_frames = 0;
    let mut receive_frames = |decoder: &mut ffmpeg::decoder::Video| loop {
        let mut frame = ffmpeg::frame::Video::empty();
        match decoder.receive_frame(&mut frame) {
            Ok(()) => decoded_frames += 1,
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => break,
            Err(ffmpeg::Error::Eof) => break,
            Err(error) => panic!("Failed to decode finalized recording: {error}"),
        }
    };
    for (stream, packet) in input.packets() {
        if stream.index() == stream_index {
            decoder.send_packet(&packet).unwrap();
            receive_frames(&mut decoder);
        }
    }
    decoder.send_eof().unwrap();
    receive_frames(&mut decoder);
    assert_eq!(decoded_frames, frame_count);
}
