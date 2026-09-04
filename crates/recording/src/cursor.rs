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
    stop_wakeup: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub rx: Shared<oneshot::Receiver<CursorActorResponse>>,
}

pub struct IncrementalCaptureOutputs {
    pub cursor: Option<PathBuf>,
    pub keyboard: Option<PathBuf>,
}

pub struct CursorCaptureTarget {
    pub crop_bounds: CursorCropBounds,
    pub display: scap_targets::Display,
    #[cfg(target_os = "linux")]
    pub window: Option<scap_targets::WindowId>,
}

#[cfg(target_os = "linux")]
struct X11WindowCursor {
    connection: x11rb::rust_connection::RustConnection,
    window: u32,
}

#[cfg(target_os = "linux")]
impl X11WindowCursor {
    fn new(id: &scap_targets::WindowId) -> anyhow::Result<Self> {
        let (connection, _) = x11rb::connect(None)?;
        Ok(Self {
            connection,
            window: id.to_string().parse()?,
        })
    }

    fn position(&self) -> Option<(f64, f64)> {
        use x11rb::protocol::xproto::ConnectionExt as _;

        let geometry = self
            .connection
            .get_geometry(self.window)
            .ok()?
            .reply()
            .ok()?;
        let pointer = self
            .connection
            .query_pointer(self.window)
            .ok()?
            .reply()
            .ok()?;
        if !pointer.same_screen {
            return None;
        }
        normalized_window_cursor(
            pointer.win_x,
            pointer.win_y,
            geometry.width,
            geometry.height,
        )
    }
}

#[cfg(target_os = "linux")]
fn normalized_window_cursor(x: i16, y: i16, width: u16, height: u16) -> Option<(f64, f64)> {
    (width != 0 && height != 0).then(|| {
        (
            f64::from(x) / f64::from(width),
            f64::from(y) / f64::from(height),
        )
    })
}

#[cfg(all(test, target_os = "linux"))]
mod window_cursor_tests {
    use super::normalized_window_cursor;

    #[test]
    fn window_local_cursor_coordinates_follow_resized_content() {
        assert_eq!(
            normalized_window_cursor(300, 150, 600, 300),
            Some((0.5, 0.5))
        );
        assert_eq!(
            normalized_window_cursor(300, 150, 1200, 600),
            Some((0.25, 0.25))
        );
        assert_eq!(
            normalized_window_cursor(-60, 330, 600, 300),
            Some((-0.1, 1.1))
        );
    }

    #[test]
    fn empty_windows_cannot_produce_cursor_coordinates() {
        assert_eq!(normalized_window_cursor(1, 1, 0, 300), None);
        assert_eq!(normalized_window_cursor(1, 1, 600, 0), None);
    }
}

impl CursorActor {
    pub fn stop(&mut self) {
        drop(self.stop.take());
        if let Some(stop_wakeup) = self.stop_wakeup.take() {
            let _ = stop_wakeup.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

const CURSOR_FLUSH_INTERVAL_SECS: u64 = 5;

#[cfg(target_os = "linux")]
fn prefers_wayland_portal_cursor() -> bool {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return false;
    }

    std::env::var_os("DISPLAY").is_none()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|session| session.eq_ignore_ascii_case("wayland"))
}

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
    if let Err(e) = events.write_to_file(output_path) {
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
        Keycode::Space => ("Space", "Space"),
        Keycode::LControl => ("LControl", "LControl"),
        Keycode::RControl => ("RControl", "RControl"),
        Keycode::LShift => ("LShift", "LShift"),
        Keycode::RShift => ("RShift", "RShift"),
        Keycode::LAlt => ("LAlt", "LAlt"),
        Keycode::RAlt => ("RAlt", "RAlt"),
        Keycode::LMeta => ("Meta", "Meta"),
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
    target: CursorCaptureTarget,
    cursors_dir: PathBuf,
    prev_cursors: Cursors,
    next_cursor_id: u32,
    start_time: Timestamps,
    incremental_outputs: IncrementalCaptureOutputs,
) -> CursorActor {
    #[cfg(target_os = "linux")]
    if prefers_wayland_portal_cursor() {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(CursorActorResponse {
            cursors: prev_cursors,
            next_cursor_id,
            moves: vec![],
            clicks: vec![],
            keyboard_presses: vec![],
        });
        return CursorActor {
            stop: None,
            stop_wakeup: None,
            thread: None,
            rx: rx.shared(),
        };
    }

    use device_query::{DeviceQuery, DeviceState};
    use sha2::{Digest, Sha256};
    use std::time::Duration;
    use tracing::{error, info};

    let stop_token = CancellationToken::new();
    let (tx, rx) = oneshot::channel();
    let (stop_wakeup_tx, stop_wakeup_rx) = std::sync::mpsc::channel();

    let scope = crate::output_pipeline::PipelineBuildScope::current();
    if let Some(scope) = &scope {
        scope.register_token(stop_token.clone());
    }
    let completion = scope.map(|scope| scope.task_completion());
    let stop_token_child = stop_token.child_token();
    let thread = std::thread::spawn(move || {
        let _completion = completion;
        let crop_bounds = target.crop_bounds;
        let display = target.display;
        #[cfg(target_os = "linux")]
        let window_cursor = target.window.as_ref().and_then(|id| {
            X11WindowCursor::new(id)
                .inspect_err(|error| tracing::error!(%error, "X11 window cursor setup failed"))
                .ok()
        });
        #[cfg(target_os = "linux")]
        let mut last_window_position = None;
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
            if stop_token_child.is_cancelled() {
                break;
            }

            if stop_wakeup_rx
                .recv_timeout(Duration::from_millis(16))
                .is_ok()
            {
                break;
            }

            let elapsed = start_time.instant().elapsed().as_secs_f64() * 1000.0;
            let mouse_state = device_state.get_mouse();

            let position = cap_cursor_capture::RawCursorPosition::get();
            let position_changed = position != last_position;

            if position_changed {
                last_position = position;
            }
            #[cfg(target_os = "linux")]
            let window_position = window_cursor.as_ref().and_then(X11WindowCursor::position);
            #[cfg(target_os = "linux")]
            let position_changed = position_changed
                || (target.window.is_some() && window_position != last_window_position);
            #[cfg(target_os = "linux")]
            {
                last_window_position = window_position;
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
                    .map(|p| p.with_crop(crop_bounds))
                    .map(|p| (p.x(), p.y()));
                #[cfg(target_os = "linux")]
                let cropped_norm_pos = if target.window.is_some() {
                    window_position
                } else {
                    cropped_norm_pos
                };

                if let Some((x, y)) = cropped_norm_pos {
                    let mouse_event = CursorMoveEvent {
                        active_modifiers: vec![],
                        cursor_id: cursor_id.clone(),
                        time_ms: elapsed,
                        x,
                        y,
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

            if last_flush.elapsed() >= flush_interval {
                if let Some(ref path) = incremental_outputs.cursor {
                    flush_cursor_data(path, &response.moves, &response.clicks);
                }
                if let Some(ref kb_path) = incremental_outputs.keyboard {
                    flush_keyboard_data(kb_path, &response.keyboard_presses);
                }
                last_flush = Instant::now();
            }
        }

        info!("cursor recorder done");

        if let Some(ref path) = incremental_outputs.cursor {
            flush_cursor_data(path, &response.moves, &response.clicks);
        }

        if let Some(ref kb_path) = incremental_outputs.keyboard {
            flush_keyboard_data(kb_path, &response.keyboard_presses);
        }

        let _ = tx.send(response);
    });

    CursorActor {
        stop: Some(stop_token.drop_guard()),
        stop_wakeup: Some(stop_wakeup_tx),
        thread: Some(thread),
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
    use objc2::{ClassType, msg_send, rc::Retained};
    use objc2_app_kit::NSCursor;

    autoreleasepool(|| unsafe {
        #[allow(deprecated)]
        let cursor = NSCursor::currentSystemCursor().or_else(|| {
            let cursor: Option<Retained<NSCursor>> = msg_send![NSCursor::class(), currentCursor];
            cursor
        })?;

        macos_cursor_data(&cursor)
    })
}

#[cfg(target_os = "macos")]
fn macos_cursor_data(cursor: &objc2_app_kit::NSCursor) -> Option<CursorData> {
    use objc2::{msg_send, rc::Retained};
    use objc2_app_kit::NSImage;
    use sha2::{Digest, Sha256};

    unsafe {
        // AppKit can return nil for transient system cursors despite NSCursor.image's nonnull annotation.
        let image: Option<Retained<NSImage>> = msg_send![cursor, image];
        let image = image?;
        let size = image.size();
        let hotspot = cursor.hotSpot();
        if !size.width.is_finite()
            || !size.height.is_finite()
            || size.width <= 0.0
            || size.height <= 0.0
            || !hotspot.x.is_finite()
            || !hotspot.y.is_finite()
        {
            return None;
        }

        let image_data = image.TIFFRepresentation()?;
        let image = image_data.as_bytes_unchecked().to_vec();
        let shape =
            cap_cursor_info::CursorShapeMacOS::from_hash(&hex::encode(Sha256::digest(&image)));

        Some(CursorData {
            image,
            hotspot: XY::new(hotspot.x / size.width, hotspot.y / size.height),
            shape: shape.map(Into::into),
        })
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_cursor_tests {
    use super::macos_cursor_data;
    use objc2::{AllocAnyThread, class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSCursor, NSImage};

    #[test]
    fn cursor_without_image_is_skipped() {
        let cursor = unsafe { NSCursor::new() };
        assert!(macos_cursor_data(&cursor).is_none());
    }

    #[test]
    fn zero_sized_cursor_is_skipped() {
        let image = unsafe { NSImage::initWithSize(NSImage::alloc(), Default::default()) };
        let cursor = NSCursor::initWithImage_hotSpot(NSCursor::alloc(), &image, Default::default());
        assert!(macos_cursor_data(&cursor).is_none());
    }

    #[test]
    fn valid_cursor_keeps_image_and_hotspot() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(8, 8, image::Rgba([20, 40, 80, 255]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let png = png.into_inner();
        let data: Retained<AnyObject> = unsafe {
            msg_send![class!(NSData), dataWithBytes: png.as_ptr().cast::<std::ffi::c_void>(), length: png.len()]
        };
        let image: Retained<NSImage> = unsafe { msg_send![NSImage::alloc(), initWithData: &*data] };
        let cursor = NSCursor::initWithImage_hotSpot(NSCursor::alloc(), &image, Default::default());
        let image = unsafe { cursor.image() };
        let expected_image = unsafe {
            image
                .TIFFRepresentation()
                .unwrap()
                .as_bytes_unchecked()
                .to_vec()
        };
        let size = unsafe { image.size() };
        let hotspot = unsafe { cursor.hotSpot() };
        let actual = macos_cursor_data(&cursor).unwrap();

        assert_eq!(actual.image, expected_image);
        assert_eq!(actual.hotspot.x, hotspot.x / size.width);
        assert_eq!(actual.hotspot.y, hotspot.y / size.height);
    }
}

#[cfg(target_os = "linux")]
fn get_cursor_data() -> Option<CursorData> {
    get_x11_cursor_data().or_else(fallback_cursor_data)
}

#[cfg(target_os = "linux")]
fn get_x11_cursor_data() -> Option<CursorData> {
    use x11rb::protocol::xfixes::ConnectionExt as _;

    let (conn, _) = x11rb::connect(None).ok()?;
    conn.xfixes_query_version(5, 0).ok()?.reply().ok()?;
    let cursor = conn.xfixes_get_cursor_image().ok()?.reply().ok()?;

    let width = u32::from(cursor.width);
    let height = u32::from(cursor.height);
    if width == 0 || height == 0 {
        return None;
    }

    let pixel_count = usize::from(cursor.width).checked_mul(usize::from(cursor.height))?;
    if cursor.cursor_image.len() != pixel_count {
        return None;
    }

    let mut rgba = Vec::with_capacity(pixel_count.checked_mul(4)?);
    for pixel in cursor.cursor_image {
        rgba.push(((pixel >> 16) & 0xff) as u8);
        rgba.push(((pixel >> 8) & 0xff) as u8);
        rgba.push((pixel & 0xff) as u8);
        rgba.push(((pixel >> 24) & 0xff) as u8);
    }

    let image = image::RgbaImage::from_raw(width, height, rgba)?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .ok()?;

    Some(CursorData {
        image: bytes.into_inner(),
        hotspot: XY::new(
            f64::from(cursor.xhot) / f64::from(width),
            f64::from(cursor.yhot) / f64::from(height),
        ),
        shape: None,
    })
}

#[cfg(target_os = "linux")]
fn fallback_cursor_data() -> Option<CursorData> {
    use std::sync::OnceLock;

    static CURSOR_PNG: OnceLock<Vec<u8>> = OnceLock::new();

    let image = CURSOR_PNG.get_or_init(linux_cursor_png).clone();
    if image.is_empty() {
        return None;
    }

    Some(CursorData {
        image,
        hotspot: XY::new(0.0, 0.0),
        shape: None,
    })
}

#[cfg(target_os = "linux")]
fn linux_cursor_png() -> Vec<u8> {
    let mut image = image::RgbaImage::new(24, 24);
    for y in 0..18 {
        for x in 0..=y.min(10) {
            image.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
        }
    }
    for y in 2..15 {
        for x in 1..=y.min(8) {
            image.put_pixel(x, y, image::Rgba([255, 255, 255, 255]));
        }
    }

    let mut bytes = std::io::Cursor::new(Vec::new());
    if image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .is_err()
    {
        return Vec::new();
    }
    bytes.into_inner()
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
