use cap_gpui_kernels::screenshot as candidate;
use std::hint::black_box;
use std::time::Instant;

fn median(samples: &mut [u128]) -> u128 {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

fn blur_reference(
    rgba: &[u8],
    frame_width: u32,
    (x0, y0, width, height): (u32, u32, u32, u32),
    level: f64,
) -> Option<image::RgbaImage> {
    let stride = frame_width as usize * 4;
    let mut copied = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height {
        let start = (y0 + row) as usize * stride + x0 as usize * 4;
        copied.extend_from_slice(&rgba[start..start + width as usize * 4]);
    }
    let source = image::RgbaImage::from_raw(width, height, copied)?;
    let factor = ((level / 4.).round() as u32).max(2);
    let small = image::imageops::resize(
        &source,
        (width / factor).max(1),
        (height / factor).max(1),
        image::imageops::FilterType::Triangle,
    );
    Some(image::imageops::resize(
        &small,
        width,
        height,
        image::imageops::FilterType::Triangle,
    ))
}

fn time_call(rgba: &[u8], width: u32, height: u32, level: f64, reference: bool) -> u128 {
    let start = Instant::now();
    let image = if reference {
        blur_reference(
            black_box(rgba),
            black_box(width),
            black_box((0, 0, width, height)),
            black_box(level),
        )
    } else {
        candidate::mask_filter(
            black_box(rgba),
            black_box(width),
            black_box(height),
            black_box((0, 0, width, height)),
            black_box(false),
            black_box(level),
        )
    };
    let elapsed = start.elapsed().as_nanos();
    black_box(image.unwrap());
    elapsed
}

fn main() {
    // Warmup is discarded. Recorded samples alternate which implementation
    // runs first. n is odd, and the reported time is the median.
    println!("workload,level,n,before_ns,after_ns,speedup");
    for (width, height, level, runs) in [
        (400u32, 300u32, 16.0f64, 21usize),
        (400, 300, 8.0, 21),
        (400, 300, 40.0, 21),
        (1920, 1080, 16.0, 21),
        (1920, 1080, 8.0, 21),
        (1920, 1080, 40.0, 21),
        (3840, 2160, 16.0, 11),
        (3840, 2160, 8.0, 11),
        (3840, 2160, 40.0, 11),
    ] {
        let rgba: Vec<u8> = (0..width as usize * height as usize * 4)
            .map(|i| (i.wrapping_mul(31) % 251) as u8)
            .collect();
        let before = blur_reference(&rgba, width, (0, 0, width, height), level)
            .unwrap()
            .into_raw();
        let after =
            candidate::mask_filter(&rgba, width, height, (0, 0, width, height), false, level)
                .unwrap()
                .into_raw();
        assert_eq!(before, after, "{width}x{height} level {level}");
        for _ in 0..3 {
            black_box(time_call(&rgba, width, height, level, true));
            black_box(time_call(&rgba, width, height, level, false));
        }
        let mut before_ns = Vec::with_capacity(runs);
        let mut after_ns = Vec::with_capacity(runs);
        for sample in 0..runs {
            if sample % 2 == 0 {
                before_ns.push(time_call(&rgba, width, height, level, true));
                after_ns.push(time_call(&rgba, width, height, level, false));
            } else {
                after_ns.push(time_call(&rgba, width, height, level, false));
                before_ns.push(time_call(&rgba, width, height, level, true));
            }
        }
        let before_median = median(&mut before_ns);
        let after_median = median(&mut after_ns);
        let speedup = before_median as f64 / after_median as f64;
        println!("{width}x{height},{level},{runs},{before_median},{after_median},{speedup:.3}");
    }
}
