use std::{
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant, SystemTime},
};

use cap_cursor_capture::RawCursorPosition;
use cap_displays::Display;
use cap_media::{platform::Bounds, sources::CropRatio};
use cap_project::{CursorClickEvent, CursorMoveEvent, XY};
use cap_utils::spawn_actor;
use device_query::{DeviceQuery, DeviceState};
use tokio::sync::oneshot;
use tracing::{debug, error, info};

pub struct Cursor {
    pub file_name: String,
    pub id: u32,
    pub hotspot: XY<f64>,
    pub shape: Option<cap_project::CursorShape>,
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
    stop_signal: Arc<AtomicBool>,
    rx: oneshot::Receiver<CursorActorResponse>,
}

impl CursorActor {
    pub async fn stop(self) -> CursorActorResponse {
        self.stop_signal
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.rx.await.unwrap()
    }
}

#[tracing::instrument(name = "cursor", skip_all)]
pub fn spawn_cursor_recorder(
    #[allow(unused)] screen_bounds: Bounds,
    #[cfg(target_os = "macos")] display: Display,
    #[cfg(target_os = "macos")] crop_ratio: CropRatio,
    cursors_dir: PathBuf,
    prev_cursors: Cursors,
    next_cursor_id: u32,
    start_time: SystemTime,
) -> CursorActor {
    let stop_signal = Arc::new(AtomicBool::new(false));
    let (tx, rx) = oneshot::channel();

    spawn_actor({
        let stop_signal = stop_signal.clone();
        async move {
            let device_state = DeviceState::new();
            let mut last_mouse_state = device_state.get_mouse();

            #[cfg(target_os = "macos")]
            let mut last_position = RawCursorPosition::get();

            // Create cursors directory if it doesn't exist
            std::fs::create_dir_all(&cursors_dir).unwrap();

            let mut response = CursorActorResponse {
                cursors: prev_cursors,
                next_cursor_id,
                moves: vec![],
                clicks: vec![],
            };

            while !stop_signal.load(std::sync::atomic::Ordering::Relaxed) {
                let Ok(elapsed) = start_time.elapsed() else {
                    continue;
                };
                let elapsed = elapsed.as_secs_f64() * 1000.0;
                let mouse_state = device_state.get_mouse();

                let cursor_data = get_cursor_image_data();
                let cursor_id = if let Some(data) = cursor_data {
                    debug!(
                        "Recording loop: Got cursor data with shape: {:?}",
                        data.shape
                    );

                    let mut hasher = DefaultHasher::default();
                    data.image.hash(&mut hasher);
                    let id = hasher.finish();

                    // Check if we've seen this cursor data before
                    if let Some(existing_id) = response.cursors.get(&id) {
                        debug!(
                            "Recording loop: Using existing cursor {} with shape: {:?}",
                            existing_id.id, existing_id.shape
                        );
                        existing_id.id.to_string()
                    } else {
                        // New cursor data - save it
                        let cursor_id = response.next_cursor_id.to_string();
                        let file_name = format!("cursor_{}.png", cursor_id);
                        let cursor_path = cursors_dir.join(&file_name);

                        if let Ok(image) = image::load_from_memory(&data.image) {
                            // Convert to RGBA
                            let rgba_image = image.into_rgba8();

                            if let Err(e) = rgba_image.save(&cursor_path) {
                                error!("Failed to save cursor image: {}", e);
                            } else {
                                info!(
                                    "Recording loop: Saved NEW cursor {} with shape {:?} to: {:?}",
                                    cursor_id, data.shape, file_name
                                );
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
                    debug!("Recording loop: No cursor data available, using default");
                    "default".to_string()
                };

                // TODO: use this on windows too
                #[cfg(target_os = "macos")]
                let position = {
                    let position = RawCursorPosition::get();

                    if position != last_position {
                        last_position = position;

                        let cropped_position = position
                            .relative_to_display(display)
                            .normalize()
                            .with_crop(crop_ratio.position, crop_ratio.size);

                        Some((cropped_position.x() as f64, cropped_position.y() as f64))
                    } else {
                        None
                    }
                };

                #[cfg(windows)]
                let position = if mouse_state.coords != last_mouse_state.coords {
                    let (mouse_x, mouse_y) = {
                        (
                            mouse_state.coords.0 - screen_bounds.x as i32,
                            mouse_state.coords.1 - screen_bounds.y as i32,
                        )
                    };

                    // Calculate normalized coordinates (0.0 to 1.0) within the screen bounds
                    // Check if screen_bounds dimensions are valid to avoid division by zero
                    let x = if screen_bounds.width > 0.0 {
                        mouse_x as f64 / screen_bounds.width
                    } else {
                        0.5 // Fallback if width is invalid
                    };

                    let y = if screen_bounds.height > 0.0 {
                        mouse_y as f64 / screen_bounds.height
                    } else {
                        0.5 // Fallback if height is invalid
                    };

                    // Clamp values to ensure they're within valid range
                    let x = if x.is_nan() || x.is_infinite() {
                        debug!("X coordinate is invalid: {}", x);
                        0.5
                    } else {
                        x
                    };

                    let y = if y.is_nan() || y.is_infinite() {
                        debug!("Y coordinate is invalid: {}", y);
                        0.5
                    } else {
                        y
                    };

                    Some((x, y))
                } else {
                    None
                };

                if let Some((x, y)) = position {
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
                tokio::time::sleep(Duration::from_millis(10)).await;
            }

            tx.send(response).ok();
        }
    });

    CursorActor { rx, stop_signal }
}

#[derive(Debug)]
struct CursorData {
    image: Vec<u8>,
    hotspot: XY<f64>,
    shape: Option<cap_project::CursorShape>,
}

#[cfg(target_os = "macos")]
fn get_cursor_shape() -> cap_project::CursorShape {
    use cocoa::base::{id, nil};
    use objc::*;

    unsafe {
        let nscursor_class = match objc::runtime::Class::get("NSCursor") {
            Some(cls) => cls,
            None => {
                debug!("Failed to get NSCursor class");
                return cap_project::CursorShape::Unknown;
            }
        };

        // Use currentCursor instead of currentSystemCursor for more accurate detection
        let current_cursor: id = msg_send![nscursor_class, currentCursor];
        if current_cursor == nil {
            debug!("Current cursor is nil");
            return cap_project::CursorShape::Unknown;
        }

        debug!("Current cursor pointer: {:p}", current_cursor);

        // Get the cursor image for analysis
        let cursor_image: id = msg_send![current_cursor, image];
        if cursor_image == nil {
            debug!("Cursor image is nil, defaulting to arrow");
            return cap_project::CursorShape::Arrow;
        }

        let cursor_size: cocoa::foundation::NSSize = msg_send![cursor_image, size];
        let cursor_hotspot: cocoa::foundation::NSPoint = msg_send![current_cursor, hotSpot];

        debug!(
            "Cursor size: {}x{}, hotspot: ({}, {})",
            cursor_size.width, cursor_size.height, cursor_hotspot.x, cursor_hotspot.y
        );

        // Try isEqual comparisons first as a fast path, but don't rely on them exclusively
        let arrow_cursor: id = msg_send![nscursor_class, arrowCursor];
        let ibeam_cursor: id = msg_send![nscursor_class, IBeamCursor];
        let crosshair_cursor: id = msg_send![nscursor_class, crosshairCursor];
        let closed_hand_cursor: id = msg_send![nscursor_class, closedHandCursor];
        let open_hand_cursor: id = msg_send![nscursor_class, openHandCursor];
        let pointing_hand_cursor: id = msg_send![nscursor_class, pointingHandCursor];

        // Quick isEqual checks (but don't rely on them exclusively)
        let is_equal_arrow: bool = msg_send![current_cursor, isEqual: arrow_cursor];
        if is_equal_arrow {
            debug!("Detected arrow cursor via isEqual");
            return cap_project::CursorShape::Arrow;
        }

        let is_equal_ibeam: bool = msg_send![current_cursor, isEqual: ibeam_cursor];
        if is_equal_ibeam {
            debug!("Detected I-beam cursor via isEqual");
            return cap_project::CursorShape::IBeam;
        }

        let is_equal_crosshair: bool = msg_send![current_cursor, isEqual: crosshair_cursor];
        if is_equal_crosshair {
            debug!("Detected crosshair cursor via isEqual");
            return cap_project::CursorShape::Crosshair;
        }

        let is_equal_closed_hand: bool = msg_send![current_cursor, isEqual: closed_hand_cursor];
        if is_equal_closed_hand {
            debug!("Detected closed hand cursor via isEqual");
            return cap_project::CursorShape::ClosedHand;
        }

        let is_equal_open_hand: bool = msg_send![current_cursor, isEqual: open_hand_cursor];
        if is_equal_open_hand {
            debug!("Detected open hand cursor via isEqual");
            return cap_project::CursorShape::OpenHand;
        }

        let is_equal_pointing_hand: bool = msg_send![current_cursor, isEqual: pointing_hand_cursor];
        if is_equal_pointing_hand {
            debug!("Detected pointing hand cursor via isEqual");
            return cap_project::CursorShape::PointingHand;
        }

        // Since isEqual comparisons are unreliable, use enhanced heuristics based on cursor properties

        // Check for hidden cursor
        if cursor_size.width <= 1.0 || cursor_size.height <= 1.0 {
            debug!("Cursor appears to be hidden based on size");
            return cap_project::CursorShape::Hidden;
        }

        // Analyze cursor dimensions and hotspot for better detection
        let width = cursor_size.width;
        let height = cursor_size.height;
        let aspect_ratio = width / height;
        let hotspot_x_ratio = cursor_hotspot.x / width;
        let hotspot_y_ratio = cursor_hotspot.y / height;

        debug!(
            "Cursor analysis - aspect_ratio: {:.2}, hotspot_ratios: ({:.2}, {:.2})",
            aspect_ratio, hotspot_x_ratio, hotspot_y_ratio
        );

        // I-beam cursor: tall and narrow with centered hotspot
        if width <= 20.0 && height >= 20.0 && aspect_ratio <= 0.5 {
            debug!("Detected I-beam cursor based on dimensions");
            return cap_project::CursorShape::IBeam;
        }

        // Crosshair: typically square with centered hotspot
        if (width - height).abs() <= 4.0
            && width >= 15.0
            && width <= 40.0
            && hotspot_x_ratio >= 0.4
            && hotspot_x_ratio <= 0.6
            && hotspot_y_ratio >= 0.4
            && hotspot_y_ratio <= 0.6
        {
            debug!("Detected crosshair cursor based on dimensions and hotspot");
            return cap_project::CursorShape::Crosshair;
        }

        // Hand cursors: typically have hotspot in the finger area
        if width >= 20.0 && width <= 40.0 && height >= 20.0 && height <= 40.0 {
            // Pointing hand: hotspot usually in the finger tip area (top-left-ish)
            if hotspot_x_ratio <= 0.5 && hotspot_y_ratio <= 0.4 {
                debug!("Detected pointing hand cursor based on hotspot position");
                return cap_project::CursorShape::PointingHand;
            }
            // Open/closed hand: hotspot usually more centered
            else if hotspot_x_ratio >= 0.3
                && hotspot_x_ratio <= 0.7
                && hotspot_y_ratio >= 0.3
                && hotspot_y_ratio <= 0.7
            {
                debug!("Detected hand cursor (open/closed) based on hotspot position");
                return cap_project::CursorShape::OpenHand; // Default to open hand
            }
        }

        // Resize cursors: often have distinctive aspect ratios and sizes
        if width >= 15.0 && height >= 15.0 {
            // Horizontal resize (left-right): wider than tall
            if aspect_ratio >= 1.5 && height <= 25.0 {
                debug!("Detected horizontal resize cursor based on aspect ratio");
                return cap_project::CursorShape::ResizeLeftRight;
            }
            // Vertical resize (up-down): taller than wide
            else if aspect_ratio <= 0.67 && width <= 25.0 {
                debug!("Detected vertical resize cursor based on aspect ratio");
                return cap_project::CursorShape::ResizeUpDown;
            }
        }

        // Wait/spinning cursor: often circular or square with larger size
        if width >= 30.0 && height >= 30.0 && (width - height).abs() <= 8.0 {
            debug!("Detected wait cursor based on large square dimensions");
            return cap_project::CursorShape::Wait;
        }

        // Not allowed cursor: often circular with centered hotspot
        if width >= 20.0
            && width <= 35.0
            && (width - height).abs() <= 5.0
            && hotspot_x_ratio >= 0.4
            && hotspot_x_ratio <= 0.6
            && hotspot_y_ratio >= 0.4
            && hotspot_y_ratio <= 0.6
        {
            debug!("Detected not-allowed cursor based on circular dimensions");
            return cap_project::CursorShape::NotAllowed;
        }

        // Arrow cursor: typically has hotspot at top-left corner
        if hotspot_x_ratio <= 0.2 && hotspot_y_ratio <= 0.2 {
            debug!("Detected arrow cursor based on top-left hotspot");
            return cap_project::CursorShape::Arrow;
        }

        // Default fallback for unknown cursors
        debug!("Could not determine cursor type, defaulting to arrow. Size: {}x{}, hotspot: ({:.2}, {:.2})", 
               width, height, hotspot_x_ratio, hotspot_y_ratio);
        cap_project::CursorShape::Arrow
    }
}

#[cfg(target_os = "macos")]
fn get_cursor_image_data() -> Option<CursorData> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSPoint, NSSize, NSUInteger};
    use objc::rc::autoreleasepool;
    use objc::runtime::Class;
    use objc::*;

    autoreleasepool(|| {
        let nscursor_class = match Class::get("NSCursor") {
            Some(cls) => cls,
            None => {
                debug!("Failed to get NSCursor class in get_cursor_image_data");
                return None;
            }
        };

        unsafe {
            // Get cursor shape first
            let cursor_shape = get_cursor_shape();
            debug!(
                "get_cursor_image_data: Detected cursor shape: {:?}",
                cursor_shape
            );

            // Use currentCursor (same as get_cursor_shape) instead of currentSystemCursor
            let current_cursor: id = msg_send![nscursor_class, currentCursor];
            if current_cursor == nil {
                debug!("get_cursor_image_data: Current cursor is nil");
                return None;
            }

            // Get the image of the cursor
            let cursor_image: id = msg_send![current_cursor, image];
            if cursor_image == nil {
                debug!("get_cursor_image_data: Cursor image is nil");
                return None;
            }

            let cursor_size: NSSize = msg_send![cursor_image, size];
            let cursor_hotspot: NSPoint = msg_send![current_cursor, hotSpot];

            debug!(
                "get_cursor_image_data: Cursor size: {}x{}, hotspot: ({}, {})",
                cursor_size.width, cursor_size.height, cursor_hotspot.x, cursor_hotspot.y
            );

            // Get the TIFF representation of the image
            let image_data: id = msg_send![cursor_image, TIFFRepresentation];
            if image_data == nil {
                debug!("get_cursor_image_data: Failed to get TIFF representation");
                return None;
            }

            // Get the length of the data
            let length: NSUInteger = msg_send![image_data, length];

            // Get the bytes of the data
            let bytes: *const u8 = msg_send![image_data, bytes];

            // Copy the data into a Vec<u8>
            let slice = std::slice::from_raw_parts(bytes, length as usize);
            let data = slice.to_vec();

            let cursor_data = CursorData {
                image: data,
                hotspot: XY::new(
                    cursor_hotspot.x / cursor_size.width,
                    cursor_hotspot.y / cursor_size.height,
                ),
                shape: Some(cursor_shape),
            };
            debug!("get_cursor_image_data: Created cursor data with shape: {:?}, hotspot: ({:.3}, {:.3})", 
                   cursor_data.shape, cursor_data.hotspot.x, cursor_data.hotspot.y);
            Some(cursor_data)
        }
    })
}

#[cfg(windows)]
fn get_cursor_image_data() -> Option<CursorData> {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectA, ReleaseDC,
        SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetIconInfo, DI_NORMAL, ICONINFO};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, CURSORINFO, CURSORINFO_FLAGS};

    unsafe {
        // Get cursor shape first
        let default_cursors = cap_media::platform::win::DefaultCursors::default();
        let cursor_shape = cap_media::platform::win::get_cursor_shape(&default_cursors);

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
        if GetIconInfo(cursor_info.hCursor, &mut icon_info).is_err() {
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
            bitmap_handle,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut _),
        ) == 0
        {
            // Clean up handles
            if !icon_info.hbmColor.is_invalid() {
                DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        // Create DCs
        let screen_dc = GetDC(HWND::default());
        let mem_dc = CreateCompatibleDC(screen_dc);

        if mem_dc.is_invalid() {
            ReleaseDC(HWND::default(), screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        let width = bitmap.bmWidth;
        let height = bitmap.bmHeight;

        if width <= 0 || height <= 0 || width > 256 || height > 256 {
            DeleteDC(mem_dc);
            ReleaseDC(HWND::default(), screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        // Prepare DIB
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // Top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [std::mem::zeroed(); 1],
        };

        let mut dib_bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut dib_bits, None, 0);

        if dib.is_invalid() || dib_bits.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(HWND::default(), screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        let old_bitmap = SelectObject(mem_dc, dib);

        // Draw cursor
        let draw_result = DrawIconEx(
            mem_dc,
            0,
            0,
            cursor_info.hCursor,
            width,
            height,
            0,
            None,
            DI_NORMAL,
        );

        SelectObject(mem_dc, old_bitmap);

        if !draw_result.as_bool() {
            DeleteObject(dib);
            DeleteDC(mem_dc);
            ReleaseDC(HWND::default(), screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        // Copy image data
        let size = (width * height * 4) as usize;
        let mut image_data = vec![0u8; size];
        std::ptr::copy_nonoverlapping(dib_bits as *const u8, image_data.as_mut_ptr(), size);

        // Clean up
        DeleteObject(dib);
        DeleteDC(mem_dc);
        ReleaseDC(HWND::default(), screen_dc);
        if !icon_info.hbmColor.is_invalid() {
            DeleteObject(icon_info.hbmColor);
        }
        if !icon_info.hbmMask.is_invalid() {
            DeleteObject(icon_info.hbmMask);
        }

        // Calculate hotspot relative to cursor size
        let hotspot_x = icon_info.xHotspot as f64 / width as f64;
        let hotspot_y = icon_info.yHotspot as f64 / height as f64;

        // BGRA to RGBA conversion and premultiply alpha
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
        let mut rgba_image = image::RgbaImage::from_raw(width as u32, height as u32, image_data)?;

        // For text cursor (I-beam), enhance visibility by adding a shadow/outline
        // Check if this is likely a text cursor by examining dimensions and pixels
        let is_text_cursor = width <= 20 && height >= 20 && width <= height / 2;

        if is_text_cursor {
            // Add a subtle shadow/outline to make it visible on white backgrounds
            let mut enhanced_image = image::RgbaImage::new(width as u32, height as u32);

            for y in 0..height as u32 {
                for x in 0..width as u32 {
                    let pixel = rgba_image.get_pixel(x, y);
                    enhanced_image.put_pixel(x, y, *pixel);

                    // If this pixel has alpha > 0, add shadow around it
                    if pixel[3] > 0 {
                        // Add shadow pixels in a 1-pixel radius
                        for dy in -1..=1 {
                            for dx in -1..=1 {
                                if dx == 0 && dy == 0 {
                                    continue;
                                }
                                let nx = (x as i32 + dx) as u32;
                                let ny = (y as i32 + dy) as u32;
                                if nx < width as u32 && ny < height as u32 {
                                    let existing = enhanced_image.get_pixel(nx, ny);
                                    if existing[3] == 0 {
                                        // Add a semi-transparent black shadow
                                        enhanced_image.put_pixel(
                                            nx,
                                            ny,
                                            image::Rgba([0, 0, 0, 128]),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            rgba_image = enhanced_image;
        }

        let mut png_data = Vec::new();
        if rgba_image
            .write_to(
                &mut std::io::Cursor::new(&mut png_data),
                image::ImageFormat::Png,
            )
            .is_err()
        {
            return None;
        }

        Some(CursorData {
            image: png_data,
            hotspot: XY::new(hotspot_x, hotspot_y),
            shape: Some(cursor_shape),
        })
    }
}
