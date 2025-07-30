use std::collections::HashMap;

use sha2::{Digest, Sha256};

fn main() {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return run();
    #[allow(unreachable_code)]
    panic!("Unsupported platform!");
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn run() {
    use objc2::{MainThreadMarker, rc::Retained};
    use objc2_app_kit::{NSApplication, NSCursor};

    let mtm = MainThreadMarker::new().expect("Not on main thread");
    let _app: Retained<NSApplication> = NSApplication::sharedApplication(mtm);

    let cursors = vec![
        ("arrow", NSCursor::arrowCursor()),
        ("contextualMenu", NSCursor::contextualMenuCursor()),
        ("closedHand", NSCursor::closedHandCursor()),
        ("crosshair", NSCursor::crosshairCursor()),
        ("disappearingItem", NSCursor::disappearingItemCursor()),
        ("dragCopy", NSCursor::dragCopyCursor()),
        ("dragLink", NSCursor::dragLinkCursor()),
        ("IBeam", NSCursor::IBeamCursor()),
        ("openHand", NSCursor::openHandCursor()),
        ("operationNotAllowed", NSCursor::operationNotAllowedCursor()),
        ("pointingHand", NSCursor::pointingHandCursor()),
        ("resizeDown", NSCursor::resizeDownCursor()),
        ("resizeLeft", NSCursor::resizeLeftCursor()),
        ("resizeLeftRight", NSCursor::resizeLeftRightCursor()),
        ("resizeRight", NSCursor::resizeRightCursor()),
        ("resizeUp", NSCursor::resizeUpCursor()),
        ("resizeUpDown", NSCursor::resizeUpDownCursor()),
        ("IBeamVertical", NSCursor::IBeamCursorForVerticalLayout()),
    ];

    unsafe {
        let mut cursor_lookup = HashMap::new();

        for (name, cursor) in cursors {
            let hash = hex::encode(Sha256::digest(
                &cursor
                    .image()
                    .TIFFRepresentation()
                    .expect("Failed to get TIFF representation of built-in cursor")
                    .as_bytes_unchecked(),
            ));
            println!("{name}: {}", hash);
            cursor_lookup.insert(hash, name);
        }

        // return;

        loop {
            #[allow(deprecated)]
            let cursor = NSCursor::currentSystemCursor().unwrap_or(NSCursor::currentCursor());
            let hash = hex::encode(Sha256::digest(
                &cursor
                    .image()
                    .TIFFRepresentation()
                    .expect("Failed to get TIFF representation of built-in cursor")
                    .as_bytes_unchecked(),
            ));

            if cursor_lookup.get(&hash).is_none() {
                panic!("Cursor hash '{hash}' not known",);
            };

            println!(
                "{cursor:?} {hash} {}",
                cursor_lookup.get(&hash).unwrap_or(&"Unknown")
            );
        }
    };
}

#[cfg(target_os = "windows")]
fn run() {
    use windows::{
        Win32::{
            Foundation::POINT,
            UI::WindowsAndMessaging::{
                CURSORINFO, CURSORINFO_FLAGS, GetCursorInfo, GetIconInfo, HCURSOR, ICONINFO,
                IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO,
                IDC_PERSON, IDC_PIN, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE,
                IDC_SIZEWE, IDC_UPARROW, IDC_WAIT, LoadCursorW,
            },
        },
        core::PCWSTR,
    };

    #[inline]
    fn load_cursor(lpcursorname: PCWSTR) -> HCURSOR {
        unsafe { LoadCursorW(None, lpcursorname) }.expect("Failed to load default system cursors")
    }

    fn get_icon(hCursor: HCURSOR) -> Vec<u8> {
        unsafe {
            // Get icon info
            use windows::Win32::{
                Foundation::HWND,
                Graphics::Gdi::{
                    BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
                    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetObjectA, ReleaseDC,
                    SelectObject,
                },
                UI::WindowsAndMessaging::{DI_NORMAL, DrawIconEx},
            };
            let mut icon_info = ICONINFO::default();
            if GetIconInfo(hCursor, &mut icon_info).is_err() {
                panic!("Error getting icon info");
            }

            // Get bitmap info for the cursor
            let mut bitmap = BITMAP::default();
            let bitmap_handle = if !icon_info.hbmColor.is_invalid() {
                icon_info.hbmColor
            } else {
                icon_info.hbmMask
            };

            if GetObjectA(
                bitmap_handle,
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bitmap as *mut _ as *mut _),
            ) == 0
            {
                // Clean up handles
                if !icon_info.hbmColor.is_invalid() {
                    use windows::Win32::Graphics::Gdi::DeleteObject;

                    DeleteObject(icon_info.hbmColor);
                }
                if !icon_info.hbmMask.is_invalid() {
                    use windows::Win32::Graphics::Gdi::DeleteObject;

                    DeleteObject(icon_info.hbmMask);
                }
                panic!("Error");
            }

            // Create DCs
            let screen_dc = GetDC(HWND::default());
            let mem_dc = CreateCompatibleDC(screen_dc);

            // Get cursor dimensions
            let width = bitmap.bmWidth;
            let height = if icon_info.hbmColor.is_invalid() && bitmap.bmHeight > 0 {
                // For mask cursors, the height is doubled (AND mask + XOR mask)
                bitmap.bmHeight / 2
            } else {
                bitmap.bmHeight
            };

            // Create bitmap info header for 32-bit RGBA
            let bi = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // Negative for top-down DIB
                biPlanes: 1,
                biBitCount: 32, // 32-bit RGBA
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };

            let bitmap_info = BITMAPINFO {
                bmiHeader: bi,
                bmiColors: [Default::default()],
            };

            // Create DIB section
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let dib = CreateDIBSection(mem_dc, &bitmap_info, DIB_RGB_COLORS, &mut bits, None, 0);

            if dib.is_err() {
                // Clean up

                use windows::Win32::Graphics::Gdi::{DeleteDC, ReleaseDC};
                DeleteDC(mem_dc);
                ReleaseDC(HWND::default(), screen_dc);
                if !icon_info.hbmColor.is_invalid() {
                    use windows::Win32::Graphics::Gdi::DeleteObject;

                    DeleteObject(icon_info.hbmColor);
                }
                if !icon_info.hbmMask.is_invalid() {
                    use windows::Win32::Graphics::Gdi::DeleteObject;

                    DeleteObject(icon_info.hbmMask);
                }
                panic!("Error");
            }

            let dib = dib.unwrap();

            // Select DIB into DC
            let old_bitmap = SelectObject(mem_dc, dib);

            // Draw the cursor onto our bitmap with transparency
            if DrawIconEx(
                mem_dc, 0, 0, hCursor, 0, // Use actual size
                0, // Use actual size
                0, None, DI_NORMAL,
            )
            .is_err()
            {
                // Clean up

                use windows::Win32::Graphics::Gdi::{DeleteDC, DeleteObject, ReleaseDC};
                SelectObject(mem_dc, old_bitmap);
                DeleteObject(dib);
                DeleteDC(mem_dc);
                ReleaseDC(HWND::default(), screen_dc);
                if !icon_info.hbmColor.is_invalid() {
                    DeleteObject(icon_info.hbmColor);
                }
                if !icon_info.hbmMask.is_invalid() {
                    DeleteObject(icon_info.hbmMask);
                }
                panic!("Error");
            }

            // Get image data
            let size = (width * height * 4) as usize;
            let mut image_data = vec![0u8; size];
            unsafe { std::ptr::copy_nonoverlapping(bits, image_data.as_mut_ptr() as *mut _, size) };

            // Calculate hotspot
            let mut hotspot_x = if icon_info.fIcon.as_bool() == false {
                icon_info.xHotspot as f64 / width as f64
            } else {
                0.5
            };

            let mut hotspot_y = if icon_info.fIcon.as_bool() == false {
                icon_info.yHotspot as f64 / height as f64
            } else {
                0.5
            };

            // Cleanup
            SelectObject(mem_dc, old_bitmap);
            DeleteObject(dib);
            DeleteDC(mem_dc);
            ReleaseDC(HWND::default(), screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                DeleteObject(icon_info.hbmMask);
            }

            // Process the image data to ensure proper alpha channel
            for i in (0..size).step_by(4) {
                // Windows DIB format is BGRA, we need to:
                // 1. Swap B and R channels
                let b = image_data[i];
                image_data[i] = image_data[i + 2]; // B <- R
                image_data[i + 2] = b; // R <- B

                // 2. Pre-multiply alpha if needed
                // This is already handled by DrawIconEx
            }

            // Convert to RGBA image
            let mut rgba_image =
                image::RgbaImage::from_raw(width as u32, height as u32, image_data).unwrap();

            // For text cursor (I-beam), enhance visibility by adding a shadow/outline
            // Check if this is likely a text cursor by examining dimensions and pixels
            let is_text_cursor = width <= 20 && height >= 20 && width <= height / 2;

            if is_text_cursor {
                // Add a subtle shadow/outline to make it visible on white backgrounds
                for y in 0..height as u32 {
                    for x in 0..width as u32 {
                        let pixel = rgba_image.get_pixel(x, y);
                        // If this is a solid pixel of the cursor
                        if pixel[3] > 200 {
                            // If alpha is high (visible pixel)
                            // Add shadow pixels around it
                            for dx in [-1, 0, 1].iter() {
                                for dy in [-1, 0, 1].iter() {
                                    let nx = x as i32 + dx;
                                    let ny = y as i32 + dy;

                                    // Skip if out of bounds or same pixel
                                    if nx < 0
                                        || ny < 0
                                        || nx >= width as i32
                                        || ny >= height as i32
                                        || (*dx == 0 && *dy == 0)
                                    {
                                        continue;
                                    }

                                    let nx = nx as u32;
                                    let ny = ny as u32;

                                    let shadow_pixel = rgba_image.get_pixel(nx, ny);
                                    // Only add shadow where there isn't already content
                                    if shadow_pixel[3] < 100 {
                                        rgba_image.put_pixel(nx, ny, image::Rgba([0, 0, 0, 100]));
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Find the bounds of non-transparent pixels to trim whitespace
            let mut min_x = width as u32;
            let mut min_y = height as u32;
            let mut max_x = 0u32;
            let mut max_y = 0u32;

            let mut has_content = false;

            for y in 0..height as u32 {
                for x in 0..width as u32 {
                    let pixel = rgba_image.get_pixel(x, y);
                    if pixel[3] > 0 {
                        // If pixel has any opacity
                        has_content = true;
                        min_x = min_x.min(x);
                        min_y = min_y.min(y);
                        max_x = max_x.max(x);
                        max_y = max_y.max(y);
                    }
                }
            }

            // Only trim if we found content and there's actually whitespace to trim
            if has_content
                && (min_x > 0 || min_y > 0 || max_x < width as u32 - 1 || max_y < height as u32 - 1)
            {
                // Add a small padding (2 pixels) around the content
                let padding = 2u32;
                let trim_min_x = min_x.saturating_sub(padding);
                let trim_min_y = min_y.saturating_sub(padding);
                let trim_max_x = (max_x + padding).min(width as u32 - 1);
                let trim_max_y = (max_y + padding).min(height as u32 - 1);

                let trim_width = trim_max_x - trim_min_x + 1;
                let trim_height = trim_max_y - trim_min_y + 1;

                // Create a new image with the trimmed dimensions
                let mut trimmed = image::RgbaImage::new(trim_width, trim_height);

                // Copy the content to the new image
                for y in 0..trim_height {
                    for x in 0..trim_width {
                        let src_x = trim_min_x + x;
                        let src_y = trim_min_y + y;
                        let pixel = rgba_image.get_pixel(src_x, src_y);
                        trimmed.put_pixel(x, y, *pixel);
                    }
                }

                // Adjust hotspot coordinates for the trimmed image
                hotspot_x = (hotspot_x * width as f64 - trim_min_x as f64) / trim_width as f64;
                hotspot_y = (hotspot_y * height as f64 - trim_min_y as f64) / trim_height as f64;

                trimmed
            } else {
                rgba_image
            }
            .to_vec()
        }
    }

    let cursors = vec![
        ("IDC_ARROW", load_cursor(IDC_ARROW)),
        ("IDC_IBEAM", load_cursor(IDC_IBEAM)),
        ("IDC_WAIT", load_cursor(IDC_WAIT)),
        ("IDC_CROSS", load_cursor(IDC_CROSS)),
        ("IDC_UPARROW", load_cursor(IDC_UPARROW)),
        ("IDC_SIZENWSE", load_cursor(IDC_SIZENWSE)),
        ("IDC_SIZENESW", load_cursor(IDC_SIZENESW)),
        ("IDC_SIZEWE", load_cursor(IDC_SIZEWE)),
        ("IDC_SIZENS", load_cursor(IDC_SIZENS)),
        ("IDC_SIZEALL", load_cursor(IDC_SIZEALL)),
        ("IDC_NO", load_cursor(IDC_NO)),
        ("IDC_HAND", load_cursor(IDC_HAND)),
        ("IDC_APPSTARTING", load_cursor(IDC_APPSTARTING)),
        ("IDC_HELP", load_cursor(IDC_HELP)),
        ("IDC_PIN", load_cursor(IDC_PIN)),
        ("IDC_PERSON", load_cursor(IDC_PERSON)),
        ("Pen", load_cursor(PCWSTR(32631u16 as _))),
        ("ScrolNS", load_cursor(PCWSTR(32652u16 as _))),
        ("ScrollWE", load_cursor(PCWSTR(32653u16 as _))),
        ("ScrollNSEW", load_cursor(PCWSTR(32654u16 as _))),
        ("ScrollN", load_cursor(PCWSTR(32655u16 as _))),
        ("ScrollS", load_cursor(PCWSTR(32656u16 as _))),
        ("ScrollW", load_cursor(PCWSTR(32657u16 as _))),
        ("ScrollE", load_cursor(PCWSTR(32658u16 as _))),
        ("ScrollNW", load_cursor(PCWSTR(32659u16 as _))),
        ("ScrollNE", load_cursor(PCWSTR(32660u16 as _))),
        ("ScrollSW", load_cursor(PCWSTR(32661u16 as _))),
        ("ScrollSE", load_cursor(PCWSTR(32662u16 as _))),
        ("ArrowCD", load_cursor(PCWSTR(32663u16 as _))),
    ];

    let mut cursor_lookup = HashMap::new();

    for (name, cursor) in cursors {
        let icon = get_icon(cursor);
        let hash = hex::encode(Sha256::digest(icon));
        println!("{name}: {hash}");
        cursor_lookup.insert(hash, name);
    }

    return;

    loop {
        let mut cursor_info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            flags: CURSORINFO_FLAGS(0),
            hCursor: Default::default(),
            ptScreenPos: POINT::default(),
        };

        if unsafe { GetCursorInfo(&mut cursor_info).is_err() } {
            panic!("Failed to get cursor info")
        }

        if cursor_info.hCursor.is_invalid() {
            panic!("Hcursor is invalid")
        }

        let trimmed_image = get_icon(cursor_info.hCursor);

        let hash = hex::encode(Sha256::digest(&trimmed_image));

        if !cursor_lookup.contains_key(&*hash) {
            panic!("Found unknown cursor hash {hash}");
        }

        println!("{hash} {}", cursor_lookup.get(&*hash).unwrap_or(&"Unknown"));
    }
}
