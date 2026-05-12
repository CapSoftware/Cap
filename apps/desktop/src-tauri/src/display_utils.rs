use scap_targets::Display;
use tauri::{PhysicalPosition, PhysicalSize};

// Credits: tauri-plugin-window-state
pub trait MonitorExt {
    fn intersects(
        &self,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        scale: f64,
    ) -> bool;

    fn intersects_window(&self, window: tauri::Window) -> tauri::Result<bool>;
}

impl MonitorExt for Display {
    fn intersects_window(&self, window: tauri::Window) -> tauri::Result<bool> {
        Ok(self.intersects(
            window.outer_position()?,
            window.outer_size()?,
            window.scale_factor()?,
        ))
    }

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
    }
}

const DEFAULT_FALLBACK_DISPLAY_WIDTH: f64 = 1920.0;
const DEFAULT_FALLBACK_DISPLAY_HEIGHT: f64 = 1080.0;
pub struct CursorMonitorInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl CursorMonitorInfo {
    pub fn get() -> Self {
        let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
        let bounds = display.raw_handle().logical_bounds();
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
        }
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
        let window_pos = window
            .outer_position()
            .ok()
            .map(|p| (p.x as f64, p.y as f64))
            .unwrap_or((0.0, 0.0));

        for display in Display::list() {
            if let Some(bounds) = display.raw_handle().logical_bounds() {
                let (x, y, width, height) = (
                    bounds.position().x(),
                    bounds.position().y(),
                    bounds.size().width(),
                    bounds.size().height(),
                );

                if window_pos.0 >= x
                    && window_pos.0 < x + width
                    && window_pos.1 >= y
                    && window_pos.1 < y + height
                {
                    return Self {
                        x,
                        y,
                        width,
                        height,
                    };
                }
            }
        }

        Self::get()
    }
}
