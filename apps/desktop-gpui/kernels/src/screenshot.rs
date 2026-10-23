pub fn is_opaque(rgba: &[u8]) -> bool {
    const ALPHA_MASK: u128 = 0xff000000ff000000ff000000ff000000;
    let mut chunks = rgba.chunks_exact(64);
    for chunk in &mut chunks {
        let b0 = u128::from_le_bytes(chunk[0..16].try_into().unwrap());
        let b1 = u128::from_le_bytes(chunk[16..32].try_into().unwrap());
        let b2 = u128::from_le_bytes(chunk[32..48].try_into().unwrap());
        let b3 = u128::from_le_bytes(chunk[48..64].try_into().unwrap());
        if (b0 & b1 & b2 & b3) & ALPHA_MASK != ALPHA_MASK {
            return false;
        }
    }
    let mut rem = chunks.remainder().chunks_exact(16);
    for block in &mut rem {
        if u128::from_le_bytes(block.try_into().unwrap()) & ALPHA_MASK != ALPHA_MASK {
            return false;
        }
    }
    rem.remainder()
        .iter()
        .skip(3)
        .step_by(4)
        .all(|&alpha| alpha == 255)
}

pub fn has_translucent_pixel(rgba: &[u8]) -> bool {
    !is_opaque(rgba)
}

pub fn flatten_onto_white(rgba: &[u8]) -> Vec<u8> {
    if is_opaque(rgba) {
        return rgba.to_vec();
    }
    let mut rgba = rgba.to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = pixel[3];
        if alpha == 255 {
            continue;
        }
        if alpha == 0 {
            pixel[0] = 255;
            pixel[1] = 255;
            pixel[2] = 255;
            pixel[3] = 255;
            continue;
        }
        let a = u32::from(alpha);
        let inv = 255 - a;
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * a + 255 * inv + 127) / 255) as u8;
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

// Source-over onto an opaque destination. `oa` is exactly 1.0 for every
// 8-bit source alpha, so the divide drops out and the result is the integer
// rounding of `(s*a + d*(255-a)) / 255`, which is bit-identical to the float
// path for all 16.6M (src, dst, alpha) combinations.
fn blend_pixel_over_opaque(dst: &mut [u8], src: [u8; 4]) {
    let alpha = u32::from(src[3]);
    let inverse = 255 - alpha;
    for channel in 0..3 {
        dst[channel] = ((u32::from(src[channel]) * alpha + u32::from(dst[channel]) * inverse + 127)
            / 255) as u8;
    }
    dst[3] = 255;
}

pub fn blit_over(canvas: &mut [u8], size: (u32, u32), region: &image::RgbaImage, at: (u32, u32)) {
    blit_over_offset(
        canvas,
        size,
        region.as_raw(),
        region.dimensions(),
        (i64::from(at.0), i64::from(at.1)),
    );
}

pub fn blit_over_offset(
    dst: &mut [u8],
    dst_size: (u32, u32),
    src: &[u8],
    src_size: (u32, u32),
    offset: (i64, i64),
) {
    if offset.0 >= i64::from(dst_size.0)
        || offset.1 >= i64::from(dst_size.1)
        || offset.0 <= -i64::from(src_size.0)
        || offset.1 <= -i64::from(src_size.1)
    {
        return;
    }

    let src_x = (-offset.0).max(0) as usize;
    let src_y = (-offset.1).max(0) as usize;
    let dst_x = offset.0.max(0) as usize;
    let dst_y = offset.1.max(0) as usize;
    let width = (src_size.0 as usize - src_x).min(dst_size.0 as usize - dst_x);
    let height = (src_size.1 as usize - src_y).min(dst_size.1 as usize - dst_y);
    let dst_stride = dst_size.0 as usize * 4;
    let src_stride = src_size.0 as usize * 4;
    for row in 0..height {
        let src_start = (src_y + row) * src_stride + src_x * 4;
        let dst_start = (dst_y + row) * dst_stride + dst_x * 4;
        let source = &src[src_start..src_start + width * 4];
        let target = &mut dst[dst_start..dst_start + width * 4];
        if is_opaque(source) {
            target.copy_from_slice(source);
        } else {
            blend_row_over(target, source);
        }
    }
}

enum Backdrop {
    Transparent,
    Opaque,
    Mixed,
}

// One pass over the destination alpha bytes instead of two predicate scans.
fn classify_backdrop(rgba: &[u8]) -> Backdrop {
    const ALPHA_MASK: u128 = 0xff000000ff000000ff000000ff000000;
    let (mut transparent, mut opaque) = (true, true);
    let mut blocks = rgba.chunks_exact(16);
    for block in blocks.by_ref() {
        let alpha = u128::from_le_bytes(block.try_into().unwrap()) & ALPHA_MASK;
        transparent &= alpha == 0;
        opaque &= alpha == ALPHA_MASK;
        if !transparent && !opaque {
            return Backdrop::Mixed;
        }
    }
    for &alpha in blocks.remainder().iter().skip(3).step_by(4) {
        transparent &= alpha == 0;
        opaque &= alpha == 255;
    }
    match (transparent, opaque) {
        (true, _) => Backdrop::Transparent,
        (_, true) => Backdrop::Opaque,
        _ => Backdrop::Mixed,
    }
}

#[inline(never)]
fn blend_row_over(target: &mut [u8], source: &[u8]) {
    match classify_backdrop(target) {
        Backdrop::Transparent => {
            // Over a fully transparent row the destination contributes
            // nothing, so each pixel is either the source or left alone.
            for (target, source) in target.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                if source[3] != 0 {
                    target.copy_from_slice(source);
                }
            }
        }
        Backdrop::Opaque => {
            // Blocks of four pixels: a fully opaque block is a straight copy,
            // anything else takes the branchless integer blend so the common
            // run of opaque pixels never pays for per-pixel branching.
            const ALPHA_MASK: u128 = 0xff000000ff000000ff000000ff000000;
            let mut targets = target.chunks_exact_mut(16);
            let mut sources = source.chunks_exact(16);
            for (target, source) in targets.by_ref().zip(sources.by_ref()) {
                if u128::from_le_bytes(source.try_into().unwrap()) & ALPHA_MASK == ALPHA_MASK {
                    target.copy_from_slice(source);
                    continue;
                }
                for (target, source) in target.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                    blend_pixel_over_opaque(target, source.try_into().unwrap());
                }
            }
            for (target, source) in targets
                .into_remainder()
                .chunks_exact_mut(4)
                .zip(sources.remainder().chunks_exact(4))
            {
                blend_pixel_over_opaque(target, source.try_into().unwrap());
            }
        }
        Backdrop::Mixed => {
            for (target, source) in target.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                blend_pixel_over(target, source.try_into().unwrap());
            }
        }
    }
}

pub fn premultiply(rgba: &mut [u8]) {
    if is_opaque(rgba) {
        return;
    }
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
    if is_opaque(rgba) {
        return;
    }
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
    if pixelate {
        let block = (level.round() as u32).max(2);
        return pixelate_region(rgba, stride, region, block);
    }

    let mut copied = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height {
        let start = (y0 + row) as usize * stride + x0 as usize * 4;
        copied.extend_from_slice(&rgba[start..start + width as usize * 4]);
    }
    let source = image::RgbaImage::from_raw(width, height, copied)?;

    let factor = ((level / 4.).round() as u32).max(2);
    let small = image::imageops::resize(
        &source,
        (width / factor).max(1),
        (height / factor).max(1),
        image::imageops::FilterType::Triangle,
    );
    Some(image::imageops::resize(
        &small,
        width,
        height,
        image::imageops::FilterType::Triangle,
    ))
}

fn pixelate_region(
    rgba: &[u8],
    stride: usize,
    (x0, y0, width, height): (u32, u32, u32, u32),
    block: u32,
) -> Option<image::RgbaImage> {
    let columns: Vec<usize> = pixelated_samples(width, block)
        .map(|x| (x0 as usize + x) * 4)
        .collect();
    let row_bytes = width as usize * 4;
    let mut pixels = Vec::with_capacity(row_bytes * height as usize);
    let mut previous = None;
    for y in pixelated_samples(height, block) {
        if previous == Some(y) {
            pixels.extend_from_within(pixels.len() - row_bytes..);
            continue;
        }
        let row = &rgba[(y0 as usize + y) * stride..];
        for &offset in &columns {
            pixels.extend_from_slice(&row[offset..offset + 4]);
        }
        previous = Some(y);
    }
    image::RgbaImage::from_raw(width, height, pixels)
}

fn pixelated_samples(size: u32, block: u32) -> impl Iterator<Item = usize> {
    let small = (size / block).max(1);
    (0..size).map(move |x| nearest_sample(nearest_sample(x, small, size), size, small) as usize)
}

fn nearest_sample(output: u32, input: u32, output_size: u32) -> u32 {
    let ratio = input as f32 / output_size as f32;
    let sample = ((output as f32 + 0.5) * ratio).floor() as i64;
    sample.clamp(0, i64::from(input) - 1) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_pixelate(
        rgba: &[u8],
        frame_width: u32,
        (x0, y0, width, height): (u32, u32, u32, u32),
        block: u32,
    ) -> Vec<u8> {
        let source = image::imageops::crop_imm(
            &image::RgbaImage::from_raw(
                frame_width,
                (rgba.len() / 4) as u32 / frame_width,
                rgba.to_vec(),
            )
            .unwrap(),
            x0,
            y0,
            width,
            height,
        )
        .to_image();
        let small = image::imageops::resize(
            &source,
            (width / block).max(1),
            (height / block).max(1),
            image::imageops::FilterType::Nearest,
        );
        image::imageops::resize(&small, width, height, image::imageops::FilterType::Nearest)
            .into_raw()
    }

    #[test]
    fn pixelate_matches_two_nearest_resizes() {
        let (frame_width, frame_height) = (61u32, 47u32);
        let rgba: Vec<u8> = (0..frame_width * frame_height * 4)
            .map(|i| (i.wrapping_mul(37) % 251) as u8)
            .collect();
        for region in [
            (0, 0, 61, 47),
            (3, 5, 1, 1),
            (4, 4, 0, 9),
            (4, 4, 9, 0),
            (7, 2, 13, 29),
            (60, 0, 1, 47),
            (10, 11, 50, 36),
        ] {
            for level in [1., 2., 2.6, 3., 7., 16., 40., 100.] {
                let block = (f64::round(level) as u32).max(2);
                let actual =
                    mask_filter(&rgba, frame_width, frame_height, region, true, level).unwrap();
                assert_eq!(actual.dimensions(), (region.2, region.3));
                assert_eq!(
                    actual.into_raw(),
                    reference_pixelate(&rgba, frame_width, region, block),
                    "{region:?} at {level}"
                );
            }
        }
    }

    fn reference_blit(
        dst: &mut [u8],
        dst_size: (u32, u32),
        src: &[u8],
        src_size: (u32, u32),
        offset: (i64, i64),
    ) {
        for y in 0..src_size.1 {
            for x in 0..src_size.0 {
                let dx = i64::from(x) + offset.0;
                let dy = i64::from(y) + offset.1;
                if dx < 0 || dy < 0 || dx >= i64::from(dst_size.0) || dy >= i64::from(dst_size.1) {
                    continue;
                }
                let source = (y as usize * src_size.0 as usize + x as usize) * 4;
                let target = (dy as usize * dst_size.0 as usize + dx as usize) * 4;
                blend_pixel_over(
                    &mut dst[target..target + 4],
                    src[source..source + 4].try_into().unwrap(),
                );
            }
        }
    }

    #[test]
    fn uniform_backdrops_match_scalar_source_over() {
        // Widths either side of the four-pixel block stride the opaque
        // backdrop path copies through.
        for width in [1, 3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33] {
            let size = (width, 3);
            let src: Vec<u8> = (0..width * 3)
                .flat_map(|i| {
                    [
                        i as u8,
                        (i * 17) as u8,
                        (i * 29) as u8,
                        match i % 5 {
                            0 => 0,
                            1 => 255,
                            2 => 128,
                            3 => 1,
                            _ => 254,
                        },
                    ]
                })
                .collect();
            // The export canvas is either cleared to zero or filled with
            // white, so both uniform backdrops are the real-world cases.
            for backdrop in [
                [0, 0, 0, 0],
                [255, 255, 255, 255],
                [11, 22, 33, 255],
                [11, 22, 33, 0],
                [11, 22, 33, 128],
            ] {
                for stray in [None, Some(0usize), Some(1), Some(4), Some(7)] {
                    let mut initial: Vec<u8> = (0..width * 3).flat_map(|_| backdrop).collect();
                    // A single differing alpha must drop the row out of the
                    // uniform fast paths and back onto the general blend.
                    if let Some(index) = stray
                        && let Some(pixel) = initial.chunks_exact_mut(4).nth(index)
                    {
                        pixel[3] = 97;
                    }
                    let mut expected = initial.clone();
                    let mut actual = initial;
                    reference_blit(&mut expected, size, &src, size, (0, 0));
                    blit_over_offset(&mut actual, size, &src, size, (0, 0));
                    assert_eq!(actual, expected, "{width}, {backdrop:?}, {stray:?}");
                }
            }
        }
    }

    #[test]
    fn clipped_blits_match_scalar_source_over() {
        for width in [0, 1, 3, 4, 5, 15, 16, 17, 31, 32, 33] {
            let src_size = (width, 4);
            let dst_size = (19, 7);
            for alpha in [0, 128, 255] {
                let mut src: Vec<u8> = (0..width * 4)
                    .flat_map(|i| [i as u8, (i * 17) as u8, (i * 29) as u8, alpha])
                    .collect();
                for mixed in [false, true] {
                    if mixed {
                        for (i, pixel) in src.chunks_exact_mut(4).enumerate() {
                            pixel[3] = i.wrapping_mul(71) as u8;
                        }
                    }
                    for x in [-34, -17, -1, 0, 1, 18, 19, 34] {
                        for y in [-5, -1, 0, 1, 6, 7] {
                            let initial: Vec<u8> = (0..19 * 7)
                                .flat_map(|i| [31, 127, 231, (i * 43) as u8])
                                .collect();
                            let mut expected = initial.clone();
                            let mut actual = initial;
                            reference_blit(&mut expected, dst_size, &src, src_size, (x, y));
                            blit_over_offset(&mut actual, dst_size, &src, src_size, (x, y));
                            assert_eq!(
                                actual, expected,
                                "{src_size:?}, {alpha}, {mixed}, {x}, {y}"
                            );
                            if x >= 0 && y >= 0 {
                                let region =
                                    image::RgbaImage::from_raw(width, 4, src.clone()).unwrap();
                                let mut actual: Vec<u8> = (0..19 * 7)
                                    .flat_map(|i| [31, 127, 231, (i * 43) as u8])
                                    .collect();
                                blit_over(&mut actual, dst_size, &region, (x as u32, y as u32));
                                assert_eq!(actual, expected);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn opaque_row_fast_path_respects_every_alpha_byte() {
        let size = (33, 2);
        for changed in 0..66 {
            let mut src = vec![255; 33 * 2 * 4];
            src[changed * 4 + 3] = 127;
            let mut expected = vec![61; src.len()];
            let mut actual = expected.clone();
            reference_blit(&mut expected, size, &src, size, (0, 0));
            blit_over_offset(&mut actual, size, &src, size, (0, 0));
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn blits_outside_the_canvas_do_not_touch_buffers() {
        for offset in [(i64::MIN, 0), (i64::MAX, 0), (0, i64::MIN), (0, i64::MAX)] {
            blit_over_offset(&mut [], (1, 1), &[], (1, 1), offset);
        }
        blit_over_offset(&mut [], (0, 0), &[], (0, 0), (0, 0));
    }

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
