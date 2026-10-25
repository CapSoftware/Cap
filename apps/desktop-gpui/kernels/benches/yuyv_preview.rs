use cap_gpui_kernels::{frame, yuyv};
use ffmpeg::format::Pixel;
use ffmpeg::software::scaling::{self, context::Context};
use std::hint::black_box;
use std::time::Instant;

fn main() {
    ffmpeg::init().expect("ffmpeg");
    let mirror_cases = [false, true];
    let sizes = [(1280u32, 720u32), (1920, 1080)];
    println!("workload,mirror,sample,swscale_copy_ns,avx2_ns,scalar_ns,max_abs");
    println!("# each column is its own warmup+sample run; the preview uses one path per frame");
    for (width, height) in sizes {
        for mirrored in mirror_cases {
            measure(width, height, mirrored);
        }
    }
}

fn measure(width: u32, height: u32, mirrored: bool) {
    let frame = yuyv_frame(width, height);
    let mut scaler = scaling_context(&frame);
    let before = swscale_copy(&frame, &mut scaler, mirrored);
    let fast = yuyv::to_bgra(
        frame.data(0),
        width as usize,
        frame.stride(0),
        height as usize,
        mirrored,
    )
    .expect("kernel");
    let scalar = yuyv::to_bgra_scalar(
        frame.data(0),
        width as usize,
        frame.stride(0),
        height as usize,
        mirrored,
    )
    .expect("scalar");
    assert_eq!(fast, scalar, "{width}x{height} mirror={mirrored}");
    let max_abs = max_abs_diff(&before, &fast);
    assert!(
        max_abs <= 3,
        "{width}x{height} mirror={mirrored} swscale delta {max_abs}"
    );
    eprintln!(
        "check {width}x{height} mirror={mirrored} stride={} bgra_stride={} max_abs={max_abs}",
        frame.stride(0),
        {
            let mut converted = ffmpeg::frame::Video::empty();
            scaler.run(&frame, &mut converted).unwrap();
            converted.stride(0)
        }
    );

    const WARMUP: usize = 8;
    const SAMPLES: usize = 31;
    let sw = timed(WARMUP, SAMPLES, || {
        time_swscale(&frame, &mut scaler, mirrored)
    });
    let mut reused_frame = ffmpeg::frame::Video::empty();
    let sw_reused = timed(WARMUP, SAMPLES, || {
        let start = Instant::now();
        let pixels = swscale_copy_into(
            black_box(&frame),
            &mut scaler,
            black_box(mirrored),
            &mut reused_frame,
        );
        black_box(pixels);
        start.elapsed().as_nanos() as u64
    });
    let avx = timed(WARMUP, SAMPLES, || time_avx(&frame, mirrored));
    let scalar = timed(WARMUP, SAMPLES, || time_scalar(&frame, mirrored));
    for sample in 0..SAMPLES {
        println!(
            "{width}x{height},{mirrored},{sample},{},{},{},{max_abs}",
            sw[sample], avx[sample], scalar[sample]
        );
    }
    eprintln!(
        "summary {width}x{height} mirror={mirrored} fresh_frame_swscale_copy_median_us={:.1} reused_frame_swscale_copy_median_us={:.1} avx2_median_us={:.1} scalar_median_us={:.1} max_abs={max_abs}",
        median_ns(&sw) as f64 / 1000.0,
        median_ns(&sw_reused) as f64 / 1000.0,
        median_ns(&avx) as f64 / 1000.0,
        median_ns(&scalar) as f64 / 1000.0,
    );
}

fn timed(warmup: usize, samples: usize, mut run: impl FnMut() -> u64) -> Vec<u64> {
    for _ in 0..warmup {
        black_box(run());
    }
    (0..samples).map(|_| run()).collect()
}

fn median_ns(samples: &[u64]) -> u64 {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

fn yuyv_frame(width: u32, height: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(Pixel::YUYV422, width, height);
    let stride = frame.stride(0);
    let data = frame.data_mut(0);
    for y in 0..height as usize {
        let row = &mut data[y * stride..y * stride + width as usize * 2];
        for (i, byte) in row.iter_mut().enumerate() {
            *byte = ((y * 131 + i * 17 + (y * i) / 64) & 0xff) as u8;
        }
    }
    frame
}

fn scaling_context(frame: &ffmpeg::frame::Video) -> Context {
    scaling::Context::get(
        frame.format(),
        frame.width(),
        frame.height(),
        Pixel::BGRA,
        frame.width(),
        frame.height(),
        scaling::Flags::BILINEAR,
    )
    .expect("swscale")
}

fn swscale_copy(frame: &ffmpeg::frame::Video, scaler: &mut Context, mirrored: bool) -> Vec<u8> {
    let mut converted = ffmpeg::frame::Video::empty();
    swscale_copy_into(frame, scaler, mirrored, &mut converted)
}

fn swscale_copy_into(
    frame: &ffmpeg::frame::Video,
    scaler: &mut Context,
    mirrored: bool,
    converted: &mut ffmpeg::frame::Video,
) -> Vec<u8> {
    scaler.run(frame, converted).expect("swscale run");
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    frame::copy_rows(
        converted.data(0),
        width * 4,
        converted.stride(0),
        height,
        mirrored,
    )
    .expect("copy_rows")
}

fn time_swscale(frame: &ffmpeg::frame::Video, scaler: &mut Context, mirrored: bool) -> u64 {
    let start = Instant::now();
    let pixels = swscale_copy(black_box(frame), scaler, black_box(mirrored));
    black_box(pixels);
    start.elapsed().as_nanos() as u64
}

fn time_avx(frame: &ffmpeg::frame::Video, mirrored: bool) -> u64 {
    let start = Instant::now();
    let pixels = yuyv::to_bgra(
        black_box(frame.data(0)),
        black_box(frame.width() as usize),
        black_box(frame.stride(0)),
        black_box(frame.height() as usize),
        black_box(mirrored),
    );
    black_box(pixels);
    start.elapsed().as_nanos() as u64
}

fn time_scalar(frame: &ffmpeg::frame::Video, mirrored: bool) -> u64 {
    let start = Instant::now();
    let pixels = yuyv::to_bgra_scalar(
        black_box(frame.data(0)),
        black_box(frame.width() as usize),
        black_box(frame.stride(0)),
        black_box(frame.height() as usize),
        black_box(mirrored),
    );
    black_box(pixels);
    start.elapsed().as_nanos() as u64
}

fn max_abs_diff(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(left, right)| left.abs_diff(*right))
        .max()
        .unwrap_or(0)
}
