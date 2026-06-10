use std::{env, fs, str::FromStr};

use x11rb::{
    connection::Connection,
    protocol::{
        randr::ConnectionExt as RandrConnectionExt,
        xproto::{Atom, AtomEnum, ConnectionExt as XprotoConnectionExt, Window},
    },
    rust_connection::RustConnection,
};

use crate::bounds::{
    LogicalBounds, LogicalPosition, LogicalSize, PhysicalBounds, PhysicalPosition, PhysicalSize,
};

#[derive(Clone, Copy)]
pub struct DisplayImpl {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    refresh_rate: f64,
}

impl DisplayImpl {
    pub fn primary() -> Self {
        Self::list().into_iter().next().unwrap_or(Self {
            id: 0,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            refresh_rate: 60.0,
        })
    }

    pub fn list() -> Vec<Self> {
        let Ok((conn, screen_num)) = x11_connection() else {
            return wayland_displays();
        };
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;

        let monitors = conn
            .randr_get_monitors(root, true)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| {
                reply
                    .monitors
                    .into_iter()
                    .enumerate()
                    .filter(|(_, monitor)| monitor.width > 0 && monitor.height > 0)
                    .map(|(index, monitor)| Self {
                        id: index as u32,
                        x: monitor.x.into(),
                        y: monitor.y.into(),
                        width: monitor.width.into(),
                        height: monitor.height.into(),
                        refresh_rate: 60.0,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if !monitors.is_empty() {
            return monitors;
        }

        vec![Self {
            id: 0,
            x: 0,
            y: 0,
            width: screen.width_in_pixels.into(),
            height: screen.height_in_pixels.into(),
            refresh_rate: 60.0,
        }]
    }

    pub fn raw_id(&self) -> DisplayIdImpl {
        DisplayIdImpl(self.id)
    }

    pub fn from_id(id: String) -> Option<Self> {
        let parsed = id.parse::<u32>().ok()?;
        Self::list()
            .into_iter()
            .find(|display| display.id == parsed)
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        Some(LogicalSize::new(self.width.into(), self.height.into()))
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        Some(LogicalBounds::new(
            LogicalPosition::new(self.x.into(), self.y.into()),
            self.logical_size()?,
        ))
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        Some(PhysicalBounds::new(
            PhysicalPosition::new(self.x.into(), self.y.into()),
            self.physical_size()?,
        ))
    }

    pub fn physical_position(&self) -> Option<PhysicalPosition> {
        Some(PhysicalPosition::new(self.x.into(), self.y.into()))
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(PhysicalSize::new(self.width.into(), self.height.into()))
    }

    pub fn refresh_rate(&self) -> f64 {
        self.refresh_rate
    }

    pub fn name(&self) -> Option<String> {
        Some(format!("Display {}", self.id + 1))
    }

    pub fn get_containing_cursor() -> Option<Self> {
        let cursor = get_cursor_position()?;
        Self::list().into_iter().find(|display| {
            display
                .physical_bounds()
                .is_some_and(|bounds| bounds.contains_point(cursor))
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayIdImpl(u32);

impl std::fmt::Display for DisplayIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DisplayIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u32>()
            .map(Self)
            .map_err(|e| format!("invalid X11 display id: {e}"))
    }
}

#[derive(Clone, Copy)]
pub struct WindowImpl(Window);

impl WindowImpl {
    pub fn list() -> Vec<Self> {
        let Ok((conn, screen_num)) = x11_connection() else {
            return wayland_windows();
        };
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let windows = filter_window_candidates(client_list(&conn, root));

        if windows.is_empty() {
            filter_window_candidates(query_window_tree(&conn, root))
        } else {
            windows
        }
    }

    pub fn list_containing_cursor() -> Vec<Self> {
        let Some(cursor) = get_cursor_position() else {
            return Vec::new();
        };
        let mut windows = Self::list()
            .into_iter()
            .filter(|window| {
                window
                    .physical_bounds()
                    .is_some_and(|bounds| bounds.contains_point(cursor))
            })
            .collect::<Vec<_>>();
        windows.reverse();
        windows
    }

    pub fn get_topmost_at_cursor() -> Option<Self> {
        Self::list_containing_cursor().into_iter().next()
    }

    pub fn id(&self) -> WindowIdImpl {
        WindowIdImpl(self.0)
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(self.physical_bounds()?.size())
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        let size = self.physical_size()?;
        Some(LogicalSize::new(size.width(), size.height()))
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        if is_wayland_portal_window(self.0) {
            return Some(DisplayImpl::primary().physical_bounds()?);
        }

        let (conn, screen_num) = x11_connection().ok()?;
        let root = conn.setup().roots[screen_num].root;
        let geometry = conn.get_geometry(self.0).ok()?.reply().ok()?;
        let translated = conn
            .translate_coordinates(self.0, root, 0, 0)
            .ok()?
            .reply()
            .ok()?;

        Some(PhysicalBounds::new(
            PhysicalPosition::new(translated.dst_x.into(), translated.dst_y.into()),
            PhysicalSize::new(geometry.width.into(), geometry.height.into()),
        ))
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        let bounds = self.physical_bounds()?;
        Some(LogicalBounds::new(
            LogicalPosition::new(bounds.position().x(), bounds.position().y()),
            LogicalSize::new(bounds.size().width(), bounds.size().height()),
        ))
    }

    pub fn owner_name(&self) -> Option<String> {
        if is_wayland_portal_window(self.0) {
            return Some("Wayland Portal".to_string());
        }

        let (conn, _) = x11_connection().ok()?;
        window_pid(&conn, self.0)
            .and_then(process_name)
            .or_else(|| window_property_string(&conn, self.0, "WM_CLASS"))
    }

    pub fn app_icon(&self) -> Option<Vec<u8>> {
        None
    }

    pub fn display(&self) -> Option<DisplayImpl> {
        let bounds = self.physical_bounds()?;
        let center = PhysicalPosition::new(
            bounds.position().x() + bounds.size().width() / 2.0,
            bounds.position().y() + bounds.size().height() / 2.0,
        );

        DisplayImpl::list().into_iter().find(|display| {
            display
                .physical_bounds()
                .is_some_and(|display_bounds| display_bounds.contains_point(center))
        })
    }

    pub fn name(&self) -> Option<String> {
        if is_wayland_portal_window(self.0) {
            return Some("Select window when recording".to_string());
        }

        let (conn, _) = x11_connection().ok()?;
        window_property_string(&conn, self.0, "_NET_WM_NAME")
            .or_else(|| window_property_string(&conn, self.0, "WM_NAME"))
    }

    pub fn level(&self) -> Option<i32> {
        Some(0)
    }
}

fn filter_window_candidates(windows: Vec<Window>) -> Vec<WindowImpl> {
    windows
        .into_iter()
        .map(WindowImpl)
        .filter(|window| {
            window
                .physical_size()
                .is_some_and(|size| size.width() > 0.0 && size.height() > 0.0)
                && window.display().is_some()
                && window.name().is_some_and(|name| !name.is_empty())
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowIdImpl(Window);

impl std::fmt::Display for WindowIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for WindowIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u32>()
            .map(Self)
            .map_err(|e| format!("invalid X11 window id: {e}"))
    }
}

fn x11_connection() -> Result<(RustConnection, usize), x11rb::errors::ConnectError> {
    x11rb::connect(None)
}

fn wayland_displays() -> Vec<DisplayImpl> {
    if env::var_os("WAYLAND_DISPLAY").is_none() {
        return Vec::new();
    }

    let (width, height) = wayland_display_size();
    vec![DisplayImpl {
        id: 0,
        x: 0,
        y: 0,
        width,
        height,
        refresh_rate: 60.0,
    }]
}

fn wayland_windows() -> Vec<WindowImpl> {
    if wayland_displays().is_empty() {
        Vec::new()
    } else {
        vec![WindowImpl(0)]
    }
}

fn wayland_display_size() -> (u32, u32) {
    let width = env::var("CAP_WAYLAND_OUTPUT_WIDTH")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1920);
    let height = env::var("CAP_WAYLAND_OUTPUT_HEIGHT")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1080);

    (width, height)
}

fn is_wayland_portal_window(window: Window) -> bool {
    window == 0 && x11_connection().is_err() && env::var_os("WAYLAND_DISPLAY").is_some()
}

fn intern_atom(conn: &RustConnection, name: &str) -> Option<Atom> {
    conn.intern_atom(false, name.as_bytes())
        .ok()?
        .reply()
        .ok()
        .map(|reply| reply.atom)
}

fn client_list(conn: &RustConnection, root: Window) -> Vec<Window> {
    ["_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"]
        .into_iter()
        .find_map(|name| {
            let atom = intern_atom(conn, name)?;
            let reply = conn
                .get_property(false, root, atom, AtomEnum::WINDOW, 0, u32::MAX)
                .ok()?
                .reply()
                .ok()?;
            reply
                .value32()
                .map(|values| values.collect::<Vec<_>>())
                .filter(|windows| !windows.is_empty())
        })
        .unwrap_or_else(|| query_window_tree(conn, root))
}

fn query_window_tree(conn: &RustConnection, root: Window) -> Vec<Window> {
    let mut windows = Vec::new();
    let mut stack = conn
        .query_tree(root)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| reply.children)
        .unwrap_or_default();

    while let Some(window) = stack.pop() {
        windows.push(window);
        if let Ok(cookie) = conn.query_tree(window)
            && let Ok(reply) = cookie.reply()
        {
            stack.extend(reply.children);
        }
    }

    windows
}

fn window_property_string(
    conn: &RustConnection,
    window: Window,
    property_name: &str,
) -> Option<String> {
    let property = intern_atom(conn, property_name)?;
    let reply = conn
        .get_property(false, window, property, AtomEnum::ANY, 0, 1024)
        .ok()?
        .reply()
        .ok()?;
    if reply.value.is_empty() {
        return None;
    }
    let nul = reply
        .value
        .iter()
        .position(|b| *b == 0)
        .unwrap_or(reply.value.len());
    String::from_utf8(reply.value[..nul].to_vec())
        .ok()
        .filter(|value| !value.is_empty())
}

fn window_pid(conn: &RustConnection, window: Window) -> Option<u32> {
    let property = intern_atom(conn, "_NET_WM_PID")?;
    let reply = conn
        .get_property(false, window, property, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    reply.value32()?.next()
}

fn process_name(pid: u32) -> Option<String> {
    fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn get_cursor_position() -> Option<PhysicalPosition> {
    let (conn, screen_num) = x11_connection().ok()?;
    let root = conn.setup().roots[screen_num].root;
    let reply = conn.query_pointer(root).ok()?.reply().ok()?;
    Some(PhysicalPosition::new(
        reply.root_x.into(),
        reply.root_y.into(),
    ))
}
