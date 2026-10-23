use std::io;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{WM_ENDSESSION, WM_NCDESTROY};

const SUBCLASS_ID: usize = 0x4341_5053;

// gpui's Windows platform ignores WM_ENDSESSION, so a shutdown, restart or sign-off
// terminates the process without running `on_app_quit`. The Tauri app then reads the
// leftover hand-off marker as a crash and turns the native app off.
pub fn install(hwnd: HWND, on_session_end: fn()) -> io::Result<()> {
    let callback = Box::into_raw(Box::new(on_session_end));
    if unsafe { SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, callback as usize) } == 0 {
        drop(unsafe { Box::from_raw(callback) });
        return Err(io::Error::other(
            "could not install the session end subclass",
        ));
    }
    Ok(())
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    reference_data: usize,
) -> LRESULT {
    let callback = reference_data as *mut fn();
    if message == WM_NCDESTROY {
        unsafe { RemoveWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID) };
        drop(unsafe { Box::from_raw(callback) });
    } else if message == WM_ENDSESSION && wparam != 0 {
        unsafe { (*callback)() };
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, ENDSESSION_CLOSEAPP, ENDSESSION_LOGOFF, HWND_MESSAGE,
        SendMessageW, WM_QUERYENDSESSION,
    };

    use super::*;

    static ENDED: AtomicUsize = AtomicUsize::new(0);

    fn record_session_end() {
        ENDED.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn runs_the_handler_only_when_the_session_really_ends() {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null());
        install(hwnd, record_session_end).unwrap();

        assert_ne!(
            unsafe { SendMessageW(hwnd, WM_QUERYENDSESSION, 0, ENDSESSION_CLOSEAPP as LPARAM) },
            0
        );
        unsafe { SendMessageW(hwnd, WM_ENDSESSION, 0, 0) };
        assert_eq!(ENDED.load(Ordering::SeqCst), 0);

        unsafe { SendMessageW(hwnd, WM_ENDSESSION, 1, ENDSESSION_LOGOFF as LPARAM) };
        assert_eq!(ENDED.load(Ordering::SeqCst), 1);

        assert_ne!(unsafe { DestroyWindow(hwnd) }, 0);
    }
}
