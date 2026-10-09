use image::RgbaImage;

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

    let resized = image::imageops::resize(
        image,
        scaled_width.max(1),
        scaled_height.max(1),
        image::imageops::FilterType::Lanczos3,
    );

    let mut canvas = RgbaImage::from_pixel(target_width, target_height, image::Rgba([0, 0, 0, 0]));

    let offset_x = (target_width - scaled_width) / 2;
    let offset_y = (target_height - scaled_height) / 2;

    image::imageops::overlay(&mut canvas, &resized, offset_x as i64, offset_y as i64);

    canvas
}
