use std::io;
use std::path::Path;

pub const LOW_DISK_WARN_BYTES: u64 = 200 * 1024 * 1024;
pub const LOW_DISK_STOP_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskSpaceStatus {
    Ok,
    Low,
    Exhausted,
}

impl DiskSpaceStatus {
    pub fn from_bytes(bytes_free: u64) -> Self {
        if bytes_free <= LOW_DISK_STOP_BYTES {
            DiskSpaceStatus::Exhausted
        } else if bytes_free <= LOW_DISK_WARN_BYTES {
            DiskSpaceStatus::Low
        } else {
            DiskSpaceStatus::Ok
        }
    }
}

#[cfg(unix)]
pub fn free_bytes_for_path(path: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let probe_path = resolve_existing_ancestor(path);
    let c_path = CString::new(probe_path.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;

    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }

    let bavail = stat.f_bavail as u64;
    let frsize = if stat.f_frsize == 0 {
        stat.f_bsize as u64
    } else {
        stat.f_frsize as u64
    };
    Ok(bavail.saturating_mul(frsize))
}

#[cfg(windows)]
pub fn free_bytes_for_path(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::PCWSTR;

    let probe_path = resolve_existing_ancestor(path);
    let mut wide: Vec<u16> = probe_path.as_os_str().encode_wide().collect();
    if wide.last().copied() != Some(0) {
        wide.push(0);
    }

    let mut free_bytes_available_to_caller: u64 = 0;
    let mut total_number_of_bytes: u64 = 0;
    let mut total_number_of_free_bytes: u64 = 0;

    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_bytes_available_to_caller),
            Some(&mut total_number_of_bytes),
            Some(&mut total_number_of_free_bytes),
        )
        .map_err(|e| io::Error::other(e.to_string()))?;
    }

    Ok(free_bytes_available_to_caller)
}

fn resolve_existing_ancestor(path: &Path) -> std::path::PathBuf {
    let mut candidate: std::path::PathBuf = path.to_path_buf();
    loop {
        if candidate.exists() {
            return candidate;
        }
        if !candidate.pop() {
            return std::env::temp_dir();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_from_bytes() {
        assert_eq!(DiskSpaceStatus::from_bytes(u64::MAX), DiskSpaceStatus::Ok);
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_WARN_BYTES + 1),
            DiskSpaceStatus::Ok
        );
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_WARN_BYTES),
            DiskSpaceStatus::Low
        );
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_STOP_BYTES + 1),
            DiskSpaceStatus::Low
        );
        assert_eq!(
            DiskSpaceStatus::from_bytes(LOW_DISK_STOP_BYTES),
            DiskSpaceStatus::Exhausted
        );
        assert_eq!(DiskSpaceStatus::from_bytes(0), DiskSpaceStatus::Exhausted);
    }

    #[test]
    fn free_bytes_on_temp_dir_is_positive() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = free_bytes_for_path(dir.path()).expect("statvfs should succeed on temp dir");
        assert!(bytes > 0);
    }

    #[test]
    fn free_bytes_on_missing_path_walks_up_to_existing_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nope").join("also-nope").join("nada");
        let bytes = free_bytes_for_path(&nested).expect("should fall back to existing ancestor");
        assert!(bytes > 0);
    }
}
