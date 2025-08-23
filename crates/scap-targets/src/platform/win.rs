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
        Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
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
            Shell::ExtractIconExW,
            WindowsAndMessaging::{
                DI_FLAGS, DestroyIcon, DrawIconEx, EnumChildWindows, EnumWindows, GCLP_HICON,
                GW_HWNDNEXT, GWL_EXSTYLE, GWL_STYLE, GetClassLongPtrW, GetClassNameW,
                GetClientRect, GetCursorPos, GetDesktopWindow, GetIconInfo,
                GetLayeredWindowAttributes, GetWindow, GetWindowLongPtrW, GetWindowLongW,
                GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
                HICON, ICONINFO, IsIconic, IsWindowVisible, SendMessageW, WM_GETICON, WS_CHILD,
                WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WindowFromPoint,
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
            // Try multiple approaches to get the highest quality icon
            let mut best_result = None;
            let mut best_size = 0;

            // Method 1: Try to get the window's large icon first
            let large_icon = SendMessageW(
                self.0,
                WM_GETICON,
                Some(WPARAM(1usize)),
                Some(LPARAM(0isize)),
            ); // ICON_BIG = 1

            if large_icon.0 != 0 {
                if let Some(result) = self.hicon_to_png_bytes_high_res(HICON(large_icon.0 as _)) {
                    best_result = Some(result.0);
                    best_size = result.1;
                }
            }

            // Method 2: Try executable file extraction with priority on larger icons
            if let Some(exe_path) = self.get_executable_path() {
                let wide_path: Vec<u16> =
                    exe_path.encode_utf16().chain(std::iter::once(0)).collect();

                // Try extracting icons from multiple indices
                for icon_index in 0..6 {
                    let mut large_icon: HICON = HICON::default();
                    let mut small_icon: HICON = HICON::default();

                    let extracted = ExtractIconExW(
                        PCWSTR(wide_path.as_ptr()),
                        icon_index,
                        Some(&mut large_icon),
                        Some(&mut small_icon),
                        1,
                    );

                    if extracted > 0 {
                        // Try large icon first
                        if !large_icon.is_invalid() {
                            if let Some(result) = self.hicon_to_png_bytes_high_res(large_icon) {
                                if result.1 > best_size {
                                    best_result = Some(result.0);
                                    best_size = result.1;
                                }
                            }
                            let _ = DestroyIcon(large_icon);
                        }

                        // Try small icon if we haven't found anything good yet
                        if !small_icon.is_invalid() && best_size < 64 {
                            if let Some(result) = self.hicon_to_png_bytes_high_res(small_icon) {
                                if result.1 > best_size {
                                    best_result = Some(result.0);
                                    best_size = result.1;
                                }
                            }
                            let _ = DestroyIcon(small_icon);
                        }
                    }
                }
            }

            // Method 3: Try small window icon if we still don't have anything good
            if best_size < 32 {
                let small_icon = SendMessageW(
                    self.0,
                    WM_GETICON,
                    Some(WPARAM(0usize)),
                    Some(LPARAM(0isize)),
                ); // ICON_SMALL = 0

                if small_icon.0 != 0 {
                    if let Some(result) = self.hicon_to_png_bytes_high_res(HICON(small_icon.0 as _))
                    {
                        if result.1 > best_size {
                            best_result = Some(result.0);
                            best_size = result.1;
                        }
                    }
                }
            }

            // Method 4: Try class icon as last resort
            if best_size < 32 {
                let class_icon = GetClassLongPtrW(self.0, GCLP_HICON) as isize;
                if class_icon != 0 {
                    if let Some(result) = self.hicon_to_png_bytes_high_res(HICON(class_icon as _)) {
                        if result.1 > best_size {
                            best_result = Some(result.0);
                        }
                    }
                }
            }

            best_result
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

    fn hicon_to_png_bytes_high_res(&self, icon: HICON) -> Option<(Vec<u8>, i32)> {
        unsafe {
            // Get icon info to determine actual size
            let mut icon_info = ICONINFO::default();
            if !GetIconInfo(icon, &mut icon_info).is_ok() {
                return None;
            }

            // Get device context
            let screen_dc = GetDC(Some(HWND::default()));
            let mem_dc = CreateCompatibleDC(Some(screen_dc));

            // Get the native icon size to prioritize it
            let native_size = self.get_icon_size(icon);

            // Always try for the highest resolution possible, starting with the largest sizes
            let mut sizes = vec![2048, 1024, 512, 256, 128, 96, 64, 48, 32, 24, 16];

            // If we have native size info, prioritize it
            if let Some((width, height)) = native_size {
                let native_dim = width.max(height);
                const MAX_SIZE: i32 = 4096;
                if !sizes.contains(&native_dim) && native_dim > 0 && native_dim <= MAX_SIZE {
                    sizes.insert(0, native_dim);
                }
            }

            let mut best_result = None;
            let mut best_size = 0;

            for &size in &sizes {
                let width = size;
                let height = size;

                // Create bitmap info for this size
                let mut bitmap_info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width,
                        biHeight: -height, // Top-down DIB
                        biPlanes: 1,
                        biBitCount: 32, // 32 bits per pixel (BGRA)
                        biCompression: BI_RGB.0,
                        biSizeImage: 0,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 0,
                        biClrImportant: 0,
                    },
                    bmiColors: [Default::default(); 1],
                };

                // Create a bitmap
                let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
                if bitmap.is_invalid() {
                    continue;
                }

                let old_bitmap = SelectObject(mem_dc, bitmap.into());

                // Fill with transparent background
                let brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0));
                let rect = RECT {
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: height,
                };
                let _ = FillRect(mem_dc, &rect, brush);
                let _ = DeleteObject(brush.into());

                // Draw the icon onto the bitmap with proper scaling
                let draw_result = DrawIconEx(
                    mem_dc,
                    0,
                    0,
                    icon,
                    width,
                    height,
                    0,
                    Some(HBRUSH::default()),
                    DI_FLAGS(0x0003), // DI_NORMAL
                );

                if draw_result.is_ok() {
                    // Get bitmap bits
                    let mut buffer = vec![0u8; (width * height * 4) as usize];
                    let result = GetDIBits(
                        mem_dc,
                        bitmap,
                        0,
                        height as u32,
                        Some(buffer.as_mut_ptr() as *mut _),
                        &mut bitmap_info,
                        DIB_RGB_COLORS,
                    );

                    if result > 0 {
                        // Check if we have any non-transparent pixels
                        let has_content = buffer.chunks_exact(4).any(|chunk| chunk[3] != 0);

                        if has_content {
                            // Convert BGRA to RGBA
                            for chunk in buffer.chunks_exact_mut(4) {
                                chunk.swap(0, 2); // Swap B and R
                            }

                            // Create PNG using the image crate
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
                                    // Keep the result if it's our first success or if this size is larger
                                    if best_result.is_none() || size > best_size {
                                        best_result = Some((png_data, size));
                                        best_size = size;
                                    }
                                }
                            }
                        }
                    }
                }

                // Cleanup for this iteration
                let _ = SelectObject(mem_dc, old_bitmap);
                let _ = DeleteObject(bitmap.into());
            }

            // Cleanup
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(Some(HWND::default()), screen_dc);
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());

            best_result
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
        process_id != current_process_id
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
