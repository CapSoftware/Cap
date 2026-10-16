use std::{io, path::Path};

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn publish(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source_name = CString::new(source.as_os_str().as_bytes())?;
    let destination_name = CString::new(destination.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renamex_np(
            source_name.as_ptr(),
            destination_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source_name.as_ptr(),
            libc::AT_FDCWD,
            destination_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Unsupported
            || matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL))
        {
            // Production recovery publishes the enclosing workspace only after all prefixes validate.
            copy_without_links(source, destination)
        } else {
            Err(error)
        }
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

#[cfg(any(unix, test))]
fn copy_without_links(source: &Path, destination: &Path) -> io::Result<()> {
    let mut input = std::fs::File::open(source)?;
    let length = input.metadata()?.len();
    copy_to_new_file(&mut input, destination, length)
}

#[cfg(any(unix, test))]
fn copy_to_new_file(input: &mut impl io::Read, destination: &Path, length: u64) -> io::Result<()> {
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = (|| {
        if io::copy(input, &mut output)? != length {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Incomplete recovered prefix copy",
            ));
        }
        output.sync_all()
    })();
    drop(output);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_keeps_complete_bytes_without_replacing_existing_data() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("temporary");
        let destination = directory.path().join("segment_001.m4s");
        std::fs::write(&source, b"complete prefix").unwrap();
        publish(&source, &destination).unwrap();
        if source.exists() {
            assert_eq!(std::fs::read(&source).unwrap(), b"complete prefix");
        }
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete prefix");
        std::fs::write(&source, b"replacement").unwrap();
        assert!(publish(&source, &destination).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"replacement");
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete prefix");
    }

    #[test]
    fn fallback_copy_preserves_source_and_refuses_existing_files() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("temporary");
        let destination = directory.path().join("segment_001.m4s");
        std::fs::write(&source, b"complete prefix").unwrap();
        copy_without_links(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"complete prefix");
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete prefix");
        std::fs::write(&source, b"replacement").unwrap();
        assert!(copy_without_links(&source, &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete prefix");
    }

    #[test]
    fn failed_fallback_copy_removes_only_its_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("segment_001.m4s");
        assert!(copy_to_new_file(&mut &b"short"[..], &destination, 100).is_err());
        assert!(!destination.exists());
        std::fs::write(&destination, b"existing").unwrap();
        assert!(copy_to_new_file(&mut &b"short"[..], &destination, 100).is_err());
        assert_eq!(std::fs::read(destination).unwrap(), b"existing");
    }
}
