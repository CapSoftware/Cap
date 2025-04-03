use std::time::Instant;

use ffmpeg_sys_next::AVHWDeviceType;

use cap_video_decode::FFmpegDecoder;

fn main() {
    let path = "/Users/brendonovich/Library/Application Support/so.cap.desktop.dev/recordings/789cca54-58ff-4c02-a772-56a01af580bf.cap/content/segments/segment-0/display.mp4";
    let mut decoder =
        FFmpegDecoder::new(path, Some(AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX)).unwrap();

    let start = Instant::now();

    let frame_count = decoder.frames().count();
    let duration = start.elapsed();
    println!(
        "decoded {} frames in {:?} - {} frames/s",
        frame_count,
        duration,
        frame_count as f64 / duration.as_secs_f64()
    );
}
