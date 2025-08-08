use std::{future::Future, path::PathBuf};

use tracing::Instrument;

#[cfg(windows)]
pub fn get_last_win32_error_formatted() -> String {
    format_error_message(unsafe { windows::Win32::Foundation::GetLastError().0 })
}

#[cfg(windows)]
pub fn format_error_message(error_code: u32) -> String {
    use windows::{
        Win32::System::Diagnostics::Debug::{FORMAT_MESSAGE_FROM_SYSTEM, FormatMessageW},
        core::PWSTR,
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

/// Wrapper around tokio::spawn that inherits the current tracing subscriber and span.
pub fn spawn_actor<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    use tracing::instrument::WithSubscriber;
    tokio::spawn(future.with_current_subscriber().in_current_span())
}

pub fn ensure_dir(path: &PathBuf) -> Result<PathBuf, std::io::Error> {
    std::fs::create_dir_all(path)?;
    Ok(path.clone())
}
