use cap_cpu_yuv_bench::{nv12_to_rgba_simd, yuv420p_to_rgba_simd};
use std::{hint::black_box, time::Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [input, output, width, height] = args.as_slice() {
        let width: usize = width.parse().expect("width");
        let height: usize = height.parse().expect("height");
        let raw = std::fs::read(input).expect("NV12 input");
        let y_len = width * height;
        let frame_len = y_len + width * height.div_ceil(2);
        assert_eq!(raw.len() % frame_len, 0);
        let mut file = std::fs::File::create(output).expect("RGBA output");
        let mut rgba = vec![0; y_len * 4];
        for frame in raw.chunks_exact(frame_len) {
            nv12_to_rgba_simd(
                &frame[..y_len],
                &frame[y_len..],
                width as u32,
                height as u32,
                width as u32,
                width as u32,
                &mut rgba,
            );
            std::io::Write::write_all(&mut file, &rgba).expect("write frame");
        }
        return;
    }
    assert!(
        args.is_empty(),
        "usage: cpu-yuv-bench [input.nv12 output.rgba width height]"
    );
    println!("format,width,height,threads,run,ms");
    for (width, height) in [(1280_usize, 720_usize), (1920, 1080), (3840, 2160)] {
        let y: Vec<u8> = (0..width * height).map(|i| (i * 7) as u8).collect();
        let uv: Vec<u8> = (0..width * height / 2).map(|i| (i * 11) as u8).collect();
        let u: Vec<u8> = uv.chunks_exact(2).map(|pair| pair[0]).collect();
        let v: Vec<u8> = uv.chunks_exact(2).map(|pair| pair[1]).collect();
        let mut output = vec![0_u8; width * height * 4];
        for planar in [false, true] {
            for run in 0..35 {
                let start = Instant::now();
                if planar {
                    yuv420p_to_rgba_simd(
                        black_box(&y),
                        black_box(&u),
                        black_box(&v),
                        width as u32,
                        height as u32,
                        width as u32,
                        (width / 2) as u32,
                        black_box(&mut output),
                    );
                } else {
                    nv12_to_rgba_simd(
                        black_box(&y),
                        black_box(&uv),
                        width as u32,
                        height as u32,
                        width as u32,
                        width as u32,
                        black_box(&mut output),
                    );
                }
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                black_box(&output);
                if run >= 5 {
                    println!(
                        "{},{width},{height},{},{},{elapsed:.6}",
                        if planar { "yuv420p" } else { "nv12" },
                        rayon::current_num_threads(),
                        run - 5
                    );
                }
            }
        }
    }
}
