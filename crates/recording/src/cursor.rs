use cap_cursor_capture::CursorCropBounds;
use cap_cursor_info::CursorShape;
use cap_project::{CursorClickEvent, CursorMoveEvent, XY};
use cap_timestamp::Timestamps;
use std::{collections::HashMap, path::PathBuf};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub struct Cursor {
    pub file_name: String,
    pub id: u32,
    pub hotspot: XY<f64>,
    pub shape: Option<CursorShape>,
}

pub type Cursors = HashMap<u64, Cursor>;

pub struct CursorActorResponse {
    // pub cursor_images: HashMap<String, Vec<u8>>,
    pub cursors: Cursors,
    pub next_cursor_id: u32,
    pub moves: Vec<CursorMoveEvent>,
    pub clicks: Vec<CursorClickEvent>,
}

pub struct CursorActor {
    stop: CancellationToken,
    rx: oneshot::Receiver<CursorActorResponse>,
}

impl CursorActor {
    pub async fn stop(self) -> CursorActorResponse {
        self.stop.cancel();
        self.rx.await.unwrap()
    }
}

#[tracing::instrument(name = "cursor", skip_all)]
pub fn spawn_cursor_recorder(
    crop_bounds: CursorCropBounds,
    display: scap_targets::Display,
    cursors_dir: PathBuf,
    prev_cursors: Cursors,
    next_cursor_id: u32,
    start_time: Timestamps,
) -> CursorActor {
    use cap_utils::spawn_actor;
    use device_query::{DeviceQuery, DeviceState};
    use futures::future::Either;
    use std::{
        hash::{DefaultHasher, Hash, Hasher},
        pin::pin,
        time::Duration,
    };
    use tracing::{error, info};

    let stop_token = CancellationToken::new();
    let (tx, rx) = oneshot::channel();

    let stop_token_child = stop_token.child_token();
    spawn_actor(async move {
        let device_state = DeviceState::new();
        let mut last_mouse_state = device_state.get_mouse();

        let mut last_position = cap_cursor_capture::RawCursorPosition::get();

        // Create cursors directory if it doesn't exist
        std::fs::create_dir_all(&cursors_dir).unwrap();

        let mut response = CursorActorResponse {
            cursors: prev_cursors,
            next_cursor_id,
            moves: vec![],
            clicks: vec![],
        };

        loop {
            let sleep = tokio::time::sleep(Duration::from_millis(10));
            let Either::Right(_) =
                futures::future::select(pin!(stop_token_child.cancelled()), pin!(sleep)).await
            else {
                break;
            };

            let elapsed = start_time.instant().elapsed().as_secs_f64() * 1000.0;
            let mouse_state = device_state.get_mouse();

            let cursor_data = get_cursor_data();
            let cursor_id = if let Some(data) = cursor_data {
                let mut hasher = DefaultHasher::default();
                data.image.hash(&mut hasher);
                let id = hasher.finish();

                // Check if we've seen this cursor data before
                if let Some(existing_id) = response.cursors.get(&id) {
                    existing_id.id.to_string()
                } else {
                    // New cursor data - save it
                    let cursor_id = response.next_cursor_id.to_string();
                    let file_name = format!("cursor_{cursor_id}.png");
                    let cursor_path = cursors_dir.join(&file_name);

                    if let Ok(image) = image::load_from_memory(&data.image) {
                        // Convert to RGBA
                        let rgba_image = image.into_rgba8();

                        if let Err(e) = rgba_image.save(&cursor_path) {
                            error!("Failed to save cursor image: {}", e);
                        } else {
                            info!("Saved cursor {cursor_id} image to: {:?}", file_name);
                            response.cursors.insert(
                                id,
                                Cursor {
                                    file_name,
                                    id: response.next_cursor_id,
                                    hotspot: data.hotspot,
                                    shape: data.shape,
                                },
                            );
                            response.next_cursor_id += 1;
                        }
                    }

                    cursor_id
                }
            } else {
                "default".to_string()
            };

            let position = cap_cursor_capture::RawCursorPosition::get();

            let position = (position != last_position).then(|| {
                last_position = position;

                let cropped_norm_pos = position
                    .relative_to_display(display)?
                    .normalize()?
                    .with_crop(crop_bounds);

                Some((cropped_norm_pos.x(), cropped_norm_pos.y()))
            });

            if let Some((x, y)) = position.flatten() {
                let mouse_event = CursorMoveEvent {
                    active_modifiers: vec![],
                    cursor_id: cursor_id.clone(),
                    time_ms: elapsed,
                    x,
                    y,
                };

                response.moves.push(mouse_event);
            }

            for (num, &pressed) in mouse_state.button_pressed.iter().enumerate() {
                let Some(prev) = last_mouse_state.button_pressed.get(num) else {
                    continue;
                };

                if pressed == *prev {
                    continue;
                }

                let mouse_event = CursorClickEvent {
                    down: pressed,
                    active_modifiers: vec![],
                    cursor_num: num as u8,
                    cursor_id: cursor_id.clone(),
                    time_ms: elapsed,
                };
                response.clicks.push(mouse_event);
            }

            last_mouse_state = mouse_state;
        }

        info!("cursor recorder done");

        let _ = tx.send(response);
    });

    CursorActor {
        stop: stop_token,
        rx,
    }
}

#[derive(Debug)]
struct CursorData {
    image: Vec<u8>,
    hotspot: XY<f64>,
    shape: Option<CursorShape>,
}

#[cfg(target_os = "macos")]
fn get_cursor_data() -> Option<CursorData> {
    use objc::rc::autoreleasepool;
    use objc2_app_kit::NSCursor;
    use sha2::{Digest, Sha256};

    autoreleasepool(|| unsafe {
        #[allow(deprecated)]
        let cursor = NSCursor::currentSystemCursor().unwrap_or(NSCursor::currentCursor());

        let image = cursor.image();
        let size = image.size();
        let hotspot = cursor.hotSpot();
        let image_data = image.TIFFRepresentation()?;

        let image = image_data.as_bytes_unchecked().to_vec();

        let shape =
            cap_cursor_info::CursorShapeMacOS::from_hash(&hex::encode(Sha256::digest(&image)));

        Some(CursorData {
            image,
            hotspot: XY::new(hotspot.x / size.width, hotspot.y / size.height),
            shape: shape.map(Into::into),
        })
    })
}

#[cfg(windows)]
fn get_cursor_data() -> Option<CursorData> {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
        DeleteDC, DeleteObject, GetDC, GetObjectA, ReleaseDC, SelectObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::{CURSORINFO, CURSORINFO_FLAGS, GetCursorInfo};
    use windows::Win32::UI::WindowsAndMessaging::{DI_NORMAL, DrawIconEx, GetIconInfo, ICONINFO};

    unsafe {
        // Get cursor info
        let mut cursor_info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            flags: CURSORINFO_FLAGS(0),
            hCursor: Default::default(),
            ptScreenPos: POINT::default(),
        };

        if GetCursorInfo(&mut cursor_info).is_err() {
            return None;
        }

        if cursor_info.hCursor.is_invalid() {
            return None;
        }

        // Get icon info
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(cursor_info.hCursor.into(), &mut icon_info).is_err() {
            return None;
        }

        // Get bitmap info for the cursor
        let mut bitmap = BITMAP::default();
        let bitmap_handle = if !icon_info.hbmColor.is_invalid() {
            icon_info.hbmColor
        } else {
            icon_info.hbmMask
        };

        if GetObjectA(
            bitmap_handle.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut _),
        ) == 0
        {
            // Clean up handles
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor.into());
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask.into());
            }
            return None;
        }

        // Create DCs
        let screen_dc = GetDC(Some(HWND::default()));
        let mem_dc = CreateCompatibleDC(Some(screen_dc));

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
        let dib = CreateDIBSection(
            Some(mem_dc),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        );

        if dib.is_err() {
            // Clean up
            let _ = DeleteDC(mem_dc);
            ReleaseDC(Some(HWND::default()), screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor.into());
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask.into());
            }
            return None;
        }

        let dib = dib.unwrap();

        // Select DIB into DC
        let old_bitmap = SelectObject(mem_dc, dib.into());

        // Draw the cursor onto our bitmap with transparency
        if DrawIconEx(
            mem_dc,
            0,
            0,
            cursor_info.hCursor.into(),
            0, // Use actual size
            0, // Use actual size
            0,
            None,
            DI_NORMAL,
        )
        .is_err()
        {
            // Clean up
            SelectObject(mem_dc, old_bitmap);
            let _ = DeleteObject(dib.into());
            let _ = DeleteDC(mem_dc);
            ReleaseDC(Some(HWND::default()), screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor.into());
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask.into());
            }
            return None;
        }

        // Get image data
        let size = (width * height * 4) as usize;
        let mut image_data = vec![0u8; size];
        std::ptr::copy_nonoverlapping(bits, image_data.as_mut_ptr() as *mut _, size);

        // Calculate hotspot
        let mut hotspot_x = if !icon_info.fIcon.as_bool() {
            icon_info.xHotspot as f64 / width as f64
        } else {
            0.5
        };

        let mut hotspot_y = if !icon_info.fIcon.as_bool() {
            icon_info.yHotspot as f64 / height as f64
        } else {
            0.5
        };

        // Cleanup
        SelectObject(mem_dc, old_bitmap);
        let _ = DeleteObject(dib.into());
        let _ = DeleteDC(mem_dc);
        ReleaseDC(Some(HWND::default()), screen_dc);
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(icon_info.hbmColor.into());
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(icon_info.hbmMask.into());
        }

        // Process the image data to ensure proper alpha channel
        for i in (0..size).step_by(4) {
            // Windows DIB format is BGRA, we need to:
            // 1. Swap B and R channels
            image_data.swap(i, i + 2); // R <- B

            // 2. Pre-multiply alpha if needed
            // This is already handled by DrawIconEx
        }

        // Convert to RGBA image
        let mut rgba_image = image::RgbaImage::from_raw(width as u32, height as u32, image_data)?;

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
                                    || nx >= width
                                    || ny >= height
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
        let trimmed_image = if has_content
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
        };

        // Convert to PNG format
        let mut png_data = Vec::new();
        trimmed_image
            .write_to(
                &mut std::io::Cursor::new(&mut png_data),
                image::ImageFormat::Png,
            )
            .ok()?;

        Some(CursorData {
            image: png_data,
            hotspot: XY::new(hotspot_x, hotspot_y),
            shape: CursorShape::try_from(&cursor_info.hCursor).ok(),
        })
    }
}
