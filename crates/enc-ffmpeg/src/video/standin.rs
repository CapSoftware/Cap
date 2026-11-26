use std::{path::Path, time::Duration};

use cap_media_info::{Pixel, VideoInfo};
use ffmpeg::util::rational::Rational as FFRational;

use crate::video::h264::H264Encoder;

/// Writes a black H.264 MP4 that lasts `duration`: one frame at the start and
/// one on the last frame time, so it costs two frames however long it runs.
/// It stands in for the display track of a recording that has no picture.
/// Written beside `path` and renamed into place, so a reader never sees half
/// a file.
pub fn write_black_standin(
    path: &Path,
    width: u32,
    height: u32,
    fps: u32,
    duration: Duration,
    encoders: &'static [&'static str],
) -> Result<(), String> {
    let info = VideoInfo {
        pixel_format: Pixel::YUV420P,
        width,
        height,
        time_base: FFRational(1, 1_000_000),
        frame_rate: FFRational(fps.max(1) as i32, 1),
    };
    let staged = path.with_extension("standin.mp4");
    let mut output =
        ffmpeg::format::output_as(&staged, "mp4").map_err(|error| error.to_string())?;
    let mut encoder = H264Encoder::builder(info)
        .with_encoder_priority_override(encoders)
        .build(&mut output)
        .map_err(|error| error.to_string())?;
    output.write_header().map_err(|error| error.to_string())?;

    let mut black = ffmpeg::frame::Video::new(info.pixel_format, info.width, info.height);
    for (plane, value) in [(0, 16u8), (1, 128u8), (2, 128u8)] {
        black.data_mut(plane).fill(value);
    }
    for time in standin_frame_times(duration, fps) {
        encoder
            .queue_frame(black.clone(), time, &mut output)
            .map_err(|error| format!("{error:?}"))?;
    }
    encoder
        .flush(&mut output)
        .map_err(|error| error.to_string())?;
    output.write_trailer().map_err(|error| error.to_string())?;
    drop(output);
    std::fs::rename(&staged, path).map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        error.to_string()
    })
}

fn standin_frame_times(duration: Duration, fps: u32) -> Vec<Duration> {
    let last = duration.saturating_sub(Duration::from_secs(1) / fps.max(1));
    if last.is_zero() {
        vec![Duration::ZERO]
    } else {
        vec![Duration::ZERO, last]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_times_cover_the_span_with_two_frames() {
        assert_eq!(
            standin_frame_times(Duration::from_secs(2), 30),
            vec![
                Duration::ZERO,
                Duration::from_secs(2).saturating_sub(Duration::from_secs(1) / 30)
            ]
        );
        assert_eq!(
            standin_frame_times(Duration::from_millis(10), 30),
            vec![Duration::ZERO]
        );
    }

    #[test]
    fn standin_lasts_as_long_as_asked() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("display.mp4");
        write_black_standin(
            &path,
            1920,
            1080,
            30,
            Duration::from_millis(7_250),
            &["libx264"],
        )
        .unwrap();
        let input = ffmpeg::format::input(&path).unwrap();
        let seconds = input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
        assert!((seconds - 7.25).abs() < 0.05, "{seconds}");
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        assert_eq!((decoder.width(), decoder.height()), (1920, 1080));
        assert!(std::fs::metadata(&path).unwrap().len() < 16 * 1024);
        assert!(!path.with_extension("standin.mp4").exists());
    }
}
