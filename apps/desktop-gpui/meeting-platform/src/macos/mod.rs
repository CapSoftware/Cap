pub mod browser_probe;
pub mod mic_clients;
pub mod speaker_labels;
pub mod system_calendar;
pub mod system_tap;
pub mod tcc;

use std::ffi::{CStr, c_void};

pub(crate) fn dynamic_symbol(name: &CStr) -> Option<*mut c_void> {
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!symbol.is_null()).then_some(symbol)
}
