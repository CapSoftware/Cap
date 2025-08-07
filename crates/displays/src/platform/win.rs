use std::{mem, str::FromStr};

use windows::{
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, TRUE},
        Graphics::Gdi::{
            DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplayMonitors, EnumDisplaySettingsW,
            GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
            MONITORINFOEXW, MonitorFromPoint,
        },
        Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
        System::{
            Registry::{
                HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ, RegCloseKey, RegOpenKeyExW,
                RegQueryValueExW,
            },
            Threading::{
                GetCurrentProcessId, OpenProcess, PROCESS_NAME_FORMAT,
                PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
            },
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetCursorPos, GetWindowRect, GetWindowThreadProcessId, IsIconic,
            IsWindowVisible, WindowFromPoint,
        },
    },
    core::{BOOL, PCWSTR, PWSTR},
};

use crate::bounds::{LogicalBounds, LogicalPosition, LogicalSize, PhysicalSize};

// Windows coordinate system notes:
// Origin is top-left of primary display. Right and down are positive.

#[derive(Clone, Copy)]
pub struct DisplayImpl(HMONITOR);

impl DisplayImpl {
    pub fn primary() -> Self {
        // Find the primary monitor by checking the MONITORINFOF_PRIMARY flag
        const MONITORINFOF_PRIMARY: u32 = 1u32;

        for display in Self::list() {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

            unsafe {
                if GetMonitorInfoW(display.0, &mut info as *mut _ as *mut _).as_bool() {
                    if (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0 {
                        return display;
                    }
                }
            }
        }

        // Fallback to the old method if no primary monitor is found
        let point = POINT { x: 0, y: 0 };
        let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
        Self(monitor)
    }

    pub fn list() -> Vec<Self> {
        unsafe extern "system" fn monitor_enum_proc(
            hmonitor: HMONITOR,
            _hdc: HDC,
            _lprc_clip: *mut RECT,
            lparam: LPARAM,
        ) -> BOOL {
            let list = unsafe { &mut *(lparam.0 as *mut Vec<DisplayImpl>) };
            list.push(DisplayImpl(hmonitor));
            TRUE
        }

        let mut list = vec![];
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(monitor_enum_proc),
                LPARAM(std::ptr::addr_of_mut!(list) as isize),
            );
        }

        list
    }

    pub fn inner(&self) -> HMONITOR {
        self.0
    }

    pub fn raw_id(&self) -> DisplayIdImpl {
        DisplayIdImpl(self.0.0 as u64)
    }

    pub fn id(&self) -> String {
        (self.0.0 as u64).to_string()
    }

    pub fn from_id(id: String) -> Option<Self> {
        let parsed_id = id.parse::<u64>().ok()?;
        Self::list().into_iter().find(|d| d.raw_id().0 == parsed_id)
    }

    pub fn logical_size(&self) -> LogicalSize {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe {
            if GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _).as_bool() {
                let rect = info.monitorInfo.rcMonitor;
                LogicalSize {
                    width: (rect.right - rect.left) as f64,
                    height: (rect.bottom - rect.top) as f64,
                }
            } else {
                LogicalSize {
                    width: 0.0,
                    height: 0.0,
                }
            }
        }
    }

    pub fn logical_position_raw(&self) -> LogicalPosition {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe {
            if GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _).as_bool() {
                let rect = info.monitorInfo.rcMonitor;
                LogicalPosition {
                    x: rect.left as f64,
                    y: rect.top as f64,
                }
            } else {
                LogicalPosition { x: 0.0, y: 0.0 }
            }
        }
    }

    pub fn get_containing_cursor() -> Option<Self> {
        let cursor = get_cursor_position()?;
        let point = POINT {
            x: cursor.x() as i32,
            y: cursor.y() as i32,
        };

        let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONULL) };
        if monitor.0 as usize != 0 {
            Some(Self(monitor))
        } else {
            None
        }
    }

    pub fn physical_size(&self) -> PhysicalSize {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe {
            if GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _).as_bool() {
                let device_name = info.szDevice;
                let mut devmode = DEVMODEW::default();
                devmode.dmSize = mem::size_of::<DEVMODEW>() as u16;

                if EnumDisplaySettingsW(
                    PCWSTR(device_name.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut devmode,
                )
                .as_bool()
                {
                    PhysicalSize {
                        width: devmode.dmPelsWidth as f64,
                        height: devmode.dmPelsHeight as f64,
                    }
                } else {
                    PhysicalSize {
                        width: 0.0,
                        height: 0.0,
                    }
                }
            } else {
                PhysicalSize {
                    width: 0.0,
                    height: 0.0,
                }
            }
        }
    }

    pub fn refresh_rate(&self) -> f64 {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe {
            if GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _).as_bool() {
                let device_name = info.szDevice;
                let mut devmode = DEVMODEW::default();
                devmode.dmSize = mem::size_of::<DEVMODEW>() as u16;

                if EnumDisplaySettingsW(
                    PCWSTR(device_name.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut devmode,
                )
                .as_bool()
                {
                    devmode.dmDisplayFrequency as f64
                } else {
                    0.0
                }
            } else {
                0.0
            }
        }
    }

    pub fn name(&self) -> String {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe {
            if GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _).as_bool() {
                // Convert the device name from wide string to String
                let device_name = &info.szDevice;
                let null_pos = device_name
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(device_name.len());
                let device_name_str = String::from_utf16_lossy(&device_name[..null_pos]);

                // Try to get friendly name from registry
                if let Some(friendly_name) = self.get_friendly_name_from_registry(&device_name_str)
                {
                    return friendly_name;
                }

                // Fallback to device name
                device_name_str
            } else {
                format!("Unknown Display")
            }
        }
    }

    fn get_friendly_name_from_registry(&self, device_name: &str) -> Option<String> {
        unsafe {
            // Registry path for display devices
            let registry_path = format!(
                "SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\{}",
                device_name.replace("\\\\.\\", "")
            );
            let registry_path_wide: Vec<u16> = registry_path
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            let mut key: HKEY = HKEY::default();
            if RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(registry_path_wide.as_ptr()),
                0,
                KEY_READ,
                &mut key,
            )
            .is_ok()
            {
                // Try to get DeviceDesc value
                let value_name = "DeviceDesc\0".encode_utf16().collect::<Vec<u16>>();
                let mut buffer = [0u16; 256];
                let mut buffer_size = (buffer.len() * 2) as u32;
                let mut value_type = REG_SZ;

                if RegQueryValueExW(
                    key,
                    PCWSTR(value_name.as_ptr()),
                    None,
                    Some(&mut value_type),
                    Some(buffer.as_mut_ptr() as *mut u8),
                    Some(&mut buffer_size),
                )
                .is_ok()
                {
                    let _ = RegCloseKey(key);
                    let null_pos = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                    let desc = String::from_utf16_lossy(&buffer[..null_pos]);

                    // DeviceDesc often contains a prefix like "PCI\VEN_...", extract just the display name
                    if let Some(semicolon_pos) = desc.rfind(';') {
                        return Some(desc[semicolon_pos + 1..].trim().to_string());
                    }
                    return Some(desc);
                }
                let _ = RegCloseKey(key);
            }
        }
        None
    }
}

fn get_cursor_position() -> Option<LogicalPosition> {
    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut point).is_ok() {
            Some(LogicalPosition {
                x: point.x as f64,
                y: point.y as f64,
            })
        } else {
            None
        }
    }
}

#[derive(Clone, Copy)]
pub struct WindowImpl(HWND);

impl WindowImpl {
    pub fn list() -> Vec<Self> {
        struct EnumContext {
            list: Vec<WindowImpl>,
            current_process_id: u32,
        }

        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let context = unsafe { &mut *(lparam.0 as *mut EnumContext) };

            // Only include visible windows
            if unsafe { IsWindowVisible(hwnd) }.as_bool() {
                // Get the process ID of this window
                let mut process_id = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };

                // Only add the window if it doesn't belong to the current process
                if process_id != context.current_process_id {
                    context.list.push(WindowImpl(hwnd));
                }
            }

            TRUE
        }

        let mut context = EnumContext {
            list: vec![],
            current_process_id: unsafe { GetCurrentProcessId() },
        };

        unsafe {
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM(std::ptr::addr_of_mut!(context) as isize),
            );
        }

        context.list
    }

    pub fn get_topmost_at_cursor() -> Option<Self> {
        let cursor = get_cursor_position()?;
        let point = POINT {
            x: cursor.x() as i32,
            y: cursor.y() as i32,
        };

        struct HitTestData {
            pt: POINT,
            found: Option<HWND>,
            current_process_id: u32,
        }

        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let data = unsafe { &mut *(lparam.0 as *mut HitTestData) };

            // Skip invisible or minimized windows
            if !unsafe { IsWindowVisible(hwnd) }.as_bool() || unsafe { IsIconic(hwnd) }.as_bool() {
                return TRUE;
            }

            // Skip own process windows
            let mut process_id = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
            if process_id == data.current_process_id {
                return TRUE;
            }

            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
                if data.pt.x >= rect.left
                    && data.pt.x < rect.right
                    && data.pt.y >= rect.top
                    && data.pt.y < rect.bottom
                {
                    data.found = Some(hwnd);
                    return windows::Win32::Foundation::FALSE; // Found match, stop enumerating
                }
            }

            TRUE
        }

        let mut data = HitTestData {
            pt: point,
            found: None,
            current_process_id: unsafe { GetCurrentProcessId() },
        };

        unsafe {
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM(std::ptr::addr_of_mut!(data) as isize),
            );
        }

        data.found.map(Self)
    }

    pub fn list_containing_cursor() -> Vec<Self> {
        let Some(cursor) = get_cursor_position() else {
            return vec![];
        };

        Self::list()
            .into_iter()
            .filter_map(|window| {
                let bounds = window.bounds()?;
                let contains_cursor = cursor.x() > bounds.position().x()
                    && cursor.x() < bounds.position().x() + bounds.size().width()
                    && cursor.y() > bounds.position().y()
                    && cursor.y() < bounds.position().y() + bounds.size().height();

                contains_cursor.then_some(window)
            })
            .collect()
    }

    pub fn id(&self) -> WindowIdImpl {
        WindowIdImpl(self.0.0 as u64)
    }

    pub fn owner_name(&self) -> Option<String> {
        unsafe {
            let mut process_id = 0u32;
            GetWindowThreadProcessId(self.0, Some(&mut process_id));

            if process_id == 0 {
                return None;
            }

            let process_handle =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;

            let mut buffer = [0u16; 1024];
            let mut buffer_size = buffer.len() as u32;

            let result = QueryFullProcessImageNameW(
                process_handle,
                PROCESS_NAME_FORMAT::default(),
                PWSTR(buffer.as_mut_ptr()),
                &mut buffer_size,
            );

            let _ = CloseHandle(process_handle);

            if result.is_ok() && buffer_size > 0 {
                let path_str = String::from_utf16_lossy(&buffer[..buffer_size as usize]);

                // Try to get the friendly name from version info first
                if let Some(friendly_name) = self.get_file_description(&path_str) {
                    return Some(friendly_name);
                }

                // Fallback to file stem
                std::path::Path::new(&path_str)
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
            } else {
                None
            }
        }
    }

    fn get_file_description(&self, file_path: &str) -> Option<String> {
        unsafe {
            let wide_path: Vec<u16> = file_path.encode_utf16().chain(std::iter::once(0)).collect();

            let size = GetFileVersionInfoSizeW(PCWSTR(wide_path.as_ptr()), None);
            if size == 0 {
                return None;
            }

            let mut buffer = vec![0u8; size as usize];
            if !GetFileVersionInfoW(
                PCWSTR(wide_path.as_ptr()),
                0,
                size,
                buffer.as_mut_ptr() as *mut _,
            )
            .as_bool()
            {
                return None;
            }

            let mut len = 0u32;
            let mut value_ptr: *mut u16 = std::ptr::null_mut();

            let query = "\\StringFileInfo\\040904B0\\FileDescription\0"
                .encode_utf16()
                .collect::<Vec<u16>>();

            if VerQueryValueW(
                buffer.as_ptr() as *const _,
                PCWSTR(query.as_ptr()),
                &mut value_ptr as *mut _ as *mut *mut _,
                &mut len,
            )
            .as_bool()
                && !value_ptr.is_null()
                && len > 0
            {
                let slice = std::slice::from_raw_parts(value_ptr, len as usize - 1);
                Some(String::from_utf16_lossy(slice))
            } else {
                None
            }
        }
    }

    pub fn app_icon(&self) -> Option<Vec<u8>> {
        // Icon functionality not implemented for Windows yet
        // This would require complex HICON to PNG/ICO conversion
        None
    }

    pub fn bounds(&self) -> Option<LogicalBounds> {
        let mut rect = RECT::default();
        unsafe {
            if GetWindowRect(self.0, &mut rect).is_ok() {
                Some(LogicalBounds {
                    position: LogicalPosition {
                        x: rect.left as f64,
                        y: rect.top as f64,
                    },
                    size: LogicalSize {
                        width: (rect.right - rect.left) as f64,
                        height: (rect.bottom - rect.top) as f64,
                    },
                })
            } else {
                None
            }
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct DisplayIdImpl(u64);

impl std::fmt::Display for DisplayIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DisplayIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse()
            .map(Self)
            .map_err(|_| "Invalid display ID".to_string())
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct WindowIdImpl(u64);

impl std::fmt::Display for WindowIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for WindowIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse()
            .map(Self)
            .map_err(|_| "Invalid window ID".to_string())
    }
}
