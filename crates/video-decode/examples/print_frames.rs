use std::{path::PathBuf, time::Instant};

#[cfg(target_os = "macos")]
use cap_video_decode::AVAssetReaderDecoder;

#[cfg(windows)]
use cap_video_decode::FFmpegDecoder;
use ffmpeg_sys_next::AVHWDeviceType;

#[tokio::main]
pub async fn main() {
    let handle = tokio::runtime::Handle::current();

    let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

    let _ = std::thread::spawn(|| {
        let mut decoder =
            FFmpegDecoder::new(path, Some(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA)).unwrap();

        let start = Instant::now();
        for frame in decoder.frames() {
            let Ok(frame) = frame else {
                return;
            };

            dbg!(frame.format());
            dbg!(frame.pts());
            dbg!(frame.planes());
            for i in 0..frame.planes() {
                dbg!(frame.data(i).len());
            }
        }
        println!("Elapsed time: {:?}", start.elapsed());
    })
    .join();
}

pub fn pts_to_frame(pts: i64, time_base: (f64, f64), fps: u32) -> u32 {
    (fps as f64 * ((pts as f64 * time_base.0) / (time_base.1))).round() as u32
}
