//! The recorder can die while cap-muxer runs. Its stdin then reaches EOF and
//! the pipe the recorder read cap-muxer's stderr through is closed; cap-muxer
//! must still finish the fragment it has open.

use std::{
    io::Write,
    process::{Command, Stdio},
};

use cap_muxer_protocol::{
    Frame, InitVideo, PACKET_FLAG_KEYFRAME, Packet, STREAM_INDEX_VIDEO, StartParams, write_frame,
    write_packet,
};
use ffmpeg::{codec, format, frame};

const WIDTH: u32 = 320;
const HEIGHT: u32 = 240;
const FPS: i32 = 30;

type EncodedPacket = (i64, i64, bool, Vec<u8>);

fn encode(count: i64, gop: u32) -> (Vec<u8>, Vec<EncodedPacket>) {
    ffmpeg::init().unwrap();
    let codec = codec::encoder::find_by_name("libx264").expect("libx264");
    let mut context = codec::context::Context::new_with_codec(codec)
        .encoder()
        .video()
        .unwrap();
    context.set_width(WIDTH);
    context.set_height(HEIGHT);
    context.set_format(format::Pixel::YUV420P);
    context.set_time_base((1, FPS));
    context.set_frame_rate(Some((FPS, 1)));
    context.set_gop(gop);
    context.set_max_b_frames(0);
    context.set_flags(codec::Flags::GLOBAL_HEADER);
    let mut options = ffmpeg::Dictionary::new();
    options.set("preset", "ultrafast");
    options.set("tune", "zerolatency");
    let mut encoder = context.open_as_with(codec, options).unwrap();
    let extradata = unsafe {
        let ctx = encoder.as_ptr();
        std::slice::from_raw_parts((*ctx).extradata, (*ctx).extradata_size as usize).to_vec()
    };
    let mut packets = Vec::new();
    let mut packet = ffmpeg::Packet::empty();
    let mut drain = |encoder: &mut ffmpeg::encoder::Video, packets: &mut Vec<_>| {
        while encoder.receive_packet(&mut packet).is_ok() {
            packets.push((
                packet.pts().unwrap(),
                packet.dts().unwrap(),
                packet.is_key(),
                packet.data().unwrap().to_vec(),
            ));
        }
    };
    for index in 0..count {
        let mut picture = frame::Video::new(format::Pixel::YUV420P, WIDTH, HEIGHT);
        for plane in 0..3 {
            picture.data_mut(plane).fill((index * 3 % 255) as u8);
        }
        picture.set_pts(Some(index));
        encoder.send_frame(&picture).unwrap();
        drain(&mut encoder, &mut packets);
    }
    encoder.send_eof().unwrap();
    drain(&mut encoder, &mut packets);
    (extradata, packets)
}

#[test]
fn an_orphaned_muxer_finishes_its_open_fragment() {
    let (extradata, packets) = encode(75, 30);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("display");
    let mut child = Command::new(env!("CARGO_BIN_EXE_cap-muxer"))
        .env("CAP_MUXER_LOG", "warn")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    write_frame(
        &mut stdin,
        &Frame::InitVideo(InitVideo {
            codec: "libx264".into(),
            width: WIDTH,
            height: HEIGHT,
            frame_rate_num: FPS,
            frame_rate_den: 1,
            time_base_num: 1,
            time_base_den: FPS,
            extradata,
            segment_duration_ms: 1000,
        }),
    )
    .unwrap();
    write_frame(
        &mut stdin,
        &Frame::Start(StartParams {
            output_directory: output.to_string_lossy().into_owned(),
            init_segment_name: "init.mp4".into(),
            media_segment_pattern: "segment_$Number%03d$.m4s".into(),
        }),
    )
    .unwrap();
    for (pts, dts, key, data) in &packets {
        write_packet(
            &mut stdin,
            &Packet {
                stream_index: STREAM_INDEX_VIDEO,
                pts: *pts,
                dts: *dts,
                duration: 1,
                flags: if *key { PACKET_FLAG_KEYFRAME } else { 0 },
                data,
            },
        )
        .unwrap();
    }
    stdin.flush().unwrap();
    // The recorder dies: its end of the stderr pipe closes, then stdin.
    drop(child.stderr.take());
    drop(stdin);
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0), "cap-muxer must finish, not panic");

    let mut segments: Vec<_> = std::fs::read_dir(&output)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("segment_"))
        .collect();
    segments.sort();
    assert_eq!(
        segments,
        ["segment_001.m4s", "segment_002.m4s", "segment_003.m4s"],
        "every fragment, including the one open when the recorder died, is finished"
    );
}
