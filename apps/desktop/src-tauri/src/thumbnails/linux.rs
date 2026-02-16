use super::*;
use image::RgbaImage;

pub async fn capture_display_thumbnail(display: &scap_targets::Display) -> Option<String> {
    let display_id = display.id();
    let bounds = display.raw_handle().logical_bounds()?;
    let width = bounds.size().width() as u32;
    let height = bounds.size().height() as u32;
    let x = bounds.position().x() as i32;
    let y = bounds.position().y() as i32;

    tokio::task::spawn_blocking(move || capture_x11_region(x, y, width, height))
        .await
        .ok()
        .flatten()
}

pub async fn capture_window_thumbnail(window: &scap_targets::Window) -> Option<String> {
    let window_id = window.raw_handle().x11_window_id();
    let bounds = window.raw_handle().logical_bounds()?;
    let width = bounds.size().width() as u32;
    let height = bounds.size().height() as u32;

    tokio::task::spawn_blocking(move || capture_x11_window(window_id, width, height))
        .await
        .ok()
        .flatten()
}

fn capture_x11_region(x: i32, y: i32, width: u32, height: u32) -> Option<String> {
    if width == 0 || height == 0 {
        return None;
    }

    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }

        let root = x11::xlib::XDefaultRootWindow(display);
        let image =
            x11::xlib::XGetImage(display, root, x, y, width, height, !0, x11::xlib::ZPixmap);

        if image.is_null() {
            x11::xlib::XCloseDisplay(display);
            return None;
        }

        let result = ximage_to_base64_png(image, width, height);

        x11::xlib::XDestroyImage(image);
        x11::xlib::XCloseDisplay(display);

        result
    }
}

fn capture_x11_window(window_id: u64, width: u32, height: u32) -> Option<String> {
    if width == 0 || height == 0 {
        return None;
    }

    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }

        let mut attrs: x11::xlib::XWindowAttributes = std::mem::zeroed();
        if x11::xlib::XGetWindowAttributes(display, window_id, &mut attrs) == 0 {
            x11::xlib::XCloseDisplay(display);
            return None;
        }

        let actual_width = attrs.width as u32;
        let actual_height = attrs.height as u32;

        if actual_width == 0 || actual_height == 0 {
            x11::xlib::XCloseDisplay(display);
            return None;
        }

        let root = x11::xlib::XDefaultRootWindow(display);
        let mut child_return = 0u64;
        let mut abs_x = 0i32;
        let mut abs_y = 0i32;
        x11::xlib::XTranslateCoordinates(
            display,
            window_id,
            root,
            0,
            0,
            &mut abs_x,
            &mut abs_y,
            &mut child_return,
        );

        let image = x11::xlib::XGetImage(
            display,
            root,
            abs_x,
            abs_y,
            actual_width.min(width),
            actual_height.min(height),
            !0,
            x11::xlib::ZPixmap,
        );

        if image.is_null() {
            x11::xlib::XCloseDisplay(display);
            return None;
        }

        let capture_w = actual_width.min(width);
        let capture_h = actual_height.min(height);
        let result = ximage_to_base64_png(image, capture_w, capture_h);

        x11::xlib::XDestroyImage(image);
        x11::xlib::XCloseDisplay(display);

        result
    }
}

unsafe fn ximage_to_base64_png(
    image: *mut x11::xlib::XImage,
    width: u32,
    height: u32,
) -> Option<String> {
    let bytes_per_pixel = ((*image).bits_per_pixel / 8) as usize;
    let stride = (*image).bytes_per_line as usize;
    let data_ptr = (*image).data as *const u8;

    if data_ptr.is_null() || bytes_per_pixel < 3 {
        return None;
    }

    let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);

    for y in 0..height as usize {
        for x in 0..width as usize {
            let offset = y * stride + x * bytes_per_pixel;
            let b = *data_ptr.add(offset);
            let g = *data_ptr.add(offset + 1);
            let r = *data_ptr.add(offset + 2);
            let a = if bytes_per_pixel >= 4 {
                *data_ptr.add(offset + 3)
            } else {
                255
            };
            rgba_data.push(r);
            rgba_data.push(g);
            rgba_data.push(b);
            rgba_data.push(a);
        }
    }

    let img = RgbaImage::from_raw(width, height, rgba_data)?;
    let normalized = normalize_thumbnail_dimensions(&img);

    let mut png_data = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
    image::ImageEncoder::write_image(
        encoder,
        normalized.as_raw(),
        normalized.width(),
        normalized.height(),
        image::ColorType::Rgba8.into(),
    )
    .ok()?;

    Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &png_data,
    ))
}
