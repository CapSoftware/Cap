//! Browser and Chrome-extension recordings store pointer and key input as
//! NDJSON. The web export worker and the in-browser renderer both turn it into
//! native cursor/keyboard events here, so preview and export see the same data.

use std::{collections::BTreeSet, fmt, io::BufRead};

use serde::Deserialize;

use crate::{
    CursorClickEvent, CursorEvents, CursorMoveEvent, KeyPressEvent, KeyboardEvents, Platform, XY,
};

pub const MAX_WEB_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WEB_INPUT_EVENTS: usize = 500_000;

#[derive(Debug)]
pub struct WebInputError(String);

impl WebInputError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for WebInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WebInputError {}

impl From<std::io::Error> for WebInputError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for WebInputError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WebInputHeader {
    version: u8,
    platform: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebInputEvent {
    kind: String,
    time_ms: f64,
    x: Option<f64>,
    y: Option<f64>,
    cursor: Option<String>,
    button: Option<u8>,
    key: Option<String>,
    code: Option<String>,
    modifiers: Vec<String>,
}

pub struct WebInputData {
    pub platform: Platform,
    pub cursor: CursorEvents,
    pub keyboard: KeyboardEvents,
    /// Cursor styles used, each recorded under the cursor id `web-{style}`.
    pub styles: BTreeSet<&'static str>,
}

pub fn web_cursor_style(cursor: &str) -> Result<&'static str, WebInputError> {
    match cursor {
        "auto" | "default" => Ok("default"),
        "pointer" => Ok("pointer"),
        "text" => Ok("text"),
        "crosshair" => Ok("crosshair"),
        "grab" => Ok("grab"),
        "grabbing" => Ok("grabbing"),
        "not-allowed" => Ok("not-allowed"),
        "ew-resize" => Ok("ew-resize"),
        "ns-resize" => Ok("ns-resize"),
        _ => Err(WebInputError::new("Unsupported web cursor shape")),
    }
}

pub fn web_cursor_id(style: &str) -> String {
    format!("web-{style}")
}

/// Stand-in cursor image, native cursor shape and hotspot for a web style.
pub fn web_cursor_asset(
    platform: &Platform,
    style: &str,
) -> Result<(&'static [u8], &'static str, XY<f64>), WebInputError> {
    let asset = match platform {
        Platform::Windows => match style {
            "default" => (
                include_bytes!("../assets/web-cursors/windows-default.png").as_slice(),
                "Windows|Arrow",
                XY::new(0.288, 0.189),
            ),
            "pointer" | "grab" | "grabbing" => (
                include_bytes!("../assets/web-cursors/windows-pointer.png").as_slice(),
                "Windows|Hand",
                XY::new(0.441, 0.143),
            ),
            "text" => (
                include_bytes!("../assets/web-cursors/windows-text.png").as_slice(),
                "Windows|IBeam",
                XY::new(0.490, 0.471),
            ),
            "crosshair" => (
                include_bytes!("../assets/web-cursors/windows-crosshair.png").as_slice(),
                "Windows|Cross",
                XY::new(0.5, 0.5),
            ),
            "not-allowed" => (
                include_bytes!("../assets/web-cursors/windows-not-allowed.png").as_slice(),
                "Windows|No",
                XY::new(0.5, 0.5),
            ),
            "ew-resize" => (
                include_bytes!("../assets/web-cursors/windows-ew-resize.png").as_slice(),
                "Windows|SizeWE",
                XY::new(0.5, 0.5),
            ),
            "ns-resize" => (
                include_bytes!("../assets/web-cursors/windows-ns-resize.png").as_slice(),
                "Windows|SizeNS",
                XY::new(0.5, 0.5),
            ),
            _ => return Err(WebInputError::new("Unsupported Windows cursor style")),
        },
        Platform::MacOS | Platform::Linux => match style {
            "default" => (
                include_bytes!("../assets/web-cursors/mac-default.png").as_slice(),
                "MacOS|Arrow",
                XY::new(0.302, 0.226),
            ),
            "pointer" => (
                include_bytes!("../assets/web-cursors/mac-pointer.png").as_slice(),
                "MacOS|PointingHand",
                XY::new(0.342, 0.172),
            ),
            "text" => (
                include_bytes!("../assets/web-cursors/mac-text.png").as_slice(),
                "MacOS|IBeam",
                XY::new(0.484, 0.520),
            ),
            "crosshair" => (
                include_bytes!("../assets/web-cursors/mac-crosshair.png").as_slice(),
                "MacOS|Crosshair",
                XY::new(0.52, 0.51),
            ),
            "grab" => (
                include_bytes!("../assets/web-cursors/mac-grab.png").as_slice(),
                "MacOS|OpenHand",
                XY::new(0.5, 0.5),
            ),
            "grabbing" => (
                include_bytes!("../assets/web-cursors/mac-grabbing.png").as_slice(),
                "MacOS|ClosedHand",
                XY::new(0.5, 0.5),
            ),
            "not-allowed" => (
                include_bytes!("../assets/web-cursors/mac-not-allowed.png").as_slice(),
                "MacOS|OperationNotAllowed",
                XY::new(0.24, 0.1),
            ),
            "ew-resize" => (
                include_bytes!("../assets/web-cursors/mac-ew-resize.png").as_slice(),
                "MacOS|ResizeLeftRight",
                XY::new(0.5, 0.5),
            ),
            "ns-resize" => (
                include_bytes!("../assets/web-cursors/mac-ns-resize.png").as_slice(),
                "MacOS|ResizeUpDown",
                XY::new(0.5, 0.5),
            ),
            _ => return Err(WebInputError::new("Unsupported Mac cursor style")),
        },
    };
    Ok(asset)
}

fn safe_web_keyboard_key(key: &str, code: &str) -> bool {
    match key {
        "Escape" | "Tab" | "Backspace" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft"
        | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown" => code == key,
        "Enter" => matches!(code, "Enter" | "NumpadEnter"),
        "Shift" => matches!(code, "ShiftLeft" | "ShiftRight"),
        "Control" => matches!(code, "ControlLeft" | "ControlRight"),
        "Alt" => matches!(code, "AltLeft" | "AltRight"),
        "Meta" => matches!(code, "MetaLeft" | "MetaRight"),
        _ => {
            code == key
                && key
                    .strip_prefix('F')
                    .and_then(|value| value.parse::<u8>().ok())
                    .is_some_and(|number| (1..=24).contains(&number))
        }
    }
}

pub fn parse_web_input_events(reader: impl BufRead) -> Result<WebInputData, WebInputError> {
    let mut lines = reader.lines();
    let header_line = lines
        .next()
        .ok_or_else(|| WebInputError::new("Input event source is empty"))??;
    if header_line.len() > 256 {
        return Err(WebInputError::new(
            "Input event header exceeds the supported size",
        ));
    }
    let header: WebInputHeader = serde_json::from_str(&header_line)?;
    if header.version != 1 || header.platform.len() > 64 {
        return Err(WebInputError::new("Unsupported input event source version"));
    }
    let platform = if header.platform.starts_with("Mac") {
        Platform::MacOS
    } else if header.platform.starts_with("Win") {
        Platform::Windows
    } else if header.platform.starts_with("Linux") {
        Platform::Linux
    } else {
        return Err(WebInputError::new("Unsupported input event platform"));
    };
    let mut cursor = CursorEvents::default();
    let mut keyboard = KeyboardEvents::default();
    let mut styles = BTreeSet::new();
    for (index, line) in lines.enumerate() {
        if index >= MAX_WEB_INPUT_EVENTS {
            return Err(WebInputError::new(
                "Input event count exceeds the supported limit",
            ));
        }
        let line = line?;
        if line.len() > 1024 || line.is_empty() {
            return Err(WebInputError::new("Input event line is invalid"));
        }
        let event: WebInputEvent = serde_json::from_str(&line)?;
        if !event.time_ms.is_finite()
            || !(0.0..=86_400_000.0).contains(&event.time_ms)
            || event.modifiers.len() > 4
            || event.modifiers.iter().any(|modifier| {
                !matches!(modifier.as_str(), "Meta" | "LControl" | "LAlt" | "LShift")
            })
        {
            return Err(WebInputError::new(
                "Input event timestamp or modifiers are invalid",
            ));
        }
        match event.kind.as_str() {
            "move" | "down" | "up" => {
                let (Some(x), Some(y), Some(cursor_name), Some(button)) =
                    (event.x, event.y, event.cursor, event.button)
                else {
                    return Err(WebInputError::new("Pointer event is incomplete"));
                };
                if !x.is_finite()
                    || !y.is_finite()
                    || !(-1.0..=2.0).contains(&x)
                    || !(-1.0..=2.0).contains(&y)
                    || button > 4
                    || event.key.is_some()
                    || event.code.is_some()
                {
                    return Err(WebInputError::new("Pointer event is invalid"));
                }
                let style = web_cursor_style(&cursor_name)?;
                styles.insert(style);
                let cursor_id = web_cursor_id(style);
                if event.kind == "move" {
                    cursor.moves.push(CursorMoveEvent {
                        active_modifiers: event.modifiers,
                        cursor_id,
                        time_ms: event.time_ms,
                        x,
                        y,
                    });
                } else {
                    cursor.clicks.push(CursorClickEvent {
                        active_modifiers: event.modifiers,
                        cursor_num: button,
                        cursor_id,
                        time_ms: event.time_ms,
                        down: event.kind == "down",
                    });
                }
            }
            "keyDown" | "keyUp" => {
                let (Some(key), Some(code)) = (event.key, event.code) else {
                    return Err(WebInputError::new("Keyboard event is incomplete"));
                };
                if key.len() > 64
                    || code.len() > 64
                    || !safe_web_keyboard_key(&key, &code)
                    || event.x.is_some()
                    || event.y.is_some()
                    || event.cursor.is_some()
                    || event.button.is_some()
                {
                    return Err(WebInputError::new("Keyboard event is invalid"));
                }
                keyboard.presses.push(KeyPressEvent {
                    key,
                    key_code: code,
                    time_ms: event.time_ms,
                    down: event.kind == "keyDown",
                });
            }
            _ => return Err(WebInputError::new("Unsupported input event kind")),
        }
    }
    cursor
        .moves
        .sort_by(|left, right| left.time_ms.total_cmp(&right.time_ms));
    cursor
        .clicks
        .sort_by(|left, right| left.time_ms.total_cmp(&right.time_ms));
    keyboard
        .presses
        .sort_by(|left, right| left.time_ms.total_cmp(&right.time_ms));
    Ok(WebInputData {
        platform,
        cursor,
        keyboard,
        styles,
    })
}
