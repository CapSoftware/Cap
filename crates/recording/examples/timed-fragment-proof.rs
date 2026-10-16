use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};
use cap_media_info::VideoInfo;
use cap_recording::recovery::RecoveryManager;
use ffmpeg::{Rational, format, frame};
use serde_json::json;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            fs::copy(entry.path(), destination.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn pictures() -> Vec<frame::Video> {
    (0..30)
        .map(|index| {
            let mut frame = frame::Video::new(format::Pixel::NV12, 1920, 1080);
            for plane in 0..frame.planes() {
                let stride = frame.stride(plane);
                for (offset, value) in frame.data_mut(plane).iter_mut().enumerate() {
                    *value = if plane == 0 {
                        (16 + ((offset % stride / 32 + offset / stride / 32 + index) % 14) * 16)
                            as u8
                    } else {
                        128
                    };
                }
            }
            frame
        })
        .collect()
}

fn main() -> Result<()> {
    ffmpeg::init()?;
    ffmpeg::log::set_level(ffmpeg::log::Level::Info);
    let root = std::env::args().nth(1).ok_or("output directory required")?;
    let root = Path::new(&root);
    fs::create_dir_all(root)?;
    let frames = pictures();
    let mut records = Vec::new();
    for step in [1_u64, 2, 10, 30] {
        for mode in ["control-calibration", "control", "timed"] {
            let directory = root.join(format!("{step}/{mode}"));
            let media = directory.join("media");
            let mut encoder = SegmentedVideoEncoder::init_with_timed_fragments(
                media.clone(),
                VideoInfo {
                    width: 1920,
                    height: 1080,
                    pixel_format: format::Pixel::NV12,
                    time_base: Rational(1, 1_000_000),
                    frame_rate: Rational(30, 1),
                },
                SegmentedVideoEncoderConfig::default(),
                mode == "timed",
            )?;
            let mut queue_times = Vec::new();
            let mut snapshots = Vec::new();
            let mut thresholds = [7.0_f64, 17.0, 59.0].into_iter().peekable();
            for slot in (0..1800_u64).step_by(step as usize) {
                let timestamp = Duration::from_nanos(slot * 1_000_000_000 / 30);
                let start = Instant::now();
                encoder.queue_frame(frames[(slot % 30) as usize].clone(), timestamp)?;
                queue_times.push(start.elapsed().as_nanos());
                if thresholds
                    .peek()
                    .is_some_and(|threshold| timestamp.as_secs_f64() >= *threshold)
                {
                    let threshold = thresholds.next().ok_or("snapshot threshold")?;
                    let snapshot = directory.join(format!("at-{threshold}"));
                    copy_directory(&media, &snapshot)?;
                    let recovered = directory.join(format!("at-{threshold}.mp4"));
                    let recovery =
                        RecoveryManager::finalize_to_progressive_mp4(&snapshot, &recovered);
                    snapshots.push(json!({"input_pts":timestamp.as_secs_f64(),"directory":format!("at-{threshold}"),"recovery_error":recovery.err().map(|error|error.to_string())}));
                }
            }
            encoder.finish_with_timestamp(Duration::from_secs(60))?;
            let segments = encoder.completed_segments().len();
            drop(encoder);
            RecoveryManager::finalize_to_progressive_mp4(&media, &directory.join("final.mp4"))?;
            records.push(json!({"step":step,"mode":mode,"frames":1800/step,"segments":segments,"queue_nanos":queue_times,"snapshots":snapshots}));
            fs::write(
                root.join("records.json"),
                serde_json::to_vec_pretty(&records)?,
            )?;
        }
    }
    Ok(())
}
