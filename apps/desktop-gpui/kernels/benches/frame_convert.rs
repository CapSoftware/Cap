use cap_gpui_kernels::frame::{self as candidate, ChannelOrder, Nv12Range};
use std::{hint::black_box, time::Instant};

fn main() {
    println!("=== Benchmark: unpad_rgba_to_bgra ===");
    for (name, width, height, stride) in [
        ("1248x702-padded", 1248usize, 702usize, 5120usize),
        ("1080p-unpadded", 1920, 1080, 1920 * 4),
        ("1080p-padded-256", 1920, 1080, 7936),
        ("4k-unpadded", 3840, 2160, 3840 * 4),
        ("4k-padded-256", 3840, 2160, 15616),
    ] {
        let input: Vec<u8> = (0..stride * height)
            .map(|i| (i as u8).wrapping_mul(17))
            .collect();
        let expected = baseline::unpad_rgba_to_bgra(&input, width, stride, height).unwrap();
        let actual = candidate::unpad_rgba_to_bgra(&input, width, stride, height).unwrap();
        assert_eq!(expected, actual, "Mismatch in {name}");

        let mut baseline_times = Vec::new();
        let mut candidate_times = Vec::new();

        for i in 0..25 {
            let start = Instant::now();
            let res = baseline::unpad_rgba_to_bgra(
                black_box(&input),
                black_box(width),
                black_box(stride),
                black_box(height),
            );
            let elapsed_base = start.elapsed().as_nanos();
            black_box(res);

            let start = Instant::now();
            let res = candidate::unpad_rgba_to_bgra(
                black_box(&input),
                black_box(width),
                black_box(stride),
                black_box(height),
            );
            let elapsed_cand = start.elapsed().as_nanos();
            black_box(res);

            if i >= 5 {
                baseline_times.push(elapsed_base);
                candidate_times.push(elapsed_cand);
            }
        }
        baseline_times.sort();
        candidate_times.sort();
        let base_med = baseline_times[baseline_times.len() / 2] as f64 / 1_000.0;
        let cand_med = candidate_times[candidate_times.len() / 2] as f64 / 1_000.0;
        let speedup = base_med / cand_med;
        println!(
            "{name}: baseline = {base_med:.1} us, candidate = {cand_med:.1} us, speedup = {speedup:.2}x"
        );
    }

    println!("\n=== Benchmark: convert_32bit_rows ===");
    for (name, width, height, stride, order) in [
        ("1080p-bgra", 1920, 1080, 1920 * 4, ChannelOrder::Bgra),
        ("1080p-rgba", 1920, 1080, 1920 * 4, ChannelOrder::Rgba),
        ("1080p-argb", 1920, 1080, 1920 * 4, ChannelOrder::Argb),
        ("1080p-abgr", 1920, 1080, 1920 * 4, ChannelOrder::Abgr),
        ("1080p-bgra-padded", 1920, 1080, 7936, ChannelOrder::Bgra),
        ("unaligned-5px-argb", 5, 1080, 32, ChannelOrder::Argb),
        ("unaligned-6px-abgr", 6, 1080, 32, ChannelOrder::Abgr),
        ("unaligned-7px-argb", 7, 1080, 32, ChannelOrder::Argb),
    ] {
        let input: Vec<u8> = (0..stride * height)
            .map(|i| (i as u8).wrapping_mul(31))
            .collect();
        let expected = baseline::convert_32bit_rows(&input, stride, width, height, order).unwrap();
        let actual = candidate::convert_32bit_rows(&input, stride, width, height, order).unwrap();
        assert_eq!(expected, actual, "Mismatch in {name}");

        let mut baseline_times = Vec::new();
        let mut candidate_times = Vec::new();

        for i in 0..25 {
            let start = Instant::now();
            let res = baseline::convert_32bit_rows(
                black_box(&input),
                black_box(stride),
                black_box(width),
                black_box(height),
                black_box(order),
            );
            let elapsed_base = start.elapsed().as_nanos();
            black_box(res);

            let start = Instant::now();
            let res = candidate::convert_32bit_rows(
                black_box(&input),
                black_box(stride),
                black_box(width),
                black_box(height),
                black_box(order),
            );
            let elapsed_cand = start.elapsed().as_nanos();
            black_box(res);

            if i >= 5 {
                baseline_times.push(elapsed_base);
                candidate_times.push(elapsed_cand);
            }
        }
        baseline_times.sort();
        candidate_times.sort();
        let base_med = baseline_times[baseline_times.len() / 2] as f64 / 1_000.0;
        let cand_med = candidate_times[candidate_times.len() / 2] as f64 / 1_000.0;
        let speedup = base_med / cand_med;
        println!(
            "{name}: baseline = {base_med:.1} us, candidate = {cand_med:.1} us, speedup = {speedup:.2}x"
        );
    }

    println!("\n=== Benchmark: downsample_nearest ===");
    for (name, width, height, stride, target_w, target_h) in [
        ("1080p->720p", 1920, 1080, 1920 * 4, 1280, 720),
        ("1080p->360p", 1920, 1080, 1920 * 4, 640, 360),
        ("4k->1080p", 3840, 2160, 3840 * 4, 1920, 1080),
    ] {
        let input: Vec<u8> = (0..stride * height)
            .map(|i| (i as u8).wrapping_mul(13))
            .collect();
        let expected =
            baseline::downsample_nearest(&input, width, height, stride, target_w, target_h);
        let actual =
            candidate::downsample_nearest(&input, width, height, stride, target_w, target_h);
        assert_eq!(expected, actual, "Mismatch in {name}");

        let mut baseline_times = Vec::new();
        let mut candidate_times = Vec::new();

        for i in 0..25 {
            let start = Instant::now();
            let res = baseline::downsample_nearest(
                black_box(&input),
                black_box(width),
                black_box(height),
                black_box(stride),
                black_box(target_w),
                black_box(target_h),
            );
            let elapsed_base = start.elapsed().as_nanos();
            black_box(res);

            let start = Instant::now();
            let res = candidate::downsample_nearest(
                black_box(&input),
                black_box(width),
                black_box(height),
                black_box(stride),
                black_box(target_w),
                black_box(target_h),
            );
            let elapsed_cand = start.elapsed().as_nanos();
            black_box(res);

            if i >= 5 {
                baseline_times.push(elapsed_base);
                candidate_times.push(elapsed_cand);
            }
        }
        baseline_times.sort();
        candidate_times.sort();
        let base_med = baseline_times[baseline_times.len() / 2] as f64 / 1_000.0;
        let cand_med = candidate_times[candidate_times.len() / 2] as f64 / 1_000.0;
        let speedup = base_med / cand_med;
        println!(
            "{name}: baseline = {base_med:.1} us, candidate = {cand_med:.1} us, speedup = {speedup:.2}x"
        );
    }

    println!("\n=== Benchmark: convert_nv12_planes ===");
    for (name, width, height) in [
        ("720p-nv12", 1280, 720),
        ("1080p-nv12", 1920, 1080),
        ("4k-nv12", 3840, 2160),
    ] {
        let y_plane: Vec<u8> = (0..width * height)
            .map(|i| (i as u8).wrapping_mul(7))
            .collect();
        let uv_plane: Vec<u8> = (0..width * (height / 2))
            .map(|i| 128u8.wrapping_add(i as u8))
            .collect();
        let expected = baseline::convert_nv12_planes(
            &y_plane,
            width,
            &uv_plane,
            width,
            width,
            height,
            Nv12Range::Video,
        )
        .unwrap();
        let actual = candidate::convert_nv12_planes(
            &y_plane,
            width,
            &uv_plane,
            width,
            width,
            height,
            Nv12Range::Video,
        )
        .unwrap();
        assert_eq!(expected, actual, "Mismatch in {name}");

        let mut baseline_times = Vec::new();
        let mut candidate_times = Vec::new();

        for i in 0..20 {
            let start = Instant::now();
            let res = baseline::convert_nv12_planes(
                black_box(&y_plane),
                black_box(width),
                black_box(&uv_plane),
                black_box(width),
                black_box(width),
                black_box(height),
                black_box(Nv12Range::Video),
            );
            let elapsed_base = start.elapsed().as_nanos();
            black_box(res);

            let start = Instant::now();
            let res = candidate::convert_nv12_planes(
                black_box(&y_plane),
                black_box(width),
                black_box(&uv_plane),
                black_box(width),
                black_box(width),
                black_box(height),
                black_box(Nv12Range::Video),
            );
            let elapsed_cand = start.elapsed().as_nanos();
            black_box(res);

            if i >= 5 {
                baseline_times.push(elapsed_base);
                candidate_times.push(elapsed_cand);
            }
        }
        baseline_times.sort();
        candidate_times.sort();
        let base_med = baseline_times[baseline_times.len() / 2] as f64 / 1_000.0;
        let cand_med = candidate_times[candidate_times.len() / 2] as f64 / 1_000.0;
        let speedup = base_med / cand_med;
        println!(
            "{name}: baseline = {base_med:.1} us, candidate = {cand_med:.1} us, speedup = {speedup:.2}x"
        );
    }
}

// Baseline implementations prior to this optimization
mod baseline {
    use super::ChannelOrder;
    use super::Nv12Range;

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

    pub fn convert_32bit_rows(
        raw_data: &[u8],
        bytes_per_row: usize,
        width: usize,
        height: usize,
        order: ChannelOrder,
    ) -> Option<Vec<u8>> {
        let mut rgba_data = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            let row_start = y * bytes_per_row;
            let row_end = row_start + width * 4;
            if row_end > raw_data.len() {
                return None;
            }

            let row = &raw_data[row_start..row_end];
            for chunk in row.chunks_exact(4) {
                match order {
                    ChannelOrder::Bgra => {
                        rgba_data.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]])
                    }
                    ChannelOrder::Rgba => rgba_data.extend_from_slice(chunk),
                    ChannelOrder::Argb => {
                        rgba_data.extend_from_slice(&[chunk[1], chunk[2], chunk[3], chunk[0]])
                    }
                    ChannelOrder::Abgr => {
                        rgba_data.extend_from_slice(&[chunk[3], chunk[2], chunk[1], chunk[0]])
                    }
                }
            }
        }

        Some(rgba_data)
    }

    pub fn downsample_nearest(
        data: &[u8],
        width: usize,
        height: usize,
        stride: usize,
        target_width: u32,
        target_height: u32,
    ) -> Vec<u8> {
        let target_width = target_width as usize;
        let target_height = target_height as usize;
        let mut pixels = Vec::with_capacity(target_width * target_height * 4);
        for y in 0..target_height {
            let row = &data[y * height / target_height * stride..];
            for x in 0..target_width {
                let offset = x * width / target_width * 4;
                pixels.extend_from_slice(&row[offset..offset + 4]);
            }
        }
        pixels
    }

    pub fn convert_nv12_planes(
        y_plane: &[u8],
        y_stride: usize,
        uv_plane: &[u8],
        uv_stride: usize,
        width: usize,
        height: usize,
        range: Nv12Range,
    ) -> Option<Vec<u8>> {
        let mut rgba_data = vec![0u8; width * height * 4];

        for y_idx in 0..height {
            let y_row_start = y_idx * y_stride;
            if y_row_start + width > y_plane.len() {
                return None;
            }
            let y_row = &y_plane[y_row_start..y_row_start + width];

            let uv_row_start = (y_idx / 2) * uv_stride;
            if uv_row_start + width > uv_plane.len() {
                return None;
            }
            let uv_row = &uv_plane[uv_row_start..uv_row_start + width];

            for (x, y_val) in y_row.iter().enumerate().take(width) {
                let uv_index = (x / 2) * 2;
                if uv_index + 1 >= uv_row.len() {
                    return None;
                }

                let cb = uv_row[uv_index];
                let cr = uv_row[uv_index + 1];
                let (r, g, b) = ycbcr_to_rgb(*y_val, cb, cr, range);
                let out = (y_idx * width + x) * 4;
                rgba_data[out] = r;
                rgba_data[out + 1] = g;
                rgba_data[out + 2] = b;
                rgba_data[out + 3] = 255;
            }
        }

        Some(rgba_data)
    }

    fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8, range: Nv12Range) -> (u8, u8, u8) {
        let y = y as f32;
        let cb = cb as f32 - 128.0;
        let cr = cr as f32 - 128.0;

        let (y_value, scale) = match range {
            Nv12Range::Video => ((y - 16.0).max(0.0), 1.164383_f32),
            Nv12Range::_Full => (y, 1.0_f32),
        };

        let r = scale * y_value + 1.596027_f32 * cr;
        let g = scale * y_value - 0.391762_f32 * cb - 0.812968_f32 * cr;
        let b = scale * y_value + 2.017232_f32 * cb;

        (
            r.clamp(0.0, 255.0) as u8,
            g.clamp(0.0, 255.0) as u8,
            b.clamp(0.0, 255.0) as u8,
        )
    }
}
