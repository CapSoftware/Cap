use std::ffi::c_void;
use std::io::{self, Write};

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, SetLastError, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Shell::{
    DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowThreadProcessId, IsWindowVisible, SWP_SHOWWINDOW, WINDOWPOS, WM_NCDESTROY,
    WM_SHOWWINDOW, WM_WINDOWPOSCHANGED, WM_WINDOWPOSCHANGING,
};

const SUBCLASS_ID: usize = 0x4341_5046;
const KNOWN: usize = 1;
const DISABLED: usize = 2;
const UPDATING: usize = 4;
const DWMWA_NCRENDERING_POLICY: u32 = 2;
const DWMNCRP_USEWINDOWSTYLE: u32 = 0;
const DWMNCRP_DISABLED: u32 = 1;

#[link(name = "dwmapi")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(hwnd: HWND, attribute: u32, value: *const c_void, size: u32) -> i32;
}

pub fn install(hwnd: HWND) -> io::Result<()> {
    let owner = unsafe { GetWindowThreadProcessId(hwnd, std::ptr::null_mut()) };
    if owner == 0 || owner != unsafe { GetCurrentThreadId() } {
        return Err(io::Error::other(
            "Main frame policy must be installed on the window's owning thread",
        ));
    }
    if state(hwnd).is_none() {
        write_state(hwnd, 0)?;
    }
    reconcile(hwnd)
}

fn state(hwnd: HWND) -> Option<usize> {
    let mut state = 0;
    let found = unsafe { GetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, &mut state) };
    (found != 0).then_some(state)
}

fn write_state(hwnd: HWND, state: usize) -> io::Result<()> {
    if unsafe { SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, state) } == 0 {
        return Err(io::Error::other("could not update Main frame subclass"));
    }
    Ok(())
}

fn apply_policy(hwnd: HWND, disabled: bool) -> io::Result<()> {
    let Some(previous) = state(hwnd) else {
        return Ok(());
    };
    let desired = KNOWN | if disabled { DISABLED } else { 0 };
    if previous & UPDATING != 0 || previous == desired {
        return Ok(());
    }
    let updating = previous | UPDATING;
    write_state(hwnd, updating)?;
    let policy = if disabled {
        DWMNCRP_DISABLED
    } else {
        DWMNCRP_USEWINDOWSTYLE
    };
    // A native frame can remain visible after Main hides; visible windows retain normal DWM policy.
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY,
            std::ptr::addr_of!(policy).cast(),
            std::mem::size_of_val(&policy) as u32,
        )
    };
    if state(hwnd) == Some(updating) {
        write_state(hwnd, if result >= 0 { desired } else { previous })?;
    }
    if result < 0 {
        return Err(io::Error::other(format!(
            "Main frame DWM policy {policy} failed: HRESULT {result:#010x}"
        )));
    }
    Ok(())
}

fn reconcile(hwnd: HWND) -> io::Result<()> {
    if state(hwnd).is_none() {
        return Ok(());
    }
    apply_policy(hwnd, unsafe { IsWindowVisible(hwnd) } == 0)
}

fn report(result: io::Result<()>) {
    if let Err(error) = result {
        let _ = writeln!(io::stderr().lock(), "Cap Main frame policy: {error}");
    }
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _reference_data: usize,
) -> LRESULT {
    let incoming_error = unsafe { GetLastError() };
    if message == WM_NCDESTROY {
        if unsafe { RemoveWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID) } == 0 {
            report(Err(io::Error::other(
                "could not remove Main frame subclass",
            )));
        }
        unsafe { SetLastError(incoming_error) };
        return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    }
    let showing = message == WM_SHOWWINDOW && wparam != 0
        || matches!(message, WM_WINDOWPOSCHANGING | WM_WINDOWPOSCHANGED)
            && lparam != 0
            && unsafe { (*(lparam as *const WINDOWPOS)).flags } & SWP_SHOWWINDOW != 0;
    if showing {
        report(apply_policy(hwnd, false));
    }
    unsafe { SetLastError(incoming_error) };
    let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    let forwarded_error = unsafe { GetLastError() };
    if message == WM_WINDOWPOSCHANGED {
        report(reconcile(hwnd));
    }
    unsafe { SetLastError(forwarded_error) };
    result
}
