use std::str::FromStr;

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
    width_mm: u32,
    height_mm: u32,
    refresh_rate: f64,
    is_primary: bool,
    name: [u8; 128],
    name_len: usize,
}

unsafe impl Send for DisplayImpl {}

impl DisplayImpl {
    pub fn primary() -> Self {
        Self::list()
            .into_iter()
            .find(|d| d.is_primary)
            .unwrap_or_else(|| Self::list().into_iter().next().unwrap_or(Self::fallback()))
    }

    fn fallback() -> Self {
        Self {
            id: 0,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            width_mm: 530,
            height_mm: 300,
            refresh_rate: 60.0,
            is_primary: true,
            name: [0u8; 128],
            name_len: 0,
        }
    }

    pub fn list() -> Vec<Self> {
        list_displays_x11().unwrap_or_else(|| vec![Self::fallback()])
    }

    pub fn raw_id(&self) -> DisplayIdImpl {
        DisplayIdImpl(self.id)
    }

    pub fn name(&self) -> Option<String> {
        if self.name_len > 0 {
            Some(
                String::from_utf8_lossy(&self.name[..self.name_len]).to_string(),
            )
        } else {
            Some(format!("Display {}", self.id))
        }
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(PhysicalSize::new(self.width as f64, self.height as f64))
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        Some(LogicalSize::new(self.width as f64, self.height as f64))
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        Some(LogicalBounds::new(
            LogicalPosition::new(self.x as f64, self.y as f64),
            LogicalSize::new(self.width as f64, self.height as f64),
        ))
    }

    pub fn logical_position(&self) -> LogicalPosition {
        LogicalPosition::new(self.x as f64, self.y as f64)
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        Some(PhysicalBounds::new(
            PhysicalPosition::new(self.x as f64, self.y as f64),
            PhysicalSize::new(self.width as f64, self.height as f64),
        ))
    }

    pub fn refresh_rate(&self) -> f64 {
        self.refresh_rate
    }

    pub fn scale(&self) -> Option<f64> {
        Some(1.0)
    }

    pub fn get_containing_cursor() -> Option<Self> {
        let cursor_pos = get_cursor_position_x11()?;
        Self::list().into_iter().find(|d| {
            cursor_pos.0 >= d.x
                && cursor_pos.0 < d.x + d.width as i32
                && cursor_pos.1 >= d.y
                && cursor_pos.1 < d.y + d.height as i32
        })
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
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
            .map_err(|e| format!("Invalid display ID: {e}"))
    }
}

#[derive(Clone, Copy)]
pub struct WindowImpl {
    id: u64,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    name_buf: [u8; 256],
    name_len: usize,
    owner_buf: [u8; 256],
    owner_len: usize,
    pid: u32,
    is_visible: bool,
}

unsafe impl Send for WindowImpl {}

impl WindowImpl {
    pub fn list() -> Vec<Self> {
        list_windows_x11().unwrap_or_default()
    }

    pub fn list_containing_cursor() -> Vec<Self> {
        let Some(cursor_pos) = get_cursor_position_x11() else {
            return Vec::new();
        };
        Self::list()
            .into_iter()
            .filter(|w| {
                cursor_pos.0 >= w.x
                    && cursor_pos.0 < w.x + w.width as i32
                    && cursor_pos.1 >= w.y
                    && cursor_pos.1 < w.y + w.height as i32
            })
            .collect()
    }

    pub fn get_topmost_at_cursor() -> Option<Self> {
        Self::list_containing_cursor().into_iter().next()
    }

    pub fn id(&self) -> WindowIdImpl {
        WindowIdImpl(self.id)
    }

    pub fn name(&self) -> Option<String> {
        if self.name_len > 0 {
            Some(String::from_utf8_lossy(&self.name_buf[..self.name_len]).to_string())
        } else {
            None
        }
    }

    pub fn owner_name(&self) -> Option<String> {
        if self.owner_len > 0 {
            Some(String::from_utf8_lossy(&self.owner_buf[..self.owner_len]).to_string())
        } else {
            None
        }
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(PhysicalSize::new(self.width as f64, self.height as f64))
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        Some(LogicalSize::new(self.width as f64, self.height as f64))
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        Some(PhysicalBounds::new(
            PhysicalPosition::new(self.x as f64, self.y as f64),
            PhysicalSize::new(self.width as f64, self.height as f64),
        ))
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        Some(LogicalBounds::new(
            LogicalPosition::new(self.x as f64, self.y as f64),
            LogicalSize::new(self.width as f64, self.height as f64),
        ))
    }

    pub fn display(&self) -> Option<DisplayImpl> {
        let center_x = self.x + self.width as i32 / 2;
        let center_y = self.y + self.height as i32 / 2;

        DisplayImpl::list().into_iter().find(|d| {
            center_x >= d.x
                && center_x < d.x + d.width as i32
                && center_y >= d.y
                && center_y < d.y + d.height as i32
        }).or_else(|| DisplayImpl::list().into_iter().next())
    }

    pub fn app_icon(&self) -> Option<Vec<u8>> {
        None
    }

    pub fn is_valid(&self) -> bool {
        self.is_visible && self.width > 0 && self.height > 0
    }

    pub fn is_on_screen(&self) -> bool {
        self.is_visible
    }

    pub fn level(&self) -> Option<i32> {
        Some(0)
    }

    pub fn bundle_identifier(&self) -> Option<String> {
        None
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WindowIdImpl(u64);

impl std::fmt::Display for WindowIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for WindowIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(Self)
            .map_err(|e| format!("Invalid window ID: {e}"))
    }
}

fn list_displays_x11() -> Option<Vec<DisplayImpl>> {
    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }

        let screen_count = x11::xlib::XScreenCount(display);
        let mut displays = Vec::new();

        let rr_available = {
            let mut event_base = 0;
            let mut error_base = 0;
            x11::xrandr::XRRQueryExtension(display, &mut event_base, &mut error_base) != 0
        };

        if rr_available {
            let root = x11::xlib::XDefaultRootWindow(display);
            let resources = x11::xrandr::XRRGetScreenResources(display, root);
            if !resources.is_null() {
                let primary = x11::xrandr::XRRGetOutputPrimary(display, root);

                for i in 0..(*resources).noutput {
                    let output_id = *(*resources).outputs.add(i as usize);
                    let output_info =
                        x11::xrandr::XRRGetOutputInfo(display, resources, output_id);
                    if output_info.is_null() {
                        continue;
                    }

                    if (*output_info).connection != 0 || (*output_info).crtc == 0 {
                        x11::xrandr::XRRFreeOutputInfo(output_info);
                        continue;
                    }

                    let crtc_info =
                        x11::xrandr::XRRGetCrtcInfo(display, resources, (*output_info).crtc);
                    if crtc_info.is_null() {
                        x11::xrandr::XRRFreeOutputInfo(output_info);
                        continue;
                    }

                    let refresh = if (*crtc_info).mode != 0 {
                        let mut rate = 60.0f64;
                        for m in 0..(*resources).nmode {
                            let mode = *(*resources).modes.add(m as usize);
                            if mode.id == (*crtc_info).mode {
                                if mode.hTotal != 0 && mode.vTotal != 0 {
                                    rate = mode.dotClock as f64
                                        / (mode.hTotal as f64 * mode.vTotal as f64);
                                }
                                break;
                            }
                        }
                        rate
                    } else {
                        60.0
                    };

                    let name_ptr = (*output_info).name;
                    let name_len_raw = (*output_info).nameLen as usize;
                    let mut name = [0u8; 128];
                    let name_len = name_len_raw.min(128);
                    if !name_ptr.is_null() && name_len > 0 {
                        std::ptr::copy_nonoverlapping(
                            name_ptr as *const u8,
                            name.as_mut_ptr(),
                            name_len,
                        );
                    }

                    displays.push(DisplayImpl {
                        id: output_id as u32,
                        x: (*crtc_info).x,
                        y: (*crtc_info).y,
                        width: (*crtc_info).width,
                        height: (*crtc_info).height,
                        width_mm: (*output_info).mm_width as u32,
                        height_mm: (*output_info).mm_height as u32,
                        refresh_rate: refresh,
                        is_primary: output_id == primary,
                        name,
                        name_len,
                    });

                    x11::xrandr::XRRFreeCrtcInfo(crtc_info);
                    x11::xrandr::XRRFreeOutputInfo(output_info);
                }
                x11::xrandr::XRRFreeScreenResources(resources);
            }
        }

        if displays.is_empty() {
            for i in 0..screen_count {
                let screen = x11::xlib::XScreenOfDisplay(display, i);
                if screen.is_null() {
                    continue;
                }
                displays.push(DisplayImpl {
                    id: i as u32,
                    x: 0,
                    y: 0,
                    width: (*screen).width as u32,
                    height: (*screen).height as u32,
                    width_mm: (*screen).mwidth as u32,
                    height_mm: (*screen).mheight as u32,
                    refresh_rate: 60.0,
                    is_primary: i == 0,
                    name: [0u8; 128],
                    name_len: 0,
                });
            }
        }

        x11::xlib::XCloseDisplay(display);
        Some(displays)
    }
}

fn get_cursor_position_x11() -> Option<(i32, i32)> {
    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let root = x11::xlib::XDefaultRootWindow(display);
        let mut root_return = 0u64;
        let mut child_return = 0u64;
        let mut root_x = 0i32;
        let mut root_y = 0i32;
        let mut win_x = 0i32;
        let mut win_y = 0i32;
        let mut mask = 0u32;

        let result = x11::xlib::XQueryPointer(
            display,
            root,
            &mut root_return,
            &mut child_return,
            &mut root_x,
            &mut root_y,
            &mut win_x,
            &mut win_y,
            &mut mask,
        );

        x11::xlib::XCloseDisplay(display);

        if result != 0 {
            Some((root_x, root_y))
        } else {
            None
        }
    }
}

fn copy_str_to_buf(s: &str, buf: &mut [u8; 256]) -> usize {
    let bytes = s.as_bytes();
    let len = bytes.len().min(256);
    buf[..len].copy_from_slice(&bytes[..len]);
    len
}

fn list_windows_x11() -> Option<Vec<WindowImpl>> {
    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let root = x11::xlib::XDefaultRootWindow(display);

        let net_client_list = x11::xlib::XInternAtom(
            display,
            b"_NET_CLIENT_LIST_STACKING\0".as_ptr() as *const _,
            0,
        );

        let mut actual_type = 0u64;
        let mut actual_format = 0i32;
        let mut nitems = 0u64;
        let mut bytes_after = 0u64;
        let mut prop: *mut u8 = std::ptr::null_mut();

        let status = x11::xlib::XGetWindowProperty(
            display,
            root,
            net_client_list,
            0,
            1024,
            0,
            x11::xlib::XA_WINDOW,
            &mut actual_type,
            &mut actual_format,
            &mut nitems,
            &mut bytes_after,
            &mut prop,
        );

        if status != 0 || prop.is_null() || nitems == 0 {
            let net_client_list_fallback = x11::xlib::XInternAtom(
                display,
                b"_NET_CLIENT_LIST\0".as_ptr() as *const _,
                0,
            );
            let status2 = x11::xlib::XGetWindowProperty(
                display,
                root,
                net_client_list_fallback,
                0,
                1024,
                0,
                x11::xlib::XA_WINDOW,
                &mut actual_type,
                &mut actual_format,
                &mut nitems,
                &mut bytes_after,
                &mut prop,
            );
            if status2 != 0 || prop.is_null() || nitems == 0 {
                x11::xlib::XCloseDisplay(display);
                return Some(Vec::new());
            }
        }

        let window_ids =
            std::slice::from_raw_parts(prop as *const u64, nitems as usize);

        let wm_state_atom = x11::xlib::XInternAtom(
            display,
            b"_NET_WM_STATE\0".as_ptr() as *const _,
            0,
        );
        let wm_hidden_atom = x11::xlib::XInternAtom(
            display,
            b"_NET_WM_STATE_HIDDEN\0".as_ptr() as *const _,
            0,
        );
        let wm_pid_atom = x11::xlib::XInternAtom(
            display,
            b"_NET_WM_PID\0".as_ptr() as *const _,
            0,
        );

        let mut windows = Vec::new();

        for &wid in window_ids.iter().rev() {
            let mut attrs: x11::xlib::XWindowAttributes = std::mem::zeroed();
            if x11::xlib::XGetWindowAttributes(display, wid, &mut attrs) == 0 {
                continue;
            }

            let is_viewable = attrs.map_state == 2; // IsViewable
            if !is_viewable {
                continue;
            }

            let is_hidden = {
                let mut at = 0u64;
                let mut af = 0i32;
                let mut ni = 0u64;
                let mut ba = 0u64;
                let mut state_prop: *mut u8 = std::ptr::null_mut();
                let st = x11::xlib::XGetWindowProperty(
                    display,
                    wid,
                    wm_state_atom,
                    0,
                    1024,
                    0,
                    x11::xlib::XA_ATOM,
                    &mut at,
                    &mut af,
                    &mut ni,
                    &mut ba,
                    &mut state_prop,
                );
                let hidden = if st == 0 && !state_prop.is_null() && ni > 0 {
                    let atoms = std::slice::from_raw_parts(state_prop as *const u64, ni as usize);
                    let h = atoms.iter().any(|&a| a == wm_hidden_atom);
                    x11::xlib::XFree(state_prop as *mut _);
                    h
                } else {
                    false
                };
                hidden
            };

            if is_hidden {
                continue;
            }

            let mut name_buf = [0u8; 256];
            let mut name_len = 0usize;
            {
                let mut name_return: *mut i8 = std::ptr::null_mut();
                if x11::xlib::XFetchName(display, wid, &mut name_return) != 0
                    && !name_return.is_null()
                {
                    let c_str = std::ffi::CStr::from_ptr(name_return);
                    let s = c_str.to_string_lossy();
                    name_len = copy_str_to_buf(&s, &mut name_buf);
                    x11::xlib::XFree(name_return as *mut _);
                }
            }

            if name_len == 0 {
                continue;
            }

            let mut owner_buf = [0u8; 256];
            let owner_len;
            {
                let wm_class_atom = x11::xlib::XInternAtom(
                    display,
                    b"WM_CLASS\0".as_ptr() as *const _,
                    0,
                );
                let mut at = 0u64;
                let mut af = 0i32;
                let mut ni = 0u64;
                let mut ba = 0u64;
                let mut class_prop: *mut u8 = std::ptr::null_mut();
                let st = x11::xlib::XGetWindowProperty(
                    display,
                    wid,
                    wm_class_atom,
                    0,
                    1024,
                    0,
                    x11::xlib::XA_STRING,
                    &mut at,
                    &mut af,
                    &mut ni,
                    &mut ba,
                    &mut class_prop,
                );
                if st == 0 && !class_prop.is_null() && ni > 0 {
                    let data = std::slice::from_raw_parts(class_prop, ni as usize);
                    let parts: Vec<&[u8]> = data.split(|&b| b == 0).collect();
                    let class_name = if parts.len() >= 2 {
                        String::from_utf8_lossy(parts[1])
                    } else if !parts.is_empty() {
                        String::from_utf8_lossy(parts[0])
                    } else {
                        std::borrow::Cow::Borrowed("")
                    };
                    owner_len = copy_str_to_buf(&class_name, &mut owner_buf);
                    x11::xlib::XFree(class_prop as *mut _);
                } else {
                    owner_len = 0;
                }
            }

            let pid = {
                let mut at = 0u64;
                let mut af = 0i32;
                let mut ni = 0u64;
                let mut ba = 0u64;
                let mut pid_prop: *mut u8 = std::ptr::null_mut();
                let st = x11::xlib::XGetWindowProperty(
                    display,
                    wid,
                    wm_pid_atom,
                    0,
                    1,
                    0,
                    x11::xlib::XA_CARDINAL,
                    &mut at,
                    &mut af,
                    &mut ni,
                    &mut ba,
                    &mut pid_prop,
                );
                if st == 0 && !pid_prop.is_null() && ni > 0 {
                    let p = *(pid_prop as *const u32);
                    x11::xlib::XFree(pid_prop as *mut _);
                    p
                } else {
                    0
                }
            };

            let mut child_return = 0u64;
            let mut root_return = 0u64;
            let mut abs_x = 0i32;
            let mut abs_y = 0i32;
            x11::xlib::XTranslateCoordinates(
                display,
                wid,
                root,
                0,
                0,
                &mut abs_x,
                &mut abs_y,
                &mut child_return,
            );
            let _ = root_return;

            windows.push(WindowImpl {
                id: wid,
                x: abs_x,
                y: abs_y,
                width: attrs.width as u32,
                height: attrs.height as u32,
                name_buf,
                name_len,
                owner_buf,
                owner_len,
                pid,
                is_visible: true,
            });
        }

        x11::xlib::XFree(prop as *mut _);
        x11::xlib::XCloseDisplay(display);

        Some(windows)
    }
}
