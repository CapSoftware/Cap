use std::time::{Duration, Instant};

use cap_enc_ffmpeg::{mov::MOVFile, prores::ProResEncoder};
use cap_media_info::{RawVideoFormat, VideoInfo};
use ffmpeg::{format, frame};

fn arg(name: &str, default: u32) -> u32 {
    let flag = format!("--{name}");
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == &flag)
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn patterned_rgba(width: u32, height: u32, seed: u32) -> frame::Video {
    let mut rgba = frame::Video::new(format::Pixel::RGBA, width, height);
    let stride = rgba.stride(0);
    let data = rgba.data_mut(0);
    for row in 0..height as usize {
        for col in 0..width as usize {
            let index = row * stride + col * 4;
            data[index] = (col as u32 + seed) as u8;
            data[index + 1] = (row as u32 + seed * 3) as u8;
            data[index + 2] = ((col ^ row) as u32 + seed * 7) as u8;
            data[index + 3] = 255;
        }
    }
    rgba
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

fn main() {
    ffmpeg::init().unwrap();
    let width = arg("width", 1920);
    let height = arg("height", 1080);
    let frames = arg("frames", 120);
    let fps = 30;

    let inputs: Vec<frame::Video> = (0..8)
        .map(|seed| patterned_rgba(width, height, seed))
        .collect();

    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("bench.mov");
    let info = VideoInfo::from_raw(RawVideoFormat::Rgba, width, height, fps);
    let mut mov = MOVFile::init(output.clone(), |output| {
        ProResEncoder::builder(info).build(output)
    })
    .unwrap();
    let mut input = frame::Video::new(format::Pixel::RGBA, width, height);
    let mut queue_samples = Vec::with_capacity(frames as usize);
    let started = Instant::now();
    for index in 0..frames {
        let source = &inputs[index as usize % inputs.len()];
        input.data_mut(0).copy_from_slice(source.data(0));
        let queued = Instant::now();
        mov.queue_video_frame(
            &mut input,
            Duration::from_secs_f64(f64::from(index) / f64::from(fps)),
        )
        .unwrap();
        queue_samples.push(queued.elapsed());
    }
    mov.finish().unwrap();
    let total = started.elapsed();
    let bytes = std::fs::metadata(output.with_extension("mov"))
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    println!(
        "prores_queue {width}x{height} frames={frames} queue_median_ms={:.2} total_secs={:.3} fps={:.1} bytes={bytes}",
        median(queue_samples).as_secs_f64() * 1000.0,
        total.as_secs_f64(),
        f64::from(frames) / total.as_secs_f64(),
    );
}
