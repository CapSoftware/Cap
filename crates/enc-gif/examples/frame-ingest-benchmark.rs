//! Measures the per-frame ingest preparation in cap-enc-gif: turning a padded
//! RGBA frame buffer (256-byte-aligned rows, as produced by GPU readback) into
//! the `ImgVec` handed to gifski, via the slice-based preparation that copies
//! the frame and via the owned strided preparation that reinterprets it. Both
//! preparations live in this file so they share compiler flags and inputs, and
//! their outputs are asserted equal before timing.
//!
//! Run with: `cargo run --release -p cap-enc-gif --example frame-ingest-benchmark`

use imgref::ImgVec;
use rgb::RGBA8;
use std::{hint::black_box, time::Instant};

fn main() {
    println!("workload,sample,before_ns,after_ns");
    for (name, width, height) in [
        ("768p-padded", 1366usize, 768usize),
        ("1080p", 1920, 1080),
        ("4k", 3840, 2160),
    ] {
        let bytes_per_row = (width * 4).next_multiple_of(256);
        let src: Vec<u8> = (0..bytes_per_row * height).map(|i| i as u8).collect();

        let before = baseline::prepare(&src, width, height, bytes_per_row);
        let after = candidate::prepare(src.clone(), width, height, bytes_per_row);
        assert_images_equal(&before, &after, width);

        for sample in 0..35 {
            let run_before = |src: &[u8]| {
                let start = Instant::now();
                let img = baseline::prepare(
                    black_box(src),
                    black_box(width),
                    black_box(height),
                    black_box(bytes_per_row),
                );
                let elapsed = start.elapsed().as_nanos();
                black_box(&img);
                elapsed
            };
            let run_after = |src: &[u8]| {
                let owned = src.to_vec();
                let start = Instant::now();
                let img = candidate::prepare(
                    black_box(owned),
                    black_box(width),
                    black_box(height),
                    black_box(bytes_per_row),
                );
                let elapsed = start.elapsed().as_nanos();
                black_box(&img);
                elapsed
            };
            let (old, new) = if sample % 2 == 0 {
                let old = run_before(&src);
                (old, run_after(&src))
            } else {
                let new = run_after(&src);
                (run_before(&src), new)
            };
            if sample >= 5 {
                println!("{name},{},{old},{new}", sample - 5);
            }
        }
    }
}

fn assert_images_equal(before: &ImgVec<RGBA8>, after: &ImgVec<RGBA8>, width: usize) {
    assert_eq!(before.width(), after.width());
    assert_eq!(before.height(), after.height());
    for (before_row, after_row) in before.rows().zip(after.rows()) {
        assert_eq!(&before_row[..width], &after_row[..width]);
    }
}

mod baseline {
    use imgref::ImgVec;
    use rgb::RGBA8;

    pub fn prepare(
        frame_data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
    ) -> ImgVec<RGBA8> {
        let expected_bytes_per_row = width * 4;
        if bytes_per_row == expected_bytes_per_row {
            let pixel_count = width * height;
            let byte_slice = &frame_data[..pixel_count * 4];
            let pixels: &[RGBA8] = unsafe {
                std::slice::from_raw_parts(byte_slice.as_ptr().cast::<RGBA8>(), pixel_count)
            };
            imgref::Img::new(pixels.to_vec(), width, height)
        } else {
            let mut rgba_pixels = Vec::with_capacity(width * height);
            for y in 0..height {
                let row_start = y * bytes_per_row;
                let row_bytes = &frame_data[row_start..row_start + expected_bytes_per_row];
                let row_pixels: &[RGBA8] = unsafe {
                    std::slice::from_raw_parts(row_bytes.as_ptr().cast::<RGBA8>(), width)
                };
                rgba_pixels.extend_from_slice(row_pixels);
            }
            imgref::Img::new(rgba_pixels, width, height)
        }
    }
}

mod candidate {
    use imgref::ImgVec;
    use rgb::RGBA8;

    pub fn prepare(
        frame_data: Vec<u8>,
        width: usize,
        height: usize,
        bytes_per_row: usize,
    ) -> ImgVec<RGBA8> {
        let mut frame_data = frame_data;
        let (ptr, len, capacity) = (
            frame_data.as_mut_ptr(),
            frame_data.len(),
            frame_data.capacity(),
        );
        std::mem::forget(frame_data);
        // SAFETY: RGBA8 is #[repr(C)] with size 4 and alignment 1, and the
        // caller guarantees the byte length and capacity are multiples of 4.
        let pixels = unsafe { Vec::from_raw_parts(ptr.cast::<RGBA8>(), len / 4, capacity / 4) };
        imgref::Img::new_stride(pixels, width, height, bytes_per_row / 4)
    }
}
