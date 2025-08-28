use windows::{
    Win32::{
        Foundation::{LPARAM, RECT},
        Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR},
    },
    core::{BOOL, Result},
};

pub fn get_display_handle_from_index(index: usize) -> Result<Option<HMONITOR>> {
    let displays = enumerate_displays()?;
    Ok(displays.get(index).copied())
}

fn enumerate_displays() -> Result<Vec<HMONITOR>> {
    unsafe {
        let displays = Box::into_raw(Box::default());
        EnumDisplayMonitors(None, None, Some(enum_monitor), LPARAM(displays as isize)).ok()?;
        Ok(*Box::from_raw(displays))
    }
}

extern "system" fn enum_monitor(monitor: HMONITOR, _: HDC, _: *mut RECT, state: LPARAM) -> BOOL {
    unsafe {
        let state = Box::leak(Box::from_raw(state.0 as *mut Vec<HMONITOR>));
        state.push(monitor);
    }
    true.into()
}
