use windows::{
    Win32::{
        Foundation::{BOOL, CloseHandle, FALSE, HWND, LPARAM, RECT, TRUE},
        Graphics::Gdi::{
            DEVMODEW, DISPLAY_DEVICEW, EnumDisplayDevicesW, EnumDisplayMonitors,
            EnumDisplaySettingsW, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONULL,
            MONITORINFO, MONITORINFOEXW, MonitorFromWindow,
        },
    },
    core::{PCWSTR, PWSTR},
};

pub struct DisplayImpl(HMONITOR);

impl DisplayImpl {
    pub fn list() -> Vec<Self> {
        unsafe extern "system" fn monitor_enum_proc(
            hmonitor: HMONITOR,
            _hdc: HDC,
            _lprc_clip: *mut RECT,
            lparam: LPARAM,
        ) -> BOOL {
            let list = &mut *(lparam.0 as *mut Vec<DisplayImpl>);

            list.push(DisplayImpl(hmonitor));

            FALSE
        }

        let mut list = vec![];
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(monitor_enum_proc),
                LPARAM(core::ptr::addr_of_mut!(list) as isize),
            );
        };

        list
    }

    pub fn bounds(&self) -> Option<RECT> {
        let mut minfo = MONITORINFOEXW::default();

        minfo.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(self.0, &mut minfo as *mut MONITORINFOEXW as *mut _).as_bool() {
            return None;
        }

        Some(minfo.monitorInfo.rcMonitor)
    }

    pub fn id(&self) -> u32 {
        self.0.0 as u32
    }
}
