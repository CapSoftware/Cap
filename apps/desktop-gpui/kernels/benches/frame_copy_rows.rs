use cap_gpui_kernels::frame as candidate;
use std::{hint::black_box, time::Instant};

type CopyRows = fn(&[u8], usize, usize, usize, bool) -> Option<Vec<u8>>;

fn main() {
    println!("workload,sample,before_ns,after_ns");
    for (name, width, height, bytes_per_pixel, stride_align, mirrored) in [
        (
            "camera-720p-mirrored",
            1280usize,
            720usize,
            4usize,
            64usize,
            true,
        ),
        ("camera-1080p-mirrored", 1920, 1080, 4, 64, true),
        ("camera-720p", 1280, 720, 4, 64, false),
        ("camera-1080p", 1920, 1080, 4, 64, false),
        ("import-4k-rgba", 3840, 2160, 4, 64, false),
        ("library-thumb-rgb24", 1280, 720, 3, 64, false),
        ("clip-thumb-bgra-padded", 1366, 768, 4, 256, false),
    ] {
        let row_bytes = width * bytes_per_pixel;
        let stride = row_bytes.next_multiple_of(stride_align);
        let src: Vec<u8> = (0..stride * height)
            .map(|i| (i * 31 + i / 7) as u8)
            .collect();
        let before = baseline::copy_rows(&src, row_bytes, stride, height, mirrored).unwrap();
        let after = candidate::copy_rows(&src, row_bytes, stride, height, mirrored).unwrap();
        assert_eq!(before, after, "{name}");
        for sample in 0..35 {
            let run = |f: CopyRows| {
                let start = Instant::now();
                let _ = black_box(f(
                    black_box(&src),
                    black_box(row_bytes),
                    black_box(stride),
                    black_box(height),
                    black_box(mirrored),
                ));
                start.elapsed().as_nanos()
            };
            let (old, new) = if sample % 2 == 0 {
                let old = run(baseline::copy_rows);
                (old, run(candidate::copy_rows))
            } else {
                let new = run(candidate::copy_rows);
                (run(baseline::copy_rows), new)
            };
            if sample >= 5 {
                println!("{name},{},{old},{new}", sample - 5);
            }
        }
    }
}

// Inlined from main so before/after share one build and the same inputs.
mod baseline {
    pub fn copy_rows(
        data: &[u8],
        row_bytes: usize,
        stride: usize,
        rows: usize,
        mirrored: bool,
    ) -> Option<Vec<u8>> {
        if stride < row_bytes || data.len() < rows.checked_mul(stride)? {
            return None;
        }
        let mut pixels = vec![0; rows.checked_mul(row_bytes)?];
        for (row, output) in pixels.chunks_exact_mut(row_bytes.max(1)).enumerate() {
            let input = &data[row * stride..row * stride + row_bytes];
            if mirrored {
                for (target, source) in output.chunks_exact_mut(4).zip(input.chunks_exact(4).rev())
                {
                    target.copy_from_slice(source);
                }
            } else {
                output.copy_from_slice(input);
            }
        }
        Some(pixels)
    }
}
