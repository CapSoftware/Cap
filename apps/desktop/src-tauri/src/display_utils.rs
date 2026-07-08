use scap_targets::{Display, DisplayId};
use tauri::{PhysicalPosition, PhysicalSize};

// Credits: tauri-plugin-window-state
pub trait MonitorExt {
    fn intersects(
        &self,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        scale: f64,
    ) -> bool;
}

impl MonitorExt for Display {
    fn intersects(
        &self,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        _scale: f64,
    ) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some(bounds) = self.raw_handle().logical_bounds() else {
                return false;
            };

            let left = (bounds.position().x() * _scale) as i32;
            let right = left + (bounds.size().width() * _scale) as i32;
            let top = (bounds.position().y() * _scale) as i32;
            let bottom = top + (bounds.size().height() * _scale) as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }

        #[cfg(windows)]
        {
            let Some(bounds) = self.raw_handle().physical_bounds() else {
                return false;
            };

            let left = bounds.position().x() as i32;
            let right = left + bounds.size().width() as i32;
            let top = bounds.position().y() as i32;
            let bottom = top + bounds.size().height() as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }

        #[cfg(target_os = "linux")]
        {
            let Some(bounds) = self.raw_handle().physical_bounds() else {
                return false;
            };

            let left = bounds.position().x() as i32;
            let right = left + bounds.size().width() as i32;
            let top = bounds.position().y() as i32;
            let bottom = top + bounds.size().height() as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }
    }
}

const DEFAULT_FALLBACK_DISPLAY_WIDTH: f64 = 1920.0;
const DEFAULT_FALLBACK_DISPLAY_HEIGHT: f64 = 1080.0;

pub struct CursorMonitorInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    // On Windows each monitor's "logical" rect is its physical rect divided by
    // its own scale, so logical rects of mixed-DPI monitors overlap and tao's
    // LogicalPosition conversion (which uses whatever monitor the window
    // currently occupies) can land a window on the wrong monitor. Positioning
    // must go through this monitor's own scale, as a physical position.
    #[cfg(windows)]
    pub scale: f64,
}

impl From<&Display> for CursorMonitorInfo {
    fn from(display: &Display) -> Self {
        let bounds = display.raw_handle().logical_bounds();

        #[cfg(windows)]
        let scale = bounds
            .as_ref()
            .map(|b| b.size().width())
            .filter(|width| *width > 0.0)
            .and_then(|logical_width| {
                display
                    .physical_size()
                    .map(|physical| physical.width() / logical_width)
            })
            .filter(|scale| scale.is_finite() && *scale > 0.0)
            .unwrap_or(1.0);

        let (x, y, width, height) = bounds
            .map(|b| {
                (
                    b.position().x(),
                    b.position().y(),
                    b.size().width(),
                    b.size().height(),
                )
            })
            .unwrap_or((
                0.0,
                0.0,
                DEFAULT_FALLBACK_DISPLAY_WIDTH,
                DEFAULT_FALLBACK_DISPLAY_HEIGHT,
            ));

        Self {
            x,
            y,
            width,
            height,
            #[cfg(windows)]
            scale,
        }
    }
}

impl CursorMonitorInfo {
    pub fn get() -> Self {
        Self::from(&Display::get_containing_cursor().unwrap_or_else(Display::primary))
    }

    /// Converts a global-logical point on this monitor into a `Position` that
    /// lands exactly there regardless of which monitor the window currently
    /// occupies. Logical on macOS/Linux (a true global space there), physical
    /// on Windows.
    pub fn position(&self, x: f64, y: f64) -> tauri::Position {
        #[cfg(windows)]
        return tauri::Position::Physical(tauri::PhysicalPosition::new(
            (x * self.scale).round() as i32,
            (y * self.scale).round() as i32,
        ));

        #[cfg(not(windows))]
        tauri::Position::Logical(tauri::LogicalPosition::new(x, y))
    }

    pub fn center_position(&self, window_width: f64, window_height: f64) -> (f64, f64) {
        let pos_x = self.x + (self.width - window_width) / 2.0;
        let pos_y = self.y + (self.height - window_height) / 2.0;
        (pos_x, pos_y)
    }

    pub fn bottom_center_position(
        &self,
        window_width: f64,
        window_height: f64,
        offset_y: f64,
    ) -> (f64, f64) {
        let pos_x = self.x + (self.width - window_width) / 2.0;
        let pos_y = self.y + self.height - window_height - offset_y;
        (pos_x, pos_y)
    }

    pub fn from_window(window: &tauri::WebviewWindow) -> Self {
        let Ok(window_pos) = window.outer_position() else {
            return Self::get();
        };

        // outer_position is physical. On Windows, resolve the display in
        // physical space (per-monitor logical rects overlap in mixed-DPI
        // layouts). On macOS, convert to logical points, a true global space.
        // On Linux scap reports logical bounds in unscaled physical units, so
        // the raw position compares directly.
        #[cfg(windows)]
        {
            let (pos_x, pos_y) = (window_pos.x as f64, window_pos.y as f64);
            for display in Display::list() {
                if let Some(bounds) = display.raw_handle().physical_bounds() {
                    let (x, y, width, height) = (
                        bounds.position().x(),
                        bounds.position().y(),
                        bounds.size().width(),
                        bounds.size().height(),
                    );

                    if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
                        return Self::from(&display);
                    }
                }
            }

            Self::get()
        }

        #[cfg(target_os = "macos")]
        {
            let scale = window.scale_factor().unwrap_or(1.0);
            let pos = window_pos.to_logical::<f64>(scale);

            for display in Display::list() {
                if display_contains_logical(&display, pos.x, pos.y) {
                    return Self::from(&display);
                }
            }

            Self::get()
        }

        #[cfg(target_os = "linux")]
        {
            let (pos_x, pos_y) = (window_pos.x as f64, window_pos.y as f64);

            for display in Display::list() {
                if display_contains_logical(&display, pos_x, pos_y) {
                    return Self::from(&display);
                }
            }

            Self::get()
        }
    }
}

fn display_contains_logical(display: &Display, pos_x: f64, pos_y: f64) -> bool {
    display
        .raw_handle()
        .logical_bounds()
        .map(|bounds| {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
        })
        .unwrap_or(false)
}

/// Resolves the display a persisted window position belongs to, preferring the
/// display it was saved on. On Windows the saved logical coordinates are only
/// meaningful relative to that display (mixed-DPI logical rects overlap), so
/// restores must convert through its scale rather than the window's current one.
pub fn display_for_saved_position(
    pos_x: f64,
    pos_y: f64,
    display_id: Option<&DisplayId>,
) -> Option<Display> {
    display_id
        .and_then(Display::from_id)
        .filter(|display| display_contains_logical(display, pos_x, pos_y))
        .or_else(|| display_containing_logical(pos_x, pos_y))
}

/// Converts a global-logical point into a `Position` that lands exactly there,
/// resolving the owning display by containment when the caller doesn't know it.
/// Falls back to a plain logical position when no display contains the point.
pub fn logical_point_position(pos_x: f64, pos_y: f64) -> tauri::Position {
    #[cfg(windows)]
    if let Some(display) = display_containing_logical(pos_x, pos_y) {
        return CursorMonitorInfo::from(&display).position(pos_x, pos_y);
    }

    tauri::Position::Logical(tauri::LogicalPosition::new(pos_x, pos_y))
}

fn display_containing_logical(pos_x: f64, pos_y: f64) -> Option<Display> {
    Display::list()
        .into_iter()
        .find(|display| display_contains_logical(display, pos_x, pos_y))
}

pub fn is_position_on_display(display_id: &DisplayId, pos_x: f64, pos_y: f64) -> bool {
    Display::from_id(display_id)
        .and_then(|display| display.raw_handle().logical_bounds())
        .map(|bounds| {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
        })
        .unwrap_or(false)
}

pub fn display_name_for_position(pos_x: f64, pos_y: f64) -> Option<String> {
    Display::list().into_iter().find_map(|display| {
        let bounds = display.raw_handle().logical_bounds()?;
        let (x, y, width, height) = (
            bounds.position().x(),
            bounds.position().y(),
            bounds.size().width(),
            bounds.size().height(),
        );

        if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
            display.name().filter(|name| !name.trim().is_empty())
        } else {
            None
        }
    })
}

pub fn is_position_on_monitor_name(monitor_name: &str, pos_x: f64, pos_y: f64) -> bool {
    Display::list().into_iter().any(|display| {
        if display.name().as_deref() != Some(monitor_name) {
            return false;
        }

        display
            .raw_handle()
            .logical_bounds()
            .map(|bounds| {
                let (x, y, width, height) = (
                    bounds.position().x(),
                    bounds.position().y(),
                    bounds.size().width(),
                    bounds.size().height(),
                );

                pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
            })
            .unwrap_or(false)
    })
}

pub fn is_position_on_any_screen(pos_x: f64, pos_y: f64) -> bool {
    for display in Display::list() {
        if let Some(bounds) = display.raw_handle().logical_bounds() {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
                return true;
            }
        }
    }
    false
}
