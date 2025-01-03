use std::{ffi::OsString, path::PathBuf};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc::Receiver;

#[cfg(windows)]
pub fn get_last_win32_error_formatted() -> String {
    format_error_message(unsafe { windows::Win32::Foundation::GetLastError().0 })
}

#[cfg(windows)]
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

#[cfg(unix)]
fn create_named_pipe(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use nix::sys::stat;
    use nix::unistd;
    std::fs::remove_file(path).ok();
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
}

pub fn create_channel_named_pipe<T, F>(
    mut rx: Receiver<T>,
    pipe_path: PathBuf,
    mut chunk_fn: F,
) -> OsString
where
    T: Send + 'static,
    F: FnMut(&T) -> Option<&[u8]> + Send + 'static,
{
    #[cfg(windows)]
    {
        // Build proper Windows named pipe path, e.g. \\.\pipe\my_pipe_name
        // Use the final filename from `pipe_path` to avoid conflicts
        let filename = pipe_path
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("cap-default-pipe"));
        let pipe_name = format!(r"\\.\pipe\{}", filename.to_string_lossy());
        let os_pipe_name = OsString::from(&pipe_name);

        tokio::spawn(async move {
            let mut server = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name)
                .expect("Failed to create named pipe");

            // For each message from rx, repeatedly call chunk_fn until None is returned
            while let Some(msg) = rx.recv().await {
                loop {
                    if let Some(bytes) = chunk_fn(&msg) {
                        if let Err(e) = server.write_all(bytes).await {
                            eprintln!("Error writing to named pipe: {e}");
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        });

        return os_pipe_name;
    }

    #[cfg(unix)]
    {
        use nix::sys::stat;
        let os_pipe_name = pipe_path.clone().into_os_string();

        let _ = std::fs::remove_file(&pipe_path);
        // Make FIFO if not existing
        nix::unistd::mkfifo(&pipe_path, stat::Mode::S_IRWXU)
            .expect("Failed to create a Unix FIFO with mkfifo()");

        tokio::spawn(async move {
            let mut file = tokio::fs::File::create(&pipe_path)
                .await
                .expect("Failed to open FIFO for writing");

            while let Some(msg) = rx.recv().await {
                loop {
                    if let Some(bytes) = chunk_fn(&msg) {
                        if let Err(e) = file.write_all(bytes).await {
                            eprintln!("Error writing to FIFO: {e}");
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        });

        return os_pipe_name;
    }
}
