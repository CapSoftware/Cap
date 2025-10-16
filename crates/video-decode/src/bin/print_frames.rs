#[tokio::main]
pub async fn main() {
    #[cfg(target_os = "macos")]
    mac::run_ffmpeg();
    #[cfg(not(target_os = "macos"))]
    panic!("This example is only supported on macOS");
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::PathBuf;

    use cap_video_decode::AVAssetReaderDecoder;
    use ffmpeg::ffi::AVHWDeviceType;

    pub(super) async fn run() {
        let handle = tokio::runtime::Handle::current();

        let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

        let _ = std::thread::spawn(|| {
            let mut decoder = AVAssetReaderDecoder::new(path, handle).unwrap();

            for frame in decoder.frames() {
                let Ok(frame) = frame else {
                    return;
                };

                println!("{:?}", frame.pts());
            }
        })
        .join();
    }

    pub fn run_ffmpeg() {
        let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

        let _ = std::thread::spawn(|| {
            let mut decoder = cap_video_decode::FFmpegDecoder::new(
                path,
                Some(AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX),
            )
            .unwrap();

            for frame in decoder.frames() {
                let Ok(frame) = frame else {
                    return;
                };

                dbg!(frame.format());
                dbg!(frame.pts());
                // println!("{:?}", frame.pts());
            }
        })
        .join();
    }

    // pub fn pts_to_frame(pts: i64, time_base: (f64, f64), fps: u32) -> u32 {
    //     (fps as f64 * ((pts as f64 * time_base.0) / (time_base.1))).round() as u32
    // }
}
