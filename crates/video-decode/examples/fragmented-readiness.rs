use cap_video_decode::FFmpegDecoder;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Instant};

fn main() -> Result<(), String> {
    let mut arguments = std::env::args().skip(1);
    let path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("Pass a video path")?;
    let times = arguments
        .map(|time| time.parse::<f32>().map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let times = if times.is_empty() { vec![0.0] } else { times };
    let frames_per_seek = std::env::var("CAP_BENCH_FRAMES")
        .map_or(Ok(30), |value| value.parse::<usize>())
        .map_err(|error| error.to_string())?;
    let hardware = std::env::var_os("CAP_BENCH_HW").is_some();
    let device = hardware.then_some(if cfg!(target_os = "macos") {
        ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX
    } else if cfg!(target_os = "windows") {
        ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA
    } else {
        ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI
    });
    let started = Instant::now();
    let mut decoder = FFmpegDecoder::new(&path, device)?;
    let opened_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut probes = Vec::new();
    for (index, time) in times.into_iter().enumerate() {
        let sought = Instant::now();
        if index > 0 || time != 0.0 {
            decoder.reset(time).map_err(|error| error.to_string())?;
        }
        let mut frames = decoder.frames();
        let mut digest = Sha256::new();
        let mut frame_count = 0;
        let mut first_ms = None;
        let mut first_timestamp = None;
        let mut last_timestamp = None;
        for frame in frames.by_ref().take(frames_per_seek) {
            let frame = frame.map_err(|error| error.to_string())?;
            first_ms.get_or_insert_with(|| sought.elapsed().as_secs_f64() * 1000.0);
            let timestamp = frame.timestamp().or_else(|| frame.pts());
            if frame_count == 0 {
                first_timestamp = timestamp;
            }
            last_timestamp = timestamp;
            digest.update(timestamp.unwrap_or(i64::MIN).to_le_bytes());
            digest.update(frame.width().to_le_bytes());
            digest.update(frame.height().to_le_bytes());
            if frame.planes() == 0 {
                return Err("Decoded frame has no readable planes".into());
            }
            for plane in 0..frame.planes() {
                let row_bytes = unsafe {
                    ffmpeg::sys::av_image_get_linesize(
                        frame.format().into(),
                        frame.width() as i32,
                        plane as i32,
                    )
                };
                if row_bytes <= 0 || row_bytes as usize > frame.stride(plane) {
                    return Err("Decoded frame has an invalid row size".into());
                }
                let height = frame.plane_height(plane) as usize;
                for row in frame.data(plane).chunks(frame.stride(plane)).take(height) {
                    digest.update(&row[..row_bytes as usize]);
                }
            }
            frame_count += 1;
        }
        if frame_count == 0 {
            return Err(format!("No decoded frames at {time}"));
        }
        probes.push(serde_json::json!({
            "time": time,
            "firstFrameMs": first_ms,
            "firstTimestamp": first_timestamp,
            "lastTimestamp": last_timestamp,
            "frames": frame_count,
            "sha256": format!("{:x}", digest.finalize()),
        }));
    }
    println!(
        "{}",
        serde_json::json!({
            "path": path,
            "openMs": opened_ms,
            "hardware": decoder.is_hardware_accelerated(),
            "probes": probes,
        })
    );
    Ok(())
}
