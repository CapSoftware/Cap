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

pub fn unpad_rgba_to_bgra(
    data: &[u8],
    width: usize,
    stride: usize,
    rows: usize,
) -> Option<Vec<u8>> {
    let mut tight = unpad_rows(data, width * 4, stride, rows)?;
    swap_red_blue(&mut tight);
    Some(tight)
}

pub fn swap_red_blue(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
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
    let mut pixels = vec![0; rows.checked_mul(row_bytes)?];
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
}
