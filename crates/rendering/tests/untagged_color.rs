use std::path::{Path, PathBuf};

use cap_rendering::{
    DecodedFrame, PixelFormat,
    cpu_yuv::{YuvMatrix, nv12_to_rgba_with_matrix, yuv420p_to_rgba_with_matrix},
    decoder::{DecoderType, spawn_decoder},
};

const ORANGE: [u8; 3] = [224, 122, 48];
const ORANGE_BT709_YCBCR: [u8; 3] = [133, 85, 175];
const ORANGE_BT601_YCBCR: [u8; 3] = [140, 80, 178];
const TOLERANCE: u8 = 8;

struct Clip {
    name: &'static str,
    width: u32,
    height: u32,
    ycbcr: [u8; 3],
    tag: Option<ffmpeg::util::color::Space>,
    matrix: YuvMatrix,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn editor_and_export_decode_untagged_hd_as_bt709() {
    ffmpeg::init().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let clips = [
        Clip {
            name: "untagged-hd",
            width: 1280,
            height: 720,
            ycbcr: ORANGE_BT709_YCBCR,
            tag: None,
            matrix: YuvMatrix::Bt709,
        },
        Clip {
            name: "untagged-480p",
            width: 640,
            height: 480,
            ycbcr: ORANGE_BT601_YCBCR,
            tag: None,
            matrix: YuvMatrix::Bt601,
        },
        Clip {
            name: "tagged-bt601",
            width: 1280,
            height: 720,
            ycbcr: ORANGE_BT601_YCBCR,
            tag: Some(ffmpeg::util::color::Space::SMPTE170M),
            matrix: YuvMatrix::Bt601,
        },
    ];

    for clip in clips {
        let path = directory.path().join(format!("{}.mp4", clip.name));
        write_clip(&path, &clip);
        assert_stream_tag(&path, &clip);
        let decoder = spawn_decoder(clip.name, path, 30, 0.0, true)
            .await
            .unwrap_or_else(|error| panic!("{} decoder: {error}", clip.name));
        let decoder_type = decoder.decoder_type();
        assert!(
            matches!(
                decoder_type,
                DecoderType::FFmpegSoftware | DecoderType::FFmpegHardware
            ),
            "{} decoded with {decoder_type}, outside the FFmpeg path that applies the editor matrix",
            clip.name
        );
        let frame = decoder
            .get_frame_initial(0.0)
            .await
            .unwrap_or_else(|| panic!("{} produced no frame", clip.name));
        let rgb = rgb_from_decoded(&frame);
        for (channel, (actual, expected)) in rgb.into_iter().zip(ORANGE).enumerate() {
            assert!(
                actual.abs_diff(expected) <= TOLERANCE,
                "{} channel {channel}: decoded {rgb:?}, source {ORANGE:?}, matrix {:?}",
                clip.name,
                frame.matrix()
            );
        }
        assert_eq!(
            frame.matrix(),
            clip.matrix,
            "{} matrix from the editor and export decoder",
            clip.name
        );
    }
}

fn rgb_from_decoded(frame: &DecodedFrame) -> [u8; 3] {
    let width = frame.width();
    let height = frame.height();
    let mut rgba = vec![0u8; width as usize * height as usize * 4];
    match frame.format() {
        PixelFormat::Yuv420p => yuv420p_to_rgba_with_matrix(
            frame.y_plane().expect("y"),
            frame.u_plane().expect("u"),
            frame.v_plane().expect("v"),
            width,
            height,
            frame.y_stride(),
            frame.uv_stride(),
            &mut rgba,
            frame.matrix(),
        ),
        PixelFormat::Nv12 => nv12_to_rgba_with_matrix(
            frame.y_plane().expect("y"),
            frame.uv_plane().expect("uv"),
            width,
            height,
            frame.y_stride(),
            frame.uv_stride(),
            &mut rgba,
            frame.matrix(),
        ),
        PixelFormat::Rgba => {
            rgba = frame.data().to_vec();
        }
    }
    let x = (width / 2) as usize;
    let y = (height / 2) as usize;
    let index = (y * width as usize + x) * 4;
    [rgba[index], rgba[index + 1], rgba[index + 2]]
}

fn write_clip(path: &Path, clip: &Clip) {
    let codec = ffmpeg::encoder::find_by_name("libx264")
        .or_else(|| ffmpeg::encoder::find(ffmpeg::codec::Id::MPEG4))
        .expect("a bundled video encoder");
    let mut output = ffmpeg::format::output_as(path, "mp4").unwrap();
    let global_header = output
        .format()
        .flags()
        .contains(ffmpeg::format::Flags::GLOBAL_HEADER);
    let (stream_index, mut encoder) = {
        let mut stream = output.add_stream(codec).unwrap();
        let stream_index = stream.index();
        stream.set_time_base((1, 30));
        stream.set_rate((30, 1));
        let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .unwrap();
        encoder.set_width(clip.width);
        encoder.set_height(clip.height);
        encoder.set_format(ffmpeg::format::Pixel::YUV420P);
        encoder.set_frame_rate(Some((30, 1)));
        encoder.set_time_base((1, 30));
        if let Some(space) = clip.tag {
            encoder.set_colorspace(space);
            encoder.set_color_range(ffmpeg::util::color::Range::MPEG);
            unsafe {
                (*encoder.as_mut_ptr()).color_primaries =
                    ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_SMPTE170M;
                (*encoder.as_mut_ptr()).color_trc =
                    ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_SMPTE170M;
            }
        }
        if global_header {
            encoder.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
        }
        stream.set_parameters(&encoder);
        let encoder = encoder.open_as(codec).unwrap();
        stream.set_parameters(&encoder);
        if clip.tag.is_none() {
            unsafe {
                let parameters = (*stream.as_mut_ptr()).codecpar;
                (*parameters).color_space = ffmpeg::ffi::AVColorSpace::AVCOL_SPC_UNSPECIFIED;
                (*parameters).color_primaries =
                    ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_UNSPECIFIED;
                (*parameters).color_trc =
                    ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_UNSPECIFIED;
                (*parameters).color_range = ffmpeg::ffi::AVColorRange::AVCOL_RANGE_UNSPECIFIED;
            }
        }
        (stream_index, encoder)
    };
    let mut header = ffmpeg::Dictionary::new();
    if clip.tag.is_some() {
        header.set("movflags", "+write_colr");
    }
    output.write_header_with(header).unwrap();
    let output_time_base = output.stream(stream_index).unwrap().time_base();
    let mut frame =
        ffmpeg::frame::Video::new(ffmpeg::format::Pixel::YUV420P, clip.width, clip.height);
    frame.data_mut(0).fill(clip.ycbcr[0]);
    frame.data_mut(1).fill(clip.ycbcr[1]);
    frame.data_mut(2).fill(clip.ycbcr[2]);
    let (space, range) = match clip.tag {
        Some(space) => (space, ffmpeg::util::color::Range::MPEG),
        None => (
            ffmpeg::util::color::Space::Unspecified,
            ffmpeg::util::color::Range::Unspecified,
        ),
    };
    frame.set_color_space(space);
    frame.set_color_range(range);
    for pts in 0..2 {
        frame.set_pts(Some(pts));
        encoder.send_frame(&frame).unwrap();
        write_packets(&mut encoder, &mut output, stream_index, output_time_base);
    }
    encoder.send_eof().unwrap();
    write_packets(&mut encoder, &mut output, stream_index, output_time_base);
    output.write_trailer().unwrap();
}

fn write_packets(
    encoder: &mut ffmpeg::codec::encoder::video::Encoder,
    output: &mut ffmpeg::format::context::Output,
    stream_index: usize,
    output_time_base: ffmpeg::Rational,
) {
    let mut packet = ffmpeg::Packet::empty();
    while encoder.receive_packet(&mut packet).is_ok() {
        packet.set_stream(stream_index);
        packet.rescale_ts(encoder.time_base(), output_time_base);
        packet.write_interleaved(output).unwrap();
    }
}

fn assert_stream_tag(path: &PathBuf, clip: &Clip) {
    let expected = clip.tag.unwrap_or(ffmpeg::util::color::Space::Unspecified);
    let mut input = ffmpeg::format::input(path).unwrap();
    let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
    let container =
        ffmpeg::util::color::Space::from(unsafe { (*stream.parameters().as_ptr()).color_space });
    assert_eq!(container, expected, "{} container tag", clip.name);
    let index = stream.index();
    let mut decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
        .unwrap()
        .decoder()
        .video()
        .unwrap();
    let mut decoded = ffmpeg::frame::Video::empty();
    for (stream, packet) in input.packets() {
        if stream.index() != index {
            continue;
        }
        decoder.send_packet(&packet).unwrap();
        if decoder.receive_frame(&mut decoded).is_ok() {
            break;
        }
    }
    if decoded.width() == 0 {
        decoder.send_eof().unwrap();
        decoder.receive_frame(&mut decoded).unwrap();
    }
    assert_eq!(
        decoded.color_space(),
        expected,
        "{} decoded frame tag",
        clip.name
    );
}
