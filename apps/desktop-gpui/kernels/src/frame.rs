pub fn unpad_rows(data: &[u8], row_bytes: usize, stride: usize, rows: usize) -> Option<Vec<u8>> {
    if stride == 0 {
        return None;
    }
    let mut tight = Vec::with_capacity(row_bytes * rows);
    for row in data.chunks(stride).take(rows) {
        tight.extend_from_slice(row.get(..row_bytes)?);
    }
    Some(tight)
}

#[inline(always)]
fn swap_rgba_to_bgra_slice(source: &[u8], target: &mut [u8]) {
    for (src, dst) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
        dst[3] = src[3];
    }
}

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
        swap_rgba_to_bgra_slice(&source[..row_bytes], target);
    }
    Some(tight)
}

pub fn swap_red_blue(pixels: &mut [u8]) {
    let aligned = (pixels.len() / 16) * 16;
    let (aligned_slice, rem) = pixels.split_at_mut(aligned);
    for chunk in aligned_slice.chunks_exact_mut(16) {
        chunk.swap(0, 2);
        chunk.swap(4, 6);
        chunk.swap(8, 10);
        chunk.swap(12, 14);
    }
    for pixel in rem.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
}

pub fn swap_red_blue_into(source: &[u8], target: &mut Vec<u8>) {
    target.clear();
    target.extend_from_slice(source);
    swap_red_blue(target);
}

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
    let total_bytes = rows.checked_mul(row_bytes)?;
    if !mirrored && stride == row_bytes {
        return Some(data[..total_bytes].to_vec());
    }

    let mut pixels = vec![0; total_bytes];
    for (row, output) in pixels.chunks_exact_mut(row_bytes.max(1)).enumerate() {
        let input = &data[row * stride..row * stride + row_bytes];
        if mirrored {
            for (target, source) in output.chunks_exact_mut(4).zip(input.chunks_exact(4).rev()) {
                target.copy_from_slice(source);
            }
        } else {
            output.copy_from_slice(input);
        }
    }
    Some(pixels)
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
    if target_width == 0 || target_height == 0 || width == 0 || height == 0 {
        return Vec::new();
    }
    let target_row_bytes = target_width * 4;
    let mut pixels = vec![0u8; target_row_bytes * target_height];

    let x_offsets: Vec<usize> = (0..target_width)
        .map(|x| (x * width / target_width) * 4)
        .collect();

    for (y, target_row) in pixels.chunks_exact_mut(target_row_bytes).enumerate() {
        let src_row_offset = (y * height / target_height) * stride;
        if src_row_offset >= data.len() {
            break;
        }
        let src_row = &data[src_row_offset..];
        for (&src_offset, dst_pixel) in x_offsets.iter().zip(target_row.chunks_exact_mut(4)) {
            if src_offset + 4 <= src_row.len() {
                dst_pixel.copy_from_slice(&src_row[src_offset..src_offset + 4]);
            }
        }
    }
    pixels
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ChannelOrder {
    Bgra,
    Rgba,
    Argb,
    Abgr,
}

pub fn convert_32bit_rows(
    raw_data: &[u8],
    bytes_per_row: usize,
    width: usize,
    height: usize,
    order: ChannelOrder,
) -> Option<Vec<u8>> {
    let row_bytes = width.checked_mul(4)?;
    let output_len = row_bytes.checked_mul(height)?;
    if bytes_per_row < row_bytes || raw_data.len() < height.checked_mul(bytes_per_row)? {
        if height > 0 && width > 0 {
            tracing::warn!(
                bytes_per_row,
                row_bytes,
                raw_len = raw_data.len(),
                "Row bounds exceeded raw data length during thumbnail capture",
            );
        }
        return None;
    }
    if output_len == 0 {
        return Some(Vec::new());
    }

    let mut rgba_data = vec![0u8; output_len];

    match order {
        ChannelOrder::Rgba => {
            if bytes_per_row == row_bytes {
                rgba_data.copy_from_slice(&raw_data[..output_len]);
            } else {
                for (source, target) in raw_data
                    .chunks_exact(bytes_per_row)
                    .zip(rgba_data.chunks_exact_mut(row_bytes))
                    .take(height)
                {
                    target.copy_from_slice(&source[..row_bytes]);
                }
            }
        }
        ChannelOrder::Bgra => {
            for (source, target) in raw_data
                .chunks_exact(bytes_per_row)
                .zip(rgba_data.chunks_exact_mut(row_bytes))
                .take(height)
            {
                swap_rgba_to_bgra_slice(&source[..row_bytes], target);
            }
        }
        ChannelOrder::Argb => {
            for (source, target) in raw_data
                .chunks_exact(bytes_per_row)
                .zip(rgba_data.chunks_exact_mut(row_bytes))
                .take(height)
            {
                let src = &source[..row_bytes];
                let aligned = (row_bytes / 16) * 16;
                let (src_aligned, src_rem) = src.split_at(aligned);
                let (dst_aligned, dst_rem) = target.split_at_mut(aligned);
                for (src, dst) in src_aligned.chunks_exact(16).zip(dst_aligned.chunks_exact_mut(16)) {
                    dst[0] = src[1];
                    dst[1] = src[2];
                    dst[2] = src[3];
                    dst[3] = src[0];

                    dst[4] = src[5];
                    dst[5] = src[6];
                    dst[6] = src[7];
                    dst[7] = src[4];

                    dst[8] = src[9];
                    dst[9] = src[10];
                    dst[10] = src[11];
                    dst[11] = src[8];

                    dst[12] = src[13];
                    dst[13] = src[14];
                    dst[14] = src[15];
                    dst[15] = src[12];
                }
                for (src, dst) in src_rem.chunks_exact(4).zip(dst_rem.chunks_exact_mut(4)) {
                    dst[0] = src[1];
                    dst[1] = src[2];
                    dst[2] = src[3];
                    dst[3] = src[0];
                }
            }
        }
        ChannelOrder::Abgr => {
            for (source, target) in raw_data
                .chunks_exact(bytes_per_row)
                .zip(rgba_data.chunks_exact_mut(row_bytes))
                .take(height)
            {
                let src = &source[..row_bytes];
                let aligned = (row_bytes / 16) * 16;
                let (src_aligned, src_rem) = src.split_at(aligned);
                let (dst_aligned, dst_rem) = target.split_at_mut(aligned);
                for (src, dst) in src_aligned.chunks_exact(16).zip(dst_aligned.chunks_exact_mut(16)) {
                    dst[0] = src[3];
                    dst[1] = src[2];
                    dst[2] = src[1];
                    dst[3] = src[0];

                    dst[4] = src[7];
                    dst[5] = src[6];
                    dst[6] = src[5];
                    dst[7] = src[4];

                    dst[8] = src[11];
                    dst[9] = src[10];
                    dst[10] = src[9];
                    dst[11] = src[8];

                    dst[12] = src[15];
                    dst[13] = src[14];
                    dst[14] = src[13];
                    dst[15] = src[12];
                }
                for (src, dst) in src_rem.chunks_exact(4).zip(dst_rem.chunks_exact_mut(4)) {
                    dst[0] = src[3];
                    dst[1] = src[2];
                    dst[2] = src[1];
                    dst[3] = src[0];
                }
            }
        }
    }

    Some(rgba_data)
}

#[derive(Copy, Clone)]
pub enum Nv12Range {
    Video,
    _Full,
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
    let row_bytes = width.checked_mul(4)?;
    let output_len = row_bytes.checked_mul(height)?;
    if output_len == 0 {
        return Some(Vec::new());
    }
    let mut rgba_data = vec![0u8; output_len];

    let (scale, y_sub) = match range {
        Nv12Range::Video => (1.164383_f32, 16.0_f32),
        Nv12Range::_Full => (1.0_f32, 0.0_f32),
    };

    for (y_idx, rgba_row) in rgba_data.chunks_exact_mut(row_bytes).enumerate() {
        let y_row_start = y_idx * y_stride;
        if y_row_start + width > y_plane.len() {
            tracing::warn!(
                y_row_start,
                width,
                y_plane_len = y_plane.len(),
                "Y row exceeded plane length during conversion",
            );
            return None;
        }
        let y_row = &y_plane[y_row_start..y_row_start + width];

        let uv_row_start = (y_idx / 2) * uv_stride;
        if uv_row_start + width > uv_plane.len() {
            tracing::warn!(
                uv_row_start,
                width,
                uv_plane_len = uv_plane.len(),
                "UV row exceeded plane length during conversion",
            );
            return None;
        }
        let uv_row = &uv_plane[uv_row_start..uv_row_start + width];

        let pairs = width / 2;
        let mut x = 0;
        let mut dst_idx = 0;

        for _ in 0..pairs {
            let cb = uv_row[x];
            let cr = uv_row[x + 1];
            let cb_f = cb as f32 - 128.0;
            let cr_f = cr as f32 - 128.0;

            let r_chroma = 1.596027_f32 * cr_f;
            let g_chroma = -0.391762_f32 * cb_f - 0.812968_f32 * cr_f;
            let b_chroma = 2.017232_f32 * cb_f;

            let y1 = ((f32::from(y_row[x]) - y_sub).max(0.0)) * scale;
            rgba_row[dst_idx] = clamp_channel(y1 + r_chroma);
            rgba_row[dst_idx + 1] = clamp_channel(y1 + g_chroma);
            rgba_row[dst_idx + 2] = clamp_channel(y1 + b_chroma);
            rgba_row[dst_idx + 3] = 255;

            let y2 = ((f32::from(y_row[x + 1]) - y_sub).max(0.0)) * scale;
            rgba_row[dst_idx + 4] = clamp_channel(y2 + r_chroma);
            rgba_row[dst_idx + 5] = clamp_channel(y2 + g_chroma);
            rgba_row[dst_idx + 6] = clamp_channel(y2 + b_chroma);
            rgba_row[dst_idx + 7] = 255;

            x += 2;
            dst_idx += 8;
        }

        if x < width {
            let cb = uv_row[x];
            let cr = uv_row[x + 1];
            let (r, g, b) = ycbcr_to_rgb(y_row[x], cb, cr, range);
            rgba_row[dst_idx] = r;
            rgba_row[dst_idx + 1] = g;
            rgba_row[dst_idx + 2] = b;
            rgba_row[dst_idx + 3] = 255;
        }
    }

    Some(rgba_data)
}


pub fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8, range: Nv12Range) -> (u8, u8, u8) {
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

    (clamp_channel(r), clamp_channel(g), clamp_channel(b))
}

fn clamp_channel(value: f32) -> u8 {
    value.clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsamples_with_nearest_source_pixels() {
        let source: Vec<u8> = (0..4u8)
            .flat_map(|y| (0..4u8).flat_map(move |x| [x, y, 0, 255]))
            .collect();
        assert_eq!(
            downsample_nearest(&source, 4, 4, 16, 2, 2),
            vec![0, 0, 0, 255, 2, 0, 0, 255, 0, 2, 0, 255, 2, 2, 0, 255]
        );
    }

    const PADDED: [u8; 20] = [
        1, 2, 3, 4, 5, 6, 7, 8, 99, 99, //
        9, 10, 11, 12, 13, 14, 15, 16, 99, 99,
    ];

    #[test]
    fn unpads_rows_and_swaps_red_and_blue() {
        assert_eq!(
            unpad_rgba_to_bgra(&PADDED, 2, 10, 2).unwrap(),
            vec![3, 2, 1, 4, 7, 6, 5, 8, 11, 10, 9, 12, 15, 14, 13, 16]
        );
        assert_eq!(unpad_rows(&PADDED, 8, 10, 1).unwrap(), PADDED[..8].to_vec());
    }

    #[test]
    fn rejects_short_rows_and_zero_stride() {
        assert_eq!(unpad_rgba_to_bgra(&[0; 12], 4, 12, 1), None);
        assert_eq!(unpad_rgba_to_bgra(&[0; 16], 4, 0, 1), None);
    }

    #[test]
    fn copies_rows_and_mirrors_each_row() {
        assert_eq!(
            copy_rows(&PADDED, 8, 10, 2, false).unwrap(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
        assert_eq!(
            copy_rows(&PADDED, 8, 10, 2, true).unwrap(),
            vec![5, 6, 7, 8, 1, 2, 3, 4, 13, 14, 15, 16, 9, 10, 11, 12]
        );
        assert_eq!(copy_rows(&PADDED, 8, 6, 2, false), None);
        assert_eq!(copy_rows(&PADDED, 8, 10, 3, false), None);
    }

    #[test]
    fn swaps_into_a_reused_buffer() {
        let mut target = vec![0; 99];
        swap_red_blue_into(&[1, 2, 3, 4], &mut target);
        assert_eq!(target, vec![3, 2, 1, 4]);
    }

    #[test]
    fn thumbnail_channel_orders_and_nv12_match_the_picker() {
        let raw = vec![1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xff, 0xff, 0xff];
        assert_eq!(
            convert_32bit_rows(&raw, 12, 2, 1, ChannelOrder::Bgra).unwrap(),
            vec![3, 2, 1, 4, 7, 6, 5, 8]
        );
        assert_eq!(
            convert_32bit_rows(&raw, 12, 2, 1, ChannelOrder::Argb).unwrap(),
            vec![2, 3, 4, 1, 6, 7, 8, 5]
        );
        assert_eq!(ycbcr_to_rgb(81, 90, 240, Nv12Range::Video), (254, 0, 0));
        let y_plane = vec![16, 235, 0xaa, 0xaa, 235, 16, 0xaa, 0xaa];
        let uv_plane = vec![128, 128, 0xaa, 0xaa];
        let out = convert_nv12_planes(&y_plane, 4, &uv_plane, 4, 2, 2, Nv12Range::Video).unwrap();
        assert_eq!(&out[0..8], &[0, 0, 0, 255, 254, 254, 254, 255]);
        assert!(convert_nv12_planes(&[16], 4, &uv_plane, 4, 2, 1, Nv12Range::Video).is_none());
    }
}
