use cap_enc_ffmpeg::decode_limit::{apply_decode_pixel_limit, limit_decode_pixels, open_input};
use std::path::{Path, PathBuf};

const RENDER_FARM_DECODE_LIMIT: i64 = 41_311_744;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../render-farm/tests/fixtures")
        .join(name)
}

fn first_frame(path: &Path) -> Result<(u32, u32), ffmpeg::Error> {
    let mut input = open_input(path)?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or(ffmpeg::Error::StreamNotFound)?;
    let index = stream.index();
    let mut context = ffmpeg::codec::Context::from_parameters(stream.parameters())?;
    apply_decode_pixel_limit(&mut context);
    let mut decoder = context.decoder().video()?;
    let mut frame = ffmpeg::frame::Video::empty();
    for (stream, packet) in input.packets() {
        if stream.index() == index {
            decoder.send_packet(&packet).ok();
            if decoder.receive_frame(&mut frame).is_ok() {
                return Ok((frame.width(), frame.height()));
            }
        }
    }
    decoder.send_eof()?;
    decoder.receive_frame(&mut frame)?;
    Ok((frame.width(), frame.height()))
}

/// `understated.mp4` carries an 8192x8192 stream in a container that declares
/// 1920x1080. One test, so the process-wide limit changes at a known point.
#[test]
fn decode_limit_refuses_streams_larger_than_their_container_declares() {
    ffmpeg::init().unwrap();
    let understated = fixture("understated.mp4");
    let at_limit = fixture("at-limit.mp4");

    assert_eq!(first_frame(&understated).unwrap(), (8192, 8192));
    assert_eq!(first_frame(&at_limit).unwrap(), (8000, 5000));

    limit_decode_pixels(RENDER_FARM_DECODE_LIMIT);
    assert!(first_frame(&understated).is_err());
    assert_eq!(first_frame(&at_limit).unwrap(), (8000, 5000));
}
