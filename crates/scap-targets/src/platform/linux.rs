use std::{env, fs, str::FromStr};

use x11rb::{
    connection::Connection,
    cookie::Cookie,
    errors::{ConnectionError, ReplyError},
    protocol::{
        ErrorKind,
        randr::{ConnectionExt as RandrConnectionExt, GetMonitorsReply},
        xproto::{
            Atom, AtomEnum, ConnectionExt as XprotoConnectionExt, GetGeometryReply,
            GetPropertyReply, InternAtomReply, MapState, QueryPointerReply,
            TranslateCoordinatesReply, Window,
        },
    },
    rust_connection::RustConnection,
    x11_utils::TryParse,
};

use crate::bounds::{
    LogicalBounds, LogicalPosition, LogicalSize, PhysicalBounds, PhysicalPosition, PhysicalSize,
};

mod wayland;

#[derive(Clone, Copy)]
pub struct DisplayImpl {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    refresh_rate: f64,
    logical_bounds: Option<LogicalBounds>,
    wayland_uuid: Option<uuid::Uuid>,
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
            logical_bounds: None,
            wayland_uuid: None,
        })
    }

    pub fn list() -> Vec<Self> {
        if prefers_wayland() {
            return wayland_displays();
        }
        let Ok((conn, screen_num)) = x11_connection() else {
            return wayland_displays();
        };
        displays_on_connection(&conn, screen_num)
    }

    pub fn wayland_uuid(&self) -> Option<uuid::Uuid> {
        self.wayland_uuid
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
        Some(self.logical_bounds.map_or_else(
            || LogicalSize::new(self.width.into(), self.height.into()),
            |bounds| bounds.size(),
        ))
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        if let Some(bounds) = self.logical_bounds {
            return Some(bounds);
        }
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

pub struct WindowSelectionMetadata {
    pub is_viewable: bool,
    pub owner_pid: Option<u32>,
}

impl WindowImpl {
    pub fn list() -> Vec<Self> {
        if prefers_wayland() {
            return wayland_windows();
        }
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

    pub fn selection_metadata(&self) -> Option<WindowSelectionMetadata> {
        let (conn, _) = x11_connection().ok()?;
        let attributes = conn.get_window_attributes(self.0).ok()?.reply().ok()?;
        Some(WindowSelectionMetadata {
            is_viewable: attributes.map_state == MapState::VIEWABLE,
            owner_pid: window_pid(&conn, self.0),
        })
    }

    pub fn owner_pid(&self) -> Option<u32> {
        if is_wayland_portal_window(self.0) {
            return None;
        }
        let (conn, _) = x11_connection().ok()?;
        window_pid(&conn, self.0)
    }

    pub fn list_x11_snapshots() -> Option<Vec<X11WindowSnapshot>> {
        x11_pass(QueryMode::Picker, false).map(|(snapshots, _)| snapshots)
    }

    /// `None` when X11 is unavailable. `Some(None)` when the probe ran and no
    /// listed window contains the pointer.
    pub fn topmost_x11_snapshot_at_cursor() -> Option<Option<X11WindowSnapshot>> {
        let (snapshots, cursor) = x11_pass(QueryMode::Listing, true)?;
        let Some(cursor) = cursor else {
            return Some(None);
        };
        Some(
            snapshots
                .into_iter()
                .rev()
                .find(|snapshot| snapshot.bounds.contains_point(cursor)),
        )
    }

    pub fn id(&self) -> WindowIdImpl {
        WindowIdImpl(self.0)
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(self.physical_bounds()?.size())
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        if is_wayland_portal_window(self.0) {
            return DisplayImpl::primary().logical_size();
        }
        let size = self.physical_size()?;
        Some(LogicalSize::new(size.width(), size.height()))
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        if is_wayland_portal_window(self.0) {
            return DisplayImpl::primary().physical_bounds();
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
        if is_wayland_portal_window(self.0) {
            return DisplayImpl::primary().logical_bounds();
        }
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
        display_for_bounds(self.physical_bounds()?, &DisplayImpl::list())
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

fn display_for_bounds(bounds: PhysicalBounds, displays: &[DisplayImpl]) -> Option<DisplayImpl> {
    displays
        .iter()
        .filter_map(|display| {
            let display_bounds = display.physical_bounds()?;
            let left = bounds.position().x().max(display_bounds.position().x());
            let top = bounds.position().y().max(display_bounds.position().y());
            let right = (bounds.position().x() + bounds.size().width())
                .min(display_bounds.position().x() + display_bounds.size().width());
            let bottom = (bounds.position().y() + bounds.size().height())
                .min(display_bounds.position().y() + display_bounds.size().height());
            let area = (right - left).max(0.0) * (bottom - top).max(0.0);
            (area > 0.0).then_some((*display, area))
        })
        .max_by(|(_, a), (_, b)| a.total_cmp(b))
        .map(|(display, _)| display)
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

    wayland::displays().unwrap_or_default()
}

fn wayland_windows() -> Vec<WindowImpl> {
    if wayland_displays().is_empty() {
        Vec::new()
    } else {
        vec![WindowImpl(0)]
    }
}

fn prefers_wayland() -> bool {
    prefers_wayland_environment(
        env::var_os("WAYLAND_DISPLAY").is_some(),
        env::var_os("DISPLAY").is_some(),
        env::var("XDG_SESSION_TYPE").ok().as_deref(),
    )
}

fn prefers_wayland_environment(wayland: bool, x11: bool, session: Option<&str>) -> bool {
    wayland && (!x11 || session.is_some_and(|session| session.eq_ignore_ascii_case("wayland")))
}

fn is_wayland_portal_window(window: Window) -> bool {
    window == 0 && prefers_wayland()
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
            window_list_property(conn, root, atom)
        })
        .unwrap_or_else(|| query_window_tree(conn, root))
}

fn client_list_windows(
    conn: &RustConnection,
    root: Window,
    atoms: &X11Atoms,
) -> Option<Vec<Window>> {
    window_list_property(conn, root, atoms.client_list_stacking)
        .or_else(|| window_list_property(conn, root, atoms.client_list))
}

fn window_list_property(conn: &RustConnection, root: Window, atom: Atom) -> Option<Vec<Window>> {
    let reply = conn
        .get_property(false, root, atom, AtomEnum::WINDOW, 0, u32::MAX)
        .ok()?
        .reply()
        .ok()?;
    reply
        .value32()
        .map(|values| values.collect::<Vec<_>>())
        .filter(|windows| !windows.is_empty())
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
    property_text(&reply.value)
}

fn property_text(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let nul = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8(bytes[..nul].to_vec())
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
    cardinal_from_reply(&reply)
}

fn cardinal_from_reply(reply: &GetPropertyReply) -> Option<u32> {
    reply.value32()?.next()
}

fn process_name(pid: u32) -> Option<String> {
    fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn get_cursor_position() -> Option<PhysicalPosition> {
    if prefers_wayland() {
        return None;
    }
    let (conn, screen_num) = x11_connection().ok()?;
    let root = conn.setup().roots[screen_num].root;
    let reply = conn.query_pointer(root).ok()?.reply().ok()?;
    Some(PhysicalPosition::new(
        reply.root_x.into(),
        reply.root_y.into(),
    ))
}

pub struct X11WindowSnapshot {
    pub window: crate::Window,
    pub name: String,
    pub owner_name: Option<String>,
    pub owner_pid: Option<u32>,
    pub bounds: PhysicalBounds,
    pub display: DisplayImpl,
}

impl X11WindowSnapshot {
    pub fn logical_size(&self) -> LogicalSize {
        let size = self.bounds.size();
        LogicalSize::new(size.width(), size.height())
    }

    pub fn display_relative_origin(&self) -> Option<(f64, f64)> {
        let display_bounds = self.display.logical_bounds()?;
        let position = self.bounds.position();
        Some((
            position.x() - display_bounds.position().x(),
            position.y() - display_bounds.position().y(),
        ))
    }

    pub fn refresh_rate(&self) -> f64 {
        self.display.refresh_rate()
    }
}

#[derive(Clone, Copy)]
enum QueryMode {
    Listing,
    Picker,
}

struct X11Atoms {
    client_list_stacking: Atom,
    client_list: Atom,
    net_wm_name: Atom,
    wm_name: Atom,
    net_wm_pid: Atom,
    wm_class: Atom,
}

enum ReplyOutcome<T> {
    Present(T),
    Vanished,
    Missing,
}

struct WindowReplies {
    geometry: ReplyOutcome<(u16, u16)>,
    translation: ReplyOutcome<(i16, i16)>,
    net_wm_name: ReplyOutcome<Option<String>>,
    wm_name: ReplyOutcome<Option<String>>,
    pid: ReplyOutcome<Option<u32>>,
    wm_class: ReplyOutcome<Option<String>>,
}

struct ParsedWindow {
    name: String,
    owner_name: Option<String>,
    owner_pid: Option<u32>,
    bounds: PhysicalBounds,
    display: DisplayImpl,
}

struct PendingWindow<'conn> {
    window: Window,
    geometry: Result<Cookie<'conn, RustConnection, GetGeometryReply>, ConnectionError>,
    translation: Result<Cookie<'conn, RustConnection, TranslateCoordinatesReply>, ConnectionError>,
    net_wm_name: Result<Cookie<'conn, RustConnection, GetPropertyReply>, ConnectionError>,
    wm_name: Result<Cookie<'conn, RustConnection, GetPropertyReply>, ConnectionError>,
    pid: Option<Result<Cookie<'conn, RustConnection, GetPropertyReply>, ConnectionError>>,
    wm_class: Option<Result<Cookie<'conn, RustConnection, GetPropertyReply>, ConnectionError>>,
}

fn x11_pass(
    mode: QueryMode,
    with_cursor: bool,
) -> Option<(Vec<X11WindowSnapshot>, Option<PhysicalPosition>)> {
    if prefers_wayland() {
        return None;
    }
    let (conn, screen_num) = x11_connection().ok()?;
    let (root, screen_width, screen_height) = screen_geometry(&conn, screen_num)?;
    let atom_cookies = send_interns(&conn);
    let monitors_cookie = conn.randr_get_monitors(root, true).ok();
    let pointer_cookie = if with_cursor {
        conn.query_pointer(root).ok()
    } else {
        None
    };
    let atoms = recv_interns(atom_cookies)?;
    let displays = recv_displays(monitors_cookie, screen_width, screen_height);
    let cursor = pointer_cookie.and_then(pointer_position);
    let listed = client_list_windows(&conn, root, &atoms);
    let from_client_list = listed.is_some();
    let windows = listed.unwrap_or_else(|| query_window_tree(&conn, root));
    let pending = send_window_queries(&conn, root, &windows, &atoms, mode);
    let mut snapshots = finish_window_queries(pending, &displays);
    if snapshots.is_empty() && from_client_list {
        let tree = query_window_tree(&conn, root);
        let pending = send_window_queries(&conn, root, &tree, &atoms, mode);
        snapshots = finish_window_queries(pending, &displays);
    }
    Some((snapshots, cursor))
}

fn screen_geometry(conn: &RustConnection, screen_num: usize) -> Option<(Window, u16, u16)> {
    let screen = conn.setup().roots.get(screen_num)?;
    Some((screen.root, screen.width_in_pixels, screen.height_in_pixels))
}

fn displays_on_connection(conn: &RustConnection, screen_num: usize) -> Vec<DisplayImpl> {
    let Some((root, screen_width, screen_height)) = screen_geometry(conn, screen_num) else {
        return Vec::new();
    };
    let monitors_cookie = conn.randr_get_monitors(root, true).ok();
    recv_displays(monitors_cookie, screen_width, screen_height)
}

fn recv_displays(
    cookie: Option<Cookie<'_, RustConnection, GetMonitorsReply>>,
    screen_width: u16,
    screen_height: u16,
) -> Vec<DisplayImpl> {
    let monitors = cookie
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| {
            reply
                .monitors
                .into_iter()
                .enumerate()
                .filter(|(_, monitor)| monitor.width > 0 && monitor.height > 0)
                .map(|(index, monitor)| DisplayImpl {
                    id: index as u32,
                    x: monitor.x.into(),
                    y: monitor.y.into(),
                    width: monitor.width.into(),
                    height: monitor.height.into(),
                    refresh_rate: 60.0,
                    logical_bounds: None,
                    wayland_uuid: None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !monitors.is_empty() {
        return monitors;
    }
    vec![DisplayImpl {
        id: 0,
        x: 0,
        y: 0,
        width: screen_width.into(),
        height: screen_height.into(),
        refresh_rate: 60.0,
        logical_bounds: None,
        wayland_uuid: None,
    }]
}

fn send_interns(
    conn: &RustConnection,
) -> Vec<Result<Cookie<'_, RustConnection, InternAtomReply>, ConnectionError>> {
    [
        "_NET_CLIENT_LIST_STACKING",
        "_NET_CLIENT_LIST",
        "_NET_WM_NAME",
        "WM_NAME",
        "_NET_WM_PID",
        "WM_CLASS",
    ]
    .into_iter()
    .map(|name| conn.intern_atom(false, name.as_bytes()))
    .collect()
}

fn recv_interns(
    cookies: Vec<Result<Cookie<'_, RustConnection, InternAtomReply>, ConnectionError>>,
) -> Option<X11Atoms> {
    let mut atoms = [0; 6];
    if cookies.len() != atoms.len() {
        return None;
    }
    for (slot, cookie) in atoms.iter_mut().zip(cookies) {
        let atom = cookie.ok()?.reply().ok()?.atom;
        if atom == x11rb::NONE {
            return None;
        }
        *slot = atom;
    }
    Some(X11Atoms {
        client_list_stacking: atoms[0],
        client_list: atoms[1],
        net_wm_name: atoms[2],
        wm_name: atoms[3],
        net_wm_pid: atoms[4],
        wm_class: atoms[5],
    })
}

fn pointer_position(
    cookie: Cookie<'_, RustConnection, QueryPointerReply>,
) -> Option<PhysicalPosition> {
    let reply = cookie.reply().ok()?;
    Some(PhysicalPosition::new(
        reply.root_x.into(),
        reply.root_y.into(),
    ))
}

fn send_window_queries<'conn>(
    conn: &'conn RustConnection,
    root: Window,
    windows: &[Window],
    atoms: &X11Atoms,
    mode: QueryMode,
) -> Vec<PendingWindow<'conn>> {
    let picker = matches!(mode, QueryMode::Picker);
    windows
        .iter()
        .copied()
        .map(|window| PendingWindow {
            window,
            geometry: conn.get_geometry(window),
            translation: conn.translate_coordinates(window, root, 0, 0),
            net_wm_name: conn.get_property(
                false,
                window,
                atoms.net_wm_name,
                AtomEnum::ANY,
                0,
                1024,
            ),
            wm_name: conn.get_property(false, window, atoms.wm_name, AtomEnum::ANY, 0, 1024),
            pid: picker.then(|| {
                conn.get_property(false, window, atoms.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
            }),
            wm_class: picker
                .then(|| conn.get_property(false, window, atoms.wm_class, AtomEnum::ANY, 0, 1024)),
        })
        .collect()
}

fn finish_window_queries(
    pending: Vec<PendingWindow<'_>>,
    displays: &[DisplayImpl],
) -> Vec<X11WindowSnapshot> {
    pending
        .into_iter()
        .filter_map(|pending| {
            let replies = WindowReplies {
                geometry: map_present(cookie_outcome(pending.geometry), |reply| {
                    (reply.width, reply.height)
                }),
                translation: map_present(cookie_outcome(pending.translation), |reply| {
                    (reply.dst_x, reply.dst_y)
                }),
                net_wm_name: map_present(cookie_outcome(pending.net_wm_name), |reply| {
                    property_text(&reply.value)
                }),
                wm_name: map_present(cookie_outcome(pending.wm_name), |reply| {
                    property_text(&reply.value)
                }),
                pid: match pending.pid {
                    Some(cookie) => {
                        map_present(cookie_outcome(cookie), |reply| cardinal_from_reply(&reply))
                    }
                    None => ReplyOutcome::Present(None),
                },
                wm_class: match pending.wm_class {
                    Some(cookie) => {
                        map_present(cookie_outcome(cookie), |reply| property_text(&reply.value))
                    }
                    None => ReplyOutcome::Present(None),
                },
            };
            let window = pending.window;
            parse_window_replies(replies, displays, &process_name).map(|parsed| X11WindowSnapshot {
                window: crate::Window(WindowImpl(window)),
                name: parsed.name,
                owner_name: parsed.owner_name,
                owner_pid: parsed.owner_pid,
                bounds: parsed.bounds,
                display: parsed.display,
            })
        })
        .collect()
}

fn cookie_outcome<R: TryParse>(
    cookie: Result<Cookie<'_, RustConnection, R>, ConnectionError>,
) -> ReplyOutcome<R> {
    match cookie {
        Ok(cookie) => outcome_from_reply(cookie.reply()),
        Err(_) => ReplyOutcome::Missing,
    }
}

fn outcome_from_reply<T>(result: Result<T, ReplyError>) -> ReplyOutcome<T> {
    match result {
        Ok(value) => ReplyOutcome::Present(value),
        Err(ReplyError::X11Error(error)) if is_vanished_error_kind(error.error_kind) => {
            ReplyOutcome::Vanished
        }
        Err(ReplyError::X11Error(_) | ReplyError::ConnectionError(_)) => ReplyOutcome::Missing,
    }
}

fn is_vanished_error_kind(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::Window | ErrorKind::Drawable)
}

fn map_present<T, U>(outcome: ReplyOutcome<T>, map: impl FnOnce(T) -> U) -> ReplyOutcome<U> {
    match outcome {
        ReplyOutcome::Present(value) => ReplyOutcome::Present(map(value)),
        ReplyOutcome::Vanished => ReplyOutcome::Vanished,
        ReplyOutcome::Missing => ReplyOutcome::Missing,
    }
}

fn parse_window_replies(
    replies: WindowReplies,
    displays: &[DisplayImpl],
    proc_name: &impl Fn(u32) -> Option<String>,
) -> Option<ParsedWindow> {
    let (width, height) = present(replies.geometry)?;
    let (dst_x, dst_y) = present(replies.translation)?;
    let net_wm_name = present(replies.net_wm_name)?;
    let wm_name = present(replies.wm_name)?;
    let owner_pid = present(replies.pid)?;
    let wm_class = present(replies.wm_class)?;
    if width == 0 || height == 0 {
        return None;
    }
    let name = net_wm_name.or(wm_name)?;
    let bounds = PhysicalBounds::new(
        PhysicalPosition::new(dst_x.into(), dst_y.into()),
        PhysicalSize::new(width.into(), height.into()),
    );
    let display = display_for_bounds(bounds, displays)?;
    Some(ParsedWindow {
        name,
        owner_name: resolve_owner_name(owner_pid, wm_class, proc_name),
        owner_pid,
        bounds,
        display,
    })
}

fn present<T>(outcome: ReplyOutcome<T>) -> Option<T> {
    match outcome {
        ReplyOutcome::Present(value) => Some(value),
        ReplyOutcome::Vanished | ReplyOutcome::Missing => None,
    }
}

fn resolve_owner_name(
    pid: Option<u32>,
    wm_class: Option<String>,
    proc_name: &impl Fn(u32) -> Option<String>,
) -> Option<String> {
    pid.and_then(proc_name).or(wm_class)
}

#[cfg(test)]
mod tests {
    use super::{
        DisplayImpl, PhysicalBounds, PhysicalPosition, PhysicalSize, ReplyOutcome, WindowImpl,
        WindowReplies, cardinal_from_reply, display_for_bounds, is_vanished_error_kind,
        parse_window_replies, property_text, resolve_owner_name,
    };
    use x11rb::protocol::{
        ErrorKind,
        xproto::{AtomEnum, ConnectionExt, CreateWindowAux, PropMode, WindowClass, create_window},
    };
    use x11rb::{
        COPY_DEPTH_FROM_PARENT, connection::Connection, protocol::xproto::GetPropertyReply,
        rust_connection::RustConnection,
    };

    fn display_box(x: i32, y: i32, width: u32, height: u32) -> DisplayImpl {
        DisplayImpl {
            id: 0,
            x,
            y,
            width,
            height,
            refresh_rate: 60.0,
            logical_bounds: None,
            wayland_uuid: None,
        }
    }

    fn display(id: u32, x: i32, y: i32, width: u32, height: u32) -> DisplayImpl {
        DisplayImpl {
            id,
            x,
            y,
            width,
            height,
            refresh_rate: 60.0,
            logical_bounds: None,
            wayland_uuid: None,
        }
    }

    fn replies(
        geometry: ReplyOutcome<(u16, u16)>,
        translation: ReplyOutcome<(i16, i16)>,
        net_wm_name: ReplyOutcome<Option<String>>,
        wm_name: ReplyOutcome<Option<String>>,
        pid: ReplyOutcome<Option<u32>>,
        wm_class: ReplyOutcome<Option<String>>,
    ) -> WindowReplies {
        WindowReplies {
            geometry,
            translation,
            net_wm_name,
            wm_name,
            pid,
            wm_class,
        }
    }

    fn kept(name: &str) -> WindowReplies {
        replies(
            ReplyOutcome::Present((100, 80)),
            ReplyOutcome::Present((10, 20)),
            ReplyOutcome::Present(Some(name.to_string())),
            ReplyOutcome::Present(None),
            ReplyOutcome::Present(Some(42)),
            ReplyOutcome::Present(Some("Bench".to_string())),
        )
    }

    fn surviving_ids(rows: Vec<(u32, WindowReplies)>) -> Vec<u32> {
        let displays = [display_box(0, 0, 1920, 1080)];
        rows.into_iter()
            .filter_map(|(id, row)| {
                parse_window_replies(row, &displays, &|pid| Some(format!("proc-{pid}"))).map(|_| id)
            })
            .collect()
    }

    fn property_reply(format: u8, value: Vec<u8>) -> GetPropertyReply {
        GetPropertyReply {
            format,
            sequence: 0,
            length: 0,
            type_: AtomEnum::CARDINAL.into(),
            bytes_after: 0,
            value_len: 0,
            value,
        }
    }

    #[test]
    fn property_text_stops_at_the_first_nul() {
        assert_eq!(property_text(b"hello\0world"), Some("hello".to_string()));
        assert_eq!(
            property_text(b"instance\0class\0"),
            Some("instance".to_string())
        );
        assert_eq!(property_text(b"plain"), Some("plain".to_string()));
    }

    #[test]
    fn property_text_rejects_empty_and_invalid_utf8() {
        assert_eq!(property_text(b""), None);
        assert_eq!(property_text(&[0]), None);
        assert_eq!(property_text(&[0xff, 0xfe]), None);
    }

    #[test]
    fn cardinal_reply_reads_the_first_native_u32() {
        let reply = property_reply(32, 0x0102_0304u32.to_ne_bytes().to_vec());
        assert_eq!(cardinal_from_reply(&reply), Some(0x0102_0304));
    }

    #[test]
    fn cardinal_reply_rejects_a_non_32bit_format() {
        let reply = property_reply(8, 0x0102_0304u32.to_ne_bytes().to_vec());
        assert_eq!(cardinal_from_reply(&reply), None);
    }

    #[test]
    fn bad_window_and_bad_drawable_count_as_vanished() {
        assert!(is_vanished_error_kind(ErrorKind::Window));
        assert!(is_vanished_error_kind(ErrorKind::Drawable));
        assert!(!is_vanished_error_kind(ErrorKind::Atom));
        assert!(!is_vanished_error_kind(ErrorKind::Match));
    }

    #[test]
    fn vanished_window_is_skipped_and_neighbors_stay() {
        let mut vanished = kept("gone");
        vanished.geometry = ReplyOutcome::Vanished;
        assert_eq!(
            surviving_ids(vec![(1, kept("one")), (2, vanished), (3, kept("three"))]),
            vec![1, 3]
        );
    }

    #[test]
    fn vanished_property_after_geometry_skips_only_that_window() {
        let mut vanished = kept("gone");
        vanished.pid = ReplyOutcome::Vanished;
        assert_eq!(
            surviving_ids(vec![(1, kept("one")), (2, vanished), (3, kept("three"))]),
            vec![1, 3]
        );
    }

    #[test]
    fn missing_geometry_skips_that_window_only() {
        let mut missing = kept("gone");
        missing.geometry = ReplyOutcome::Missing;
        assert_eq!(
            surviving_ids(vec![(1, kept("one")), (2, missing), (3, kept("three"))]),
            vec![1, 3]
        );
    }

    #[test]
    fn wm_name_fills_in_when_net_wm_name_is_absent() {
        let displays = [display_box(0, 0, 1920, 1080)];
        let row = replies(
            ReplyOutcome::Present((40, 40)),
            ReplyOutcome::Present((0, 0)),
            ReplyOutcome::Present(None),
            ReplyOutcome::Present(Some("legacy".to_string())),
            ReplyOutcome::Present(None),
            ReplyOutcome::Present(Some("Legacy".to_string())),
        );
        let parsed = parse_window_replies(row, &displays, &|_| None).expect("window");
        assert_eq!(parsed.name, "legacy");
        assert_eq!(parsed.owner_name.as_deref(), Some("Legacy"));
        assert_eq!(parsed.owner_pid, None);
    }

    #[test]
    fn owner_name_prefers_the_process_name() {
        assert_eq!(
            resolve_owner_name(Some(7), Some("class".into()), &|_| Some("from-proc".into())),
            Some("from-proc".into())
        );
        assert_eq!(
            resolve_owner_name(Some(7), Some("class".into()), &|_| None),
            Some("class".into())
        );
        assert_eq!(
            resolve_owner_name(None, Some("class".into()), &|_| Some("unused".into())),
            Some("class".into())
        );
    }

    #[test]
    fn zero_size_and_offscreen_windows_are_skipped() {
        let displays = [display_box(0, 0, 200, 200)];
        assert!(parse_window_replies(kept("zero"), &displays, &|_| None).is_some());
        let mut zero = kept("zero");
        zero.geometry = ReplyOutcome::Present((0, 40));
        assert!(parse_window_replies(zero, &displays, &|_| None).is_none());
        let mut offscreen = kept("off");
        offscreen.translation = ReplyOutcome::Present((1000, 1000));
        assert!(parse_window_replies(offscreen, &displays, &|_| None).is_none());
    }

    fn lock_shared_x11_display() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    #[ignore = "needs an X server; run under Xvfb"]
    fn snapshot_matches_per_field_queries() {
        let _x11_display = lock_shared_x11_display();
        let (conn, screen_num) = x11rb::connect(None).expect("X11 connection");
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let mut windows = Vec::new();
        for index in 0..4u32 {
            let window = conn.generate_id().expect("window id");
            create_window(
                &conn,
                COPY_DEPTH_FROM_PARENT,
                window,
                root,
                i16::try_from(index * 30).unwrap_or(0),
                10,
                80,
                60,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new().background_pixel(screen.white_pixel),
            )
            .expect("create_window")
            .check()
            .expect("create accepted");
            let name = format!("snap-{index}");
            let class = format!("inst-{index}\0Bench\0");
            let pid = std::process::id().to_ne_bytes();
            let net_wm_name = intern(&conn, "_NET_WM_NAME");
            let wm_name = AtomEnum::WM_NAME.into();
            let wm_class = AtomEnum::WM_CLASS.into();
            let net_wm_pid = intern(&conn, "_NET_WM_PID");
            replace_property(
                &conn,
                window,
                net_wm_name,
                AtomEnum::STRING.into(),
                8,
                name.as_bytes(),
            );
            replace_property(
                &conn,
                window,
                wm_name,
                AtomEnum::STRING.into(),
                8,
                name.as_bytes(),
            );
            replace_property(
                &conn,
                window,
                wm_class,
                AtomEnum::STRING.into(),
                8,
                class.as_bytes(),
            );
            replace_property(
                &conn,
                window,
                net_wm_pid,
                AtomEnum::CARDINAL.into(),
                32,
                &pid,
            );
            conn.map_window(window)
                .expect("map")
                .check()
                .expect("map accepted");
            windows.push(window);
        }
        let stale = windows.remove(1);
        conn.destroy_window(stale)
            .expect("destroy")
            .check()
            .expect("destroy accepted");
        let mut listed = windows.clone();
        listed.insert(1, stale);
        let stacking = intern(&conn, "_NET_CLIENT_LIST_STACKING");
        let client_list = intern(&conn, "_NET_CLIENT_LIST");
        let mut bytes = Vec::with_capacity(listed.len() * 4);
        for window in &listed {
            bytes.extend_from_slice(&window.to_ne_bytes());
        }
        replace_property(&conn, root, stacking, AtomEnum::WINDOW.into(), 32, &bytes);
        replace_property(
            &conn,
            root,
            client_list,
            AtomEnum::WINDOW.into(),
            32,
            &bytes,
        );
        conn.flush().expect("flush");

        let snapshots = WindowImpl::list_x11_snapshots().expect("x11 snapshots");
        let snapshot_ids = snapshots
            .iter()
            .map(|snapshot| snapshot.window.0.0)
            .filter(|id| listed.contains(id))
            .collect::<Vec<_>>();
        assert_eq!(snapshot_ids, windows, "stale window id must be skipped");

        let listed_ids = WindowImpl::list()
            .into_iter()
            .map(|window| window.0)
            .filter(|id| listed.contains(id))
            .collect::<Vec<_>>();
        assert_eq!(listed_ids, snapshot_ids);

        for snapshot in snapshots
            .iter()
            .filter(|snapshot| windows.contains(&snapshot.window.0.0))
        {
            let handle = WindowImpl(snapshot.window.0.0);
            assert_eq!(handle.name().as_deref(), Some(snapshot.name.as_str()));
            assert_eq!(handle.owner_name(), snapshot.owner_name);
            assert_eq!(handle.owner_pid(), snapshot.owner_pid);
            assert_eq!(snapshot.owner_pid, Some(std::process::id()));
            let bounds = handle.physical_bounds().expect("bounds");
            assert_eq!(bounds.position().x(), snapshot.bounds.position().x());
            assert_eq!(bounds.position().y(), snapshot.bounds.position().y());
            assert_eq!(bounds.size().width(), snapshot.bounds.size().width());
            assert_eq!(bounds.size().height(), snapshot.bounds.size().height());
            assert_eq!(
                handle.display().map(|display| display.raw_id()),
                Some(snapshot.display.raw_id())
            );
        }

        for window in windows {
            if let Ok(cookie) = conn.destroy_window(window) {
                let _ = cookie.check();
            }
        }
        let _ = conn.flush();
    }

    #[test]
    #[ignore = "needs an X server; run under Xvfb"]
    fn stale_client_list_falls_back_to_the_window_tree() {
        let _x11_display = lock_shared_x11_display();
        let (conn, screen_num) = x11rb::connect(None).expect("X11 connection");
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let white = screen.white_pixel;
        let window_a = open_named_window(&conn, root, white, 0, 20, 20);
        let window_b = open_named_window(&conn, root, white, 1, 200, 20);
        let guard = MappedWindows {
            conn,
            windows: vec![window_a, window_b],
        };
        publish_client_list(&guard.conn, root, &[window_a]);
        guard
            .conn
            .warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, 240, 50)
            .expect("warp")
            .check()
            .expect("warp accepted");

        assert_eq!(snapshot_ids(), vec![window_a]);
        assert_eq!(list_ids(), vec![window_a]);
        assert_eq!(
            WindowImpl::topmost_x11_snapshot_at_cursor()
                .map(|found| found.map(|snapshot| snapshot.window.0.0)),
            Some(None)
        );

        let decoy = guard.conn.generate_id().expect("decoy id");
        create_window(
            &guard.conn,
            COPY_DEPTH_FROM_PARENT,
            decoy,
            root,
            400,
            20,
            40,
            40,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().background_pixel(white),
        )
        .expect("create decoy")
        .check()
        .expect("decoy accepted");
        guard
            .conn
            .destroy_window(decoy)
            .expect("destroy decoy")
            .check()
            .expect("decoy destroyed");
        publish_client_list(&guard.conn, root, &[decoy]);

        let listed = list_ids();
        assert!(
            listed.contains(&window_a) && listed.contains(&window_b),
            "list missed a live window: {listed:?}"
        );
        assert!(
            !listed.contains(&decoy),
            "destroyed client-list id survived: {listed:?}"
        );
        assert_eq!(snapshot_ids(), listed);
        assert_eq!(
            WindowImpl::topmost_x11_snapshot_at_cursor()
                .map(|found| found.map(|snapshot| snapshot.window.0.0)),
            Some(Some(window_b))
        );
    }

    struct MappedWindows {
        conn: RustConnection,
        windows: Vec<u32>,
    }

    impl Drop for MappedWindows {
        fn drop(&mut self) {
            for window in &self.windows {
                if let Ok(cookie) = self.conn.destroy_window(*window) {
                    let _ = cookie.check();
                }
            }
            let _ = self.conn.flush();
        }
    }

    fn open_named_window(
        conn: &RustConnection,
        root: u32,
        white: u32,
        index: u32,
        x: i16,
        y: i16,
    ) -> u32 {
        let window = conn.generate_id().expect("window id");
        create_window(
            conn,
            COPY_DEPTH_FROM_PARENT,
            window,
            root,
            x,
            y,
            80,
            60,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().background_pixel(white),
        )
        .expect("create_window")
        .check()
        .expect("create accepted");
        let name = format!("tree-fallback-{index}");
        let class = format!("tree-{index}\0Bench\0");
        let pid = std::process::id().to_ne_bytes();
        replace_property(
            conn,
            window,
            intern(conn, "_NET_WM_NAME"),
            AtomEnum::STRING.into(),
            8,
            name.as_bytes(),
        );
        replace_property(
            conn,
            window,
            AtomEnum::WM_NAME.into(),
            AtomEnum::STRING.into(),
            8,
            name.as_bytes(),
        );
        replace_property(
            conn,
            window,
            AtomEnum::WM_CLASS.into(),
            AtomEnum::STRING.into(),
            8,
            class.as_bytes(),
        );
        replace_property(
            conn,
            window,
            intern(conn, "_NET_WM_PID"),
            AtomEnum::CARDINAL.into(),
            32,
            &pid,
        );
        conn.map_window(window)
            .expect("map")
            .check()
            .expect("map accepted");
        window
    }

    fn publish_client_list(conn: &RustConnection, root: u32, windows: &[u32]) {
        let mut bytes = Vec::with_capacity(windows.len() * 4);
        for window in windows {
            bytes.extend_from_slice(&window.to_ne_bytes());
        }
        replace_property(
            conn,
            root,
            intern(conn, "_NET_CLIENT_LIST_STACKING"),
            AtomEnum::WINDOW.into(),
            32,
            &bytes,
        );
        replace_property(
            conn,
            root,
            intern(conn, "_NET_CLIENT_LIST"),
            AtomEnum::WINDOW.into(),
            32,
            &bytes,
        );
        conn.flush().expect("flush");
    }

    fn snapshot_ids() -> Vec<u32> {
        WindowImpl::list_x11_snapshots()
            .expect("x11 snapshots")
            .into_iter()
            .map(|snapshot| snapshot.window.0.0)
            .collect()
    }

    fn list_ids() -> Vec<u32> {
        WindowImpl::list()
            .into_iter()
            .map(|window| window.0)
            .collect()
    }

    fn intern(conn: &RustConnection, name: &str) -> u32 {
        conn.intern_atom(false, name.as_bytes())
            .expect("intern")
            .reply()
            .expect("intern reply")
            .atom
    }

    fn replace_property(
        conn: &RustConnection,
        window: u32,
        property: u32,
        type_: u32,
        format: u8,
        data: &[u8],
    ) {
        let data_len = match format {
            8 => u32::try_from(data.len()).unwrap_or(0),
            32 => u32::try_from(data.len() / 4).unwrap_or(0),
            _ => 0,
        };
        conn.change_property(
            PropMode::REPLACE,
            window,
            property,
            type_,
            format,
            data_len,
            data,
        )
        .expect("change_property")
        .check()
        .expect("property accepted");
    }

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> PhysicalBounds {
        PhysicalBounds::new(
            PhysicalPosition::new(x, y),
            PhysicalSize::new(width, height),
        )
    }

    #[test]
    fn window_center_in_monitor_gap_still_resolves_to_visible_display() {
        let displays = [display(0, 0, 0, 1000, 800), display(1, 1200, 0, 1000, 800)];
        let window = bounds(900.0, 100.0, 350.0, 200.0);
        assert_eq!(display_for_bounds(window, &displays).unwrap().id, 0);
    }

    #[test]
    fn window_uses_largest_overlap_on_offset_monitors() {
        let displays = [
            display(0, -1920, 0, 1920, 1080),
            display(1, 0, -900, 1440, 900),
        ];
        let window = bounds(-150.0, -100.0, 400.0, 300.0);
        assert_eq!(display_for_bounds(window, &displays).unwrap().id, 0);
        assert_eq!(
            display_for_bounds(window, &[displays[1], displays[0]])
                .unwrap()
                .id,
            0
        );
        assert_eq!(
            display_for_bounds(bounds(-150.0, -200.0, 400.0, 300.0), &displays)
                .unwrap()
                .id,
            1
        );
    }

    #[test]
    fn nonoverlapping_and_edge_touching_windows_have_no_display() {
        let displays = [display(0, 0, 0, 1920, 1080)];
        for window in [
            bounds(-320.0, 100.0, 320.0, 240.0),
            bounds(1920.0, 100.0, 320.0, 240.0),
            bounds(100.0, -240.0, 320.0, 240.0),
            bounds(100.0, 1080.0, 320.0, 240.0),
            bounds(-400.0, -400.0, 320.0, 240.0),
        ] {
            assert!(display_for_bounds(window, &displays).is_none());
        }
        assert!(display_for_bounds(bounds(0.0, 0.0, 320.0, 240.0), &[]).is_none());
    }

    #[test]
    fn spanning_window_resolves_to_the_display_it_overlaps_most() {
        let displays = [
            display(0, -1920, 0, 1920, 1080),
            display(1, 0, -900, 1440, 900),
        ];
        let parsed = parse_window_replies(placed(-150, -100, 400, 300), &displays, &|_| None)
            .expect("window");
        assert_eq!(parsed.display.id, 0);
        let parsed = parse_window_replies(
            placed(-150, -100, 400, 300),
            &[displays[1], displays[0]],
            &|_| None,
        )
        .expect("window");
        assert_eq!(parsed.display.id, 0);
        let parsed = parse_window_replies(placed(-150, -200, 400, 300), &displays, &|_| None)
            .expect("window");
        assert_eq!(parsed.display.id, 1);

        let gapped = [display(0, 0, 0, 1000, 800), display(1, 1200, 0, 1000, 800)];
        let parsed =
            parse_window_replies(placed(900, 100, 350, 200), &gapped, &|_| None).expect("window");
        assert_eq!(parsed.display.id, 0);
    }

    fn placed(x: i16, y: i16, width: u16, height: u16) -> WindowReplies {
        replies(
            ReplyOutcome::Present((width, height)),
            ReplyOutcome::Present((x, y)),
            ReplyOutcome::Present(Some("span".to_string())),
            ReplyOutcome::Present(None),
            ReplyOutcome::Present(None),
            ReplyOutcome::Present(Some("Span".to_string())),
        )
    }
}
