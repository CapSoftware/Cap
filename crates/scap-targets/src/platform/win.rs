use std::{ffi::OsString, mem, os::windows::ffi::OsStringExt, path::PathBuf, str::FromStr};
use tracing::error;
use windows::{
    Graphics::Capture::GraphicsCaptureItem,
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, TRUE, WPARAM},
        Graphics::{
            Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
            Gdi::{
                BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap,
                CreateCompatibleDC, CreateSolidBrush, DEVMODEW, DIB_RGB_COLORS,
                DISPLAY_DEVICE_STATE_FLAGS, DISPLAY_DEVICEW, DeleteDC, DeleteObject,
                ENUM_CURRENT_SETTINGS, EnumDisplayDevicesW, EnumDisplayMonitors,
                EnumDisplaySettingsW, FillRect, GetDC, GetDIBits, GetMonitorInfoW, GetObjectA,
                HBRUSH, HDC, HGDIOBJ, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
                MONITORINFOEXW, MonitorFromPoint, MonitorFromWindow, ReleaseDC, SelectObject,
            },
        },
        Storage::FileSystem::{
            FILE_FLAGS_AND_ATTRIBUTES, GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
        },
        System::{
            Threading::{
                GetCurrentProcessId, OpenProcess, PROCESS_NAME_FORMAT,
                PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
            },
            WinRT::Graphics::Capture::IGraphicsCaptureItemInterop,
        },
        UI::{
            HiDpi::{
                GetDpiForMonitor, GetDpiForWindow, GetProcessDpiAwareness, MDT_EFFECTIVE_DPI,
                PROCESS_PER_MONITOR_DPI_AWARE,
            },
            Shell::{
                ExtractIconExW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SMALLICON,
                SHGetFileInfoW,
            },
            WindowsAndMessaging::{
                DI_FLAGS, DestroyIcon, DrawIconEx, EnumChildWindows, EnumWindows, GCLP_HICON,
                GW_HWNDNEXT, GWL_EXSTYLE, GWL_STYLE, GetClassLongPtrW, GetClassNameW,
                GetClientRect, GetCursorPos, GetDesktopWindow, GetIconInfo,
                GetLayeredWindowAttributes, GetWindow, GetWindowLongPtrW, GetWindowLongW,
                GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
                HICON, ICONINFO, IsIconic, IsWindowVisible, PrivateExtractIconsW, SendMessageW,
                WM_GETICON, WS_CHILD, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
                WS_EX_TRANSPARENT, WindowFromPoint,
            },
        },
    },
    core::{BOOL, PCWSTR, PWSTR},
};

use crate::bounds::{LogicalSize, PhysicalBounds, PhysicalPosition, PhysicalSize};

// All of this assumes PROCESS_PER_MONITOR_DPI_AWARE
//
// On Windows it's nigh impossible to get the logical position of a display
// or window, since there's no simple API that accounts for each monitor having different DPI.

static IGNORED_EXES: &'static [&str] = &[
    // As it's a system webview it isn't owned by the Cap process.
    "webview2",
    "msedgewebview2",
    // Just make sure, lol
    "cap",
];

#[derive(Clone, Copy)]
pub struct DisplayImpl(HMONITOR);

unsafe impl Send for DisplayImpl {}

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

    pub fn from_id(id: String) -> Option<Self> {
        let parsed_id = id.parse::<u64>().ok()?;
        Self::list().into_iter().find(|d| d.raw_id().0 == parsed_id)
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        let physical_size = self.physical_size()?;

        let dpi = unsafe {
            let mut dpi_x = 0;
            GetDpiForMonitor(self.0, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut 0).ok()?;
            dpi_x
        };

        let scale = dpi as f64 / 96.0;

        Some(LogicalSize::new(
            physical_size.width() / scale,
            physical_size.height() / scale,
        ))
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

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        unsafe { GetMonitorInfoW(self.0, &mut info as *mut _ as *mut _) }
            .as_bool()
            .then(|| {
                let rect = info.monitorInfo.rcMonitor;
                PhysicalBounds::new(
                    PhysicalPosition::new(rect.left as f64, rect.top as f64),
                    PhysicalSize::new(
                        rect.right as f64 - rect.left as f64,
                        rect.bottom as f64 - rect.top as f64,
                    ),
                )
            })
    }

    pub fn physical_position(&self) -> Option<PhysicalPosition> {
        Some(self.physical_bounds()?.position())
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(self.physical_bounds()?.size())
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

    pub fn name(&self) -> Option<String> {
        unsafe {
            let mut monitor_info = MONITORINFOEXW {
                monitorInfo: windows::Win32::Graphics::Gdi::MONITORINFO {
                    cbSize: mem::size_of::<MONITORINFOEXW>() as u32,
                    rcMonitor: RECT::default(),
                    rcWork: RECT::default(),
                    dwFlags: 0,
                },
                szDevice: [0; 32],
            };

            if GetMonitorInfoW(self.0, &mut monitor_info as *mut _ as *mut _).as_bool() {
                let device_name = PCWSTR::from_raw(monitor_info.szDevice.as_ptr());

                let mut display_device = DISPLAY_DEVICEW {
                    cb: mem::size_of::<DISPLAY_DEVICEW>() as u32,
                    DeviceName: [0; 32],
                    DeviceString: [0; 128],
                    StateFlags: DISPLAY_DEVICE_STATE_FLAGS(0),
                    DeviceID: [0; 128],
                    DeviceKey: [0; 128],
                };

                if EnumDisplayDevicesW(device_name, 0, &mut display_device, 0).as_bool() {
                    let device_string = display_device.DeviceString;
                    let len = device_string
                        .iter()
                        .position(|&x| x == 0)
                        .unwrap_or(device_string.len());

                    return Some(String::from_utf16_lossy(&device_string[..len]));
                }
            }
        }

        None
    }

    pub fn try_as_capture_item(&self) -> windows::core::Result<GraphicsCaptureItem> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        unsafe { interop.CreateForMonitor(self.0) }
    }
}

fn get_cursor_position() -> Option<PhysicalPosition> {
    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut point).is_ok() {
            Some(PhysicalPosition {
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

            if is_window_valid_for_enumeration(hwnd, context.current_process_id) {
                context.list.push(WindowImpl(hwnd));
            }

            TRUE
        }

        let mut context = EnumContext {
            list: vec![],
            current_process_id: unsafe { GetCurrentProcessId() },
        };

        unsafe {
            let _ = EnumChildWindows(
                Some(GetDesktopWindow()),
                Some(enum_windows_proc),
                LPARAM(std::ptr::addr_of_mut!(context) as isize),
            );
        }

        context.list
    }

    pub fn inner(&self) -> HWND {
        self.0
    }

    pub fn get_topmost_at_cursor() -> Option<Self> {
        let cursor = get_cursor_position()?;
        let point = POINT {
            x: cursor.x() as i32,
            y: cursor.y() as i32,
        };

        unsafe {
            // Use WindowFromPoint first as a quick check
            let hwnd_at_point = WindowFromPoint(point);
            if hwnd_at_point != HWND(std::ptr::null_mut()) {
                let current_process_id = GetCurrentProcessId();

                // Walk up the Z-order chain to find the topmost valid window
                let mut current_hwnd = hwnd_at_point;

                loop {
                    // Check if this window is valid for our purposes
                    if is_window_valid_for_topmost_selection(
                        current_hwnd,
                        current_process_id,
                        point,
                    ) {
                        return Some(Self(current_hwnd));
                    }

                    // Move to the next window in Z-order (towards background)
                    current_hwnd =
                        GetWindow(current_hwnd, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
                    if current_hwnd == HWND(std::ptr::null_mut()) {
                        break;
                    }

                    // Check if this window still contains the point
                    if !is_point_in_window(current_hwnd, point) {
                        continue;
                    }
                }
            }

            // Fallback to enumeration if WindowFromPoint fails
            Self::get_topmost_at_cursor_fallback(point)
        }
    }

    fn get_topmost_at_cursor_fallback(point: POINT) -> Option<Self> {
        struct HitTestData {
            pt: POINT,
            candidates: Vec<HWND>,
            current_process_id: u32,
        }

        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let data = unsafe { &mut *(lparam.0 as *mut HitTestData) };

            if is_window_valid_for_topmost_selection(hwnd, data.current_process_id, data.pt) {
                data.candidates.push(hwnd);
            }

            TRUE
        }

        let mut data = HitTestData {
            pt: point,
            candidates: Vec::new(),
            current_process_id: unsafe { GetCurrentProcessId() },
        };

        unsafe {
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM(std::ptr::addr_of_mut!(data) as isize),
            );

            // Sort candidates by Z-order (topmost first)
            data.candidates.sort_by(|&a, &b| {
                // Use GetWindowLong to check topmost status
                let a_topmost = (GetWindowLongW(a, GWL_EXSTYLE) & WS_EX_TOPMOST.0 as i32) != 0;
                let b_topmost = (GetWindowLongW(b, GWL_EXSTYLE) & WS_EX_TOPMOST.0 as i32) != 0;

                match (a_topmost, b_topmost) {
                    (true, false) => std::cmp::Ordering::Less, // a is more topmost
                    (false, true) => std::cmp::Ordering::Greater, // b is more topmost
                    _ => std::cmp::Ordering::Equal,            // Same topmost level
                }
            });

            data.candidates.first().map(|&hwnd| Self(hwnd))
        }
    }

    pub fn list_containing_cursor() -> Vec<Self> {
        let Some(cursor) = get_cursor_position() else {
            return vec![];
        };

        Self::list()
            .into_iter()
            .filter_map(|window| {
                let bounds = window.physical_bounds()?;
                bounds.contains_point(cursor).then_some(window)
            })
            .collect()
    }

    pub fn id(&self) -> WindowIdImpl {
        WindowIdImpl(self.0.0 as u64)
    }

    pub fn level(&self) -> Option<i32> {
        unsafe {
            // Windows doesn't have the same level concept as macOS, but we can approximate
            // using extended window styles and z-order information
            let ex_style = GetWindowLongW(self.0, GWL_EXSTYLE);

            // Check if window has topmost style
            if (ex_style & WS_EX_TOPMOST.0 as i32) != 0 {
                Some(3) // Higher level for topmost windows
            } else {
                Some(0) // Normal level for regular windows
            }
        }
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
                Some(0),
                size,
                buffer.as_mut_ptr() as *mut _,
            )
            .is_ok()
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
        unsafe {
            // Target size for acceptable icon quality - early termination threshold
            const GOOD_SIZE_THRESHOLD: i32 = 256;

            // Method 1: Try shell icon extraction for highest quality
            if let Some(exe_path) = self.get_executable_path() {
                if let Some(icon_data) = self.extract_shell_icon_high_res(&exe_path, 512) {
                    return Some(icon_data);
                }
            }

            // Method 2: Try executable file extraction with multiple icon sizes
            if let Some(exe_path) = self.get_executable_path() {
                if let Some(icon_data) = self.extract_executable_icons_high_res(&exe_path) {
                    return Some(icon_data);
                }
            }

            // Method 3: Try to get the window's large icon
            let large_icon = SendMessageW(
                self.0,
                WM_GETICON,
                Some(WPARAM(1usize)),
                Some(LPARAM(0isize)),
            ); // ICON_BIG = 1

            if large_icon.0 != 0 {
                if let Some(result) = self.hicon_to_png_bytes_optimized(HICON(large_icon.0 as _)) {
                    // If we got a good quality icon, return it immediately
                    if result.1 >= GOOD_SIZE_THRESHOLD {
                        return Some(result.0);
                    }
                }
            }

            // Method 4: Try executable file extraction (fallback to original method)
            if let Some(exe_path) = self.get_executable_path() {
                let wide_path: Vec<u16> =
                    exe_path.encode_utf16().chain(std::iter::once(0)).collect();

                let mut large_icon: HICON = HICON::default();
                let mut small_icon: HICON = HICON::default();

                let extracted = ExtractIconExW(
                    PCWSTR(wide_path.as_ptr()),
                    0, // Only try the first (main) icon
                    Some(&mut large_icon),
                    Some(&mut small_icon),
                    1,
                );

                if extracted > 0 {
                    // Try large icon first
                    if !large_icon.is_invalid() {
                        if let Some(result) = self.hicon_to_png_bytes_optimized(large_icon) {
                            let _ = DestroyIcon(large_icon);
                            if !small_icon.is_invalid() {
                                let _ = DestroyIcon(small_icon);
                            }
                            // Return immediately if we got a good quality icon
                            if result.1 >= GOOD_SIZE_THRESHOLD {
                                return Some(result.0);
                            }
                        }
                        let _ = DestroyIcon(large_icon);
                    }

                    // Try small icon as fallback
                    if !small_icon.is_invalid() {
                        if let Some(result) = self.hicon_to_png_bytes_optimized(small_icon) {
                            let _ = DestroyIcon(small_icon);
                            return Some(result.0);
                        }
                        let _ = DestroyIcon(small_icon);
                    }
                }
            }

            // Method 5: Try small window icon as fallback
            let small_icon = SendMessageW(
                self.0,
                WM_GETICON,
                Some(WPARAM(0usize)),
                Some(LPARAM(0isize)),
            ); // ICON_SMALL = 0

            if small_icon.0 != 0 {
                if let Some(result) = self.hicon_to_png_bytes_optimized(HICON(small_icon.0 as _)) {
                    return Some(result.0);
                }
            }

            // Method 6: Try class icon as last resort
            let class_icon = GetClassLongPtrW(self.0, GCLP_HICON) as isize;
            if class_icon != 0 {
                if let Some(result) = self.hicon_to_png_bytes_optimized(HICON(class_icon as _)) {
                    return Some(result.0);
                }
            }

            None
        }
    }

    fn extract_shell_icon_high_res(&self, exe_path: &str, target_size: i32) -> Option<Vec<u8>> {
        unsafe {
            let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

            // Try different shell icon sizes
            let icon_flags = [
                SHGFI_ICON | SHGFI_LARGEICON, // Large system icon
                SHGFI_ICON | SHGFI_SMALLICON, // Small system icon as fallback
            ];

            for flags in icon_flags {
                let mut file_info = SHFILEINFOW::default();
                let result = SHGetFileInfoW(
                    windows::core::PCWSTR(wide_path.as_ptr()),
                    FILE_FLAGS_AND_ATTRIBUTES(0),
                    Some(&mut file_info),
                    std::mem::size_of::<SHFILEINFOW>() as u32,
                    flags,
                );

                if result != 0 && !file_info.hIcon.is_invalid() {
                    if let Some(result) = self.hicon_to_png_bytes_optimized(file_info.hIcon) {
                        let _ = DestroyIcon(file_info.hIcon);
                        if result.1 >= target_size / 2 {
                            // Accept if at least half target size
                            return Some(result.0);
                        }
                    }
                    let _ = DestroyIcon(file_info.hIcon);
                }
            }

            None
        }
    }

    fn extract_executable_icons_high_res(&self, exe_path: &str) -> Option<Vec<u8>> {
        unsafe {
            let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

            let mut path_buffer = [0u16; 260];
            let copy_len = wide_path.len().min(path_buffer.len());
            path_buffer[..copy_len].copy_from_slice(&wide_path[..copy_len]);

            let icon_count = ExtractIconExW(PCWSTR(wide_path.as_ptr()), -1, None, None, 0);

            let total_icons = if icon_count > 0 {
                icon_count as usize
            } else {
                1
            };

            let max_icons_to_try = total_icons.min(8);
            let size_candidates: [i32; 12] = [512, 400, 256, 192, 128, 96, 72, 64, 48, 32, 24, 16];

            let mut best_icon: Option<Vec<u8>> = None;
            let mut best_size: i32 = 0;

            for &size in &size_candidates {
                for index in 0..max_icons_to_try {
                    let mut icon_slot = [HICON::default(); 1];

                    let extracted = PrivateExtractIconsW(
                        &path_buffer,
                        index as i32,
                        size,
                        size,
                        Some(&mut icon_slot),
                        None,
                        0,
                    );

                    if extracted == 0 {
                        continue;
                    }

                    let icon_handle = icon_slot[0];
                    if icon_handle.is_invalid() {
                        continue;
                    }

                    let icon_result = self.hicon_to_png_bytes_optimized(icon_handle);
                    let _ = DestroyIcon(icon_handle);

                    if let Some((png_data, realized_size)) = icon_result {
                        if realized_size > best_size {
                            best_size = realized_size;
                            best_icon = Some(png_data);

                            if best_size >= 256 {
                                return best_icon;
                            }
                        }
                    }
                }
            }

            best_icon
        }
    }

    fn get_executable_path(&self) -> Option<String> {
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
                Some(String::from_utf16_lossy(&buffer[..buffer_size as usize]))
            } else {
                None
            }
        }
    }

    fn get_icon_size(&self, icon: HICON) -> Option<(i32, i32)> {
        unsafe {
            let mut icon_info = ICONINFO::default();
            if !GetIconInfo(icon, &mut icon_info).is_ok() {
                return None;
            }

            // Get bitmap info to determine actual size
            let mut bitmap_info = BITMAP::default();
            let result = GetObjectA(
                HGDIOBJ(icon_info.hbmColor.0),
                mem::size_of::<BITMAP>() as i32,
                Some(&mut bitmap_info as *mut _ as *mut _),
            );

            // Clean up bitmap handles
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());

            if result > 0 {
                Some((bitmap_info.bmWidth, bitmap_info.bmHeight))
            } else {
                None
            }
        }
    }

    fn hicon_to_png_bytes_optimized(&self, icon: HICON) -> Option<(Vec<u8>, i32)> {
        unsafe {
            let mut icon_info = ICONINFO::default();
            if !GetIconInfo(icon, &mut icon_info).is_ok() {
                return None;
            }

            let screen_dc = GetDC(Some(HWND::default()));
            let mem_dc = CreateCompatibleDC(Some(screen_dc));

            let native_size = self.get_icon_size(icon);
            let target_sizes: Vec<i32> = if let Some((width, height)) = native_size {
                let native_dim = width.max(height);
                if native_dim > 0 {
                    let mut sizes = Vec::with_capacity(10);
                    sizes.push(native_dim);
                    for &candidate in &[256, 192, 128, 96, 64, 48, 32, 24, 16] {
                        if candidate > 0 && candidate < native_dim {
                            sizes.push(candidate);
                        }
                    }
                    if sizes.is_empty() {
                        vec![native_dim]
                    } else {
                        sizes
                    }
                } else {
                    vec![256, 192, 128, 96, 64, 48, 32, 24, 16]
                }
            } else {
                vec![512, 256, 192, 128, 96, 64, 48, 32, 24, 16]
            };

            let mut deduped = Vec::new();
            for size in target_sizes.into_iter() {
                if !deduped.contains(&size) {
                    deduped.push(size);
                }
            }

            for size in deduped.into_iter().filter(|size| *size > 0) {
                if let Some((png_data, realized_size)) =
                    self.try_convert_icon_to_png(icon, size, screen_dc, mem_dc)
                {
                    let _ = DeleteDC(mem_dc);
                    let _ = ReleaseDC(Some(HWND::default()), screen_dc);
                    let _ = DeleteObject(icon_info.hbmColor.into());
                    let _ = DeleteObject(icon_info.hbmMask.into());

                    return Some((png_data, realized_size));
                }
            }

            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(Some(HWND::default()), screen_dc);
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());

            None
        }
    }

    fn try_convert_icon_to_png(
        &self,
        icon: HICON,
        size: i32,
        screen_dc: HDC,
        mem_dc: HDC,
    ) -> Option<(Vec<u8>, i32)> {
        unsafe {
            let width = size;
            let height = size;

            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [Default::default(); 1],
            };

            let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
            if bitmap.is_invalid() {
                return None;
            }

            let old_bitmap = SelectObject(mem_dc, bitmap.into());

            let brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0));
            let rect = RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            };
            let _ = FillRect(mem_dc, &rect, brush);
            let _ = DeleteObject(brush.into());

            let draw_result = DrawIconEx(
                mem_dc,
                0,
                0,
                icon,
                width,
                height,
                0,
                Some(HBRUSH::default()),
                DI_FLAGS(0x0003),
            );

            let mut result: Option<(Vec<u8>, i32)> = None;

            if draw_result.is_ok() {
                let mut buffer = vec![0u8; (width * height * 4) as usize];
                let get_bits_result = GetDIBits(
                    mem_dc,
                    bitmap,
                    0,
                    height as u32,
                    Some(buffer.as_mut_ptr() as *mut _),
                    &mut bitmap_info,
                    DIB_RGB_COLORS,
                );

                if get_bits_result > 0 {
                    let has_content = buffer.chunks_exact(4).any(|chunk| chunk[3] != 0);

                    if has_content {
                        for chunk in buffer.chunks_exact_mut(4) {
                            chunk.swap(0, 2);
                        }

                        if let Some(img) =
                            image::RgbaImage::from_raw(width as u32, height as u32, buffer)
                        {
                            let mut png_data = Vec::new();
                            if img
                                .write_to(
                                    &mut std::io::Cursor::new(&mut png_data),
                                    image::ImageFormat::Png,
                                )
                                .is_ok()
                            {
                                result = Some((png_data, width));
                            }
                        }
                    }
                }
            }

            let _ = SelectObject(mem_dc, old_bitmap);
            let _ = DeleteObject(bitmap.into());

            result
        }
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        let mut rect = RECT::default();

        unsafe {
            match GetProcessDpiAwareness(None) {
                Ok(PROCESS_PER_MONITOR_DPI_AWARE) => {}
                Err(e) => {
                    error!("Failed to get process DPI awareness: {e}");
                    return None;
                }
                Ok(v) => {
                    error!("Unsupported DPI awareness {v:?}");
                    return None;
                }
            }

            DwmGetWindowAttribute(
                self.0,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&raw mut rect).cast(),
                size_of::<RECT>() as u32,
            )
            .ok()?;

            const BASE_DPI: f64 = 96.0;
            let dpi = match GetDpiForWindow(self.0) {
                0 => BASE_DPI as u32,
                dpi => dpi,
            } as f64;
            let scale_factor = dpi / BASE_DPI;

            Some(LogicalSize {
                width: (rect.right - rect.left) as f64 / scale_factor,
                height: (rect.bottom - rect.top) as f64 / scale_factor,
            })
        }
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        let mut rect = RECT::default();
        unsafe {
            match GetProcessDpiAwareness(None) {
                Ok(PROCESS_PER_MONITOR_DPI_AWARE) => {}
                Err(e) => {
                    error!("Failed to get process DPI awareness: {e}");
                    return None;
                }
                Ok(v) => {
                    error!("Unsupported DPI awareness {v:?}");
                    return None;
                }
            }

            DwmGetWindowAttribute(
                self.0,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&raw mut rect).cast(),
                size_of::<RECT>() as u32,
            )
            .ok()?;

            Some(PhysicalBounds {
                position: PhysicalPosition {
                    x: rect.left as f64,
                    y: rect.top as f64,
                },
                size: PhysicalSize {
                    width: (rect.right - rect.left) as f64,
                    height: (rect.bottom - rect.top) as f64,
                },
            })
        }
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(self.physical_bounds()?.size())
    }

    pub fn physical_position(&self) -> Option<PhysicalPosition> {
        Some(self.physical_bounds()?.position())
    }

    pub fn display(&self) -> Option<DisplayImpl> {
        let hwmonitor = unsafe { MonitorFromWindow(self.0, MONITOR_DEFAULTTONULL) };
        if hwmonitor.is_invalid() {
            None
        } else {
            Some(DisplayImpl(hwmonitor))
        }
    }

    pub fn name(&self) -> Option<String> {
        let len = unsafe { GetWindowTextLengthW(self.0) };

        let mut name = vec![0u16; usize::try_from(len).unwrap() + 1];
        if len >= 1 {
            let copied = unsafe { GetWindowTextW(self.0, &mut name) };
            if copied == 0 {
                return Some(String::new());
            }
        }

        String::from_utf16(
            &name
                .as_slice()
                .iter()
                .take_while(|ch| **ch != 0x0000)
                .copied()
                .collect::<Vec<u16>>(),
        )
        .ok()
    }

    pub fn is_on_screen(&self) -> bool {
        if !unsafe { IsWindowVisible(self.0) }.as_bool() {
            return false;
        }

        let mut pvattribute_cloaked = 0u32;
        unsafe {
            DwmGetWindowAttribute(
                self.0,
                DWMWA_CLOAKED,
                &mut pvattribute_cloaked as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .ok();

        if pvattribute_cloaked != 0 {
            return false;
        }

        let mut process_id = 0;
        unsafe { GetWindowThreadProcessId(self.0, Some(&mut process_id)) };

        let owner_process_path = match unsafe { pid_to_exe_path(process_id) } {
            Ok(path) => path,
            Err(_) => return false,
        };

        if owner_process_path.starts_with("C:\\Windows\\SystemApps") {
            return false;
        }

        true
    }

    pub fn is_valid(&self) -> bool {
        if !unsafe { IsWindowVisible(self.0).as_bool() } {
            return false;
        }

        let mut id = 0;
        unsafe { GetWindowThreadProcessId(self.0, Some(&mut id)) };
        if id == unsafe { GetCurrentProcessId() } {
            return false;
        }

        // Also skip WebView2 and Cap-related processes
        if let Ok(exe_path) = unsafe { pid_to_exe_path(id) } {
            if let Some(exe_name) = exe_path.file_name().and_then(|n| n.to_str()) {
                if IGNORED_EXES.contains(&&*exe_name.to_lowercase()) {
                    return false;
                }
            }
        }

        let mut rect = RECT::default();
        let result = unsafe { GetClientRect(self.0, &mut rect) };
        if result.is_ok() {
            let styles = unsafe { GetWindowLongPtrW(self.0, GWL_STYLE) };
            let ex_styles = unsafe { GetWindowLongPtrW(self.0, GWL_EXSTYLE) };

            if (ex_styles & isize::try_from(WS_EX_TOOLWINDOW.0).unwrap()) != 0 {
                return false;
            }
            if (styles & isize::try_from(WS_CHILD.0).unwrap()) != 0 {
                return false;
            }
        } else {
            return false;
        }

        true
    }

    pub fn try_as_capture_item(&self) -> windows::core::Result<GraphicsCaptureItem> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        unsafe { interop.CreateForWindow(self.0) }
    }
}

fn is_window_valid_for_enumeration(hwnd: HWND, current_process_id: u32) -> bool {
    unsafe {
        // Skip invisible or minimized windows
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }

        // Skip own process windows
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == current_process_id {
            return false;
        }

        // Also skip WebView2 and Cap-related processes
        if let Ok(exe_path) = pid_to_exe_path(process_id) {
            if let Some(exe_name) = exe_path.file_name().and_then(|n| n.to_str()) {
                if IGNORED_EXES.contains(&&*exe_name.to_lowercase()) {
                    return false;
                }
            }
        }

        true
    }
}

fn is_window_valid_for_topmost_selection(
    hwnd: HWND,
    current_process_id: u32,
    point: POINT,
) -> bool {
    unsafe {
        // Skip invisible or minimized windows
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }

        // Skip own process windows (includes overlays)
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == current_process_id {
            return false;
        }

        // Also skip WebView2 and Cap-related processes
        if let Ok(exe_path) = pid_to_exe_path(process_id) {
            if let Some(exe_name) = exe_path.file_name().and_then(|n| n.to_str()) {
                let exe_name_lower = exe_name.to_lowercase();
                if exe_name_lower.contains("webview2")
                    || exe_name_lower.contains("msedgewebview2")
                    || exe_name_lower.contains("cap")
                {
                    return false;
                }
            }
        }

        // Check if point is actually in this window
        if !is_point_in_window(hwnd, point) {
            return false;
        }

        // Skip certain window classes that should be ignored
        let mut class_name = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut class_name);
        if len > 0 {
            let class_name_str = String::from_utf16_lossy(&class_name[..len as usize]);
            match class_name_str.as_str() {
                "Shell_TrayWnd" | "Button" | "Tooltip" | "ToolTips_Class32" => return false,
                _ => {}
            }
        }

        // Skip windows with certain extended styles
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if (ex_style & WS_EX_TRANSPARENT.0) != 0 || (ex_style & WS_EX_LAYERED.0) != 0 {
            // Allow layered windows only if they have proper alpha
            if (ex_style & WS_EX_LAYERED.0) != 0 {
                let mut alpha = 0u8;
                let mut color_key = 0u32;
                let mut flags = 0u32;
                if GetLayeredWindowAttributes(
                    hwnd,
                    Some(&mut color_key as *mut u32 as *mut _),
                    Some(&mut alpha),
                    Some(&mut flags as *mut u32 as *mut _),
                )
                .is_ok()
                {
                    if alpha < 50 {
                        // Skip nearly transparent windows
                        return false;
                    }
                }
            } else {
                return false; // Skip fully transparent windows
            }
        }

        true
    }
}

fn is_point_in_window(hwnd: HWND, point: POINT) -> bool {
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() {
            point.x >= rect.left
                && point.x < rect.right
                && point.y >= rect.top
                && point.y < rect.bottom
        } else {
            false
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

unsafe fn pid_to_exe_path(pid: u32) -> Result<PathBuf, windows::core::Error> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }?;
    if handle.is_invalid() {
        tracing::error!("Invalid PID {}", pid);
    }
    let mut lpexename = [0u16; 1024];
    let mut lpdwsize = lpexename.len() as u32;

    let query = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT::default(),
            windows::core::PWSTR(lpexename.as_mut_ptr()),
            &mut lpdwsize,
        )
    };
    unsafe { CloseHandle(handle) }.ok();
    query?;

    let os_str = &OsString::from_wide(&lpexename[..lpdwsize as usize]);
    Ok(PathBuf::from(os_str))
}
