use crate::RecordingStartGate;
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
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
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

#[derive(Clone)]
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

struct IncrementalSnapshot {
    cursor: Option<(Vec<CursorMoveEvent>, Vec<CursorClickEvent>)>,
    keyboard: Option<Vec<KeyPressEvent>>,
}

impl IncrementalSnapshot {
    fn capture(outputs: &IncrementalCaptureOutputs, response: &CursorActorResponse) -> Self {
        Self {
            cursor: outputs
                .cursor
                .as_ref()
                .map(|_| (response.moves.clone(), response.clicks.clone())),
            keyboard: outputs
                .keyboard
                .as_ref()
                .map(|_| response.keyboard_presses.clone()),
        }
    }

    fn write(self, outputs: &IncrementalCaptureOutputs) {
        if let (Some(path), Some((moves, clicks))) = (&outputs.cursor, &self.cursor) {
            flush_cursor_data(path, moves, clicks);
        }
        if let (Some(path), Some(presses)) = (&outputs.keyboard, &self.keyboard) {
            flush_keyboard_data(path, presses);
        }
    }
}

enum WriterMessage {
    Image {
        path: PathBuf,
        image: image::RgbaImage,
    },
    Snapshot(IncrementalSnapshot),
}

/// Writes cursor images and the incremental cursor and keyboard files on a
/// separate thread so a slow or stalled output volume cannot pause input
/// sampling. At most one periodic snapshot waits while another is written; a
/// flush that finds one already waiting is skipped, since the next one carries
/// every event. Cursor images that fail to save are retried, and any still
/// missing at the end are reported so the recorder can drop them, matching the
/// old inline behaviour of only registering images that reached disk.
struct CursorFileWriter {
    tx: std::sync::mpsc::Sender<WriterMessage>,
    snapshot_queued: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<Vec<PathBuf>>,
}

const CURSOR_IMAGE_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

impl CursorFileWriter {
    fn spawn(outputs: IncrementalCaptureOutputs) -> std::io::Result<Self> {
        let (tx, rx) = std::sync::mpsc::channel::<WriterMessage>();
        let snapshot_queued = Arc::new(AtomicBool::new(false));
        let queued = snapshot_queued.clone();
        let thread = std::thread::Builder::new()
            .name("cursor-writer".to_string())
            .spawn(move || {
                let mut failed_images: Vec<(PathBuf, image::RgbaImage)> = Vec::new();
                loop {
                    let message = if failed_images.is_empty() {
                        rx.recv().ok()
                    } else {
                        match rx.recv_timeout(CURSOR_IMAGE_RETRY_INTERVAL) {
                            Ok(message) => Some(message),
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    };
                    let had_failures = !failed_images.is_empty();
                    match message {
                        Some(WriterMessage::Image { path, image }) => {
                            if !save_cursor_image(&path, &image) {
                                failed_images.push((path, image));
                            }
                        }
                        Some(WriterMessage::Snapshot(snapshot)) => {
                            queued.store(false, Ordering::Release);
                            snapshot.write(&outputs);
                        }
                        None if !had_failures => break,
                        None => {}
                    }
                    if had_failures {
                        failed_images.retain(|(path, image)| !save_cursor_image(path, image));
                    }
                }
                failed_images.retain(|(path, image)| !save_cursor_image(path, image));
                failed_images.into_iter().map(|(path, _)| path).collect()
            })?;
        Ok(Self {
            tx,
            snapshot_queued,
            thread,
        })
    }

    fn save_image(&self, path: PathBuf, image: image::RgbaImage) -> bool {
        match self.tx.send(WriterMessage::Image { path, image }) {
            Ok(()) => true,
            Err(std::sync::mpsc::SendError(WriterMessage::Image { path, image })) => {
                save_cursor_image(&path, &image)
            }
            Err(_) => false,
        }
    }

    fn flush(&self, snapshot: impl FnOnce() -> IncrementalSnapshot) {
        if !self.snapshot_queued.swap(true, Ordering::AcqRel) {
            let _ = self.tx.send(WriterMessage::Snapshot(snapshot()));
        }
    }

    fn finish(self, snapshot: Option<IncrementalSnapshot>) -> Vec<PathBuf> {
        if let Some(snapshot) = snapshot {
            let _ = self.tx.send(WriterMessage::Snapshot(snapshot));
        }
        drop(self.tx);
        self.thread.join().unwrap_or_else(|_| {
            tracing::error!("Cursor writer thread panicked");
            Vec::new()
        })
    }
}

fn save_cursor_image(path: &Path, image: &image::RgbaImage) -> bool {
    match image.save(path) {
        Ok(()) => {
            tracing::info!(path = %path.display(), "Saved cursor image");
            true
        }
        Err(e) => {
            tracing::error!("Failed to save cursor image: {}", e);
            false
        }
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

/// Time zero for cursor, click and key events: the start gate's arm point
/// when the pipeline was primed ahead of the recording, else the pipeline
/// epoch. `None` while a primed recording is still waiting for its cue.
fn input_epoch(start_gate: Option<&RecordingStartGate>, start_time: Timestamps) -> Option<Instant> {
    match start_gate {
        Some(gate) => gate
            .armed_instant()
            .map(|armed| armed.max(start_time.instant())),
        None => Some(start_time.instant()),
    }
}

#[tracing::instrument(name = "cursor", skip_all)]
pub fn spawn_cursor_recorder(
    target: CursorCaptureTarget,
    cursors_dir: PathBuf,
    prev_cursors: Cursors,
    next_cursor_id: u32,
    start_time: Timestamps,
    start_gate: Option<RecordingStartGate>,
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

        let mut last_position =
            cap_cursor_capture::RawCursorPosition::from_coords(last_mouse_state.coords);

        std::fs::create_dir_all(&cursors_dir).unwrap();

        let mut response = CursorActorResponse {
            cursors: prev_cursors,
            next_cursor_id,
            moves: vec![],
            clicks: vec![],
            keyboard_presses: vec![],
        };

        let has_incremental_outputs =
            incremental_outputs.cursor.is_some() || incremental_outputs.keyboard.is_some();
        let writer = CursorFileWriter::spawn(incremental_outputs.clone())
            .inspect_err(|e| error!("Failed to start cursor writer, writing inline: {e}"))
            .ok();
        let mut last_flush = Instant::now();
        let flush_interval = Duration::from_secs(CURSOR_FLUSH_INTERVAL_SECS);
        let mut last_cursor_id: Option<String> = None;
        let mut last_cursor_image = None;
        let mut awaiting_start = start_gate.is_some();

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

            let Some(epoch) = input_epoch(start_gate.as_ref(), start_time) else {
                last_mouse_state = device_state.get_mouse();
                last_position =
                    cap_cursor_capture::RawCursorPosition::from_coords(last_mouse_state.coords);
                last_keys = device_state.get_keys();
                continue;
            };
            let elapsed = epoch.elapsed().as_secs_f64() * 1000.0;
            let mouse_state = device_state.get_mouse();

            let position = cap_cursor_capture::RawCursorPosition::from_coords(mouse_state.coords);
            // The first sample after the gate opens is always recorded so the
            // cursor has a known position at the recording's time zero.
            let position_changed = position != last_position || std::mem::take(&mut awaiting_start);

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
                let cursor_id = cursor_id_for_image(
                    data,
                    &mut response,
                    &cursors_dir,
                    writer.as_ref(),
                    &mut last_cursor_image,
                );
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

            if has_incremental_outputs && last_flush.elapsed() >= flush_interval {
                let snapshot = || IncrementalSnapshot::capture(&incremental_outputs, &response);
                match &writer {
                    Some(writer) => writer.flush(snapshot),
                    None => snapshot().write(&incremental_outputs),
                }
                last_flush = Instant::now();
            }
        }

        info!("cursor recorder done");

        let snapshot = has_incremental_outputs
            .then(|| IncrementalSnapshot::capture(&incremental_outputs, &response));
        match writer {
            Some(writer) => {
                let unsaved = writer.finish(snapshot);
                response.cursors.retain(|_, cursor| {
                    !unsaved.iter().any(|path| path.ends_with(&cursor.file_name))
                });
            }
            None => {
                if let Some(snapshot) = snapshot {
                    snapshot.write(&incremental_outputs);
                }
            }
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

fn cursor_id_for_image(
    data: CursorData,
    response: &mut CursorActorResponse,
    cursors_dir: &Path,
    writer: Option<&CursorFileWriter>,
    last_cursor_image: &mut Option<(Vec<u8>, String)>,
) -> String {
    use sha2::{Digest, Sha256};

    // Hashing a large macOS cursor TIFF costs milliseconds, and the image
    // rarely changes between ticks.
    if let Some((image, cursor_id)) = last_cursor_image
        && *image == data.image
    {
        return cursor_id.clone();
    }

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

            let saved = match writer {
                Some(writer) => writer.save_image(cursor_path, rgba_image),
                None => save_cursor_image(&cursor_path, &rgba_image),
            };
            if saved {
                #[cfg(target_os = "macos")]
                let shape = cap_cursor_info::CursorShapeMacOS::from_hash(&hex::encode(hash_bytes))
                    .map(Into::into);
                #[cfg(not(target_os = "macos"))]
                let shape = data.shape;
                response.cursors.insert(
                    id,
                    Cursor {
                        file_name,
                        id: response.next_cursor_id,
                        hotspot: data.hotspot,
                        shape,
                    },
                );
                response.next_cursor_id += 1;
            }
        }

        cursor_id
    };

    *last_cursor_image = response
        .cursors
        .contains_key(&id)
        .then(|| (data.image, cursor_id.clone()));
    cursor_id
}

#[derive(Debug, Clone)]
struct CursorData {
    image: Vec<u8>,
    hotspot: XY<f64>,
    #[cfg(not(target_os = "macos"))]
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

        Some(CursorData {
            image,
            hotspot: XY::new(hotspot.x / size.width, hotspot.y / size.height),
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
    thread_local! {
        static X11_CURSOR: std::cell::RefCell<X11CursorSource> = std::cell::RefCell::default();
    }

    X11_CURSOR
        .with_borrow_mut(X11CursorSource::cursor_data)
        .or_else(fallback_cursor_data)
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct X11CursorSource {
    connection: Option<x11rb::rust_connection::RustConnection>,
    last_image: Option<X11CursorImage>,
}

#[cfg(target_os = "linux")]
struct X11CursorImage {
    width: u16,
    height: u16,
    pixels: Vec<u32>,
    png: Vec<u8>,
}

#[cfg(target_os = "linux")]
impl X11CursorSource {
    fn cursor_data(&mut self) -> Option<CursorData> {
        let cursor = self.cursor_image()?;

        let width = u32::from(cursor.width);
        let height = u32::from(cursor.height);
        if width == 0 || height == 0 {
            return None;
        }

        Some(CursorData {
            image: self.png(cursor.width, cursor.height, cursor.cursor_image)?,
            hotspot: XY::new(
                f64::from(cursor.xhot) / f64::from(width),
                f64::from(cursor.yhot) / f64::from(height),
            ),
            shape: None,
        })
    }

    fn cursor_image(&mut self) -> Option<x11rb::protocol::xfixes::GetCursorImageReply> {
        use x11rb::protocol::xfixes::ConnectionExt as _;

        if let Some(connection) = self.connection.take()
            && let Some(cursor) = connection
                .xfixes_get_cursor_image()
                .ok()
                .and_then(|cookie| cookie.reply().ok())
        {
            self.connection = Some(connection);
            return Some(cursor);
        }

        let (connection, _) = x11rb::connect(None).ok()?;
        connection.xfixes_query_version(5, 0).ok()?.reply().ok()?;
        let cursor = connection.xfixes_get_cursor_image().ok()?.reply().ok()?;
        self.connection = Some(connection);
        Some(cursor)
    }

    fn png(&mut self, width: u16, height: u16, pixels: Vec<u32>) -> Option<Vec<u8>> {
        if let Some(last) = &self.last_image
            && last.width == width
            && last.height == height
            && last.pixels == pixels
        {
            return Some(last.png.clone());
        }

        let png = x11_cursor_png(width, height, &pixels)?;
        self.last_image = Some(X11CursorImage {
            width,
            height,
            pixels,
            png: png.clone(),
        });
        Some(png)
    }
}

#[cfg(target_os = "linux")]
fn x11_cursor_png(width: u16, height: u16, pixels: &[u32]) -> Option<Vec<u8>> {
    let pixel_count = usize::from(width).checked_mul(usize::from(height))?;
    if pixels.len() != pixel_count {
        return None;
    }

    let mut rgba = Vec::with_capacity(pixel_count.checked_mul(4)?);
    for &pixel in pixels {
        rgba.push(((pixel >> 16) & 0xff) as u8);
        rgba.push(((pixel >> 8) & 0xff) as u8);
        rgba.push((pixel & 0xff) as u8);
        rgba.push(((pixel >> 24) & 0xff) as u8);
    }

    let image = image::RgbaImage::from_raw(u32::from(width), u32::from(height), rgba)?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .ok()?;
    Some(bytes.into_inner())
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

#[cfg(all(test, target_os = "linux"))]
mod x11_cursor_tests {
    use super::{X11CursorSource, x11_cursor_png};

    #[test]
    fn cached_cursor_pngs_match_a_fresh_encode() {
        let mut source = X11CursorSource::default();
        let arrow = vec![0xff00_0000; 6];
        let hand = vec![0x80ff_ffff; 6];

        for (width, height, pixels) in [
            (2, 3, &arrow),
            (2, 3, &arrow),
            (2, 3, &hand),
            (3, 2, &hand),
            (2, 3, &arrow),
        ] {
            assert_eq!(
                source.png(width, height, pixels.clone()),
                x11_cursor_png(width, height, pixels)
            );
        }
    }

    #[test]
    fn cursor_pixels_are_encoded_as_rgba() {
        let png = x11_cursor_png(1, 1, &[0x8011_2233]).unwrap();
        let image = image::load_from_memory(&png).unwrap().into_rgba8();
        assert_eq!(image.get_pixel(0, 0).0, [0x11, 0x22, 0x33, 0x80]);
    }

    #[test]
    fn cursor_with_mismatched_pixel_count_is_skipped() {
        let mut source = X11CursorSource::default();
        assert_eq!(source.png(2, 2, vec![0; 3]), None);
    }
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

        // Rendering, trimming and PNG-encoding the cursor every tick only to hash it is wasted
        // while the shape is unchanged. Keyed on the handle, so a cursor scheme change that keeps
        // the system cursor handles shows the old image until the shape changes; key on the
        // bitmap contents instead if that ever matters.
        thread_local! {
            static LAST_CURSOR: std::cell::RefCell<Option<(usize, CursorData)>> =
                const { std::cell::RefCell::new(None) };
        }
        let handle = cursor_info.hCursor.0 as usize;
        if let Some(cached) = LAST_CURSOR.with_borrow(|last| {
            last.as_ref()
                .filter(|(last_handle, _)| *last_handle == handle)
                .map(|(_, data)| data.clone())
        }) {
            return Some(cached);
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

        let data = CursorData {
            image: png_data,
            hotspot: XY::new(hotspot_x, hotspot_y),
            shape: CursorShape::try_from(&cursor_info.hCursor).ok(),
        };
        LAST_CURSOR.set(Some((handle, data.clone())));
        Some(data)
    }
}

#[cfg(test)]
mod input_epoch_tests {
    use super::*;

    #[test]
    fn primed_input_waits_for_the_gate_and_then_starts_at_the_arm_point() {
        let start_time = Timestamps::now();
        assert_eq!(input_epoch(None, start_time), Some(start_time.instant()));

        let gate = RecordingStartGate::new();
        assert_eq!(input_epoch(Some(&gate), start_time), None);

        let armed = Timestamps::now() + std::time::Duration::from_millis(250);
        gate.arm_at(armed);
        assert_eq!(input_epoch(Some(&gate), start_time), Some(armed.instant()));
    }

    #[test]
    fn an_arm_point_before_the_pipeline_epoch_is_clamped_to_it() {
        let gate = RecordingStartGate::new();
        gate.arm();
        let start_time = Timestamps::now() + std::time::Duration::from_millis(250);
        assert_eq!(
            input_epoch(Some(&gate), start_time),
            Some(start_time.instant())
        );
    }
}

#[cfg(test)]
mod incremental_writer_tests {
    use super::*;
    use std::time::Duration;

    fn response(events: usize) -> CursorActorResponse {
        CursorActorResponse {
            cursors: Cursors::default(),
            next_cursor_id: 1,
            moves: (0..events)
                .map(|i| CursorMoveEvent {
                    active_modifiers: vec![],
                    cursor_id: "0".to_string(),
                    time_ms: i as f64 * 16.0,
                    x: i as f64 / events as f64,
                    y: 0.5,
                })
                .collect(),
            clicks: (0..events / 10)
                .map(|i| CursorClickEvent {
                    active_modifiers: vec![],
                    cursor_num: 0,
                    cursor_id: "0".to_string(),
                    time_ms: i as f64 * 160.0,
                    down: i % 2 == 0,
                })
                .collect(),
            keyboard_presses: (0..events / 10)
                .map(|i| KeyPressEvent {
                    key: "a".to_string(),
                    key_code: "KeyA".to_string(),
                    time_ms: i as f64 * 160.0,
                    down: i % 2 == 0,
                })
                .collect(),
        }
    }

    fn outputs(dir: &Path, name: &str) -> IncrementalCaptureOutputs {
        IncrementalCaptureOutputs {
            cursor: Some(dir.join(format!("{name}-cursor.json"))),
            keyboard: Some(dir.join(format!("{name}-keyboard.bin"))),
        }
    }

    #[test]
    fn writer_thread_produces_the_same_files_as_inline_flushes() {
        let dir = tempfile::tempdir().unwrap();
        let full = response(500);

        let inline = outputs(dir.path(), "inline");
        IncrementalSnapshot::capture(&inline, &full).write(&inline);

        let threaded = outputs(dir.path(), "threaded");
        let writer = CursorFileWriter::spawn(threaded.clone()).unwrap();
        writer.flush(|| IncrementalSnapshot::capture(&threaded, &response(10)));
        writer.finish(Some(IncrementalSnapshot::capture(&threaded, &full)));

        for (a, b) in [
            (&inline.cursor, &threaded.cursor),
            (&inline.keyboard, &threaded.keyboard),
        ] {
            let (a, b) = (a.as_ref().unwrap(), b.as_ref().unwrap());
            assert_eq!(std::fs::read(a).unwrap(), std::fs::read(b).unwrap());
        }
    }

    #[cfg(unix)]
    #[test]
    fn flushes_do_not_wait_for_a_blocked_writer() {
        use std::ffi::CString;
        use std::io::Read;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("cursor.json");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        let outputs = IncrementalCaptureOutputs {
            cursor: Some(fifo.clone()),
            keyboard: Some(dir.path().join("keyboard.bin")),
        };

        // Opening a FIFO for writing blocks until a reader arrives, which
        // stands in for a stalled output volume.
        let writer = CursorFileWriter::spawn(outputs.clone()).unwrap();
        let started = Instant::now();
        for events in [10, 20, 30, 40] {
            writer.flush(|| IncrementalSnapshot::capture(&outputs, &response(events)));
        }
        assert!(writer.save_image(
            dir.path().join("cursor_0.png"),
            image::RgbaImage::from_pixel(8, 8, image::Rgba([20, 40, 80, 255])),
        ));
        assert!(started.elapsed() < Duration::from_millis(500));

        let mut drain = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let drainer = {
            let done = done.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while !done.load(Ordering::Acquire) {
                    if !matches!(drain.read(&mut buf), Ok(n) if n > 0) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
            })
        };

        let final_response = response(50);
        let unsaved = writer.finish(Some(IncrementalSnapshot::capture(
            &outputs,
            &final_response,
        )));
        done.store(true, Ordering::Release);
        drainer.join().unwrap();

        assert!(unsaved.is_empty());
        assert!(dir.path().join("cursor_0.png").exists());
        let expected = dir.path().join("expected-keyboard.bin");
        flush_keyboard_data(&expected, &final_response.keyboard_presses);
        assert_eq!(
            std::fs::read(dir.path().join("keyboard.bin")).unwrap(),
            std::fs::read(expected).unwrap()
        );
    }

    #[test]
    fn unsaved_cursor_images_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let writer = CursorFileWriter::spawn(IncrementalCaptureOutputs {
            cursor: None,
            keyboard: None,
        })
        .unwrap();
        let missing = dir.path().join("missing").join("cursor_0.png");
        assert!(writer.save_image(
            missing.clone(),
            image::RgbaImage::from_pixel(8, 8, image::Rgba([20, 40, 80, 255])),
        ));
        let saved = dir.path().join("cursor_1.png");
        assert!(writer.save_image(
            saved.clone(),
            image::RgbaImage::from_pixel(8, 8, image::Rgba([20, 40, 80, 255])),
        ));
        assert_eq!(writer.finish(None), vec![missing]);
        assert!(saved.exists());
    }

    #[test]
    fn cursor_images_are_retried_until_storage_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let writer = CursorFileWriter::spawn(IncrementalCaptureOutputs {
            cursor: None,
            keyboard: None,
        })
        .unwrap();
        let cursors_dir = dir.path().join("cursors");
        let path = cursors_dir.join("cursor_0.png");
        assert!(writer.save_image(
            path.clone(),
            image::RgbaImage::from_pixel(8, 8, image::Rgba([20, 40, 80, 255])),
        ));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!path.exists());
        std::fs::create_dir_all(&cursors_dir).unwrap();
        let deadline = Instant::now() + CURSOR_IMAGE_RETRY_INTERVAL * 3;
        while !path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(path.exists());
        assert!(writer.finish(None).is_empty());
    }
}

#[cfg(test)]
mod cursor_image_tests {
    use super::*;

    fn png(color: [u8; 4]) -> Vec<u8> {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(8, 8, image::Rgba(color))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        png.into_inner()
    }

    fn cursor_data(image: Vec<u8>) -> CursorData {
        CursorData {
            image,
            hotspot: XY::new(0.0, 0.0),
            #[cfg(not(target_os = "macos"))]
            shape: None,
        }
    }

    fn empty_response() -> CursorActorResponse {
        CursorActorResponse {
            cursors: Cursors::default(),
            next_cursor_id: 0,
            moves: vec![],
            clicks: vec![],
            keyboard_presses: vec![],
        }
    }

    #[test]
    fn an_unchanged_cursor_image_reuses_its_id_without_hashing() {
        let dir = tempfile::tempdir().unwrap();
        let mut response = empty_response();
        let mut last = None;
        let red = png([255, 0, 0, 255]);

        assert_eq!(
            cursor_id_for_image(
                cursor_data(red.clone()),
                &mut response,
                dir.path(),
                None,
                &mut last
            ),
            "0"
        );
        assert_eq!(response.cursors.len(), 1);

        // The hash path would register this image again; the fast path never looks.
        response.cursors.clear();
        assert_eq!(
            cursor_id_for_image(cursor_data(red), &mut response, dir.path(), None, &mut last),
            "0"
        );
        assert!(response.cursors.is_empty());
    }

    #[test]
    fn a_changed_cursor_image_gets_hashed_and_a_new_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut response = empty_response();
        let mut last = None;
        let red = png([255, 0, 0, 255]);
        let blue = png([0, 0, 255, 255]);

        for (image, expected) in [(red.clone(), "0"), (blue, "1"), (red, "0")] {
            assert_eq!(
                cursor_id_for_image(
                    cursor_data(image),
                    &mut response,
                    dir.path(),
                    None,
                    &mut last
                ),
                expected
            );
        }
        assert_eq!(response.cursors.len(), 2);
        assert!(dir.path().join("cursor_0.png").exists());
        assert!(dir.path().join("cursor_1.png").exists());
    }

    #[test]
    fn a_cursor_image_that_fails_to_decode_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let mut response = empty_response();
        let mut last = None;

        let id = cursor_id_for_image(
            cursor_data(b"not an image".to_vec()),
            &mut response,
            dir.path(),
            None,
            &mut last,
        );
        assert_eq!(id, "0");
        assert!(response.cursors.is_empty());
        assert!(last.is_none());
    }

    #[test]
    fn a_cursor_image_that_fails_to_save_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let mut response = empty_response();
        let mut last = None;
        let red = png([255, 0, 0, 255]);

        // A directory at the cursor's path makes the PNG write fail.
        let cursor_path = dir.path().join("cursor_0.png");
        std::fs::create_dir(&cursor_path).unwrap();
        cursor_id_for_image(
            cursor_data(red.clone()),
            &mut response,
            dir.path(),
            None,
            &mut last,
        );
        assert!(response.cursors.is_empty());
        assert!(last.is_none());

        std::fs::remove_dir(&cursor_path).unwrap();
        assert_eq!(
            cursor_id_for_image(cursor_data(red), &mut response, dir.path(), None, &mut last),
            "0"
        );
        assert_eq!(response.cursors.len(), 1);
        assert!(cursor_path.is_file());
    }
}
