use std::{io, path::Path};

#[cfg(not(windows))]
pub fn replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(temporary, destination)
}

#[cfg(windows)]
pub fn replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    use windows::core::PCWSTR;

    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(temporary.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| io::Error::other(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_an_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("destination");
        let temporary = directory.path().join("temporary");
        std::fs::write(&destination, "old").unwrap();
        std::fs::write(&temporary, "new").unwrap();
        replace(&temporary, &destination).unwrap();
        assert_eq!(std::fs::read_to_string(destination).unwrap(), "new");
        assert!(!temporary.exists());
    }
}
