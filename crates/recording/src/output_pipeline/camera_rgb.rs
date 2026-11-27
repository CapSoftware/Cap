pub(super) fn convert_rgb24_to_bgra_into<'a>(
    src: &[u8],
    dst: &'a mut Vec<u8>,
    width: usize,
    height: usize,
    src_stride: usize,
    red_first: bool,
    bottom_up: bool,
) -> Result<&'a [u8], &'static str> {
    let invalid_layout = "Invalid 24-bit camera buffer layout";
    if width == 0 || height == 0 {
        return Err(invalid_layout);
    }
    let src_row_bytes = width.checked_mul(3).ok_or(invalid_layout)?;
    let dst_row_bytes = width.checked_mul(4).ok_or(invalid_layout)?;
    let required_src_len = (height - 1)
        .checked_mul(src_stride)
        .and_then(|offset| offset.checked_add(src_row_bytes))
        .ok_or(invalid_layout)?;
    let dst_len = height.checked_mul(dst_row_bytes).ok_or(invalid_layout)?;
    if src_stride < src_row_bytes || src.len() < required_src_len {
        return Err(invalid_layout);
    }

    dst.resize(dst_len, 0);
    let (blue, red) = if red_first { (2, 0) } else { (0, 2) };
    for (row, dst_row) in dst.chunks_exact_mut(dst_row_bytes).enumerate() {
        let src_row = if bottom_up { height - 1 - row } else { row };
        let start = src_row * src_stride;
        for (src_pixel, dst_pixel) in src[start..start + src_row_bytes]
            .chunks_exact(3)
            .zip(dst_row.chunks_exact_mut(4))
        {
            dst_pixel.copy_from_slice(&[src_pixel[blue], src_pixel[1], src_pixel[red], 255]);
        }
    }
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::convert_rgb24_to_bgra_into;

    #[test]
    fn rgb24_to_bgra_channel_order() {
        let mut dst = Vec::new();
        let result = convert_rgb24_to_bgra_into(
            &[255, 0, 0, 0, 255, 0, 0, 0, 255],
            &mut dst,
            3,
            1,
            9,
            true,
            false,
        )
        .unwrap();
        assert_eq!(result, &[0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    }

    #[test]
    fn bgr24_to_bgra_channel_order() {
        let mut dst = Vec::new();
        let result = convert_rgb24_to_bgra_into(
            &[0, 0, 255, 0, 255, 0, 255, 0, 0],
            &mut dst,
            3,
            1,
            9,
            false,
            false,
        )
        .unwrap();
        assert_eq!(result, &[0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    }

    #[test]
    fn padded_odd_width_rows_in_both_orientations() {
        let src = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 222, 222, 222, 10, 11, 12, 13, 14, 15, 16, 17, 18,
        ];
        for red_first in [false, true] {
            let (top, bottom) = if red_first {
                (
                    [3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255],
                    [12, 11, 10, 255, 15, 14, 13, 255, 18, 17, 16, 255],
                )
            } else {
                (
                    [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255],
                    [10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255],
                )
            };
            for bottom_up in [false, true] {
                let mut dst = Vec::new();
                let result =
                    convert_rgb24_to_bgra_into(&src, &mut dst, 3, 2, 12, red_first, bottom_up)
                        .unwrap();
                let expected = if bottom_up {
                    [bottom, top].concat()
                } else {
                    [top, bottom].concat()
                };
                assert_eq!(result, expected);
            }
        }
    }

    #[test]
    fn rejects_malformed_buffers_before_writing() {
        for (width, height, stride, len) in [
            (3, 2, 12, 20),
            (3, 2, 8, 24),
            (0, 2, 12, 24),
            (3, 0, 12, 24),
            (usize::MAX, 1, 12, 24),
            (3, usize::MAX, 12, 24),
        ] {
            for red_first in [false, true] {
                for bottom_up in [false, true] {
                    let mut dst = vec![42; 4];
                    assert!(
                        convert_rgb24_to_bgra_into(
                            &[0; 24][..len],
                            &mut dst,
                            width,
                            height,
                            stride,
                            red_first,
                            bottom_up,
                        )
                        .is_err()
                    );
                    assert_eq!(dst, [42; 4]);
                }
            }
        }
    }

    #[test]
    fn reuses_scratch_buffer_and_overwrites_previous_frame() {
        let mut dst = Vec::new();
        convert_rgb24_to_bgra_into(&[1; 18], &mut dst, 3, 2, 9, false, false).unwrap();
        let ptr = dst.as_ptr();
        let capacity = dst.capacity();
        let result =
            convert_rgb24_to_bgra_into(&[2, 3, 4], &mut dst, 1, 1, 3, true, false).unwrap();
        assert_eq!(result, &[4, 3, 2, 255]);
        assert_eq!(dst.as_ptr(), ptr);
        assert_eq!(dst.capacity(), capacity);
    }
}
