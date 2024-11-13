use std::{ffi::OsString, path::PathBuf};

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

pub fn create_channel_named_pipe(
    mut rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    unix_path: PathBuf,
) -> OsString {
    #[cfg(unix)]
    {
        use std::io::Write;

        create_named_pipe(&unix_path).unwrap();

        let path = unix_path.clone();
        tokio::spawn(async move {
            let mut file = std::fs::File::create(&path).unwrap();
            println!("video pipe opened");

            while let Some(bytes) = rx.recv().await {
                file.write_all(&bytes).unwrap();
            }

            println!("done writing to video pipe");
        });

        unix_path.into_os_string()
    }

    #[cfg(windows)]
    {
        use tokio::io::AsyncWriteExt;
        use tokio::net::windows::named_pipe::ServerOptions;

        let uuid = uuid::Uuid::new_v4();
        let pipe_name = format!(r#"\\.\pipe\{uuid}"#);

        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .unwrap();

        tokio::spawn({
            async move {
                println!("video pipe opened");

                server.connect().await.unwrap();

                while let Some(bytes) = rx.recv().await {
                    server.write_all(&bytes).await.unwrap();
                }

                println!("done writing to video pipe");
            }
        });

        pipe_name.into()
    }
}
