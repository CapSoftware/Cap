use image::RgbaImage;
use std::borrow::Cow;

pub fn fit_centered(image: &RgbaImage, target_width: u32, target_height: u32) -> RgbaImage {
    let width = image.width();
    let height = image.height();

    if width == target_width && height == target_height {
        return image.clone();
    }

    if width == 0 || height == 0 {
        return RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
    }

    let scale = (target_width as f32 / width as f32)
        .min(target_height as f32 / height as f32)
        .max(f32::MIN_POSITIVE);

    let scaled_width = (width as f32 * scale)
        .round()
        .clamp(1.0, target_width as f32) as u32;
    let scaled_height = (height as f32 * scale)
        .round()
        .clamp(1.0, target_height as f32) as u32;

    let resized = if (scaled_width, scaled_height) == image.dimensions() {
        Cow::Borrowed(image)
    } else {
        Cow::Owned(image::imageops::resize(
            image,
            scaled_width.max(1),
            scaled_height.max(1),
            image::imageops::FilterType::Lanczos3,
        ))
    };

    let mut canvas = RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));

    let offset_x = (target_width - scaled_width) / 2;
    let offset_y = (target_height - scaled_height) / 2;

    image::imageops::overlay(&mut canvas, &*resized, offset_x as i64, offset_y as i64);

    canvas
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fit_centered_with_unconditional_resize(
        image: &RgbaImage,
        target_width: u32,
        target_height: u32,
    ) -> RgbaImage {
        let width = image.width();
        let height = image.height();
        if width == target_width && height == target_height {
            return image.clone();
        }
        if width == 0 || height == 0 {
            return RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
        }
        let scale = (target_width as f32 / width as f32)
            .min(target_height as f32 / height as f32)
            .max(f32::MIN_POSITIVE);
        let scaled_width = (width as f32 * scale)
            .round()
            .clamp(1.0, target_width as f32) as u32;
        let scaled_height = (height as f32 * scale)
            .round()
            .clamp(1.0, target_height as f32) as u32;
        let resized = image::imageops::resize(
            image,
            scaled_width.max(1),
            scaled_height.max(1),
            image::imageops::FilterType::Lanczos3,
        );
        let mut canvas =
            RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));
        image::imageops::overlay(
            &mut canvas,
            &resized,
            i64::from((target_width - scaled_width) / 2),
            i64::from((target_height - scaled_height) / 2),
        );
        canvas
    }

    fn source(width: u32, height: u32, alpha: Option<u8>) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([
                (x * 17 + y * 31) as u8,
                (x * 43 + y * 7) as u8,
                211,
                alpha.unwrap_or((x + y * width) as u8),
            ])
        })
    }

    fn assert_matches_reference(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
        let unchanged = image.clone();
        let expected = fit_centered_with_unconditional_resize(image, width, height);
        let actual = fit_centered(image, width, height);
        assert_eq!(actual.dimensions(), (width, height));
        assert!(
            actual == expected,
            "RGBA output changed for {:?} into {width}x{height}",
            image.dimensions()
        );
        assert_eq!(image, &unchanged);
        actual
    }

    #[test]
    fn fitted_sources_keep_exact_centering_and_transparent_padding() {
        for (width, height, target_width, target_height) in [
            (218, 180, 320, 180),
            (320, 134, 320, 180),
            (180, 180, 320, 180),
            (320, 175, 320, 180),
            (1, 1, 3, 1),
            (2, 1, 5, 1),
            (1, 2, 1, 5),
            (3, 2, 3, 3),
        ] {
            for alpha in [Some(255), None, Some(0)] {
                let source = source(width, height, alpha);
                let actual = assert_matches_reference(&source, target_width, target_height);
                let left = (target_width - width) / 2;
                let top = (target_height - height) / 2;
                for (x, y, pixel) in actual.enumerate_pixels() {
                    if x < left || y < top || x >= left + width || y >= top + height {
                        assert_eq!(*pixel, image::Rgba([0, 0, 0, 0]));
                    } else if alpha == Some(255) {
                        assert_eq!(pixel, source.get_pixel(x - left, y - top));
                    }
                }
                if alpha == Some(0) {
                    assert!(actual.as_raw().iter().all(|value| *value == 0));
                }
            }
        }
    }

    #[test]
    fn resized_sources_match_lanczos_reference() {
        for (width, height, target_width, target_height) in [
            (53, 31, 320, 180),
            (640, 360, 320, 180),
            (641, 361, 320, 180),
            (7, 9, 16, 16),
            (17, 9, 8, 8),
            (1, 7, 4, 4),
            (7, 1, 4, 4),
            (1, 1, 3, 5),
            (2, 3, 1, 1),
        ] {
            for alpha in [Some(255), None, Some(0)] {
                assert_matches_reference(
                    &source(width, height, alpha),
                    target_width,
                    target_height,
                );
            }
        }
    }

    #[test]
    fn exact_size_preserves_hidden_rgb_and_source_pixels() {
        for alpha in [Some(255), None, Some(0)] {
            let source = source(320, 180, alpha);
            let actual = assert_matches_reference(&source, 320, 180);
            assert_eq!(actual, source);
        }
    }

    #[test]
    fn empty_sources_produce_transparent_canvas() {
        for (width, height) in [(0, 0), (0, 7), (9, 0)] {
            let source = RgbaImage::new(width, height);
            for (target_width, target_height) in [(320, 180), (1, 1), (0, 5), (7, 0), (0, 0)] {
                let actual = assert_matches_reference(&source, target_width, target_height);
                assert!(actual.as_raw().iter().all(|value| *value == 0));
            }
        }
    }
}
