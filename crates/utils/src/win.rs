use std::ffi::OsString;

#[inline]
pub fn get_last_win32_error_formatted() -> String {
    format_error_message(unsafe { windows::Win32::Foundation::GetLastError().0 })
}

pub fn format_error_message(error_code: u32) -> String {
    use windows::{
        core::PWSTR,
        Win32::System::Diagnostics::Debug::{FormatMessageW, FORMAT_MESSAGE_FROM_SYSTEM},
    };

    let mut buffer = vec![0u16; 1024];
    match unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_FROM_SYSTEM,
            None,
            error_code,
            0,
            PWSTR(buffer.as_mut_ptr()),
            buffer.len() as u32,
            None,
        )
    } {
        0 => format!("Unknown error: {}", error_code),
        len => String::from_utf16_lossy(&buffer[..len as usize])
            .trim()
            .to_string(),
    }
}

// Windows named pipes must be in the format "\\.\pipe\name"
#[inline]
pub fn named_pipe_to_path(name: &str) -> OsString {
    format!(r"\\.\pipe\{}", name).into()
}
