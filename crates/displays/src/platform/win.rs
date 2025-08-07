use std::{mem, str::FromStr};

use base64::prelude::*;
use windows::{
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT, TRUE, WPARAM},
        Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap, CreateCompatibleDC,
            CreateSolidBrush, DEVMODEW, DIB_RGB_COLORS, DeleteDC, DeleteObject,
            ENUM_CURRENT_SETTINGS, EnumDisplayMonitors, EnumDisplaySettingsW, FillRect, GetDC,
            GetDIBits, GetMonitorInfoW, HBRUSH, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST,
            MONITOR_DEFAULTTONULL, MONITORINFOEXW, MonitorFromPoint, ReleaseDC, SelectObject,
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
        UI::{
            Shell::ExtractIconExW,
            WindowsAndMessaging::{
                DI_FLAGS, DestroyIcon, DrawIconEx, EnumWindows, GCLP_HICON, GWL_EXSTYLE,
                GetClassLongPtrW, GetCursorPos, GetIconInfo, GetWindowLongW, GetWindowRect,
                GetWindowThreadProcessId, HICON, ICONINFO, IsIconic, IsWindowVisible, SendMessageW,
                WM_GETICON, WS_EX_TOPMOST,
            },
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
                Some(0),
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

    pub fn app_icon(&self) -> Option<String> {
        unsafe {
            // Try to get the window's icon first
            let mut icon = SendMessageW(
                self.0,
                WM_GETICON,
                Some(WPARAM(1usize)),
                Some(LPARAM(0isize)),
            ); // ICON_BIG = 1
            if icon.0 == 0 {
                // Try to get the class icon
                icon.0 = GetClassLongPtrW(self.0, GCLP_HICON) as isize;
            }

            if icon.0 == 0 {
                // Try to get icon from the executable file
                if let Some(exe_path) = self.get_executable_path() {
                    let wide_path: Vec<u16> =
                        exe_path.encode_utf16().chain(std::iter::once(0)).collect();

                    let mut large_icon: HICON = HICON::default();
                    let extracted = ExtractIconExW(
                        PCWSTR(wide_path.as_ptr()),
                        0,
                        Some(&mut large_icon),
                        None,
                        1,
                    );

                    if extracted > 0 && !large_icon.is_invalid() {
                        let result = self.hicon_to_png_bytes(large_icon);
                        let _ = DestroyIcon(large_icon);
                        return result;
                    }
                }
                return None;
            }

            self.hicon_to_png_bytes(HICON(icon.0 as _))
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

    fn hicon_to_png_bytes(&self, icon: HICON) -> Option<String> {
        unsafe {
            // Get icon info to determine actual size
            let mut icon_info = ICONINFO::default();
            if !GetIconInfo(icon, &mut icon_info).is_ok() {
                return None;
            }

            // Get device context
            let screen_dc = GetDC(Some(HWND::default()));
            let mem_dc = CreateCompatibleDC(Some(screen_dc));

            // Try multiple common icon sizes to find the best match
            let sizes = [16, 24, 32, 48, 64, 128, 256];
            let mut best_result = None;

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

                            // Create a simple PNG using a basic implementation
                            if let Some(png_data) =
                                self.create_png_data(width as u32, height as u32, &buffer)
                            {
                                let base64_string = BASE64_STANDARD.encode(&png_data);
                                best_result =
                                    Some(format!("data:image/png;base64,{}", base64_string));
                            }
                        }
                    }
                }

                // Cleanup for this iteration
                let _ = SelectObject(mem_dc, old_bitmap);
                let _ = DeleteObject(bitmap.into());

                // If we found a good result, use it
                if best_result.is_some() {
                    break;
                }
            }

            // Cleanup
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(Some(HWND::default()), screen_dc);
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());

            best_result
        }
    }

    fn create_png_data(&self, width: u32, height: u32, rgba_data: &[u8]) -> Option<Vec<u8>> {
        // Simple PNG creation - this creates a minimal but valid PNG file
        let mut png_data = Vec::new();

        // PNG signature
        png_data.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

        // IHDR chunk
        let ihdr_data = {
            let mut data = Vec::new();
            data.extend_from_slice(&width.to_be_bytes());
            data.extend_from_slice(&height.to_be_bytes());
            data.push(8); // bit depth
            data.push(6); // color type (RGBA)
            data.push(0); // compression
            data.push(0); // filter
            data.push(0); // interlace
            data
        };
        self.write_png_chunk(&mut png_data, b"IHDR", &ihdr_data);

        // IDAT chunk with zlib compression
        let mut idat_data = Vec::new();

        // Add filter bytes (0 = None filter) for each row
        for y in 0..height {
            idat_data.push(0); // Filter type: None
            let row_start = (y * width * 4) as usize;
            let row_end = row_start + (width * 4) as usize;
            if row_end <= rgba_data.len() {
                idat_data.extend_from_slice(&rgba_data[row_start..row_end]);
            }
        }

        // Simple zlib compression (deflate with no compression)
        let compressed = self.simple_deflate(&idat_data)?;
        self.write_png_chunk(&mut png_data, b"IDAT", &compressed);

        // IEND chunk
        self.write_png_chunk(&mut png_data, b"IEND", &[]);

        Some(png_data)
    }

    fn write_png_chunk(&self, output: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
        // Length
        output.extend_from_slice(&(data.len() as u32).to_be_bytes());
        // Type
        output.extend_from_slice(chunk_type);
        // Data
        output.extend_from_slice(data);
        // CRC
        let crc = self.crc32(chunk_type, data);
        output.extend_from_slice(&crc.to_be_bytes());
    }

    fn simple_deflate(&self, data: &[u8]) -> Option<Vec<u8>> {
        let mut result = Vec::new();

        // Zlib header
        result.push(0x78); // CMF
        result.push(0x01); // FLG (no compression)

        // Process data in blocks
        let block_size = 65535;
        let mut offset = 0;

        while offset < data.len() {
            let remaining = data.len() - offset;
            let current_block_size = remaining.min(block_size);
            let is_final = remaining <= block_size;

            // Block header
            result.push(if is_final { 0x01 } else { 0x00 }); // BFINAL and BTYPE

            // Block length (little endian)
            result.extend_from_slice(&(current_block_size as u16).to_le_bytes());
            let negated_size = !(current_block_size as u16);
            result.extend_from_slice(&negated_size.to_le_bytes());

            // Block data
            result.extend_from_slice(&data[offset..offset + current_block_size]);
            offset += current_block_size;
        }

        // Adler32 checksum
        let checksum = self.adler32(data);
        result.extend_from_slice(&checksum.to_be_bytes());

        Some(result)
    }

    fn crc32(&self, chunk_type: &[u8], data: &[u8]) -> u32 {
        let mut crc = 0xFFFFFFFF_u32;

        for &byte in chunk_type.iter().chain(data.iter()) {
            crc ^= byte as u32;
            for _ in 0..8 {
                if crc & 1 != 0 {
                    crc = (crc >> 1) ^ 0xEDB88320;
                } else {
                    crc >>= 1;
                }
            }
        }

        !crc
    }

    fn adler32(&self, data: &[u8]) -> u32 {
        let mut a = 1_u32;
        let mut b = 0_u32;

        for &byte in data {
            a = (a + byte as u32) % 65521;
            b = (b + a) % 65521;
        }

        (b << 16) | a
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
