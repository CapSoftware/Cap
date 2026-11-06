use cap_gpui_kernels::frame as candidate;
use std::{hint::black_box, time::Instant};

type Unpad = fn(&[u8], usize, usize, usize) -> Option<Vec<u8>>;

fn main() {
    #[cfg(target_arch = "x86_64")]
    println!(
        "arch={} avx2={} ssse3={}",
        std::env::consts::ARCH,
        std::arch::is_x86_feature_detected!("avx2"),
        std::arch::is_x86_feature_detected!("ssse3"),
    );
    #[cfg(not(target_arch = "x86_64"))]
    println!("arch={} avx2=false ssse3=false", std::env::consts::ARCH);
    println!("workload,sample,before_ns,after_ns");
    for (name, width, height) in [
        ("preview-1248x702", 1248usize, 702usize),
        ("1080p", 1920, 1080),
        ("4k", 3840, 2160),
    ] {
        let stride = (width * 4).next_multiple_of(256);
        let src: Vec<u8> = (0..stride * height).map(|i| (i * 31 + 9) as u8).collect();
        let before = baseline::unpad_rgba_to_bgra(&src, width, stride, height).unwrap();
        let after = candidate::unpad_rgba_to_bgra(&src, width, stride, height).unwrap();
        assert_eq!(before, after, "{name}");
        let mut samples = Vec::with_capacity(30);
        for sample in 0..40 {
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
            if sample >= 10 {
                println!("{name},{},{old},{new}", sample - 10);
                samples.push((old, new));
            }
        }
        let (before_ns, after_ns) = median(&samples);
        println!(
            "{name},median,{before_ns},{after_ns},stride={stride},samples={}",
            samples.len()
        );
    }
}

fn median(samples: &[(u128, u128)]) -> (u128, u128) {
    fn mid(values: &mut [u128]) -> u128 {
        values.sort_unstable();
        let center = values.len() / 2;
        if values.len().is_multiple_of(2) {
            values[center - 1].midpoint(values[center])
        } else {
            values[center]
        }
    }
    let before = mid(&mut samples
        .iter()
        .map(|(before, _)| *before)
        .collect::<Vec<_>>());
    let after = mid(&mut samples.iter().map(|(_, after)| *after).collect::<Vec<_>>());
    (before, after)
}

// Scalar pointer loop this kernel used before the AVX2/SSSE3 dispatch.
// Inlined so before/after share one build and the same inputs.
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

        let mut tight = Vec::with_capacity(output_len);
        let dest: *mut u8 = tight.as_mut_ptr();
        unsafe {
            for row in 0..rows {
                let src = data.as_ptr().add(row * stride);
                let dst = dest.add(row * row_bytes);
                for col in 0..width {
                    let s = src.add(col * 4);
                    let d = dst.add(col * 4);
                    *d = *s.add(2);
                    *d.add(1) = *s.add(1);
                    *d.add(2) = *s;
                    *d.add(3) = *s.add(3);
                }
            }
            tight.set_len(output_len);
        }
        Some(tight)
    }
}
