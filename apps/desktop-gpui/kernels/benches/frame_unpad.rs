use cap_gpui_kernels::frame as candidate;
use std::{hint::black_box, time::Instant};

type Unpad = fn(&[u8], usize, usize, usize) -> Option<Vec<u8>>;

fn main() {
    println!("workload,sample,before_ns,after_ns");
    for (name, width, height) in [
        ("preview-1248x702", 1248usize, 702usize),
        ("1080p", 1920, 1080),
        ("4k", 3840, 2160),
    ] {
        let stride = (width * 4).next_multiple_of(256);
        let src: Vec<u8> = (0..stride * height).map(|i| i as u8).collect();
        let before = baseline::unpad_rgba_to_bgra(&src, width, stride, height).unwrap();
        let after = candidate::unpad_rgba_to_bgra(&src, width, stride, height).unwrap();
        assert_eq!(before, after, "{name}");
        for sample in 0..35 {
            let run = |f: Unpad| {
                let start = Instant::now();
                let _ = black_box(f(
                    black_box(&src),
                    black_box(width),
                    black_box(stride),
                    black_box(height),
                ));
                start.elapsed().as_nanos()
            };
            let (old, new) = if sample % 2 == 0 {
                let old = run(baseline::unpad_rgba_to_bgra);
                (old, run(candidate::unpad_rgba_to_bgra))
            } else {
                let new = run(candidate::unpad_rgba_to_bgra);
                (run(baseline::unpad_rgba_to_bgra), new)
            };
            if sample >= 5 {
                println!("{name},{},{old},{new}", sample - 5);
            }
        }
    }
}

// Inlined from main so before/after share one build and the same inputs.
mod baseline {
    pub fn unpad_rgba_to_bgra(
        data: &[u8],
        width: usize,
        stride: usize,
        rows: usize,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        let output_len = row_bytes.checked_mul(rows)?;
        if stride == 0 || stride < row_bytes || data.len() < stride.checked_mul(rows)? {
            return None;
        }
        if output_len == 0 {
            return Some(Vec::new());
        }

        let mut tight = vec![0; output_len];
        for (source, target) in data
            .chunks_exact(stride)
            .zip(tight.chunks_exact_mut(row_bytes))
            .take(rows)
        {
            for (source, target) in source[..row_bytes]
                .chunks_exact(4)
                .zip(target.chunks_exact_mut(4))
            {
                target[0] = source[2];
                target[1] = source[1];
                target[2] = source[0];
                target[3] = source[3];
            }
        }
        Some(tight)
    }
}
