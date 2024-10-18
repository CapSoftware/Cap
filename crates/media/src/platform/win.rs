use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;

use super::{Bounds, CursorShape, Window};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, FALSE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetCursorInfo, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, LoadCursorW, SetForegroundWindow, CURSORINFO,
    IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO, IDC_SIZEALL,
    IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_UPARROW, IDC_WAIT,
};

fn pid_to_name(pid: u32) -> Result<String, windows::core::Error> {
    unsafe {
        tracing::debug!("Getting name for pid: {pid}");
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, pid)?;
        if handle.is_invalid() || handle.0 == 0 {
            println!("Invalid PID {}", pid);
        }
        let mut name = vec![0u16; 1024];
        let mut size = name.len() as u32;

        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT::default(),
            PWSTR(name.as_mut_ptr()),
            &mut size,
        )?;

        name.truncate(size as usize);
        CloseHandle(handle).ok();
        Ok(OsString::from_wide(&name).to_string_lossy().into_owned())
    }
}

unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if hwnd.0 == 0 {
        return TRUE;
    }
    let windows = &mut *(lparam.0 as *mut Vec<Window>);

    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }

    let mut rect: RECT = RECT::default();
    if let Err(_) = GetWindowRect(hwnd, &mut rect) {
        return TRUE;
    }

    let process_id = GetWindowThreadProcessId(hwnd, None);

    let wnamelen = GetWindowTextLengthW(hwnd);
    if wnamelen == 0 {
        return TRUE;
    }
    let mut wname = vec![0u16; wnamelen as usize + 1];
    let len = GetWindowTextW(hwnd, &mut wname);
    wname.truncate(len as usize);

    // TODO: Might need fixing
    let owner_name = pid_to_name(process_id).unwrap_or("".into());

    let window = Window {
        window_id: hwnd.0 as u32,
        name: OsString::from_wide(&wname).to_string_lossy().into_owned(),
        owner_name,
        process_id,
        bounds: Bounds {
            x: rect.left as f64,
            y: rect.top as f64,
            width: (rect.right - rect.left) as f64,
            height: (rect.bottom - rect.top) as f64,
        },
    };

    windows.push(window);
    TRUE
}

pub fn get_on_screen_windows() -> Vec<Window> {
    let mut windows = Vec::<Window>::new();
    let _ = unsafe {
        EnumWindows(
            Some(enum_window_proc),
            LPARAM(&mut windows as *mut _ as isize),
        )
    };
    windows
}

pub fn bring_window_to_focus(window_id: u32) {
    let _ = unsafe { SetForegroundWindow(HWND(window_id as isize)) };
}

/// Keeps handles to default cursor.
/// Read more: [MS Doc - About Cursors](https://learn.microsoft.com/en-us/windows/win32/menurc/about-cursors)
// TODO(Ilya): Change to an enum and define the values here.
pub struct DefaultCursors {
    arrow: isize,
    ibeam: isize,
    wait: isize,
    cross: isize,
    up_arrow: isize,
    size_nwse: isize,
    size_nesw: isize,
    size_we: isize,
    size_ns: isize,
    size_all: isize,
    no: isize,
    hand: isize,
    appstarting: isize,
    help: isize,
}

impl Default for DefaultCursors {
    fn default() -> Self {
        let load_cursor = |lpcursorname| {
            unsafe { LoadCursorW(None, lpcursorname) }
                .expect("Failed to load default system cursors")
                .0
        };

        DefaultCursors {
            arrow: load_cursor(IDC_ARROW),
            ibeam: load_cursor(IDC_IBEAM),
            cross: load_cursor(IDC_CROSS),
            hand: load_cursor(IDC_HAND),
            help: load_cursor(IDC_HELP),
            no: load_cursor(IDC_NO),
            size_all: load_cursor(IDC_SIZEALL),
            size_ns: load_cursor(IDC_SIZENS),
            size_we: load_cursor(IDC_SIZEWE),
            size_nwse: load_cursor(IDC_SIZENWSE),
            size_nesw: load_cursor(IDC_SIZENESW),
            up_arrow: load_cursor(IDC_UPARROW),
            wait: load_cursor(IDC_WAIT),
            appstarting: load_cursor(IDC_APPSTARTING),
        }
    }
}

pub fn get_cursor_shape(cursors: &DefaultCursors) -> CursorShape {
    let mut cursor_info = CURSORINFO::default();
    cursor_info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;

    match unsafe { GetCursorInfo(&mut cursor_info) } {
        Ok(_) => match cursor_info.hCursor.0 {
            ptr if ptr == cursors.arrow => CursorShape::Arrow,
            ptr if ptr == cursors.ibeam => CursorShape::IBeam,
            ptr if ptr == cursors.wait => CursorShape::Wait,
            ptr if ptr == cursors.cross => CursorShape::Crosshair,
            ptr if ptr == cursors.up_arrow => CursorShape::ResizeUp,
            ptr if ptr == cursors.size_we => CursorShape::ResizeLeftRight,
            ptr if ptr == cursors.size_ns => CursorShape::ResizeUpDown,
            ptr if ptr == cursors.size_nwse => CursorShape::ResizeUpLeftAndDownRight,
            ptr if ptr == cursors.size_nesw => CursorShape::ResizeUpRightAndDownLeft,
            ptr if ptr == cursors.size_all => CursorShape::ResizeAll,
            ptr if ptr == cursors.hand => CursorShape::OpenHand,
            ptr if ptr == cursors.no => CursorShape::NotAllowed,
            ptr if ptr == cursors.appstarting => CursorShape::Appstarting,
            ptr if ptr == cursors.help => CursorShape::Help,
            // Usually 0, meaning the cursor is hidden. On Windows 8+, a value of 2 means the cursor is supressed
            // as the user is using touch input instead.
            _ => CursorShape::Hidden,
        },
        Err(_) => CursorShape::Unknown,
    }
}
