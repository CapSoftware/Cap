use std::collections::HashMap;
use std::ffi::{OsString, c_void};
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use super::{Bounds, LogicalBounds, LogicalPosition, LogicalSize, Window};

use tracing::debug;
use windows::Win32::{
    Foundation::{CloseHandle, FALSE, HWND, LPARAM, RECT, TRUE},
    Graphics::{
        Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
        Gdi::{
            DEVMODEW, DISPLAY_DEVICEW, EnumDisplayDevicesW, EnumDisplayMonitors,
            EnumDisplaySettingsW, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONULL,
            MONITORINFO, MONITORINFOEXW, MonitorFromWindow,
        },
    },
    System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    },
    UI::HiDpi::GetDpiForWindow,
    UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, SetForegroundWindow,
    },
};
use windows::core::{BOOL, PCWSTR, PWSTR};

#[inline]
pub fn bring_window_to_focus(window_id: u32) {
    let _ = unsafe { SetForegroundWindow(HWND(window_id as *mut c_void)) };
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

pub fn get_on_screen_windows() -> Vec<Window> {
    let mut windows = Vec::<Window>::new();

    unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if hwnd.is_invalid() {
            return TRUE;
        }
        let windows = unsafe { &mut *(lparam.0 as *mut Vec<Window>) };

        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return TRUE;
        }

        let mut pvattribute_cloaked = 0u32;
        unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut pvattribute_cloaked as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .ok();

        if pvattribute_cloaked != 0 {
            return TRUE;
        }

        let mut process_id = 0;
        let _thrad_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };

        let wnamelen = unsafe { GetWindowTextLengthW(hwnd) };
        if wnamelen == 0 {
            return TRUE;
        }
        let mut wname = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut wname) };

        let owner_process_path = match unsafe { pid_to_exe_path(process_id) } {
            Ok(path) => path,
            Err(_) => return TRUE,
        };

        if owner_process_path.starts_with("C:\\Windows\\SystemApps") {
            return TRUE;
        }

        let owner_name = match owner_process_path.file_stem() {
            Some(exe_name) => exe_name.to_string_lossy().into_owned(),
            None => owner_process_path.to_string_lossy().into_owned(),
        };

        // Windows 10 build 1607 or later
        // Credits: TAO src/platform_impl/windows/dpi.rs
        const BASE_DPI: u32 = 96;
        let _dpi = match unsafe { GetDpiForWindow(hwnd) } {
            0 => BASE_DPI,
            dpi => dpi,
        } as i32;

        let mut rect = RECT::default();
        unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rect as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<RECT>() as u32,
            )
        }
        .ok();

        let rect_left = rect.left as f64;
        let rect_top = rect.top as f64;
        let rect_right = rect.right as f64;
        let rect_bottom = rect.bottom as f64;

        let window = Window {
            window_id: hwnd.0 as u32,
            name: String::from_utf16_lossy(&wname[..len as usize]),
            owner_name,
            process_id,
            bounds: Bounds {
                x: rect_left.max(0.0),
                y: rect_top.max(0.0),
                width: rect_right - rect_left,
                height: rect_bottom - rect_top,
            },
        };

        windows.push(window);
        TRUE
    }

    let _ = unsafe {
        EnumWindows(
            Some(enum_window_proc),
            LPARAM(core::ptr::addr_of_mut!(windows) as isize),
        )
    };
    windows
}

pub fn monitor_bounds(id: u32) -> Bounds {
    let bounds = None::<Bounds>;

    unsafe extern "system" fn monitor_enum_proc(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _lprc_clip: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let (target_id, bounds) = unsafe { &mut *(lparam.0 as *mut (u32, Option<Bounds>)) };

        let mut minfo = MONITORINFOEXW::default();
        minfo.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !unsafe { GetMonitorInfoW(hmonitor, &mut minfo as *mut MONITORINFOEXW as *mut _) }
            .as_bool()
        {
            return TRUE;
        }

        let mut display_device = DISPLAY_DEVICEW::default();
        #[allow(clippy::field_reassign_with_default)]
        {
            display_device.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        }

        if !unsafe {
            EnumDisplayDevicesW(
                PWSTR(minfo.szDevice.as_ptr() as _),
                0,
                &mut display_device,
                0,
            )
        }
        .as_bool()
        {
            return TRUE;
        }

        let id = hmonitor.0 as u32;

        if id == *target_id {
            let rect = minfo.monitorInfo.rcMonitor;
            *bounds = Some(Bounds {
                x: rect.left as f64,
                y: rect.top as f64,
                width: (rect.right - rect.left) as f64,
                height: (rect.bottom - rect.top) as f64,
            });
            return FALSE;
        }
        TRUE
    }

    let mut lparams = (id, bounds);
    let _ = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(monitor_enum_proc),
            LPARAM(core::ptr::addr_of_mut!(lparams) as isize),
        )
    };

    // If we didn't find the monitor with the given ID, log a warning and return a default bounds
    if lparams.1.is_none() {
        debug!("Could not find monitor with ID: {}", id);
        return Bounds {
            x: 0.0,
            y: 0.0,
            width: 1920.0, // Default to a common resolution
            height: 1080.0,
        };
    }

    lparams.1.unwrap()
}

pub fn logical_monitor_bounds(id: u32) -> Option<LogicalBounds> {
    let bounds = monitor_bounds(id);
    Some(LogicalBounds {
        position: LogicalPosition {
            x: bounds.x,
            y: bounds.y,
        },
        size: LogicalSize {
            width: bounds.width,
            height: bounds.height,
        },
    })
}

pub fn display_names() -> HashMap<u32, String> {
    let mut names = HashMap::new();

    for window in windows_capture::monitor::Monitor::enumerate().unwrap_or_default() {
        let Ok(name) = window.device_string() else {
            continue;
        };

        names.insert(window.as_raw_hmonitor() as u32, name);
    }

    names
}

pub fn get_display_refresh_rate(monitor: HMONITOR) -> Result<u32, String> {
    let mut monitorinfoexw: MONITORINFOEXW = unsafe { std::mem::zeroed() };
    monitorinfoexw.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;

    unsafe { GetMonitorInfoW(monitor, &mut monitorinfoexw.monitorInfo as *mut MONITORINFO) }
        .ok()
        .map_err(|e| e.to_string())?;

    let mut dev_mode: DEVMODEW = unsafe { std::mem::zeroed() };
    dev_mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;

    let device_name = PCWSTR::from_raw(monitorinfoexw.szDevice.as_ptr());

    unsafe {
        EnumDisplaySettingsW(
            device_name,
            windows::Win32::Graphics::Gdi::ENUM_CURRENT_SETTINGS,
            &mut dev_mode,
        )
    }
    .ok()
    .map_err(|e| e.to_string())?;

    Ok(dev_mode.dmDisplayFrequency)
}

pub fn display_for_window(window: HWND) -> Option<HMONITOR> {
    let hwmonitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONULL) };
    if hwmonitor.is_invalid() {
        None
    } else {
        Some(hwmonitor)
    }
}
