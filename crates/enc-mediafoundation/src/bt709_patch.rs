use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

use cap_mediafoundation_ffmpeg::{H264StreamMuxer, MuxerConfig};
use windows::{
    Foundation::TimeSpan,
    Graphics::SizeInt32,
    Win32::{
        Graphics::{
            Direct3D11::{
                D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Texture2D,
            },
            Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
        },
        Media::MediaFoundation::{IMFSample, MFSTARTUP_FULL, MFStartup},
        System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize},
    },
};

use crate::{d3d::create_d3d_device, media::MF_VERSION, video::H264Encoder};

const WIDTH: u32 = 64;
const HEIGHT: u32 = 64;
const FPS: u32 = 30;
const RGB: [u8; 3] = [125, 62, 93];
const FRAMES: u32 = 48;

#[test]
#[ignore = "needs a Windows GPU and a Media Foundation H.264 encoder"]
fn color_patch_decodes_as_limited_bt709() {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.expect("RoInitialize");
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.expect("MFStartup");
    ffmpeg::init().expect("ffmpeg::init");

    let device = create_d3d_device().expect("D3D11 device");
    let texture = solid_bgra(&device, RGB);
    let mut encoder = H264Encoder::new(
        &device,
        DXGI_FORMAT_B8G8R8A8_UNORM,
        SizeInt32 {
            Width: WIDTH as i32,
            Height: HEIGHT as i32,
        },
        FPS,
        8.0,
    )
    .expect("Media Foundation H.264 encoder");

    let mut frames_left = FRAMES;
    let mut tick = 0i64;
    let mut samples = Vec::new();
    encoder
        .run(
            Arc::new(AtomicBool::new(false)),
            || {
                if frames_left == 0 {
                    return Ok(None);
                }
                frames_left -= 1;
                let timestamp = TimeSpan { Duration: tick };
                tick += 333_333;
                Ok(Some((texture.clone(), timestamp)))
            },
            |sample| {
                samples.push(sample);
                Ok(())
            },
        )
        .expect("encoder run");
    assert!(
        !samples.is_empty(),
        "encoder emitted no samples from {FRAMES} frames"
    );

    let path = std::env::temp_dir().join(format!("cap-mf-bt709-{}.mp4", std::process::id()));
    let _ = std::fs::remove_file(&path);
    write_mp4(&path, encoder.bitrate(), &samples);
    let frame = first_decoded_frame(&path);
    assert_eq!(frame.width(), WIDTH);
    assert_eq!(frame.height(), HEIGHT);
    let actual = sample_yuv(&frame);
    let expected = crate::color::bt709_limited_yuv(RGB);
    assert_eq!(frame.color_space(), ffmpeg::color::Space::BT709);
    assert_eq!(frame.color_range(), ffmpeg::color::Range::MPEG);
    for (index, (got, want)) in actual.into_iter().zip(expected).enumerate() {
        assert!(
            got.abs_diff(want) <= 2,
            "component {index}: decoded {actual:?}, BT.709 limited {expected:?}"
        );
    }
    let _ = std::fs::remove_file(&path);
}

fn solid_bgra(device: &ID3D11Device, rgb: [u8; 3]) -> ID3D11Texture2D {
    let [r, g, b] = rgb;
    let pixels = vec![b, g, r, 255].repeat((WIDTH * HEIGHT) as usize);
    let desc = D3D11_TEXTURE2D_DESC {
        Width: WIDTH,
        Height: HEIGHT,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let initial = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr().cast::<core::ffi::c_void>(),
        SysMemPitch: WIDTH * 4,
        SysMemSlicePitch: 0,
    };
    unsafe {
        let mut texture = None;
        device
            .CreateTexture2D(&desc, Some(&initial), Some(&mut texture))
            .expect("CreateTexture2D");
        texture.expect("CreateTexture2D returned no texture")
    }
}

fn write_mp4(path: &Path, bitrate: u32, samples: &[IMFSample]) {
    let mut output = ffmpeg::format::output_as(path, "mp4").expect("create mp4");
    let mut muxer = H264StreamMuxer::new(
        &mut output,
        MuxerConfig {
            width: WIDTH,
            height: HEIGHT,
            fps: FPS,
            bitrate,
            fragmented: false,
            frag_duration_us: 2_000_000,
        },
    )
    .expect("H264 muxer");
    output.write_header().expect("mp4 header");
    for sample in samples {
        muxer
            .write_sample(sample, &mut output)
            .expect("write sample");
    }
    muxer.finish().expect("finish muxer");
    output.write_trailer().expect("mp4 trailer");
}

fn first_decoded_frame(path: &Path) -> ffmpeg::frame::Video {
    let mut input = ffmpeg::format::input(path).expect("open mp4");
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .expect("video stream");
    let index = stream.index();
    let mut decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
        .expect("decoder context")
        .decoder()
        .video()
        .expect("h264 decoder");
    let mut frames = Vec::new();
    for (stream, packet) in input.packets() {
        if stream.index() != index {
            continue;
        }
        decoder.send_packet(&packet).expect("send packet");
        receive_frames(&mut decoder, &mut frames);
        if !frames.is_empty() {
            break;
        }
    }
    decoder.send_eof().expect("decoder eof");
    receive_frames(&mut decoder, &mut frames);
    frames.into_iter().next().expect("decoded frame")
}

fn receive_frames(decoder: &mut ffmpeg::decoder::Video, frames: &mut Vec<ffmpeg::frame::Video>) {
    loop {
        let mut frame = ffmpeg::frame::Video::empty();
        match decoder.receive_frame(&mut frame) {
            Ok(()) => frames.push(frame),
            Err(ffmpeg::Error::Eof) => break,
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => break,
            Err(error) => panic!("receive decoded frame: {error}"),
        }
    }
}

fn sample_yuv(frame: &ffmpeg::frame::Video) -> [u8; 3] {
    let x = frame.width() as usize / 2;
    let y = frame.height() as usize / 2;
    let luma = frame.data(0)[y * frame.stride(0) + x];
    let (cb, cr) = match frame.format() {
        ffmpeg::format::Pixel::YUV420P => {
            let cx = x / 2;
            let cy = y / 2;
            (
                frame.data(1)[cy * frame.stride(1) + cx],
                frame.data(2)[cy * frame.stride(2) + cx],
            )
        }
        ffmpeg::format::Pixel::NV12 => {
            let cx = x & !1usize;
            let cy = y / 2;
            let row = cy * frame.stride(1);
            (frame.data(1)[row + cx], frame.data(1)[row + cx + 1])
        }
        other => panic!("decoded pixel format {other:?}"),
    };
    [luma, cb, cr]
}
