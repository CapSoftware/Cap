use cap_cursor_capture::CursorCropBounds;
use cap_cursor_info::CursorShape;
use cap_project::{
    CursorClickEvent, CursorEvents, CursorMoveEvent, KeyPressEvent, KeyboardEvents, XY,
};
use cap_timestamp::Timestamps;
use futures::{FutureExt, future::Shared};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Instant,
};
use tokio::sync::oneshot;
use tokio_util::sync::{CancellationToken, DropGuard};

#[derive(Clone)]
pub struct Cursor {
    pub file_name: String,
    pub id: u32,
    pub hotspot: XY<f64>,
    pub shape: Option<CursorShape>,
}

pub type Cursors = HashMap<u64, Cursor>;

#[derive(Clone)]
pub struct CursorActorResponse {
    pub cursors: Cursors,
    pub next_cursor_id: u32,
    pub moves: Vec<CursorMoveEvent>,
    pub clicks: Vec<CursorClickEvent>,
    pub keyboard_presses: Vec<KeyPressEvent>,
}

pub struct CursorActor {
    stop: Option<DropGuard>,
    pub rx: Shared<oneshot::Receiver<CursorActorResponse>>,
}

impl CursorActor {
    pub fn stop(&mut self) {
        drop(self.stop.take());
    }
}

const CURSOR_FLUSH_INTERVAL_SECS: u64 = 5;

fn flush_cursor_data(output_path: &Path, moves: &[CursorMoveEvent], clicks: &[CursorClickEvent]) {
    let events = CursorEvents {
        clicks: clicks.to_vec(),
        moves: moves.to_vec(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&events)
        && let Err(e) = std::fs::write(output_path, json)
    {
        tracing::error!(
            "Failed to write cursor data to {}: {}",
            output_path.display(),
            e
        );
    }
}

fn flush_keyboard_data(output_path: &Path, presses: &[KeyPressEvent]) {
    let events = KeyboardEvents {
        presses: presses.to_vec(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&events)
        && let Err(e) = std::fs::write(output_path, json)
    {
        tracing::error!(
            "Failed to write keyboard data to {}: {}",
            output_path.display(),
            e
        );
    }
}

fn keycode_to_string(key: &device_query::Keycode) -> (String, String) {
    use device_query::Keycode;
    let (display, code) = match key {
        Keycode::Key0 => ("0", "Key0"),
        Keycode::Key1 => ("1", "Key1"),
        Keycode::Key2 => ("2", "Key2"),
        Keycode::Key3 => ("3", "Key3"),
        Keycode::Key4 => ("4", "Key4"),
        Keycode::Key5 => ("5", "Key5"),
        Keycode::Key6 => ("6", "Key6"),
        Keycode::Key7 => ("7", "Key7"),
        Keycode::Key8 => ("8", "Key8"),
        Keycode::Key9 => ("9", "Key9"),
        Keycode::A => ("a", "A"),
        Keycode::B => ("b", "B"),
        Keycode::C => ("c", "C"),
        Keycode::D => ("d", "D"),
        Keycode::E => ("e", "E"),
        Keycode::F => ("f", "F"),
        Keycode::G => ("g", "G"),
        Keycode::H => ("h", "H"),
        Keycode::I => ("i", "I"),
        Keycode::J => ("j", "J"),
        Keycode::K => ("k", "K"),
        Keycode::L => ("l", "L"),
        Keycode::M => ("m", "M"),
        Keycode::N => ("n", "N"),
        Keycode::O => ("o", "O"),
        Keycode::P => ("p", "P"),
        Keycode::Q => ("q", "Q"),
        Keycode::R => ("r", "R"),
        Keycode::S => ("s", "S"),
        Keycode::T => ("t", "T"),
        Keycode::U => ("u", "U"),
        Keycode::V => ("v", "V"),
        Keycode::W => ("w", "W"),
        Keycode::X => ("x", "X"),
        Keycode::Y => ("y", "Y"),
        Keycode::Z => ("z", "Z"),
        Keycode::F1 => ("F1", "F1"),
        Keycode::F2 => ("F2", "F2"),
        Keycode::F3 => ("F3", "F3"),
        Keycode::F4 => ("F4", "F4"),
        Keycode::F5 => ("F5", "F5"),
        Keycode::F6 => ("F6", "F6"),
        Keycode::F7 => ("F7", "F7"),
        Keycode::F8 => ("F8", "F8"),
        Keycode::F9 => ("F9", "F9"),
        Keycode::F10 => ("F10", "F10"),
        Keycode::F11 => ("F11", "F11"),
        Keycode::F12 => ("F12", "F12"),
        Keycode::Escape => ("Escape", "Escape"),
        Keycode::Space => (" ", "Space"),
        Keycode::LControl => ("LControl", "LControl"),
        Keycode::RControl => ("RControl", "RControl"),
        Keycode::LShift => ("LShift", "LShift"),
        Keycode::RShift => ("RShift", "RShift"),
        Keycode::LAlt => ("LAlt", "LAlt"),
        Keycode::RAlt => ("RAlt", "RAlt"),
        Keycode::Meta => ("Meta", "Meta"),
        Keycode::Enter => ("Enter", "Enter"),
        Keycode::Up => ("Up", "Up"),
        Keycode::Down => ("Down", "Down"),
        Keycode::Left => ("Left", "Left"),
        Keycode::Right => ("Right", "Right"),
        Keycode::Backspace => ("Backspace", "Backspace"),
        Keycode::CapsLock => ("CapsLock", "CapsLock"),
        Keycode::Tab => ("Tab", "Tab"),
        Keycode::Home => ("Home", "Home"),
        Keycode::End => ("End", "End"),
        Keycode::PageUp => ("PageUp", "PageUp"),
        Keycode::PageDown => ("PageDown", "PageDown"),
        Keycode::Insert => ("Insert", "Insert"),
        Keycode::Delete => ("Delete", "Delete"),
        Keycode::Numpad0 => ("0", "Numpad0"),
        Keycode::Numpad1 => ("1", "Numpad1"),
        Keycode::Numpad2 => ("2", "Numpad2"),
        Keycode::Numpad3 => ("3", "Numpad3"),
        Keycode::Numpad4 => ("4", "Numpad4"),
        Keycode::Numpad5 => ("5", "Numpad5"),
        Keycode::Numpad6 => ("6", "Numpad6"),
        Keycode::Numpad7 => ("7", "Numpad7"),
        Keycode::Numpad8 => ("8", "Numpad8"),
        Keycode::Numpad9 => ("9", "Numpad9"),
        Keycode::NumpadSubtract => ("-", "NumpadSubtract"),
        Keycode::NumpadAdd => ("+", "NumpadAdd"),
        Keycode::NumpadDivide => ("/", "NumpadDivide"),
        Keycode::NumpadMultiply => ("*", "NumpadMultiply"),
        Keycode::Grave => ("`", "Grave"),
        Keycode::Minus => ("-", "Minus"),
        Keycode::Equal => ("=", "Equal"),
        Keycode::LeftBracket => ("[", "LeftBracket"),
        Keycode::RightBracket => ("]", "RightBracket"),
        Keycode::BackSlash => ("\\", "BackSlash"),
        Keycode::Semicolon => (";", "Semicolon"),
        Keycode::Apostrophe => ("'", "Apostrophe"),
        Keycode::Comma => (",", "Comma"),
        Keycode::Dot => (".", "Dot"),
        Keycode::Slash => ("/", "Slash"),
        _ => {
            let s = format!("{key:?}");
            return (s.clone(), s);
        }
    };
    (display.to_string(), code.to_string())
}

#[tracing::instrument(name = "cursor", skip_all)]
pub fn spawn_cursor_recorder(
    crop_bounds: CursorCropBounds,
    display: scap_targets::Display,
    cursors_dir: PathBuf,
    prev_cursors: Cursors,
    next_cursor_id: u32,
    start_time: Timestamps,
    output_path: Option<PathBuf>,
    keyboard_output_path: Option<PathBuf>,
) -> CursorActor {
    use cap_utils::spawn_actor;
    use device_query::{DeviceQuery, DeviceState};
    use futures::future::Either;
    use sha2::{Digest, Sha256};
    use std::{pin::pin, time::Duration};
    use tracing::{error, info};

    let stop_token = CancellationToken::new();
    let (tx, rx) = oneshot::channel();

    let stop_token_child = stop_token.child_token();
    spawn_actor(async move {
        let device_state = DeviceState::new();
        let mut last_mouse_state = device_state.get_mouse();
        let mut last_keys: Vec<device_query::Keycode> = device_state.get_keys();

        let mut last_position = cap_cursor_capture::RawCursorPosition::get();

        std::fs::create_dir_all(&cursors_dir).unwrap();

        let mut response = CursorActorResponse {
            cursors: prev_cursors,
            next_cursor_id,
            moves: vec![],
            clicks: vec![],
            keyboard_presses: vec![],
        };

        let mut last_flush = Instant::now();
        let flush_interval = Duration::from_secs(CURSOR_FLUSH_INTERVAL_SECS);
        let mut last_cursor_id: Option<String> = None;

        loop {
            let sleep = tokio::time::sleep(Duration::from_millis(16));
            let Either::Right(_) =
                futures::future::select(pin!(stop_token_child.cancelled()), pin!(sleep)).await
            else {
                break;
            };

            let elapsed = start_time.instant().elapsed().as_secs_f64() * 1000.0;
            let mouse_state = device_state.get_mouse();

            let position = cap_cursor_capture::RawCursorPosition::get();
            let position_changed = position != last_position;

            if position_changed {
                last_position = position;
            }

            let cursor_id = if let Some(data) = get_cursor_data() {
                let hash_bytes = Sha256::digest(&data.image);
                let id = u64::from_le_bytes(
                    hash_bytes[..8]
                        .try_into()
                        .expect("sha256 produces at least 8 bytes"),
                );

                let cursor_id = if let Some(existing_id) = response.cursors.get(&id) {
                    existing_id.id.to_string()
                } else {
                    let cursor_id = response.next_cursor_id.to_string();
                    let file_name = format!("cursor_{cursor_id}.png");
                    let cursor_path = cursors_dir.join(&file_name);

                    if let Ok(image) = image::load_from_memory(&data.image) {
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
                };
                last_cursor_id = Some(cursor_id.clone());
                Some(cursor_id)
            } else {
                last_cursor_id.clone()
            };

            let Some(cursor_id) = cursor_id else {
                continue;
            };

            if position_changed {
                let cropped_norm_pos = position
                    .relative_to_display(display)
                    .and_then(|p| p.normalize())
                    .map(|p| p.with_crop(crop_bounds));

                if let Some(pos) = cropped_norm_pos {
                    let mouse_event = CursorMoveEvent {
                        active_modifiers: vec![],
                        cursor_id: cursor_id.clone(),
                        time_ms: elapsed,
                        x: pos.x(),
                        y: pos.y(),
                    };
                    response.moves.push(mouse_event);
                }
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

            let current_keys = device_state.get_keys();

            for key in &current_keys {
                if !last_keys.contains(key) {
                    let (display, code) = keycode_to_string(key);
                    response.keyboard_presses.push(KeyPressEvent {
                        key: display,
                        key_code: code,
                        time_ms: elapsed,
                        down: true,
                    });
                }
            }

            for key in &last_keys {
                if !current_keys.contains(key) {
                    let (display, code) = keycode_to_string(key);
                    response.keyboard_presses.push(KeyPressEvent {
                        key: display,
                        key_code: code,
                        time_ms: elapsed,
                        down: false,
                    });
                }
            }

            last_keys = current_keys;

            if let Some(ref path) = output_path
                && last_flush.elapsed() >= flush_interval
            {
                flush_cursor_data(path, &response.moves, &response.clicks);
                if let Some(ref kb_path) = keyboard_output_path {
                    flush_keyboard_data(kb_path, &response.keyboard_presses);
                }
                last_flush = Instant::now();
            }
        }

        info!("cursor recorder done");

        if let Some(ref path) = output_path {
            flush_cursor_data(path, &response.moves, &response.clicks);
        }

        if let Some(ref kb_path) = keyboard_output_path {
            flush_keyboard_data(kb_path, &response.keyboard_presses);
        }

        let _ = tx.send(response);
    });

    CursorActor {
        stop: Some(stop_token.drop_guard()),
        rx: rx.shared(),
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
