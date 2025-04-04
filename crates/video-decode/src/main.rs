use std::time::Instant;

use cap_video_decode::AVAssetReaderDecoder;

#[tokio::main]
async fn main() {
    let handle = tokio::runtime::Handle::current();

    let _ = std::thread::spawn(|| {
        let mut args = std::env::args();
        args.next();

        let path = args.next().unwrap();

        let mut decoder = AVAssetReaderDecoder::new(path.into(), handle).unwrap();

        let start = Instant::now();

        let frame_count = decoder.frames().count();
        let duration = start.elapsed();
        println!(
            "decoded {} frames in {:?} - {} frames/s",
            frame_count,
            duration,
            frame_count as f64 / duration.as_secs_f64()
        );
    })
    .join();
}
