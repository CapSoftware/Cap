use std::{io, path::Path};

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn publish(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(super) fn publish(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{Win32::Storage::FileSystem::MoveFileW, core::PCWSTR};

    let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<_> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if source[..source.len() - 1].contains(&0) || destination[..destination.len() - 1].contains(&0)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Path contains a null character",
        ));
    }
    unsafe { MoveFileW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr())) }
        .map_err(|_| io::Error::last_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_moves_the_complete_file_without_replacing_existing_data() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("temporary");
        let destination = directory.path().join("segment_001.m4s");
        std::fs::write(&source, b"complete prefix").unwrap();
        publish(&source, &destination).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete prefix");
        std::fs::write(&source, b"replacement").unwrap();
        assert!(publish(&source, &destination).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"replacement");
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete prefix");
    }
}
