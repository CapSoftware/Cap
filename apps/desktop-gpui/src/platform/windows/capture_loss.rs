use std::io;

use tokio::sync::mpsc::{self, Receiver, Sender};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::GetCapture,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{WM_CAPTURECHANGED, WM_NCDESTROY},
    },
};

pub(super) fn install(hwnd: HWND) -> io::Result<Receiver<()>> {
    let (tx, rx) = mpsc::channel(1);
    let sender = Box::into_raw(Box::new(tx));
    if unsafe { SetWindowSubclass(hwnd, Some(subclass), 0, sender as usize) } == 0 {
        drop(unsafe { Box::from_raw(sender) });
        return Err(io::Error::other("could not observe mouse capture loss"));
    }
    Ok(rx)
}

pub(super) fn owns_capture(hwnd: HWND) -> bool {
    unsafe { GetCapture() == hwnd }
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    reference_data: usize,
) -> LRESULT {
    let sender = reference_data as *mut Sender<()>;
    if message == WM_NCDESTROY {
        unsafe { RemoveWindowSubclass(hwnd, Some(subclass), subclass_id) };
        drop(unsafe { Box::from_raw(sender) });
    } else if message == WM_CAPTURECHANGED {
        let _ = unsafe { (*sender).try_send(()) };
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, HWND_MESSAGE, SendMessageW,
    };

    #[test]
    fn picker_receives_native_capture_loss_and_closes_with_window() {
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
        let mut losses = install(hwnd).unwrap();
        unsafe { SendMessageW(hwnd, WM_CAPTURECHANGED, 0, 0) };
        assert_eq!(losses.try_recv(), Ok(()));
        assert_ne!(unsafe { DestroyWindow(hwnd) }, 0);
        assert_eq!(
            losses.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        );
    }
}
