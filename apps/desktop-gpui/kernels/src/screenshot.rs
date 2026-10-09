pub fn is_opaque(rgba: &[u8]) -> bool {
    const ALPHA_MASK: u128 = 0xff000000ff000000ff000000ff000000;
    let mut blocks = rgba.chunks_exact(16);
    blocks
        .by_ref()
        .all(|block| u128::from_le_bytes(block.try_into().unwrap()) & ALPHA_MASK == ALPHA_MASK)
        && blocks
            .remainder()
            .iter()
            .skip(3)
            .step_by(4)
            .all(|&alpha| alpha == 255)
}

pub fn has_translucent_pixel(rgba: &[u8]) -> bool {
    rgba.iter().skip(3).step_by(4).any(|&alpha| alpha != 255)
}

pub fn flatten_onto_white(rgba: &[u8]) -> Vec<u8> {
    let mut rgba = rgba.to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel[3] = 255;
    }
    rgba
}

fn blend_pixel_over(dst: &mut [u8], src: [u8; 4]) {
    if src[3] == 0 {
        return;
    }
    if src[3] == 255 {
        dst.copy_from_slice(&src);
        return;
    }
    let sa = f32::from(src[3]) / 255.;
    let da = f32::from(dst[3]) / 255.;
    let oa = sa + da * (1. - sa);
    if oa <= 0. {
        dst.fill(0);
        return;
    }
    for channel in 0..3 {
        let s = f32::from(src[channel]);
        let d = f32::from(dst[channel]);
        dst[channel] = ((s * sa + d * da * (1. - sa)) / oa).round().clamp(0., 255.) as u8;
    }
    dst[3] = (oa * 255.).round() as u8;
}

pub fn blit_over(canvas: &mut [u8], size: (u32, u32), region: &image::RgbaImage, at: (u32, u32)) {
    let stride = size.0 as usize * 4;
    for (row_index, row) in region.rows().enumerate() {
        let y = at.1 as usize + row_index;
        if y >= size.1 as usize {
            break;
        }
        for (column_index, pixel) in row.enumerate() {
            let x = at.0 as usize + column_index;
            if x >= size.0 as usize {
                break;
            }
            let start = y * stride + x * 4;
            blend_pixel_over(&mut canvas[start..start + 4], pixel.0);
        }
    }
}

pub fn blit_over_offset(
    dst: &mut [u8],
    dst_size: (u32, u32),
    src: &[u8],
    src_size: (u32, u32),
    offset: (i64, i64),
) {
    let dst_stride = dst_size.0 as usize * 4;
    let src_stride = src_size.0 as usize * 4;
    for src_y in 0..src_size.1 as i64 {
        let dst_y = src_y + offset.1;
        if dst_y < 0 || dst_y >= i64::from(dst_size.1) {
            continue;
        }
        for src_x in 0..src_size.0 as i64 {
            let dst_x = src_x + offset.0;
            if dst_x < 0 || dst_x >= i64::from(dst_size.0) {
                continue;
            }
            let src_start = src_y as usize * src_stride + src_x as usize * 4;
            let dst_start = dst_y as usize * dst_stride + dst_x as usize * 4;
            let pixel = [
                src[src_start],
                src[src_start + 1],
                src[src_start + 2],
                src[src_start + 3],
            ];
            blend_pixel_over(&mut dst[dst_start..dst_start + 4], pixel);
        }
    }
}

pub fn premultiply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u16::from(*channel) * alpha + 127) / 255) as u8;
        }
    }
}

pub fn demultiply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        if alpha == 255 || alpha == 0 {
            continue;
        }
        for channel in &mut pixel[..3] {
            let value = (u32::from(*channel) * 255 + alpha / 2) / alpha;
            *channel = value.min(255) as u8;
        }
    }
}

pub fn blend_rect_premultiplied(
    data: &mut [u8],
    size: (u32, u32),
    at: (f64, f64),
    rect: (u32, u32),
    color: [u8; 4],
) {
    let alpha = f32::from(color[3]) / 255.;
    if alpha <= 0. {
        return;
    }
    let src = [
        (f32::from(color[0]) * alpha).round() as u8,
        (f32::from(color[1]) * alpha).round() as u8,
        (f32::from(color[2]) * alpha).round() as u8,
        color[3],
    ];
    let inverse = 1. - alpha;
    let stride = size.0 as usize * 4;
    let x0 = at.0.round() as i64;
    let y0 = at.1.round() as i64;
    for row in 0..i64::from(rect.1) {
        let y = y0 + row;
        if y < 0 || y >= i64::from(size.1) {
            continue;
        }
        for column in 0..i64::from(rect.0) {
            let x = x0 + column;
            if x < 0 || x >= i64::from(size.0) {
                continue;
            }
            let start = y as usize * stride + x as usize * 4;
            for channel in 0..4 {
                let d = f32::from(data[start + channel]);
                data[start + channel] =
                    (f32::from(src[channel]) + d * inverse).round().min(255.) as u8;
            }
        }
    }
}

pub fn mask_filter(
    rgba: &[u8],
    frame_width: u32,
    frame_height: u32,
    region: (u32, u32, u32, u32),
    pixelate: bool,
    level: f64,
) -> Option<image::RgbaImage> {
    if frame_width == 0 || frame_height == 0 {
        return None;
    }
    let stride = frame_width as usize * 4;
    if rgba.len() < stride * frame_height as usize {
        return None;
    }

    let (x0, y0, width, height) = region;
    let mut copied = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height {
        let start = (y0 + row) as usize * stride + x0 as usize * 4;
        copied.extend_from_slice(&rgba[start..start + width as usize * 4]);
    }
    let source = image::RgbaImage::from_raw(width, height, copied)?;

    let processed = if pixelate {
        let block = (level.round() as u32).max(2);
        let small = image::imageops::resize(
            &source,
            (width / block).max(1),
            (height / block).max(1),
            image::imageops::FilterType::Nearest,
        );
        image::imageops::resize(&small, width, height, image::imageops::FilterType::Nearest)
    } else {
        let factor = ((level / 4.).round() as u32).max(2);
        let small = image::imageops::resize(
            &source,
            (width / factor).max(1),
            (height / factor).max(1),
            image::imageops::FilterType::Triangle,
        );
        image::imageops::resize(&small, width, height, image::imageops::FilterType::Triangle)
    };

    Some(processed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_flatten(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
        let mut out = vec![255; rgba.len()];
        blit_over_offset(&mut out, (width, height), rgba, (width, height), (0, 0));
        out
    }

    #[test]
    fn white_flatten_matches_source_over_for_every_channel_and_alpha() {
        let rgba: Vec<u8> = (0..=255u8)
            .flat_map(|alpha| {
                (0..=255u8).flat_map(move |channel| {
                    [channel, 255 - channel, channel.wrapping_mul(17), alpha]
                })
            })
            .collect();
        assert_eq!(
            flatten_onto_white(&rgba),
            reference_flatten(&rgba, 256, 256)
        );
    }

    #[test]
    fn opacity_check_matches_individual_alpha_bytes_at_block_boundaries() {
        for length in 0..130 {
            let opaque = vec![255; length];
            assert!(is_opaque(&opaque));
            assert!(!has_translucent_pixel(&opaque));
            for changed_byte in 0..length {
                let mut rgba = opaque.clone();
                rgba[changed_byte] = 127;
                let expected = rgba.iter().skip(3).step_by(4).all(|&alpha| alpha == 255);
                assert_eq!(is_opaque(&rgba), expected);
                assert_eq!(has_translucent_pixel(&rgba), !expected);
            }
        }
    }

    #[test]
    fn flattening_an_opaque_canvas_is_the_identity() {
        let rgba = vec![10, 20, 30, 255, 40, 50, 60, 255];
        assert_eq!(flatten_onto_white(&rgba), rgba);
    }

    #[test]
    fn premultiply_roundtrip_is_exact_for_opaque_pixels() {
        let mut rgba = vec![13, 200, 91, 255, 1, 2, 3, 0];
        premultiply(&mut rgba);
        demultiply(&mut rgba);
        assert_eq!(rgba, vec![13, 200, 91, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn mask_filter_returns_the_region_size_and_rejects_short_frames() {
        let rgba: Vec<u8> = (0..16u32 * 12 * 4).map(|value| value as u8).collect();
        for pixelate in [false, true] {
            let filtered = mask_filter(&rgba, 16, 12, (2, 3, 9, 7), pixelate, 8.).unwrap();
            assert_eq!(filtered.dimensions(), (9, 7));
        }
        assert!(mask_filter(&rgba[..10], 16, 12, (0, 0, 1, 1), true, 8.).is_none());
        assert!(mask_filter(&rgba, 0, 12, (0, 0, 1, 1), true, 8.).is_none());
    }
}
