//! Compares the macOS fast-capture pixel packers in `src/screenshot.rs` before and after the
//! aarch64 NEON paths: BGRA to RGB (display and area captures) and BGRA to RGBA (window
//! captures). The old and new code live in this one file, so both sides share compiler flags.
//! Every timed call allocates its output buffer, as the production functions do.
//!
//! The file uses only `std`, so it builds without the crate's native dependencies:
//!
//!   rustc +1.88.0 --edition 2024 -C opt-level=s -C lto=thin -C codegen-units=1 \
//!     -C debuginfo=line-tables-only -C panic=unwind \
//!     crates/recording/examples/screenshot-pack-benchmark.rs -o /tmp/screenshot-pack-benchmark
//!   /tmp/screenshot-pack-benchmark
//!
//! or, where the crate builds: `cargo run --release -p cap-recording --example screenshot-pack-benchmark`.

#[cfg(not(target_arch = "aarch64"))]
fn main() {
    eprintln!("screenshot-pack-benchmark: skipped (not aarch64)");
}

#[cfg(target_arch = "aarch64")]
fn main() {
    bench::run();
}

#[cfg(target_arch = "aarch64")]
#[derive(Clone, Copy, Debug)]
enum ChannelOrder {
    Rgba,
    Bgra,
}

#[cfg(target_arch = "aarch64")]
mod old {
    use super::ChannelOrder;

    pub fn rgb_from_rgba(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        if bytes_per_row < row_bytes {
            return None;
        }

        let required_len = height.checked_mul(bytes_per_row)?;
        if data.len() < required_len {
            return None;
        }

        let width_stride = width.checked_mul(3)?;
        let rgb_len = height.checked_mul(width_stride)?;
        let mut rgb = vec![0u8; rgb_len];

        for y in 0..height {
            let (src_row, dst_row) =
                rgb_row_pair(data, &mut rgb, y, bytes_per_row, row_bytes, width_stride)?;
            reorder_rgb_row_scalar(src_row, dst_row, order);
        }

        Some(rgb)
    }

    fn rgb_row_pair<'a>(
        data: &'a [u8],
        rgb: &'a mut [u8],
        y: usize,
        bytes_per_row: usize,
        row_bytes: usize,
        width_stride: usize,
    ) -> Option<(&'a [u8], &'a mut [u8])> {
        let src_start = y.checked_mul(bytes_per_row)?;
        let src_end = src_start.checked_add(row_bytes)?;
        let dst_start = y.checked_mul(width_stride)?;
        let dst_end = dst_start.checked_add(width_stride)?;
        let src_row = data.get(src_start..src_end)?;
        let dst_row = rgb.get_mut(dst_start..dst_end)?;
        Some((src_row, dst_row))
    }

    fn reorder_rgb_row_scalar(src: &[u8], dst: &mut [u8], order: ChannelOrder) {
        match order {
            ChannelOrder::Rgba => rgba_to_rgb_scalar(src, dst),
            ChannelOrder::Bgra => bgra_to_rgb_scalar(src, dst),
        }
    }

    fn rgba_to_rgb_scalar(src: &[u8], dst: &mut [u8]) {
        for (src, dst) in src.chunks_exact(4).zip(dst.chunks_exact_mut(3)) {
            dst[0] = src[0];
            dst[1] = src[1];
            dst[2] = src[2];
        }
    }

    fn bgra_to_rgb_scalar(src: &[u8], dst: &mut [u8]) {
        for (src, dst) in src.chunks_exact(4).zip(dst.chunks_exact_mut(3)) {
            dst[0] = src[2];
            dst[1] = src[1];
            dst[2] = src[0];
        }
    }

    pub fn rgba_from_raw(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        if bytes_per_row < row_bytes {
            return None;
        }

        let required_len = height.checked_mul(bytes_per_row)?;
        if data.len() < required_len {
            return None;
        }

        let width_stride = width.checked_mul(4)?;
        let rgba_len = height.checked_mul(width_stride)?;
        let mut rgba = vec![0u8; rgba_len];

        for y in 0..height {
            let src_start = y.checked_mul(bytes_per_row)?;
            let src_end = src_start.checked_add(row_bytes)?;
            let dst_start = y.checked_mul(width_stride)?;
            let dst_end = dst_start.checked_add(width_stride)?;

            let src_row = data.get(src_start..src_end)?;
            let dst_row = rgba.get_mut(dst_start..dst_end)?;

            for (src, dst) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
                let (r, b) = match order {
                    ChannelOrder::Rgba => (src[0], src[2]),
                    ChannelOrder::Bgra => (src[2], src[0]),
                };

                dst[0] = r;
                dst[1] = src[1];
                dst[2] = b;
                dst[3] = src[3];
            }
        }

        Some(rgba)
    }
}

#[cfg(target_arch = "aarch64")]
mod new {
    use super::ChannelOrder;

    pub fn rgb_from_rgba(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        if bytes_per_row < row_bytes {
            return None;
        }
        let required_len = height.checked_mul(bytes_per_row)?;
        if data.len() < required_len {
            return None;
        }
        let width_stride = width.checked_mul(3)?;
        // SAFETY: reorder_rgb_row_neon initializes every element of each destination row.
        unsafe {
            pack_rows_uninit(
                data,
                height,
                bytes_per_row,
                row_bytes,
                width_stride,
                |src_row, dst_row| reorder_rgb_row_neon(src_row, dst_row, order),
            )
        }
    }

    pub fn rgba_from_raw(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        if bytes_per_row < row_bytes {
            return None;
        }
        let required_len = height.checked_mul(bytes_per_row)?;
        if data.len() < required_len {
            return None;
        }
        let width_stride = width.checked_mul(4)?;
        // SAFETY: reorder_rgba_row_neon initializes every element of each destination row.
        unsafe {
            pack_rows_uninit(
                data,
                height,
                bytes_per_row,
                row_bytes,
                width_stride,
                |src_row, dst_row| reorder_rgba_row_neon(src_row, dst_row, order),
            )
        }
    }

    pub fn rgb_from_rgba_zeroed(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        let width_stride = width.checked_mul(3)?;
        let mut rgb = vec![0u8; height.checked_mul(width_stride)?];
        for y in 0..height {
            let src_row = data.get(y * bytes_per_row..y * bytes_per_row + row_bytes)?;
            let dst_row = rgb.get_mut(y * width_stride..(y + 1) * width_stride)?;
            reorder_rgb_row_neon(src_row, as_uninit(dst_row), order);
        }
        Some(rgb)
    }

    pub fn rgba_from_raw_zeroed(
        data: &[u8],
        width: usize,
        height: usize,
        bytes_per_row: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let row_bytes = width.checked_mul(4)?;
        let mut rgba = vec![0u8; height.checked_mul(row_bytes)?];
        for y in 0..height {
            let src_row = data.get(y * bytes_per_row..y * bytes_per_row + row_bytes)?;
            let dst_row = rgba.get_mut(y * row_bytes..(y + 1) * row_bytes)?;
            reorder_rgba_row_neon(src_row, as_uninit(dst_row), order);
        }
        Some(rgba)
    }

    fn as_uninit(bytes: &mut [u8]) -> &mut [std::mem::MaybeUninit<u8>] {
        // SAFETY: MaybeUninit<u8> has the layout of u8, and the kernels only store initialized
        // bytes, so the slice stays initialized.
        unsafe { &mut *(bytes as *mut [u8] as *mut [std::mem::MaybeUninit<u8>]) }
    }

    /// # Safety
    ///
    /// `write_row` must initialize every element of the destination slice it receives.
    unsafe fn pack_rows_uninit(
        data: &[u8],
        height: usize,
        bytes_per_row: usize,
        row_bytes: usize,
        dst_stride: usize,
        mut write_row: impl FnMut(&[u8], &mut [std::mem::MaybeUninit<u8>]),
    ) -> Option<Vec<u8>> {
        let dst_len = height.checked_mul(dst_stride)?;
        let mut out = Vec::<u8>::with_capacity(dst_len);
        let spare = out.spare_capacity_mut().get_mut(..dst_len)?;

        for y in 0..height {
            let src_start = y.checked_mul(bytes_per_row)?;
            let src_row = data.get(src_start..src_start.checked_add(row_bytes)?)?;
            let dst_start = y.checked_mul(dst_stride)?;
            let dst_row = spare.get_mut(dst_start..dst_start.checked_add(dst_stride)?)?;
            write_row(src_row, dst_row);
        }

        // SAFETY: the rows 0..height tile 0..dst_len exactly, and the caller guarantees write_row
        // initialized every byte of each row. dst_len <= capacity.
        unsafe { out.set_len(dst_len) };
        Some(out)
    }

    fn reorder_rgb_row_neon(
        src: &[u8],
        dst: &mut [std::mem::MaybeUninit<u8>],
        order: ChannelOrder,
    ) {
        use std::arch::aarch64::*;

        assert_eq!(
            dst.len() % 3,
            0,
            "rgb row length must be a whole number of pixels"
        );
        let pixels = dst.len() / 3;
        let src = &src[..pixels * 4];
        let swap = matches!(order, ChannelOrder::Bgra);
        let simd_pixels = pixels & !15;

        for i in (0..simd_pixels).step_by(16) {
            // SAFETY: i + 16 <= simd_pixels <= pixels, so the 64 byte load at i * 4 is inside src
            // (pixels * 4 bytes) and the 48 byte store at i * 3 is inside dst (pixels * 3 bytes).
            // NEON is part of the aarch64 baseline, and both intrinsics accept unaligned pointers.
            unsafe {
                let px = vld4q_u8(src.as_ptr().add(i * 4));
                let rgb = if swap {
                    uint8x16x3_t(px.2, px.1, px.0)
                } else {
                    uint8x16x3_t(px.0, px.1, px.2)
                };
                vst3q_u8(dst.as_mut_ptr().add(i * 3).cast::<u8>(), rgb);
            }
        }

        for (s, d) in src[simd_pixels * 4..]
            .chunks_exact(4)
            .zip(dst[simd_pixels * 3..].chunks_exact_mut(3))
        {
            let (r, b) = if swap { (s[2], s[0]) } else { (s[0], s[2]) };
            d[0].write(r);
            d[1].write(s[1]);
            d[2].write(b);
        }
    }

    fn reorder_rgba_row_neon(
        src: &[u8],
        dst: &mut [std::mem::MaybeUninit<u8>],
        order: ChannelOrder,
    ) {
        use std::arch::aarch64::*;

        assert_eq!(
            dst.len() % 4,
            0,
            "rgba row length must be a whole number of pixels"
        );
        let pixels = dst.len() / 4;
        let src = &src[..pixels * 4];
        let swap = matches!(order, ChannelOrder::Bgra);
        let simd_pixels = pixels & !15;

        for i in (0..simd_pixels).step_by(16) {
            // SAFETY: i + 16 <= simd_pixels <= pixels, so the 64 byte load and the 64 byte store at
            // i * 4 are inside src and dst (both pixels * 4 bytes). NEON is part of the aarch64
            // baseline, and both intrinsics accept unaligned pointers.
            unsafe {
                let px = vld4q_u8(src.as_ptr().add(i * 4));
                let rgba = if swap {
                    uint8x16x4_t(px.2, px.1, px.0, px.3)
                } else {
                    px
                };
                vst4q_u8(dst.as_mut_ptr().add(i * 4).cast::<u8>(), rgba);
            }
        }

        for (s, d) in src[simd_pixels * 4..]
            .chunks_exact(4)
            .zip(dst[simd_pixels * 4..].chunks_exact_mut(4))
        {
            let (r, b) = if swap { (s[2], s[0]) } else { (s[0], s[2]) };
            d[0].write(r);
            d[1].write(s[1]);
            d[2].write(b);
            d[3].write(s[3]);
        }
    }
}

#[cfg(target_arch = "aarch64")]
mod bench {
    use super::{ChannelOrder, new, old};
    use std::hint::black_box;
    use std::time::{Duration, Instant};

    const SIZES: [(usize, usize); 3] = [(1920, 1080), (2880, 1800), (5120, 2880)];
    const STRIDE_PAD: usize = 64;
    const WARMUP: usize = 2;
    const RUNS: usize = 9;

    type Packer = fn(&[u8], usize, usize, usize, ChannelOrder) -> Option<Vec<u8>>;

    fn paint(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        let mut out = vec![0u8; len];
        for byte in &mut out {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            *byte = (state >> 16) as u8;
        }
        out
    }

    fn time_once(packer: Packer, data: &[u8], w: usize, h: usize, stride: usize) -> Duration {
        let start = Instant::now();
        let out = packer(
            black_box(data),
            black_box(w),
            black_box(h),
            black_box(stride),
            black_box(ChannelOrder::Bgra),
        );
        let elapsed = start.elapsed();
        black_box(out.expect("packer rejected a valid frame"));
        elapsed
    }

    fn median_ms(mut samples: Vec<Duration>) -> f64 {
        samples.sort();
        samples[samples.len() / 2].as_secs_f64() * 1000.0
    }

    fn command_line(program: &str, args: &[&str]) -> String {
        std::process::Command::new(program)
            .args(args)
            .output()
            .ok()
            .map(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .replace('\n', " ")
            })
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn verify(data: &[u8], w: usize, h: usize, stride: usize) -> bool {
        let mut ok = true;
        for order in [ChannelOrder::Bgra, ChannelOrder::Rgba] {
            let pairs: [(&str, Packer, Packer); 4] = [
                ("rgb", old::rgb_from_rgba, new::rgb_from_rgba),
                ("rgb zeroed", old::rgb_from_rgba, new::rgb_from_rgba_zeroed),
                ("rgba", old::rgba_from_raw, new::rgba_from_raw),
                ("rgba zeroed", old::rgba_from_raw, new::rgba_from_raw_zeroed),
            ];
            for (label, before, after) in pairs {
                let expected = before(data, w, h, stride, order);
                let got = after(data, w, h, stride, order);
                if expected.is_none() || expected != got {
                    eprintln!("MISMATCH {label} {w}x{h} stride {stride} {order:?}");
                    ok = false;
                }
            }
        }
        ok
    }

    pub fn run() {
        println!(
            "machine: {} | {}",
            command_line("sysctl", &["-n", "machdep.cpu.brand_string", "hw.memsize"]),
            command_line("sw_vers", &["-productVersion"]),
        );
        println!(
            "build: {} | {}",
            option_env!("RUSTC_VERSION").unwrap_or("rustc version not recorded"),
            option_env!("OPT_LABEL").unwrap_or("flags not recorded"),
        );
        println!(
            "input: BGRA, bytes_per_row = width * 4 + {STRIDE_PAD}, warmup {WARMUP}, median of {RUNS} single-frame calls"
        );
        println!();
        println!(
            "| Frame | BGRA to RGB before | NEON, zeroed buffer | NEON, uninit buffer | Speedup | BGRA to RGBA before | NEON, zeroed buffer | NEON, uninit buffer | Speedup |"
        );
        println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

        let mut all_ok = true;
        for (w, h) in SIZES {
            let stride = w * 4 + STRIDE_PAD;
            let data = paint(stride * h, (w as u32) ^ (h as u32).rotate_left(16));

            if !verify(&data, w, h, stride) {
                all_ok = false;
                continue;
            }

            let packers: [Packer; 6] = [
                old::rgb_from_rgba,
                new::rgb_from_rgba_zeroed,
                new::rgb_from_rgba,
                old::rgba_from_raw,
                new::rgba_from_raw_zeroed,
                new::rgba_from_raw,
            ];
            let mut samples: [Vec<Duration>; 6] = Default::default();
            for run in 0..WARMUP + RUNS {
                for (packer, bucket) in packers.iter().zip(samples.iter_mut()) {
                    let elapsed = time_once(*packer, &data, w, h, stride);
                    if run >= WARMUP {
                        bucket.push(elapsed);
                    }
                }
            }
            let ms = samples.map(median_ms);
            println!(
                "| {w}x{h} | {:.3} | {:.3} | {:.3} | {:.2}x | {:.3} | {:.3} | {:.3} | {:.2}x |",
                ms[0],
                ms[1],
                ms[2],
                ms[0] / ms[2],
                ms[3],
                ms[4],
                ms[5],
                ms[3] / ms[5],
            );
        }

        if !all_ok {
            eprintln!("outputs differ, failing");
            std::process::exit(1);
        }
    }
}
